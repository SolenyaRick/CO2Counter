# App Store screenshots

Seven 1320 × 2868 images for App Store Connect's 6.9" iPhone slot (it scales
them for the smaller iPhones). Upload them in this order:

1. `01-know-your-footprint.png`: Know your footprint. Watch it shrink.
2. `02-six-short-steps.png`: Answer a few questions about your week.
3. `03-your-results.png`: See where it really comes from.
4. `04-picture-your-year.png`: Watch your footprint shrink.
5. `05-greener-switches.png`: Find your biggest switch.
6. `06-build-habits.png`: Build habits that stick.
7. `07-what-if-everyone.png`: What if everyone lived like you? (beta)

The app screens are real captures of the site at iPhone size, using a
typical UK resident's answers with £5,000 in a high-street bank and a demo
user called Sam. No real person's data.

## Rebuilding them

From the repo root, serve the site, capture the screens, then render:

    python3 -m http.server 8765 &
    mkdir -p store/app-store-screenshots/source/raw
    node store/app-store-screenshots/source/capture.cjs store/app-store-screenshots/source/raw
    cd store/app-store-screenshots/source && python3 -m http.server 8766 &

Then open `http://localhost:8766/slides.html` and screenshot each
`<section class="slide">` at 1320 × 2868 (Playwright: `el.screenshot()`).
Headlines, badges and colours are in `slides.js`.
