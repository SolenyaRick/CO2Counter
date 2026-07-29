# Weekly CO2 Tracker

A web app for tracking your weekly carbon footprint from commuting and food,
with accounts and a friends leaderboard backed by Supabase.

## Pages

- **Login** — email/password sign-in and sign-up (with a "forgot password"
  flow), gating the rest of the app.
- **This Week** — starts with a "Compared to an average week" card: a UK
  average week (commute + food only, the same bottom-up figures as the
  Stats page) shown alongside a savings-framed comparison against your
  week so far — "X kg CO2e saved vs an average week" (green) or "X kg
  over" (red), prorated to how far through the week it is the same way the
  Weeks-grid goal is. The point is you don't need to log every category for
  this to be meaningful, unlike apps that require comprehensive manual
  tracking before they'll show you anything. Below that, the inputs,
  toggleable between "This week" and "Last week". For each day (M–S) pick
  how you got to work (Walk, Cycle, Train, Car, or
  Didn't travel) and what you ate — a row of tap targets: Ve (vegan), Vg
  (veggie), then a meat-type emoji per option (🍗 🥓 🥩 🐟 🍖) — the cut/product
  rather than a live animal, so they're easy to tell apart at a glance and
  read a bit less "cutesy" than an animal-face emoji. Tapping a meat icon
  reveals a
  Small/Medium/Large portion picker right below it. Once any diet is picked,
  an In/Out toggle lets you say whether dinner was eaten in or out — eating
  out applies a rough 1.5&times; multiplier to just the dinner slice of that
  day's food footprint (the meat portion on a meat day, or half the flat
  figure on a veggie/vegan day), reflecting a restaurant/takeaway's extra
  energy use, portions, and food waste. A pick is saved as a draft
  immediately, but only counts toward the weekly totals, chart, and
  leaderboard once you press that day's ✓ confirm button (which plays a
  small pop animation) — changing a confirmed day's pick un-confirms it
  again. Today's row is highlighted (only when viewing "This week", not
  "Last week"). Below that, an "Alcohol this week" card is a whole-week (not
  per-day) figure: tap-to-fill rows of beer/wine icons set a weekly count
  (tap the current count again to clear it), plus an ABV% and shots count
  for other spirits — counts immediately, with no confirm step needed, since
  every value including 0 is already a real answer. Also shows a "This
  week, in context" card that converts your confirmed total into an
  equivalent car-km distance (DEFRA-style car factor) and how much CO2e
  you'd have saved if every confirmed meat day had been veggie instead,
  broken down by meat type (e.g. beef vs chicken). The weekly summary chart
  is a Monzo Trends-style "budget pace" line chart: a dashed target line
  burns straight down from your weekly goal to 0 across Mon–Sun, plotted
  against a solid line for your actual remaining budget (goal minus
  confirmed CO2e so far, with alcohol counted from the very start of the
  week since it isn't tied to a day). The line (and the area under it)
  turns from green to red if you dip below the dashed pace line — i.e.
  you're using CO2e faster than the week allows for — even if you haven't
  blown the full weekly goal yet. For the current week the actual line only
  draws up to today; it doesn't project the rest of the week for you.
- **Weeks** — a grid of boxes, one per week (Mon–Sun), most recent first.
  Each box shows that week's total CO2e, color-coded against your goal from
  the Account page, with an over/under-goal indicator. For the current,
  still-in-progress week, the goal itself is prorated to how much of the
  week has elapsed (e.g. Wednesday = 3/7 of the weekly goal) so "under
  goal" is meaningful before the week is actually over, rather than
  trivially true on day one. A week that has every day confirmed for both
  commute and food gets a "✓ FULL" badge — this is a stricter bar than just
  having *some* data (which is all that's needed for the box to show a
  total at all), and is what counts toward the "confirmed week" averages on
  the Stats and Leaderboard pages below, so a week where you only logged
  Monday doesn't drag those averages down as if it were a whole week's
  worth of data. Tap a box for a day-by-day breakdown.
- **Leaderboard** — three cards: "This week" ranks you and your accepted
  friends by this week's total CO2e (lowest first) with a callout for
  whoever's winning — this one still includes in-progress weeks, same as
  the Weeks grid; "All-time weekly average" ranks everyone by their average
  CO2e per *fully* confirmed week (every day, both commute and food — see
  the Weeks page above) since they started, which also folds in a
  weekly-equivalent share of each person's yearly Stats page figures
  (flights, home electricity, buying goods, and any optional extras
  they've answered — everything the yearly total on the Stats page
  includes besides commute/food/alcohol, divided by 52), so this figure
  and "Stats page yearly total ÷ 52" always agree; "Everyone on the app"
  shows two anonymous, aggregate figures across every account on the app —
  commute + food only, and the fuller total (same composition as above) —
  and how many people each is based on, with no per-user data or names
  ever exposed. The full-total figure is computed entirely in SQL (see
  `app_wide_weekly_average()` in `supabase/schema.sql`), since unlike the
  friends version it can't read individual accounts' profile data
  client-side — so its emission-factor constants are a second copy of the
  ones in `app.js` and need to be kept in sync by hand if either changes.
- **Stats** — a yearly estimate. Inputs (flights: short-haul European vs
  long-haul international; home energy: household kWh/month split across
  everyone in the household; clothing purchases per month; then an
  **Other factors** card of optional extras — gas/oil heating kWh/yr,
  extra non-commute car km/week, whether you own a car, number of dogs and
  cats, household water usage in m&sup3;/yr, and which bank you mainly hold
  money with plus a balance) come first, each converted
  to a yearly kg CO2e figure. The optional extras are skippable: leaving
  one blank leaves it out of every total below rather
  than counting it as zero, so an unanswered question never makes your
  estimate look artificially low. The "Your year, estimated" analysis
  card below rolls those together with your fully confirmed weeks' average
  commute/food/alcohol (extrapolated ×52) into an estimated yearly total,
  next to a
  rough percentile ("lower than ~X%" / "higher than ~X% of people in the
  UK", worded so it never reads backwards). Every domain tile (food,
  commute, flying, home energy, goods, and the six optional extras once
  answered) shows its own ▲/▼ delta against the UK average for that same
  category, not just the total. A "How your year compares" card at the
  bottom opens with your estimated total against the 1.5°C-by-2030 climate
  target (see below), then shows a UK average — built from the same core
  categories plus whichever optional extras you've personally answered, so
  the comparison is always apples-to-apples — alongside your total
  converted into car miles and mature-trees-of-CO2-absorption equivalents,
  each with a delta against the UK average.
- **Account** — display name, one-way commute distance, weekly CO2e goal
  (with three quick-set presets alongside typing your own number: "Match UK
  average week", "1.5°C 2030 (food + commute)" — our own estimate, since
  there's no official category-level split of the 1.5°C target — and "Match
  world average week", the roughest of the three since there's no global
  equivalent of the UK's national travel/diet surveys to build it from), a
  food-waste setting (0–3% / 3–10% / 10–30% / 30%+, scales up food figures
  everywhere to account for produced-but-wasted food), a "Help improve UK
  averages" opt-in (off by default — if turned on, everything on the
  Account/Stats pages except your banking answers becomes visible to the
  app developer for calibrating the UK-average assumptions against real
  data; your name/email/account are never included, see
  `supabase/README.md` for exactly how this is scoped — signed in as the
  app owner, this card also shows a "Download opted-in research data"
  button that pulls every opted-in user's data, gated server-side on the
  signed-in account's email rather than anything checkable client-side), a
  friends list (add by email, accept/decline requests), sign-out, and
  export/import/reset for your data.

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
- **Food** (kg CO2e per day): Vegan ~2.3, Veggie ~2.6, from Rosi et al. 2017
  (seven-day diets for ~150 people in Italy). A Meat day uses the same ~2.6
  kg baseline for the rest of that day's food (it isn't any more
  carbon-efficient just because the main is meat), plus the chosen meat
  type's average footprint per kg (beef ~36 kg CO2e/kg and lamb ~25 much
  higher than chicken ~6 or fish ~5) times the chosen portion size. So a
  meat day is always at least as high as a veggie day, e.g. a medium
  chicken portion comes to ~3.5 kg, a medium beef portion to ~8.0 kg.
