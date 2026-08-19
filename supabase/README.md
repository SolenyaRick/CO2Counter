# Supabase setup

The app's accounts, weeks, and friends data live in Supabase (hosted Postgres +
auth) once login is wired up. To set that up:

1. Go to https://supabase.com, sign up, and create a new project (pick any
   name/region; set a database password and keep it somewhere safe — you
   won't need it for the app itself).
2. Wait for provisioning to finish (a minute or two).
3. Open **SQL Editor** in the project sidebar, paste in the contents of
   `schema.sql` from this folder, and run it. This creates the `profiles`,
   `weeks`, and `friendships` tables with row-level security policies, plus
   two helper functions (`find_user_by_email`, `friend_leaderboard`) used for
   adding friends and building the leaderboard.
4. Go to **Project Settings > API** and copy two values:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **anon public** key (a long string starting with `eyJ...`)

   Both of these are safe to use in client-side code — they're meant to be
   public, and access is controlled by the row-level security policies in
   `schema.sql`, not by keeping the key secret. Do **not** use the
   `service_role` key in the app; that one bypasses row-level security
   entirely and must stay server-side only.
5. By default Supabase requires email confirmation before a new account can
   log in. For quicker local testing you can turn this off under
   **Authentication > Providers > Email > Confirm email**, then turn it back
   on before any real users sign up.
