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
replace` so it's safe to run again, and it picks up the fix that lets both
sides of a pending friend request see each other's display name (previously
only accepted friends could).

The `@supabase/supabase-js` client library is vendored at
`vendor/supabase.js` rather than loaded from a CDN, so the app doesn't
depend on a third party being up at runtime. To update it later:
`npm pack @supabase/supabase-js@2`, extract `package/dist/umd/supabase.js`
from the tarball, and overwrite `vendor/supabase.js`.

## Note on the network sandbox this was built in

The environment this app was developed in blocks outbound connections to
`supabase.co` by policy, so the login/friends/leaderboard code could not be
tested end-to-end against a live project from there — only the logged-out
UI (forms, validation, tab navigation) could be verified directly. The
Supabase API calls follow the documented supabase-js v2 interface, but you
should test the full sign-up → log in → add a friend → leaderboard flow
yourself once this is deployed somewhere with normal internet access, and
report back anything that doesn't work as expected.