- **Food waste** (Account page setting): scales every food figure by
  1/(1-waste%), using each bracket's midpoint — 0–3% → ×1.02, 3–10% → ×1.07,
  10–30% → ×1.25, 30%+ → ×1.67 (assuming 40%). Wasted food still carries the
  emissions it took to produce, so higher waste means you effectively have
  to account for more food produced than you actually eat.
- **Eating out** (This Week page, per day): a ~1.5&times; multiplier applied
  to just the dinner slice of that day's food figure — the meat portion
  itself on a meat day, or half the flat day figure on a veggie/vegan day
  (there's no meal-level split to draw on there) — before food waste is
  applied on top.
- **Alcohol** (This Week page, per week, not per day): ~0.5 kg CO2e per
  beer/can, ~0.3 kg CO2e per glass of wine (~175ml), ~0.15 kg CO2e per 25ml
  shot of spirits at 40% ABV (scaled linearly for other strengths) — rough
  averages covering production, packaging, and transport. Counted from the
  very start of the week in the budget-pace chart, since it isn't logged
  against a specific day.
- **Flying** (Stats page, per return trip): ~250 kg CO2e short-haul within
  Europe, ~1,600 kg CO2e long-haul international.
- **Home energy** (Stats page): household kWh/month × 12 × ~0.2 kg CO2e/kWh
  (rough grid average), divided evenly across everyone in the household.
- **Buying goods** (Stats page): ~10 kg CO2e per clothing item bought, a
  rough blended average across garment types.
- **Gas/oil heating** (Stats page, optional): household kWh/year × ~0.18 kg
  CO2e/kWh (rough blended gas/oil factor), split evenly across the
  household the same way electricity is.
- **Non-commute driving** (Stats page, optional): extra car km/week beyond
  your logged commute × 52, using the same ~0.171 kg CO2e/km car factor.
- **Car ownership** (Stats page, optional yes/no): if yes, a flat ~700 kg
  CO2e/yr for the car's own manufacturing footprint, amortized over an
  average ~14-year car lifetime — separate from the fuel/charging for
  trips logged elsewhere.
- **UK average reference** (Stats page): computed bottom-up the same way as
  your own total, from representative average UK inputs run through the
  same formulas — a 10 km one-way commute by car, a representative average
  week's food (5 meat days weighted toward poultry + 2 veggie days, 3–10%
  waste), 1 short-haul + 0.2 long-haul flights/yr, ~2,900 kWh/yr household
  electricity split across ~2.4 people, and 3 clothing items/month — rather
  than a generic "average footprint" statistic, which would cover a lot
  this app doesn't track (see the Stats page's "What this doesn't account
  for" card). This core figure comes to roughly 2,860 kg CO2e/yr, well
  below often-cited "average person" figures (8–10 tonnes) because those
  are scoped much more broadly. If you've answered any of the optional
  extras above (gas heating, non-commute driving, car ownership, pets,
  water usage, banking), the matching representative UK figure for each
  one is added to *both* sides of the comparison, so it's never your
  fuller total measured against a narrower UK figure.
