-- Run this in the Supabase SQL Editor (safe to run more than once).
-- It is also the last section of schema.sql.

-- ---------- Global ranking by the 7 Acts (November 2026) ----------
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
    with everyone as (
      select coalesce(acts_done, '{}') as d, coalesce(cardinality(acts_done), 0) as n, acts_at from public.profiles where acts_done is not null
    )
    select jsonb_build_object(
      'people', (select count(*) from everyone),
      'average', (select round(avg(n)::numeric, 2) from everyone),
      'active_30', (select count(*) from everyone where acts_at > now() - interval '30 days'),
      'levels', coalesce((select jsonb_object_agg(l, c) from (select public.acts_level(n) as l, count(*) as c from everyone group by 1) x), '{}'::jsonb),
      'by_act', coalesce((select jsonb_object_agg(a::text, c) from (select a, count(*) as c from everyone, unnest(d) a group by a) y), '{}'::jsonb)
    )
  );
end;
$$;
revoke all on function public.owner_level_analytics() from public, anon;
grant execute on function public.owner_level_analytics() to authenticated;

-- ---------- Leagues: the people ranked around you (November 2026) ----------
-- Like a Duolingo league: up to 11 people around your place in the global
-- ranking, by Acts done (whoever got there first is ahead on a tie). Only
-- usernames and Act counts are shown. Anyone can hide from leagues on their
-- Account page (they still count in the anonymous totals), and people who
-- have blocked each other never see each other.
alter table public.profiles add column if not exists leagues_hidden boolean not null default false;

create or replace function public.my_acts_league()
returns table (pos bigint, username text, acts integer, is_me boolean)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select p.id, p.username, coalesce(cardinality(p.acts_done), 0)::integer as n,
      row_number() over (order by coalesce(cardinality(p.acts_done), 0) desc, p.acts_at asc nulls last, p.id) as pos
    from public.profiles p
    where p.acts_done is not null
      and (not p.leagues_hidden or p.id = auth.uid())
      and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = auth.uid()))
  ), me as (
    select pos from ranked where id = auth.uid()
  ), win as (
    select greatest(1, least((select pos from me) - 5, (select count(*) from ranked) - 10)) as lo
  )
  select r.pos, r.username, r.n, r.id = auth.uid()
  from ranked r, win
  where exists (select 1 from me) and r.pos >= win.lo and r.pos < win.lo + 11
  order by r.pos;
$$;
revoke all on function public.my_acts_league() from public, anon;
grant execute on function public.my_acts_league() to authenticated;
