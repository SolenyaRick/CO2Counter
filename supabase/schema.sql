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
alter table public.profiles add column if not exists annual_water_m3 numeric;
alter table public.profiles add column if not exists bank_name text;
alter table public.profiles add column if not exists bank_balance numeric;
-- Optional: null means "prefer not to say" (the select's "None" option,
-- normalized to null client-side before saving) - matches the same
-- nullable-optional pattern as car_fuel_type/food_waste_bracket above.
alter table public.profiles add column if not exists university text;
alter table public.profiles drop constraint if exists profiles_university_check;
alter table public.profiles add constraint profiles_university_check
  check (university is null or university in ('UCL', 'Imperial', 'KCL'));

-- Optional: which country you live in - null means "prefer not to say",
-- same nullable-optional pattern as university above. Used for the
-- Account > Settings country picker and, once answered, as one of the
-- public_leaderboard() filter options below (see COUNTRY_LIST in
-- app.js, which must be kept in sync with this check constraint's list -
-- same duplication-by-necessity as university's UCL/Imperial/KCL list
-- above, one enum spelled out on each side since a SQL CHECK constraint
-- and an HTML <select>'s <option> list can't share a single source of
-- truth across a project with no build step).
alter table public.profiles add column if not exists country text;
alter table public.profiles drop constraint if exists profiles_country_check;
alter table public.profiles add constraint profiles_country_check
  check (country is null or country in (
    'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria',
    'Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan',
    'Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia',
    'Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo (Brazzaville)','Congo (Kinshasa)',
    'Costa Rica','Croatia','Cuba','Cyprus','Czechia','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador',
    'Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France',
    'Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau',
    'Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland',
    'Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait',
    'Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg',
    'Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius','Mexico',
    'Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nauru',
    'Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway','Oman',
    'Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal',
    'Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa','San Marino','Sao Tome and Principe',
    'Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia','Solomon Islands','Somalia',
    'South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland','Syria',
    'Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga','Trinidad and Tobago','Tunisia','Turkey',
    'Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Vanuatu',
    'Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'
  ));

-- Research opt-in (Account page): off by default, unlike every other column
-- on this table - nothing is shared until the user actively turns it on.
-- See the research_profiles / research_weeks views below for what opting in
-- actually exposes, and to whom.
alter table public.profiles add column if not exists research_opt_in boolean not null default false;

-- Leaderboard opt-in (Account > Settings): off by default, same "nothing
-- shared until actively turned on" stance as research_opt_in above. Unlike
-- friend_leaderboard() (which only ever shows friends to each other),
-- turning this on makes display_name and this week's total_kg visible to
-- ANY signed-in user via public_leaderboard() below, filterable by
-- university/country - so it's opt-in, not opt-out, and off by default.
alter table public.profiles add column if not exists leaderboard_opt_in boolean not null default false;

-- Optional: a "typical week" from before the person started tracking, used
-- on the Account page's Baseline week screen to compare This Week's card
-- against that instead of the UK average - nullable with no default, same
-- "not answered" = "use the UK average" pattern as the optional Stats-page
-- extras above. Used to be a fully-confirmed week_key picked from the
-- person's own tracked history, but that meant "before I got the app" was
-- unrepresentable - if their habits were very different before they
-- started tracking, there was no real week to point at. Then briefly a
-- small self-described jsonb blob ({commuteMode, commuteDaysPerWeek,
-- dietType, ...}) the client expanded into a synthetic week - now it's the
-- exact same shape as a real tracked week ({commute, diet,
-- confirmedCommute, confirmedDiet, alcohol, extraJourneys}, see
-- blankWeek() in app.js), built either by hand-editing the real day-by-day
-- commute/diet tables directly (the Baseline week screen's "Custom week"
-- tab reuses buildCommuteTable()/buildDietTable() from This Week) or by
-- copying one of their own past tracked weeks as an editable starting
-- point ("Copy a week" tab, copyWeekToBaseline() in app.js - a one-time
-- snapshot, not a live reference, so editing that real week afterwards on
-- This Week never silently shifts an already-set baseline). No schema
-- change needed for that shape change: this has always been a
-- deliberately unstructured jsonb blob interpreted entirely client-side.
alter table public.profiles drop column if exists baseline_week_key;
alter table public.profiles add column if not exists baseline_week jsonb;

-- Optional: "diesel" | "hybrid" | "electric" - null means use the
-- blended-average car factor (0.171 kg CO2e/km) for both commute and
-- non-commute driving, same as before this column existed.
alter table public.profiles add column if not exists car_fuel_type text;
alter table public.profiles drop constraint if exists profiles_car_fuel_type_check;
alter table public.profiles add constraint profiles_car_fuel_type_check
  check (car_fuel_type is null or car_fuel_type in ('diesel', 'hybrid', 'electric'));

