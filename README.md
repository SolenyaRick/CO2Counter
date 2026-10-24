# CO2 Counter (Prototype 2)

A carbon-footprint survey and habit tracker. Answer six short sections
about your week and it estimates your yearly footprint, shows where it
comes from, and points you at your biggest opportunity to cut it.

Anyone can take the survey and see their yearly total compared with the
UK average, with no account. Everything else (the breakdown, tips, guides,
habits, check-ins and saving across devices) needs an account with a
£2/year membership (Stripe). The owner account (jack.s.brown@outlook.com)
is free. Answers given as a guest stay on the device and are uploaded to
the account when the person joins.

Prototype 2 was designed in Base44 and ported here as a plain static web
app (no build step), replacing Prototype 1 (the weekly CO2 Tracker). Prototype 1
is still in this repository's git history, and its Supabase tables are left
untouched.

## Pages

- **Survey** (`#/`): six steps: Weekly Meals (diet, or each day's main
  meal, eating out, food waste), Daily Commute (distance + mode per day),
  Flight Checklist (airport-to-airport flights with cabin class), Home &
  Water (electricity, gas, green tariff, water, household size), Pets and
  Banking & Pension (savings and bank, pension pot and provider). Answers save as you go.
  Finishing the survey records that month's total for the progress list.
- **Results** (`#/results`): monthly total, comparison with the UK average
  and the 1.5°C budget (2.5 t/yr), a tappable bar chart by category, the
  biggest-opportunity tip with its estimated saving, the "if you build these
  habits" comparison, per-category rows, and monthly progress. A banner
  nudges you to re-take the survey in a new month.
- **Explainers** (`#/explainer/<category>`): why the category matters,
  your potential saving, and numbered guidance cards. The Meals guidance
  adapts to your diet. The Flights cards open pop-ups with your flight
  tier, tree/phone/driving equivalents, and a flight-vs-train comparison.
  Committing to habits is shown as "Coming Soon", as in the Base44 version.
- **Habits** (`#/habits`) and **Check-in** (`#/check-in`): committed
  habits, daily check-ins with 🔥 streaks, one new habit unlocking per week,
  and deadlines for one-off goal habits.
- **Account** (`#/account`): sign out, membership status (with a link to
  Stripe to manage or cancel), a summary of saved data, and options to clear
  habits or everything.
- **How we calculate** (`#/how-we-calculate`): a free public page linked
  from results and the footer. It explains the sources and approach in
  plain English, but deliberately leaves out the exact factors and
  formulas (those live in `data.js`/`app.js`, which are still public to
  anyone who reads the code).
- **Sign-in and membership screens**: guests see the free results (total
  and UK-average comparison) with a "Create an account and join" prompt;
  the members-only pages ask guests to sign in and non-members to join.

## Where data lives

Survey answers are saved to Supabase (`survey_responses`, one JSON row per
user) and cached in the browser's localStorage (`ecoimpact_*` keys), so they
follow you between devices. Habits, streaks, goals and monthly snapshots stay on the
device, as they did in the Base44 version. Existing Prototype 1 accounts
sign in unchanged; only their survey starts fresh.

## Files

- `index.html`: page shell, header and navigation.
- `data.js`: survey options, emission factors, airports, banks, and all
  explainer and habit text, copied exactly from the Base44 prototype.
  Results are shown per year (12× Base44's monthly figures); the energy and
  water questions still ask for monthly amounts, as bills show them.
- `app.js`: calculations, hash routing, rendering, and Supabase auth and sync.
- `style.css`: styles (neutral greys with an emerald accent, matching
  Base44).
- `vendor/supabase.js`: the Supabase client.
- `supabase/schema.sql`: database schema. The "EcoImpact (Prototype 2)"
  section at the end is what Prototype 2 needs.
- `supabase/functions/stripe-webhook/index.ts`: Edge Function that Stripe
  calls on payments, renewals and cancellations; it updates `memberships`.

## Running it

No build step. Serve the folder with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

**One-time database step:** in Supabase, open **SQL Editor** and run the
"EcoImpact (Prototype 2)" section at the end of `supabase/schema.sql`
(the `survey_responses` and `memberships` parts). It's safe to re-run.

## UK average comparison

Results compare the person with a typical UK resident like for like: the
typical resident's answers (`UK_TYPICAL_SURVEY` in `data.js`, each input
sourced there: Ofgem, ONS, Consumer Council for Water, DfT National Travel
Survey, ONS Travel trends, UK Pet Food) are run through the same factors,
and both sides cover only food, commuting, flights, home energy, water and
pets. Shopping, services, coffee, alcohol and the like aren't counted
because the survey doesn't measure them, and banking and pensions are left
out of the comparison because there is no reliable UK per-person figure.
The typical diet comes from Defra's Family Food survey (average
purchases of each meat and fish per person per week); eating out once a
week and "some" food waste are assumptions.

