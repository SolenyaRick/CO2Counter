-- Run this in the Supabase SQL Editor (safe to run more than once).
-- Only finished surveys count: in Analytics, the leagues, friends' totals,
-- group averages and invite counts. A survey left half-done no longer
-- counts anywhere. Everything here is also in schema.sql.

-- A survey counts as finished only with a real finish time, or the old
-- "earlier" marker (surveys saved before finish times were kept) backed by
-- a finished survey in the history. Half-done surveys never count, in the
-- analytics, leagues, friends' totals or groups.
create or replace function public.survey_finished(p_user uuid, p_data jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_data is null then return false; end if;
  if coalesce(nullif(p_data ->> 'completedAt', ''), 'earlier') <> 'earlier' then return true; end if;
  return p_data ->> 'completedAt' = 'earlier'
    and exists (select 1 from public.survey_history h where h.user_id = p_user);
end;
$$;
revoke all on function public.survey_finished(uuid, jsonb) from public, anon, authenticated;

drop function if exists public.friends_footprints();
create function public.friends_footprints()
returns table (user_id uuid, display_name text, total_yearly numeric, updated_at timestamptz, is_self boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.user_id,
    coalesce(nullif(p.display_name, ''), 'Friend'),
    s.total_yearly,
    s.updated_at,
    s.user_id = auth.uid()
  from public.survey_responses s
  left join public.profiles p on p.id = s.user_id
  where public.has_access()
    and s.total_yearly is not null
    and public.survey_finished(s.user_id, s.survey_data)
    and (
      s.user_id = auth.uid()
      or exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester_id = auth.uid() and f.addressee_id = s.user_id)
            or (f.addressee_id = auth.uid() and f.requester_id = s.user_id))
      )
    );
$$;
revoke all on function public.friends_footprints() from public;
grant execute on function public.friends_footprints() to authenticated;

drop function if exists public.group_board(uuid);
create function public.group_board(p_group uuid)
returns table (display_name text, total_yearly numeric, first_total numeric, latest_total numeric, surveys integer, is_self boolean, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with members as (
    select m.user_id from public.group_members m
    where m.group_id = p_group
      and exists (select 1 from public.group_members me where me.group_id = p_group and me.user_id = auth.uid())
      and not exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = m.user_id)
  ),
  h as (
    select sh.user_id, sh.total_yearly,
      row_number() over (partition by sh.user_id order by sh.completed_at asc) as first_n,
      row_number() over (partition by sh.user_id order by sh.completed_at desc) as last_n,
      count(*) over (partition by sh.user_id) as n
    from public.survey_history sh join members mb on mb.user_id = sh.user_id
    where sh.total_yearly is not null
  )
  select
    coalesce(nullif(p.display_name, ''), nullif(p.username, ''), 'Member'),
    s.total_yearly,
    (select h1.total_yearly from h h1 where h1.user_id = mb.user_id and h1.first_n = 1),
    (select h2.total_yearly from h h2 where h2.user_id = mb.user_id and h2.last_n = 1),
    coalesce((select h3.n::integer from h h3 where h3.user_id = mb.user_id and h3.first_n = 1), 0),
    mb.user_id = auth.uid(),
    mb.user_id
  from members mb
  left join public.survey_responses s on s.user_id = mb.user_id and public.survey_finished(s.user_id, s.survey_data)
  left join public.profiles p on p.id = mb.user_id;
$$;
revoke all on function public.group_board(uuid) from public;
grant execute on function public.group_board(uuid) to authenticated;

create or replace function public.owner_analytics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  return jsonb_build_object(
    'latest', coalesce((select jsonb_agg(jsonb_build_object('u', left(md5('co2:' || r.user_id::text), 12), 'data', r.survey_data))
      from public.survey_responses r where public.survey_finished(r.user_id, r.survey_data)), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('u', left(md5('co2:' || h.user_id::text), 12), 'at', h.completed_at, 'data', h.survey_data) order by h.completed_at)
      from public.survey_history h), '[]'::jsonb),
    'clicks', coalesce((select jsonb_agg(jsonb_build_object('u', left(md5('co2:' || c.user_id::text), 12), 'link', c.link_key, 'place', c.place, 'aff', c.via_affiliate, 'at', c.first_clicked_at))
      from public.link_clicks c), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('u', left(md5('co2:' || p.id::text), 12), 'role', p.role, 'research', p.research_opt_in))
      from public.profiles p), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('name', g.name, 'members', (select jsonb_agg(left(md5('co2:' || m.user_id::text), 12)) from public.group_members m where m.group_id = g.id)))
      from public.groups g), '[]'::jsonb),
    'accounts', (select count(*) from auth.users)
  );