-- Itemized flight log, replacing the old short_haul_flights_per_year/
-- long_haul_flights_per_year flat counts (left in place above, unused
-- going forward - no destructive schema change). flights is the raw
-- per-trip array (date optional, continent, class) the app reads back to
-- render the list; flying_yearly_kg is the total this year's worth of
-- logged flights comes to, computed client-side (see
-- computeFlyingYearlyKg() in app.js, using the FLIGHT_CONTINENT_KG/
-- FLIGHT_CLASS_MULTIPLIER factors in emission-factors.js) and written
-- alongside it purely so app_wide_weekly_average()/
-- university_weekly_average() below can read a plain number instead of
-- re-implementing the continent/class lookup in SQL.
alter table public.profiles add column if not exists flights jsonb not null default '[]'::jsonb;
alter table public.profiles add column if not exists flying_yearly_kg numeric not null default 0;

-- Electricity bill (This Year page, "Household energy"), replacing manual
-- entry of a monthly kWh figure - household_kwh_per_month (added above)
-- is now DERIVED from these three columns (see
-- computeElectricityMonthlyKwh() in app.js) rather than typed in
-- directly, but keeps being written as before so nothing downstream needs
-- to change. Nullable with no default - null means no bill has been
-- submitted yet, same "not answered" pattern as the optional extras
-- above.
alter table public.profiles add column if not exists electricity_bill_from date;
alter table public.profiles add column if not exists electricity_bill_to date;
alter table public.profiles add column if not exists electricity_bill_kwh numeric;

-- Home page "Habits" card: an opt-in, time-boxed commitment to a specific
-- behavior change (currently "meatFree" or "noFlights"), distinct from the
-- passive diet/flights/commute tracking elsewhere in the app. Keyed by
-- habit id rather than a list, since only one challenge per habit can be
-- active at once - starting a new one overwrites whatever was there before
-- (same "starting fresh replaces the old value" pattern as
-- weekly_goal_kg's presets). Two shapes coexist: {"noFlights":
-- {"startDate": "2026-08-17", "targetDays": 30}} is a streak-length
-- challenge (flying only); {"meatFree": {"startDate": "2026-08-17",
-- "targetPerWeek": 3}, "carFree": {...}} is a weekly day-cap (Eating/
-- Commuting's tailored survey flow - see chooseWeeklyTarget()/
-- setWeeklyTarget() in app.js). A habit with no key means no active
-- challenge/target for it. Deliberately doesn't store the streak count or
-- this week's day count itself: those are always recomputed client-side
-- from the existing diet/flights/commute data (see flightFreeStreakDays()/
-- mealsThisWeekMeatCount()/carDaysThisWeekCount() in app.js), so this
-- column only remembers what was committed to, not ongoing progress, and
-- can't drift out of sync with the real data.
alter table public.profiles add column if not exists habit_challenges jsonb not null default '{}'::jsonb;

-- Which habit (if any) the person opted into via the Habits card's survey
-- on the Leaderboard page - null shows the "Would you like to change your
-- habits?" prompt instead of any tile, keeping the whole feature opt-in.
-- Banking has no habit_challenges entry (it's a one-off savings nudge, not
-- a streak/target), so it's included here even though it never appears as
-- a key in habit_challenges above.
alter table public.profiles add column if not exists chosen_habit text;
alter table public.profiles drop constraint if exists profiles_chosen_habit_check;
alter table public.profiles add constraint profiles_chosen_habit_check
  check (chosen_habit is null or chosen_habit in ('eating', 'commuting', 'flying', 'banking'));

