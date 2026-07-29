-- Weekly CO2 Tracker: Supabase schema
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Safe to re-run: guards with "if not exists" / "or replace" where possible.
--
-- Structure: all tables are created first, then all row-level-security
-- policies. Policies can reference other tables (e.g. profiles' policy
-- checks friendships), so every table this file creates must already exist
-- before any policy is defined - on a fresh database, creating a policy
-- that references a not-yet-created table fails immediately.

-- ==================== tables ====================

-- ---------- profiles ----------
-- One row per user, mirrors auth.users. Row is created by the app right
-- after sign-up (see app.js), not by a trigger, to keep this file simple.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  commute_distance_km numeric not null default 8,
  weekly_goal_kg numeric not null default 20,
  created_at timestamptz not null default now()
);

-- Yearly-estimate inputs (Stats page) and the food-waste setting (Account
-- page). Added via ALTER so this is safe to re-run against a table that
-- already existed before these columns were introduced.
alter table public.profiles add column if not exists short_haul_flights_per_year numeric not null default 0;
alter table public.profiles add column if not exists long_haul_flights_per_year numeric not null default 0;
alter table public.profiles add column if not exists household_people numeric not null default 1;
alter table public.profiles add column if not exists household_kwh_per_month numeric not null default 0;
alter table public.profiles add column if not exists clothes_per_month numeric not null default 0;
alter table public.profiles add column if not exists food_waste_bracket text not null default 'low';
alter table public.profiles drop constraint if exists profiles_food_waste_bracket_check;
alter table public.profiles add constraint profiles_food_waste_bracket_check
  check (food_waste_bracket in ('low', 'some', 'high', 'severe'));

-- Optional Stats-page extras. Deliberately left nullable with NO default -
-- unlike the columns above, null here means "not answered" and the app
-- excludes it from every total rather than treating it as 0.
alter table public.profiles add column if not exists annual_gas_kwh numeric;
alter table public.profiles add column if not exists weekly_noncommute_car_km numeric;
alter table public.profiles add column if not exists owns_car boolean;
alter table public.profiles add column if not exists num_dogs numeric;
alter table public.profiles add column if not exists num_cats numeric;

-- ---------- weeks ----------
-- One row per user per week (week_key = that week's Monday, "YYYY-MM-DD").
-- total_kg is computed client-side (same emission-factor logic as the rest
-- of the app) and stored alongside so friends' leaderboard totals don't
-- require duplicating that math in SQL.
create table if not exists public.weeks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_key text not null,
  commute jsonb not null default '{}'::jsonb,
  diet jsonb not null default '{}'::jsonb,
  total_kg numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, week_key)
);

-- Per-day confirmation: a day's commute/diet choice is saved as a draft as
-- soon as it's picked, but only counts toward total_kg (and therefore the
-- weekly figures, chart, and leaderboard) once its confirm button has been
-- pressed. Added via ALTER so this is safe to re-run against a table that
-- already existed before this column was introduced.
alter table public.weeks add column if not exists confirmed_commute jsonb not null default '{}'::jsonb;
alter table public.weeks add column if not exists confirmed_diet jsonb not null default '{}'::jsonb;

-- Alcohol: a single whole-week figure (not tied to a specific day, and not
-- gated by the per-day confirm flow above - every value here, including 0,
-- is already a real answer, so it counts toward total_kg immediately).
alter table public.weeks add column if not exists alcohol jsonb not null default '{"beer":0,"wine":0,"spiritsShots":0,"spiritsAbv":40}'::jsonb;

-- commute + food only (i.e. total_kg minus alcohol), computed and stored
-- client-side same as total_kg, so the "commute + food" figure on the
-- Leaderboard's "Everyone on the app" card doesn't need to duplicate the
-- alcohol emission-factor math in SQL either.
alter table public.weeks add column if not exists commute_food_kg numeric not null default 0;

-- ---------- friendships ----------
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

-- ==================== row-level security ====================

alter table public.profiles enable row level security;
alter table public.weeks enable row level security;
alter table public.friendships enable row level security;

-- ---------- profiles policies ----------

drop policy if exists "profiles: owner can select" on public.profiles;
create policy "profiles: owner can select" on public.profiles
  for select using (auth.uid() = id);

-- Visible once a friend request exists in either direction (pending or
-- accepted) so both sides can see who a request is from/to, not just
-- confirmed friends. The leaderboard itself (friend_leaderboard()) still
-- only ever includes accepted friendships.
drop policy if exists "profiles: friends can select" on public.profiles;
create policy "profiles: friends can select" on public.profiles
  for select using (
    exists (
      select 1 from public.friendships f
      where f.status in ('pending', 'accepted')
        and ((f.requester_id = auth.uid() and f.addressee_id = profiles.id)
          or (f.addressee_id = auth.uid() and f.requester_id = profiles.id))
    )
  );