6. **Required for signup-confirmation and password-reset emails to actually
   work**: go to **Authentication > URL Configuration** and:
   - Set **Site URL** to wherever the app is actually hosted -
     `https://co2counter.co.uk/` once that domain is live (see
     `README.md`'s "iOS app (Capacitor)" section), or
     `https://solenyarick.github.io/CO2Counter/` in the meantime.
   - Add that same URL under **Redirect URLs** (a wildcard like
     `https://co2counter.co.uk/**` also works, and covers local testing
     origins too if you add e.g. `http://localhost:8000/**`).

   The app tells Supabase where to send the user back to (via
   `emailRedirectTo`/`redirectTo`, computed from whatever URL the app is
   actually running at when the user signs up or requests a reset) - but
   Supabase silently ignores any redirect target that isn't on this
   allowlist and falls back to the Site URL default, which is
   `http://localhost:3000` until you change it. Skipping this step is why
   email links can look like they "don't work" — they're likely redirecting
   to a `localhost` URL that doesn't exist for anyone but you, and only then
   if you happen to be running something on port 3000.

The app is already wired up to a Supabase project — its URL and anon key are
in the `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants near the top of
`app.js`. If you already ran an earlier version of `schema.sql`, re-run the
current version — every statement uses `drop ... if exists` / `create or
replace` / `add column if not exists` so it's safe to run again. Recent runs
add `confirmed_commute` and `confirmed_diet` columns to `weeks` (a day's
commute/diet pick is saved as soon as you choose it, but only counts toward
the weekly totals, chart, and leaderboard once you press that day's confirm
button — if you'd already entered test data before this column existed,
those days will show as unconfirmed/0 kg until confirmed again, nothing is
lost), plus flight/home-energy/clothing columns for the Stats page and a
`food_waste_bracket` column for the Account page's food-waste setting, all
on `profiles`. The latest run also adds a `friend_weekly_average()`
function, used by the Leaderboard page's "All-time weekly average" card;
`annual_gas_kwh`, `weekly_noncommute_car_km`, `owns_car`, `num_dogs`, and
`num_cats` columns on `profiles` for the Stats page's optional extras
(deliberately left nullable with no default, unlike every other profiles
column — null means "not answered" and the app excludes it from totals,
rather than treating it as 0); and an `app_wide_weekly_average()` function,
used by the Leaderboard page's "Everyone on the app" card. That function
returns only a single aggregate row (an average and a headcount) across
every account, never any per-user id, name, or row, so it's safe to expose
to any signed-in user without requiring a friendship; and an `alcohol`
jsonb column on `weeks` for the This Week page's weekly (not per-day)
alcohol tracker — not gated by the confirm flow, since every value there
(including 0) is already a real answer.

A later run adds a `week_is_fully_confirmed()` helper and tightens
`friend_weekly_average()` / `app_wide_weekly_average()` to only count a
week toward those averages once *every* day has both commute and diet
confirmed (previously just one confirmed day was enough), so a week where
you only logged Monday no longer drags the average down as if it were a
full week's data. `friend_leaderboard()` (the live "This week" ranking) is
deliberately left as-is, since it needs to keep working on a week that's
still in progress.

The latest run adds a `commute_food_kg` column to `weeks` (commute + food
only, i.e. `total_kg` minus alcohol - stored client-side the same way, so
no math needs duplicating in SQL for it) and changes
`app_wide_weekly_average()`'s return shape to two figures instead of one:
`avg_commute_food_kg` and a fuller `avg_total_kg` that also amortizes each
eligible user's flights, home energy, buying goods, and any optional
extras they've answered - the same composition as the Stats page's yearly
total ÷ 52. Unlike the friends version (which reads each friend's profile
client-side, where RLS already allows it), this app-wide function can't
expose per-user profile data without breaking its "aggregate only, no
per-user data" guarantee, so it duplicates the relevant emission-factor
constants directly in SQL - if any of those ever change in `app.js`
(flight/energy/goods/heating/car/pet/water factors), update the matching
literals in this function too, or the two "everyone on the app" figures
will quietly drift out of sync with the rest of the app.

A later run adds an `annual_water_m3` column to `profiles` for the
Stats page's water-usage optional extra (same nullable-with-no-default
pattern as the other optional extras), and includes it in
`app_wide_weekly_average()`'s duplicated formula above.

A later run adds `bank_name` and `bank_balance` columns to
`profiles` for the Stats page's banking optional extra (same
nullable-with-no-default pattern - both need answering for it to count),
and includes a per-bank lookup (mirroring `BANK_KG_PER_POUND_PER_YEAR` in
`app.js`, sourced from MotherTree's bank carbon emissions league table) in
`app_wide_weekly_average()`'s duplicated formula above. If a new bank is
ever added to that constant in `app.js`, add a matching `when` branch to
the `case p.bank_name` expression in this function too.

A later run adds a `research_opt_in` boolean column to `profiles`
(`false` by default, unlike every other column on this table - nothing is
shared until a user actively turns it on from the Account page) and two
views, `research_profiles` and `research_weeks`, which expose everything
covered by that opt-in - the Stats page's yearly-estimate inputs, and each
opted-in week's actual day-by-day commute/diet/alcohol figures - for
opted-in users only, with banking and any name/id/email always excluded.
Neither view is granted to the `authenticated` or `anon` roles Supabase's
client library uses, so the app itself has no way to read them and neither
does any other signed-in user - they're for the app owner only, queried
directly in the Supabase SQL Editor (`select * from
public.research_profiles;` / `research_weeks`), which connects with full
database access regardless of grants. This is meant for calibrating the
`UK_AVERAGE_ASSUMPTIONS` constants in `app.js` against real usage once
enough people opt in, rather than the rough bottom-up estimates they
currently hold.

The most recent run adds two functions, `research_export_profiles()` and
`research_export_weeks()`, as an in-app alternative to querying the two
views above directly - they back the Account page's "Download opted-in
research data" button (see `OWNER_EMAIL` in `app.js`, which only shows
that button when signed in as the owner). Unlike the views, both
functions ARE granted to `authenticated` so the client can call them via
RPC, but each one only returns rows when
`(select email from auth.users where id = auth.uid())` matches the
hardcoded owner email inside the function - anyone else calling either
RPC gets an empty array back, not an error, so the app can safely call
them from any signed-in session (the button being hidden for non-owners
is just UX; this server-side check is the actual access control).
Verified against a real Postgres instance that calling as the owner's id
returns the opted-in rows and calling as any other id returns none. If
the app owner's account email ever changes, update the literal in both
functions (and `OWNER_EMAIL` in `app.js`).

The most recent run adds `commute_kg`, `food_kg`, and `alcohol_kg`
columns to `weeks` - a per-category kg CO2e breakdown alongside the
pre-existing combined `commute_food_kg`/`total_kg` figures (computed and
stored client-side the same way, at `persistWeek()` time), and includes
all three in `research_weeks`. This was a real gotcha to get right: the
three new columns had to be appended to the END of that view's SELECT
list, not inserted before the pre-existing `commute_food_kg`/`total_kg`
columns - `CREATE OR REPLACE VIEW` treats output columns positionally,
so inserting a column earlier in the list reads as renaming whatever
existing column that position used to hold, and fails with
`ERROR: cannot change name of view column "commute_food_kg" to
"commute_kg"`. Reproduced this by upgrading a database that already had
the old column order before fixing the column order in this file -
apply this version fresh (or over an older one) and it won't happen.
The Excel export also now appends an "Average" and "Std Dev (sample)"
row under each sheet's data for every numeric column, computed
client-side in `app.js` from whatever `research_export_profiles()` /
`research_export_weeks()` return - not part of the schema itself, but
worth knowing the standard deviation is sample (n-1), not population,
and any column with fewer than two numeric values is left blank there
rather than showing a misleading 0.

The most recent run adds `p.commute_distance_km` to `research_weeks`
(via the join it already needed for the `research_opt_in` check) - a
coarse km figure that doesn't identify anyone on its own, and this view
still can't be joined back to `research_profiles` (no shared key). It
exists so the Excel export can compute an actual kg CO2e figure per
commute mode, not just a count. The export now has two more sheets,
"Meal Breakdown" and "Commute Breakdown", collating every day of every
*fully* confirmed opted-in week (every day, both commute and diet -
same bar as `week_is_fully_confirmed()`/`isFullyConfirmed()` elsewhere
in this app; a week where only a day or two got confirmed is excluded
entirely, not partially counted) into "how many of each per week, on
average" plus the kg CO2e that represents - e.g. "Beef: 1.0/week, 9.8kg
CO2e/week". Meal kg uses the same baseline meat/portion formula as
`foodFootprint()` in `app.js`, but without a per-user food-waste or
eating-out multiplier (neither is available in this anonymized rollup),
so it's the plain meal/portion figure on its own, not each user's exact
stored total. Verified all of this - the schema upgrade path, the new
column's data, and the breakdown math - against a real Postgres
instance and a mocked browser run with hand-calculated expected values.

The most recent run adds a `baseline_week_key` column to `profiles` -
nullable with no default, same "not answered" = "use the UK average"
pattern as the optional Stats-page extras. Lets a user pick one of their
own fully-confirmed weeks (Account page) to compare This Week's
"Compared to..." card against instead of the UK average. Deliberately
not a foreign key into `weeks` (which would need `(user_id, week_key)` -
composite foreign keys onto a table that isn't itself keyed that way
add real complexity for little benefit here) - if the referenced week
later gets un-confirmed or the account's data gets reset, the app just
falls back to the UK average client-side (`getBaselineWeekData()` in
`app.js`) rather than the column enforcing anything.

A later run adds a `delete_own_account()` function, backing the
Account page's "Delete account" button (Apple's App Store review
guidelines require any app that supports account creation to also offer
account deletion, easy to find - this is separate from "Reset all data",
which only clears profile/week data and leaves the login working).
`security definer` so it can reach `auth.users` (which `authenticated`/
`anon` have no direct access to), but the function takes no parameters
and always deletes `where id = auth.uid()` - it can only ever delete the
caller's own account, never anyone else's. `profiles`, `weeks`, and
`friendships` all already have `on delete cascade` foreign keys into
`auth.users(id)`, so deleting the `auth.users` row alone cleans up every
table this app owns - nothing else needs to run in this function.
Verified against a real Postgres instance with two users: one calling
`delete_own_account()` as themselves removed exactly their own auth,
profile, week, and shared-friendship rows, while the other user's data
was completely untouched.

A later run widens `app_wide_weekly_average()`'s first return
column from `avg_commute_food_kg` (commute + food only, excluding
alcohol) to `avg_commute_food_alcohol_kg` (commute + food + alcohol) -
there was no longer a good reason for the "Everyone on the app" card's
first figure to leave alcohol out when the fuller `avg_total_kg` figure
right next to it already includes it. The value is just `avg(total_kg)`
per eligible week (already computed internally as
`avg_commute_food_alcohol_kg` in the `per_user` CTE, previously only
used to help build `avg_total_kg`) - no new math, just returning a
figure that already existed under a different name. Since this renames
an output column, the function had to be dropped first (same
"cannot change return type" constraint as before) - verified by
upgrading a database seeded with the previous schema version and
confirming a clean apply, then checking the actual returned value
against a hand-inserted week.

The most recent run adds a `week_days_confirmed(confirmed_commute,
confirmed_diet)` helper (count of days, 0-7, where both are confirmed -
the per-day version of the existing `week_is_fully_confirmed()` bar) and
changes `friend_leaderboard()` to rank by average daily kg
(`total_kg / days_confirmed`) instead of raw `total_kg`, since that
function deliberately still works on a live, in-progress week - ranking
by total let someone who's simply behind on logging (e.g. only Monday
confirmed by Friday) look artificially "better" than a friend who's kept
every day current, purely because they'd logged less, not emitted less.
`days_confirmed` is now also returned alongside `total_kg`, so the
Leaderboard page can show "X kg total · D/E days" next to each person's
average. Verified against a real Postgres instance with two users - one
behind on logging with a worse per-day rate but a lower raw total, one
diligent with a better per-day rate but a higher raw total - confirming
the diligent one now correctly ranks first.

The most recent run adds a `car_fuel_type` column to `profiles`
(nullable, `check`-constrained to `diesel`/`hybrid`/`electric` or null,
same "not answered" = "use the blended-average car factor" pattern as the
other optional extras). This backs the This Year page's "What type of car
do you mainly drive?" question - the app-side `carFactorFor()` helper in
`app.js` swaps in a DEFRA-style per-fuel-type factor (~0.171 diesel,
~0.111 hybrid, ~0.058 electric) in place of the ~0.171 blended average,
for both logged commute days and the non-commute-driving extra. Also
divides the pets figure (`num_dogs`/`num_cats`) by household size, the
same way home energy/gas/water already were, since a household's pets
aren't really just one person's footprint - previously the full pets
figure was attributed entirely to whichever household member answered
the question. `app_wide_weekly_average()`'s duplicated formula was
updated to match both changes (a `case p.car_fuel_type` expression for
non-commute driving, and dividing the pets term by
`greatest(1, p.household_people)`) - neither change altered that
function's output columns, so no `drop function` was needed first, only
the internal formula. `research_profiles` also gains `car_fuel_type`,
appended at the end of its column list per the positional-columns
constraint noted above. Verified against a real Postgres instance
(hand-computed expected `avg_total_kg` for an electric-car, two-dog,
two-person household against the function's actual output) and a mocked
browser run confirming the This Year page's inputs and the Stats page's
resulting figures match.

The most recent run adds a `check` constraint to the `university` column
on `profiles` (already present in the file, but previously unconstrained -
`university is null or university in ('UCL', 'Imperial', 'KCL')`, same
nullable-optional pattern as `car_fuel_type`) and a new
`university_weekly_average(target_university text)` function - a near-copy
of `app_wide_weekly_average()`'s duplicated formula (see its own comment
for why the duplication exists), just with a `where p.university =
target_university` filter instead of aggregating every account. Backs the
Home page's "Uni average" comparison chip; `app.js` only calls it once the
signed-in user has picked a university, and only shows a real number once
`user_count` comes back at 3 or more, so the "average" is never just one
or two other people's data reflected back at the caller. If
`app_wide_weekly_average()`'s formula ever changes, this needs the same
edit - there was no clean way to share the duplicated SQL between the two
functions without a bigger refactor, so for now they have to be kept in
sync by hand, same as the client/SQL duplication already noted above.

While building this, found that the `university` column added earlier
was never actually wired up end-to-end on the client side - `app.js`
read the select's value into an in-memory `profile.university` on change,
but never included it in the row sent to `profiles` on save, never read
it back out of a loaded profile, and re-added a fresh change listener
every time the Account page rendered (accumulating duplicate listeners
per visit). Since no code path ever included `university` in the saved
row, no real account could have had a non-null value in the database
regardless of what the dropdown showed in a given session - fixed by
adding it to `ensureProfile()`/`profileToRow()`/`DEFAULT_PROFILE` like
every other profile field, moving the listener to the one-time wiring
block alongside the other Account page fields, and normalizing the
select's `"None"` sentinel value to `null` client-side (the check
constraint only allows `null` or an actual university, not the literal
string `"None"`).

The latest run adds a `total_signups()` function - a plain `select
count(*)::int from auth.users`, `security definer` so it can read
`auth.users` (not otherwise selectable by the `authenticated` role) without
granting broader access to it. Backs a new figure on the Leaderboard's
"Everyone on the app" card: total accounts ever created, not just the ones
with a confirmed week the way `app_wide_weekly_average()`'s `user_count` is
scoped. Just a count, no rows/emails/names returned, so - unlike the
research-export functions above, which are gated to the app owner's email -
this is granted to `authenticated` and safe for any signed-in user to call.

The latest run adds an `extra_journeys` jsonb column to `weeks` (default
`'[]'::jsonb`, an array of `{ day, mode, km }` objects) for the This Week
page's new "Additional journeys" section - one-off trips beyond the daily
commute. Same pattern as `alcohol`: not gated by the per-day confirm flow,
computed and folded into `commute_kg`/`total_kg` client-side (see
`journeyFootprint()` in `app.js`), so no SQL formula duplication needed for
it the way `app_wide_weekly_average()` needed for the yearly-extras
figures. Also appended to `research_weeks` (at the end of its column list,
per the positional-columns constraint noted above) for opted-in users.

The app no longer reads or writes the `weekly_noncommute_car_km` column on
`profiles` - the This Year page's "Non-commute driving (extra car km per
week)" question was removed, and the Home page now sources that figure from
the Car-mode slice of the `extra_journeys` column above instead (see
`extraCarJourneysFootprintForDay()` in `app.js`). The column itself is left
in place rather than dropped - no destructive schema change, and it isn't
free-floating: `app_wide_weekly_average()`, `friend_weekly_average()`, and
`university_weekly_average()` still reference it, so anyone who answered
that question before this change keeps contributing their old answer to
those aggregate averages indefinitely; no new profile will ever populate it
going forward, so its influence there only fades as those accounts age out
of the data, never anything that needs active cleanup.

The latest run adds five columns to `profiles`: `flights` (jsonb array of
`{ date, continent, class }` objects, default `'[]'::jsonb`) and
`flying_yearly_kg` (numeric, default 0) for the This Year page's itemized
flight log, replacing manual entry via `short_haul_flights_per_year`/
`long_haul_flights_per_year` (left in place, same "harmless unused column"
pattern as `weekly_noncommute_car_km` above); and `electricity_bill_from`,
`electricity_bill_to` (both `date`, nullable), `electricity_bill_kwh`
(numeric, nullable) for the bill-based electricity input, from which
`household_kwh_per_month` (already existed) is now derived client-side
(`computeElectricityMonthlyKwh()` in `app.js`) rather than typed in
directly - that column itself is unchanged, so nothing downstream needed
to change for it. `flying_yearly_kg` is a precomputed cache of the flight
log's total (`computeFlyingYearlyKg()`, using the FLIGHT_CONTINENT_KG/
FLIGHT_CLASS_MULTIPLIER factors in `emission-factors.js`), written
alongside the raw `flights` array purely so `app_wide_weekly_average()`
and `university_weekly_average()` can read a plain number instead of
re-implementing the continent/class lookup in SQL - both functions had
their duplicated flying formula
(`short_haul_flights_per_year * 250 + long_haul_flights_per_year * 1600`)
replaced with `coalesce(p.flying_yearly_kg, 0)`; neither function's output
columns changed, so no `drop function` was needed first. All five new
columns are also appended to `research_profiles` (at the end of its
column list, per the positional-columns constraint noted above) for
opted-in users.

The run after that adds one more column to `profiles`: `habit_challenges`
(jsonb, default `'{}'::jsonb`) for the Home page's "Habits" card - an
opt-in, time-boxed commitment to a specific behavior change (currently
"meatFree" or "noFlights"), shaped `{"meatFree": {"startDate": "...",
"targetDays": 30}}` with one key per habit that has an active challenge.
Unlike `flights`/`flying_yearly_kg` above, there's no companion
precomputed-total column here, because there's nothing for SQL to read:
the habit streaks themselves are never stored anywhere, always
recomputed client-side from data that already exists (confirmed diet
days, the `flights` array) - see `meatFreeStreakDays()`/
`flightFreeStreakDays()` in `app.js`. Deliberately **not** added to
`research_profiles` - it's a personal commitment/target a user set for
themselves, not a measured emissions input, same reasoning that already
excludes `weekly_goal_kg` from that view.

The run after that adds the Leaderboard page's "Leagues" card:
`week_is_vegan()`, `week_is_veggie()`, and `week_is_car_free()` (each
`(diet/commute jsonb, confirmed jsonb) returns boolean`, same
"immutable, no security definer needed" shape as `week_days_confirmed()`
above - "every CONFIRMED day this week matched, and at least one day was
confirmed") plus `friend_leagues(target_week_key text)`, a
`security definer` function in the same family as `friend_leaderboard()`/
`friend_weekly_average()`: self + accepted friends only, reads the raw
diet/commute/flights jsonb server-side but returns only the derived
per-person flags (`is_vegan_week`, `is_veggie_week`, `is_car_free_week`,
`flight_free_days`) - never the day-by-day detail itself, so a league
appearing on someone's Leaderboard reveals nothing about their other
days. `flight_free_days` (days since the most recent dated flight
anywhere in `profiles.flights`, null if none logged) deliberately
doesn't fall back to a challenge-start date the way the personal Habits
card's `flightFreeStreakDays()` does in `app.js` - a shared ranking
should only reflect people's actual logged history, not a self-declared
"starting now".

The run after that replaces `baseline_week_key` (a real week key picked
from the person's own tracked history) with a `baseline_week jsonb`
column: `{commuteMode, commuteDaysPerWeek, dietType, dietMeat,
dietPortion, alcoholBeer, alcoholWine}`, a self-described "typical week
from before you started tracking". The old approach broke down for anyone
whose habits changed a lot after they started using the app - there was
no real tracked week that represented "before". `app.js`'s
`buildBaselineWeekData()` expands this into a synthetic 7-day week (the
chosen commute mode fills the first N days matching
`commuteDaysPerWeek`, the rest "Didn't travel"; the diet entry repeats
every day) and runs it through the same `weekTotals()` math as a real
week, so it's not a second formula that could drift out of sync. Also
extends `friend_leagues()` with a Goal league: a new `day_index integer
default 7` parameter (1=Monday..7=Sunday, client-supplied - the server has
no reliable notion of the caller's local day, same reasoning
`target_week_key` is already client-supplied for) and a new
`is_on_track_for_goal` output column, true when the friend has at least
one confirmed day this week (so a blank week doesn't trivially qualify)
and their `total_kg` so far is at or under `weekly_goal_kg` prorated to
`day_index / 7` - mirrors `goalForWeek()`'s client-side proration exactly.
Since `weekly_goal_kg` always has a value (defaults to 20, never
null/unset), there's no separate "has a goal" flag to check - the
meaningful bar is just being on pace for whatever it's currently set to.
Both changes verified against a real Postgres instance (inserting rows
across a Monday/Wednesday day-index boundary and confirming
`is_on_track_for_goal` flips exactly where expected) and a mocked browser
run.

**If running this on a brand-new/empty database gave you
`ERROR: 42P01: relation "public.friendships" does not exist`**: that was a
real ordering bug (a `profiles` policy referenced the `friendships` table
before it existed yet in the file) — fixed by moving all `create table`
statements before any policy. Just re-run the current file; the tables it
already managed to create before hitting the error are safe (`create table
if not exists`), so nothing needs cleaning up first.

**If re-running this gave you
`ERROR: 42P13: cannot change return type of existing function` /
`DETAIL: Row type defined by OUT parameters is different.`**: Postgres
won't let `create or replace function` change a function's output columns
or parameter signature - `friend_weekly_average()`, `app_wide_weekly_average()`,
and `friend_leagues()` have each changed shape over time (gaining columns,
or in `friend_leagues()`'s case also a new `day_index` parameter), and the
file drops each one before recreating it for exactly this reason.
If you still hit this error, you're most likely on an older copy of this
file from before that fix — pull the latest version and re-run it; nothing
needs to be cleaned up by hand. (Verified by installing the old function
signature in a scratch database and confirming the current file applies
over it with no errors.)

The `@supabase/supabase-js` client library is vendored at
`vendor/supabase.js` rather than loaded from a CDN, so the app doesn't
depend on a third party being up at runtime. To update it later:
`npm pack @supabase/supabase-js@2`, extract `package/dist/umd/supabase.js`
from the tarball, and overwrite `vendor/supabase.js`.

## Note on the network sandbox this was built in

The environment this app was developed in blocks outbound connections to
`supabase.co` by policy, so nothing here could be tested against your real
project directly. The sign-in → app rendering flow (tables, footprints,
tabs) has since been verified by mocking the Supabase REST/auth endpoints
in a headless browser, which caught and fixed a real CSS bug (the login
screen not disappearing after sign-in). Anything that depends on your
actual data or the real friend_leaderboard()/find_user_by_email() functions
— confirming days, switching between this/last week, adding a friend by
email, the leaderboard — still hasn't been exercised against the live
project, so please test that yourself and report back anything unexpected.