-- Optional profile photo (Account page) - a small square JPEG data URL,
-- cropped/resized to 200x200 client-side on upload (see
-- cropAndResizeImage()/handleAvatarFileSelected() in app.js) rather than a
-- Supabase Storage object: this is the only image anywhere in the app, so
-- one more text column on a row already synced by persistProfile() is
-- simpler than standing up a storage bucket + its own policies for a
-- single use. The length cap is a defense-in-depth backstop matching the
-- client-side AVATAR_MAX_DATA_URL_LENGTH check (which rejects an oversized
-- result before it's ever sent) - comfortably above a typical ~15-40KB
-- compressed avatar, well below anything that could bloat the row.
alter table public.profiles add column if not exists avatar_data_url text;
alter table public.profiles drop constraint if exists profiles_avatar_data_url_check;
alter table public.profiles add constraint profiles_avatar_data_url_check
  check (avatar_data_url is null or char_length(avatar_data_url) <= 300000);

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

-- Per-category kg breakdown (commute_food_kg/total_kg only give combined
-- figures) - computed and stored client-side the same way as those two,
-- so commute_kg + food_kg = commute_food_kg and + alcohol_kg = total_kg.
-- Mainly for the research export (research_weeks view below), which needs
-- an actual kg CO2e breakdown per category, not just the raw day-by-day
-- commute/diet choices.
alter table public.weeks add column if not exists commute_kg numeric not null default 0;
alter table public.weeks add column if not exists food_kg numeric not null default 0;
alter table public.weeks add column if not exists alcohol_kg numeric not null default 0;

-- One-off "additional journeys" (This Week page, under Alcohol) - trips
-- beyond the regular day-by-day commute above, e.g. a weekend trip or an
-- errand. Array of { day, mode, km } objects. Same as alcohol above: not
-- gated by the per-day confirm flow, counts toward commute_kg/total_kg
-- (computed client-side, see journeyFootprint() in app.js) as soon as one
-- is added.
alter table public.weeks add column if not exists extra_journeys jsonb not null default '[]'::jsonb;

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
--
-- Every function below is preceded by a DROP FUNCTION IF EXISTS: Postgres
-- rejects CREATE OR REPLACE FUNCTION when the return columns change
-- ("cannot change return type of existing function" / "Row type defined
-- by OUT parameters is different"), and several of these have gained
-- columns across earlier versions of this file. Dropping first makes
-- every function here safe to re-run regardless of which version you last
-- applied.
drop function if exists public.find_user_by_email(text);

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

-- Count of days (0-7) where BOTH commute and diet are confirmed for a
-- week - the same per-day bar as a "✓ FULL" week just applied one day at
-- a time, used by friend_leaderboard() below to rank a live, still-in-
-- progress week fairly (by average daily kg) rather than by raw total,
-- which would otherwise reward simply not having logged yet.
drop function if exists public.week_days_confirmed(jsonb, jsonb);

create or replace function public.week_days_confirmed(confirmed_commute jsonb, confirmed_diet jsonb)
returns integer
language sql
immutable
as $$
  select
    (case when confirmed_commute @> '{"mon":true}'::jsonb and confirmed_diet @> '{"mon":true}'::jsonb then 1 else 0 end) +
    (case when confirmed_commute @> '{"tue":true}'::jsonb and confirmed_diet @> '{"tue":true}'::jsonb then 1 else 0 end) +
    (case when confirmed_commute @> '{"wed":true}'::jsonb and confirmed_diet @> '{"wed":true}'::jsonb then 1 else 0 end) +
    (case when confirmed_commute @> '{"thu":true}'::jsonb and confirmed_diet @> '{"thu":true}'::jsonb then 1 else 0 end) +
    (case when confirmed_commute @> '{"fri":true}'::jsonb and confirmed_diet @> '{"fri":true}'::jsonb then 1 else 0 end) +
    (case when confirmed_commute @> '{"sat":true}'::jsonb and confirmed_diet @> '{"sat":true}'::jsonb then 1 else 0 end) +
    (case when confirmed_commute @> '{"sun":true}'::jsonb and confirmed_diet @> '{"sun":true}'::jsonb then 1 else 0 end);
$$;

revoke all on function public.week_days_confirmed(jsonb, jsonb) from public;
grant execute on function public.week_days_confirmed(jsonb, jsonb) to authenticated;

-- Leaderboard: self + accepted friends' totals for one week, with display
-- names. Everything else about a friend's week stays private. Only weeks
-- with at least one confirmed day are included - otherwise a week with
-- nothing but unconfirmed drafts (total_kg = 0) would misleadingly rank as
-- a perfect zero-carbon week.
--
-- Ranked by average daily kg (total_kg / days_confirmed), not raw
-- total_kg - this is the one leaderboard that deliberately works on a
-- live, still-in-progress week (see week_is_fully_confirmed()'s comment
-- below), so ranking by total would let someone who's simply behind on
-- logging (say, only Monday confirmed by Friday) look artificially
-- "better" than someone who's confirmed every day so far - not because
-- they emit less, but because they've logged less. days_confirmed is
-- also returned so the client can show "X/Y days" alongside the total.
drop function if exists public.friend_leaderboard(text);

create or replace function public.friend_leaderboard(target_week_key text)
returns table (user_id uuid, display_name text, total_kg numeric, days_confirmed integer, is_self boolean)
language sql
security definer
set search_path = public
as $$
  select
    w.user_id, p.display_name, w.total_kg,
    public.week_days_confirmed(w.confirmed_commute, w.confirmed_diet) as days_confirmed,
    (w.user_id = auth.uid()) as is_self
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
  order by (w.total_kg / greatest(1, public.week_days_confirmed(w.confirmed_commute, w.confirmed_diet))) asc;
$$;

revoke all on function public.friend_leaderboard(text) from public;
grant execute on function public.friend_leaderboard(text) to authenticated;

-- Same ranking logic as friend_leaderboard() above (average daily kg,
-- at-least-one-confirmed-day gate, live in-progress week), but scoped to
-- everyone with leaderboard_opt_in = true instead of accepted friends -
-- opting in makes your display_name and this week's total_kg visible to
-- any signed-in user calling this, filtered by university/country if
-- given (both optional; null means "everyone opted in, regardless").
-- is_self is still computed, and your own row is still included whenever
-- it matches the filters AND you've opted in - not opting in hides you
-- from this list entirely, including from your own view of it, since the
-- whole point of the toggle is controlling your own visibility.
drop function if exists public.public_leaderboard(text, text, text);

create or replace function public.public_leaderboard(target_week_key text, filter_university text default null, filter_country text default null)
returns table (user_id uuid, display_name text, total_kg numeric, days_confirmed integer, is_self boolean)
language sql
security definer
set search_path = public
as $$
  select
    w.user_id, p.display_name, w.total_kg,
    public.week_days_confirmed(w.confirmed_commute, w.confirmed_diet) as days_confirmed,
    (w.user_id = auth.uid()) as is_self
  from public.weeks w
  join public.profiles p on p.id = w.user_id
  where w.week_key = target_week_key
    and p.leaderboard_opt_in = true
    and (filter_university is null or p.university = filter_university)
    and (filter_country is null or p.country = filter_country)
    and (
      exists (select 1 from jsonb_each_text(w.confirmed_commute) kv where kv.value = 'true')
      or exists (select 1 from jsonb_each_text(w.confirmed_diet) kv where kv.value = 'true')
    )
  order by (w.total_kg / greatest(1, public.week_days_confirmed(w.confirmed_commute, w.confirmed_diet))) asc;
$$;

revoke all on function public.public_leaderboard(text, text, text) from public;
grant execute on function public.public_leaderboard(text, text, text) to authenticated;

-- Every day of the week (both commute and diet) confirmed - a stricter bar
-- than friend_leaderboard()'s "at least one confirmed day", used below for
-- averages so a week where only Monday got confirmed doesn't drag the
-- average down as if it were a real full week. NOT used for
-- friend_leaderboard() itself, which needs to keep working on a live,
-- still-in-progress "this week".
drop function if exists public.week_is_fully_confirmed(jsonb);

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
drop function if exists public.friend_weekly_average();

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

-- ---------- Leaderboard leagues (Vegan / Veggie / Commute / Flight-free) ----------
-- Three helpers, each "every CONFIRMED day this week matched, and at
-- least one day was confirmed" (an unconfirmed day is unknown, not a
-- pass or a fail, and a week with nothing confirmed at all shouldn't
-- register as a perfect week by default) - same privacy shape as
-- week_days_confirmed() above: reads the raw diet/commute jsonb, but
-- only ever returns a single boolean, never the day-by-day detail
-- itself. week_is_veggie also passes for a fully vegan week (vegan is a
-- stricter subset of meat-free, not a separate condition), so someone in
-- the Vegan league is in the Veggie league too, same as real dietary
-- categories nest.
drop function if exists public.week_is_vegan(jsonb, jsonb);

create or replace function public.week_is_vegan(diet jsonb, confirmed_diet jsonb)
returns boolean
language sql
immutable
as $$
  select
    exists (select 1 from jsonb_each_text(confirmed_diet) kv where kv.value = 'true')
    and not exists (
      select 1 from jsonb_each_text(confirmed_diet) kv
      where kv.value = 'true' and coalesce(diet -> kv.key ->> 'type', '') <> 'vegan'
    );
$$;

revoke all on function public.week_is_vegan(jsonb, jsonb) from public;
grant execute on function public.week_is_vegan(jsonb, jsonb) to authenticated;

drop function if exists public.week_is_veggie(jsonb, jsonb);

create or replace function public.week_is_veggie(diet jsonb, confirmed_diet jsonb)
returns boolean
language sql
immutable
as $$
  select
    exists (select 1 from jsonb_each_text(confirmed_diet) kv where kv.value = 'true')
    and not exists (
      select 1 from jsonb_each_text(confirmed_diet) kv
      where kv.value = 'true' and coalesce(diet -> kv.key ->> 'type', '') = 'meat'
    );
$$;

revoke all on function public.week_is_veggie(jsonb, jsonb) from public;
grant execute on function public.week_is_veggie(jsonb, jsonb) to authenticated;

drop function if exists public.week_is_car_free(jsonb, jsonb);

create or replace function public.week_is_car_free(commute jsonb, confirmed_commute jsonb)
returns boolean
language sql
immutable
as $$
  select
    exists (select 1 from jsonb_each_text(confirmed_commute) kv where kv.value = 'true')
    and not exists (
      select 1 from jsonb_each_text(confirmed_commute) kv
      where kv.value = 'true' and coalesce(commute ->> kv.key, '') = 'car'
    );
$$;

revoke all on function public.week_is_car_free(jsonb, jsonb) from public;
grant execute on function public.week_is_car_free(jsonb, jsonb) to authenticated;

-- Self + accepted friends' league membership for one week - Vegan/Veggie/
-- Commute (car-free) from the three helpers above, plus flight_free_days
-- (days since the most recent DATED flight anywhere in profiles.flights,
-- null if none logged), plus is_on_track_for_goal. Deliberately doesn't
-- fall back to a "no history" streak the way the personal Habits card's
-- flightFreeStreakDays() does (that fallback exists so one person always
-- has a number to watch, but a group ranking should only compare people
-- against their actual logged history, not a self-declared "starting
-- now"). Same privacy shape as friend_leaderboard()/friend_weekly_average()
-- above: reads the raw diet/commute/flights jsonb server-side, returns
-- only the derived per-person flags a client can safely see.
--
-- is_on_track_for_goal mirrors the client's own goalForWeek()/statusClass()
-- definition: total_kg so far this week at or under weekly_goal_kg
-- prorated to how much of the week has elapsed (Monday = 1/7 ... Sunday =
-- 7/7) - trivially true for everyone before anyone's logged anything, so
-- it also requires at least one confirmed day this week, same gate
-- friend_leaderboard() uses. day_index is supplied by the client (which
-- day of the week it is where THEY are, 1=Monday..7=Sunday) rather than
-- computed from the server's current_date, since the server has no
-- reliable notion of the caller's local day - same reasoning
-- target_week_key is already client-supplied for. Defaults to 7 (a full
-- week, i.e. no proration) so an old client that doesn't pass it yet still
-- gets a sane, if less precise, answer instead of an error.
drop function if exists public.friend_leagues(text);
drop function if exists public.friend_leagues(text, integer);

create or replace function public.friend_leagues(target_week_key text, day_index integer default 7)
returns table (
  user_id uuid, display_name text, is_self boolean,
  is_vegan_week boolean, is_veggie_week boolean, is_car_free_week boolean,
  flight_free_days integer, is_on_track_for_goal boolean
)
language sql
security definer
set search_path = public
as $$
  select
    p.id as user_id,
    p.display_name,
    (p.id = auth.uid()) as is_self,
    coalesce(public.week_is_vegan(w.diet, w.confirmed_diet), false) as is_vegan_week,
    coalesce(public.week_is_veggie(w.diet, w.confirmed_diet), false) as is_veggie_week,
    coalesce(public.week_is_car_free(w.commute, w.confirmed_commute), false) as is_car_free_week,
    (
      select (current_date - max((f ->> 'date')::date))::int
      from jsonb_array_elements(coalesce(p.flights, '[]'::jsonb)) f
      where f ->> 'date' is not null
    ) as flight_free_days,
    (
      (
        exists (select 1 from jsonb_each_text(coalesce(w.confirmed_commute, '{}'::jsonb)) kv where kv.value = 'true')
        or exists (select 1 from jsonb_each_text(coalesce(w.confirmed_diet, '{}'::jsonb)) kv where kv.value = 'true')
      )
      and coalesce(w.total_kg, 0) <= p.weekly_goal_kg * (greatest(1, least(7, day_index))::numeric / 7)
    ) as is_on_track_for_goal
  from public.profiles p
  left join public.weeks w on w.user_id = p.id and w.week_key = target_week_key
  where
    p.id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = auth.uid() and f.addressee_id = p.id)
          or (f.addressee_id = auth.uid() and f.requester_id = p.id))
    );
