-- Weekly CO2 Tracker: Supabase schema
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Safe to re-run: guards with "if not exists" / "or replace" where possible.

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

alter table public.profiles enable row level security;

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

alter table public.weeks enable row level security;

drop policy if exists "weeks: owner full access" on public.weeks;
create policy "weeks: owner full access" on public.weeks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Friends do NOT get direct table access to weeks (that would expose full
-- day-by-day commute/diet detail) — they only see totals, via the
-- friend_leaderboard() function below.

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

alter table public.friendships enable row level security;

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

-- ---------- helper functions ----------

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
-- names. Everything else about a friend's week stays private.
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
