# App Store and Google Play pack

Everything needed to list CO2 Counter in both stores. Copy the text below into
App Store Connect and the Google Play Console.

- Screenshots: `screenshots/ios` (iPhone 6.9", 1320×2868), `screenshots/iphone-6.3`
  (iPhone 6.1"/6.3", 1206×2622), `screenshots/ipad`
  (iPad 13", 2064×2752), `screenshots/android` (phone, 1080×1920). All use the
  example profile, so no real person's data appears.
- Graphics: `graphics/play-feature-1024x500.png` (Play feature graphic) and
  `graphics/play-icon-512.png` (Play icon). The iOS icon is already in the Xcode
  project.

App ID on both stores: `com.solenyarick.co2tracker` (permanent once registered).
App name shown on the phone: **CO2 Counter**.

## Listing text

| Field | Text |
| --- | --- |
| Name | CO2 Counter |
| iOS subtitle (30) | Measure and cut your footprint |
| iOS promotional text (170) | Find out your yearly carbon footprint in five minutes, then take the seven actions that cut it most. |
| iOS keywords (100) | carbon,footprint,climate,CO2,calculator,emissions,sustainability,eco,green,net zero,NHS,habits,diet |
| Play short description (80) | Your yearly carbon footprint in five minutes, and the changes that cut it most. |
| Category | Lifestyle (secondary: Education) |
| Age rating | 4+ (Apple) / Everyone (Google): no objectionable content |
| Price | Free, no in-app purchases, no ads |
| Support URL | https://co2counter.co.uk/about/ |
| Marketing URL | https://co2counter.co.uk |
| Privacy policy URL | https://co2counter.co.uk/privacy/ |
| Contact email | CO2counter@outlook.com |

### Description (both stores)

CO2 Counter works out your yearly carbon footprint from six short questions about your week: meals, commute, flights, home and water, pets, and where your money sits. It uses official UK government emission factors, and shows how you compare with the UK average and the 1.5°C budget.

Then it shows you what to do about it:
• Your 3 biggest moves, each with the kilograms it saves and a step-by-step guide
• My Habits: Real Zero's 7 Acts, from moving your money to writing to your MP, ticked off as you do them
• Friends and groups: compare yearly totals with friends, your team or your ward, and cheer each other on
• Greener switches: independent picks for banks, energy, food and travel

Built for everyone, with extras for NHS staff: the NHS Pension Scheme, Cycle to Work and salary-sacrifice electric cars are all covered.

Free, with no ads. We never sell your data, and friends only ever see each other's yearly totals, never your answers. Some partner links may earn us a small fee; they are always labelled.

## App privacy (Apple "nutrition label") and Google Play Data safety

No tracking: nothing is shared with advertisers or data brokers, and the app
uses no tracking or analytics SDKs.

| Data | Collected | Linked to the person | Why |
| --- | --- | --- | --- |
| Email address | Yes, with an account | Yes | Account sign-in |
| Name (display name, username) | Yes, with an account | Yes | Shown to friends; app functionality |
| User content (survey answers, footprint) | Yes, with an account | Yes | App functionality; saved across devices |
| User ID | Yes, with an account | Yes | App functionality |
| Product interaction (which partner links were opened) | Yes, signed in only | Yes | Analytics (totals only) |
| Optional: occupation (role) | Yes, if given | Yes | Analytics (anonymous totals by role) |
| Postcode for the MP letter | Used in real time, not stored | n/a | Finding the MP; not "collected" under either store's definition |

Data is encrypted in transit, and people can delete their account and data in the app
(Account → Delete account). Without an account, answers stay on the device.

## Notes for App Review

- No in-app purchases. The website offers optional £2-a-year support through
  Stripe; the app hides it entirely and never links to it.
- Demo account for review (create it on co2counter.co.uk before submitting,
  and finish the survey on it): email `review@co2counter.co.uk`, password of
  your choice. Put both in App Store Connect → App Review Information.
- What it does beyond a website: the whole app is bundled, so the survey works
  offline (answers are saved on the device), and it keeps people signed in.
- Partner links open in the browser and are labelled when they could earn a fee.

## What only you can do

1. **Developer accounts:** Apple Developer Program (£79/US$99 a year) and Google
   Play Console (US$25 once). Google needs ID verification, which can take days.
2. **Build iOS on a Mac:** `npm install`, `npm run open:ios`, then in Xcode pick
   your Team under Signing & Capabilities, choose Any iOS Device, and
   Product → Archive → Distribute App. (Full steps: main README, "iOS app".)
3. **Build Android:** install Android Studio, then `npm install`,
   `npm run open:android`, and Build → Generate Signed Bundle / APK →
   Android App Bundle. Create an upload key when asked and keep it safe: losing
   it means you can't update the app.
4. **Google Play testing rule:** new personal developer accounts must run a
   closed test with at least 12 testers for 14 days before going public. The
   UKHACC pilot group could be those testers.
5. Create the demo account above, then fill in the listings with this text,
   the screenshots and the privacy answers.