$$;

revoke all on function public.friend_leagues(text, integer) from public;
grant execute on function public.friend_leagues(text, integer) to authenticated;

-- App-wide averages across every account, not just friends - for the
-- Leaderboard page's "Everyone on the app" card. Two figures:
--   avg_commute_food_alcohol_kg - commute + food + alcohol (total_kg), no
--     duplicated math needed since it's already stored per week. This
--     used to be commute + food only (commute_food_kg, excluding
--     alcohol) - widened to include alcohol too, since there's no longer
--     a good reason for this figure to leave it out when the fuller
--     avg_total_kg figure right next to it already includes it.
--   avg_total_kg - the fuller figure that matches "Stats page yearly
--     total / 52" for each user (commute + food + alcohol, plus a
--     weekly-equivalent share of flights, home energy, buying goods, and
--     any optional extras they've answered - mirrors weeklyExtrasFor() in
--     app.js). Computing this needs every eligible user's profile, which
--     this function can't expose row-by-row without breaking the
--     "aggregate only" privacy guarantee it exists for - so unlike the
--     client-side friends version, the emission-factor constants below are
--     duplicated into SQL. Flying is the one exception - it reads the
--     pre-computed flying_yearly_kg column instead of re-implementing the
--     continent/class lookup here (see computeFlyingYearlyKg() in app.js).
--     If any of GRID_ELECTRICITY_KG_PER_KWH, CLOTHING_ITEM_KG,
--     GAS_HEATING_KG_PER_KWH, TRANSPORT_FACTORS.car,
--     CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR, DOG_KG_PER_YEAR,
--     CAT_KG_PER_YEAR, WATER_KG_PER_M3, or BANK_KG_PER_POUND_PER_YEAR ever
--     change in app.js, update the matching literal here too.
-- Deliberately returns ONLY these two aggregates plus a headcount - never
-- any user_id, name, or per-person row - so it's safe to expose to any
-- signed-in user with no friendship relationship required.
--
-- This function's output columns have changed more than once (most
-- recently: avg_commute_food_kg -> avg_commute_food_alcohol_kg); Postgres
-- won't let CREATE OR REPLACE change a function's output columns, so the
-- old version has to be dropped first (safe: nothing else in this schema
-- depends on it).
drop function if exists public.app_wide_weekly_average();