## Friends

`#/friends` (members only) reuses Prototype 1's `friendships` table,
`profiles.display_name` and `find_user_by_email()`, so existing friendships
carry over. People add friends by email, accept or decline requests, and
see a leaderboard of yearly totals for themselves and accepted friends.
The app saves each member's yearly total in `survey_responses.total_yearly`,
and `friends_footprints()` returns only names and totals, never answers.
Run the "Friends (Prototype 2)" section of `supabase/schema.sql` once.

## Giving people free access

Add their email address to the `free_access` table in Supabase (Table
Editor → free_access → Insert row). `note` is for your own reference, and
`expires_at` is optional (leave empty for no end date). They get full
access as soon as they sign in with that email; delete the row to remove
it. Run the "Free access list" section of `supabase/schema.sql` once first.

## Privacy policy and terms

`#/privacy` and `#/terms`, linked from the footer and the sign-up and join
screens. Set `OPERATOR_NAME` and `CONTACT_EMAIL` near the top of `app.js`;
until then the pages show placeholders. This isn't legal advice, so have
them checked if you can.

## Inputs (changing the figures live)

Every figure the footprint is worked out with (107 of them: food, travel,
flights, energy, pets, each bank and pension provider, the shared and
assumed lines, the savings assumptions and the UK-average profile used for
the comparison) is listed in `INPUT_DEFS` in `data.js`, with its source.
Admins can change any of them on the Inputs page (`#/inputs`, linked from
the Account page): new figure, new source, Save. The change reaches every
visitor the next time they load the site, with no deploy.

- The built-in values stay in `data.js`; edits are stored in the `inputs`
  table and override them. Every edit is logged in `input_changes`, with
  Undo on the Inputs page and a public "Figure updates" list on How we
  calculate.
- A finished survey keeps the figures it was worked out with
  (`survey.factors`), so past totals and history never move. Results show
  a "New figures since your survey" note with a Quick update button; the
  next survey uses the latest figures.
- The app owner is always an admin; add others with the snippet at the end
  of the "Inputs" section of `supabase/schema.sql` (run that section once).
- Export CSV on the Inputs page downloads every figure with its source,
  for the emission factors spreadsheet.

## Analytics (owner)

`#/analytics` (admins only, linked from the Account page) shows:

- The average footprint across everyone's latest survey, with standard
  deviation, median and counts. Each survey is worked out with the
  figures it was taken with.
- The average and standard deviation for each area, as a bar chart with
  ±1 SD lines.
- Each partner link's click-throughs (once per person), affiliate uses
  (people who used the referral version, once a `ref` link is added), and
  survey switches: people who clicked the link and in a later survey made
  that change (renewable tariff, moving to that bank, fewer meat days,
  fewer car commute days, fewer flights), with everyone who made the
  change in brackets.

