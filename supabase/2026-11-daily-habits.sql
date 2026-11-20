-- Run this in the Supabase SQL Editor (safe to run more than once).
-- Daily habits, streaks and weekly seasons. Also the last section of schema.sql.

-- ---------- Daily habits and weekly seasons (November 2026) ----------
-- Small things ticked off each day on My Habits: one per Act (1 to 5),
-- picked from options that fit the person's survey. Each tick is 10 points. Points this week (Monday to
-- Sunday, UK time) rank you among friends and in your tree league, and
-- start again every Monday. Saved only through save_daily_habits(), which
-- takes today or yesterday, so nobody can fill in a whole week for points.
create table if not exists public.daily_habits (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  habits text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.daily_habits enable row level security;
drop policy if exists "daily_habits: owner can select" on public.daily_habits;
create policy "daily_habits: owner can select" on public.daily_habits for select to authenticated using (user_id = auth.uid());
revoke all on public.daily_habits from anon, authenticated;
grant select on public.daily_habits to authenticated;

create or replace function public.uk_today() returns date language sql stable as $$ select (now() at time zone 'Europe/London')::date $$;
create or replace function public.season_start() returns date language sql stable as $$ select date_trunc('week', now() at time zone 'Europe/London')::date $$;

create or replace function public.save_daily_habits(p_day date, p_habits text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text[];
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  -- Today or yesterday (a day either side for people abroad).
  if p_day is null or p_day < public.uk_today() - 1 or p_day > public.uk_today() + 1 then raise exception 'Only today or yesterday'; end if;
  -- One habit per Act a day ("a3:meatfree": Act 3's habit, picked from the
  -- person's options), plus the first six names from before.
  select coalesce(array_agg(x.h order by x.h), '{}') into v
  from (
    select distinct on (case when h ~ '^a[1-5]:' then left(h, 2) else h end) h
    from unnest(coalesce(p_habits, '{}')) h
    where h ~ '^a[1-5]:[a-z0-9]{2,20}$'
       or h in ('meatfree', 'carfree', 'shower', 'heating', 'nothingnew', 'nowaste')
    order by case when h ~ '^a[1-5]:' then left(h, 2) else h end, h
  ) x;
  if cardinality(v) > 6 then v := v[1:6]; end if;
  if cardinality(v) = 0 then
    delete from public.daily_habits where user_id = auth.uid() and day = p_day;
  else
    insert into public.daily_habits (user_id, day, habits, updated_at) values (auth.uid(), p_day, v, now())
    on conflict (user_id, day) do update set habits = excluded.habits, updated_at = now();
  end if;
end;
$$;
revoke all on function public.save_daily_habits(date, text[]) from public, anon;
grant execute on function public.save_daily_habits(date, text[]) to authenticated;

-- This week's race in your tree league: the same people as my_acts_league
-- (finished survey, not hidden, not blocked), ranked by points this week;
-- on a tie, whoever got there first. last_pos is where you finished last
-- week (yours only). Up to 11 people around you.
drop function if exists public.my_week_league();
create or replace function public.my_week_league()
returns table (pos bigint, username text, points integer, is_me boolean, league_size bigint, last_pos bigint)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select public.acts_level(coalesce(cardinality(acts_done), 0)) as lvl from public.profiles where id = auth.uid() and acts_done is not null
  ), members as (
    select p.id, p.username
    from public.profiles p
    join public.survey_responses s on s.user_id = p.id and public.survey_finished(s.user_id, s.survey_data)
    where p.acts_done is not null
      and public.acts_level(coalesce(cardinality(p.acts_done), 0)) = (select lvl from mine)
      and (not p.leagues_hidden or p.id = auth.uid())
      and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = auth.uid()))
  ), pts as (
    select m.id, m.username,
      coalesce(sum(cardinality(d.habits)) filter (where d.day >= public.season_start()), 0)::integer * 10 as now_pts,
      coalesce(sum(cardinality(d.habits)) filter (where d.day >= public.season_start() - 7 and d.day < public.season_start()), 0)::integer * 10 as last_pts,
      max(d.updated_at) filter (where d.day >= public.season_start()) as at_now,
      max(d.updated_at) filter (where d.day >= public.season_start() - 7 and d.day < public.season_start()) as at_last
    from members m left join public.daily_habits d on d.user_id = m.id and d.day >= public.season_start() - 7
    group by m.id, m.username
  ), ranked as (
    select x.*,
      row_number() over (order by x.now_pts desc, x.at_now asc nulls last, x.username, x.id) as pos,
      row_number() over (order by x.last_pts desc, x.at_last asc nulls last, x.username, x.id) as lpos,
      count(*) over () as size
    from pts x
  ), me as (
    select pos from ranked where id = auth.uid()
  ), win as (
    select greatest(1, least((select pos from me) - 5, (select count(*) from ranked) - 10)) as lo
  )
  select r.pos, r.username, r.now_pts, r.id = auth.uid(), r.size,
    case when r.id = auth.uid() and r.last_pts > 0 then r.lpos end
  from ranked r, win
  where exists (select 1 from me) and r.pos >= win.lo and r.pos < win.lo + 11
  order by r.pos;
$$;
revoke all on function public.my_week_league() from public, anon;
grant execute on function public.my_week_league() to authenticated;

-- You and your friends this week: points, days ticked and current streak.
drop function if exists public.friends_week();
create or replace function public.friends_week()
returns table (user_id uuid, display_name text, points integer, days integer, streak integer, is_self boolean)
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select auth.uid() as id
    union
    select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
    from public.friendships f
    where f.status = 'accepted' and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  ), ok as (
    select pe.id from people pe
    where pe.id is not null
      and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = pe.id) or (b.blocker_id = pe.id and b.blocked_id = auth.uid()))
  ), isl as (
    select d.user_id, d.day, d.day - (row_number() over (partition by d.user_id order by d.day))::integer as g
    from public.daily_habits d join ok on ok.id = d.user_id
    where d.day > public.uk_today() - 400 and d.day <= public.uk_today() + 1
  ), lastd as (
    select distinct on (i.user_id) i.user_id, i.day, i.g from isl i order by i.user_id, i.day desc
  )
  select ok.id,
    coalesce(nullif(p.display_name, ''), nullif(p.username, ''), 'Friend'),
    coalesce((select sum(cardinality(d.habits)) from public.daily_habits d where d.user_id = ok.id and d.day >= public.season_start()), 0)::integer * 10,
    coalesce((select count(*) from public.daily_habits d where d.user_id = ok.id and d.day >= public.season_start()), 0)::integer,
    coalesce((select case when l.day >= public.uk_today() - 1 then (select count(*) from isl i where i.user_id = l.user_id and i.g = l.g) else 0 end from lastd l where l.user_id = ok.id), 0)::integer,
    ok.id = auth.uid()
  from ok left join public.profiles p on p.id = ok.id
  where public.has_access();
$$;
revoke all on function public.friends_week() from public, anon;
grant execute on function public.friends_week() to authenticated;