create or replace function public.app_wide_weekly_average()
returns table (avg_commute_food_alcohol_kg numeric, avg_total_kg numeric, user_count integer)
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
      pu.avg_commute_food_alcohol_kg as avg_commute_food_alcohol_kg,
      pu.avg_commute_food_alcohol_kg
        + (
            coalesce(p.flying_yearly_kg, 0)
            + (coalesce(p.household_kwh_per_month, 0) * 12 * 0.2) / greatest(1, coalesce(p.household_people, 1))
            + (coalesce(p.clothes_per_month, 0) * 12 * 10)
            + case when p.annual_gas_kwh is not null then (p.annual_gas_kwh * 0.18) / greatest(1, coalesce(p.household_people, 1)) else 0 end
            + case when p.weekly_noncommute_car_km is not null then
                p.weekly_noncommute_car_km * 52 * (case p.car_fuel_type
                  when 'diesel' then 0.171
                  when 'hybrid' then 0.111
                  when 'electric' then 0.058
                  else 0.171
                end)
              else 0 end
            + case when p.owns_car then 700 else 0 end
            + case when p.num_dogs is not null or p.num_cats is not null then
                (coalesce(p.num_dogs, 0) * 770 + coalesce(p.num_cats, 0) * 310) / greatest(1, coalesce(p.household_people, 1))
              else 0 end
            + case when p.annual_water_m3 is not null then (p.annual_water_m3 * 0.32) / greatest(1, coalesce(p.household_people, 1)) else 0 end
            + case when p.bank_name is not null and p.bank_balance is not null then
                p.bank_balance * (case p.bank_name
                  when 'barclays' then 0.2376
                  when 'hsbc' then 0.2170
                  when 'firstDirect' then 0.2170
                  when 'chase' then 0.1897
                  when 'santander' then 0.1742
                  when 'natwest' then 0.1295
                  when 'rbs' then 0.1295
                  when 'monzo' then 0.1088
                  when 'lloyds' then 0.0704
                  when 'halifax' then 0.0704
                  when 'metroBank' then 0.0694
                  when 'starling' then 0.0610
                  when 'virginMoney' then 0.0517
                  when 'nationwide' then 0.0432
                  when 'cooperative' then 0.0328
                  when 'triodos' then 0.0317
                  else 0
                end)
              else 0 end
          ) / 52.0 as avg_total_kg
    from per_user pu
    join public.profiles p on p.id = pu.user_id
  )
  select
    coalesce(avg(avg_commute_food_alcohol_kg), 0) as avg_commute_food_alcohol_kg,
    coalesce(avg(avg_total_kg), 0) as avg_total_kg,
    count(*)::int as user_count
  from per_user_extras;
