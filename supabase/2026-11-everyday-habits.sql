-- Run this in the Supabase SQL Editor (safe to run more than once).
-- Everyday habits: you can pick several habits in one area (a short shower
-- and the heating down a notch), so each one now counts on its own, up to
-- six a day, instead of one per area. Also in schema.sql.

create or replace function public.save_daily_habits(p_day date, p_habits text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text[];
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  -- Today or yesterday (a day either side for people abroad).
  if p_day is null or p_day < public.uk_today() - 1 or p_day > public.uk_today() + 1 then raise exception 'Only today or yesterday'; end if;
  -- Your everyday habits ("a3:meatfree": a food habit, from the person's
  -- options; several in one area are fine), plus the first six names from
  -- before. Each counts once a day, and at most six a day.
  select coalesce(array_agg(x.h order by x.h), '{}') into v
  from (
    select distinct h
    from unnest(coalesce(p_habits, '{}')) h
    where h ~ '^a[1-5]:[a-z0-9]{2,20}$'
       or h in ('meatfree', 'carfree', 'shower', 'heating', 'nothingnew', 'nowaste')
  ) x;
  if cardinality(v) > 6 then v := v[1:6]; end if;
  if cardinality(v) = 0 then
    delete from public.daily_habits where user_id = auth.uid() and day = p_day;
  else
    insert into public.daily_habits (user_id, day, habits, updated_at) values (auth.uid(), p_day, v, now())
    on conflict (user_id, day) do update set habits = excluded.habits, updated_at = now();
  end if;
end;
$$;
revoke all on function public.save_daily_habits(date, text[]) from public, anon;
grant execute on function public.save_daily_habits(date, text[]) to authenticated;
