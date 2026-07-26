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

Once you have the Project URL and anon key, pass them along and the app's
login screen, friend requests, and leaderboard get wired up to use them.