$$;

revoke all on function public.app_wide_weekly_average() from public;
grant execute on function public.app_wide_weekly_average() to authenticated;

-- Same duplicated-formula pattern as app_wide_weekly_average() above (see
-- its comment for why - can't read other users' profiles client-side, so
-- this has to recompute the yearly-extras formula in SQL too), scoped to
-- whichever university is passed in - backs the Home page's "Uni average"
-- comparison chip. Returns a weekly-equivalent figure (same convention as
-- app_wide_weekly_average()), which app.js multiplies by 52 for the yearly
-- comparison. If the formula above ever changes, this needs the same edit.
create or replace function public.university_weekly_average(target_university text)
returns table (avg_total_kg numeric, user_count integer)
language sql
security definer
set search_path = public
as $$
  with eligible_weeks as (
    select w.user_id, w.total_kg
    from public.weeks w
    where
      public.week_is_fully_confirmed(w.confirmed_commute)
      and public.week_is_fully_confirmed(w.confirmed_diet)
  ),
  per_user as (
    select user_id, avg(total_kg) as avg_commute_food_alcohol_kg
    from eligible_weeks
    group by user_id
  ),
  per_user_extras as (
    select
      pu.avg_commute_food_alcohol_kg
        + (
            coalesce(p.flying_yearly_kg, 0)
            + (coalesce(p.household_kwh_per_month, 0) * 12 * 0.2) / greatest(1, coalesce(p.household_people, 1))
            + (coalesce(p.clothes_per_month, 0) * 12 * 10)
            + case when p.annual_gas_kwh is not null then (p.annual_gas_kwh * 0.18) / greatest(1, coalesce(p.household_people, 1)) else 0 end
            + case when p.weekly_noncommute_car_km is not null then
                p.weekly_noncommute_car_km * 52 * (case p.car_fuel_type
                  when 'diesel' then 0.171
                  when 'hybrid' then 0.111
                  when 'electric' then 0.058
                  else 0.171
                end)
              else 0 end
            + case when p.owns_car then 700 else 0 end
            + case when p.num_dogs is not null or p.num_cats is not null then
                (coalesce(p.num_dogs, 0) * 770 + coalesce(p.num_cats, 0) * 310) / greatest(1, coalesce(p.household_people, 1))
              else 0 end
            + case when p.annual_water_m3 is not null then (p.annual_water_m3 * 0.32) / greatest(1, coalesce(p.household_people, 1)) else 0 end
            + case when p.bank_name is not null and p.bank_balance is not null then
                p.bank_balance * (case p.bank_name
                  when 'barclays' then 0.2376
                  when 'hsbc' then 0.2170
                  when 'firstDirect' then 0.2170
                  when 'chase' then 0.1897
                  when 'santander' then 0.1742
                  when 'natwest' then 0.1295
                  when 'rbs' then 0.1295
                  when 'monzo' then 0.1088
                  when 'lloyds' then 0.0704
                  when 'halifax' then 0.0704
                  when 'metroBank' then 0.0694
                  when 'starling' then 0.0610
                  when 'virginMoney' then 0.0517
                  when 'nationwide' then 0.0432
                  when 'cooperative' then 0.0328
                  when 'triodos' then 0.0317
                  else 0
                end)
              else 0 end
          ) / 52.0 as avg_total_kg
    from per_user pu
    join public.profiles p on p.id = pu.user_id
    where p.university = target_university
  )
  select
    coalesce(avg(avg_total_kg), 0) as avg_total_kg,
    count(*)::int as user_count
  from per_user_extras;
