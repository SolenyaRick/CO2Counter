# App Store screenshots

Seven images, in two sizes:

- This folder: 1320 × 2868, for App Store Connect's **6.9"** iPhone slot.
- `iphone-6.3/`: 1206 × 2622, for the **6.1" / 6.3"** iPhone slot.
- `ipad-13/`: 2064 × 2752, for the **iPad 13"** slot. The app at iPad size, in an iPad frame.
- `laptop/`: 2880 × 1800, the website in a browser window. That's the Mac App
  Store size (16:10), and it works for the website, press and social media too.

Upload them in this order (same names in both folders):

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
For the 6.3" set, resize each to 1206 × 2622 (the same shape, to within
0.1%) with a high-quality filter such as Pillow's LANCZOS.
Headlines, badges and colours are in `slides.js`.

### iPad and laptop sets

`source/wide/capture.cjs` captures the screens at iPad (1032 × 1352) or
laptop (1440 × 860) size, at 2x, and `source/wide/wide.html?m=ipad` (or
`?m=laptop`) lays out the slides. Serve `source/wide/` with the captures in
`raw-ipad/` and `raw-laptop/` beside it, then screenshot each slide.
