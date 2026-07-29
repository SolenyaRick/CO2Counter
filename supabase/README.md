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

The most recent run adds a `research_opt_in` boolean column to `profiles`
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
