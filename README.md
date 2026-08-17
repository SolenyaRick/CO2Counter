# CO2 Tracker

A web app for tracking your weekly carbon footprint from commuting and food,
with accounts and a friends leaderboard backed by Supabase.

## Pages

- **Login** — email/password sign-in and sign-up (with a "forgot password"
  flow), gating the rest of the app.
- **Home** — the landing page. For a brand-new account (every To Do item
  below still outstanding - see the "To do" card further down) it opens
  with a dismissible welcome banner pointing at the two places to start:
  This Week for day-by-day logging, This Year for the one-off yearly
  questions. Dismissing it is remembered per-device via `localStorage`
  (`co2tracker_onboarding_dismissed`), independent of account sync - it's
  not meaningful data worth a network round trip - and it stops showing
  itself automatically the moment anything at all has been logged, even
  without an explicit dismissal. Then a "Total CO2 saved" hero card: a
  two-slide swipeable carousel (native CSS scroll-snap, Instagram-post
  style, with two small dots underneath showing which slide you're on -
  swipe/scroll horizontally on either mobile or desktop to move between
  them). Both slides are the same lifetime figure - your real confirmed
  commute + food + alcohol emissions since the week you first confirmed a
  day, subtracted from a weekly reference rate scaled by days elapsed (the
  same flat linear-rate convention the budget pace chart's own dashed
  target line uses below) - just against two different reference points:
  the first slide is the UK average (`UK_AVERAGE_WEEKLY_KG`, always
  available); the second is your own baseline week if you've set one on
  the Account page (the same "your own week instead of the UK average"
  choice already offered on This Week's "Compared to" card), or a prompt
  to set one if you haven't. Each slide is green with a positive number if
  you're under its reference, red/"more than X" if you're over it, and a
  muted placeholder prompting you to confirm a day if you haven't tracked
  anything yet. Explicitly illustrative: days you haven't logged count as
  zero on your side of the comparison, so the more consistently you log,
  the more accurate it gets — same known approximation the pace chart
  below already makes. Next is a "Budget pace" card: a
  three-way toggle ("This week" / "This month" / "This year") over a
  single Monzo Trends-style budget-pace chart — a dashed target line burns
  from your weekly goal down to 0 across whichever span is selected
  (×1 for a week, roughly ×4.3 for a month, ×52 for a year, so the implied
  daily rate is the same across all three), plotted against a solid line
  tracking your actual confirmed commute + food + alcohol day by day
  (alcohol spread evenly across each week's 7 days, since it's a
  whole-week figure, not tied to a specific day). Falling below the dashed
  line means you're using CO2e faster than the goal allows for how far
  through the span it is; staying above it means you're on pace or ahead.
  For "This week", the actual line only draws up to today - it doesn't
  project the rest of the week for you. For "This month" and "This year",
  it additionally only starts drawing from a light vertical marker - the
  week you first confirmed a day - and picks up exactly on the dashed
  target line there rather than at the full goal: the days before that
  marker have no data, so they're assumed to have used exactly their fair
  share of the goal at the target rate (neither over nor under), rather
  than being credited as zero-emission days, which would make the actual
  line jump out ahead of pace for no real reason. Flights, home energy,
  and the other yearly-estimate categories below aren't part of any of
  these lines, since they're fixed annual figures with no day-by-day data
  to plot a pace against. Below that, an "emissions by domain" card breaks
  the selected timeframe into a stacked bar with up to twelve segments - one
  per domain, sized by share of the total, with a legend giving each
  domain's exact kg and percentage plus a total row. It follows whichever
  of the three timeframe buttons above the pace chart is currently selected
  rather than having its own toggle. Commute, food, alcohol, and
  non-commute driving (the Car-mode slice of logged "Additional journeys",
  pulled out of Commute into its own segment) are real tracked totals, same
  scope as the pace chart above it; the rest (flights, home energy,
  gas/oil heating, water, pets, banking, buying goods, car manufacturing)
  have no day-by-day data, so each is its own weekly-equivalent share
  (yearly ÷ 52) scaled to match the
  timeframe - month uses the same ×(days in month/7) the pace chart's own
  goal line uses, year uses a flat ×52 (not ×365/7, which would inflate
  every one of these by about 0.3% versus the exact figures on the "Your
  year, estimated" tiles) - the same weekly-equivalent approach the
  all-time weekly average on the Leaderboard already uses. A domain that's
  zero or unanswered (e.g. gas heating, if that question's been skipped)
  just doesn't get a segment. Segments are separated by a thin gap (not
  just a color change) and every legend row is prefixed with that
  category's emoji, so a domain is always identifiable by more than its
  swatch color alone - with up to twelve categories on screen at once and
  "Rank by size" free to put any two next to each other, no fixed hue
  order can guarantee every pair reads as different colors for every
  viewer (see the palette comment above `--commute-color` etc. in
  `style.css` for how the 12-color set was chosen and validated). Two
  small buttons sit under the legend. "Show
  full breakdown ▾" doesn't reveal a separate chart underneath; instead,
  the legend's own small colored squares each animate (a plain CSS width
  transition, no library) into a full-length bar sized to that domain's own
  percentage share (same number as the legend/segment above), with the
  label and kg/percentage trailing right after it, wrapping onto its own
  line if the bar's grown wide enough to need it. The same square is the
  "before" and "after" of the animation - nothing new appears, it just
  elongates in place - so it reads as one continuous shape rather than two
  disconnected chart elements swapped by a toggle. Next to it, "Rank by
  size" re-sorts those same rows biggest-first (an instant re-render, not
  an animated reorder) instead of the default DOMAIN_ORDER; toggling it off
  puts them back. Both buttons remember their own on/off state
  independently across re-renders (period switch, new data) until clicked
  again. Next, a
  "To do" card lists up to six quick
  nudges - yesterday's and today's commute and meal, electricity per year,
  and flights per year - each dropping off the list the moment there's
  something logged for it (yesterday/today check that specific day's
  commute/diet confirm status, wherever that day's data actually lives -
  this week's or last week's; electricity is done once a bill's been
  submitted AND it's still fresh, dropping back to "not done" once its end
  date is over ~13 months old, so this one nudge doubles as the "submit an
  updated bill" reminder too; flights is done once at least one has ever
  been logged, regardless of whether older entries have since aged out of
  the current yearly total), so the list only ever shows
  what's actually still outstanding rather than a permanent checklist of
  everything. Once every item's dropped off, the list itself is replaced
  by a single "All done" message. Tapping an item jumps to wherever you'd
  log it (This Week for the day-based ones, This Year for the other two).
  Then "Your year, estimated" opens with a hero box -
  your estimated yearly total in large accent-colored type, next to a
  rough percentile ("lower than ~X%" / "higher than ~X% of people in the
  UK", worded so it never reads backwards). A "Compared to:" Instagram-style
  swipeable carousel sits right underneath - one slide per benchmark (1.5°C
  target, UK average, World average, Uni average), each a big ▲/▼ delta
  against that benchmark (same red/green convention as everywhere else on
  this page) with 4 dots below showing which one you're on - swipe or
  scroll horizontally to move between them, same native scroll-snap
  mechanism as the "Total CO2 saved" carousel above. The first three
  benchmarks are instant; the Uni slide needs your university set on the
  Account page and a network round trip (`university_weekly_average()`,
  see `supabase/README.md`) - it reads "Set your university on Account to
  compare" until you've picked one (tapping/pressing Enter on that slide
  jumps straight to Account), "Not enough people from X yet" until at
  least 3 people from that university have a fully confirmed week (so the
  comparison is never just reflecting one or two other people's data back
  at you), and only then shows a real number. Next, two comparison tiles
  convert that total into km driven by an average car and
  mature-trees-of-CO2-absorption equivalents, each with a delta against
  the UK average. A divider then splits the 12 category tiles into another
  swipeable carousel, one slide per group with its own 3-dot indicator:
  "This week" (food, commute, non-commute driving, alcohol - the four
  domains with real day-by-day tracked data, matching the bar chart's own
  tracked/estimated split above), then "Home" (home energy, gas/oil
  heating, water usage, pets), then "Other" (flying, banking, buying
  goods, car manufacturing). Unlike the This Year input page, these tile
  labels don't say "(optional)". Every tile except Alcohol (which isn't
  modeled in the UK average figure to begin with, so there's nothing to
  ring against) is an Apple-Watch-style ring (`renderRingStat()` in
  `app.js`): starts as a full green ring representing 100% of your UK-average
  "budget" for that category still unused, and drains anticlockwise from 12
  o'clock as your own total eats into it - an empty green ring means you've
  used exactly the UK average, "no budget left". Go over it and the ring
  switches to red, filling back up the same anticlockwise way from empty,
  capped at a full red ring for double the UK average or worse. The ring's
  centre shows just the figure itself (kg/yr); the percentage of the UK
  average that is sits underneath the category caption below the ring
  instead, colored the same green/red as the ring itself - the same two
  numbers the old delta/caption pairing showed, just laid out as a ring
  plus a caption line instead of text. Each tile's category emoji sits as
  its own small badge in the top-left corner (static HTML, not part of the
  ring or caption text any more) rather than prefixing the caption label -
  and the "(×52 weeks)" that used to follow Food/Commute/Non-commute
  driving's labels (and Alcohol's) is gone too, since every tile on this
  card is a ×52 yearly projection, so spelling it out on some tiles and not
  others just added noise. Optional categories you haven't answered yet
  fall back to the same muted "–" tile (value, label, "vs UK average"
  caption) used everywhere else in the app, rather than showing a
  misleadingly "full" ring for an unanswered question. Before the first
  render completes (the brief window between sign-in and profile/weeks
  finishing their load - see `onSignedIn()` in `app.js`), each ring tile
  is a literally-empty `<div>`; a CSS `:empty` rule gives it a
  reserved-height shimmer placeholder instead, so the tile never flashes
  its emoji/info-button badges floating over collapsed blank space, and it
  stops applying itself automatically the instant real markup (populated
  or muted "no data" alike) is set. Four tiles - Food,
  Home energy, Flying, and Banking
  - additionally have a small ⓘ button in the top-right corner (the emoji
  badge and info button share the tile's two top corners without
  overlapping), opening a popup with
  a short bit of context/advice for that category; the popup content lives
  in `tile-info.js` (`TILE_INFO`), a plain, directly-editable file (same
  idea as `emission-factors.js`) - starts out with placeholder text, meant
  to be filled in by hand. A final, deliberately compact "What this doesn't
  account for" card condenses the app's disclaimed categories into four
  bullet points,
  including a rough figure for the one people ask about most - your share
  of public infrastructure and government spending runs to roughly 3.3
  tonnes CO2e/yr per person in the UK, real but not something an app like
  this can help you reduce.
