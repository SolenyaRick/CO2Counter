// ============================================================================
// tile-info.js
// ----------------------------------------------------------------------------
// Content for the info (ⓘ) popups on the Home page's Food, Home energy,
// Flying, and Banking tiles - plain, directly-editable, same idea as
// emission-factors.js: edit the text below and reload, nothing else needs
// to change.
//
// Each entry's `body` becomes the popup's HTML content, so basic tags are
// fine - <p>, <ul>/<li>, <strong>, <a href="...">. Keep it short enough to
// read in a small popup on a phone.
//
// This file must be loaded via a <script> tag before app.js (see
// index.html) - same top-level-const-becomes-shared-scope trick as
// emission-factors.js.
// ============================================================================

const TILE_INFO = {
  food: {
    title: "Food",
    body: "<p>Add your own tips here - e.g. which swaps cut the most CO2e, how portion size and food waste change the numbers, or links to sources.</p>",
  },
  homeEnergy: {
    title: "Home energy",
    body: "<p>Add your own tips here - e.g. switching supplier to a renewable tariff, insulation, or the impact of appliance choices.</p>",
  },
  flying: {
    title: "Flying",
    body: "<p>Add your own tips here - e.g. train alternatives for short-haul routes, how flight frequency compares to other categories, or offsetting caveats.</p>",
  },
  banking: {
    title: "Banking",
    body: "<p>Add your own tips here - e.g. which high-street or ethical banks finance less fossil fuel extraction, and how switching compares to the other categories on this page.</p>",
  },
};
