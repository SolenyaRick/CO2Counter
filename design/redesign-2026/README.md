# CO2 Counter redesign (2026)

Design mock-ups for a refreshed CO2 Counter, made on a Claude Design canvas:
https://claude.ai/artifact/EcYAWWKwGK1Qpj3K3YM8wR

Each `*.dc.html` file is one artboard in the Design Component format (it runs
inside the canvas editor, not as a standalone page). `canvas.json` is the
canvas layout.

## Chosen direction: Glass v2

- `Glass2-Intro.dc.html`: intro / landing page. Mission as a five-step flow
  (survey, analyse, find where to improve, learn the best ways, build habits),
  what we look at, why it matters, trust and privacy, FAQ and "Start the survey".
- `Glass2-Results.dc.html`: results overview. Count-up total, "path down"
  bar (now / realistic / all the way), donut that converts into a bar chart
  with an optional UK average comparison (horizontal bars on phones),
  biggest opportunity and the supporters card.
- `Glass2-Category.dc.html`: one page per category (tabs), with a share-of-
  footprint pie, UK average, three ranked to-dos with "Add to plan", and
  what the category could drop to.
- `Glass2-Survey.dc.html`: all six survey steps on one page with step tabs
  and numbered question cards.
- `Glass2-Guide.dc.html`: step-by-step guide for each category's top to-do
  (e.g. Flights: take the train), with a side-by-side comparison chart, what the
  saving looks like (trees, phones, driving, share of the 1.5°C budget) and steps.
- `Glass2-Sections.dc.html`: the pop-ups behind category sections, restyled:
  Fly less and shorter (flight tiers), take the train, fly economy (cabin
  comparison), drive less (commute options), bank league table, switching
  account, and savings and pensions (pension ranking).
- `Glass2-SurveyDone.dc.html`: survey page once completed (quick update, start
  from scratch, view results), last answers per step and survey history.
- `Glass2-Friends.dc.html`: leaderboard with podium, rank nudge, most improved,
  add a friend, requests and your name.
- `Glass2-Account.dc.html`: profile, saved data, plan and support, clearing data
  and account deletion.
- `Glass2-Switches.dc.html`: greener switches. A switchboard of five toggles
  that animates your footprint down, an impact-against-effort bubble plot,
  then one numbered feature per switch (before/after panel, partner offer
  cards with a clear call to action).
- `Glass2-About.dc.html`: about us. Statement headline and promises, three
  beliefs, an animated diagram of your answers and official factors flowing as dots through the
  calculator into an estimated footprint, who runs it, partner principles and an
  affiliate disclosure showing the exact tag.
- `Glass2-Habits.dc.html`: My Habits. Real Zero's 7 Acts as a 7-segment
  progress ring and a numbered path in three groups (switch the big things,
  keep measuring, use your voice), with the bill-payer, MP finder and invite
  boxes inline, then a "coming soon" preview of daily habits with streaks.
- `App-Icon.dc.html`: the "Leaf Ledger" app icon, sizes, variants and splash.

Every Glass v2 page includes a phone layout (under 640 px wide: the nav links
move to their own swipeable row, type and padding shrink, and multi-column
grids collapse). `Phone-*.dc.html` are the same pages shown at 390 px on the
canvas, linked to each other.

Palette: oat `#EFE9DC`, moss `#3F5B3A`, sage `#8FA58A`, honey `#D9A441`,
clay `#B8653D`. Type: Bricolage Grotesque (headings and numbers), Karla (body).
Habits are shown as "coming soon".

## Numbers

Figures come from the example results in the current app. UK averages per
category were worked out with the app's own `footprint()` on
`UK_TYPICAL_SURVEY` (`data.js`): meals 1,821, home energy 1,080, flights 429,
commute 280, pets 231, water 18 kg CO2e a year (3.9 t in total). Banking and
pensions have no UK figure and are left out of the comparison, as in the app.

## Other explorations

Earlier directions kept for reference: Living Atmosphere (`Main`, `Meals`,
`Commute`, `Icons`, `Laptop-Atmosphere`), Warming Stripes (`Stripes-*`), Puff
(`Puff-*`), Canopy with Mol (`Canopy-*`), Night Grove with Wisp (`Grove-*`),
Topographic (`Topo-*`), Glass Bento (`Bento-*`, `Laptop-Glass`) and Earthy
Glass (`Earth-*`).