Data comes from `owner_analytics()` in `supabase/schema.sql` ("Owner
analytics" section, run once). People appear only as a scrambled id.

## Bank figures

The per-bank figures (`BANKS` in `data.js`, kg CO2e financed per £ held
per year) come from MotherTree's 2021 analysis of UK banks.

## Pension figures

The Banking & Pension step multiplies the pension pot by the provider's
default-fund carbon footprint (Scope 1+2 tonnes CO2e per £1m invested,
from each scheme's own TCFD climate report). The figures and their sources
are in `PENSION_PROVIDERS` in `data.js`. "Other / not sure" uses the
average of 20 major UK workplace schemes (Corporate Adviser, 2024). The
saving assumes a switch to a climate-focused fund like Nest's Ethical Fund
(21 t per £1m). Providers publish new reports every year, so refresh the
figures yearly. Not yet included, because no usable current figure could
be retrieved: Scottish Widows (its site blocks automated downloads),
Prudential/M&G (report link removed), Cushon and SEI (only 2023 data),
Mercer, LifeSight, Hargreaves Lansdown, Zurich, Atlas and PensionBee (no
default-fund figure published or found). The People's Pension figure is
worked out from its reported reduction, and NOW: Pensions' comes from its
announcement, because neither report could be downloaded.

## Payments (£2/year via Stripe)

How it fits together:

1. The membership screen sends people to a Stripe **Payment Link**, adding
   their Supabase user ID as `client_reference_id`.
2. Stripe calls the `stripe-webhook` Edge Function, which records the
   subscription in `memberships` (status and paid-until date).
3. `has_access()` in the database is true for the owner's email or an active,
   paid-up membership. The app checks it via `membership_status()`, and the
   `survey_responses` policy uses it, so the paywall holds on the server too.
4. Renewals, failed cards and cancellations arrive as
   `customer.subscription.*` events and update the same row.

The iOS app never shows a purchase button or link to Stripe (App Store rules
require Apple's own in-app purchase for that). People who haven't paid are
told to join on the website, then sign in on the app.

Setup (Stripe dashboard, then Supabase dashboard):

1. **Product:** Product catalogue → **Add product** → "EcoImpact
   membership", **Recurring**, **£2.00 GBP**, billing period **Yearly**.
2. **Payment Link:** on that product, **Create payment link**. Under
   **After payment**, choose "Don't show confirmation page" and redirect to
   `https://co2counter.co.uk/?checkout=success`. Copy the link
   (`https://buy.stripe.com/...`) into `STRIPE_PAYMENT_LINK` in `app.js`.
3. **Customer portal:** Settings → Billing → **Customer portal** → activate,
   allow cancelling, and copy the **login link** into `STRIPE_PORTAL_URL` in
   `app.js`.
4. **Edge Function:** Supabase → **Edge Functions** → **Deploy a new
   function** → **Via editor**, name it `stripe-webhook`, paste in
   `supabase/functions/stripe-webhook/index.ts` and deploy. Then open its
   settings and turn **Enforce JWT verification** off. (CLI alternative:
   `supabase functions deploy stripe-webhook --no-verify-jwt`.)
5. **Webhook:** Stripe → Developers → **Webhooks** → **Add endpoint**:
   `https://fbgfylfnbtxzbwgilktt.supabase.co/functions/v1/stripe-webhook`,
   with events `checkout.session.completed`,
   `customer.subscription.updated` and `customer.subscription.deleted`.
   Copy its **Signing secret** (`whsec_...`).
6. **Secrets:** Supabase → Edge Functions → **Secrets**: add
   `STRIPE_SECRET_KEY` (Stripe → Developers → API keys → Secret key) and
   `STRIPE_WEBHOOK_SECRET` (from step 5).

Do all of this in Stripe's **test mode** first and pay with card
`4242 4242 4242 4242`. Then repeat steps 1–3, 5 and 6 in live mode,
update the two links in `app.js`, and replace both secrets with their live
values.

## iOS app (Capacitor)

The `ios/` folder is a [Capacitor](https://capacitorjs.com) wrapper around
this exact web app — same `index.html`/`app.js`/`data.js`/`style.css`/
`vendor`/`icons`, unchanged, running inside a
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

**Custom domain**: the site is served from **`co2counter.co.uk`** via
GitHub Pages (see the `CNAME` file). Sign-up and password-reset emails sent
from inside the iOS app link to that website, where they complete in the
browser. The remaining setup needs your domain registrar, GitHub's website
and Xcode:

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

Safe-area padding (`env(safe-area-inset-*)` in `style.css`)
and `apple-mobile-web-app-*` meta tags in `index.html` are already in place
so content clears the notch/Dynamic Island and home indicator, and so
"Add to Home Screen" from Safari (a separate, App-Store-free path to a
home-screen icon - see `manifest.json`) looks reasonable too.
