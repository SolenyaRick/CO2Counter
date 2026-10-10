# EcoImpact (Prototype 2)

A carbon-footprint survey and habit tracker. Answer six short sections
about your week and it estimates your monthly footprint, shows where it
comes from, and points you at your biggest opportunity to cut it.

Prototype 2 was designed in Base44 and ported here as a plain static web
app (no build step), replacing Prototype 1 (the weekly CO2 Tracker). Prototype 1
is still in this repository's git history, and its Supabase tables are left
untouched.

## Pages

- **Survey** (`#/`): six steps: Weekly Meals (diet, or each day's main
  meal, eating out, food waste), Daily Commute (distance + mode per day),
  Flight Checklist (airport-to-airport flights with cabin class), Home &
  Water (electricity, gas, green tariff, water, household size), Pets and
  Banking (savings and which bank holds them). Answers save as you go.
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
- **Account** (`#/account`): sign in or out, a summary of saved data, and
  options to clear habits or everything.

## Where data lives

Everything works without an account, saved in the browser's localStorage
(`ecoimpact_*` keys). When signed in, the survey answers are also saved to
Supabase (`survey_responses`, one JSON row per user), so they follow you
between devices. Habits, streaks, goals and monthly snapshots stay on the
device, as they did in the Base44 version. Existing Prototype 1 accounts
sign in unchanged; only their survey starts fresh.

## Files

- `index.html`: page shell, header and navigation.
- `data.js`: survey options, emission factors, airports, banks, and all
  explainer and habit text, copied exactly from the Base44 prototype.
- `app.js`: calculations, hash routing, rendering, and Supabase auth and sync.
- `style.css`: styles (neutral greys with an emerald accent, matching
  Base44).
- `vendor/supabase.js`: the Supabase client.
- `supabase/schema.sql`: database schema. The `survey_responses` section at
  the end is what Prototype 2 needs.

## Running it

No build step. Serve the folder with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

**One-time database step:** in Supabase, open **SQL Editor** and run the
"EcoImpact (Prototype 2)" section at the end of `supabase/schema.sql`. It
creates the `survey_responses` table. Until it exists, signed-in users'
answers are only kept on their device.

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
