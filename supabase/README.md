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
   - Set **Site URL** to wherever the app is actually hosted, e.g.
     `https://solenyarick.github.io/CO2Counter/`.
   - Add that same URL under **Redirect URLs** (a wildcard like
     `https://solenyarick.github.io/CO2Counter/**` also works, and covers
     local testing origins too if you add e.g. `http://localhost:8000/**`).

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

The most recent run widens `app_wide_weekly_average()`'s first return
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
- only `friend_weekly_average()` and `app_wide_weekly_average()` have ever
changed shape (both gained columns over time), and the file now drops
`app_wide_weekly_average()` before recreating it for exactly this reason.
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