drop policy if exists "profiles: owner can insert" on public.profiles;
create policy "profiles: owner can insert" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles: owner can update" on public.profiles;
create policy "profiles: owner can update" on public.profiles
  for update using (auth.uid() = id);

-- ---------- weeks policies ----------

drop policy if exists "weeks: owner full access" on public.weeks;
create policy "weeks: owner full access" on public.weeks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Friends do NOT get direct table access to weeks (that would expose full
-- day-by-day commute/diet detail) — they only see totals, via the
-- friend_leaderboard() function below.

-- ---------- friendships policies ----------

drop policy if exists "friendships: view own" on public.friendships;
create policy "friendships: view own" on public.friendships
  for select using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop policy if exists "friendships: create as requester" on public.friendships;
create policy "friendships: create as requester" on public.friendships
  for insert with check (auth.uid() = requester_id);

drop policy if exists "friendships: addressee can respond" on public.friendships;
create policy "friendships: addressee can respond" on public.friendships
  for update using (auth.uid() = addressee_id) with check (auth.uid() = addressee_id);

drop policy if exists "friendships: either side can delete" on public.friendships;
create policy "friendships: either side can delete" on public.friendships
  for delete using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- ==================== helper functions ====================

-- Look up a user id by email, for sending a friend request. Returns null if
-- no match. security definer so it can read auth.users without granting
-- broad access; only ever returns a bare id, never other account details.
create or replace function public.find_user_by_email(lookup_email text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from auth.users where email = lower(lookup_email) limit 1;
$$;

revoke all on function public.find_user_by_email(text) from public;
grant execute on function public.find_user_by_email(text) to authenticated;

-- Leaderboard: self + accepted friends' totals for one week, with display
-- names. Everything else about a friend's week stays private. Only weeks
-- with at least one confirmed day are included - otherwise a week with
-- nothing but unconfirmed drafts (total_kg = 0) would misleadingly rank as
-- a perfect zero-carbon week.
create or replace function public.friend_leaderboard(target_week_key text)
returns table (user_id uuid, display_name text, total_kg numeric, is_self boolean)
language sql
security definer
set search_path = public
as $$
  select w.user_id, p.display_name, w.total_kg, (w.user_id = auth.uid()) as is_self
  from public.weeks w
  join public.profiles p on p.id = w.user_id
  where w.week_key = target_week_key
    and (
      exists (select 1 from jsonb_each_text(w.confirmed_commute) kv where kv.value = 'true')
      or exists (select 1 from jsonb_each_text(w.confirmed_diet) kv where kv.value = 'true')
    )
    and (
      w.user_id = auth.uid()
      or exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester_id = auth.uid() and f.addressee_id = w.user_id)
            or (f.addressee_id = auth.uid() and f.requester_id = w.user_id))
      )
    )
  order by w.total_kg asc;
$$;

revoke all on function public.friend_leaderboard(text) from public;
grant execute on function public.friend_leaderboard(text) to authenticated;

-- Every day of the week (both commute and diet) confirmed - a stricter bar
-- than friend_leaderboard()'s "at least one confirmed day", used below for
-- averages so a week where only Monday got confirmed doesn't drag the
-- average down as if it were a real full week. NOT used for
-- friend_leaderboard() itself, which needs to keep working on a live,
-- still-in-progress "this week".
create or replace function public.week_is_fully_confirmed(confirmed jsonb)
returns boolean
language sql
immutable
as $$
  select confirmed @> '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":true,"sun":true}'::jsonb;
$$;

revoke all on function public.week_is_fully_confirmed(jsonb) from public;
grant execute on function public.week_is_fully_confirmed(jsonb) to authenticated;

-- All-time weekly average: self + accepted friends' average confirmed-week
-- total_kg (commute + food only - weeks that aren't fully confirmed for
-- every day are excluded from the average, see week_is_fully_confirmed()
-- above). Flights and home electricity are yearly,
-- not weekly, figures, so the app amortizes each person's yearly totals
-- into a weekly-equivalent client-side (see averageConfirmedWeekly() /
-- SHORT_HAUL_FLIGHT_KG etc. in app.js) and adds it on top of the average
-- this function returns, using the flight/home-energy profiles columns
-- friends can already read via the "profiles: friends can select" policy.
create or replace function public.friend_weekly_average()
returns table (user_id uuid, display_name text, avg_weekly_kg numeric, weeks_confirmed integer, is_self boolean)
language sql
security definer
set search_path = public
as $$
  select
    p.id as user_id,
    p.display_name,
    coalesce(avg(w.total_kg), 0) as avg_weekly_kg,
    count(w.*)::int as weeks_confirmed,
    (p.id = auth.uid()) as is_self
  from public.profiles p
  left join public.weeks w on w.user_id = p.id
    and public.week_is_fully_confirmed(w.confirmed_commute)
    and public.week_is_fully_confirmed(w.confirmed_diet)
  where
    p.id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = auth.uid() and f.addressee_id = p.id)
          or (f.addressee_id = auth.uid() and f.requester_id = p.id))
    )
  group by p.id, p.display_name;