- **This Week** — starts with a "Compared to an average week" card: a UK
  average week (commute + food only, the same bottom-up figures as the
  Home page) shown alongside a savings-framed comparison against your
  week so far — "X kg CO2e saved vs an average week" (green) or "X kg
  over" (red), prorated to how far through the week it is the same way the
  Weeks-grid goal is. The point is you don't need to log every category for
  this to be meaningful, unlike apps that require comprehensive manual
  tracking before they'll show you anything. You can swap the UK average
  out for one of your own fully-confirmed weeks instead (Account page,
  "Baseline week") — the card then reads "Compared to your baseline week"
  and compares full totals (commute + food + alcohol) rather than the UK
  average's commute+food-only figure, since a real week of yours has
  actual alcohol data on both sides where the UK average doesn't. Below
  that, the inputs,
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
  "Last week"). Nested inside that same commute card, right below the day
  table, a collapsed-by-default "Additional journeys (optional)" section (a
  native `<details>` — no JS needed for the expand/collapse itself, just a
  small text heading rather than its own card) lets you log one-off trips
  beyond the regular commute above: a distance in km (the journey's own real
  distance, not doubled the way the daily commute is, since a one-off trip
  isn't necessarily a round trip), a Cycle/Tube/Train/Car mode toggle, and
  which day. Each addition shows up in a list immediately (no confirm step
  needed, same pattern as alcohol below), and counts toward commute in
  every total this page shows (Total this week, goal colors, leaderboard) —
  though on the Home page, Car-mode entries specifically get pulled out
  into their own "Non-commute driving" domain instead of staying folded
  into Commute, so the two pages' commute figures aren't always identical;
  see "Non-commute driving" further down. If you picked anything other than Car, it also pops up a small
  "Nice one! 🎉" congratulations modal showing how much CO2e that choice
  saved versus driving the same distance would have. Tube is a new transport
  mode this added everywhere (not just here) — a rough DEFRA-style London
  Underground factor, lower than National Rail's train figure. After the
  diet table, an "Alcohol this week" card is a whole-week (not per-day)
  figure: tap-to-fill rows of beer/wine icons set a weekly count (tap the
  current count again to clear it), plus an ABV% and shots count for other
  spirits — counts immediately, with no confirm step needed, since every
  value including 0 is already a real answer. Also shows a
  "This week, in context" card that converts your confirmed total into an
  equivalent car-km distance (DEFRA-style car factor) and how much CO2e
  you'd have saved if every confirmed meat day had been veggie instead,
  broken down by meat type (e.g. beef vs chicken). A "Weekly summary" card
  below that shows your Commute/Food/Alcohol/Total-so-far tiles and a
  "Reset this week" button - the budget-pace chart itself now lives on the
  Home page (its "This week" view), alongside month and year versions of
  the same chart. At the bottom of the page, a "Your weeks" grid shows one box per week
  (Mon–Sun), most recent first. Each box shows that week's total CO2e,
  color-coded against your goal from the Account page, with an over/under-goal
  indicator. For the current, still-in-progress week, the goal itself is
  prorated to how much of the week has elapsed (e.g. Wednesday = 3/7 of the
  weekly goal) so "under goal" is meaningful before the week is actually
  over, rather than trivially true on day one. A week that has every day
  confirmed for both commute and food gets a "✓ FULL" badge — this is a
  stricter bar than just having *some* data (which is all that's needed for
  the box to show a total at all), and is what counts toward the "confirmed
  week" averages on the Home and Leaderboard pages, so a week where
  you only logged Monday doesn't drag those averages down as if it were a
  whole week's worth of data. Tap a box for a day-by-day breakdown.
- **This Year** — the yearly-estimate inputs, grouped into five cards in a
  roughly biggest-to-smallest-impact order: **Driving** (whether you own or
  regularly drive a car; and what type — Diesel, Hybrid, or Electric/EV,
  which swaps in a DEFRA-style factor — ~0.171 kg CO2e/km diesel, ~0.111
  hybrid, ~0.058 electric using average UK grid intensity to charge it —
  used for *both* every "Car" day you log on the This Week page and any
  Car-mode additional journeys, in place of the ~0.171 kg CO2e/km
  blended-average fallback used if you leave it as "Prefer not to say" —
  the old "extra non-commute driving km/week" question that used to live
  here is gone; see "Non-commute driving" above for where that figure comes
  from now), **Flying** (an itemized log, same "Additional journeys" style
  as the This Week page's commute card: a date (optional), which continent
  you flew to, and cabin class, then "Add flight" — each entry shows up in
  a list immediately, counted in the total unless its date is over a year
  old, in which case it stays in the list but shows muted with an "(over a
  year ago – not counted)" note rather than disappearing, and remove with
  the × button. Replaces the old flat "short-haul/long-haul flights per
  year" counts — no built-in distance calculator, continent picks one of
  six rough averages instead), **Household energy** (people in your
  household; a bill-based electricity form — bill start date, end date,
  and total kWh used, from which the app derives a kWh/month figure itself
  rather than you calculating it by hand; a "Save bill" button; a summary
  line showing the derived monthly figure and the date range it came from;
  and, once that bill's end date is more than ~13 months old, a red nudge
  to submit an updated one — replaces the old flat "kWh per month" number
  input. Also total gas/oil heating + hot water kWh/yr and total household
  water usage in m&sup3;/yr, both still optional plain numbers), **Pets**
  (number of dogs and cats, optional — their ~770/~310 kg CO2e/yr-each
  footprint is split evenly across everyone in your household, the "People
  in your household" figure above, rather than attributed entirely to you,
  since a household's pets aren't really just one person's footprint),
  **Banking** (which bank you mainly hold money with, plus a balance,
  optional), and **Buying goods** (clothing items bought per month).
  Household energy, pets/water, and banking are all split or weighted by
  household size the same way, for consistency. The optional extras
  (gas/oil heating, water, pets, banking, car ownership) are skippable:
  leaving one blank leaves it out of every total on the Home page rather
  than counting it as zero, so an unanswered question never makes your
  estimate look artificially low. Flying and household energy aren't part
  of that skippable group any more — an empty flight log or a
  never-submitted bill both just read as zero, the same way commute/food
  do, since they're tracked logs rather than one-off optional questions.
- **Leaderboard** — three cards: "This week" ranks you and your accepted
  friends by this week's *average* kg CO2e per confirmed day so far (lowest
  first), not raw total, with a callout for whoever's winning — this one
  still includes in-progress weeks, same as the This Week page's weeks
  grid, and ranking by average rather than total means being behind on
  logging days doesn't make someone look artificially better than a friend
  who's kept every day up to date; each person's raw total and
  "confirmed/elapsed days" (e.g. "3/5" on a Friday if only Mon–Wed are
  done) show in small text next to their average; "All-time weekly
  average" ranks everyone by their average CO2e per *fully* confirmed week
  (every day, both commute and food — see the weeks grid above) since they
  started, which also folds in a weekly-equivalent share of each person's
  yearly Home page figures (flights, home electricity, buying goods, and
  any optional extras they've answered — everything the yearly total on
  the Home page includes besides commute/food/alcohol, divided by 52), so
  this figure and "Home page yearly total ÷ 52" always agree; "Everyone on
  the app" shows a total account count (every signup ever, active or not —
  `total_signups()` in `supabase/schema.sql`, a plain `count(*) from
  auth.users`) alongside two anonymous, aggregate figures scoped to
  accounts with at least one fully confirmed week — commute + food +
  alcohol, and the fuller total (that plus the same yearly-extras
  composition as above) — and how many people each is based on, with no
  per-user data or names ever exposed. The full-total figure is computed
  entirely in SQL (see
  `app_wide_weekly_average()` in `supabase/schema.sql`), since unlike the
  friends version it can't read individual accounts' profile data
  client-side — so its emission-factor constants are a second copy of the
  ones in `app.js` and need to be kept in sync by hand if either changes.
