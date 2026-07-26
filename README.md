# Weekly CO2 Tracker

A small client-side web app for tracking your weekly carbon footprint from
commuting and food.

## Pages

- **This Week** — the inputs. For each day (M–S) pick how you got to work
  (Walk, Cycle, Train, Car, or Didn't travel) and what you ate (Meat, Veggie,
  Vegan). Choosing Meat opens a dialog to pick the type of meat and roughly
  how much of it. Shows a running weekly total, a daily bar chart, and how
  much CO2e you'd have saved this week if every meat day had been veggie
  instead, broken down by meat type (e.g. beef vs chicken).
- **Weeks** — a grid of boxes, one per week (Mon–Sun), most recent first.
  Each box shows that week's total CO2e, color-coded against your goal from
  the Account page. Tap a box for a day-by-day breakdown.
- **Leaderboard** — ranks your own tracked weeks, lowest footprint first.
  (Ranking against other people would need shared accounts/a backend, which
  this static, local-storage-only version doesn't have yet.)
- **Account** — your display name, one-way commute distance, and weekly CO2e
  goal, plus export/import/reset for your data.

All data (profile + week history) is saved to your browser's local storage,
so it persists between visits on the same browser/device, but does not sync
across devices — there's no server/account system behind it.

## Running it

No build step or dependencies — it's static HTML/CSS/JS. Serve the folder
with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser.

(Opening `index.html` directly via `file://` also works in most browsers,
but some browsers restrict `localStorage` under `file://`, so a local server
is recommended.)

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

These are based on commonly cited average emission factors (in the style of
DEFRA conversion factors and Our World in Data / Poore & Nemecek food
footprint figures) and are meant to give a rough sense of relative impact,
not an exact measurement.
