# Weekly CO2 Tracker

A web app for tracking your weekly carbon footprint from commuting and food,
with accounts and a friends leaderboard backed by Supabase.

## Pages

- **Login** — email/password sign-in and sign-up (with a "forgot password"
  flow), gating the rest of the app.
- **This Week** — the inputs, toggleable between "This week" and "Last week".
  For each day (M–S) pick how you got to work (Walk, Cycle, Train, Car, or
  Didn't travel) and what you ate (Meat, Veggie, Vegan). Choosing Meat opens
  a dialog to pick the type of meat and roughly how much of it. A pick is
  saved as a draft immediately, but only counts toward the weekly totals,
  chart, and leaderboard once you press that day's ✓ confirm button (which
  plays a small pop animation) — changing a confirmed day's pick un-confirms
  it again. Also shows a "This week, in context" card that converts your
  confirmed total into an equivalent car-km distance (DEFRA-style car
  factor) and how much CO2e you'd have saved if every confirmed meat day had
  been veggie instead, broken down by meat type (e.g. beef vs chicken).
- **Weeks** — a grid of boxes, one per week (Mon–Sun), most recent first.
  Each box shows that week's total CO2e, color-coded against your goal from
  the Account page, with an over/under-goal indicator. Tap a box for a
  day-by-day breakdown.
- **Leaderboard** — you and your accepted friends, ranked by this week's
  total CO2e, lowest first.
- **Stats** — a yearly estimate: your confirmed weeks' average, extrapolated
  commute/food totals (×52), plus flights (short-haul European vs long-haul
  international), home energy (household kWh/month split across everyone in
  the household), and clothing purchases, each converted to a yearly kg
  CO2e figure and rolled into an estimated yearly total.
- **Account** — display name, one-way commute distance, weekly CO2e goal, a
  food-waste setting (0–3% / 3–10% / 10–30% / 30%+, scales up food figures
  everywhere to account for produced-but-wasted food), a friends list (add
  by email, accept/decline requests), sign-out, and export/import/reset for
  your data.

## Architecture

Static HTML/CSS/JS frontend (no build step) talking directly to
[Supabase](https://supabase.com) (Postgres + Auth) from the browser via the
vendored `@supabase/supabase-js` client in `vendor/supabase.js`. See
`supabase/README.md` for how the backend is set up and `supabase/schema.sql`
for the full schema — profiles, weeks, and friendships tables with
row-level security, so friends only ever see each other's weekly totals on
the leaderboard, never day-by-day commute/diet detail.

## Running it

No build step — it's static HTML/CSS/JS. Serve the folder with any static
file server, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser. (`file://` won't work here
since the Supabase client needs a real origin.)

You'll need your own Supabase project — see `supabase/README.md` — with its
URL and anon key set in the `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants
near the top of `app.js`.

## Emission factor assumptions

Figures are illustrative averages, not a precise personal carbon calculator:

- **Transport** (kg CO2e per passenger-km): Walk/Cycle 0, Train ~0.041, Car
  ~0.171. Applied to a round trip using your commute distance.
- **Food** (kg CO2e per day): Vegan ~0.9, Veggie ~1.5. A Meat day is the
  same ~1.5 kg baseline for the rest of that day's food (it isn't any more
  carbon-efficient just because the main is meat), plus the chosen meat
  type's average footprint per kg (beef and lamb much higher than chicken
  or fish) times the chosen portion size. So a meat day is always at least
  as high as a veggie day, e.g. a medium chicken portion comes to ~2.4 kg,
  a medium beef portion to ~5.6 kg.
- **Food waste** (Account page setting): scales every food figure by
  1/(1-waste%), using each bracket's midpoint — 0–3% → ×1.02, 3–10% → ×1.07,
  10–30% → ×1.25, 30%+ → ×1.67 (assuming 40%). Wasted food still carries the
  emissions it took to produce, so higher waste means you effectively have
  to account for more food produced than you actually eat.
- **Flying** (Stats page, per return trip): ~250 kg CO2e short-haul within
  Europe, ~1,600 kg CO2e long-haul international.
- **Home energy** (Stats page): household kWh/month × 12 × ~0.2 kg CO2e/kWh
  (rough grid average), divided evenly across everyone in the household.
- **Buying goods** (Stats page): ~10 kg CO2e per clothing item bought, a
  rough blended average across garment types.

These are based on commonly cited average emission factors (in the style of
DEFRA conversion factors and Our World in Data / Poore & Nemecek food
footprint figures) and are meant to give a rough sense of relative impact,
not an exact measurement.