$$;

revoke all on function public.university_weekly_average(text) from public;
grant execute on function public.university_weekly_average(text) to authenticated;

-- Total accounts ever created (auth.users), not just people with a
-- confirmed week the way app_wide_weekly_average()'s user_count is scoped -
-- backs the Leaderboard's "Everyone on the app" card. Just a count, no
-- rows/emails/names returned, so unlike the research-export functions
-- below this is safe to expose to every signed-in user, not just the app
-- owner. security definer + explicit search_path so it can read auth.users
-- (not otherwise selectable by the authenticated role) without granting
-- broader access to it.
create or replace function public.total_signups()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int from auth.users;
$$;

revoke all on function public.total_signups() from public;
grant execute on function public.total_signups() to authenticated;

-- ==================== research opt-in views ====================

-- For calibrating the UK_AVERAGE_ASSUMPTIONS / UK-average methodology in
-- app.js against real usage data, once enough people have opted in (see
-- research_opt_in on profiles, off by default). Two views, each already
-- filtered to opted-in users only:
--   research_profiles - one row per opted-in user: the yearly-estimate
--     inputs from the Stats page (commute distance, household size, flights,
--     home energy, clothing, gas heating, non-commute driving, car
--     ownership, pets, water). Deliberately excludes id, display_name,
--     weekly_goal_kg, and both bank_name/bank_balance - banking is excluded
--     per the opt-in's own description ("all anonymous data bar banking"),
--     and id/display_name are excluded so a row can't be tied back to a
--     specific account from this view alone.
--   research_weeks - one row per opted-in user per week: the actual
--     day-by-day commute/diet choices and alcohol figures behind their
--     weekly totals, useful for checking the real distribution of commute
--     modes and meat/veggie/vegan choices against the assumptions in
--     UK_AVERAGE_ASSUMPTIONS, PLUS the actual computed kg CO2e breakdown
--     for that week (commute_kg, food_kg, alcohol_kg, and the pre-existing
--     commute_food_kg/total_kg combined figures) - so the exported data
--     covers both "what did they choose" and "what did it come to in
--     kg CO2e", not just one or the other. Also excludes user_id/display_name.
--     Also includes the user's one-way commute_distance_km (from profiles,
--     via the join already needed for the research_opt_in check) so the
--     Excel export's commute-mode breakdown can compute an actual kg CO2e
--     figure per mode, not just a count - a coarse km figure on its own
--     doesn't identify anyone, and this view still can't be joined back to
--     research_profiles (no shared key between them).
--
-- Neither view is granted to `authenticated` or `anon` - the app itself
-- never queries them, and a signed-in user has no way to read them through
-- the client. They're for the app owner only, via the Supabase SQL Editor
-- (which connects with full database access regardless of grants/RLS) -
-- e.g. `select * from public.research_profiles;`. This is "anonymous" in
-- the sense that nothing here is exposed to other users or to the client
-- app, and no name/email/id travels with the row - but since this is the
-- app owner's own database, cross-referencing auth.users directly would
-- still theoretically be possible; these views just don't do that
-- correlation themselves.
create or replace view public.research_profiles as
select
  commute_distance_km,
  food_waste_bracket,
  short_haul_flights_per_year,
  long_haul_flights_per_year,
  household_people,
  household_kwh_per_month,
  clothes_per_month,
  annual_gas_kwh,
  weekly_noncommute_car_km,
  owns_car,
  num_dogs,
  num_cats,
  annual_water_m3,
  car_fuel_type,
  flights,
  flying_yearly_kg,
  electricity_bill_from,
  electricity_bill_to,
  electricity_bill_kwh