end;
$$;
revoke all on function public.owner_analytics() from public;
grant execute on function public.owner_analytics() to authenticated;

create or replace function public.my_acts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  select code into v_code from public.referral_codes where user_id = auth.uid();
  while v_code is null loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    begin
      insert into public.referral_codes (user_id, code) values (auth.uid(), v_code);
    exception when unique_violation then
      select code into v_code from public.referral_codes where user_id = auth.uid();
    end;
  end loop;
  return jsonb_build_object(
    'code', v_code,
    'joined', (select count(*) from public.referrals r where r.referrer_id = auth.uid()),
    'finished', (select count(*) from public.referrals r where r.referrer_id = auth.uid()
      and (exists (select 1 from public.survey_history h where h.user_id = r.referred_id)
        or exists (select 1 from public.survey_responses s where s.user_id = r.referred_id and public.survey_finished(s.user_id, s.survey_data)))),
    'verified', coalesce((select jsonb_object_agg(v.act, v.verified_at) from public.act_verifications v where v.user_id = auth.uid()), '{}'::jsonb),
    -- Totals only, and only once enough people count that no one stands out.
    'cut', (select case when c.people >= 2 then round(c.cut) end from public.referral_cut(auth.uid()) c),
    'cut_people', (select c.people from public.referral_cut(auth.uid()) c),
    'global_cut', (select case when c.people >= 3 then round(c.cut) end from public.referral_cut(null) c),
    'global_people', (select case when c.people >= 3 then c.people end from public.referral_cut(null) c)
  );
end;
$$;
revoke all on function public.my_acts() from public;
grant execute on function public.my_acts() to authenticated;

create or replace function public.check_referrer()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer uuid;
  v_finished int;
begin
  select referrer_id into v_referrer from public.referrals where referred_id = auth.uid();
  if v_referrer is null then
    return;
  end if;
  select count(*) into v_finished from public.referrals r where r.referrer_id = v_referrer
    and (exists (select 1 from public.survey_history h where h.user_id = r.referred_id)
      or exists (select 1 from public.survey_responses s where s.user_id = r.referred_id and public.survey_finished(s.user_id, s.survey_data)));
  if v_finished >= 7 then
    insert into public.act_verifications (user_id, act) values (v_referrer, 'motivate') on conflict do nothing;
  end if;
end;
$$;
revoke all on function public.check_referrer() from public;
grant execute on function public.check_referrer() to authenticated;

create or replace function public.owner_acts_analytics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_people bigint;
  v_cut numeric;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  select c.people, c.cut into v_people, v_cut from public.referral_cut(null) c;
  return jsonb_build_object(
    'referrals', jsonb_build_object(
      'joined', (select count(*) from public.referrals),
      'finished', (select count(*) from public.referrals r where exists (select 1 from public.survey_history h where h.user_id = r.referred_id)
        or exists (select 1 from public.survey_responses s where s.user_id = r.referred_id and public.survey_finished(s.user_id, s.survey_data))),
      'inviters', (select count(distinct referrer_id) from public.referrals),
      'codes', (select count(*) from public.referral_codes),
      'cut_people', v_people,
      'cut', round(v_cut),
      'top', coalesce((select jsonb_agg(t order by t.finished desc, t.joined desc) from (
        select left(md5('co2:' || r.referrer_id::text), 12) as u, count(*) as joined,
          count(*) filter (where exists (select 1 from public.survey_history h where h.user_id = r.referred_id)) as finished
        from public.referrals r group by r.referrer_id order by 3 desc, 2 desc limit 10) t), '[]'::jsonb)
    ),
    'letters', coalesce((select jsonb_object_agg(kind, jsonb_build_object('total', total, 'month', month)) from (
      select kind, count(*) as total, count(*) filter (where sent_at > now() - interval '30 days') as month
      from public.letters_sent group by kind) l), '{}'::jsonb),
    'verified', coalesce((select jsonb_object_agg(act, n) from (select act, count(*) as n from public.act_verifications group by act) v), '{}'::jsonb),
    'energy_asks', jsonb_build_object(
      'links', (select count(*) from public.energy_asks),
      'confirmed', (select count(*) from public.energy_asks where confirmed_at is not null)
    ),
    'hand_ticks', jsonb_build_object(
      'mobilise', (select count(*) from public.profiles where acts ->> 'mobilise' = 'true'),
      'mp_sent', (select count(*) from public.profiles where acts ->> 'mpSent' = 'true'),
      'energy_asked', (select count(*) from public.profiles where acts ->> 'energyAsked' = 'true')
    )
  );