- **Account** — display name, university (optional — "Not affiliated" or
  one of a fixed list; powers the Home page's "Uni average" comparison
  chip once enough people from the same university have signed up), one-way
  commute distance, weekly CO2e goal
  (with three quick-set presets alongside typing your own number: "Match UK
  average week", "1.5°C 2030 (food + commute)" — our own estimate, since
  there's no official category-level split of the 1.5°C target — and "Match
  world average week", the roughest of the three since there's no global
  equivalent of the UK's national travel/diet surveys to build it from), a
  food-waste setting (0–3% / 3–10% / 10–30% / 30%+, scales up food figures
  everywhere to account for produced-but-wasted food), a "Baseline week"
  picker (a dropdown of your own fully-confirmed weeks — only ones with a
  "✓ FULL" badge on the weeks grid qualify — to compare the This Week
  page's card against instead of the UK average; "UK average (default)"
  switches back), a "Help improve UK averages" opt-in (off by default — if turned on, everything on the
  Account/Home pages except your banking answers becomes visible to the
  app developer for calibrating the UK-average assumptions against real
  data; your name/email/account are never included, see
  `supabase/README.md` for exactly how this is scoped — signed in as the
  app owner, this card also shows buttons to download every opted-in
  user's data as either .json or .xlsx (the latter includes each week's
  actual kg CO2e breakdown by commute/food/alcohol, not just the raw
  day-by-day choices, an Average/Std Dev row under every numeric column
  on both sheets, and two extra sheets collating every confirmed day
  across every opted-in week into an "avg N per week" + kg CO2e
  breakdown by meal type and by commute mode), gated server-side on the
  signed-in account's email rather than anything checkable client-side),
  a friends list (add by email, accept/decline requests), sign-out,
  export/import/reset for your data, and a separate "Delete account"
  button that permanently deletes the account itself (login included),
  not just its data — required for App Store review, since Apple mandates
  in-app account deletion for any app that supports account creation.

## Architecture

Static HTML/CSS/JS frontend (no build step) talking directly to
[Supabase](https://supabase.com) (Postgres + Auth) from the browser via the
vendored `@supabase/supabase-js` client in `vendor/supabase.js`. See
`supabase/README.md` for how the backend is set up and `supabase/schema.sql`
for the full schema — profiles, weeks, and friendships tables with
row-level security, so friends only ever see each other's weekly totals on
the leaderboard, never day-by-day commute/diet detail.

All the physical "kg CO2e per unit" numbers the app calculates with live in
`emission-factors.js`, loaded via a `<script>` tag before `app.js` (plain
top-level `const` declarations, sharing `app.js`'s global scope since
neither file is an ES module) — see "Emission factor assumptions" below.
Everything else (UI labels/icons, Supabase config, page logic) stays in
`app.js`. `tile-info.js`, loaded the same way, holds the editable copy for
the Home page's four tile info popups (see "Pages" above).

`style.css` defines a small spacing scale (`--space-1` through `--space-6`,
4px to 24px) at the top of `:root` - card/tile/list padding, margins, and
flex/grid gaps reference these tokens rather than one-off pixel values, so
the app has one consistent rhythm instead of a different number per
feature. The three "pick one of N" toggle-button patterns
(`.week-picker-btn`, a rigid single-row segmented control;
`.chip-toggle-btn`, the same idea wrapping onto multiple lines for wider
option sets like the 6 flight continents; and `.domain-toolbar-btn`, a
`.btn-secondary` with a "selected" state) share one base look and active
state rather than each declaring its own, for the same reason.

The Account page's owner-only "Download as Excel" button also lazy-loads a
vendored copy of [SheetJS](https://sheetjs.com) (`vendor/xlsx.js`, the
~250KB "mini" browser build — no legacy XLS/XLSB support, which this app
never needs since it only ever writes plain .xlsx files) via a dynamically
injected `<script>` tag the first time that button is clicked. It's not
loaded on every page view, since only one account can ever see the button
that needs it.

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

## iOS app (Capacitor)

The `ios/` folder is a [Capacitor](https://capacitorjs.com) wrapper around
this exact web app — same `index.html`/`app.js`/`emission-factors.js`/
`tile-info.js`/`style.css`/`vendor`/`icons`, unchanged, running inside a
native WKWebView shell, producing a real app you
can install on a device or submit to the App Store. No rewrite: fetch calls
to Supabase work the same way from inside the native app as they do in a
browser.

**This part needs a Mac with Xcode installed** (and, for real-device
installs or App Store submission, a free or paid Apple ID — the $99/yr
Apple Developer Program is only required for App Store distribution, not
for running on your own device via Xcode). None of the steps below can be
done from this environment.

On your Mac:

1. Clone the repo and run `npm install` (installs the Capacitor CLI/core/iOS
   packages - see `package.json`).
2. Run `npm run sync:ios`. This copies the real web files into `www/` (a
   build artifact, regenerated from scratch each run - see
   `scripts/sync-web.sh` - never edit `www/` directly, edit the real files
   at the repo root) and then into `ios/App/App/public`, which is what
   Xcode actually builds from.
3. Run `npm run open:ios`, or just open `ios/App/App.xcodeproj` directly in
   Xcode. (Capacitor 8's iOS platform uses Swift Package Manager, not
   CocoaPods - no `.xcworkspace` or `pod install` needed. Xcode will
   resolve the Capacitor Swift package automatically the first time it
   opens, which needs an internet connection.)
4. In Xcode, select the `App` target → **Signing & Capabilities** → pick
   your team under **Team** (add your Apple ID first via **Xcode → Settings
   → Accounts** if you haven't). Xcode will auto-generate a free
   development signing certificate.
5. Pick a simulator or a connected iPhone as the run destination and hit
   **Run** (▶). That's a working native build.
6. For the App Store: first create the app's record in [App Store
   Connect](https://appstoreconnect.apple.com) using the same bundle ID as
   `capacitor.config.json`'s `appId` (currently `com.solenyarick.co2tracker`
   — a placeholder; change it in `capacitor.config.json` and re-run `npm run
   sync:ios` before registering anything if you want a different one, since
   a registered bundle ID is effectively permanent). Then in Xcode:
   **Product → Archive**, and once it finishes, **Distribute App** from the
   Organizer window that opens, following Apple's App Store submission flow
   (screenshots, description, privacy details, etc. are filled in on App
   Store Connect's website, not in Xcode).

**Whenever you change the web app** (`index.html`/`app.js`/`style.css`/
`vendor`/`icons`), re-run `npm run sync:ios` before rebuilding in Xcode —
Xcode builds from the copied snapshot in `ios/App/App/public`, not live
from the repo root, so a plain Xcode rebuild without re-syncing first will
still show the old version.

**Password-reset deep linking (Universal Links)**: production hosting is
now decided - **`co2counter.co.uk`** (a `CNAME` file at the repo root
declares this to GitHub Pages, `PRODUCTION_URL` in `app.js`'s Auth
section is set to it, and `registerDeepLinkHandling()`/`handleDeepLink()`
in the same file already handle picking up a password-reset link opened
via Universal Links - the WKWebView never navigates to the real
`https://` URL the way a browser tab would, so Supabase's normal
automatic session detection can't fire on its own; this extracts the
same token(s) from whatever URL the OS handed the app and establishes
the session itself, same end result as the web flow). What's left needs
your domain registrar, GitHub's website, and Xcode - none of which this
environment has access to:

1. **Buy `co2counter.co.uk`** at a registrar, if you haven't already.
2. **Point DNS at GitHub Pages**: since this is a subdomain-free root
   domain, use GitHub's recommended `ALIAS`/`ANAME` record if your
   registrar supports one, otherwise four **A** records to
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
   `185.199.111.153`.
3. In the repo's **Settings → Pages** on GitHub's website, confirm the
   custom domain shows as `co2counter.co.uk` (the `CNAME` file usually
   makes this automatic once DNS resolves) and enable **Enforce HTTPS**
   once that option becomes available.
4. Fill in `ios-universal-links/apple-app-site-association.template.json`
   - replace `TEAMID` with your Apple Developer Team ID (Xcode →
   Settings → Accounts, or developer.apple.com/account → Membership) -
   and host the resulting file at
   `https://co2counter.co.uk/.well-known/apple-app-site-association`
   (add it to this repo, since that's what's now serving the domain; no
   file extension, needs to be served as `application/json`, which
   GitHub Pages does automatically for a `.json`-free filename like
   this one as long as it doesn't misdetect the content type - verify
   this once it's live, e.g. `curl -I` and check the `Content-Type`
   header).
5. In Xcode: App target → Signing & Capabilities → **+ Capability** →
   **Associated Domains** → add `applinks:co2counter.co.uk`.
6. Add `https://co2counter.co.uk/` to Supabase's Authentication → URL
   Configuration → Site URL and Redirect URLs (see `supabase/README.md`).

Safe-area padding (`env(safe-area-inset-*)` in `style.css`'s `.app` rule)
and `apple-mobile-web-app-*` meta tags in `index.html` are already in place
so content clears the notch/Dynamic Island and home indicator, and so
"Add to Home Screen" from Safari (a separate, App-Store-free path to a
home-screen icon - see `manifest.json`) looks reasonable too.

## Emission factor assumptions

Every number below lives in `emission-factors.js` at the repo root — a plain,
directly-editable file (the same idea as `supabase/schema.sql` being the
single source of truth for the database schema). Edit the numbers there and
reload; nothing else needs to change.

You can also edit these numbers from `emission-factors-reference.xlsx`, a
companion spreadsheet listing the same figures with units and sources, if
that's easier than editing code directly:

1. Open `emission-factors-reference.xlsx` and change a value in the yellow
   **Value** column (only that column is unlocked). Don't edit the grey
   **JS Path** column — it tells the sync script exactly which line in
   `emission-factors.js` that row corresponds to. Rows with no JS Path
   (currently just the meat-day non-meat baseline) are informational only
   and mirror another row automatically - edit that other row instead.
2. Save the spreadsheet.
3. From the project folder, run:
   ```bash
   npm run sync:factors
   ```
   This reads the spreadsheet with the same vendored SheetJS build the app
   uses for its own Excel export (`vendor/xlsx.js` — no extra install
   needed), rewrites only the values that changed in `emission-factors.js`,
   and prints a before/after summary. It refuses to write anything if a row
   has a non-numeric value or a JS Path it can't find, so a bad edit can't
   silently corrupt the file.
4. Reload the app. If you're about to build the iOS app, run
   `npm run sync:ios` too.

The sync only runs one direction (spreadsheet → code) — editing
`emission-factors.js` directly does not update the spreadsheet, so if you
edit the code by hand, update the matching spreadsheet row yourself to keep
them in sync.

Figures are illustrative averages, not a precise personal carbon calculator:

- **Transport** (kg CO2e per passenger-km): Walk/Cycle 0, Train ~0.041, Tube
  ~0.028 (London Underground — lower than National Rail, electric traction
  and high passenger loads), Car ~0.171 (blended average). Applied to a
  round trip using your commute distance (This Week page's daily commute
  table), or the journey's own real, non-doubled distance for a one-off
  "Additional journeys" entry. If you've picked a car type on the This Year
  page's Driving card, "Car" days/journeys use that DEFRA-style factor
  instead of the ~0.171 blended average — ~0.171 diesel (near-identical to
  the blended average), ~0.111 hybrid, ~0.058 electric (using average UK
  grid intensity to charge it).
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
  averages covering production, packaging, and transport. Spread evenly
  (1/7th per day) across the budget-pace chart, since it isn't logged
  against a specific day — this used to be front-loaded entirely onto day
  0, before Monday had even happened, which made the pace line look
  missed from the very start of the week regardless of your actual
  Monday/Tuesday choices.
- **Flying** (This Year page, itemized log): a rough DEFRA-style
  return-trip figure per destination continent — Europe ~250 kg CO2e,
  North America ~1,600, Asia ~1,900, Africa ~1,500, South America ~2,100,
  Oceania ~3,400 — multiplied by a cabin-class factor (Economy ×1, Economy
  Plus ×1.5, Business ×2.5, First ×4). A flight logged with a date more
  than 365 days old stops counting toward the current yearly total (still
  shown in the list, just muted, so the log itself never needs pruning by
  hand); a flight logged with no date always counts, same as the flat
  per-year counts this replaced.
- **Home energy** (This Year page, bill-based): household kWh/month × 12 ×
  ~0.2 kg CO2e/kWh (rough grid average), divided evenly across everyone in
  the household. The kWh/month figure itself is derived from a submitted
  bill (start date, end date, total kWh used) rather than typed in
  directly — see "Household energy" further down for how.
- **Buying goods** (This Year page): ~10 kg CO2e per clothing item bought,
  a rough blended average across garment types.
- **Gas/oil heating** (This Year page, optional): household kWh/year ×
  ~0.18 kg CO2e/kWh (rough blended gas/oil factor), split evenly across the
  household the same way electricity is.
- **Non-commute driving** (Home page): no longer a This Year question — it's
  the Car-mode slice of whatever you've logged under This Week's
  "Additional journeys" (see below), averaged the same rolling-52-week way
  as food/commute/alcohol and ×52'd for the yearly figure. Logging a
  one-off trip as Car counts here; Cycle/Tube/Train trips stay folded into
  "Commute" instead. Always tracked (never a skippable "–" tile the way
  gas heating/pets/water/banking are), using the same car factor as your
  commute (either the ~0.171 kg CO2e/km blended average, or your chosen car
  type's DEFRA-style factor — see "Transport" above).
- **Car ownership** (This Year page, optional yes/no): if yes, a flat ~700 kg
  CO2e/yr for the car's own manufacturing footprint, amortized over an
  average ~14-year car lifetime — separate from the fuel/charging for
  trips logged elsewhere.
- **UK average reference** (Home page): computed bottom-up the same way as
  your own total, from representative average UK inputs run through the
  same formulas — a 10 km one-way commute by car over a standard 5-day
  working week (~0.89 tonnes CO2e/yr on its own — this used to be missing
  the 5-day multiplier entirely, landing at ~0.18 tonnes/yr versus the
  ~1 tonne/yr commonly cited for a UK car commuter, until that was fixed),
  a representative average week's food (5 meat days weighted toward
  poultry + 2 veggie days, 3–10% waste, ~1.51 tonnes CO2e/yr on its own —
  narrower than the ~2.2 tonnes/yr sometimes cited, since this only
  covers the meat/veg choice behind each meal, not dairy, eggs, snacks, or
  packaging/food-miles — see "What this doesn't account for" below), 1
  short-haul + 0.2 long-haul flights/yr, ~2,900 kWh/yr household
  electricity split across ~2.4 people, and 3 clothing items/month —
  rather than a generic "average footprint" statistic, which would cover
  a lot this app doesn't track. A representative ~50 km/week of
  non-commute driving is always folded in too (not gated behind an
  "answered" check, since it's a tracked figure now, not a skippable
  question). This core figure comes to roughly 3,570 kg CO2e/yr, still
  below often-cited "average person" figures (8–10 tonnes) because those
  are scoped much more broadly. If you've answered any of the optional
  extras above (gas heating, car ownership, pets, water usage, banking),
  the matching representative UK figure for each one is added to *both*
  sides of the comparison, so it's never your fuller total measured
  against a narrower UK figure.
- **UK percentile** (Home page): models the population as log-normally
  distributed around the UK average above (median = average, an assumed
  spread) to estimate a percentile — illustrative, not based on real
  ONS/population distribution data.
- **Car-km / trees comparisons** (Home page): the car-km comparison reuses
  the same blended-average car factor as commuting (~0.171 kg CO2e/km, not
  converted to miles or personalized to a chosen car type - it's a
  reference unit, not a claim about your actual car); the trees comparison
  uses ~22 kg CO2e absorbed per mature tree per year.
- **UK average week** (This Week page, and the "Match UK average week" goal
  preset): the same commute + food UK-average assumptions as above, without
  the ×52, since this is what a single average week (not year) comes to —
  roughly 46.2 kg CO2e.
- **1.5°C by 2030 target — comprehensive** (Home page, "How your year
  compares"): 2,500 kg CO2e/yr per capita, the Hot or Cool Institute's
  "1.5-Degree Lifestyles" research target (dropping further for 2040/2050)
  as roughly a fair-share pathway for keeping warming under 1.5°C. This
  covers a *whole* lifestyle (mobility, energy, food, shopping, leisure) —
  not just what this app tracks — so it's compared against the Home
  page's fuller yearly total (5–8 categories), not the This Week page's
  narrower commute+food-only weekly figure, which would make this target
  look artificially easy to beat for no reason other than mismatched
  scope. (This previously cited the MyEmission app's 6.3 kg CO2e/day
  figure instead — switched to Hot or Cool's own headline number so this
  and the food+commute preset below cite one consistent source.)
- **1.5°C by 2030 target — food + commute only** (Account page goal
  preset): ~20.2 kg CO2e/week. There's no officially published
  category-level split of the comprehensive target above, so this is our
  own estimate: applying published 2030 reduction requirements for
  developed countries (nutrition −47%, mobility −72%, per Hot or Cool
  Institute's "1.5-Degree Lifestyles" research) to the UK-average food and
  commute figures already used elsewhere in this app.
- **World average week** (Account page goal preset): ~29.0 kg CO2e/week.
  The roughest figure in the app — there's no global equivalent of the
  UK's national travel/diet surveys, so this is a lightweight bottom-up
  estimate (a shorter car-equivalent commute and less meat than the UK
  figures) rather than being built from real survey data the way the UK
  figures are.
- **World average year** (Home page, "Compared to:" chip): a flat 4,700 kg
  CO2e/yr — a single commonly-cited global per-capita figure, deliberately
  *not* built bottom-up the way the weekly figure above or the UK average
  are. Same spirit as the "8–10 tonnes CO2e/yr" UK figure already cited
  elsewhere in this app without a bottom-up model behind it: a rough
  reference point, not something this app derives from its own
  assumptions.
- **Uni average year** (Home page, "Compared to:" chip): built the exact
  same way as the "Everyone on the app" Leaderboard figure, just filtered
  to whoever shares your selected university — see
  `university_weekly_average()` in `supabase/schema.sql`. Requires at
  least 3 people from that university with a fully confirmed week before
  showing a real number.
- **Pets** (This Year page, optional): ~770 kg CO2e/yr per dog, ~310 kg
  CO2e/yr per cat, mostly driven by their (often meat-heavy) diet, split
  evenly across everyone in the household (the "People in your household"
  figure), the same way home energy is. The UK-average comparison assumes
  ~0.2 dogs and ~0.15 cats per person, a rough estimate from UK
  pet-population figures.
- **Water usage** (This Year page, optional): household m&sup3;/yr (from a
  water bill) &times; ~0.32 kg CO2e/m&sup3;, a rough DEFRA-style combined
  supply + treatment factor, split evenly across the household the same
  way electricity and gas are. The UK-average comparison assumes ~122
  m&sup3;/yr per household (~140 L/person/day).
- **Banking** (This Year page, optional): balance held with your bank
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
