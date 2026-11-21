-- Run this in the Supabase SQL Editor (safe to run more than once).
-- Sign in with Apple: where Apple's token is kept so it can be revoked.
-- Also the last section of schema.sql.

-- ---------- Sign in with Apple: revoking Apple's token (November 2026) ----------
-- When someone signs in with Apple, the apple-token Edge Function keeps
-- Apple's refresh token so that, if they delete their account, it can
-- revoke it with Apple (App Store rule 5.1.1(v)). Only the service role
-- (the function) can read or write it; the row goes with the account.
create table if not exists public.apple_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  client_id text not null,
  updated_at timestamptz not null default now()
);
alter table public.apple_tokens enable row level security;
revoke all on public.apple_tokens from anon, authenticated;
grant select, insert, update, delete on public.apple_tokens to service_role;