$$;

revoke all on function public.friend_weekly_average() from public;
grant execute on function public.friend_weekly_average() to authenticated;

-- App-wide averages across every account, not just friends - for the
-- Leaderboard page's "Everyone on the app" card. Two figures:
--   avg_commute_food_kg - just commute + food (commute_food_kg), no
--     duplicated math needed since it's already stored per week.
--   avg_total_kg - the fuller figure that matches "Stats page yearly
--     total / 52" for each user (commute + food + alcohol, plus a
--     weekly-equivalent share of flights, home energy, buying goods, and
--     any optional extras they've answered - mirrors weeklyExtrasFor() in
--     app.js). Computing this needs every eligible user's profile, which
--     this function can't expose row-by-row without breaking the
--     "aggregate only" privacy guarantee it exists for - so unlike the
--     client-side friends version, the emission-factor constants below are
--     duplicated into SQL. If any of SHORT_HAUL_FLIGHT_KG,
--     LONG_HAUL_FLIGHT_KG, GRID_ELECTRICITY_KG_PER_KWH, CLOTHING_ITEM_KG,
--     GAS_HEATING_KG_PER_KWH, TRANSPORT_FACTORS.car,
--     CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR, DOG_KG_PER_YEAR, or
--     CAT_KG_PER_YEAR ever change in app.js, update the matching literal
--     here too.
-- Deliberately returns ONLY these two aggregates plus a headcount - never
-- any user_id, name, or per-person row - so it's safe to expose to any
-- signed-in user with no friendship relationship required.
--
-- This function used to return a single avg_weekly_kg column; Postgres
-- won't let CREATE OR REPLACE change a function's output columns, so the
-- old version has to be dropped first (safe: nothing else in this schema
-- depends on it).
drop function if exists public.app_wide_weekly_average();

create or replace function public.app_wide_weekly_average()
returns table (avg_commute_food_kg numeric, avg_total_kg numeric, user_count integer)
language sql
security definer
set search_path = public
as $$
  with eligible_weeks as (
    select w.user_id, w.total_kg, w.commute_food_kg
    from public.weeks w
    where
      public.week_is_fully_confirmed(w.confirmed_commute)
      and public.week_is_fully_confirmed(w.confirmed_diet)
  ),
  per_user as (
    select
      user_id,
      avg(commute_food_kg) as avg_commute_food_kg,
      avg(total_kg) as avg_commute_food_alcohol_kg
    from eligible_weeks
    group by user_id
  ),
  per_user_extras as (
    select
      pu.avg_commute_food_kg,
      pu.avg_commute_food_alcohol_kg
        + (
            (coalesce(p.short_haul_flights_per_year, 0) * 250 + coalesce(p.long_haul_flights_per_year, 0) * 1600)
            + (coalesce(p.household_kwh_per_month, 0) * 12 * 0.2) / greatest(1, coalesce(p.household_people, 1))
            + (coalesce(p.clothes_per_month, 0) * 12 * 10)
            + case when p.annual_gas_kwh is not null then (p.annual_gas_kwh * 0.18) / greatest(1, coalesce(p.household_people, 1)) else 0 end
            + case when p.weekly_noncommute_car_km is not null then p.weekly_noncommute_car_km * 0.171 * 52 else 0 end
            + case when p.owns_car then 700 else 0 end
            + case when p.num_dogs is not null or p.num_cats is not null then coalesce(p.num_dogs, 0) * 770 + coalesce(p.num_cats, 0) * 310 else 0 end
          ) / 52.0 as avg_total_kg
    from per_user pu
    join public.profiles p on p.id = pu.user_id
  )
  select
    coalesce(avg(avg_commute_food_kg), 0) as avg_commute_food_kg,
    coalesce(avg(avg_total_kg), 0) as avg_total_kg,
    count(*)::int as user_count
  from per_user_extras;
$$;

revoke all on function public.app_wide_weekly_average() from public;
grant execute on function public.app_wide_weekly_average() to authenticated;
