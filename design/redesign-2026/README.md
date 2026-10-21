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
  with an optional UK average comparison, biggest opportunity and the
  supporters card.
- `Glass2-Category.dc.html`: one page per category (tabs), with a share-of-
  footprint pie, UK average, three ranked to-dos with "Add to plan", and
  what the category could drop to.
- `Glass2-Survey.dc.html`: all six survey steps on one page with step tabs
  and numbered question cards.
- `App-Icon.dc.html`: the "Leaf Ledger" app icon, sizes, variants and splash.

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
