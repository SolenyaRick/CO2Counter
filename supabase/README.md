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
function, used by the Leaderboard page's "All-time weekly average" card.

**If running this on a brand-new/empty database gave you
`ERROR: 42P01: relation "public.friendships" does not exist`**: that was a
real ordering bug (a `profiles` policy referenced the `friendships` table
before it existed yet in the file) — fixed by moving all `create table`
statements before any policy. Just re-run the current file; the tables it
already managed to create before hitting the error are safe (`create table
if not exists`), so nothing needs cleaning up first.

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