end;
$$;
revoke all on function public.owner_acts_analytics() from public, anon;
grant execute on function public.owner_acts_analytics() to authenticated;

-- ---------- Global ranking by the 7 Acts (November 2026) ----------

-- A survey counts as finished only with a real finish time, or the old
-- "earlier" marker (surveys saved before finish times were kept) backed by
-- a finished survey in the history. Half-done surveys never count, in the
-- analytics, leagues, friends' totals or groups.
create or replace function public.survey_finished(p_user uuid, p_data jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_data is null then return false; end if;
  if coalesce(nullif(p_data ->> 'completedAt', ''), 'earlier') <> 'earlier' then return true; end if;
  return p_data ->> 'completedAt' = 'earlier'
    and exists (select 1 from public.survey_history h where h.user_id = p_user);
end;
$$;
revoke all on function public.survey_finished(uuid, jsonb) from public, anon, authenticated;
-- Each person's app saves which of the 7 Acts they've done (worked out on
-- their phone from their survey and verified acts), via save_my_acts. The
-- ranking is anonymous: my_acts_rank() tells you your own place and how
-- everyone is spread across the tree levels (Seed 0, Sprout 1-2, Sapling
-- 3-4, Tree 5-6, Forest 7). Nobody else's name or acts are ever returned.
alter table public.profiles add column if not exists acts_done smallint[];
alter table public.profiles add column if not exists acts_at timestamptz;
-- The app writes these through save_my_acts. Like the rest of a profile,
-- the owner could also change them directly; acts are worked out on the
-- phone, so the ranking is for fun and motivation, not a verified score.

create or replace function public.save_my_acts(p_done smallint[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set acts_done = (select coalesce(array_agg(distinct a order by a), '{}') from unnest(p_done) a where a between 1 and 7),
         acts_at = now()
   where id = auth.uid();
$$;
revoke all on function public.save_my_acts(smallint[]) from public, anon;
grant execute on function public.save_my_acts(smallint[]) to authenticated;

create or replace function public.acts_level(n integer)
returns text
language sql
immutable
as $$
  select case when n >= 7 then 'forest' when n >= 5 then 'tree' when n >= 3 then 'sapling' when n >= 1 then 'sprout' else 'seed' end;
$$;

create or replace function public.my_acts_rank()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with everyone as (
    select id, coalesce(cardinality(acts_done), 0) as n from public.profiles where acts_done is not null
  ), me as (
    select n from everyone where id = auth.uid()
  )
  select jsonb_build_object(
    'acts', (select n from me),
    'total', (select count(*) from everyone),
    'rank', case when exists (select 1 from me) then (select 1 + count(*) from everyone where n > (select n from me)) end,
    'tied', case when exists (select 1 from me) then (select count(*) from everyone where n = (select n from me)) end,
    'levels', coalesce((select jsonb_object_agg(l, c) from (select public.acts_level(n) as l, count(*) as c from everyone group by 1) x), '{}'::jsonb)
  );
$$;
revoke all on function public.my_acts_rank() from public, anon;
grant execute on function public.my_acts_rank() to authenticated;

-- Owner analytics: the same spread, plus how many people have done each Act.
alter table public.profiles add column if not exists leagues_hidden boolean not null default false;
create or replace function public.owner_level_analytics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  return (
    -- Only people with a finished survey: a half-done one counts nowhere.
    with everyone as (
      select coalesce(p.acts_done, '{}') as d, coalesce(cardinality(p.acts_done), 0) as n, p.acts_at
      from public.profiles p
      join public.survey_responses s on s.user_id = p.id and public.survey_finished(s.user_id, s.survey_data)
      where p.acts_done is not null
    )
    select jsonb_build_object(
      'people', (select count(*) from everyone),
      'average', (select round(avg(n)::numeric, 2) from everyone),
      'active_30', (select count(*) from everyone where acts_at > now() - interval '30 days'),
      'levels', coalesce((select jsonb_object_agg(l, c) from (select public.acts_level(n) as l, count(*) as c from everyone group by 1) x), '{}'::jsonb),
      'by_act', coalesce((select jsonb_object_agg(a::text, c) from (select a, count(*) as c from everyone, unnest(d) a group by a) y), '{}'::jsonb),
      -- Each tree league: who's in it and their yearly footprints (the same
      -- totals the league tables rank by). Counts and averages only.
      'leagues', coalesce((select jsonb_object_agg(lvl, x) from (
        select public.acts_level(coalesce(cardinality(p.acts_done), 0)) as lvl,
          jsonb_build_object(
            'people', count(*),
            'with_total', count(s.total_yearly),
            'median', round(percentile_cont(0.5) within group (order by s.total_yearly)),
            'average', round(avg(s.total_yearly)),
            'lowest', round(min(s.total_yearly)),
            'highest', round(max(s.total_yearly)),
            'under_2500', count(*) filter (where s.total_yearly < 2500),
            'hidden', count(*) filter (where p.leagues_hidden)
          ) as x
        from public.profiles p
        join public.survey_responses s on s.user_id = p.id and public.survey_finished(s.user_id, s.survey_data)
        where p.acts_done is not null
        group by 1) l), '{}'::jsonb)
    )
  );
end;
$$;
revoke all on function public.owner_level_analytics() from public, anon;
grant execute on function public.owner_level_analytics() to authenticated;

-- ---------- Leagues: your tree, ranked by footprint (November 2026) ----------
-- Your league is your tree level from the 7 Acts (Seed 0, Sprout 1-2,
-- Sapling 3-4, Tree 5-6, Forest 7). Inside your league, people are ranked
-- by yearly footprint (survey_responses.total_yearly, the total friends
-- see), lowest first; on a tie, whoever got there first. You see up to 11
-- people around you, by username and total. Anyone can hide from leagues on
-- their Account page (they still count in anonymous totals), and people
-- who've blocked each other never see each other.
alter table public.profiles add column if not exists leagues_hidden boolean not null default false;
drop function if exists public.my_acts_league();

create or replace function public.my_acts_league()
returns table (pos bigint, username text, kg integer, acts integer, is_me boolean, league_size bigint)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select public.acts_level(coalesce(cardinality(acts_done), 0)) as lvl from public.profiles where id = auth.uid() and acts_done is not null
  ), members as (
    select s.user_id as id, p.username, round(s.total_yearly)::integer as t, coalesce(cardinality(p.acts_done), 0)::integer as n, s.updated_at
    from public.survey_responses s
    join public.profiles p on p.id = s.user_id
    where p.acts_done is not null
      and public.acts_level(coalesce(cardinality(p.acts_done), 0)) = (select lvl from mine)
      and s.total_yearly is not null and s.total_yearly > 0 and public.survey_finished(s.user_id, s.survey_data)
      and (not p.leagues_hidden or s.user_id = auth.uid())
      and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = s.user_id) or (b.blocker_id = s.user_id and b.blocked_id = auth.uid()))
  ), ranked as (
    select m.*, row_number() over (order by m.t asc, m.updated_at asc nulls last, m.id) as pos, count(*) over () as size from members m
  ), me as (
    select pos from ranked where id = auth.uid()
  ), win as (
    select greatest(1, least((select pos from me) - 5, (select count(*) from ranked) - 10)) as lo
  )
  select r.pos, r.username, r.t, r.n, r.id = auth.uid(), r.size
  from ranked r, win
  where exists (select 1 from me) and r.pos >= win.lo and r.pos < win.lo + 11
  order by r.pos;
$$;
revoke all on function public.my_acts_league() from public, anon;
grant execute on function public.my_acts_league() to authenticated;