from public.profiles
where research_opt_in = true;

-- New output columns must be appended at the end, never inserted before
-- existing ones - CREATE OR REPLACE VIEW treats columns positionally, so
-- inserting a column earlier in the list reads as "rename the existing
-- column at that position" and fails (verified: reproduced
-- "cannot change name of view column ... to ..." by upgrading a database
-- that already had the old column order, then fixed by moving the three
-- new columns after commute_food_kg/total_kg instead of before them).
create or replace view public.research_weeks as
select
  w.week_key,
  w.commute,
  w.diet,
  w.confirmed_commute,
  w.confirmed_diet,
  w.alcohol,
  w.commute_food_kg,
  w.total_kg,
  w.commute_kg,
  w.food_kg,
  w.alcohol_kg,
  p.commute_distance_km,
  w.extra_journeys
from public.weeks w
join public.profiles p on p.id = w.user_id
where p.research_opt_in = true;

revoke all on public.research_profiles from public, authenticated, anon;
revoke all on public.research_weeks from public, authenticated, anon;

-- In-app access to the two views above, for the Account page's "Download
-- opted-in research data" button (only shown there when signed in as the
-- app owner) - an alternative to querying the views directly in the SQL
-- Editor. Unlike the views, these ARE granted to `authenticated` so the
-- client can call them via RPC, but each one only ever returns rows when
-- the caller's own auth.users email matches the hardcoded owner email
-- below - anyone else gets an empty result, not an error, so the
-- function's existence doesn't itself reveal anything. If the app owner's
-- account email ever changes, update the literal in both functions.
drop function if exists public.research_export_profiles();

create or replace function public.research_export_profiles()
returns setof public.research_profiles
language sql
security definer
set search_path = public
as $$
  select rp.* from public.research_profiles rp
  where (select email from auth.users where id = auth.uid()) = 'jack.s.brown@outlook.com';
$$;

revoke all on function public.research_export_profiles() from public;
grant execute on function public.research_export_profiles() to authenticated;

drop function if exists public.research_export_weeks();

create or replace function public.research_export_weeks()
returns setof public.research_weeks
language sql
security definer
set search_path = public
as $$
  select rw.* from public.research_weeks rw
  where (select email from auth.users where id = auth.uid()) = 'jack.s.brown@outlook.com';
$$;

revoke all on function public.research_export_weeks() from public;
grant execute on function public.research_export_weeks() to authenticated;

-- ==================== account deletion ====================

-- Lets a signed-in user permanently delete their own account (Account
-- page, "Delete account" - separate from "Reset all data", which only
-- clears profile/week data and keeps the login working). Apple's App
-- Store review guidelines require any app that supports account creation
-- to also offer account deletion that's easy to find, hence this.
--
-- SECURITY DEFINER because the authenticated/anon roles have no direct
-- access to auth.users - but scoped strictly to auth.uid(), so this can
-- only ever delete the CALLER's own account, never anyone else's, no
-- matter what id is passed in (nothing is passed in - there's no
-- parameter, it's always "whoever is calling this").
--
-- profiles, weeks, and friendships all have "on delete cascade" foreign
-- keys into auth.users(id) already, so deleting the auth.users row alone
-- cleans up every table this app owns - nothing else needs to run here.
drop function if exists public.delete_own_account();

create or replace function public.delete_own_account()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
