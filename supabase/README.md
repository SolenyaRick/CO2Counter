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

The app is already wired up to a Supabase project — its URL and anon key are
in the `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants near the top of
`app.js`. If you already ran an earlier version of `schema.sql`, re-run the
current version — every statement uses `drop ... if exists` / `create or
replace` / `add column if not exists` so it's safe to run again. The latest
run adds `confirmed_commute` and `confirmed_diet` columns to `weeks`: a
day's commute/diet pick is saved as soon as you choose it, but only counts
toward the weekly totals, chart, and leaderboard once you press that day's
confirm button. **If you'd already entered test data before this column
existed**, those days will show as unconfirmed (0 kg) until you go back and
press confirm on them again — the raw choices themselves aren't lost.

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
