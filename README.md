# Weekly CO2 Tracker

A small client-side web app for tracking your weekly carbon footprint from
commuting and food.

## Features

- **Commute log**: for each day (M–S), pick how you got to work — Walk,
  Cycle, Train, Car, or Didn't travel. Set your one-way commute distance once
  and it's used for every day.
- **Food log**: for each day, pick Meat, Veggie, or Vegan. Choosing Meat opens
  a dialog to pick the type of meat and roughly how much of it.
- **Weekly summary**: totals for commute and food emissions, a combined
  weekly total, and a simple daily bar chart.
- Data is saved to your browser's local storage, so it persists between
  visits (per browser/device).

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
- **Food** (kg CO2e per day): Vegan ~0.9, Veggie ~1.5. A Meat day is
  calculated from the chosen meat type's average footprint per kg (e.g.
  beef and lamb are much higher than chicken or fish) times the chosen
  portion size, plus a small baseline for the rest of the day's food.

These are based on commonly cited average emission factors (in the style of
DEFRA conversion factors and Our World in Data / Poore & Nemecek food
footprint figures) and are meant to give a rough sense of relative impact,
not an exact measurement.
