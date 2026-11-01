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
- `Glass2-Results.dc.html`: results overview. A dark hero with the
  count-up total, "above UK average" and "× 1.5°C budget" chips and the
  animated now / realistic / all the way bar; then the donut that turns
  into bars (with UK average) beside the biggest opportunity, three animated
  comparisons (trees, km driven, × budget) and a "since your first survey"
  trend line; then a slim supporters strip. Horizontal bars on phones.
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
- `Glass2-Friends.dc.html`: friends as a social feed. A story strip of
  friends (ring and badge show their trend), friend requests inline, then
  Standings (Lowest footprint / Most improved tabs), then the Feed: a
  monthly standings post with each person's movement, retakes with
  before/after bars, milestones, new friends and a personal "next move",
  each with a Cheer button. The side column holds your profile, invite code
  (Act 7) and add or manage friends. Posts only use yearly totals.
- `Glass2-Account.dc.html`: account in the Friends style. A profile card
  (footprint, rank among friends, 7 Acts) with sign out and shortcuts, then
  profile details, plan and support, and clearing data or deleting the
  account.
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

Shared style rules (applied to every Glass v2 page): three corner radii
(12px small, 18px medium, 28px large, plus pills), one 1,160px page width,
moss `#3F5B3A` with deep green `#2B3F28`, 20px glass blur, 1.9px icon
strokes (2.2px for small arrows), headlines at 64px on public pages and
48px on app pages, spaced capitals only on small labels, honey for actions
and sky `#7FA3AE` for "waiting". On phones a bottom tab bar (Survey,
Results, Friends, Habits, Account) replaces the top links.

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

Next steps and scroll guidance (every page): an "Up next" card
for the single biggest move (Results also lists your 3 biggest moves), a
sticky next-step bar that appears once you scroll past the top, the section
under the reading line stays bright while others fade back, a side rail of
sections on laptop and tablet, and on load the page scrolls to its key area
on phones and tablets (laptops only when it starts below the fold).