- **UK percentile** (Stats page): models the population as log-normally
  distributed around the UK average above (median = average, an assumed
  spread) to estimate a percentile — illustrative, not based on real
  ONS/population distribution data.
- **Car-miles / trees comparisons** (Stats page): the car-miles comparison
  reuses the same car factor as commuting (~0.171 kg CO2e/km, converted to
  miles); the trees comparison uses ~22 kg CO2e absorbed per mature tree
  per year.
- **UK average week** (This Week page, and the "Match UK average week" goal
  preset): the same commute + food UK-average assumptions as above, without
  the ×52, since this is what a single average week (not year) comes to —
  roughly 32.5 kg CO2e.
- **1.5°C by 2030 target — comprehensive** (Stats page, "How your year
  compares"): 2,500 kg CO2e/yr per capita, the Hot or Cool Institute's
  "1.5-Degree Lifestyles" research target (dropping further for 2040/2050)
  as roughly a fair-share pathway for keeping warming under 1.5°C. This
  covers a *whole* lifestyle (mobility, energy, food, shopping, leisure) —
  not just what this app tracks — so it's compared against the Stats
  page's fuller yearly total (5–8 categories), not the This Week page's
  narrower commute+food-only weekly figure, which would make this target
  look artificially easy to beat for no reason other than mismatched
  scope. (This previously cited the MyEmission app's 6.3 kg CO2e/day
  figure instead — switched to Hot or Cool's own headline number so this
  and the food+commute preset below cite one consistent source.)
- **1.5°C by 2030 target — food + commute only** (Account page goal
  preset): ~16.4 kg CO2e/week. There's no officially published
  category-level split of the comprehensive target above, so this is our
  own estimate: applying published 2030 reduction requirements for
  developed countries (nutrition −47%, mobility −72%, per Hot or Cool
  Institute's "1.5-Degree Lifestyles" research) to the UK-average food and
  commute figures already used elsewhere in this app.
- **World average week** (Account page goal preset): ~23.6 kg CO2e/week.
  The roughest figure in the app — there's no global equivalent of the
  UK's national travel/diet surveys, so this is a lightweight bottom-up
  estimate (a shorter car-equivalent commute and less meat than the UK
  figures) rather than being built from real survey data the way the UK
  figures are.
- **Pets** (Stats page, optional): ~770 kg CO2e/yr per dog, ~310 kg CO2e/yr
  per cat, mostly driven by their (often meat-heavy) diet. The UK-average
  comparison assumes ~0.2 dogs and ~0.15 cats per person, a rough estimate
  from UK pet-population figures.
- **Water usage** (Stats page, optional): household m&sup3;/yr (from a
  water bill) &times; ~0.32 kg CO2e/m&sup3;, a rough DEFRA-style combined
  supply + treatment factor, split evenly across the household the same
  way electricity and gas are. The UK-average comparison assumes ~122
  m&sup3;/yr per household (~140 L/person/day).
- **Banking** (Stats page, optional): balance held with your bank
  (current + savings) × that bank's kg CO2e financed per £/yr, from
  MotherTree's bank carbon emissions league table
  ([mymothertree.com/bank-league-table](https://www.mymothertree.com/bank-league-table)),
  which ranks UK banks by tonnes of CO2 financed per £10,000 of customer
  deposits (reflecting how much of that money goes into fossil-fuel
  financing) — Barclays and HSBC sit at the high end (~0.22–0.24 kg
  CO2e/£/yr), most high-street banks in the middle, and Triodos/The
  Co-operative Bank/Nationwide at the low end (~0.03–0.04 kg CO2e/£/yr).
  Both the bank and a balance need answering for this to count. The
  UK-average comparison uses a representative "big five" high-street
  factor (Barclays, HSBC, Lloyds, NatWest, Santander) and a rough
  illustrative £5,000 balance — the softest of all the assumptions here,
  since there's no clean single source for "the average person's bank
  balance".

These are based on commonly cited average emission factors (in the style of
DEFRA conversion factors and Our World in Data / Poore & Nemecek food
footprint figures) and are meant to give a rough sense of relative impact,
not an exact measurement.
