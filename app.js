// CO2 Counter (Prototype 2): yearly carbon-footprint survey, results,
// reduction guides, habits and daily check-ins.
//
// Ported from the Base44 prototype. Anyone can take the survey and see
// their yearly total against the UK average; everything else (breakdown,
// tips, guides, habits, sync) needs a signed-in account with an active
// £2/year membership (paid through Stripe, recorded by the stripe-webhook
// Edge Function), unless they are the owner. Survey answers
// are kept in Supabase (survey_responses, see supabase/schema.sql) and
// cached in localStorage; habits and streaks stay on the device.
(function () {
  "use strict";

  const SUPABASE_URL = "https://fbgfylfnbtxzbwgilktt.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiZ2Z5bGZuYnR4emJ3Z2lsa3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwOTg1MjUsImV4cCI6MjEwMDY3NDUyNX0.S-c144dilgUwf8saEjuIQMAp4q-B86R2TRkLV6l9Ym0";

  // Stripe Payment Link for the £2/year membership, and the Stripe customer
  // portal login link (for cancelling or updating a card). Both come from
  // the Stripe dashboard; see README "Payments". Leave empty until set up.
  const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/9B6eVd0a4g2X4Gbc2K5EY00";
  // Everything is free while this is on; the £2 a year becomes an optional
  // way to support the site. Set to false to bring the paywall back (and
  // restore has_access() in supabase/schema.sql).
  const FREE_MODE = true;
  const STRIPE_PORTAL_URL = "https://billing.stripe.com/p/login/9B6eVd0a4g2X4Gbc2K5EY00";
  const WEBSITE_URL = "https://co2counter.co.uk/";
  // Shown on the Privacy and Terms pages. Fill these in before publishing.
  const OPERATOR_NAME = "Jack Brown";
  const CONTACT_EMAIL = "CO2counter@outlook.com";
  const LEGAL_UPDATED = "2 November 2026";
  // Bump when the privacy policy changes in a way people should be told
  // about: signed-in accounts on an older version see a one-time notice.
  const PRIVACY_VERSION = "2026-10-28";

  const D = window.ECO_DATA;
  // The hand-picked airports in data.js come first (they're the list shown
  // before you search); airports.js adds every other scheduled airport.
  const POPULAR_AIRPORTS = D.AIRPORTS.length;
  (window.ECO_AIRPORTS || "").split("\n").forEach((line) => {
    const [code, city, country, lat, lon, name] = line.split("|");
    if (!code) return;
    const known = D.AIRPORTS.find((a) => a.code === code);
    if (known) known.name = name; // full name helps search, e.g. "Kennedy"
    else D.AIRPORTS.push({ code, city, country, lat: Number(lat), lon: Number(lon), name });
  });
  D.AIRPORTS.forEach((a) => (a.search = (a.city + " " + a.code + " " + a.country + " " + (a.name || "")).toLowerCase()));
  const AIRPORT_BY_CODE = new Map(D.AIRPORTS.map((a) => [a.code, a]));
  // An invite link (?ref=CODE) is remembered until the person signs in,
  // then claimed for whoever shared it (act 7 on the Habits page).
  (() => {
    const m = (location.search + location.hash).match(/[?&]ref=([A-Za-z0-9]{4,12})/);
    if (m) try { localStorage.setItem("co2_ref", m[1].toUpperCase()); } catch (e) {}
  })();
  const DAYS = D.DAYS;
  const CATEGORIES = Object.keys(D.EXPLAINERS);

  const KEY_SURVEY = "ecoimpact_survey";
  const KEY_SNAPSHOTS = "ecoimpact_monthly_snapshots";
  // Completed surveys on this device (guests, and a fallback when offline).
  const KEY_HISTORY = "co2_survey_history";
  const KEY_SHOW_UK = "co2_chart_show_uk";
  // Set while someone who came from a reset link still has to choose a new
  // password, so a reload doesn't skip that step. Per tab only.
  const KEY_RECOVERY = "co2_password_recovery";
  const KEY_HABITS = "ecoimpact_habits_"; // + category
  const KEY_STAGE = "ecoimpact_stage_"; // + category
  const KEY_GOALS = "ecoimpact_goals";
  const KEY_STREAKS = "ecoimpact_goal_streaks";

  // Savings assumptions (see tipFor).
  const MOTOR_MODES = ["car_petrol", "car_diesel", "ev", "motorcycle"];
  const A = D.ASSUMPTIONS; // editable on the Inputs page, so read at use
  const trainToFlightRatio = () => A.PARIS_TRAIN_KG / A.PARIS_FLIGHT_KG; // Eurostar vs flight, London–Paris
  const STAGE_DAYS = 7;
  const DAY_MS = 864e5;

  // ==================== helpers ====================

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // The first sentence of a paragraph, for main pages that keep text short
  // (the full text stays on the pages that explain).
  const firstSentence = (t) => String(t || "").split(/(?<=[.!?])\s+(?=[A-Z0-9£“"])/)[0];

  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function ssGet(key) {
    try {
      return sessionStorage.getItem(key) === "1";
    } catch (e) {
      return false;
    }
  }

  function ssSet(key, on) {
    try {
      if (on) sessionStorage.setItem(key, "1");
      else sessionStorage.removeItem(key);
    } catch (e) {}
  }

  function lsRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  const byKey = (list, key) => list.find((o) => o.key === key);
  const factorOf = (list, key) => (byKey(list, key) || {}).factor || 0;
  const fixed = (n, d) => Number(n || 0).toFixed(d || 0);
  const capFirst = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : "");

  const ICONS = {
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
    link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    share: '<path d="M12 3v12"/><path d="m7.5 7.5 4.5-4.5 4.5 4.5"/><path d="M8 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/>',
    arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    trendDown: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
    refresh: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    minus: '<path d="M5 12h14"/>',
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    tree: '<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7z"/><path d="M12 22v-3"/>',
    phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    logIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3 0 1.25 1 3 2.5 3.5z"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  };

  // Line icons (Lucide, ISC licence) that stand in for the emojis used in
  // data.js and the templates. glyphify() swaps them in as each page renders,
  // so the data can keep its emoji keys.
  const GLYPHS = {
    "🛍️": '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/> <path d="M3 6h18"/> <path d="M16 10a4 4 0 0 1-8 0"/>',
    "🍽️": '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/> <path d="M7 2v20"/> <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
    "🥗": '<path d="M2 2a26.6 26.6 0 0 1 10 20c.9-6.82 1.5-9.5 4-14"/> <path d="M16 8c4 0 6-2 6-6-4 0-6 2-6 6"/> <path d="M17.41 3.6a10 10 0 1 0 3 3"/>',
    "🧀": '<path d="M2.27 21.7s9.87-3.5 12.73-6.36a4.5 4.5 0 0 0-6.36-6.37C5.77 11.84 2.27 21.7 2.27 21.7zM8.64 14l-2.05-2.04M15.34 15l-2.46-2.46"/> <path d="M22 9s-1.33-2-3.5-2C16.86 7 15 9 15 9s1.33 2 3.5 2S22 9 22 9z"/> <path d="M15 2s-2 1.33-2 3.5S15 9 15 9s2-1.84 2-3.5C17 3.33 15 2 15 2z"/>',
    "🐟": '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/> <path d="M18 12v.5"/> <path d="M16 17.93a9.77 9.77 0 0 1 0-11.86"/> <path d="M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"/> <path d="M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4"/> <path d="m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98"/>',
    "🥩": '<circle cx="12.5" cy="8.5" r="2.5"/> <path d="M12.5 2a6.5 6.5 0 0 0-6.22 4.6c-1.1 3.13-.78 3.9-3.18 6.08A3 3 0 0 0 5 18c4 0 8.4-1.8 11.4-4.3A6.5 6.5 0 0 0 12.5 2Z"/> <path d="m18.5 6 2.19 4.5a6.48 6.48 0 0 1 .31 2 6.49 6.49 0 0 1-2.6 5.2C15.4 20.2 11 22 7 22a3 3 0 0 1-2.68-1.66L2.4 16.5"/>',
    "🍗": '<path d="M15.4 15.63a7.875 6 135 1 1 6.23-6.23 4.5 3.43 135 0 0-6.23 6.23"/> <path d="m8.29 12.71-2.6 2.6a2.5 2.5 0 1 0-1.65 4.65A2.5 2.5 0 1 0 8.7 18.3l2.59-2.59"/>',
    "🥓": '<path d="M13.144 21.144A7.274 10.445 45 1 0 2.856 10.856"/> <path d="M13.144 21.144A7.274 4.365 45 0 0 2.856 10.856a7.274 4.365 45 0 0 10.288 10.288"/> <path d="M16.565 10.435 18.6 8.4a2.501 2.501 0 1 0 1.65-4.65 2.5 2.5 0 1 0-4.66 1.66l-2.024 2.025"/> <path d="m8.5 16.5-1-1"/>',
    "🍖": '<path d="M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c.28 0 .5.22.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5Z"/>',
    "🏠": '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/> <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "🚲": '<circle cx="18.5" cy="17.5" r="3.5"/> <circle cx="5.5" cy="17.5" r="3.5"/> <circle cx="15" cy="5" r="1"/> <path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    "🚇": '<path d="M2 22V12a10 10 0 1 1 20 0v10"/><path d="M15 6.8v1.4a3 2.8 0 1 1-6 0V6.8"/><path d="M10 15h.01"/><path d="M14 15h.01"/><path d="M10 19a4 4 0 0 1-4-4v-3a6 6 0 1 1 12 0v3a4 4 0 0 1-4 4Z"/><path d="m9 19-2 3"/><path d="m15 19 2 3"/>',
    "🚆": '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/> <path d="m9 15-1-1"/> <path d="m15 15 1-1"/> <path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/> <path d="m8 19-2 3"/> <path d="m16 19 2 3"/>',
    "🚌": '<path d="M8 6v6"/> <path d="M15 6v6"/> <path d="M2 12h19.6"/> <path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/> <circle cx="7" cy="18" r="2"/> <path d="M9 18h5"/> <circle cx="16" cy="18" r="2"/>',
    "🚙": '<path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"/> <path d="M7 14h.01"/> <path d="M17 14h.01"/> <rect width="18" height="8" x="3" y="10" rx="2"/> <path d="M5 18v2"/> <path d="M19 18v2"/>',
    "🚗": '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/> <circle cx="7" cy="17" r="2"/> <path d="M9 17h6"/> <circle cx="17" cy="17" r="2"/>',
    "⚡": '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    "🏍️": '<circle cx="18.5" cy="17.5" r="3.5"/> <circle cx="5.5" cy="17.5" r="3.5"/> <circle cx="15" cy="5" r="1"/> <path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    "💺": '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/> <path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/> <path d="M5 18v2"/> <path d="M19 18v2"/>',
    "🥂": '<path d="M8 22h8"/> <path d="M7 10h10"/> <path d="M12 15v7"/> <path d="M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z"/>',
    "🛋️": '<path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/> <path d="M2 16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/> <path d="M4 18v2"/> <path d="M20 18v2"/> <path d="M12 4v9"/>',
    "👑": '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/> <path d="M5 21h14"/>',
    "✈️": '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
    "💧": '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
    "🐾": '<circle cx="11" cy="4" r="2"/> <circle cx="18" cy="8" r="2"/> <circle cx="20" cy="16" r="2"/> <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>',
    "🏦": '<line x1="3" x2="21" y1="22" y2="22"/> <line x1="6" x2="6" y1="18" y2="11"/> <line x1="10" x2="10" y1="18" y2="11"/> <line x1="14" x2="14" y1="18" y2="11"/> <line x1="18" x2="18" y1="18" y2="11"/> <polygon points="12 2 20 7 4 7"/>',
    "🌱": '<path d="M7 20h10"/> <path d="M10 20c5.5-2.5.8-6.4 3-10"/> <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/> <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
    "🔥": '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    "✅": '<circle cx="12" cy="12" r="10"/> <path d="m9 12 2 2 4-4"/>',
    "➕": '<path d="M5 12h14"/> <path d="M12 5v14"/>',
    "🐕": '<path d="M11.25 16.25h1.5L12 17z"/> <path d="M16 14v.5"/> <path d="M4.42 11.247A13.152 13.152 0 0 0 4 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a11.702 11.702 0 0 0-.493-3.309"/> <path d="M8 14v.5"/> <path d="M8.5 8.5c-.384 1.05-1.083 2.028-2.344 2.5-1.931.722-3.576-.297-3.656-1-.113-.994 1.177-6.53 4-7 1.923-.321 3.651.845 3.651 2.235A7.497 7.497 0 0 1 14 5.277c0-1.39 1.844-2.598 3.767-2.277 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5"/>',
    "🐈": '<path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z"/> <path d="M8 14v.5"/> <path d="M16 14v.5"/> <path d="M11.25 16.25h1.5L12 17l-.75-.75Z"/>',
    "🎯": '<circle cx="12" cy="12" r="10"/> <circle cx="12" cy="12" r="6"/> <circle cx="12" cy="12" r="2"/>',
    "🌳": '<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/> <path d="M12 22v-3"/>',
    "📱": '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/> <path d="M12 18h.01"/>',
    "🌍": '<circle cx="12" cy="12" r="10"/> <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/> <path d="M2 12h20"/>',
    "📋": '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/> <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/> <path d="M12 11h4"/> <path d="M12 16h4"/> <path d="M8 11h.01"/> <path d="M8 16h.01"/>',
    "ℹ️": '<circle cx="12" cy="12" r="10"/> <path d="M12 16v-4"/> <path d="M12 8h.01"/>',
  };
  const DOT_COLORS = { "🟢": "#4c9a6a", "🟡": "#d9b23c", "🟠": "#e08a3c", "🔴": "#d0574a" };
  const GLYPH_RE = new RegExp("(" + Object.keys(GLYPHS).concat(Object.keys(DOT_COLORS)).map((k) => k.replace(/\uFE0F/g, "")).join("|") + ")\uFE0F?", "g");

  function glyph(e) {
    const k = GLYPHS[e] ? e : GLYPHS[e + "\uFE0F"] ? e + "\uFE0F" : null;
    if (k) {
      return '<svg class="icon glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + GLYPHS[k] + "</svg>";
    }
    return DOT_COLORS[e] ? '<span class="dot-ind" style="background:' + DOT_COLORS[e] + '"></span>' : e;
  }

  // Emojis inside <option> can't hold markup, so they're just dropped there.
  function glyphify(html) {
    return html
      .replace(/(<option[^>]*>)([^<]*)/g, (m, open, text) => open + text.replace(GLYPH_RE, "").trim())
      .replace(GLYPH_RE, (m, e) => glyph(e));
  }

  function icon(name, cls) {
    return (
      '<svg class="icon ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || "") + "</svg>"
    );
  }

  // ==================== Supabase ====================

  let sb = null;
  if (window.supabase && typeof window.supabase.createClient === "function") {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  let currentUser = null;
  let authChecked = false;

  async function refreshUser() {
    if (!sb) {
      currentUser = null;
    } else {
      try {
        const { data } = await sb.auth.getSession();
        currentUser = (data && data.session && data.session.user) || null;
      } catch (e) {
        currentUser = null;
      }
    }
    authChecked = true;
    return currentUser;
  }

  // { access, owner, status, until } once checked; null while unknown.
  let membership = null;

  async function checkMembership() {
    if (!currentUser || !sb) {
      membership = null;
      return null;
    }
    const result = { access: false, owner: false, status: "", until: null, error: false };
    try {
      const { data, error } = await sb.rpc("membership_status");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        result.access = !!row.has_access;
        result.owner = !!row.is_owner;
        result.free = !!row.is_free;
        result.status = row.status || "";
        result.until = row.current_period_end ? new Date(row.current_period_end) : null;
      }
    } catch (e) {
      result.error = true;
    }
    membership = result;
    if (!result.error) lsSet(KEY_MEMBER_CACHE, { ...result, uid: currentUser.id, until: result.until ? result.until.toISOString() : null });
    return result;
  }
  // What this phone last knew about you, so the app can open straight away.
  const KEY_MEMBER_CACHE = "co2_member_cache";
  const KEY_ME_CACHE = "co2_me_cache";

  const isSupporter = () => !!(membership && ["active", "trialing", "past_due"].includes(membership.status));
  // Full results and guides: any signed-in user in free mode (free, but an
  // account lets us see who uses the app), otherwise members.
  const hasFullAccess = () => (FREE_MODE ? !!currentUser : !!(currentUser && membership && membership.access));
  // Answers saved to the account (and Friends): any signed-in user in free
  // mode, otherwise members.
  const canSync = () => !!currentUser && (FREE_MODE || !!(membership && membership.access));

  const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  // The iPhone app fills the whole screen; the page keeps clear of the notch
  // and home bar itself, and doesn't bounce past its top or bottom.
  if (isNativeApp()) document.documentElement.classList.add("native-app");

  async function displayName(user) {
    const meta = (user && user.user_metadata) || {};
    if (meta.full_name) return meta.full_name;
    try {
      let { data, error } = await sb.from("profiles").select("display_name, username").eq("id", user.id).maybeSingle();
      if (error) ({ data } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle());
      if (data && data.username) ui.username = data.username;
      if (data && data.display_name) return data.display_name;
    } catch (e) {}
    return "App user";
  }

  // ==================== live inputs (emission factors) ====================
  // Every figure on the admin Inputs page (#/inputs). data.js holds the
  // built-in values; the admin's edits are kept in Supabase (inputs table)
  // and override them. A finished survey keeps the figures it was worked out
  // with (survey.factors), so past totals never move; new surveys use the
  // latest figures.

  const KEY_INPUTS = "co2_inputs"; // last overrides seen, for a fast, offline start
  const INPUT_DEFS = D.INPUT_DEFS;

  // "NAME", "NAME.field" or "LIST[key].field" -> [object, field]
  function inputRef(path) {
    const m = path.match(/^([A-Z_]+)(?:\[([a-z0-9_]+)\])?(?:\.(\w+))?$/);
    if (!m[2] && !m[3]) return [D, m[1]];
    const obj = m[2] ? byKey(D[m[1]], m[2]) : D[m[1]];
    return [obj, m[3]];
  }
  const inputGet = (d) => { const [o, f] = inputRef(d.path); return o[f]; };
  const inputSet = (d, v) => { const [o, f] = inputRef(d.path); o[f] = v; };

  const BUILT_IN = {};
  INPUT_DEFS.forEach((d) => (BUILT_IN[d.key] = Math.round(inputGet(d) * 1e6) / 1e6));
  let liveInputs = BUILT_IN;
  let inputMeta = {}; // key -> { source, updatedAt } for inputs the admin has set
  let appliedInputs = BUILT_IN;

  function setLiveInputs(rows) {
    const next = { ...BUILT_IN };
    const meta = {};
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      const v = Number(r.value);
      if (BUILT_IN[r.key] == null || !isFinite(v) || v < 0) return;
      next[r.key] = v;
      meta[r.key] = { source: r.source || "", updatedAt: r.updated_at || "" };
    });
    liveInputs = next;
    inputMeta = meta;
  }
  setLiveInputs(lsGet(KEY_INPUTS, []));

  // Returns true when the figures changed, so the page can redraw.
  async function loadInputs() {
    if (!sb) return false;
    try {
      const { data, error } = await sb.from("inputs").select("key, value, source, updated_at");
      if (error || !Array.isArray(data)) return false;
      const before = JSON.stringify(liveInputs);
      lsSet(KEY_INPUTS, data);
      setLiveInputs(data);
      return JSON.stringify(liveInputs) !== before;
    } catch (e) {
      return false;
    }
  }

  // Puts a set of figures into D, then works out the values built from them.
  function applyInputs(values) {
    if (values === appliedInputs) return;
    appliedInputs = values;
    INPUT_DEFS.forEach((d) => inputSet(d, values[d.key] != null ? values[d.key] : BUILT_IN[d.key]));
    const veggie = byKey(D.MEAL_OPTIONS, "veggie").factor;
    ["chicken", "pork", "beef", "lamb"].forEach((k) => (byKey(D.MEAL_OPTIONS, k).factor = Math.round((veggie + D.PORTION * D.MEAT_PER_KG[k]) * 100) / 100));
    const shop = D.ASSUMED_SHOPPING;
    shop.totalKg = shop.clothesKg + shop.householdKg + shop.electronicsKg + shop.hobbiesKg;
    const shared = D.SHARED_FOOTPRINT;
    shared.totalKg = shared.publicServicesKg + shared.infrastructureKg;
    D.buildUkTypical(D.PORTION);
  }

  // The figures a survey is worked out with: its own once finished (built-in
  // ones for surveys finished before figures were kept), else the latest.
  function factorsFor(s) {
    if (!s || !s.completedAt) return liveInputs;
    return s.factors || BUILT_IN;
  }

  function withInputs(values, fn) {
    const prev = appliedInputs;
    applyInputs(values);
    try {
      return fn();
    } finally {
      applyInputs(prev);
    }
  }

  // Inputs whose latest figure differs from the one this survey used.
  function inputsChangedSince(s) {
    const used = factorsFor(s);
    if (used === liveInputs) return [];
    return INPUT_DEFS.filter((d) => Math.abs((used[d.key] != null ? used[d.key] : BUILT_IN[d.key]) - liveInputs[d.key]) > 1e-9);
  }

  // Figures quoted in sentences, worked out from the current inputs.
  function fillTokens(html) {
    if (html.indexOf("{{") < 0) return html;
    const day = (k) => byKey(D.MEAL_OPTIONS, k).factor;
    const times = (r) => {
      const n = Math.round(r);
      return r - n >= 0.15 ? "over " + n + "×" : "about " + n + "×";
    };
    const share = (f) => {
      const words = { 2: "half", 3: "a third", 4: "a quarter", 5: "a fifth", 6: "a sixth", 7: "a seventh", 8: "an eighth", 9: "a ninth", 10: "a tenth" };
      const n = Math.round(1 / f);
      if (f > 0.6 && f < 0.7) return "two-thirds";
      if (f >= 0.7 && f < 0.8) return "three-quarters";
      return f >= 0.8 ? "about " + Math.round(f * 100) + "%" : words[n] ? "about " + words[n] : "under a tenth";
    };
    // "over 80%" style, rounded down to a tidy step.
    const over = (f) => {
      const pct = f * 100;
      const step = Math.floor(pct / 10) * 10;
      return pct - step < 1 ? "about " + Math.round(pct) + "%" : "over " + step + "%";
    };
    const nyKg = flightKg({ from: "LHR", to: "JFK", cabin: "economy", returnTrip: true });
    const t = {
      paris_plane: kgFmt(A.PARIS_FLIGHT_KG),
      paris_train: kgFmt(A.PARIS_TRAIN_KG),
      three_beef_days: kgFmt(Math.round((3 * (day("beef") - day("chicken")) * D.WEEKS_PER_YEAR) / 100) * 100),
      beef_vs_chicken: times(day("beef") / day("chicken")),
      beef_vs_vegan: times(day("beef") / day("vegan")),
      ev_share: share(byKey(D.COMMUTE_MODES, "ev").factor / petrolKm()),
      grid_kwh: (Math.round(D.ELECTRICITY_FACTOR * 100) / 100).toString(),
      green_cut: over(1 - D.GREEN_ELECTRICITY_FACTOR / D.ELECTRICITY_FACTOR),
      oat_cut: "about " + Math.round((1 - A.OAT_MILK_KG / A.DAIRY_MILK_KG) * 100) + "%",
      ny_t: (nyKg / 1000).toFixed(1),
      ny_share: share(nyKg / D.BUDGET_YEARLY),
      short_km: kgFmt(A.SHORT_HAUL_KM),
      swap_km: kgFmt(A.TRAIN_SWAP_MAX_KM),
      medium_km: kgFmt(A.MEDIUM_HAUL_MAX_KM),
      active_km: String(A.ACTIVE_TRAVEL_MAX_KM),
      budget_t: (D.BUDGET_YEARLY / 1000).toFixed(1).replace(/\.0$/, ""),
      uk_total_t: String(Math.round(A.UK_TOTAL_KG / 1000)),
      bank_cut: Math.round((1 - Math.min(...D.BANKS.map((x) => x.factor)) / Math.max(...D.BANKS.map((x) => x.factor))) * 100) + "%",
    };
    return html.replace(/\{\{(\w+)\}\}/g, (m, k) => (t[k] != null ? t[k] : m));
  }

  // ==================== survey storage ====================

  function normaliseSurvey(s) {
    const d = D.DEFAULT_SURVEY;
    if (!s || typeof s !== "object") return JSON.parse(JSON.stringify(d));
    return {
      ...d,
      ...s,
      meals: { ...d.meals, ...(s.meals || {}) },
      commute: { ...d.commute, ...(s.commute || {}) },
      car: { ...d.car, ...(s.car || {}) },
      cars: Array.isArray(s.cars) ? s.cars : [],
      energy: { ...d.energy, ...(s.energy || {}) },
      water: { ...d.water, ...(s.water || {}) },
      pets: { ...d.pets, ...(s.pets || {}) },
      banking: { ...d.banking, ...(s.banking || {}) },
      flights: Array.isArray(s.flights) ? s.flights : [],
      extraTravel: Array.isArray(s.extraTravel) ? s.extraTravel : [],
      longTrips: Array.isArray(s.longTrips) ? s.longTrips : [],
    };
  }

  async function loadSurvey() {
    if (currentUser && sb) {
      try {
        const { data, error } = await sb
          .from("survey_responses")
          .select("survey_data")
          .eq("user_id", currentUser.id)
          .maybeSingle();
        if (!error && data) {
          const s = normaliseSurvey(data.survey_data);
          // Saved before completedAt existed: they've been seeing results.
          if (!s.completedAt) s.completedAt = data.survey_data && data.survey_data.completedAt ? data.survey_data.completedAt : "earlier";
          if (pinFactors(s)) saveSurveyRemote(s);
          lsSet(KEY_SURVEY, s);
          return s;
        }
        // A member with nothing saved yet keeps the answers they gave on
        // this device as a guest, now stored on their account.
        const local = lsGet(KEY_SURVEY, null);
        if (!error && local && canSync()) saveSurveyRemote(normaliseSurvey(local));
      } catch (e) {}
    }
    return localSurvey();
  }
  // The answers kept on this phone.
  function localSurvey() {
    const local = normaliseSurvey(lsGet(KEY_SURVEY, null));
    // Finished before completedAt existed: a monthly snapshot is the tell.
    const snaps = getSnapshots();
    if (!local.completedAt && lsGet(KEY_SURVEY, null) && snaps.length) local.completedAt = snaps[snaps.length - 1].savedAt || "earlier";
    if (pinFactors(local)) lsSet(KEY_SURVEY, local);
    return local;
  }

  // A survey finished before figures were kept with it was worked out with
  // the built-in ones, so it keeps those. Returns true if it changed.
  function pinFactors(s) {
    if (!s.completedAt || s.factors) return false;
    s.factors = { ...BUILT_IN };
    return true;
  }

  async function saveSurveyRemote(s) {
    if (!currentUser || !sb) return;
    const row = { user_id: currentUser.id, survey_data: s, updated_at: new Date().toISOString() };
    try {
      // total_yearly lets friends see your total (friends_footprints()).
      // If the database doesn't have that column yet, save without it.
      const { error } = await sb.from("survey_responses").upsert({ ...row, total_yearly: Math.round(withInputs(factorsFor(s), () => footprint(s).totalYearly)) });
      if (error && /total_yearly/.test(error.message || "")) await sb.from("survey_responses").upsert(row);
    } catch (e) {}
  }

  let saveTimer = null;
  function surveyChanged() {
    // A new survey replaces the saved one only when it's finished.
    if (ui.newSurvey) return;
    lsSet(KEY_SURVEY, survey);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSurveyRemote(survey), 600);
  }

  // ---------- survey history ----------

  async function loadHistory() {
    const local = lsGet(KEY_HISTORY, []);
    if (!canSync() || !sb) {
      ui.history = local;
      return;
    }
    try {
      const { data, error } = await sb
        .from("survey_history")
        .select("completed_at, total_yearly")
        .order("completed_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      // Surveys finished on this device before signing in move to the account.
      if (!data.length && local.length) {
        await sb.from("survey_history").insert(
          local.map((h) => ({ user_id: currentUser.id, survey_data: h.survey || {}, total_yearly: Math.round(h.totalYearly), completed_at: h.completedAt }))
        );
        ui.history = local;
        return;
      }
      ui.history = data.map((h) => ({ completedAt: h.completed_at, totalYearly: Number(h.total_yearly) || 0 }));
    } catch (e) {
      ui.history = local; // table not set up yet, or offline
    }
  }

  async function recordHistory(s) {
    const entry = { completedAt: new Date().toISOString(), totalYearly: Math.round(footprint(s).totalYearly), survey: JSON.parse(JSON.stringify(s)) };
    const local = [entry].concat(lsGet(KEY_HISTORY, [])).slice(0, 50);
    lsSet(KEY_HISTORY, local);
    ui.history = [{ completedAt: entry.completedAt, totalYearly: entry.totalYearly }].concat(ui.history || []);
    if (canSync() && sb) {
      try {
        await sb.from("survey_history").insert({ user_id: currentUser.id, survey_data: entry.survey, total_yearly: entry.totalYearly });
        notifyFriends({ kind: "survey" });
      } catch (e) {}
    }
    if (isNativeApp()) {
      sundaySig = null;
      syncSunday();
    }
  }

  // One entry per day (the latest), newest first.
  function historyByDay() {
    const seen = {};
    return (ui.history || []).filter((h) => {
      const day = (h.completedAt || "").slice(0, 10);
      if (!day || seen[day]) return false;
      seen[day] = true;
      return true;
    });
  }

  async function clearSurvey() {
    lsRemove(KEY_SURVEY);
    if (currentUser && sb) {
      try {
        await sb.from("survey_responses").delete().eq("user_id", currentUser.id);
      } catch (e) {}
    }
  }

  // ==================== monthly snapshots ====================

  function monthKey(date) {
    const d = date || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  function monthLabel(key) {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    });
  }

  const getSnapshots = () => lsGet(KEY_SNAPSHOTS, []);

  // Snapshots saved before the switch to yearly figures hold totalMonthly.
  const snapshotYearly = (s) => (s.totalYearly != null ? s.totalYearly : (s.totalMonthly || 0) * 12);

  function saveSnapshot(totalYearly) {
    const month = monthKey();
    const list = getSnapshots();
    const entry = { month, totalYearly, savedAt: new Date().toISOString() };
    const i = list.findIndex((s) => s.month === month);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    list.sort((a, b) => (a.month < b.month ? -1 : 1));
    lsSet(KEY_SNAPSHOTS, list);
  }

  const KEY_CHECKIN_SNOOZE = "co2_checkin_snooze"; // time the check-in shows again
  function checkInDue() {
    const list = getSnapshots();
    return list.length > 0 && list[list.length - 1].month !== monthKey();
  }

  // ==================== calculations ====================

  function airport(code) {
    return AIRPORT_BY_CODE.get(code);
  }

  function greatCircleKm(a, b) {
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  // Great-circle distance with DESNZ's 8% uplift for real-world routing.
  function flightKm(from, to) {
    const a = airport(from);
    const b = airport(to);
    if (!a || !b) return 0;
    return greatCircleKm(a, b) * D.FLIGHT_DISTANCE_UPLIFT;
  }

  // kg CO2e per km for this route and cabin: domestic, short- or long-haul.
  function flightFactor(from, to, cabin) {
    const a = airport(from);
    const b = airport(to);
    if (!a || !b) return 0;
    if (a.country === "UK" && b.country === "UK") return D.FLIGHT_DOMESTIC_FACTOR;
    const c = byKey(D.CABINS, cabin) || D.CABINS[0];
    return greatCircleKm(a, b) > D.FLIGHT_LONG_HAUL_KM ? c.long : c.short;
  }

  // A pot with no provider picked counts as "other" (the sector average).
  function pensionProvider(b) {
    return byKey(D.PENSION_PROVIDERS, b.pensionProvider) || byKey(D.PENSION_PROVIDERS, "other");
  }

  // kg CO2e per year from a pension pot at a given t CO2e per £1m invested.
  const pensionKg = (pot, tPerMillion) => ((pot || 0) * tPerMillion) / 1000;
  // A ticked "Return trip" counts the distance both ways. Flights saved
  // before the box existed have no flag and stay one-way.
  const legs = (f) => (f.returnTrip ? 2 : 1);
  // `trips` (default 1) lets the UK-average profile model a fractional
  // number of the same trip per year; survey flights never set it.
  const flightKg = (f) => flightKm(f.from, f.to) * flightFactor(f.from, f.to, f.cabin) * legs(f) * (f.trips || 1);
  const routeLabel = (f) => {
    const a = airport(f.from);
    const b = airport(f.to);
    return ((a && a.city) || f.from) + (f.returnTrip ? " ⇄ " : " → ") + ((b && b.city) || f.to);
  };

  function flightTier(s) {
    const flights = s.flights || [];
    let shortHaul = 0;
    let mediumHaul = 0;
    let longHaul = 0;
    flights.forEach((f) => {
      const km = flightKm(f.from, f.to);
      if (km < A.SHORT_HAUL_KM) shortHaul += legs(f);
      else if (km < A.MEDIUM_HAUL_MAX_KM) mediumHaul += legs(f);
      else longHaul += legs(f);
    });
    let tier;
    if (flights.length === 0) tier = 1;
    else if (shortHaul >= 5 || mediumHaul >= 3 || longHaul > 1) tier = 4;
    else if (shortHaul >= 3 || mediumHaul >= 1 || longHaul >= 1) tier = 3;
    else tier = 2;
    return { tier, total: flights.length };
  }

  function flightTotals(s) {
    const items = (s.flights || []).map((f) => {
      const co2 = flightKg(f);
      return {
        label: routeLabel(f),
        co2,
        pctOfTarget: (co2 / D.BUDGET_YEARLY) * 100,
      };
    });
    const total = items.reduce((sum, i) => sum + i.co2, 0);
    return { items, total, pctOfTarget: (total / D.BUDGET_YEARLY) * 100 };
  }

  // Every category is returned as kg CO2e per year. The survey asks for
  // weekly habits and monthly bills, so those are scaled up here.
  // Extra bank accounts and pension pots, on top of the main ones.
  const moneyExtras = (b) => (Array.isArray(b && b.extra) ? b.extra : []).filter((x) => x && (x.amount || 0) > 0);
  const extraPension = (x) => byKey(D.PENSION_PROVIDERS, x.provider) || byKey(D.PENSION_PROVIDERS, "other");
  const extrasKg = (b) =>
    moneyExtras(b).reduce((t, x) => t + (x.kind === "pension" ? pensionKg(x.amount, extraPension(x).tPerMillion) : x.amount * factorOf(D.BANKS, x.bank)), 0);
  function extrasSaving(b) {
    const greenest = Math.min(...D.BANKS.map((x) => x.factor));
    return moneyExtras(b).reduce((t, x) => {
      if (x.kind === "pension") return t + Math.max(0, pensionKg(x.amount, extraPension(x).tPerMillion - D.GREEN_PENSION_T_PER_MILLION));
      const bank = byKey(D.BANKS, x.bank);
      return t + (bank && bank.factor > greenest ? x.amount * (bank.factor - greenest) : 0);
    }, 0);
  }

  // Every pet, by kind: dogs and cats (food is most of it), horses and small pets.
  const petsKg = (p) => (p.dogs || 0) * D.DOG_YEARLY + (p.cats || 0) * D.CAT_YEARLY + (p.horses || 0) * D.HORSE_YEARLY + (p.smallPets || 0) * D.SMALL_PET_YEARLY;
  const petCount = (p) => (p.dogs || 0) + (p.cats || 0) + (p.horses || 0) + (p.smallPets || 0);
  const petWords = (p) =>
    [p.dogs ? plural(Math.round(p.dogs), "dog") : "", p.cats ? plural(Math.round(p.cats), "cat") : "", p.horses ? plural(Math.round(p.horses), "horse") : "", p.smallPets ? plural(Math.round(p.smallPets), "small pet") : ""]
      .filter(Boolean).join(", ") || "No pets";

  function footprint(s) {
    const items = [];
    const household = Math.max(1, (s.energy && s.energy.household) || 1);
    const meals = s.meals || {};

    // meals.weekMix ({ mealKey: days per week }) allows fractional days; it's
    // only used for the typical UK resident, whose week comes from averages.
    const mealBase = meals.weekMix
      ? Object.keys(meals.weekMix).reduce((sum, k) => sum + factorOf(D.MEAL_OPTIONS, k) * meals.weekMix[k], 0)
      : DAYS.reduce((sum, day) => sum + factorOf(D.MEAL_OPTIONS, meals[day]), 0);
    const eatOut = Math.min(7, Math.max(0, meals.eatOut || 0));
    const eatOutMult = (7 + (D.EAT_OUT_MULTIPLIER - 1) * eatOut) / 7;
    const waste = byKey(D.FOOD_WASTE, meals.foodWaste || "low");
    const mealsWeekly = mealBase * eatOutMult * (waste ? waste.multiplier : 1);
    const mealNotes = [
      eatOut > 0 ? "eat out " + eatOut + "×/wk" : null,
      waste && waste.key !== "low" ? waste.title.toLowerCase() + " wasted" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    items.push({
      key: "meals",
      label: "Meals & Diet",
      icon: "🍽️",
      yearly: mealsWeekly * D.WEEKS_PER_YEAR,
      detail: "~" + mealsWeekly.toFixed(1) + " kg CO₂e per week" + (mealNotes ? " · " + mealNotes : ""),
    });

    const commute = s.commute || {};
    const commuteWeekly = DAYS.reduce(
      (sum, day) => sum + factorOf(D.COMMUTE_MODES, commute[day]) * (commute.distance || 0) * 2,
      0
    );
    const car = carYearly(s);
    const otherYearly = extraTravelYearly(s) + longTripsYearly(s) + car.other;
    items.push({
      key: "commute",
      label: "Commute & Travel",
      icon: "🚗",
      yearly: commuteWeekly * D.WEEKS_PER_YEAR + otherYearly + car.make,
      detail: "~" + commuteWeekly.toFixed(1) + " kg CO₂e per week commuting" + (otherYearly > 0 ? " · " + Math.round(otherYearly) + " kg other travel" : "") +
        (car.make > 0 ? " · " + Math.round(car.make) + " kg making your car" : ""),
    });

    const flights = s.flights || [];
    items.push({
      key: "flights",
      label: "Flights",
      icon: "✈️",
      yearly: flights.reduce((sum, f) => sum + flightKg(f), 0),
      detail: flights.length + (flights.length === 1 ? " trip" : " trips") + " / year",
    });

    const energy = s.energy || {};
    const elecFactor = energy.greenTariff ? D.GREEN_ELECTRICITY_FACTOR : D.ELECTRICITY_FACTOR;
    items.push({
      key: "energy",
      label: "Home Energy",
      icon: "⚡",
      yearly: (12 * ((energy.electricityKwh || 0) * elecFactor + (energy.gasKwh || 0) * D.GAS_FACTOR)) / household,
      detail: energy.greenTariff
        ? "Green tariff · split across household"
        : "Standard electricity + gas · split across household",
    });

    const liters = (s.water && s.water.liters) || 0;
    items.push({
      key: "water",
      label: "Water",
      icon: "💧",
      yearly: (12 * (liters / 1000) * D.WATER_FACTOR) / household,
      detail: (liters / household).toFixed(0) + " L per person / month",
    });

    const pets = s.pets || {};
    items.push({
      key: "pets",
      label: "Pets",
      icon: "🐾",
      yearly: petsKg(pets) / household,
      detail: petCount(pets) + " pet(s)",
    });

    const banking = s.banking || {};
    const bank = byKey(D.BANKS, banking.bank);
    const pension = pensionProvider(banking);
    const pot = banking.pensionPot || 0;
    items.push({
      key: "banking",
      label: "Banking & Pension",
      icon: "🏦",
      yearly: (banking.amount || 0) * factorOf(D.BANKS, banking.bank) + pensionKg(pot, pension.tPerMillion) + extrasKg(banking),
      detail: [bank ? bank.label : "", pot > 0 ? "pension: " + pension.label : ""].filter(Boolean).join(" · "),
    });

    const totalYearly = items.reduce((sum, i) => sum + i.yearly, 0);
    items.sort((a, b) => b.yearly - a.yearly);
    return { totalYearly, breakdown: items, biggest: items[0] };
  }

  // Classifies the week of meals so the Meals tip and explainer can be
  // tailored to the person's actual diet.
  // Days a week of each main meal: from the day-by-day answers, or the
  // fractional weekMix used for the typical UK resident.
  function mealCounts(s) {
    const m = s.meals || {};
    const out = {};
    if (m.weekMix) Object.keys(m.weekMix).forEach((k) => (out[k] = m.weekMix[k]));
    else DAYS.forEach((d) => m[d] && (out[m[d]] = (out[m[d]] || 0) + 1));
    return out;
  }

  // Whole days a week of each main meal (the survey stores them by weekday).
  function mealDayCounts(s) {
    const c = mealCounts(s);
    const out = {};
    Object.keys(c).forEach((k) => (out[k] = Math.round(c[k])));
    return out;
  }
  // Writes counts back as weekdays, so everything else reads them unchanged.
  function mealsFromCounts(meals, counts) {
    const out = { ...meals };
    delete out.weekMix;
    DAYS.forEach((d) => delete out[d]);
    let i = 0;
    D.MEAL_OPTIONS.forEach((o) => {
      for (let k = 0; k < (counts[o.key] || 0) && i < DAYS.length; k++) out[DAYS[i++]] = o.key;
    });
    return out;
  }

  function dietType(s) {
    const c = mealCounts(s);
    const days = Object.values(c).reduce((t, v) => t + v, 0);
    if (days === 0) return "other_meat";
    const count = (keys) => keys.reduce((t, k) => t + (c[k] || 0), 0);
    const red = count(["beef", "lamb", "pork"]);
    const chicken = count(["chicken"]);
    const fish = count(["fish"]);
    const veggie = count(["veggie"]);
    if (count(["vegan"]) === days) return "vegan";
    if (red === 0 && fish === 0 && veggie > 0) return "veggie";
    if (red === 0 && chicken === 0 && fish > 0) return "pescatarian";
    if (red > 2) return "red_meat_high";
    if (red >= 1) return "red_meat_low";
    return "other_meat";
  }

  function mealsTip(s) {
    const c = mealCounts(s);
    const count = (keys) => keys.reduce((t, k) => t + (c[k] || 0), 0);
    const chicken = count(["chicken"]);
    const fish = count(["fish"]);
    const veggie = count(["veggie"]);
    const veganKg = factorOf(D.MEAL_OPTIONS, "vegan");
    const veggieKg = factorOf(D.MEAL_OPTIONS, "veggie");
    const chickenKg = factorOf(D.MEAL_OPTIONS, "chicken");
    const fishKg = factorOf(D.MEAL_OPTIONS, "fish");
    const W = D.WEEKS_PER_YEAR;
    switch (dietType(s)) {
      case "red_meat_high":
        return {
          title: "Cut back on red meat (>2×/week)",
          body:
            "Beef and lamb are the most carbon-intensive foods by far: a beef day emits {{beef_vs_chicken}} a chicken day and {{beef_vs_vegan}} a vegan day. With red meat on more than two days a week, this is your biggest food lever. Swapping your red-meat days for chicken would save about " +
            kgFmt(redMeatSaving(s)) + " kg CO₂e a year.",
          saving: redMeatSaving(s),
        };
      case "red_meat_low":
        return {
          title: "Trim your red-meat days (1–2×/week)",
          body: "You're already keeping red meat to a couple of days — great. Beef and lamb are still your highest-impact meals, though. Replacing one more red-meat day a week with chicken or a plant-based option keeps cutting your footprint meaningfully.",
          saving: redMeatSaving(s),
        };
      case "other_meat": {
        const saving = Math.max(0, (chicken + fish) * ((chickenKg + fishKg) / 2 - veganKg) * W);
        return {
          title: "Lean into more plant-based days",
          body:
            "You're avoiding red meat — a strong start. Chicken and fish still carry a higher footprint than plant-based meals, though. Swapping " +
            (chicken + fish) +
            " of your chicken/fish day(s) a week for a vegan meal could save ~" +
            saving.toFixed(0) +
            " kg CO₂e a year.",
          saving,
        };
      }
      case "pescatarian": {
        const saving = Math.max(0, fish * (fishKg - veganKg) * W);
        return {
          title: "Add more plant-based days",
          body:
            "A pescatarian diet is already relatively low-impact. Fish still beats plants, though — swapping " +
            fish +
            " fish day(s) a week for a vegan meal could save ~" +
            saving.toFixed(0) +
            " kg CO₂e a year.",
          saving,
        };
      }
      case "veggie":
        return {
          title: "Watch the dairy & cheese",
          body: "With meat and fish off the menu, cheese and dairy are now your biggest food-emission driver. Hard cheeses like cheddar and mozzarella are especially intensive. Swapping one cheese-heavy meal a day for a plant-based version — oat milk, nutritional yeast or vegan cheese — can trim your food footprint further.",
          saving: Math.max(0, veggie * (veggieKg - veganKg) * W),
        };
      case "vegan":
        return {
          title: "Your diet is already low-impact 🌱",
          body: "A vegan diet has the lowest food footprint of any eating pattern. Your biggest remaining gains in food are reducing waste and choosing locally-grown, in-season produce. Otherwise, look to the other categories below — that's where your largest opportunities likely are.",
          saving: 0,
        };
      default:
        return {
          title: "Rethink a few meals a week",
          body: "Small swaps — one or two plant-based days a week — can noticeably lower your food footprint without changing your whole diet.",
          saving: redMeatSaving(s),
        };
    }
  }

  // Saving from swapping every beef/lamb day for chicken.
  function redMeatSaving(s) {
    const beef = factorOf(D.MEAL_OPTIONS, "beef");
    const lamb = factorOf(D.MEAL_OPTIONS, "lamb");
    const chicken = factorOf(D.MEAL_OPTIONS, "chicken");
    const c = mealCounts(s);
    return ((c.beef || 0) * (beef - chicken) + (c.lamb || 0) * (lamb - chicken)) * D.WEEKS_PER_YEAR;
  }

  function householdOf(s) {
    return Math.max(1, (s.energy && s.energy.household) || 1);
  }

  function tipFor(key, s) {
    const tips = {
      meals: () => mealsTip(s),
      // Realistic: each car/motorbike day becomes walking or cycling for
      // trips up to 10 km, or train/bus for longer ones. Maximum: no commuting
      // emissions at all (working from home, or active travel).
      commute: () => {
        const c = s.commute || {};
        const distance = c.distance || 0;
        const long = distance > A.ACTIVE_TRAVEL_MAX_KM;
        const replacement = long ? publicTransportFactor() : 0;
        const perDay = (mode) => Math.max(0, factorOf(D.COMMUTE_MODES, mode) - replacement) * distance * 2;
        // Long journeys by car: the realistic swap is the train.
        const trainF = travelFactor("train");
        const carTrips = (s.longTrips || []).filter((x) => MOTOR_MODES.includes(x.mode));
        const tripSaving = carTrips.reduce((t, x) => t + Math.max(0, longTripKg(x) - trainF * (Number(x.km) || 0) * (x.returnTrip ? 2 : 1)), 0);
        const saving =
          DAYS.filter((d) => MOTOR_MODES.includes(c[d])).reduce((sum, d) => sum + perDay(c[d]), 0) * D.WEEKS_PER_YEAR + tripSaving;
        return {
          title: "Rethink your daily commute",
          body: long
            ? "Driving is one of the largest personal emission sources. For a commute of more than {{active_km}} km, taking the train or bus instead of the car on your driving days cuts most of it — and working from home or cycling some days takes it to zero."
            : "Driving is one of the largest personal emission sources. For a commute of {{active_km}} km or less, walking or cycling instead of driving removes those emissions completely — an e-bike makes longer or hillier trips easy.",
          saving,
          maxSaving: categoryYearly("commute", s),
          realisticLabel: (long ? "train or bus on driving days" : "walking or cycling on driving days") + (tripSaving > 0 ? ", and the train for long journeys you drive" : ""),
          maxLabel: "no travel emissions, by working from home, walking and cycling, and holidaying closer to home" + (ownedCars(s).length ? ", without a car" : ""),
        };
      },
      // Flying is optional, so the potential saving is all of it: what you'd
      // save by holidaying by train or closer to home instead.
      // Realistic (keeps some flying, swaps the rest):
      //  - more than one long-haul flight -> one long-haul flight in economy
      //  - exactly one long-haul flight   -> one short-haul flight in economy
      //  - three or more short-haul       -> one short-haul in economy, the rest by train
      //  - one or two short-haul          -> all by train
      // Long-haul and short-haul are handled separately. Maximum: not flying.
      flights: () => {
        const flights = s.flights || [];
        const total = flights.reduce((sum, f) => sum + flightKg(f), 0);
        const economyKg = (f) => flightKm(f.from, f.to) * flightFactor(f.from, f.to, "economy") * legs(f);
        const avg = (list, fn) => (list.length ? list.reduce((t, f) => t + fn(f), 0) / list.length : 0);
        // Long-haul: beyond medium-haul. Medium: too far for the train, so kept
        // in economy. Short: close enough to go by train.
        const long = flights.filter((f) => flightKm(f.from, f.to) > A.MEDIUM_HAUL_MAX_KM);
        const medium = flights.filter((f) => {
          const km = flightKm(f.from, f.to);
          return km > A.TRAIN_SWAP_MAX_KM && km <= A.MEDIUM_HAUL_MAX_KM;
        });
        const short = flights.filter((f) => {
          const km = flightKm(f.from, f.to);
          return km > 0 && km <= A.TRAIN_SWAP_MAX_KM;
        });
        const typicalShortKg =
          medium.length || short.length ? avg(medium.concat(short), economyKg) : flightKm("LHR", "BCN") * flightFactor("LHR", "BCN", "economy") * (long.length === 1 ? legs(long[0]) : 1);
        let remaining = 0;
        const parts = [];
        if (long.length > 1) {
          remaining += avg(long, economyKg);
          parts.push("one long-haul trip in economy");
        } else if (long.length === 1) {
          remaining += typicalShortKg;
          parts.push("a short-haul trip in economy instead of long-haul");
        }
        if (medium.length) {
          remaining += medium.reduce((t, f) => t + economyKg(f), 0);
          parts.push("medium-haul trips in economy");
        }
        if (short.length >= 3) {
          remaining += avg(short, economyKg) + (short.length - 1) * avg(short, economyKg) * trainToFlightRatio();
          parts.push("one short-haul trip in economy, the rest by train");
        } else if (short.length > 0) {
          remaining += short.length * avg(short, economyKg) * trainToFlightRatio();
          parts.push("short trips by train");
        }
        return {
          realisticLabel: parts.join(", ") || "no change needed",
          maxLabel: "not flying",
          maxSaving: total,
          saving: Math.max(0, total - remaining),
          title: "Cut back on flying",
          body: "Flights are often the single largest chunk of a personal footprint. A single long-haul return can emit more than a year of driving. Every flight you swap for a train, a closer destination or a video call removes its emissions entirely — and if you can't avoid flying, economy and direct routes keep it lower.",
        };
      },
      // Realistic: green electricity tariff. Maximum: green tariff plus a heat
      // pump replacing gas (about a third of the energy, as electricity).
      energy: () => ({
        realisticLabel: "a green electricity tariff",
        maxLabel: "a green tariff and a heat pump instead of gas",
        maxSaving: (() => {
          const e = s.energy || {};
          const after = (12 * ((e.electricityKwh || 0) + (e.gasKwh || 0) / A.HEAT_PUMP_COP) * D.GREEN_ELECTRICITY_FACTOR) / householdOf(s);
          return Math.max(0, categoryYearly("energy", s) - after);
        })(),
        title: "Switch to a green energy tariff",
        body: "Grid electricity emits about {{grid_kwh}} kg CO₂e per kWh. A green/renewable tariff can cut that by {{green_cut}}, instantly lowering one of your biggest contributors.",
        saving:
          s.energy && s.energy.greenTariff
            ? 0
            : (12 * ((s.energy && s.energy.electricityKwh) || 0) * (D.ELECTRICITY_FACTOR - D.GREEN_ELECTRICITY_FACTOR)) /
              householdOf(s),
      }),
      water: () => ({
        title: "Reduce your water usage",
        body: "Heating and treating water uses energy. Shorter showers, fixing leaks, and water-efficient fixtures can cut your water footprint meaningfully over a year.",
        saving: (12 * (((s.water && s.water.liters) || 0) / 1000) * D.WATER_FACTOR * A.WATER_CUT) / householdOf(s),
        maxSaving: (12 * (((s.water && s.water.liters) || 0) / 1000) * D.WATER_FACTOR * A.WATER_CUT_MAX) / householdOf(s),
        realisticLabel: "using " + ({ 0.5: "half", 0.25: "a quarter", 0.2: "a fifth", 0.1: "a tenth" }[A.WATER_CUT] || Math.round(A.WATER_CUT * 100) + "%") + " less water",
        maxLabel: "using " + Math.round(A.WATER_CUT_MAX * 100) + "% less, with efficient fittings and short showers",
      }),
      pets: () => {
        const p = s.pets || {};
        return {
          title: "Consider your pets' diet",
          body: "A medium dog's food can emit as much as a small car over a year. Choosing lower-meat or sustainable pet food brands can reduce their footprint without compromising nutrition.",
          saving:
            (((p.dogs || 0) * D.DOG_YEARLY + (p.cats || 0) * D.CAT_YEARLY) * A.PET_FOOD_CUT) / householdOf(s),
          maxSaving:
            (((p.dogs || 0) * D.DOG_YEARLY + (p.cats || 0) * D.CAT_YEARLY) * A.PET_FOOD_CUT_MAX) / householdOf(s),
          realisticLabel: "lower-impact pet food",
          maxLabel: "by-product or alternative-protein pet food",
        };
      },
      banking: () => {
        const b = s.banking || {};
        const bank = byKey(D.BANKS, b.bank);
        const greenest = Math.min(...D.BANKS.map((x) => x.factor));
        const bankSaving = !bank || bank.factor <= greenest ? 0 : (b.amount || 0) * (bank.factor - greenest);
        const pension = pensionProvider(b);
        // Extra accounts and pots count towards whichever saving they are.
        const xBank = moneyExtras(b).filter((x) => x.kind !== "pension");
        const xPension = moneyExtras(b).filter((x) => x.kind === "pension");
        const pensionSaving = Math.max(0, pensionKg(b.pensionPot, pension.tPerMillion - D.GREEN_PENSION_T_PER_MILLION)) + extrasSaving({ extra: xPension });
        const bankSavingAll = bankSaving + extrasSaving({ extra: xBank });
        // Already with a very good bank: say so, and how much further the greenest goes.
        const greenestBank = D.BANKS.slice().sort((x, y) => x.factor - y.factor)[0];
        const bankDone = bank && bankRating(bank).key === "vgood";
        const bankBody = bankDone
          ? "You're already with " + bank.label.replace(/^The /, "") + ", one of the greenest banks." +
            (bankSaving > 0.5 ? " You could go a bit further: moving to " + greenestBank.label.replace(/^The /, "") + " would cut about " + kgFmt(bankSaving) + " kg a year more." : " There's no greener bank on our list.")
          : "Traditional banks finance fossil fuel projects with your deposits. Moving your savings to a bank that doesn't fund fossil fuels (e.g. Triodos, Co-op) can reduce your financed emissions by up to {{bank_cut}}.";
        if (pensionSaving > bankSavingAll) {
          return {
            title: "Switch your pension to a climate-focused fund",
            body:
              "Your pension is invested in companies, and its share of their emissions counts towards your footprint. Most providers offer an ethical or climate-focused fund alongside the default — Nest's Ethical Fund, for example, is around " +
              D.GREEN_PENSION_T_PER_MILLION +
              " t CO₂e per £1m invested against " +
              pension.tPerMillion +
              " t for " +
              (b.pensionProvider && b.pensionProvider !== "other" ? pension.label + "'s default" : "a typical default fund") +
              ". Ask your provider or HR how to switch; it usually takes a few minutes online." +
              (bankSaving > 0 ? " " + bankBody : ""),
            saving: bankSavingAll + pensionSaving,
            realisticLabel: "a greener bank and a climate-focused pension fund",
          };
        }
        return {
          realisticLabel: "a greener bank and a climate-focused pension fund",
          title: bankDone ? (bankSaving > 0.5 ? "You've switched bank. Go a bit further?" : "You're with the greenest bank") : "Move your money to a greener bank",
          body: bankBody + (pensionSaving > 0 ? " Switching your pension to a climate-focused fund helps too." : ""),
          saving: bankSavingAll + pensionSaving,
        };
      },
    };
    const tip = (tips[key] || tips.meals)();
    if (key === "meals" || !tips[key]) {
      // Maximum for food: a fully plant-based week with little waste.
      const vegan = { ...s, meals: { ...(s.meals || {}), weekMix: { vegan: 7 }, foodWaste: "low" } };
      tip.maxSaving = Math.max(0, categoryYearly("meals", s) - categoryYearly("meals", vegan));
      tip.realisticLabel = "swapping your highest-impact meals";
      tip.maxLabel = "a fully plant-based diet with little waste";
    }
    const total = categoryYearly(key, s);
    tip.saving = Math.min(Math.max(0, tip.saving || 0), total);
    tip.maxSaving = Math.min(Math.max(tip.saving, tip.maxSaving || 0), total);
    return tip;
  }

  // Train or bus: the average of the two modes' factors.
  function publicTransportFactor() {
    return (factorOf(D.COMMUTE_MODES, "train") + factorOf(D.COMMUTE_MODES, "bus")) / 2;
  }

  // Travel outside the commute: regular weekly trips (km a week) and long
  // journeys (km one way, doubled for a return).
  const travelFactor = (mode) => factorOf(D.TRAVEL_MODES, mode);
  const extraTravelYearly = (s) => (s.extraTravel || []).reduce((t, x) => t + travelFactor(x.mode) * (Number(x.km) || 0), 0) * D.WEEKS_PER_YEAR;
  const longTripKg = (x) => travelFactor(x.mode) * (Number(x.km) || 0) * (x.returnTrip ? 2 : 1);
  const longTripsYearly = (s) => (s.longTrips || []).reduce((t, x) => t + longTripKg(x), 0);

  // Cars someone owns: making the car is spread over its life and split
  // between the people who share it. Mileage, when given, tops up driving
  // the commute and trips don't already cover, so nothing counts twice.
  const CAR_MODES = ["car_petrol", "car_diesel", "ev"];
  const ownedCars = (s) => (s.car && s.car.owns === "yes" ? s.cars || [] : []);
  const carType = (c) => byKey(D.CAR_TYPES, c.fuel) || D.CAR_TYPES[0];
  const carSize = (c) => (["small", "medium", "large"].includes(c.size) ? c.size : "medium");
  const carMakeYearly = (c) => carType(c)["make_" + carSize(c)] / Math.max(1, A.CAR_LIFE_YEARS) / Math.max(1, Number(c.share) || 1);
  const carDriveFactor = (c) => carType(c)["drive_" + carSize(c)];
  const carMilesKm = (c) => Math.max(0, Number(c.miles) || 0) * D.KM_PER_MILE;
  function tripCarKm(s) {
    const c = s.commute || {};
    const commute = DAYS.filter((d) => CAR_MODES.includes(c[d])).length * (c.distance || 0) * 2 * D.WEEKS_PER_YEAR;
    const extra = (s.extraTravel || []).filter((x) => CAR_MODES.includes(x.mode)).reduce((t, x) => t + (Number(x.km) || 0), 0) * D.WEEKS_PER_YEAR;
    const long = (s.longTrips || []).filter((x) => CAR_MODES.includes(x.mode)).reduce((t, x) => t + (Number(x.km) || 0) * (x.returnTrip ? 2 : 1), 0);
    return commute + extra + long;
  }
  function carYearly(s) {
    const cars = ownedCars(s);
    const make = cars.reduce((t, c) => t + carMakeYearly(c), 0);
    const mileKm = cars.reduce((t, c) => t + carMilesKm(c), 0);
    const tripKm = tripCarKm(s);
    const otherKm = Math.max(0, mileKm - tripKm);
    // The extra driving uses each car's own factor, in proportion to its miles.
    const other = mileKm > 0 ? (cars.reduce((t, c) => t + carMilesKm(c) * carDriveFactor(c), 0) * otherKm) / mileKm : 0;
    return { make, other, mileKm, tripKm, otherKm };
  }

  function categoryYearly(key, s) {
    const item = footprint(s).breakdown.find((b) => b.key === key);
    return item ? item.yearly : 0;
  }

  // Like-for-like comparison with a typical UK resident: both sides cover
  // only the categories in D.UK_COMPARISON_KEYS (banking/pension excluded).
  function ukComparison(fp) {
    const sumKeys = (f) => f.breakdown.filter((b) => D.UK_COMPARISON_KEYS.includes(b.key)).reduce((t, b) => t + b.yearly, 0);
    const mine = sumKeys(fp);
    const uk = sumKeys(footprint(D.UK_TYPICAL_SURVEY));
    const diff = mine - uk;
    return { mine, uk, above: diff > 0, pct: Math.abs(Math.round((diff / uk) * 100)) };
  }

  // ---------- Picture it: your footprint as lettuces, axolotls, Danny DeVitos ----------
  // Now and after the big switches in Real Zero's 7 Acts. Weights become a
  // field of dots or a grid of drawings; heights a stack of figures as tall
  // as your CO2 would be as a cube of gas; giants "years of you" stripes.
  const piItems = () => D.FUN_COMPARISONS.items;
  const KEY_MASCOT = "co2_mascot";
  const piMascot = () => {
    const k = lsGet(KEY_MASCOT, "");
    return piItems().some((x) => x.key === k) ? k : "";
  };
  const piIndex = () => {
    const n = piItems().length;
    if (ui.piIdx == null) ui.piIdx = Math.max(0, piItems().findIndex((x) => x.key === piMascot()));
    return ((ui.piIdx % n) + n) % n;
  };
  // 15,600 · 140 · 11 · 3½
  function funNum(n) {
    if (n >= 1000) return (Math.round(n / 100) * 100).toLocaleString("en-GB");
    if (n >= 100) return String(Math.round(n / 10) * 10);
    if (n >= 10) return String(Math.round(n));
    const half = Math.round(n * 2) / 2;
    return String(Math.floor(half)) + (half % 1 ? "½" : "");
  }
  const cubeSide = (kg) => Math.cbrt(Math.max(0, kg) / D.FUN_COMPARISONS.co2Density);
  const howMany = (n, item) => funNum(n) + " " + (funNum(n) === "1" ? item.one : item.many);
  // The clay look: soft highlight from the top left and a shaded lower edge.
  const PI_DEFS =
    '<filter id="pi-clay" x="-8%" y="-8%" width="116%" height="124%" color-interpolation-filters="sRGB">' +
    '<feGaussianBlur in="SourceAlpha" stdDeviation="1.1" result="blur"/>' +
    '<feSpecularLighting in="blur" surfaceScale="2.4" specularConstant=".7" specularExponent="14" lighting-color="#FFFFFF" result="spec"><fePointLight x="6" y="-14" z="26"/></feSpecularLighting>' +
    '<feComposite in="spec" in2="SourceAlpha" operator="in" result="hi"/><feOffset in="SourceAlpha" dx="0" dy="-1.4" result="up"/>' +
    '<feComposite in="SourceAlpha" in2="up" operator="out" result="edge"/><feGaussianBlur in="edge" stdDeviation=".5" result="edgeSoft"/>' +
    '<feFlood flood-color="#000000" flood-opacity=".26"/><feComposite in2="edgeSoft" operator="in" result="shade"/>' +
    '<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="shade"/><feMergeNode in="hi"/></feMerge></filter>' +
    // A vector sheen for sharp icons: light from the top left, a soft shade low down.
    '<linearGradient id="pi-sheen" x1="0" y1="0" x2=".55" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".42" stop-color="#fff" stop-opacity="0"/><stop offset=".72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></linearGradient>' +
    '<filter id="pi-grey" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter>';
  const piDefsSvg = () => '<svg class="pi-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>' + PI_DEFS + "</defs></svg>";
  // One drawing, in a 48 x 48 box.
  // crisp: no blur filter (iPhones draw filters at low resolution), a
  // vector sheen on each shape instead, so icons stay sharp at any size.
  function piArt(key, shadow, crisp) {
    const parts = (D.FUN_COMPARISONS.art[key] || [])
      .map((p) => '<path d="' + p[0] + '" fill="' + p[1] + '" stroke="' + p[2] + '" stroke-width="' + p[3] + '" stroke-linecap="round" stroke-linejoin="round"/>' +
        (crisp && p[1] && p[1] !== "none" ? '<path d="' + p[0] + '" fill="url(#pi-sheen)" stroke="none"/>' : ""))
      .join("");
    return (shadow ? '<path d="M24 46.4m-15 0a15 2.1 0 1 0 30 0a15 2.1 0 1 0 -30 0" fill="rgba(46,42,34,.14)"/>' : "") + (crisp ? "<g>" + parts + "</g>" : '<g filter="url(#pi-clay)">' + parts + "</g>");
  }
  const piIcon = (key, size) => '<svg class="pi-ic" viewBox="0 0 48 48" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">' + piArt(key, true, true) + "</svg>";
  const f1 = (v) => (Math.round(v * 10) / 10).toString();

  // The picture for one comparison, as a single SVG W x H (it scales to fit).
  // o: { w, h, big, minPitch, minCell, maxCell, maxPitch, uid }
  function piModel(it, now, after, o) {
    const W = o.w, H = o.h, big = !!o.big, uid = o.uid || "p";
    const base = { it, uid, W, H, big };
    const fs = (a, b) => (big ? a : b);
    if (it.type === "h") {
      // Stacks of the real thing, on each other's shoulders, as tall as the
      // cube of gas now and after.
      const sNow = cubeSide(now), sAft = cubeSide(after);
      const nNow = sNow / it.size, nAft = sAft / it.size;
      const ground = H - fs(34, 22), top = fs(46, 26);
      const uNow = Math.max(1, Math.round(nNow * 2)), uAft = Math.round(nAft * 2);
      const fh = Math.min((ground - top) / (Math.max(uNow, nNow * 2) / 2), (W - 120) / 2);
      const k = fh / it.size;
      const colW = fh, gap = Math.max(30, colW * 0.45), cutGap = Math.max(colW / 2 + 6, fs(74, 34));
      const groupW = 44 + colW * 1.5 + gap + cutGap + fs(40, 22);
      const x0 = Math.max(0, (W - groupW) / 2);
      const rx = x0 + 28, xNow = x0 + 44, xAft = xNow + colW + gap;
      const slots = (x, n, solid) => {
        let s = "";
        for (let j = 0; j < n; j++)
          s += '<svg x="' + f1(x) + '" y="' + f1(ground - (j + 1) * fh / 2) + '" width="' + f1(colW) + '" height="' + f1(fh / 2) + '" viewBox="' + (j % 2 === 0 ? "0 24 48 24" : "0 0 48 24") +
            '" preserveAspectRatio="xMidYMid meet" overflow="hidden"' + (j < solid ? "" : ' opacity=".2"') + ">" + piArt(it.key, false, true) + "</svg>";
        return s;
      };
      const step = sNow * k > 260 ? 1 : 2;
      let ruler = '<line x1="' + f1(Math.max(6, x0 - 10)) + '" y1="' + ground + '" x2="' + f1(Math.min(W, x0 + groupW + 10)) + '" y2="' + ground + '" stroke="rgba(46,42,34,.3)" stroke-width="1.5"/>' +
        '<line x1="' + f1(rx) + '" y1="' + ground + '" x2="' + f1(rx) + '" y2="' + f1(ground - Math.floor(sNow) * k) + '" stroke="rgba(46,42,34,.3)" stroke-width="1.5"/>';
      for (let m = 0; m <= Math.floor(sNow); m += step) {
        const y = ground - m * k;
        ruler += '<line x1="' + f1(rx - 4) + '" y1="' + f1(y) + '" x2="' + f1(rx + 4) + '" y2="' + f1(y) + '" stroke="rgba(46,42,34,.3)" stroke-width="1.5"/>' +
          '<text x="' + f1(rx - 7) + '" y="' + f1(y + 3) + '" text-anchor="end" font-size="' + fs(18, 9) + '" fill="#5E574B">' + (m ? m + " m" : "0") + "</text>";
      }
      const topNow = ground - uNow * fh / 2, topAft = ground - uAft * fh / 2;
      const label = (x, y, text, col, size, weight, anchor) => '<text x="' + f1(x) + '" y="' + f1(y) + '" text-anchor="' + (anchor || "middle") + '" font-size="' + size + '" font-weight="' + (weight || 800) + '" fill="' + col + '">' + text + "</text>";
      const svg =
        ruler + slots(xNow, uNow, uNow) + slots(xAft, uNow, uAft) +
        label(xNow + colW / 2, topNow - 6, sNow.toFixed(1) + " m", "#9A5130", fs(30, 13)) +
        label(xAft + colW / 2, topAft - 6, sAft.toFixed(1) + " m", "#3F5B3A", fs(30, 13)) +
        label(xAft + colW / 2 + cutGap, topNow + fs(20, 10), "cut", "#9A5130", fs(22, 10), 700, "start") +
        label(xNow + colW / 2, ground + fs(28, 16), "NOW", "#2E2A22", fs(22, 10)) +
        label(xAft + colW / 2, ground + fs(28, 16), "AFTER", "#2E2A22", fs(22, 10));
      return { ...base, mode: "tower", svg,
        headline: funNum(nNow) + " → " + funNum(nAft), unitWord: it.many + " tall", title: "In " + it.many + ", stacked up",
        caption: "As gas, your CO₂ would fill a cube " + sNow.toFixed(1) + " m tall: " + howMany(nNow, it) + " standing on each other's shoulders. After the 7 Acts, " + funNum(nAft) + "." };
    }
    const nNow = now / it.size, nAft = after / it.size;
    if (nNow < 1) {
      // Bigger than a whole footprint: years of you to weigh one, a stripe a year.
      const yNow = Math.max(1, Math.round(it.size / Math.max(now, 1))), yAft = Math.max(1, Math.round(it.size / Math.max(after, 1)));
      const gs = Math.floor(Math.min((W - 24) / 2, H - fs(90, 46)));
      const gap = fs(28, 10), x1 = (W - gs * 2 - gap) / 2;
      const giant = (x, years, col, label, labelCol, n) => {
        const stripes = Array.from({ length: years }, (_, i) =>
          '<rect x="' + (11.6 + i * 33.4 / years).toFixed(2) + '" y="18" width="' + Math.max(0.3, 33.4 / years - 0.5).toFixed(2) + '" height="20" fill="' + (i === 0 ? col : "rgba(255,255,255,.5)") + '" opacity=".85"/>').join("");
        return '<svg x="' + f1(x) + '" y="0" width="' + gs + '" height="' + gs + '" viewBox="0 0 48 48" overflow="visible"><defs><clipPath id="pi-cl-' + uid + n + '"><path d="' + (D.FUN_COMPARISONS.body[it.key] || "") + '"/></clipPath></defs>' +
          piArt(it.key, true, true) + '<g clip-path="url(#pi-cl-' + uid + n + ')">' + stripes + "</g></svg>" +
          '<text x="' + f1(x) + '" y="' + f1(gs + fs(40, 18)) + '" font-size="' + fs(40, 15) + '" font-weight="800" fill="' + labelCol + '">' + years + " years of you</text>" +
          '<text x="' + f1(x) + '" y="' + f1(gs + fs(70, 31)) + '" font-size="' + fs(18, 9) + '" font-weight="800" fill="#2E2A22">' + label + "</text>";
      };
      return { ...base, mode: "stripes", vh: gs + fs(80, 36),
        svg: giant(x1, yNow, "#B8653D", "NOW", "#9A5130", "a") + giant(x1 + gs + gap, yAft, "#3F5B3A", "AFTER THE 7 ACTS", "#3F5B3A", "b"),
        headline: yNow + " → " + yAft, unitWord: "years of you to weigh one", title: "Years of you to weigh one " + it.one,
        caption: "An " + it.one + " weighed about " + funNum(it.size / 1000) + " tonnes: " + yNow + " years of your footprint now, " + yAft + " after the 7 Acts. Each stripe is a year; this year is coloured in." };
    }
    // How big each drawing can be if n of them fill the box.
    const fit = (n, gap) => {
      let best = { cell: 0, cols: 1 };
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const cell = Math.min((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows);
        if (cell > best.cell) best = { cell, cols };
      }
      return best;
    };
    const n = Math.max(1, Math.round(nNow));
    const gap = fs(14, 5);
    const g = n <= 400 ? fit(n, gap) : { cell: 0 };
    const headline = funNum(nNow) + " → " + funNum(nAft);
    if (g.cell >= (o.minCell || 22)) {
      const cell = Math.floor(Math.min(g.cell, o.maxCell || 999)), kept = Math.round(nAft);
      const rows = Math.ceil(n / g.cols), gw = g.cols * cell + (g.cols - 1) * gap, gh = rows * cell + (rows - 1) * gap;
      const ox = (W - gw) / 2;
      let cells = "";
      for (let i = 0; i < n; i++) {
        const x = ox + (i % g.cols) * (cell + gap), y = Math.floor(i / g.cols) * (cell + gap);
        const cut = i >= kept;
        cells += (cut ? '<rect x="' + f1(x) + '" y="' + f1(y) + '" width="' + cell + '" height="' + cell + '" rx="' + f1(cell * 0.14) + '" fill="none" stroke="#B8653D" stroke-width="' + fs(2.4, 1.2) + '" stroke-dasharray="' + fs("8 6", "4 3") + '"/>' : "") +
          '<svg x="' + f1(x) + '" y="' + f1(y) + '" width="' + cell + '" height="' + cell + '" viewBox="0 0 48 48" overflow="visible"' + (cut ? ' opacity=".3"' : "") + ">" +
          (cut ? '<g filter="url(#pi-grey)">' + piArt(it.key, false, true) + "</g>" : piArt(it.key, false, true)) + "</svg>";
      }
      return { ...base, mode: "grid", svg: cells, vh: gh,
        headline, unitWord: it.many, title: "In " + it.many,
        legend: [["sq", "#7FAE4E", "Still there after the 7 Acts"], ["dash", "#B8653D", "Cut by them"]],
        caption: "The 7 Acts would cut " + howMany(nNow - nAft, it) + " a year." };
    }
    // Lots of them: a field of dots, one each (or a round number each), as
    // big as the box allows, so the cut stays visible however big the number.
    const dotFit = (count) => {
      for (let p = Math.min(o.maxPitch || 30, Math.sqrt((W * H) / count)); p >= 1; p -= 0.1) {
        const cols = Math.floor(W / p);
        if (Math.ceil(count / cols) * p <= H) return { p: Math.floor(p * 10) / 10, cols };
      }
      return { p: 1, cols: Math.floor(W) };
    };
    let u = 1, d = dotFit(n);
    for (const x of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 10000]) {
      u = x;
      d = dotFit(Math.ceil(nNow / x));
      if (d.p >= (o.minPitch || 5)) break;
    }
    const pitch = d.p, cols = d.cols;
    const total = Math.round(nNow / u), kept = Math.round(nAft / u), rows = Math.ceil(total / cols);
    const fw = cols * pitch, ox = (W - fw) / 2;
    const seg = (a, b, fill) => {
      let out = "", i = a;
      while (i < b) {
        const r = Math.floor(i / cols), c = i % cols;
        if (c === 0 && b - i >= cols) {
          const full = Math.floor((b - i) / cols);
          out += '<rect x="' + f1(ox) + '" y="' + f1(r * pitch) + '" width="' + f1(cols * pitch) + '" height="' + f1(full * pitch) + '" fill="' + fill + '"/>';
          i += full * cols;
        } else {
          const kk = Math.min(cols - c, b - i);
          out += '<rect x="' + f1(ox + c * pitch) + '" y="' + f1(r * pitch) + '" width="' + f1(kk * pitch) + '" height="' + pitch + '" fill="' + fill + '"/>';
          i += kk;
        }
      }
      return out;
    };
    const pat = (id, col) => '<pattern id="' + id + '" x="' + f1(ox) + '" width="' + pitch + '" height="' + pitch + '" patternUnits="userSpaceOnUse"><circle cx="' + pitch / 2 + '" cy="' + pitch / 2 + '" r="' + (pitch * 0.36).toFixed(2) + '" fill="' + col + '"/></pattern>';
    const per = u === 1 ? "Each dot is one " + it.one : "Each dot is " + howMany(u, it);
    return { ...base, mode: "dots", vh: rows * pitch,
      svg: "<defs>" + pat("pi-dk-" + uid, it.dot) + pat("pi-dc-" + uid, "#C9774F") + "</defs>" + seg(0, kept, "url(#pi-dk-" + uid + ")") + seg(kept, total, "url(#pi-dc-" + uid + ")"),
      headline, unitWord: it.many, title: "In " + it.many, per,
      legend: [["dot", it.dot, funNum(nAft) + " still there"], ["dot", "#C9774F", funNum(nNow - nAft) + " cut by the 7 Acts"], ["", "", per]],
      caption: "The 7 Acts would cut " + howMany(nNow - nAft, it) + " a year: the clay dots. " + per + "." };
  }
  // The whole picture as one SVG. defs: include the filters (for pictures
  // drawn outside the page, like the share card).
  function piSvg(m, defs) {
    const h = m.vh ? Math.min(m.H, Math.ceil(m.vh)) : m.H;
    return '<svg class="pi-svg" viewBox="0 0 ' + m.W + " " + h + '" ' + (defs ? 'width="' + m.W + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg" ' : "") +
      'font-family="Karla, Arial, sans-serif" role="img" aria-label="' + esc(m.caption) + '" preserveAspectRatio="xMidYMid meet">' + (defs ? "<defs>" + PI_DEFS + "</defs>" : "") + m.svg + "</svg>";
  }
  const piLegend = (m) =>
    m.legend
      ? '<div class="pi-legend">' + m.legend.map((l) => '<span class="' + (l[0] ? "" : "muted") + '">' + (l[0] ? '<i class="pi-key ' + l[0] + '" style="--c:' + l[1] + '"></i>' : "") + esc(l[2]) + "</span>").join("") + "</div>"
      : "";

  // Picture it: your footprint now and after the 7 Acts, in trees, phone
  // charges and your fair share of 2.5 t, then four mascots. The rest of
  // the mascots are for the share card.
  const KEY_PI_VIEW = "co2_pi_view";
  const PI_REAL = [
    { key: "tree", short: "Trees" },
    { key: "phone", short: "Phone charges", tab: "Phones" },
    { key: "target", short: "Fair share" },
  ];
  // Your mascot: the one you picked, or the default until you do.
  const piMine = () => piItems().find((x) => x.key === (piMascot() || D.EVERYDAY_COMPARISONS.defaultMascot)) || piItems()[0];
  const piViews = () => { const m = piMine(); return PI_REAL.concat([{ key: "mascot", short: m.short, tab: "Mascot", mascot: m }]); };
  const piView = () => {
    const k = ui.piView || lsGet(KEY_PI_VIEW, "tree");
    return piViews().find((v) => v.key === k) || piViews()[0];
  };
  // Simple flat glyphs, 24 x 24, drawn in the current colour.
  const PI_GLYPH = {
    tree: '<circle cx="12" cy="7.6" r="5.4"/><circle cx="7.6" cy="11.6" r="4.4"/><circle cx="16.4" cy="11.6" r="4.4"/><rect x="7.6" y="10" width="8.8" height="6" rx="3"/><rect x="10.9" y="13" width="2.2" height="9" rx="1.1"/>',
    phone: '<path fill-rule="evenodd" d="M8.6 2h6.8A2.6 2.6 0 0 1 18 4.6v14.8a2.6 2.6 0 0 1-2.6 2.6H8.6A2.6 2.6 0 0 1 6 19.4V4.6A2.6 2.6 0 0 1 8.6 2zm4.6 4.6-3.6 6.1h2.5l-1.3 4.7 3.6-6.1h-2.5z"/>',
    target: '<path fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6zm0 3a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6z"/>',
  };
  const piGlyph = (key, size) => '<svg class="pi-gl" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor" aria-hidden="true" focusable="false">' + PI_GLYPH[key] + "</svg>";
  // 2.3m · 480k · 1,200 · 480 · 12
  function piNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "m";
    if (n >= 1e5) return Math.round(n / 1000) + "k";
    return funNum(n);
  }
  // A grid of icons, one per tree (or 10, 100, ...), the ones the 7 Acts
  // would save in a pale tint.
  // draw: a glyph key, or a mascot (its own drawing, in a 48 box).
  function piIconGrid(draw, nNow, nAft, oneWord, manyWord, words) {
    let u = 1;
    for (const x of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6]) {
      u = x;
      if (Math.ceil(nNow / x) <= 60) break;
    }
    const total = Math.max(1, Math.ceil(nNow / u)), kept = Math.min(total, Math.round(nAft / u));
    const cols = Math.min(10, total), cell = 28, rows = Math.ceil(total / cols);
    const art = typeof draw === "string" ? PI_GLYPH[draw] : null;
    let g = "";
    for (let i = 0; i < total; i++) {
      const x = (i % cols) * cell + 2, y = Math.floor(i / cols) * cell + 2;
      g += art
        ? '<g class="' + (i < kept ? "k" : "s") + '" transform="translate(' + x + " " + y + ')">' + art + "</g>"
        : '<svg x="' + (x - 1) + '" y="' + (y - 1) + '" width="26" height="26" viewBox="0 0 48 48" overflow="visible"' + (i < kept ? "" : ' class="s"') + ">" +
          (i < kept ? piArt(draw.key, false, true) : '<g filter="url(#pi-grey)">' + piArt(draw.key, false, true) + "</g>") + "</svg>";
    }
    const w = words || ["Still needed", "Saved by the 7 Acts"];
    const each = u === 1 ? "Each is one " + oneWord : "Each is " + piNum(u) + " " + manyWord;
    return {
      html: '<svg class="pi-icons" viewBox="0 0 ' + cols * cell + " " + rows * cell + '" style="max-width:' + cols * (total <= 10 ? 60 : 34) + 'px" role="img" aria-label="' + esc(each + ": " + kept + " " + w[0].toLowerCase() + ", " + (total - kept) + " " + w[1].toLowerCase()) + '">' + g + "</svg>",
      legend: '<div class="pi-legend"><span><i class="pi-key k' + (art ? "" : " m") + '"' + (art ? "" : ' style="--c:' + draw.dot + '"') + "></i>" + esc(w[0]) + '</span><span><i class="pi-key s"></i>' + esc(w[1]) + '</span><span class="muted">' + esc(each) + "</span></div>",
    };
  }
  // Now and after, as two bars against the 2.5 t line.
  function piTargetBars(now, after) {
    const B = D.BUDGET_YEARLY, max = Math.max(now, B) * 1.08;
    const pct = (v) => ((v / max) * 100).toFixed(1) + "%";
    const row = (label, v, cls) =>
      '<div class="pi-bar-row"><span class="pi-bar-l">' + label + '</span><div class="pi-bar"><i class="' + cls + '" style="width:' + pct(v) + '"></i><em style="left:' + pct(B) + '"></em></div><b class="tnum">' + (v / 1000).toFixed(1) + " t</b></div>";
    return '<div class="pi-bars"><div class="pi-bar-row pi-bar-top"><span class="pi-bar-l"></span><div class="pi-bar-mark"><span style="left:' + pct(B) + (B / max > 0.7 ? ';transform:translateX(-100%)' : '') + '">' + (B / 1000).toFixed(1) + " t fair share</span></div><b></b></div>" +
      row("Now", now, "now") + row("After", after, "aft") + "</div>";
  }
  // One phone charge on the UK grid: kWh x the grid factor, in grams.
  const phoneChargeG = () => D.EVERYDAY_COMPARISONS.phoneKwh * D.ELECTRICITY_FACTOR * 1000;
  const phoneWorking = () =>
    D.EVERYDAY_COMPARISONS.phoneKwh + " kWh × " + D.ELECTRICITY_FACTOR.toFixed(3) + " kg CO₂e per kWh on the UK grid (DESNZ) = " + phoneChargeG().toFixed(1) + " g CO₂e a charge";
  function piPanel(v, ba) {
    const E = D.EVERYDAY_COMPARISONS;
    const stat = (a, b, unit) =>
      '<div class="pi-stat"><div><span class="pi-when">Now</span><b class="display tnum">' + esc(a) + '</b></div><span class="pi-arr" aria-hidden="true">→</span>' +
      '<div><span class="pi-when">After the 7 Acts</span><b class="display tnum">' + esc(b) + "</b></div></div>" + '<p class="pi-unit">' + esc(unit) + "</p>";
    const foot = (cap, src) => '<p class="pi-cap">' + esc(cap) + '</p><p class="xs muted pi-src">' + esc(src) + "</p>";
    if (v.key === "tree") {
      const a = ba.now / E.treeKgYear, b = ba.after / E.treeKgYear, g = piIconGrid("tree", a, b, "tree", "trees");
      return stat(piNum(a), piNum(b), "trees, each growing for a year, to soak up your CO₂") + '<div class="pi-vis2">' + g.html + "</div>" + g.legend +
        foot("The 7 Acts would save the work of " + piNum(a - b) + " trees, every year.", E.treeSource);
    }
    if (v.key === "phone") {
      const per = E.phoneKwh * D.ELECTRICITY_FACTOR, a = ba.now / per, b = ba.after / per, g = piIconGrid("phone", a, b, "charge", "charges", ["After the 7 Acts", "Cut by them"]);
      return stat(piNum(a), piNum(b), "phone charges' worth of CO₂ a year") + '<div class="pi-vis2">' + g.html + "</div>" + g.legend +
        foot("Like charging a phone every day for " + funNum(a / 365) + " years. After the 7 Acts, " + funNum(b / 365) + " years.", E.phoneSource + " " + phoneWorking() + ".");
    }
    if (v.key === "target") {
      const B = D.BUDGET_YEARLY, r = (x) => (x / B).toFixed(1).replace(/\.0$/, "") + "×";
      return stat(r(ba.now), r(ba.after), "your fair share of " + (B / 1000).toFixed(1) + " t a year") + '<div class="pi-vis2">' + piTargetBars(ba.now, ba.after) + "</div>" +
        foot(ba.after <= B ? "The 7 Acts would bring you inside the 1.5°C budget." : "The 7 Acts would close " + Math.round(((ba.now - ba.after) / Math.max(1, ba.now - B)) * 100) + "% of the gap to it.",
          "The 1.5°C budget: about 2.5 t per person a year by 2030 (Hot or Cool Institute, 2021).");
    }
    // Change mascot: every drawing, one tap to pick.
    if (ui.piPicking)
      return '<div class="pi-mrow"><b>Pick your mascot</b><button type="button" class="link-btn" data-action="pi-mascot-pick">Cancel</button></div><div class="pi-pick-grid">' +
        piItems().map((x) => '<button type="button" class="pi-pick-btn' + (x.key === v.key ? " on" : "") + '" data-action="pi-mascot-set" data-key="' + x.key + '" aria-pressed="' + (x.key === v.key) + '">' + piIcon(x.key, 48) + '<span class="pi-pick-name">' + esc(x.short) + "</span></button>").join("") + "</div>";
    const it = v.mascot, a = ba.now / it.size, b = ba.after / it.size;
    const mrow = '<div class="pi-mrow"><span class="sm">Your mascot: <b>' + esc(it.short) + '</b></span><button type="button" class="link-btn" data-action="pi-mascot-pick" aria-label="Change your mascot">Change</button></div>';
    const fun = it.source + " For fun and scale, not precision.";
    if (it.type === "w" && a >= 1) {
      const g = piIconGrid(it, a, b, it.one, it.many, ["After the 7 Acts", "Cut by them"]);
      return mrow + stat(piNum(a), piNum(b), "the weight of your CO₂ a year, in " + it.many) + '<div class="pi-vis2">' + g.html + "</div>" + g.legend +
        foot("The 7 Acts would cut " + howMany(a - b, it) + " a year.", fun);
    }
    const m = piModel(it, ba.now, ba.after, { w: 320, h: 196, minPitch: 5, minCell: 18, maxCell: 90, uid: "s" + v.key });
    const [x, y] = m.headline.split(" → ");
    return mrow + stat(x, y, m.unitWord) + '<div class="pi-vis">' + piSvg(m) + "</div>" + piLegend(m) + foot(m.caption, fun);
  }
  function pictureItHtml() {
    const ba = actsBeforeAfter();
    if (!ba) return "";
    const v = piView();
    const tab = (x) =>
      '<button type="button" role="tab" class="pi-tab' + (x.key === v.key ? " on" : "") + '" aria-selected="' + (x.key === v.key) + '" data-action="pi-view" data-key="' + x.key + '">' +
      '<span class="pi-tab-ic">' + (x.mascot ? piIcon(x.mascot.key, 24) : piGlyph(x.key, 20)) + '</span><span class="pi-tab-l">' + esc(x.tab || x.short) + "</span></button>";
    return (
      '<section class="glass picture-it pi-wrap pi-v2" id="picture-it" aria-labelledby="pi-h">' + piDefsSvg() +
      '<div class="pi-head"><div class="min0"><h2 id="pi-h" class="card-title">Picture it</h2><p class="sm muted">Your footprint now, and after the 7 Acts</p></div>' +
      '<div class="pi-acts"><button type="button" class="pi-play" data-action="pi-story"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>Watch it shrink</button>' +
      '<button type="button" class="icon-btn pi-share" data-action="pi-share" aria-label="Share your before and after">' + icon("share") + "</button></div></div>" +
      '<div class="pi-tabs" role="tablist" aria-label="Compare with">' + PI_REAL.map(tab).join("") +       piViews().filter((x) => x.mascot).map(tab).join("") + "</div>" +
      '<div class="pi-panel" role="tabpanel" aria-label="' + esc(v.short) + '">' + piPanel(v, ba) + "</div></section>"
    );
  }
  // Move the slideshow without re-rendering the page.
  function piGo(i) {
    const n = piItems().length;
    ui.piIdx = ((i % n) + n) % n;
    const track = document.querySelector(".pi-track");
    if (!track) return;
    track.style.transform = "translateX(" + -ui.piIdx * 100 + "%)";
    document.querySelectorAll(".pi-dot").forEach((d, k) => {
      d.classList.toggle("on", k === ui.piIdx);
      if (k === ui.piIdx) d.setAttribute("aria-current", "true");
      else d.removeAttribute("aria-current");
    });
    const c = document.querySelector(".pi-count");
    if (c) c.textContent = ui.piIdx + 1 + "/" + n;
    const op = document.querySelector(".pi-opener");
    if (op) op.setAttribute("aria-label", "Picture it: " + piItems()[ui.piIdx].short + ". Tap to see every comparison");
  }
  // Every few seconds, unless it's off screen, in use or motion is reduced.
  setInterval(() => {
    const sq = document.querySelector(".pi-square");
    if (!sq || !sq.querySelector(".pi-track") || document.hidden || ui.piOpen || sq.matches(":hover") || sq.querySelector(":focus-visible")) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = sq.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    piGo(piIndex() + 1);
  }, 3500);
  // Swipe the square left or right.
  let piSwipe = null;
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".pi-opener") && document.querySelector(".pi-track")) piSwipe = { x: e.clientX, y: e.clientY, moved: false };
  });
  document.addEventListener("pointerup", (e) => {
    if (!piSwipe) return;
    const dx = e.clientX - piSwipe.x, dy = e.clientY - piSwipe.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      piSwipe.moved = true;
      piGo(piIndex() + (dx < 0 ? 1 : -1));
    }
    setTimeout(() => (piSwipe = null), 0);
  });

  // The 1.5°C budget (Hot or Cool Institute) covers household consumption:
  // food, home, travel, goods and leisure. It leaves out banks and pensions
  // (financed emissions) and public services. So we compare like with like:
  // the survey's areas apart from money, plus the typical shopping figure.
  // Money is shown on its own, beside it.
  const BUDGET_SOURCE_URL = "https://hotorcool.org/hc-projects/1-5-degree-lifestyles";
  function budgetBasis(fp, tips) {
    const money = fp.breakdown.filter((b) => b.key === "banking").reduce((t, b) => t + b.yearly, 0);
    const shop = D.ASSUMED_SHOPPING.totalKg;
    const life = fp.totalYearly - money + shop;
    const mt = tips ? tips.find((x) => x.b.key === "banking") : null;
    return { money, shop, life, moneySave: mt ? mt.t.saving : 0, moneyMax: mt ? mt.t.maxSaving : 0 };
  }
  const budgetPhrase = (kg) => {
    const ratio = kg / D.BUDGET_YEARLY;
    return ratio <= 1 ? "inside the 1.5°C budget" : ratio < 1.5 ? Math.round((ratio - 1) * 100) + "% over the 1.5°C budget" : ratio.toFixed(1).replace(/\.0$/, "") + " times the 1.5°C budget";
  };

  function ukPill(cmp) {
    if (cmp.pct < 5) return '<span class="stat-pill">About the same as the UK average</span>';
    return (
      '<span class="stat-pill">' +
      (cmp.above ? '<span class="red">' + cmp.pct + "% above</span>" : '<span class="green">' + cmp.pct + "% below</span>") +
      " the UK average</span>"
    );
  }

  // The fixed share everyone in the UK has from public services and
  // infrastructure, shown under the headline total.
  function sharedLine(personalKg) {
    const sh = D.SHARED_FOOTPRINT;
    const shop = D.ASSUMED_SHOPPING;
    const t = (kg) => (kg / 1000).toFixed(1);
    return (
      '<div class="shared-line mt-4">' +
      '<p class="sm"><strong>+ ' + t(shop.totalKg) + " t shopping (assumed)</strong> &middot; a typical UK figure for clothes, household goods, electronics and hobbies. Shopping isn't in the survey yet.</p>" +
      '<p class="sm mt-2"><strong>+ ' + t(sh.totalKg) + " t shared footprint</strong> &middot; your share of the UK's public services (" +
      t(sh.publicServicesKg) + " t) and infrastructure (" + t(sh.infrastructureKg) + " t). It's the same for everyone in the UK.</p>" +
      '<p class="sm mt-2">Including both, your total is about <strong>' + t(personalKg + shop.totalKg + sh.totalKg) + " t a year</strong>.</p></div>"
    );
  }

  function ukNote(cmp) {
    return (
      '<p class="xs muted mt-3">Compared on food, commuting, flights, home energy, water and pets, where you come to ' +
      (cmp.mine / 1000).toFixed(1) + " t and a typical UK resident about " + (cmp.uk / 1000).toFixed(1) +
      " t a year. Banking and pensions aren't included in this comparison.</p>"
    );
  }

  // Every "the same as driving" uses the survey's petrol car (DESNZ 2026).
  const petrolKm = () => byKey(D.COMMUTE_MODES, "car_petrol").factor;

  function equivalents(kg) {
    if (kg <= 0) return { trees: 0, phones: 0, drivingKm: 0 };
    return {
      trees: Math.round(kg / A.TREE_KG),
      phones: Math.round(kg / A.PHONE_KG),
      drivingKm: Math.round(kg / petrolKm()),
    };
  }

  // ==================== habits, stages, goals, streaks ====================

  const committedHabits = (cat) => lsGet(KEY_HABITS + cat, []);

  function allCommitted() {
    const out = {};
    CATEGORIES.forEach((c) => (out[c] = committedHabits(c)));
    return out;
  }

  function habitsFor(cat, s) {
    if (cat === "meals") {
      const diet = s ? D.DIET_EXPLAINERS[dietType(s)] : null;
      return (diet && diet.habits) || D.EXPLAINERS.meals.habits;
    }
    return D.EXPLAINERS[cat].habits;
  }

  // The first time a category's habits are seen on the check-in page, that
  // day becomes its start date; each further habit unlocks a week later.
  function stageStart(cat) {
    const raw = lsGet(KEY_STAGE + cat, null);
    if (raw) return new Date(raw);
    const now = new Date();
    lsSet(KEY_STAGE + cat, now.toISOString());
    return now;
  }

  function stageInfo(start, index) {
    if (!start || index <= 0) return { active: true, unlocksInDays: 0 };
    const unlockAt = new Date(start.getTime() + index * STAGE_DAYS * DAY_MS);
    const now = new Date();
    const active = now >= unlockAt;
    return { active, unlocksInDays: active ? 0 : Math.max(1, Math.ceil((unlockAt - now) / DAY_MS)) };
  }

  function checkInGroups(s) {
    const groups = [];
    CATEGORIES.forEach((cat) => {
      const ids = committedHabits(cat);
      if (!ids.length) return;
      const lookup = new Map(habitsFor(cat, s).map((h) => [h.id, h]));
      const start = stageStart(cat);
      const habits = ids
        .map((id, i) => {
          const h = lookup.get(id);
          return h ? { ...h, goal: D.GOAL_HABIT_IDS.includes(id), stage: stageInfo(start, i) } : null;
        })
        .filter(Boolean);
      if (habits.length) groups.push({ category: cat, title: D.EXPLAINERS[cat].title, icon: D.EXPLAINERS[cat].icon, habits });
    });
    return groups;
  }

  function oneMonthFromNow() {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  }

  function goalFor(id) {
    const goals = lsGet(KEY_GOALS, {});
    if (!goals[id]) {
      goals[id] = { deadline: oneMonthFromNow(), done: false };
      lsSet(KEY_GOALS, goals);
    }
    return goals[id];
  }

  function updateGoal(id, patch) {
    const goals = lsGet(KEY_GOALS, {});
    goals[id] = { ...(goals[id] || { deadline: oneMonthFromNow(), done: false }), ...patch };
    lsSet(KEY_GOALS, goals);
  }

  const dayKey = (d) => d.toISOString().slice(0, 10);

  function streak(id) {
    const days = lsGet(KEY_STREAKS, {})[id] || {};
    const cursor = new Date();
    if (!days[dayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
    let count = 0;
    while (days[dayKey(cursor)]) {
      count++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { count, checkedToday: !!days[dayKey(new Date())] };
  }

  function toggleCheckIn(id) {
    const all = lsGet(KEY_STREAKS, {});
    all[id] = all[id] || {};
    const today = dayKey(new Date());
    if (all[id][today]) delete all[id][today];
    else all[id][today] = true;
    lsSet(KEY_STREAKS, all);
  }

  function lastDays(id, n) {
    const days = lsGet(KEY_STREAKS, {})[id] || {};
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push({ key: dayKey(d), checked: !!days[dayKey(d)] });
    }
    return out;
  }

  // ==================== shared UI pieces ====================

  function pageHeader(title, subtitle, iconName) {
    return (
      '<div class="page-head">' +
      '<div class="page-badge">' + icon(iconName || "leaf") + "</div>" +
      "<div><h1>" + esc(title) + "</h1>" +
      (subtitle ? '<p class="muted xs">' + esc(subtitle) + "</p>" : "") +
      "</div></div>"
    );
  }

  // One look for every empty, loading and error state: a soft round icon,
  // a clear title, a line of help, and what to do next.
  function stateCard(o) {
    const art = o.kind === "loading" ? '<span class="spinner"></span>' : icon(o.icon || "info");
    const acts = (o.actions || []).map(([label, attrs, primary]) => (attrs.startsWith("href") ? "<a " : '<button type="button" ') + 'class="btn ' + (primary ? "btn-green" : "btn-outline") + ' btn-sm" ' + attrs + ">" + label + (attrs.startsWith("href") ? "</a>" : "</button>")).join("");
    return (
      '<section class="state-card ' + (o.kind || "empty") + (o.inline ? " inline" : "") + '" role="' + (o.kind === "error" ? "alert" : "status") + '"' + (o.kind === "loading" ? ' aria-busy="true"' : "") + ">" +
      '<span class="state-art" aria-hidden="true">' + art + "</span>" +
      (o.title ? '<h2 class="display">' + o.title + "</h2>" : "") + (o.text ? "<p>" + o.text + "</p>" : "") +
      (acts ? '<div class="state-actions">' + acts + "</div>" : "") + "</section>"
    );
  }
  const spinner = '<div class="container">' + stateCard({ kind: "loading", title: "One moment", text: "Getting your footprint ready." }) + "</div>";
  const notFound = (home) => '<div class="container">' + stateCard({ icon: "search", title: "We couldn't find that page", text: "The link may be old, or the page has moved.", actions: [[home ? "Back to My Habits" : "Go to my results", 'href="' + (home ? "#/habits" : "#/results") + '"', true], ["Take the survey", 'href="#/" data-action="start-survey"']] }) + "</div>";
  // Results before the survey's finished: nothing made up, just the way in.
  function noResultsYet() {
    const started = !!(survey && (survey.meals || survey.commute) && lsGet(KEY_SURVEY, null));
    return '<div class="container">' + stateCard({ icon: "chart", title: "Your results will appear here", text: started ? "Finish the survey to see your footprint, where it comes from and your biggest moves." : "Take the 5-minute survey to see your footprint, where it comes from and your biggest moves.", actions: [[started ? "Continue the survey" : "Take the survey", 'href="#/" data-action="start-survey"', true], ["See an example", 'href="/example/"']] }) + "</div>";
  }
  const adminsOnly = (what) => '<div class="container">' + stateCard({ icon: "lock", title: "Only for the owner", text: "Sign in with the owner's account to see " + what + ".", actions: [["Go to my account", 'href="#/account"', true]] }) + "</div>";

  function setNav(path) {
    document.querySelectorAll("#nav a, #nav-avatar, #tabbar a").forEach((a) => {
      const on = a.getAttribute("data-route") === path;
      a.classList.toggle("active", on);
      if (a.closest("#tabbar")) on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
    });
    // Once the survey's done, its tab is for updating it.
    const surveyLabel = survey && survey.completedAt ? "Update" : "Survey";
    const navSurvey = document.querySelector('#nav a[data-route="/"]');
    if (navSurvey && navSurvey.textContent !== surveyLabel) navSurvey.textContent = surveyLabel;
    const tabSurvey = document.querySelector('#tabbar a[data-route="/"] span');
    if (tabSurvey) tabSurvey.textContent = surveyLabel;
    const tabAcc = document.querySelector('#tabbar a[data-route="/account"] span');
    if (tabAcc) tabAcc.textContent = currentUser ? "Account" : "Sign in";
    const av = document.getElementById("nav-avatar");
    if (av) {
      const name = ui.userName && ui.userName !== "App user" ? ui.userName : ui.username || currentUser?.email || "";
      const label = currentUser ? initials(name) : "";
      av.innerHTML = label ? label : icon("user");
      av.setAttribute("aria-label", currentUser ? "Account" : "Sign in");
    }
    moveTabInk();
  }

  // ==================== the phone app shell ====================
  // On a phone the app behaves like an iPhone app: a title bar with a back
  // button on inner screens, screens that slide in and out, tabs that keep
  // their place, and a tab bar whose highlight glides between tabs.
  const ROOT_TABS = ["/", "/results", "/friends", "/habits", "/check-in", "/account", "/welcome"];
  const pathDepth = (p) => (ROOT_TABS.includes(p) ? 1 : 2);
  const onPhoneScreen = () => window.matchMedia("(max-width: 640px)").matches;
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const NAV_TITLES = { "/results": "Results", "/friends": "Friends", "/habits": "My Habits", "/check-in": "My Habits", "/switches": "Greener switches", "/about": "About", "/how-we-calculate": "How we calculate", "/budget": "The 1.5°C budget", "/privacy": "Privacy", "/terms": "Terms", "/example": "Example result", "/confirm/energy": "Confirm", "/inputs": "Inputs", "/analytics": "Analytics" };
  function navMeta(path) {
    const parts = path.split("/").filter(Boolean);
    let title = NAV_TITLES[path] || "", parent = null;
    if (path === "/") title = survey && survey.completedAt ? "Your survey" : "Survey";
    if (path === "/account") title = currentUser ? "Account" : "Sign in";
    if (parts[0] === "explainer" && D.EXPLAINERS[parts[1]]) { title = D.EXPLAINERS[parts[1]].title; parent = "/results"; }
    if (parts[0] === "acts") { title = ACT_PAGES[parts[1]] ? "Act " + ACT_PAGES[parts[1]] + " of 7" : "The 7 Acts"; parent = "/habits"; }
    if (path === "/habits/level") { title = "Your level"; parent = "/habits"; }
    if (path === "/switches" || path === "/example") parent = path === "/switches" ? "/habits" : "/results";
    return { title, parent };
  }
  // Where we've been in this visit, so Back goes where you came from.
  let navTrail = null;
  let lastRoute = null;
  let navIntent = null; // "back" from our back button or swipe, "tab" from the tab bar
  const scrollMem = {};
  function backTarget(path) {
    const prev = navTrail && navTrail.length > 1 ? navTrail[navTrail.length - 2] : null;
    if (pathDepth(path) === 1) return null;
    return prev || navMeta(path).parent;
  }
  function navBar(path) {
    const bar = document.querySelector(".topbar");
    const back = document.getElementById("nav-back");
    const title = document.getElementById("nav-title");
    if (!bar || !back || !title) return;
    const meta = navMeta(path);
    title.textContent = app.querySelector(".intro-v2") ? "" : meta.title;
    const to = backTarget(path);
    back.hidden = !to;
    bar.classList.toggle("has-back", !!to);
    if (to) {
      const label = (navMeta(to).title || "Back").replace(/^Your survey$/, "Survey");
      back.querySelector("span").textContent = label.length > (window.innerWidth < 360 ? 8 : 13) ? "Back" : label;
      back.dataset.to = to;
      back.setAttribute("aria-label", "Back to " + label);
    }
    watchTitle();
  }
  // After each draw: the title bar, whether this is one of the app's own
  // screens (no website footer), and the survey's focus mode (no tab bar).
  function shellSync() {
    const path = currentPath();
    navBar(path);
    const intro = !!app.querySelector(".intro-v2");
    const inApp = ["/", "/results", "/friends", "/habits", "/check-in", "/account"].includes(path) || /^\/(explainer|acts|habits)\//.test(path);
    document.body.classList.toggle("in-app", inApp && !intro);
    document.body.classList.toggle("survey-focus", path === "/" && !!app.querySelector(".survey-v2 .step-nav-v2"));
    moveTabInk();
    clampLongText();
  }
  // On a phone, long explanations show two lines and a More button, so a
  // screen isn't a wall of text. Tapping More opens it in place.
  const CLAMP_SEL = ".research-consent > span, .acc-plan-p, .sw-fact, .cat-hero .cat-why, .act-page p.xs.muted, .act-page .act-ideas li, .ab-hero > p, .ab-founder p, .ab-note p, .ab-aff-text p, .ab-pcard p, .ab-belief p, .method > p, .method li";
  function clampLongText() {
    if (!onPhoneScreen()) return;
    app.querySelectorAll(CLAMP_SEL).forEach((el) => {
      if (el.classList.contains("ph-clamp") || (el.innerText.match(/\S+/g) || []).length < 22) return;
      el.classList.add("ph-clamp");
      requestAnimationFrame(() => {
        if (el.scrollHeight <= el.clientHeight + 2) return el.classList.remove("ph-clamp");
        const more = document.createElement("button");
        more.type = "button";
        more.className = "ph-more";
        more.dataset.action = "ph-more";
        more.textContent = "More";
        if (el.tagName === "LI") {
          const li = document.createElement("li");
          li.className = "ph-more-li";
          li.appendChild(more);
          el.after(li);
        } else (el.closest("label") || el).after(more); // outside a label, or iPhones tick its box too
      });
    });
  }
  // The title shows in the bar once the page's own heading scrolls under it.
  let titleObs = null;
  function watchTitle() {
    const bar = document.querySelector(".topbar");
    if (titleObs) titleObs.disconnect();
    titleObs = null;
    if (!bar) return;
    const h = app.querySelector("h1");
    if (!h || !("IntersectionObserver" in window)) return bar.classList.add("titled");
    bar.classList.remove("titled");
    titleObs = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      bar.classList.toggle("titled", !e.isIntersecting && e.boundingClientRect.top < 80);
    }, { rootMargin: "-64px 0px 0px 0px" });
    titleObs.observe(h);
  }
  let barTick = false;
  window.addEventListener("scroll", () => {
    if (barTick) return;
    barTick = true;
    requestAnimationFrame(() => {
      barTick = false;
      const bar = document.querySelector(".topbar");
      if (bar) bar.classList.toggle("scrolled", window.scrollY > 4);
    });
  }, { passive: true });
  // The tab bar's highlight glides to the tab you're on.
  function moveTabInk() {
    const bar = document.getElementById("tabbar");
    const ink = bar && bar.querySelector(".tab-ink");
    if (!ink) return;
    const a = bar.querySelector("a.active");
    if (!a || !bar.offsetWidth) { ink.style.opacity = "0"; return; }
    ink.style.opacity = "1";
    ink.style.width = a.offsetWidth + "px";
    ink.style.transform = "translateX(" + a.offsetLeft + "px)";
    if (!ink.classList.contains("ready")) requestAnimationFrame(() => ink.classList.add("ready"));
  }
  // A light tap of haptics in the iPhone app (nothing on the web).
  function haptic(kind) {
    const h = plugin("Haptics");
    if (!h) return;
    try {
      const p = kind === "success" ? h.notification({ type: "SUCCESS" }) : h.impact({ style: kind === "medium" ? "MEDIUM" : "LIGHT" });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
  // Screens glide in: a push slides in from the right, going back slides in
  // from the left, and switching tabs is a quick fade.
  function glide(dir) {
    // Tabs switch instantly, like any iPhone app; only going in and Back slide.
    if (!dir || reducedMotion()) return;
    // A computer gets a quick fade between pages; a phone slides in and back.
    if (!onPhoneScreen()) dir = "fade";
    else if (dir === "tab") return;
    const cls = "pg-" + dir;
    app.classList.remove("pg-push", "pg-pop", "pg-tab", "pg-fade");
    void app.offsetWidth;
    app.classList.add(cls);
    clearTimeout(glide.t);
    glide.t = setTimeout(() => app.classList.remove(cls), 240);
  }

  // "Alex Green" -> "AG", "sam_green" -> "SG", "sam@x.com" -> "S".
  function initials(name) {
    const words = String(name).split("@")[0].split(/[\s_.-]+/).filter(Boolean);
    return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "";
  }

  // ==================== state ====================

  let survey = null;
  const ui = {
    step: 0,
    commuteOpen: null, // commute day being answered
    mealDay: null, // meal day being answered
    airport: null, // { index, field } of the open airport picker
    airportQuery: "",
    selectedCategory: null, // Results page bar/tip selection
    authMode: "signin",
    authEmail: "",
    authMsg: "",
    authErr: "",
    userName: "",
    username: "", // the account's @username
    recovery: false,
    authSentTo: "", // email a confirmation link was just sent to
    flash: "", // one-off message shown at the top of the next page
    pendingVerify: null, // { tokenHash, type } from an email link, until tapped
    authUsername: "",
    needUsername: false, // signed in, but the account has no username yet
    shownStep: null, // survey step last drawn, so cards only fade in on a new step
    newSurvey: false, // taking a new survey; the finished one is kept until it's done
    reviewing: false, // on the "Anything changed?" summary of a new survey
    fromReview: false, // editing one step, opened from that summary
    editBase: null, // answers before "Edit my answers", to compare on save
    celebrate: null, // what changed since the last survey, shown once on Results
    draft: null,
    prevSurvey: null,
    history: [], // completed surveys, newest first: { completedAt, totalYearly }
    showUk: lsGet(KEY_SHOW_UK, false), // UK average bars on the results chart
    chartMode: lsGet("co2_chart_mode", "donut"), // results chart: donut or bars
    exampleMode: false, // drawing Results for the typical-UK example
    resultsSeen: false, // count-up animation plays on the first visit only
    confirmingPayment: false,
    paymentTimedOut: false,
    editing: false, // editing a completed survey (from Results)
  };

  const app = document.getElementById("app");
  const modalRoot = document.getElementById("modal-root");

  // ==================== Survey page ====================

  const STEPS = [
    { key: "meals", title: "Weekly Meals", subtitle: "What you eat, day by day", icon: "🍽️", render: renderMealsStep },
    { key: "commute", title: "Commute & Travel", subtitle: "How you get around", icon: "🚗", render: renderCommuteStep },
    { key: "flights", title: "Flight Checklist", subtitle: "Your saved flights", icon: "✈️", render: renderFlightsStep },
    { key: "energy", title: "Home & Water", subtitle: "Energy, gas & water", icon: "⚡", render: renderEnergyStep },
    { key: "pets", title: "Pets", subtitle: "Furry companions", icon: "🐾", render: renderPetsStep },
    { key: "banking", title: "Banking & Pension", subtitle: "Where your money lives", icon: "🏦", render: renderBankingStep },
  ];

  // Shown on the Survey tab once a survey is complete. Small edits happen
  // from "Edit my answers" on the Results page instead.
  // The Survey tab once it's done: update it, or change one step.
  function renderSurveyDone() {
    const when = Date.parse(survey.completedAt);
    const longDate = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    const now = footprint(survey).totalYearly;
    return (
      '<div class="container done-v2" data-fs-pill="' + kgFmt(now) + '" data-fs-unit="kg last time">' +
      '<header class="glass cat-hero rise"><span class="cat-watermark" aria-hidden="true">' + icon("clipboard") + "</span>" +
      '<div class="cat-hero-main done-head"><span class="done-tick">' + icon("check") + "</span><div>" +
      '<h1 class="cat-title display">Update your answers</h1><p class="cat-why">' +
      (isNaN(when) ? "" : "Last done on <strong>" + esc(longDate(when)) + "</strong>. ") +
      "Change only what's different.</p>" +
      '<div class="chip-row mt-4"><button type="button" class="btn btn-honey" data-action="whats-changed">Update my answers ' + icon("arrowRight") + "</button>" +
      '<button type="button" class="link-btn" data-action="new-survey">Start from scratch</button></div></div></div>' +
      '<div class="cat-figs"><div class="muted">Your last result</div><div class="cat-kg display tnum" data-countup="' + Math.round(now) + '">0</div><div class="muted">kg CO₂e a year</div>' +
      '<a class="link-btn mt-2" href="#/results">See results</a></div></header>' +
      '<section class="guide-card flat"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline">' +
      '<h2 class="display">Or change one step</h2><span class="muted">Tap the one that\'s different</span></div><div class="answer-tiles">' +
      STEPS.map((st, i) => {
        const lines = answerSummary(st.key, survey);
        return (
          '<button type="button" class="answer-tile" data-action="quick-edit" data-step="' + i + '" aria-label="Change ' + esc(STEP_TAB[st.key]) + '">' +
          '<span class="row-between"><span class="display answer-name"><span class="answer-n">' + (i + 1) + "</span>" + esc(STEP_TAB[st.key]) + "</span>" +
          '<span class="display tnum fw-700">' + kgFmt(stepKg(st.key, survey)) + ' <small class="muted">kg</small></span></span>' +
          '<span class="answer-l1">' + esc(lines[0] || "") + "</span>" + (lines[1] ? '<span class="answer-l2">' + esc(lines[1]) + "</span>" : "") +
          '<span class="answer-change">Change</span></button>'
        );
      }).join("") +
      "</div></section></div>"
    );
  }

  function finishSurvey() {
    const base = ui.newSurvey ? ui.prevSurvey : ui.editBase;
    ui.editBase = null;
    if (ui.newSurvey) {
      survey = ui.draft;
      ui.newSurvey = false;
      ui.draft = null;
      ui.prevSurvey = null;
    }
    ui.reviewing = ui.fromReview = false;
    survey.completedAt = new Date().toISOString();
    // Kept with the survey, so later edits on the Inputs page don't move it.
    survey.factors = { ...liveInputs };
    applyInputs(survey.factors);
    surveyChanged();
    ui.editing = false;
    saveSnapshot(footprint(survey).totalYearly);
    // Once saved, tell whoever invited this person (their act 7 may tick).
    recordHistory(survey).then(() => setTimeout(() => { if (currentUser && sb) sb.rpc("check_referrer").then(() => {}, () => {}); }, 1500));
    // Without an account, count that a survey was finished: just the time,
    // nothing about the person or their answers (those stay on the device).
    if (!currentUser && sb) sb.rpc("count_guest_survey").then(() => {}, () => {});
    ui.celebrate = base && base.completedAt ? celebration(base, survey) : null;
    location.hash = "#/results";
  }

  // What changed between two surveys, for the message on Results.
  function celebration(before, after) {
    const a = footprint(before);
    const b = footprint(after);
    const cats = b.breakdown
      .map((x) => {
        const old = a.breakdown.find((y) => y.key === x.key);
        return { label: x.label, diff: x.yearly - (old ? old.yearly : 0) };
      })
      .filter((c) => Math.abs(c.diff) >= 0.05);
    return { before: a.totalYearly, after: b.totalYearly, saved: a.totalYearly - b.totalYearly, cats };
  }

  // Shown when the Inputs page has changed figures since this survey was taken.
  function newFiguresCard() {
    if (!survey.completedAt || ui.newSurvey) return "";
    const changed = inputsChangedSince(survey);
    if (!changed.length) return "";
    const names = changed.slice(0, 2).map((d) => d.label).join(" and ") + (changed.length > 2 ? " and " + (changed.length - 2) + " more" : "");
    return (
      '<div class="glass new-figures fade-up" role="status"><span class="round-badge">' + icon("refresh") + '</span><div class="grow min0">' +
      '<p class="fw-700">New figures since your survey</p><p class="sm muted">' + esc(names) + " " + (changed.length === 1 ? "has" : "have") +
      " been updated. These results use the figures from when you took the survey; a quick update brings them up to date.</p></div>" +
      '<button type="button" class="btn btn-green btn-sm" data-action="update-figures">Quick update</button></div>'
    );
  }

  function celebrationCard() {
    const c = ui.celebrate;
    if (!c) return "";
    const kg = (n) => (n >= 10 ? kgFmt(n) : n.toFixed(1)) + " kg";
    const down = c.cats.filter((x) => x.diff < 0).sort((x, y) => x.diff - y.diff);
    const close = '<button type="button" class="modal-close" data-action="dismiss-celebrate" aria-label="Dismiss">' + icon("x") + "</button>";
    if (c.saved >= 0.05) {
      const pct = c.before ? (c.saved / c.before) * 100 : 0;
      const km = c.saved / petrolKm();
      const title = c.saved < 25 ? "Every bit counts. Nice one!" : c.saved < 250 ? "Great progress!" : "Brilliant work!";
      return (
        '<div class="card celebrate fade-up" role="status">' + close + '<div class="celebrate-burst" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
        '<span class="eyebrow">' + icon("trendDown") + " Since your last survey</span>" +
        '<h2 class="celebrate-title">' + title + "</h2>" +
        '<p class="celebrate-num"><span>−' + kg(c.saved) + '</span> CO₂e a year</p>' +
        '<p class="sm celebrate-sub">That\'s ' + (pct >= 1 ? Math.round(pct) + "%" : "a little") + " lower, the same as not driving " + kgFmt(Math.max(1, km)) + " km in a petrol car. " +
        (c.saved < 25 ? "Small changes add up when they stick." : "Keep it going.") + "</p>" +
        (down.length ? '<div class="celebrate-chips">' + down.map((x) => '<span class="celebrate-chip">' + esc(x.label) + " −" + kg(-x.diff) + "</span>").join("") + "</div>" : "") +
        "</div>"
      );
    }
    return (
      '<div class="card celebrate quiet fade-up" role="status">' + close +
      '<span class="eyebrow">' + icon("check") + " New survey saved</span>" +
      (c.cats.length
        ? '<h2 class="celebrate-title">Thanks for keeping it honest</h2><p class="sm celebrate-sub">Your footprint is up ' + kg(-c.saved) +
          " a year since last time. Your biggest opportunity is below." +
          (down.length ? " You still cut " + down.map((x) => esc(x.label) + " by " + kg(-x.diff)).join(" and ") + ", so well done there." : "") + "</p>"
        : '<h2 class="celebrate-title">All up to date</h2><p class="sm celebrate-sub">Nothing changed since last time. Your next step is below.</p>') +
      "</div>"
    );
  }

  // ---------- intro / landing page ----------

  const KEY_SEEN_INTRO = "co2_seen_intro";
  // New visitors see the intro first; anyone who has started or finished
  // the survey goes straight to it.
  function showIntroFirst() {
    if (ui.newSurvey || ui.editing || survey.completedAt || lsGet(KEY_SEEN_INTRO, false)) return false;
    return JSON.stringify(survey) === JSON.stringify(normaliseSurvey(null));
  }

  const INTRO_STEPS = [
    ["clipboard", "Take the survey", "Six short steps about your week: meals, travel, flights, home, pets and money."],
    ["chart", "Analyse your footprint", "We turn your answers into a yearly total, compared with the UK average and the 1.5°C budget."],
    ["search", "Find where to improve", "See which parts of your life make up most of your footprint, and where the biggest savings are."],
    ["book", "Learn the best ways", "Clear, ranked next steps for each area, starting with the change that saves the most."],
    ["leaf", "Build habits", "Turn the changes you choose into habits, and watch your footprint fall over time.", true],
  ];

  // The welcome page opens with a scroll story: the typical UK footprint as
  // a disc (area to scale), what it means, where it comes from, and the
  // 1.5°C budget it needs to shrink to. Painted by paintWelcome on scroll.
  function welcomeStory(cta) {
    const uk = ukComparison(footprint(D.UK_TYPICAL_SURVEY)).uk + D.ASSUMED_SHOPPING.totalKg;
    const tree = (D.EVERYDAY_COMPARISONS && D.EVERYDAY_COMPARISONS.treeKgYear) || 22;
    const t = (kg) => (kg / 1000).toFixed(1);
    const cats = ["Meals", "Travel", "Flights", "Home", "Pets", "Money"];
    const steps = [
      ["The typical UK footprint", "About " + t(uk) + " tonnes of CO₂e a year", "What a year of everyday life adds up to: food, travel, home, pets, money and shopping."],
      ["Picture it", kgFmt(uk / tree) + " mature trees", "That's how many trees it takes, working all year, to soak up one person's footprint."],
      ["Where it comes from", "Six parts of everyday life", "Meals, travel, flights, home, pets, and one most calculators miss: where your money sits."],
      ["The 1.5°C budget", "About " + t(D.BUDGET_YEARLY) + " t each", "To stay on track for 1.5°C, footprints like this need to fall to about " + t(D.BUDGET_YEARLY) + " t by 2030. Find your biggest levers in six short steps."],
    ];
    return (
      '<div class="wl" data-step="0" style="--b:' + Math.sqrt(D.BUDGET_YEARLY / uk).toFixed(4) + '" data-uk="' + Math.round(uk) + '">' +
      '<section class="wl-open"><span class="story-k">Free for everyone · no ads</span>' +
      '<h1 class="display wl-title">Know your footprint.<br><span>Shrink it,</span> one habit at a time.</h1>' +
      '<p class="wl-lead">Answer six short steps about your week. We estimate your yearly carbon footprint, show where it really comes from, and point you to the changes that make the biggest difference for you.</p>' +
      '<div class="wl-ctas">' + cta(survey.completedAt ? "Update my survey" : "Start the survey") + '<a class="btn wl-ghost" href="/example/">See an example result</a></div>' +
      '<div class="wl-trust">' + ["No account needed to start", "Answers save as you go", "We never sell your data"].map((x) => "<span>" + icon("check") + x + "</span>").join("") + "</div>" +
      '<span class="story-cue" aria-hidden="true"><i></i></span></section>' +
      '<section class="wl-track" style="--n:' + steps.length + '"><div class="story-stage wl-stage">' +
      '<div class="story-orb wl-orb" aria-hidden="true"><i class="story-ghost"></i><i class="story-disc"></i><i class="story-budget"></i>' +
      '<span class="story-budget-l">1.5°C budget · ' + t(D.BUDGET_YEARLY) + " t</span>" +
      '<span class="story-read"><b class="display tnum wl-kg">' + t(uk) + " t</b><small>a year</small></span>" +
      cats.map((c, i) => { const a = (i / cats.length) * Math.PI * 2 - Math.PI / 2; return '<span class="wl-cat" style="--cx:' + Math.cos(a).toFixed(3) + ";--cy:" + Math.sin(a).toFixed(3) + ";--k:" + i + '">' + c + "</span>"; }).join("") +
      "</div>" +
      '<ol class="story-steps wl-steps">' + steps.map((st, i) => '<li data-i="' + i + '"' + (i ? "" : ' class="on"') + '><span class="story-k">' + esc(st[0]) + '</span><h2 class="display">' + esc(st[1]) + "</h2><p>" + esc(st[2]) + "</p>" + (i === steps.length - 1 ? '<div class="wl-ctas">' + cta(survey.completedAt ? "Update my survey" : "Start the survey") + "</div>" : "") + "</li>").join("") + "</ol>" +
      '<div class="story-ticks" aria-hidden="true">' + steps.map((_, i) => '<span style="--k:' + i + '"></span>').join("") + "</div>" +
      "</div></section></div>"
    );
  }
  function paintWelcome() {
    const wl = app.querySelector(".wl");
    if (!wl) return;
    const track = wl.querySelector(".wl-track");
    const open = wl.querySelector(".wl-open");
    const r = track.getBoundingClientRect();
    const n = 4;
    const tp = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - innerHeight)));
    const ip = Math.min(1, Math.max(0, -open.getBoundingClientRect().top / (open.offsetHeight * 0.8)));
    const step = Math.min(n - 1, Math.floor(tp * n));
    // The disc holds at the UK size, then shrinks to the budget in the last step.
    const f = Math.min(1, Math.max(0, tp * n - (n - 1) + 0.2) / 0.7);
    const shrink = fsReduce() ? (step === n - 1 ? 1 : 0) : f * f * (3 - 2 * f);
    const uk = Number(wl.dataset.uk), b = D.BUDGET_YEARLY;
    const kg = uk + (b - uk) * shrink;
    wl.style.setProperty("--ip", ip.toFixed(4));
    wl.style.setProperty("--tp", tp.toFixed(4));
    wl.style.setProperty("--s", Math.sqrt(kg / uk).toFixed(4));
    wl.style.setProperty("--q", (1 - kg / uk).toFixed(4));
    wl.classList.toggle("under", shrink > 0.98);
    wl.querySelector(".wl-kg").textContent = (kg / 1000).toFixed(1) + " t";
    // While the story fills the screen, the top bar goes dark and the phone's
    // sticky "Start the survey" bar waits (the story has its own buttons).
    const wr = wl.getBoundingClientRect();
    const bar = document.querySelector(".topbar");
    if (bar) bar.classList.toggle("on-dark", wr.top < 40 && wr.bottom > 64);
    document.body.classList.toggle("wl-in", wr.bottom > innerHeight * 0.6);
    if (wl.dataset.step !== String(step)) {
      wl.dataset.step = String(step);
      wl.querySelectorAll(".wl-steps li").forEach((li, i) => { li.classList.toggle("on", i === step); li.classList.toggle("past", i < step); });
    }
  }

  function renderIntro() {
    const cta = (label) => '<button type="button" class="btn btn-green intro-cta" data-action="start-survey">' + label + " " + icon("arrowRight") + "</button>";
    const faq = [
      ["Do I need an account?", "You can take the whole survey as a guest. To see your full results, create a free account: it also keeps your answers safe across your devices."],
      ["How accurate is it?", "It's an estimate using typical lifecycle emission factors. It's built to show your biggest levers clearly, not to be a precise audit."],
      ["How is it free?", (isNativeApp() ? "It's free, with no ads. Some" : "Supporters chip in £2 a year, and some") + ' partner links (marked "Affiliate") may earn us a small commission at no cost to you. Partners never change your figures. <a href="/about/">About us</a> · <a href="/greener-switches/">Greener switches</a>'],
    ];
    return (
      '<div class="container intro-v2">' +
      welcomeStory(cta) +
      '<section class="intro-mission"><div class="intro-sec-head"><div><span class="eyebrow">Our mission</span><h2 class="display">From "what\'s my footprint?" to habits that stick</h2></div>' +
      "<p>Most people don't know where their emissions really come from. We make it clear, then make it doable.</p></div>" +
      '<ol class="mission">' +
      INTRO_STEPS.map(
        ([ic, t, b, soon], i) =>
          '<li class="glass mission-step" style="--i:' + i + '"><span class="mission-dot display">' + (i + 1) + '</span><span class="mission-icon">' + icon(ic) + "</span>" +
          '<h3 class="display">' + t + "</h3><p>" + b + "</p>" + (soon ? '<span class="nav-soon">Daily habits soon</span>' : "") + "</li>"
      ).join("") +
      "</ol></section>" +
      '<section class="intro-split"><div><h2 class="display">What we look at</h2><p>Six parts of everyday life, including one most calculators miss: where your money sits.</p><ul class="intro-chips">' +
      STEPS.map((st) => "<li>" + st.icon + esc(st.title) + "</li>").join("") +
      '</ul></div><div class="intro-why"><span class="eyebrow">Why it matters</span><span class="display intro-why-num">{{budget_t}} t</span>' +
      "<p>is roughly each person's yearly share of CO₂e if we're to keep warming to 1.5°C. Most of us in the UK are well above it, and small, repeated changes are how we close the gap. <a href=\"/budget/\">What it covers</a></p></div></section>" +
      '<section class="intro-cards">' +
      [
        ["chart", "Built on official figures", 'We use UK government emission factors and published data from sources like DESNZ, Defra, Ofgem and the ONS. <a href="/how-we-calculate/">How we calculate</a>'],
        ["shield", "Your data stays yours", "No ads, and we never sell your data. Answers stay on your device until you choose to create an account."],
        isNativeApp()
          ? ["heart", "Free, with no ads", "Everything in CO2 Counter is free. No ads, and we never sell your data."]
          : ["heart", "Free, kept going by supporters", "Everything is free. If it helps you, you can chip in £2 a year to cover running costs."],
      ].map(([ic, t, b]) => '<div class="glass intro-card"><span class="cat-badge">' + icon(ic) + '</span><h3 class="display">' + t + "</h3><p>" + b + "</p></div>").join("") +
      "</section>" +
      '<section class="intro-faq"><h2 class="display">Questions people ask</h2>' +
      faq.map(([q, a]) => '<details class="glass faq"><summary><span>' + q + "</span>" + icon("chevronDown") + "</summary><p>" + a + "</p></details>").join("") +
      "</section>" +
      '<div class="intro-sticky">' + cta(survey.completedAt ? "Update my survey" : "Start the survey") + "</div></div>"
    );
  }

  // Results for a typical UK resident, so people can see what they'll get.
  function renderExample() {
    const own = survey;
    const typical = JSON.parse(JSON.stringify(D.UK_TYPICAL_SURVEY));
    survey = normaliseSurvey(typical);
    survey.flights = typical.flights;
    survey.meals = typical.meals;
    ui.exampleMode = true;
    try {
      return renderResults();
    } finally {
      ui.exampleMode = false;
      survey = own;
    }
  }

  // ---------- "Anything changed?" review ----------

  const STEP_FIELDS = { meals: ["meals"], commute: ["car", "cars", "commute", "extraTravel", "longTrips"], flights: ["flights"], energy: ["energy", "water"], pets: ["pets"], banking: ["banking"] };
  const STEP_BREAKDOWN = { energy: ["energy", "water"] };
  const stepChanged = (key) => STEP_FIELDS[key].some((f) => JSON.stringify(ui.draft[f] || null) !== JSON.stringify(ui.prevSurvey[f] || null));
  const stepKg = (key, s) => footprint(s).breakdown.filter((b) => (STEP_BREAKDOWN[key] || [key]).includes(b.key)).reduce((sum, b) => sum + b.yearly, 0);
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

  function countLabels(options, values) {
    const counts = {};
    values.filter(Boolean).forEach((v) => (counts[v] = (counts[v] || 0) + 1));
    return Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .map((k) => {
        const o = byKey(options, k);
        return counts[k] + "× " + ((o && o.label) || k);
      })
      .join(", ");
  }

  // Plain-language lines describing someone's answers for one survey step.
  function answerSummary(key, s) {
    if (key === "meals") {
      const m = s.meals || {};
      const diet = byKey(D.DIETS, m.diet);
      const waste = byKey(D.FOOD_WASTE, m.foodWaste || "low");
      return [
        (diet ? diet.label + ": " : "") + (countLabels(D.MEAL_OPTIONS, DAYS.map((d) => m[d])) || "No meals chosen"),
        "Eat out " + ((m.eatOut || 0) >= 7 ? "every day" : (m.eatOut || 0) + "× a week") + " · " + (waste ? waste.title : "Hardly any") + " food wasted",
      ];
    }
    if (key === "commute") {
      const c = s.commute || {};
      const extra = (s.extraTravel || []).length;
      const long = (s.longTrips || []).length;
      const cars = ownedCars(s);
      const carLine = !s.car || !s.car.owns ? [] : !cars.length ? ["No car"] : [cars.map((x) => carLabel(x) + (Number(x.miles) > 0 ? ", " + kgFmt(Number(x.miles)) + " miles a year" : "")).join(" · ")];
      return carLine.concat([
        (countLabels(D.COMMUTE_MODES, DAYS.map((d) => c[d])) || "No commute days") + " · " + (c.distance || 0) + " km each way",
        extra || long ? [extra ? plural(extra, "weekly trip") : "", long ? plural(long, "long journey") : ""].filter(Boolean).join(" · ") : "No extra trips or long journeys",
      ]);
    }
    if (key === "flights") {
      const f = (s.flights || []).filter((x) => flightKm(x.from, x.to) > 0);
      if (!f.length) return ["No flights"];
      return [f.slice(0, 3).map(routeLabel).join(", ") + (f.length > 3 ? " and " + (f.length - 3) + " more" : "")];
    }
    if (key === "energy") {
      const e = s.energy || {};
      return [
        Math.round(e.electricityKwh || 0).toLocaleString() + " kWh electricity, " + Math.round(e.gasKwh || 0).toLocaleString() + " kWh gas a month" + (e.greenTariff ? " · green tariff" : e.billPayer === "other" ? " · someone else chooses the supplier" : ""),
        ((e.household || 1) === 1 ? "1 person" : (e.household || 1) + " people") + " at home · " + Math.round((s.water && s.water.liters) || 0).toLocaleString() + " L water a month",
      ];
    }
    if (key === "pets") {
      const p = s.pets || {};
      return [petWords(p)];
    }
    if (key === "banking") {
      const b = s.banking || {};
      const bank = byKey(D.BANKS, b.bank);
      const pension = byKey(D.PENSION_PROVIDERS, b.pensionProvider);
      return [
        (bank ? bank.label : "Bank not chosen") + " · £" + (b.amount || 0).toLocaleString(),
        pension && pension.unfunded ? "Pension: " + pension.label : b.pensionPot ? "Pension: " + (pension ? pension.label : "provider not chosen") + " · £" + b.pensionPot.toLocaleString() : "No pension added",
      ].concat(moneyExtras(b).length ? ["+ " + moneyExtras(b).length + (moneyExtras(b).length === 1 ? " more account or pension" : " more accounts or pensions")] : []);
    }
    return [];
  }

  function renderReview() {
    const before = footprint(ui.prevSurvey).totalYearly;
    const now = footprint(ui.draft).totalYearly;
    const diff = now - before;
    const anyChanged = STEPS.some((st) => stepChanged(st.key));
    const when = Date.parse(ui.prevSurvey.completedAt);
    const date = isNaN(when) ? "last time" : new Date(when).toLocaleDateString(undefined, { day: "numeric", month: "long" });
    const delta = !anyChanged
      ? '<span class="review-pill">No changes yet</span>'
      : Math.abs(diff) < 0.05
      ? '<span class="review-pill">Same total</span>'
      : '<span class="review-pill ' + (diff < 0 ? "down" : "up") + '">' + (diff < 0 ? "▼ " : "▲ ") + kgFmt(Math.abs(diff)) + " kg</span>";
    return (
      '<div class="container narrow review-page">' +
      '<div class="review-hero fade-up"><span class="eyebrow">New survey · the quick way</span>' +
      '<h1 class="review-title">Anything changed?</h1>' +
      '<p class="sm review-lead">Here are your answers from ' + esc(date) + ". Tap anything that's different. Everything else carries over.</p>" +
      '<div class="review-stat"><span class="review-num">' + kgFmt(now) + '</span><span class="xs">kg CO₂e a year</span>' + delta + "</div></div>" +
      '<div class="review-group fade-up">' +
      STEPS.map((st, i) => {
        const changed = stepChanged(st.key);
        const kgNow = stepKg(st.key, ui.draft);
        const kgWas = stepKg(st.key, ui.prevSurvey);
        return (
          '<button type="button" class="review-item' + (changed ? " changed" : "") + '" data-action="review-edit" data-step="' + i + '">' +
          '<span class="review-icon">' + st.icon + "</span>" +
          '<span class="review-main"><span class="review-name">' + esc(st.title) + (changed ? '<span class="review-dot" aria-label="Updated"></span>' : "") + "</span>" +
          '<span class="review-detail">' + esc(answerSummary(st.key, ui.draft).join(" · ")) + "</span></span>" +
          '<span class="review-side"><span class="review-kg">' + kgFmt(kgNow) + "<small> kg</small></span>" +
          (changed && Math.round(kgWas) !== Math.round(kgNow) ? '<span class="review-was">was ' + kgFmt(kgWas) + "</span>" : "") +
          "</span>" + icon("chevronRight", "review-chev") + "</button>"
        );
      }).join("") +
      "</div>" +
      '<p class="xs muted center mt-4">This counts as a new survey, so it\'s added to your history and progress.</p>' +
      '<div class="review-bar"><button type="button" class="btn btn-ghost" data-action="cancel-new-survey">Cancel</button>' +
      '<button type="button" class="btn btn-green" data-action="review-save">' + icon("check") + (anyChanged ? " Save new survey" : " Nothing's changed: save") + "</button></div></div>"
    );
  }

  function renderSurvey() {
    if (ui.newSurvey && ui.reviewing) return renderReview();
    if (survey.completedAt && !ui.editing) return renderSurveyDone();
    const step = STEPS[ui.step];
    const n = STEPS.length;
    const qKey = ui.step + ":" + (ui.q || 0);
    qAnimate = ui.shownStep !== qKey;
    ui.shownStep = qKey;
    // Render the step first: it sets how many questions it has (ui.qCount).
    const body = step.render();
    const qMore = ui.q < (ui.qCount || 1) - 1;
    const pct = Math.round(((ui.step + (ui.q + 1) / (ui.qCount || 1)) / n) * 100);
    const tabs = STEPS.map((s, i) => {
      const on = i === ui.step;
      const done = !on && i < ui.step;
      return (
        '<button type="button" class="' + (on ? "on" : "") + '" data-action="goto-step" data-step="' + i + '"' + (on ? ' aria-current="step"' : "") + ">" +
        '<span class="tab-dot' + (on ? " on" : done ? " done" : "") + '">' + (done ? icon("check") : i + 1) + "</span>" + esc(STEP_TAB[s.key] || s.title) + "</button>"
      );
    }).join("");
    const last = ui.step === n - 1;
    const prev = STEPS[ui.step - 1];
    const next = STEPS[ui.step + 1];
    const kg = stepKg(step.key, survey);
    const newBanner = ui.fromReview
      ? '<div class="panel p-4 mb-5 row-between gap-3" style="flex-wrap:wrap"><p class="sm">Update what\'s changed, then go back to your summary.</p>' +
        '<button type="button" class="btn btn-green btn-sm" data-action="review-back">' + icon("check") + " Back to summary</button></div>"
      : ui.newSurvey
      ? '<div class="panel p-4 mb-5 row-between gap-3" style="flex-wrap:wrap"><p class="sm">You\'re taking a new survey. Your previous results stay saved until you finish, and are kept in your history.</p>' +
        '<button type="button" class="btn btn-outline btn-sm" data-action="cancel-new-survey">' + icon("x") + " Cancel new survey</button></div>"
      : "";
    return (
      '<div class="container survey-v2" data-fs-key="' + qKey + '" data-fs-from="' + (ui.step / n).toFixed(4) + '" data-fs-to="' + ((ui.step + 1) / n).toFixed(4) +
      '" data-fs-pill="Step ' + (ui.step + 1) + " of " + n + " · " + kgFmt(kg) + '" data-fs-unit="kg">' + newBanner +
      '<nav class="section-tabs" aria-label="Survey steps">' + tabs + "</nav>" +
      '<header class="glass step-hero' + (qAnimate ? " rise" : "") + '"><span class="cat-watermark" aria-hidden="true">' + step.icon + "</span>" +
      '<div class="step-hero-main"><span class="eyebrow">Step ' + (ui.step + 1) + " of " + n + "</span>" +
      '<h1 class="cat-title display">' + esc(step.title) + '</h1><p class="cat-why">' + esc(STEP_INTRO[step.key] || step.subtitle) + "</p></div>" +
      '<div class="cat-hero-side"><div class="cat-figs"><div class="step-kg display tnum">' + kgFmt(kg) + '</div><div class="muted">kg CO₂e a year so far</div></div>' +
      '<figure class="cat-share"><svg viewBox="0 0 42 42" role="img" aria-label="Step ' + (ui.step + 1) + " of " + n + '"><circle cx="21" cy="21" r="20" fill="rgba(63,91,58,.12)"></circle>' +
      '<circle cx="21" cy="21" r="10" fill="none" stroke="#3F5B3A" stroke-width="20" pathLength="100" stroke-dasharray="' + pct + ' 100" transform="rotate(-90 21 21)"></circle></svg>' +
      "<figcaption><span>" + (ui.step + 1) + " of " + n + " steps</span></figcaption></figure></div></header>" +
      '<div class="step-body">' + body + "</div>" +
      '<div class="step-nav-v2">' +
      (ui.q > 0
        ? '<button type="button" class="btn btn-outline" data-action="prev-step">' + icon("chevronLeft") + " Back</button>"
        : prev
        ? '<button type="button" class="btn btn-outline" data-action="prev-step">' + icon("chevronLeft") + ' Back<span class="nav-lbl">: ' + esc(STEP_TAB[prev.key]) + "</span></button>"
        : ui.newSurvey || ui.editing ? '<a class="btn btn-outline" href="#/results">Back to results</a>' : "<span></span>") +
      '<button type="button" class="btn btn-green" data-action="next-step">' +
      (qMore ? "Next question" : last ? (ui.editing ? "Save and see results" : "See my results") : "Next: " + esc(STEP_TAB[next.key])) + " " + icon("chevronRight") + "</button>" +
      "</div></div>"
    );
  }

  const STEP_TAB = { meals: "Meals", commute: "Commute", flights: "Flights", energy: "Home & water", pets: "Pets", banking: "Money" };
  const STEP_INTRO = {
    meals: "Food is often the biggest part of a footprint.",
    commute: "How you get around day to day. It repeats over 200 times a year, so it adds up.",
    flights: "Flights are rare but large. Add the trips you took in the last 12 months.",
    energy: "Your energy and water use. Have a recent bill handy if you can.",
    pets: "A few quick counts. Most of a pet's footprint is its food.",
    banking: "Where your money sits can matter as much as what you buy.",
  };

  function optionCard(selected, attrs, inner, extraCls) {
    return (
      '<button type="button" class="option-card ' + (extraCls || "") + (selected ? " selected" : "") + '" ' + attrs + ">" + inner + "</button>"
    );
  }

  // ---------- numbered question cards ----------

  // Cards fade in when a step opens, not every time an answer changes.
  let qAnimate = false;

  // One question: a numbered badge, the question, a hint and its answers.
  function qCard(n, title, hint, body, opts) {
    const o = opts || {};
    return (
      '<li class="q' + (qAnimate ? " q-in" : "") + (o.note ? " q-note" : "") + '">' +
      '<span class="qn' + (n === 1 && !o.note ? " lead" : "") + '">' + (o.note ? icon("info") : n) + "</span>" +
      '<div class="min0"><h2 class="qt">' + title + (o.optional ? ' <span class="q-opt">Optional</span>' : "") + "</h2>" +
      (hint ? '<p class="qh">' + hint + "</p>" : "") + (body ? '<div class="q-body">' + body + "</div>" : "") + "</div></li>"
    );
  }
  // One question at a time: a step's questions show one by one, with Next
  // and Back moving between them (ui.q). "Good to know" notes stay with the
  // question before them (or the first one).
  const isNote = (c) => /^<li class="q[^"]*\bq-note\b/.test(c);
  function qList(cards) {
    const groups = [];
    let lead = [];
    cards.filter(Boolean).forEach((c) => {
      if (isNote(c)) groups.length ? groups[groups.length - 1].push(c) : lead.push(c);
      else {
        groups.push(lead.concat(c));
        lead = [];
      }
    });
    if (lead.length) groups.length ? groups[groups.length - 1].push(...lead) : groups.push(lead);
    const n = Math.max(1, groups.length);
    ui.qCount = n;
    ui.q = Math.min(Math.max(0, ui.q || 0), n - 1);
    const dots =
      n > 1
        ? '<div class="q-progress" role="img" aria-label="Question ' + (ui.q + 1) + " of " + n + '"><span class="q-progress-n">Question ' + (ui.q + 1) + " of " + n + "</span>" +
          '<span class="q-dots">' + groups.map((_, i) => '<i class="' + (i < ui.q ? "done" : i === ui.q ? "on" : "") + '"></i>').join("") + "</span></div>"
        : "";
    return dots + '<ol class="q-list one">' + (groups[ui.q] || []).join("") + "</ol>";
  }
  const goodToKnow = (text) => qCard(0, "Good to know", text, "", { note: true });

  // A number with − and + buttons either side.
  function stepper(field, value, step, min, unit, label) {
    return (
      '<div class="stepper"><button type="button" class="step-btn" data-action="step-field" data-field="' + field + '" data-delta="' + -step + '" data-min="' + min +
      '" aria-label="Less">' + icon("minus") + '</button><input class="stepper-input display tnum" type="number" inputmode="decimal" min="' + min + '" value="' + esc(value) +
      '" data-field="' + field + '" aria-label="' + esc(label) + '" /><button type="button" class="step-btn" data-action="step-field" data-field="' + field + '" data-delta="' + step +
      '" data-min="' + min + '" aria-label="More">' + icon("plus") + "</button>" + (unit ? '<span class="muted">' + unit + "</span>" : "") + "</div>"
    );
  }

  const fieldInput = (field, value, unit, label, prefix) =>
    '<div class="field-row">' + (prefix ? '<span class="display field-prefix">' + prefix + "</span>" : "") +
    '<input class="input field-big tnum" type="number" min="0" inputmode="numeric" value="' + esc(value) + '" data-field="' + field + '" aria-label="' + esc(label) + '" />' +
    (unit ? '<span class="muted">' + unit + "</span>" : "") + "</div>";

  const chip = (on, attrs, label, sub) =>
    '<button type="button" class="q-chip' + (on ? " on" : "") + '" aria-pressed="' + !!on + '" ' + attrs + ">" + label + (sub ? '<span class="q-chip-sub tnum">' + sub + "</span>" : "") + "</button>";

  const DAY_NAMES = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
  // Colour dot for a day: clay for the heaviest, honey, sage, then moss.
  const dayDot = (kg, hi, mid, lo) => (kg >= hi ? "#B8653D" : kg >= mid ? "#D9A441" : kg >= lo ? "#8FA58A" : "#3F5B3A");

  function renderMealsStep() {
    const m = survey.meals;
    const diet = m.diet || "";
    const cards = [];
    cards.push(
      qCard(
        1,
        "What's your overall diet?",
        "Mix it up? Choose <strong>Meat eater</strong>.",
        '<div class="q-grid">' +
          D.DIETS.map((d) =>
            optionCard(diet === d.key, 'data-action="set-diet" data-key="' + d.key + '"', '<span class="opt-title display">' + esc(d.label) + '</span><span class="opt-sub">' + esc(d.desc) + "</span>", "q-opt-card")
          ).join("") +
          "</div>"
      )
    );
    let n = 2;
    if (diet === "meat_eater") {
      // A rough week, not specific days: how many days each main meal.
      const counts = mealDayCounts(survey);
      const total = Object.values(counts).reduce((t, v) => t + v, 0);
      const rows = D.MEAL_OPTIONS.map((o) => {
        const c = counts[o.key] || 0;
        return (
          '<li class="meal-row' + (c ? " on" : "") + '"><i class="meal-dot" style="background:' + dayDot(o.factor, 8, 3, 2) + '" aria-hidden="true"></i>' +
          '<span class="min0 grow"><b>' + esc(o.label) + '</b><span class="xs muted tnum">' + o.factor.toFixed(2) + " kg a meal</span></span>" +
          '<span class="meal-step"><button type="button" class="step-btn" data-action="meal-count" data-key="' + o.key + '" data-delta="-1" aria-label="Fewer ' + esc(o.label) + ' days"' + (c ? "" : " disabled") + ">" + icon("minus") + "</button>" +
          '<b class="display tnum" aria-live="polite">' + c + "</b>" +
          '<button type="button" class="step-btn" data-action="meal-count" data-key="' + o.key + '" data-delta="1" aria-label="More ' + esc(o.label) + ' days"' + (total < 7 ? "" : " disabled") + ">" + icon("plus") + "</button></span></li>"
        );
      }).join("");
      const top = D.MEAL_OPTIONS.filter((o) => counts[o.key]).sort((a, b) => b.factor - a.factor)[0];
      const veg = byKey(D.MEAL_OPTIONS, "veggie");
      const tip =
        total === 7 && top && veg && top.factor > veg.factor * 2
          ? '<p class="q-tip">Swapping one ' + esc(top.label.toLowerCase()) + " day a week for a vegetarian meal would save about " + kgFmt((top.factor - veg.factor) * D.WEEKS_PER_YEAR) + " kg a year.</p>"
          : "";
      cards.push(
        qCard(
          n++,
          "How many days a week is your main meal…",
          "",
          '<p class="meal-total"><b class="tnum">' + total + " of 7 days</b>" + (total < 7 ? '<span class="muted"> · ' + (7 - total) + " to go</span>" : ' <span class="green-dark">' + icon("check") + "</span>") + "</p>" +
            '<ul class="meal-rows">' + rows + "</ul>" + tip
        )
      );
    }
    if (diet) {
      cards.push(
        qCard(
          n++,
          "How often do you eat out or get a takeaway?",
          "",
          '<div class="chip-wrap">' + D.EAT_OUT_OPTIONS.map((o) => chip((m.eatOut || 0) === o.value, 'data-action="set-eatout" data-value="' + o.value + '"', esc(o.label))).join("") + "</div>"
        )
      );
      cards.push(
        qCard(
          n++,
          "How much of your food ends up thrown away?",
          "A rough guess is fine.",
          '<div class="q-grid">' +
            D.FOOD_WASTE.map((o) =>
              optionCard((m.foodWaste || "low") === o.key, 'data-action="set-waste" data-key="' + o.key + '"', '<span class="opt-title display">' + esc(o.title) + '</span><span class="opt-sub tnum">' + esc(o.range) + "</span>", "q-opt-card")
            ).join("") +
            "</div>"
        )
      );
    }
    return qList(cards);
  }

  function renderCommuteStep() {
    const c = survey.commute;
    const distance = c.distance == null ? 10 : c.distance;
    const day = DAYS.includes(ui.commuteOpen) ? ui.commuteOpen : DAYS.find((d) => !c[d]) || "Mon";
    const cur = byKey(D.COMMUTE_MODES, c[day]);
    const perDay = (o) => o.factor * distance * 2;
    const days =
      '<div class="day-pick">' +
      DAYS.map((d) => {
        const o = byKey(D.COMMUTE_MODES, c[d]);
        const kg = o ? perDay(o) : 0;
        return (
          '<button type="button" class="day-btn' + (d === day ? " on" : "") + '" data-action="toggle-commute" data-day="' + d + '" aria-pressed="' + (d === day) +
          '" aria-label="' + DAY_NAMES[d] + ": " + (o ? esc(o.label) : "not chosen") + '"><span class="display">' + d + "</span>" +
          '<i style="background:' + (o ? dayDot(kg, 3, 1.5, 0.01) : "transparent") + '"' + (o ? "" : ' class="empty"') + "></i>" +
          '<span class="day-val">' + (o ? esc(o.label) : "Choose") + '</span><span class="day-kg tnum">' + (o && distance > 0 ? kg.toFixed(2) + " kg" : "") + "</span></button>"
        );
      }).join("") +
      "</div>";
    const train = byKey(D.COMMUTE_MODES, "train");
    const tip =
      cur && MOTOR_MODES.includes(cur.key) && distance > 0
        ? '<p class="q-tip">Taking the train on ' + DAY_NAMES[day] + "s instead would save about " +
          kgFmt((perDay(cur) - perDay(train)) * D.WEEKS_PER_YEAR) + " kg a year" +
          (distance <= A.ACTIVE_TRAVEL_MAX_KM ? ", and walking or cycling about " + kgFmt(perDay(cur) * D.WEEKS_PER_YEAR) + " kg." : ".") + "</p>"
        : "";
    return qList([
      qCard(1, "Do you own or lease a car?", "Count a company car too. Making a car has a big footprint of its own, so we spread it over the years a car lasts.", renderCars()),
      qCard(2, "How far is your commute, one way?", "A rough figure is fine. We count there and back.", stepper("commute.distance", distance, 1, 0, "km", "One-way distance in km") + commuteFinder()),
      qCard(
        3,
        "How did you get there each day?",
        "Pick a day, then how you travelled. Leave a day as it is if you didn't commute.",
        days +
          '<div class="q-sub"><p class="q-sub-title display">' + DAY_NAMES[day] + '</p><div class="chip-wrap">' +
          D.COMMUTE_MODES.map((o) => chip(c[day] === o.key, 'data-action="set-commute" data-day="' + day + '" data-key="' + o.key + '"', esc(o.label), distance > 0 ? perDay(o).toFixed(2) + " kg" : "")).join("") +
          "</div>" + tip + "</div>"
      ),
      qCard(0, "Work shifts?", nightNote, "", { note: true }),
      qCard(4, "Any other regular travel each week?", "Trips outside your commute, like the school run, the weekly shop or visiting family. A rough weekly total is fine.", renderExtraTravel(), { optional: true }),
      qCard(5, "Long journeys by land this year?", "Trains or drives like London to Cornwall or Scotland. Type where you go from and to, and we'll work out the distance. Flights come in the next step.", renderLongTrips(), { optional: true }),
    ]);
  }

  const carLabel = (c) => (byKey(D.CAR_SIZES, carSize(c)) || {}).label + " " + carType(c).label.toLowerCase() + " car";

  // Optional: yearly miles from the number plate's MOT history (the
  // mot-lookup function). Shown only once it's set up, and only signed in.
  function motFinder(i) {
    if (currentUser && ui.motEnabled === undefined && sb) {
      ui.motEnabled = null;
      fetch(SUPABASE_URL + "/functions/v1/mot-lookup", { method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }, body: '{"ping":true}' })
        .then((r) => r.json())
        .then((o) => {
          ui.motEnabled = !!(o && o.enabled);
          if (ui.motEnabled) render();
        })
        .catch(() => (ui.motEnabled = false));
    }
    if (!currentUser || !ui.motEnabled) return "";
    const st = (ui.mot || {})[i] || {};
    return (
      '<form class="mot-form mt-2" id="mot-form-' + i + '" data-car-index="' + i + '"><label class="xs fw-700" for="mot-reg-' + i + '">Or find the miles from your number plate</label>' +
      '<span class="mot-row"><input class="input mot-reg" id="mot-reg-' + i + '" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AB12 CDE" value="' + esc(st.reg || "") + '" />' +
      '<button type="submit" class="btn btn-outline btn-sm"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Looking…" : "Look up") + "</button></span>" +
      (st.msg ? '<span class="xs ' + (st.ok ? "green-dark fw-700" : "red") + '" role="status">' + esc(st.msg) + "</span>" : "") +
      '<span class="xs muted">From its MOT history (DVSA). We don\'t save the number plate.</span></form>'
    );
  }
  const motFuel = (f) => (/plug|phev/i.test(f) ? "phev" : /hybrid/i.test(f) ? "hybrid" : /electric/i.test(f) ? "ev" : /diesel/i.test(f) ? "diesel" : /petrol/i.test(f) ? "petrol" : "");

  function renderCars() {
    const owns = survey.car && survey.car.owns;
    const yesNo =
      '<div class="chip-wrap">' +
      chip(owns === "yes", 'data-action="set-car-owns" data-value="yes"', "Yes") +
      chip(owns === "no", 'data-action="set-car-owns" data-value="no"', "No") +
      "</div>";
    if (owns !== "yes") return yesNo;
    const sum = carYearly(survey);
    const rows = survey.cars
      .map((c, i) => {
        const make = carMakeYearly(c);
        const share = Math.max(1, Number(c.share) || 1);
        const total = carType(c)["make_" + carSize(c)];
        const chips = (list, field, value, sub) =>
          '<div class="chip-wrap mt-1">' +
          list.map((o) => chip(value === o.key, 'data-action="set-car" data-index="' + i + '" data-key="' + field + '" data-value="' + o.key + '"', esc(o.label), sub ? sub(o) : "")).join("") +
          "</div>";
        return (
          '<div class="panel p-4 car-card"><p class="q-sub-title display">' + (survey.cars.length > 1 ? "Car " + (i + 1) : "Your car") + "</p>" +
          '<label class="xs">Fuel</label>' + chips(D.CAR_TYPES, "fuel", carType(c).key) +
          '<label class="xs mt-3 block">Size</label>' + chips(D.CAR_SIZES, "size", carSize(c), (o) => o.hint) +
          '<div class="travel-row mt-3"><div class="w-150"><label class="xs">People who share it</label><input class="input mt-1" type="number" min="1" inputmode="numeric" value="' + esc(share) +
          '" data-car="' + i + '" data-key="share" aria-label="People who share this car" /></div>' +
          '<div class="grow minw-160"><label class="xs">Miles you drive it a year <span class="muted">(optional)</span></label><input class="input mt-1" type="number" min="0" inputmode="numeric" placeholder="e.g. 7,000" value="' +
          esc(Number(c.miles) > 0 ? c.miles : "") + '" data-car="' + i + '" data-key="miles" aria-label="Miles you drive this car a year" /></div></div>' +
          motFinder(i) +
          '<p class="xs muted mt-2">Making it: about ' + kgFmt(total) + " kg CO₂e, spread over " + A.CAR_LIFE_YEARS + " years" + (share > 1 ? " and split " + share + " ways" : "") +
          ' = <strong class="tnum">' + kgFmt(make) + " kg a year</strong>. That's the same whether you bought it new or used: each year of its life carries a share.</p>" +
          '<div class="row-between journey-foot mt-3"><span></span><span class="label-row">' +
          '<button type="button" class="dup-btn" data-action="dup-car" data-index="' + i + '" aria-label="Duplicate this car">' + icon("copy") + "Duplicate</button>" +
          '<button type="button" class="icon-btn danger-hover" data-action="remove-car" data-index="' + i + '" aria-label="Remove car">' + icon("trash") + "</button></span></div></div>"
        );
      })
      .join("");
    const mi = (km) => kgFmt(km / D.KM_PER_MILE);
    const mileNote =
      sum.mileKm <= 0
        ? '<p class="xs muted mt-3">Not sure of your mileage? Your MOT history shows the reading each year: <a href="https://www.gov.uk/check-mot-history" target="_blank" rel="noopener">check it on GOV.UK</a>. Without it, we count the driving in your commute and trips below.</p>'
        : sum.otherKm > 0
          ? '<p class="xs muted mt-3">Your commute and trips below cover about ' + mi(sum.tripKm) + " of your " + mi(sum.mileKm) + " miles. We count the other " + mi(sum.otherKm) +
            ' miles as other driving: <strong class="tnum">' + kgFmt(sum.other) + " kg a year</strong>.</p>"
          : '<p class="xs muted mt-3">Your commute and trips below already add up to ' + mi(sum.tripKm) + " miles or more, so we count those and nothing extra.</p>";
    return (
      yesNo +
      (rows ? '<div class="stack-3 mt-3">' + rows + "</div>" : "") +
      '<button type="button" class="q-add mt-3" data-action="add-car">' + icon("plus") + " Add another car</button>" +
      mileNote
    );
  }

  function travelModeSelect(kind, i, value) {
    return (
      '<select class="input mt-1" data-travel="' + kind + '" data-index="' + i + '" data-key="mode">' +
      D.TRAVEL_MODES.map((m) => '<option value="' + m.key + '"' + (m.key === value ? " selected" : "") + ">" + esc(m.label) + "</option>").join("") +
      "</select>"
    );
  }

  function renderExtraTravel() {
    const rows = survey.extraTravel
      .map((x, i) => {
        const kg = travelFactor(x.mode) * (Number(x.km) || 0);
        return (
          '<div class="travel-row"><div class="grow minw-160"><label class="xs">How</label>' + travelModeSelect("extra", i, x.mode) + "</div>" +
          '<div class="w-150"><label class="xs">km per week</label><input class="input mt-1" type="number" min="0" value="' + esc(x.km || 0) +
          '" data-travel="extra" data-index="' + i + '" data-key="km" /></div>' +
          '<div class="travel-kg xs muted">' + (kg > 0 ? kg.toFixed(1) + " kg CO₂e / week" : "") + "</div>" +
          '<button type="button" class="icon-btn danger-hover" data-action="remove-travel" data-kind="extra" data-index="' + i + '" aria-label="Remove">' + icon("trash") + "</button></div>"
        );
      })
      .join("");
    return (
      (rows ? '<div class="stack-3 mb-3">' + rows + "</div>" : "") +
      '<button type="button" class="q-add" data-action="add-travel" data-kind="extra">' + icon("plus") + " Add weekly travel</button>"
    );
  }

  // ---------- places for land journeys ----------

  // Straight-line distance between two towns plus 25% for the way roads
  // and railways wind (a common rule of thumb for land routes).
  // Same number as the ?v= on the scripts in index.html.
  const ASSET_VERSION = (document.querySelector('script[src*="app.js?v="]') || { src: "" }).src.split("v=")[1] || "1";
  let placeIndex = null;
  function findPlace(name) {
    if (!placeIndex) {
      placeIndex = new Map();
      (window.ECO_PLACES || []).forEach((p) => {
        const full = p[0].toLowerCase();
        if (!placeIndex.has(full)) placeIndex.set(full, p);
        // "Paris" or "Newport" alone finds the biggest place of that name.
        const short = full.replace(/ \(.*\)$/, "").replace(/, .*$/, "");
        if (!placeIndex.has(short)) placeIndex.set(short, p);
      });
    }
    return placeIndex.get(String(name || "").trim().toLowerCase()) || null;
  }

  function landKm(from, to) {
    const a = findPlace(from);
    const b = findPlace(to);
    if (!a || !b || a === b) return null;
    return Math.round(greatCircleKm({ lat: a[1], lon: a[2] }, { lat: b[1], lon: b[2] }) * A.LAND_ROUTE_UPLIFT);
  }

  // One shared suggestion list for every From / To box. The place list is
  // loaded the first time it's needed, then the step re-renders.
  let placesLoading = false;
  function placesDatalist() {
    if (!window.ECO_PLACES) {
      if (!placesLoading) {
        placesLoading = true;
        const sc = document.createElement("script");
        sc.src = "places.js?v=" + ASSET_VERSION;
        sc.onload = () => {
          placeIndex = null;
          render();
        };
        document.head.appendChild(sc);
      }
      return;
    }
    if (document.getElementById("places-list")) return;
    const dl = document.createElement("datalist");
    dl.id = "places-list";
    dl.innerHTML = window.ECO_PLACES.map((p) => '<option value="' + esc(p[0]) + '"></option>').join("");
    document.body.appendChild(dl);
  }

  // "Not sure?" helper for the commute: two postcodes (looked up with the
  // free postcodes.io service) or two towns, straight line + 25% for roads.
  // Nothing is saved except the distance.
  const POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2}$/i;
  function commuteFinder() {
    const st = ui.pcFind || {};
    return (
      '<details class="pc-help"' + (st.open ? " open" : "") + '><summary data-action="pc-toggle">Not sure? Work it out from two postcodes</summary>' +
      '<form id="pc-form" class="pc-form"><input class="input" id="pc-from" autocomplete="postal-code" maxlength="60" placeholder="Home, e.g. M1 1AE" aria-label="Home postcode or town" value="' + esc(st.from || "") + '" />' +
      '<input class="input" id="pc-to" autocomplete="off" maxlength="60" placeholder="Work, e.g. M13 9PL" aria-label="Work postcode or town" value="' + esc(st.to || "") + '" />' +
      '<button type="submit" class="btn btn-outline btn-sm"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Working it out…" : "Work it out") + "</button></form>" +
      (st.msg ? '<p class="xs mt-2 ' + (st.ok ? "green-dark fw-700" : "red") + '" role="status">' + esc(st.msg) + "</p>" : "") +
      '<p class="xs muted mt-1">Postcodes are looked up with postcodes.io and not saved. Town names work too. We use the straight line plus 25% for the roads.</p></details>'
    );
  }
  async function findCommuteKm(from, to) {
    const pcs = [from, to].filter((x) => POSTCODE_RE.test(x));
    const coords = {};
    if (pcs.length) {
      const res = await fetch("https://api.postcodes.io/postcodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postcodes: pcs }) });
      const out = await res.json();
      (out.result || []).forEach((r) => r.result && (coords[r.query] = { lat: r.result.latitude, lon: r.result.longitude }));
    }
    if (!window.ECO_PLACES && [from, to].some((x) => !POSTCODE_RE.test(x))) {
      await new Promise((resolve) => {
        const sc = document.createElement("script");
        sc.src = "places.js?v=" + ASSET_VERSION;
        sc.onload = resolve;
        sc.onerror = resolve;
        document.head.appendChild(sc);
      });
      placeIndex = null;
    }
    const where = (x) => {
      if (coords[x]) return coords[x];
      const p = findPlace(x);
      return p ? { lat: p[1], lon: p[2] } : null;
    };
    const a = where(from), b = where(to);
    if (!a || !b) return { error: !a ? "We couldn't find \"" + from + "\". Check the postcode or try the town name." : "We couldn't find \"" + to + "\". Check the postcode or try the town name." };
    return { km: Math.max(1, Math.round(greatCircleKm(a, b) * A.LAND_ROUTE_UPLIFT)) };
  }

  function renderLongTrips() {
    placesDatalist();
    const rows = survey.longTrips
      .map((x, i) => {
        const kg = longTripKg(x);
        const auto = x.from && x.to && landKm(x.from, x.to);
        const unknown = (x.from && !findPlace(x.from)) || (x.to && !findPlace(x.to));
        const place = (key, ph) =>
          '<input class="input mt-1" type="text" list="places-list" autocomplete="off" maxlength="60" placeholder="' + ph + '" value="' + esc(x[key] || "") +
          '" data-travel="long" data-index="' + i + '" data-key="' + key + '" />';
        return (
          '<div class="panel p-4"><div class="travel-row">' +
          '<div class="grow minw-160"><label class="xs">From</label>' + place("from", "e.g. London") + "</div>" +
          '<div class="grow minw-160"><label class="xs">To</label>' + place("to", "e.g. Exeter") + "</div></div>" +
          '<div class="travel-row mt-3"><div class="grow minw-160"><label class="xs">How</label>' + travelModeSelect("long", i, x.mode) + "</div>" +
          '<div class="w-150"><label class="xs">km one way</label><input class="input mt-1" type="number" min="0" value="' + esc(x.km || 0) +
          '" data-travel="long" data-index="' + i + '" data-key="km" /></div></div>' +
          (auto
            ? '<p class="xs green-dark mt-2">' + icon("check", "sm") + " Worked out for you: about " + auto.toLocaleString() + " km by road or rail.</p>"
            : unknown
              ? '<p class="xs muted mt-2">We don\'t know that place yet, so pick from the suggestions or type the km yourself.</p>'
              : "") +
          '<div class="row-between journey-foot mt-3"><label class="check-label"><input type="checkbox"' + (x.returnTrip ? " checked" : "") +
          ' data-travel="long" data-index="' + i + '" data-key="returnTrip" /> Return trip</label>' +
          '<span class="label-row"><span class="sm fw-500">' + (kg > 0 ? Math.round(kg).toLocaleString() + " kg CO₂e" : "") + "</span>" +
          '<button type="button" class="dup-btn" data-action="dup-travel" data-kind="long" data-index="' + i + '" aria-label="Duplicate this journey">' + icon("copy") + "Duplicate</button>" +
          '<button type="button" class="icon-btn danger-hover" data-action="remove-travel" data-kind="long" data-index="' + i + '" aria-label="Remove journey">' + icon("trash") + "</button></span></div></div>"
        );
      })
      .join("");
    return (
      (rows ? '<div class="stack-3 mb-3">' + rows + "</div>" : "") +
      '<button type="button" class="q-add" data-action="add-travel" data-kind="long">' + icon("plus") + " Add a journey</button>"
    );
  }

  // Briefly highlight a freshly duplicated row so it's clear what happened.
  function flashCopy(index, kind) {
    const sel =
      kind === "car" ? '[data-action="dup-car"][data-index="' + index + '"]'
      : kind ? '[data-action="dup-travel"][data-kind="' + kind + '"][data-index="' + index + '"]'
      : '[data-action="dup-flight"][data-index="' + index + '"]';
    const btn = document.querySelector(sel);
    const row = btn && btn.closest(".panel");
    if (!row) return;
    row.classList.add("just-copied");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => row.classList.remove("just-copied"), 1400);
  }

  function airportPicker(index, field, value, placeholder) {
    const a = airport(value);
    const open = ui.airport && ui.airport.index === index && ui.airport.field === field;
    let html =
      '<div class="picker"><button type="button" class="btn btn-outline picker-btn' + (a ? "" : " placeholder") +
      '" data-action="open-airport" data-index="' + index + '" data-field="' + field + '">' +
      '<span class="picker-label">' + icon("plane", "muted") +
      (a ? '<span class="truncate">' + esc(a.city) + '</span><span class="muted xs">(' + a.code + ")</span>" : esc(placeholder)) +
      "</span>" + icon("chevronDown", "faint") + "</button>";
    if (open) {
      html +=
        '<div class="picker-panel"><div class="picker-search">' + icon("search", "muted") +
        '<input type="text" id="airport-search" placeholder="Search city or code..." autocomplete="off" value="' + esc(ui.airportQuery) + '" /></div>' +
        '<div class="picker-list" id="airport-list">' + airportOptions(value) + "</div></div>";
    }
    return html + "</div>";
  }

  function airportOptions(value) {
    const q = ui.airportQuery.trim().toLowerCase();
    // Best matches first: exact code, then city starting with the search.
    const rank = (a) => (a.code.toLowerCase() === q ? 0 : a.city.toLowerCase().startsWith(q) ? 1 : 2);
    const list = q
      ? D.AIRPORTS.filter((a) => a.search.includes(q)).sort((a, b) => rank(a) - rank(b)).slice(0, 50)
      : D.AIRPORTS.slice(0, POPULAR_AIRPORTS);
    if (!list.length) return '<p class="picker-empty">No airport found. Try the city or the 3-letter code.</p>';
    return list
      .map(
        (a) =>
          '<button type="button" class="picker-item" data-action="pick-airport" data-code="' + a.code + '">' +
          '<span class="check-slot">' + (a.code === value ? icon("check") : "") + "</span>" +
          "<span>" + esc(a.city) + '</span><span class="muted xs">(' + a.code + ')</span><span class="muted xs ml-auto">' + esc(a.country) + "</span></button>"
      )
      .join("");
  }

  function renderFlightsStep() {
    const flights = survey.flights;
    let html = '<div class="stack-3">';
    if (!flights.length) {
      html +=
        '<p class="q-tip green-tip">No flights in the last 12 months? Nice. You can skip to the next step.</p>';
    }
    html += flights
      .map((f, i) => {
        const km = flightKm(f.from, f.to);
        return (
          '<div class="panel p-4"><div class="flight-grid"><div><label class="xs">From</label><div class="mt-1">' +
          airportPicker(i, "from", f.from, "Departure") +
          "</div></div>" + icon("arrowRight", "muted flight-arrow") +
          '<div><label class="xs">To</label><div class="mt-1">' + airportPicker(i, "to", f.to, "Arrival") + "</div></div></div>" +
          '<div class="flight-meta"><div class="w-150"><label class="xs">When</label>' +
          '<input type="date" class="input mt-1" value="' + esc(f.date || "") + '" data-flight="' + i + '" data-flight-field="date" /></div>' +
          '<div class="grow minw-160"><label class="xs">Cabin class</label><select class="input mt-1" data-flight="' + i + '" data-flight-field="cabin">' +
          D.CABINS.map((c) => '<option value="' + c.key + '"' + (c.key === (f.cabin || "economy") ? " selected" : "") + ">" + c.emoji + " " + esc(c.label) + "</option>").join("") +
          "</select></div>" +
          '<label class="check-label"><input type="checkbox" data-flight="' + i + '" data-flight-field="returnTrip"' + (f.returnTrip ? " checked" : "") +
          " /> Return trip</label>" +
          (km > 0
            ? '<div class="sm"><span class="muted">' + (km * legs(f)).toFixed(0) + ' km · </span><span class="fw-500">' + flightKg({ ...f, trips: 1 }).toFixed(0) + " kg CO₂e</span></div>"
            : "") +
          '<span class="label-row ml-auto"><button type="button" class="dup-btn" data-action="dup-flight" data-index="' + i + '" aria-label="Duplicate this flight">' + icon("copy") + "Duplicate</button>" +
          '<button type="button" class="icon-btn danger-hover" data-action="remove-flight" data-index="' + i + '" aria-label="Remove flight">' + icon("trash") + "</button></span>" +
          "</div></div>"
        );
      })
      .join("");
    html += '</div><button type="button" class="q-add mt-3" data-action="add-flight">' + icon("plus") + " Add a flight</button>";
    return qList([
      qCard(
        1,
        "Which flights did you take in the last 12 months?",
        "Add each trip airport to airport, with when you flew. Tick <strong>Return trip</strong> for there and back. Trips stay saved, so you only add each one once.",
        html
      ),
      goodToKnow("Economy spreads a plane's emissions over more people, so business and first class can double or triple your share. For trips under about {{swap_km}} km, the train is often as fast door to door."),
    ]);
  }

  function numberCard(label, field, value, hint, min, extraCls) {
    return (
      '<div class="panel p-5"><label class="sm fw-500">' + label + '</label><input class="input mt-2 ' + (extraCls || "") +
      '" type="number" min="' + (min || 0) + '" value="' + esc(value) + '" data-field="' + field + '" />' +
      (hint ? '<p class="xs muted mt-2">' + hint + "</p>" : "") + "</div>"
    );
  }

  function renderEnergyStep() {
    const e = survey.energy;
    const w = survey.water;
    const hh = e.household == null ? 2 : e.household;
    return qList([
      qCard(1, "How much electricity does your home use a month?", "It's on your bill or in your supplier's app. A typical home uses 200–400 kWh a month.", fieldInput("energy.electricityKwh", e.electricityKwh == null ? 0 : e.electricityKwh, "kWh a month", "Electricity per month in kWh")),
      qCard(2, "And gas?", "A typical home uses 500–1,200 kWh of gas a month. Put 0 if you don't have gas.", fieldInput("energy.gasKwh", e.gasKwh == null ? 0 : e.gasKwh, "kWh a month", "Gas per month in kWh")),
      qCard(
        3,
        "Are you on a green electricity tariff?",
        "A 100% renewable tariff cuts electricity emissions by {{green_cut}}.",
        '<div class="chip-wrap">' + chip(!!e.greenTariff, 'data-action="set-green" data-value="1"', "Yes") + chip(!e.greenTariff, 'data-action="set-green" data-value="0"', "No") + "</div>" +
          // Renters, students and people living with family often don't pick the supplier.
          (e.greenTariff
            ? ""
            : '<div class="q-sub"><p class="q-sub-title display">Who chooses your energy supplier?</p><div class="chip-wrap">' +
              chip(e.billPayer !== "other", 'data-action="set-billpayer" data-value="me"', "Me or my household") +
              chip(e.billPayer === "other", 'data-action="set-billpayer" data-value="other"', "Someone else", "landlord, family, bills included") +
              "</div>" + (e.billPayer === "other" ? '<p class="q-tip">No problem. We\'ll give you a ready-made message to send whoever does, asking them to switch.</p>' : "") + "</div>")
      ),
      qCard(4, "How many people live in your home?", "We share the home's energy, water and pets between everyone who lives there.", stepper("energy.household", hh, 1, 1, hh === 1 ? "person" : "people", "People in your home")),
      qCard(5, "How much water do you use?", "For the whole home, per month. A typical person uses about 3,000–5,000 litres.", fieldInput("water.liters", w.liters == null ? 0 : w.liters, "litres a month", "Water per month in litres")),
    ]);
  }

  function renderPetsStep() {
    const p = survey.pets;
    return qList([
      qCard(1, "How many dogs do you have?", "About " + D.DOG_YEARLY + " kg CO₂e a year each, mostly from their food.", stepper("pets.dogs", p.dogs == null ? 0 : p.dogs, 1, 0, "", "Dogs")),
      qCard(2, "And cats?", "About " + D.CAT_YEARLY + " kg CO₂e a year each. Put 0 if you don't have any.", stepper("pets.cats", p.cats == null ? 0 : p.cats, 1, 0, "", "Cats")),
      qCard(3, "Any other pets?", "Optional. Leave at 0 if not.",
        '<div class="pet-more"><div><p class="fw-700">Horses and ponies</p><p class="xs muted">About ' + kgFmt(D.HORSE_YEARLY) + " kg a year each, mostly feed and bedding</p>" + stepper("pets.horses", p.horses || 0, 1, 0, "", "Horses and ponies") + "</div>" +
          '<div><p class="fw-700">Small pets</p><p class="xs muted">Rabbits, guinea pigs, birds, fish: about ' + D.SMALL_PET_YEARLY + " kg a year each (a rough figure)</p>" + stepper("pets.smallPets", p.smallPets || 0, 1, 0, "", "Small pets") + "</div></div>",
        { optional: true }),
      goodToKnow("A medium dog's food can emit as much as a small car over a year. You don't need to change your pet, just what goes in the bowl."),
    ]);
  }

  function extrasEditor(b) {
    const list = Array.isArray(b.extra) ? b.extra : [];
    const rows = list.map((x, i) => {
      const pension = x.kind === "pension";
      const opts = pension
        ? D.PENSION_PROVIDERS.filter((p) => !p.unfunded).map((p) => '<option value="' + p.key + '"' + (p.key === x.provider ? " selected" : "") + ">" + esc(p.label) + "</option>").join("")
        : D.BANKS.map((p) => '<option value="' + p.key + '"' + (p.key === x.bank ? " selected" : "") + ">" + esc(p.label) + "</option>").join("");
      return (
        '<div class="extra-row"><span class="extra-kind xs fw-700">' + (pension ? "Pension" : "Bank account") + "</span>" +
        '<select class="input" data-extra="' + i + '" data-extra-field="' + (pension ? "provider" : "bank") + '" aria-label="' + (pension ? "Pension provider" : "Bank") + '">' +
        '<option value=""' + ((pension ? x.provider : x.bank) ? "" : " selected") + " disabled>" + (pension ? "Provider" : "Bank") + "</option>" + opts + "</select>" +
        '<label class="extra-amt"><span class="muted">£</span><input class="input" type="number" min="0" inputmode="numeric" value="' + esc(x.amount || 0) + '" data-extra="' + i + '" data-extra-field="amount" aria-label="' + (pension ? "Pot size in pounds" : "Amount in pounds") + '" /></label>' +
        '<button type="button" class="fr-btn ghost sq" data-action="remove-extra" data-i="' + i + '" aria-label="Remove">' + icon("x") + "</button></div>"
      );
    }).join("");
    return (
      rows +
      '<div class="chip-row mt-2"><button type="button" class="q-add" data-action="add-extra" data-kind="bank">' + icon("plus") + ' Add a bank account</button>' +
      '<button type="button" class="q-add" data-action="add-extra" data-kind="pension">' + icon("plus") + " Add a pension</button></div>"
    );
  }

  function renderBankingStep() {
    const b = survey.banking;
    const pension = byKey(D.PENSION_PROVIDERS, b.pensionProvider);
    return qList([
      qCard(
        1,
        "Who do you bank with?",
        "Your main current account. Banks lend out your money, and some finance fossil fuels.",
        '<select class="input q-select" data-field="banking.bank" data-type="text" aria-label="Your bank">' +
          '<option value=""' + (b.bank ? "" : " selected") + " disabled>Select your bank</option>" +
          D.BANKS.map((x) => '<option value="' + x.key + '"' + (x.key === b.bank ? " selected" : "") + ">" + esc(x.label) + "</option>").join("") +
          "</select>"
      ),
      qCard(2, "Roughly how much do you keep in savings and current accounts?", "A ballpark is fine. It's never shared.", fieldInput("banking.amount", b.amount == null ? 0 : b.amount, "", "Savings in pounds", "£")),
      qCard(
        3,
        "Who runs your pension?",
        "Pensions are often the biggest money lever. Choose <strong>Other / not sure</strong> if you don't know.",
        '<select class="input q-select" data-field="banking.pensionProvider" data-type="text" data-rerender="1" aria-label="Pension provider">' +
          '<option value=""' + (b.pensionProvider ? "" : " selected") + " disabled>Select your provider</option>" +
          D.PENSION_PROVIDERS.map((x) => '<option value="' + x.key + '"' + (x.key === b.pensionProvider ? " selected" : "") + ">" + esc(x.label) + "</option>").join("") +
          "</select>" +
          (pension && pension.unfunded
            ? '<p class="sm mt-2 q-tip green-tip">' + esc(pension.label) + " pays pensions from government funds rather than investing in companies, so it doesn't add to your footprint and there's nothing to switch. If you also have a personal pension, choose that provider instead.</p>"
            : pension ? '<p class="xs muted mt-2">' + pension.tPerMillion + " t CO₂e per £1m invested · " + esc(pension.source) + "</p>" : "")
      ),
      pension && pension.unfunded
        ? ""
        : qCard(4, "Roughly how big is your pension pot?", "Add up your workplace and personal pots. Check your provider's app or latest statement. Leave it at 0 if you don't have one.", fieldInput("banking.pensionPot", b.pensionPot == null ? 0 : b.pensionPot, "", "Pension pot in pounds", "£")),
      qCard(pension && pension.unfunded ? 4 : 5, "Any other accounts or pensions?", "Optional. Add savings with another bank, or an old workplace pension, so they count too.", extrasEditor(b), { optional: true }),
      // Optional, for anonymous totals by role (also on the Account page).
      qCard(pension && pension.unfunded ? 5 : 6, "What best describes your work?", "Only used for anonymous totals, like the average footprint of nurses. Never shown with your name.",
        '<select class="input q-select" data-field="about.role" data-type="text" aria-label="Your work">' +
          '<option value="">Prefer not to say</option>' +
          ROLES.map(([k, l]) => '<option value="' + k + '"' + (((survey.about || {}).role || "") === k ? " selected" : "") + ">" + l + "</option>").join("") +
          "</select>", { optional: true }),
    ]);
  }

  // ==================== Results page ====================


  // The typical UK resident's yearly kg per category (the same profile as
  // the UK comparison), for the dashed markers on the chart.
  function ukAverageByKey() {
    const out = {};
    footprint(D.UK_TYPICAL_SURVEY).breakdown.forEach((b) => {
      if (D.UK_COMPARISON_KEYS.includes(b.key)) out[b.key] = b.yearly;
    });
    return out;
  }

  // Big totals count up from zero the first time Results is shown.
  const countedUp = new Set();
  function countUp() {
    app.querySelectorAll("[data-countup]").forEach((el) => {
      const to = Number(el.dataset.countup);
      if (el.textContent !== "0" || !to) return;
      // Numbers count up the first time you see them, then just show.
      const key = currentPath() + "|" + to;
      const seen = countedUp.has(key);
      countedUp.add(key);
      if (seen || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
        el.textContent = to.toLocaleString();
        return;
      }
      const t0 = performance.now();
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / 1400);
        el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString();
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function niceCeil(v) {
    const step = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (m * step >= v) return m * step;
    }
    return 10 * step;
  }



  function savingSummary(tip) {
    let html = "";
    if (tip.saving > 0.5)
      html += '<div class="saving-pill">' + icon("trendDown") + "<span>Realistic: could save ~" + tip.saving.toFixed(0) + " kg CO₂e / year</span></div>";
    if (tip.maxSaving > tip.saving + 0.5)
      html +=
        '<p class="xs muted mt-2">Going all the way, up to ~' + tip.maxSaving.toFixed(0) + " kg a year: " + esc(tip.maxLabel || "") + ".</p>";
    return "<div>" + html + "</div>";
  }

  function compareBar(label, value, max, tone) {
    const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return (
      '<div><div class="row-between xs mb-1"><span class="muted">' + label + '</span><span class="fw-500">' + value.toFixed(0) +
      ' kg CO₂e/yr</span></div><div class="progress"><div class="' + (tone === "emerald" ? "" : tone === "deep" ? "deep" : "grey") + '" style="width:' + pct + '%"></div></div></div>'
    );
  }

  function supportUrl() {
    return currentUser ? paymentUrl() : STRIPE_PAYMENT_LINK;
  }

  // Optional support. Hidden in the iOS app (App Store rules on outside
  // payment links).
  function supportCard() {
    if (isNativeApp() || !STRIPE_PAYMENT_LINK) return "";
    if (isSupporter()) {
      return (
        '<div class="card support-card fade-up"><div class="label-row mb-2"><span class="round-badge sm">' + icon("leaf") + '</span>' +
        '<span class="eyebrow">Supporter</span></div><h3 class="card-title mb-1">Thank you for supporting CO2 Counter</h3>' +
        '<p class="sm muted">Your £2 a year helps keep it free for everyone.</p></div>'
      );
    }
    return (
      '<div class="card support-card fade-up"><div class="label-row mb-2"><span class="round-badge sm">' + icon("leaf") + '</span>' +
      '<span class="eyebrow">Support CO2 Counter</span></div>' +
      '<h3 class="card-title mb-1">Free for everyone, kept going by supporters</h3>' +
      '<p class="sm muted mb-4 max-2xl">CO2 Counter has no ads and never sells your data. If it\'s helped you, you can chip in £2 a year to cover running costs and new features. Cancel any time.</p>' +
      '<div class="chip-row"><a class="btn btn-green" href="' + esc(supportUrl()) + '">Support for £2 a year</a></div>' +
      '<p class="xs muted mt-3">Secure payment by Stripe. Optional: everything stays free either way. <a class="link-btn" href="/terms/">Terms</a></p></div>'
    );
  }

  // Guests can see everything; an account keeps answers across devices.
  function saveCard() {
    if (currentUser) return "";
    return (
      '<div class="card fade-up"><div class="row-between gap-3" style="flex-wrap:wrap"><div class="min0 grow"><h3 class="card-title mb-1">Keep your results</h3>' +
      '<p class="sm muted">Create a free account to save your answers on all your devices and compare with friends.</p></div>' +
      '<div class="chip-row"><button type="button" class="btn btn-green" data-action="start-signup">Create free account</button>' +
      '<button type="button" class="btn btn-outline" data-action="start-signin">Sign in</button></div></div></div>'
    );
  }

  // Category colours and short names for tabs and charts (Glass v2).
  const CAT_COLOR = { meals: "#3F5B3A", banking: "#6E8B5E", energy: "#A3B58F", pets: "#D9A441", flights: "#B8653D", commute: "#8C6A4F", water: "#7FA3AE" };
  const CAT_SHORT = { meals: "Meals", banking: "Money", energy: "Home", pets: "Pets", flights: "Flights", commute: "Commute", water: "Water" };

  // On the example page, category links start the survey instead.
  const catHref = (key) => (ui.exampleMode ? "#/" : "#/explainer/" + key);

  // Overview plus one tab per category, biggest first.
  function resultTabs(fp, current) {
    return (
      '<nav class="section-tabs" aria-label="Result sections">' +
      '<a href="#/results"' + (current ? "" : ' class="on" aria-current="page"') + ">Overview</a>" +
      fp.breakdown
        .map((b) => '<a href="' + catHref(b.key) + '"' + (current === b.key ? ' class="on" aria-current="page"' : "") + ">" + esc(CAT_SHORT[b.key] || b.label) + "</a>")
        .join("") +
      "</nav>"
    );
  }

  function donutChart(fp) {
    const total = fp.totalYearly || 1;
    let acc = 0;
    const segs = fp.breakdown
      .map((b) => {
        const len = (b.yearly / total) * 100;
        const dash = Math.max(0.15, len - 0.6);
        const out =
          '<circle cx="21" cy="21" r="15.9" fill="none" stroke="' + CAT_COLOR[b.key] + '" stroke-width="7" pathLength="100" stroke-dasharray="' +
          dash.toFixed(2) + " " + (100 - dash).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 21 21)"><title>' +
          esc(b.label) + "</title></circle>";
        acc += len;
        return out;
      })
      .join("");
    const pct = (v) => Math.max(1, Math.round((v / total) * 100)) + "%";
    return (
      '<div class="donut-wrap"><div class="donut"><svg viewBox="0 0 42 42" role="img" aria-label="Share of your footprint by category">' + segs + "</svg>" +
      '<div class="donut-mid"><span class="display tnum">' + kgFmt(fp.totalYearly) + '</span><span class="xs muted">kg a year</span></div></div>' +
      '<ul class="donut-legend">' +
      fp.breakdown
        .map(
          (b) =>
            '<li><a href="' + catHref(b.key) + '" aria-label="' + esc(b.label) + ", " + kgFmt(b.yearly) + " kg, " + pct(b.yearly) + ' of your footprint. Open how to improve">' +
            '<span class="sw" style="background:' + CAT_COLOR[b.key] + '"></span><span class="nm"><span class="nm-long">' + esc(b.label) + '</span><span class="nm-short">' + esc(CAT_SHORT[b.key] || b.label) + '</span></span><span class="muted tnum">' + pct(b.yearly) + "</span></a></li>"
        )
        .join("") +
      "</ul></div>"
    );
  }

  // Columns on wider screens, rows on phones (the same markup, laid out by CSS).
  function barsChart(fp) {
    const uk = ui.showUk ? ukAverageByKey() : {};
    const max = Math.max(1, ...fp.breakdown.map((b) => Math.max(b.yearly, uk[b.key] || 0)));
    const top = niceCeil(max);
    const h = (v) => ((v / top) * 100).toFixed(2);
    const total = fp.totalYearly || 1;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => '<span class="bars-grid" style="bottom:calc(52px + (100% - 52px) * ' + f + ')"><i class="tnum">' + kgFmt(top * f) + "</i></span>").join("");
    return (
      '<div class="bars' + (ui.showUk ? " with-uk" : "") + '"><div class="bars-plot">' + grid +
      fp.breakdown
        .map((b) => {
          const u = uk[b.key];
          const sub = ui.showUk
            ? u == null ? "No UK figure" : Math.abs(b.yearly - u) / u < 0.03 ? "Same as UK" : (b.yearly > u ? "+" : "−") + kgFmt(Math.abs(b.yearly - u)) + " vs UK"
            : Math.max(1, Math.round((b.yearly / total) * 100)) + "%";
          return (
            '<a class="bars-col" href="' + catHref(b.key) + '" aria-label="' + esc(b.label) + ", " + kgFmt(b.yearly) + ' kg a year. Open how to improve">' +
            '<span class="bars-track"><span class="bar-you" style="--h:' + h(b.yearly) + "%;background:" + CAT_COLOR[b.key] + '"><b class="tnum">' + kgFmt(b.yearly) + "</b></span>" +
            (ui.showUk && u != null ? '<span class="bar-uk" style="--h:' + h(u) + '%"><b class="tnum">' + kgFmt(u) + "</b></span>" : "") +
            '</span><span class="bars-name">' + esc(CAT_SHORT[b.key]) + '</span><span class="bars-sub">' + esc(sub) + "</span></a>"
          );
        })
        .join("") +
      "</div></div>"
    );
  }

  // Your progress: one point per survey, oldest to newest, as a line that
  // draws itself in, with a dashed line where you started.
  function progressHtml(points, nextTip) {
    if (!points.length) return "";
    const pts = points.slice(-8);
    const first = pts[0], last = pts[pts.length - 1];
    const one = pts.length === 1;
    const change = last.kg - first.kg;
    const vals = pts.map((p) => p.kg);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.25, hi * 0.08, 150);
    lo = Math.max(0, lo - pad);
    hi = hi + pad;
    // x and y in % of the plot
    const X = (i) => (one ? 30 : 6 + (i / (pts.length - 1)) * 88);
    const Y = (v) => 100 - ((v - lo) / (hi - lo || 1)) * 100;
    const xy = pts.map((p, i) => [X(i), Y(p.kg)]);
    const line = xy.map((q, i) => (i ? "L" : "M") + q[0].toFixed(2) + " " + q[1].toFixed(2)).join(" ");
    const area = one ? "" : line + " L" + xy[xy.length - 1][0].toFixed(2) + " 100 L" + xy[0][0].toFixed(2) + " 100 Z";
    const down = change < -0.5, up = change > 0.5;
    const chip = one ? "" : '<span class="pg-chip ' + (down ? "down" : up ? "up" : "") + '">' + (down ? "▼ " : up ? "▲ " : "") +
      (Math.abs(change) < 0.5 ? "No change" : kgFmt(Math.abs(change)) + " kg") + '<small> since your first survey</small></span>';
    const label = (p) => p.label + ": " + kgFmt(p.kg) + " kg a year";
    return (
      '<section class="glass pg' + (one ? " one" : "") + '" aria-labelledby="pg-h"><div class="pg-head"><h2 id="pg-h" class="card-title">Your progress</h2>' + chip + "</div>" +
      '<div class="pg-plot" role="img" aria-label="Your footprint over time. ' + esc(pts.map(label).join("; ")) + '.">' +
      '<svg class="pg-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="pg-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5C7A4E" stop-opacity=".28"></stop><stop offset="1" stop-color="#5C7A4E" stop-opacity="0"></stop></linearGradient>' +
      '<clipPath id="pg-sweep"><rect class="pg-reveal" x="-2" y="-10" width="104" height="120"></rect></clipPath></defs>' +
      (one ? '<line class="pg-next" x1="' + X(0) + '" x2="94" y1="' + Y(first.kg).toFixed(2) + '" y2="' + Y(first.kg).toFixed(2) + '" vector-effect="non-scaling-stroke"></line>'
        : '<line class="pg-start" x1="0" x2="100" y1="' + Y(first.kg).toFixed(2) + '" y2="' + Y(first.kg).toFixed(2) + '" vector-effect="non-scaling-stroke"></line>' +
          '<g clip-path="url(#pg-sweep)"><path class="pg-area" d="' + area + '"></path><path class="pg-line" d="' + line + '" vector-effect="non-scaling-stroke"></path></g>') +
      "</svg>" +
      (one ? "" : '<span class="pg-start-l" style="top:' + Y(first.kg).toFixed(2) + '%">Where you started</span>') +
      pts.map((p, i) =>
        '<span class="pg-dot' + (i === pts.length - 1 ? " last" : "") + '" style="left:' + xy[i][0].toFixed(2) + "%;top:" + xy[i][1].toFixed(2) + "%;--d:" + (0.2 + (one ? 0 : i / (pts.length - 1)) * 1.1).toFixed(2) + 's" title="' + esc(label(p)) + '"></span>'
      ).join("") +
      '<span class="pg-val' + (xy[xy.length - 1][0] > 70 ? " end" : "") + (!one && xy[xy.length - 2][1] < xy[xy.length - 1][1] ? " below" : "") + '" style="left:' + xy[xy.length - 1][0].toFixed(2) + "%;top:" + xy[xy.length - 1][1].toFixed(2) + '%"><b class="display tnum">' + kgFmt(last.kg) + "</b> kg</span>" +
      (one ? '<span class="pg-next-l" style="top:' + Y(first.kg).toFixed(2) + '%">Next</span>' : "") +
      "</div>" +
      '<div class="pg-x" aria-hidden="true">' + pts.map((p, i) => '<span style="left:' + X(i).toFixed(2) + '%">' + esc(p.short) + "</span>").join("") + "</div>" +
      (one ? '<p class="xs muted pg-tip">' + esc(nextTip) + "</p>" : "") +
      "</section>"
    );
  }
  // ===== Picture your year: a full-screen scroll story =====
  // Opens from the Picture it card. Your year is a disc whose area is your
  // kg; scrolling walks through your three biggest moves and the disc
  // shrinks towards the dashed 1.5°C budget ring.
  let storyEl = null, storyFrom = null;
  function storyData() {
    const fp = footprint(survey);
    const tree = (D.EVERYDAY_COMPARISONS && D.EVERYDAY_COMPARISONS.treeKgYear) || 22;
    const moves = fp.breakdown.map((b) => ({ b, t: tipFor(b.key, survey) })).filter((x) => x.t.saving >= 0.5).sort((a, b) => b.t.saving - a.t.saving).slice(0, 3);
    const total = Math.max(1, fp.totalYearly);
    let left = total;
    const steps = [{ kg: total, k: "Today", h: "Your year: " + kgFmt(total) + " kg", p: "That's what <em>" + kgFmt(total / tree) + " mature trees</em> soak up in a year." }];
    moves.forEach((x, i) => {
      left = Math.max(0, left - x.t.saving);
      steps.push({ kg: left, k: "Move " + (i + 1) + " · " + esc(CAT_SHORT[x.b.key] || x.b.label), h: esc(capFirst(x.t.realisticLabel || x.t.title)), p: "Saves about <em>" + kgFmt(x.t.saving) + " kg</em> a year. You're down to " + kgFmt(left) + " kg." });
    });
    // Your full footprint now, and if you made every change you could
    // (the "All the way" figure on Results), each with the shared share.
    const allTips = fp.breakdown.map((b) => ({ b, t: tipFor(b.key, survey) }));
    const bb = budgetBasis(fp, allTips);
    const maxCut = Math.max(0, allTips.reduce((t, x) => t + x.t.maxSaving, 0) - bb.moneyMax);
    const shared = D.SHARED_FOOTPRINT.totalKg;
    const warm = D.WARMING ? warmModel(Math.max(0, bb.life) + shared, Math.max(0, bb.life - maxCut) + shared) : null;
    return { total, steps, moves, left, budget: D.BUDGET_YEARLY, tree, warm };
  }
  // What if everyone lived like you? Observed warming to today, then two
  // futures to 2100 (see WARMING in data.js for the sources and method).
  function warmModel(fullKg, allKg) {
    const W = D.WARMING;
    const obs = W.observed, f0 = W.observedFrom, Y = W.startYear;
    const at = (pts, y) => {
      for (let i = 1; i < pts.length; i++) if (y <= pts[i][0]) { const [x0, v0] = pts[i - 1], [x1, v1] = pts[i]; return v0 + ((v1 - v0) * (y - x0)) / (x1 - x0); }
      return pts[pts.length - 1][1];
    };
    // Today: the 20-year trend at the start year.
    const last = obs.slice(-20).map((v, i) => [Y - 19 + i, v]);
    const mx = last.reduce((t, p) => t + p[0], 0) / 20, my = last.reduce((t, p) => t + p[1], 0) / 20;
    const slope = last.reduce((t, p) => t + (p[0] - mx) * (p[1] - my), 0) / last.reduce((t, p) => t + (p[0] - mx) ** 2, 0);
    const t0 = my + slope * (Y - mx);
    // The bold line: an 11-year average, easing into today's trend.
    const smooth = obs.map((_, i) => {
      const y = f0 + i;
      if (y > Y - 5) { const a = smoothAt(Y - 5); return a + ((t0 - a) * (y - (Y - 5))) / 5; }
      return smoothAt(y);
    });
    function smoothAt(y) { const i = y - f0, lo = Math.max(0, i - 5), hi = Math.min(obs.length - 1, i + 5); let t = 0; for (let j = lo; j <= hi; j++) t += obs[j]; return t / (hi - lo + 1); }
    let cumCp = 0, cumYou = 0, cumAll = 0;
    const cpCum = [0], youCum = [0], allCum = [0];
    for (let y = Y + 1; y <= 2100; y++) {
      const bn = at(W.populationBn, y - 0.5);
      cumCp += at(W.currentPoliciesGt, y - 0.5);
      cumYou += (bn * fullKg) / 1000; // billions of people x kg = Mt; / 1000 = Gt
      cumAll += (bn * allKg) / 1000;
      cpCum.push(cumCp); youCum.push(cumYou); allCum.push(cumAll);
    }
    const k = (W.currentPolicies2100 - t0) / cumCp;
    const cp = cpCum.map((c) => t0 + k * c), you = youCum.map((c) => t0 + k * c), all = allCum.map((c) => t0 + k * c);
    return { f0, Y, obs, smooth, t0, cp, you, all, fullKg, allKg, worldKg: (W.emissionsNowGt / at(W.populationBn, Y)) * 1000, people: at(W.populationBn, Y) };
  }
  const degC = (v) => (v < 0 ? "−" : "+") + Math.abs(v).toFixed(1) + "°C";

  function storyHtml(d) {
    const n = d.steps.length;
    const saved = d.total - d.left;
    const gap = d.left - d.budget;
    const r = (kg) => Math.sqrt(Math.max(0, kg) / d.total).toFixed(4);
    const first = d.moves[0];
    return (
      '<div class="story" role="dialog" aria-modal="true" aria-labelledby="story-h">' +
      '<div class="story-line" aria-hidden="true"><i></i></div>' +
      '<button type="button" class="story-close" data-story-close aria-label="Close">' + icon("x") + "</button>" +
      '<div class="story-scroll" tabindex="0" aria-label="Picture your year. Scroll to move through it.">' +
      '<section class="story-intro"><span class="story-k">Picture it</span>' +
      '<h2 id="story-h" class="display">This is your year.<br><b class="tnum">' + kgFmt(d.total) + " kg</b> of CO₂.</h2>" +
      "<p>Scroll, and watch it shrink.</p><span class=\"story-cue\" aria-hidden=\"true\"><i></i></span></section>" +
      '<section class="story-track" style="--n:' + n + '">' +
      '<div class="story-stage">' +
      '<div class="story-orb" aria-hidden="true" style="--b:' + r(d.budget) + '">' +
      '<i class="story-ghost"></i><i class="story-disc"></i><i class="story-budget"></i>' +
      '<span class="story-saved"><b class="tnum">0</b> kg saved</span>' +
      '<span class="story-budget-l">1.5°C budget · ' + kgFmt(d.budget) + " kg</span>" +
      '<span class="story-read"><b class="display tnum story-kg">' + kgFmt(d.total) + "</b><small>kg a year</small></span></div>" +
      '<ol class="story-steps">' + d.steps.map((st, i) => '<li data-i="' + i + '"' + (i ? "" : ' class="on"') + '><span class="story-k">' + st.k + '</span><h3 class="display">' + st.h + "</h3><p>" + st.p + "</p></li>").join("") + "</ol>" +
      '<div class="story-ticks" aria-hidden="true">' + d.steps.map((_, i) => '<span style="--k:' + i + '"></span>').join("") + "</div>" +
      "</div></section>" + (d.warm ? warmHtml(d.warm) : "") +
      '<section class="story-end"><span class="story-k">' + (d.moves.length ? d.moves.length + (d.moves.length === 1 ? " move" : " moves") : "Your year") + "</span>" +
      '<h2 class="display">' + (saved >= 0.5 ? "<b class=\"tnum\">" + kgFmt(saved) + " kg</b> lighter, every year." : "You're already lean.") + "</h2>" +
      "<p>" + (gap > 0 ? "That leaves you " + kgFmt(gap) + " kg above the 1.5°C budget. The 7 Acts close more of the gap." : "That puts you inside the 1.5°C budget of " + kgFmt(d.budget) + " kg.") + "</p>" +
      '<div class="story-go">' + (first ? '<a class="btn btn-honey" href="' + catHref(first.b.key) + '">Start with ' + esc(CAT_SHORT[first.b.key] || first.b.label) + " " + icon("arrowRight") + "</a>" : "") +
      '<a class="btn story-ghost-btn" href="#/habits">Open My Habits</a>' +
      '<button type="button" class="link-btn story-back" data-story-close>Back to my results</button></div></section>' +
      "</div></div>"
    );
  }
  const WARM_MODES = [["both", "Both"], ["now", "As I live now"], ["all", "If I made every change I could"]];
  function warmHtml(w) {
    const end = (a) => a[a.length - 1];
    const cpEnd = end(w.cp), youEnd = end(w.you), allEnd = end(w.all);
    const hot = youEnd > cpEnd + 0.05, allHot = allEnd > cpEnd + 0.05;
    const t = (kg) => (kg / 1000).toFixed(1);
    const vs = (v) => (v > cpEnd + 0.05 ? "Hotter than the world is heading for." : v < 1.6 ? "Close to the 1.5°C limit." : "Cooler than the world is heading for.");
    const caps = [
      ["1850", "The industrial age gets going", "Each year's global temperature, measured, compared with the late 1800s."],
      ["1950s", "Then the line turns upward", "Coal, oil and gas burn faster every decade, and the heat builds."],
      ["Today", "About " + degC(w.t0) + " already", "The last ten years were the ten warmest on record."],
      ["If the world carries on", "About " + degC(cpEnd) + " by 2100", "Where today's policies are heading, by Climate Action Tracker's estimate."],
      ["If everyone lived like you do now", "About " + degC(youEnd) + " by 2100", vs(youEnd) + " Everyone at " + t(w.fullKg) + " t a year."],
      ["If everyone made every change you could", "About " + degC(allEnd) + " by 2100", vs(allEnd) + " Everyone at " + t(w.allKg) + " t a year" + (youEnd - allEnd >= 0.05 ? ", " + (youEnd - allEnd).toFixed(1) + "°C cooler than living as you do now." : ".")],
    ];
    const summary = "Global warming from 1850 to today, reaching about " + degC(w.t0) + ". By 2100: about " + degC(cpEnd) + " if the world carries on as it is, about " + degC(youEnd) +
      " if everyone lived like you do now, and about " + degC(allEnd) + " if everyone made every change you could.";
    const modes = (cls) => '<div class="warm-modes ' + cls + '" role="radiogroup" aria-label="Which version of you?">' +
      WARM_MODES.map(([k, l]) => '<button type="button" role="radio" aria-checked="' + (k === "both") + '" data-warm-mode="' + k + '">' + esc(l) +
        (k === "now" ? "<small>" + t(w.fullKg) + " t a year</small>" : k === "all" ? "<small>" + t(w.allKg) + " t a year</small>" : "<small>Then and after</small>") + "</button>").join("") + "</div>";
    return (
      '<section class="warm-intro"><span class="story-k">Now picture everyone</span>' +
      '<h2 class="display">What if all ' + w.people.toFixed(1) + " billion of us lived like you?</h2>" +
      "<p>Your full footprint, with shopping and your share of public services, is <b>" + t(w.fullKg) + " t</b> a year. Make every change you could and it's <b>" + t(w.allKg) + " t</b>. The world averages about <b>" + t(w.worldKg) + " t</b>.</p>" +
      '<p class="warm-q">Which version of you should everyone live like?</p>' + modes("big") +
      '<span class="warm-go" aria-hidden="true">Scroll to play</span></section>' +
      '<section class="warm-track"><div class="warm-stage">' +
      '<ol class="warm-caps">' + caps.map((c, i) => '<li data-i="' + i + '"' + (i ? "" : ' class="on"') + '><span class="story-k">' + esc(c[0]) + '</span><h3 class="display">' + esc(c[1]) + "</h3><p>" + esc(c[2]) + "</p></li>").join("") + "</ol>" +
      '<div class="warm-read" aria-hidden="true"><b class="display tnum warm-yr">1850</b><span class="warm-t tnum">+0.0°C</span></div>' + modes("small") +
      '<div class="warm-chart" role="img" aria-label="' + esc(summary) + '">' +
      '<div class="warm-grid" aria-hidden="true"></div>' +
      '<svg viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true"><path class="w-raw" vector-effect="non-scaling-stroke"></path><path class="w-obs" vector-effect="non-scaling-stroke"></path>' +
      '<path class="w-cp" vector-effect="non-scaling-stroke"></path><path class="w-you' + (hot ? " hot" : "") + '" vector-effect="non-scaling-stroke"></path>' +
      '<path class="w-all' + (allHot ? " hot" : "") + '" vector-effect="non-scaling-stroke"></path></svg>' +
      '<span class="w-head" aria-hidden="true"></span>' +
      '<span class="w-end w-end-cp" aria-hidden="true"><b class="tnum">' + degC(cpEnd) + "</b>Carries on</span>" +
      '<span class="w-end w-end-you' + (hot ? " hot" : "") + '" aria-hidden="true"><b class="tnum">' + degC(youEnd) + "</b>Everyone like you now</span>" +
      '<span class="w-end w-end-all' + (allHot ? " hot" : "") + '" aria-hidden="true"><b class="tnum">' + degC(allEnd) + "</b>After every change</span>" +
      '<div class="warm-x" aria-hidden="true"></div></div>' +
      '<div class="warm-key" aria-hidden="true"><span class="k-you' + (hot ? " hot" : "") + '"><i></i><b>' + degC(youEnd) + "</b> Like you now</span>" +
      '<span class="k-cp"><i></i><b>' + degC(cpEnd) + "</b> Carries on</span>" +
      '<span class="k-all' + (allHot ? " hot" : "") + '"><i></i><b>' + degC(allEnd) + "</b> Every change</span></div>" +
      '<p class="warm-note">An illustration, not a climate model. It holds everyone at that footprint until 2100. Measured: Met Office HadCRUT5. Ahead: Climate Action Tracker, UNEP, UN population. <a class="link-btn" href="/how-we-calculate/">How we calculate</a></p>' +
      "</div></section>"
    );
  }
  // Draws the chart for a scroll position (0 to 1 through its track) and
  // the chosen version of you: "now", "all" (every change) or "both".
  function paintWarm(el, w, p, mode) {
    const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
    const cl = (a, b) => Math.min(1, Math.max(0, (p - a) / (b - a)));
    // Your lines share the last stretch of the scroll, one after another.
    const mine = mode === "now" ? ["you"] : mode === "all" ? ["all"] : ["you", "all"];
    const span = (0.96 - 0.72) / mine.length;
    const ph = { hist: cl(0.04, 0.46), zoom: ease(cl(0.48, 0.56)), cp: cl(0.56, 0.7), you: 0, all: 0 };
    mine.forEach((k, i) => (ph[k] = cl(0.72 + i * span, 0.72 + (i + 1) * span - 0.02)));
    const end = w.f0 + w.obs.length - 1;
    const histMax = 1.8, yMin = -0.5;
    const fullMax = Math.max(3, w.you[w.you.length - 1], w.cp[w.cp.length - 1]) + 0.4;
    const x1 = end + (2100 - end) * ph.zoom, y1 = histMax + (fullMax - histMax) * ph.zoom;
    const X = (yr) => ((yr - w.f0) / (x1 - w.f0)) * 1000;
    const Yv = (v) => 500 - ((v - yMin) / (y1 - yMin)) * 500;
    const pct = (yr, v) => [(X(yr) / 10).toFixed(3) + "%", ((Yv(v) / 500) * 100).toFixed(3) + "%"];
    const line = (from, vals, upto) => {
      let d = "";
      const n = Math.floor(upto);
      for (let i = 0; i <= Math.min(n, vals.length - 1); i++) d += (i ? "L" : "M") + X(from + i).toFixed(2) + " " + Yv(vals[i]).toFixed(2);
      if (n < vals.length - 1 && upto > n) { const v = vals[n] + (vals[n + 1] - vals[n]) * (upto - n); d += "L" + X(from + upto).toFixed(2) + " " + Yv(v).toFixed(2); }
      return d;
    };
    const valAt = (vals, upto) => { const n = Math.min(vals.length - 1, Math.floor(upto)); return n >= vals.length - 1 ? vals[n] : vals[n] + (vals[n + 1] - vals[n]) * (upto - n); };
    const histUpto = ph.hist * (w.obs.length - 1);
    const fut = 2100 - w.Y;
    const q = (s) => el.querySelector(s);
    q(".w-raw").setAttribute("d", line(w.f0, w.obs, histUpto));
    q(".w-obs").setAttribute("d", line(w.f0, w.smooth, histUpto));
    ["cp", "you", "all"].forEach((k) => q(".w-" + k).setAttribute("d", ph[k] > 0 ? line(w.Y, w[k], ph[k] * fut) : ""));
    // The moving tip, the year and the temperature: whichever line is drawing.
    const drawing = ph.all > 0 && (ph.all < 1 || mine[mine.length - 1] === "all") ? "all" : ph.you > 0 ? "you" : ph.cp > 0 ? "cp" : "hist";
    let yr, v;
    if (drawing === "hist") { yr = w.f0 + histUpto; v = valAt(w.smooth, histUpto); }
    else { yr = w.Y + ph[drawing] * fut; v = valAt(w[drawing], ph[drawing] * fut); }
    const [hx, hy] = pct(yr, v);
    const head = q(".w-head");
    head.style.left = hx; head.style.top = hy;
    const hotOf = (k) => (k === "you" || k === "all") && q(".w-" + k).classList.contains("hot");
    const tone = drawing === "hist" ? "" : drawing === "cp" ? "cp" : hotOf(drawing) ? "hot" : drawing;
    head.className = "w-head " + tone;
    q(".warm-yr").textContent = Math.round(yr);
    q(".warm-t").textContent = degC(v);
    q(".warm-read").className = "warm-read " + tone;
    // End labels at 2100, nudged apart so they never sit on top of each other.
    const chartH = q(".warm-chart").clientHeight || 1;
    const gapPx = innerWidth < 760 ? 30 : 38;
    const ends = ["cp", "you", "all"].filter((k) => ph[k] >= 1).map((k) => ({ k, y: (Yv(w[k][fut]) / 500) * chartH })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < gapPx) ends[i].y = ends[i - 1].y + gapPx;
    ["cp", "you", "all"].forEach((k) => {
      const e = q(".w-end-" + k), at = ends.find((x) => x.k === k);
      e.style.left = pct(2100, 0)[0];
      if (at) e.style.top = at.y.toFixed(1) + "px";
      e.classList.toggle("on", !!at);
      q(".k-" + k).classList.toggle("on", !!at);
    });
    // Grid: a line per whole degree, and the 1.5°C and 2°C limits.
    const grid = q(".warm-grid");
    const top = Math.floor(y1);
    if (grid.dataset.y1 !== y1.toFixed(3)) {
      grid.dataset.y1 = y1.toFixed(3);
      let g = "";
      for (let t = 0; t <= top; t++) g += '<span class="wg" style="top:' + pct(w.f0, t)[1] + '"><i>' + (t ? "+" + t : "0") + "°C</i></span>";
      g += '<span class="wg lim" style="top:' + pct(w.f0, 1.5)[1] + '"><i>1.5°C limit</i></span>';
      if (2 <= y1) g += '<span class="wg lim two" style="top:' + pct(w.f0, 2)[1] + '"><i>2°C</i></span>';
      grid.innerHTML = g;
    }
    const xs = q(".warm-x");
    const ticks = [1850, 1900, 1950, 2000, 2025, 2050, 2100].filter((t) => t <= x1 + 0.5);
    const key = ticks.join() + x1.toFixed(1);
    if (xs.dataset.k !== key) { xs.dataset.k = key; xs.innerHTML = ticks.map((t) => '<span data-y="' + t + '" style="left:' + pct(t, 0)[0] + '">' + t + "</span>").join(""); }
    // Which caption is showing.
    const cap = drawing === "all" && ph.all > 0.02 ? 5 : drawing === "you" && ph.you > 0.02 ? 4 : ph.cp > 0.02 || ph.zoom > 0.4 ? 3 : ph.hist >= 0.98 ? 2 : ph.hist > 0.55 ? 1 : 0;
    if (el._cap !== cap) { el._cap = cap; el.querySelectorAll(".warm-caps li").forEach((li, i) => { li.classList.toggle("on", i === cap); li.classList.toggle("past", i < cap); }); }
  }

  function openStory(from) {
    if (storyEl || !survey) return;
    const d = storyData();
    storyFrom = from || document.activeElement;
    document.body.insertAdjacentHTML("beforeend", storyHtml(d));
    storyEl = document.body.lastElementChild;
    document.body.classList.add("modal-open", "story-open");
    // It opens out of the button that was pressed.
    const b = from && from.getBoundingClientRect();
    if (b) { storyEl.style.setProperty("--ox", Math.round(b.left + b.width / 2) + "px"); storyEl.style.setProperty("--oy", Math.round(b.top + b.height / 2) + "px"); }
    requestAnimationFrame(() => requestAnimationFrame(() => storyEl && storyEl.classList.add("in")));
    const sc = storyEl.querySelector(".story-scroll");
    const track = storyEl.querySelector(".story-track");
    const kgEl = storyEl.querySelector(".story-kg");
    const savedEl = storyEl.querySelector(".story-saved b");
    const warmTrack = storyEl.querySelector(".warm-track");
    let warmMode = "both";
    const items = [...storyEl.querySelectorAll(".story-steps li")];
    const n = d.steps.length;
    let tick = false, shown = -1;
    const ease = (t) => t * t * (3 - 2 * t);
    const paint = () => {
      tick = false;
      if (!storyEl) return;
      const vh = sc.clientHeight;
      const max = Math.max(1, sc.scrollHeight - vh);
      const ip = Math.min(1, sc.scrollTop / (vh * 0.8));
      const tp = Math.min(1, Math.max(0, (sc.scrollTop - track.offsetTop) / Math.max(1, track.offsetHeight - vh)));
      const f = Math.min(n - 1, Math.max(0, tp * n - 0.5));
      const i0 = Math.floor(f), i1 = Math.min(n - 1, i0 + 1);
      const kg = fsReduce() ? d.steps[Math.round(f)].kg : d.steps[i0].kg + (d.steps[i1].kg - d.steps[i0].kg) * ease(f - i0);
      const active = Math.min(n - 1, Math.floor(tp * n));
      storyEl.style.setProperty("--ip", ip.toFixed(4));
      storyEl.style.setProperty("--tp", tp.toFixed(4));
      storyEl.style.setProperty("--sp", (sc.scrollTop / max).toFixed(4));
      storyEl.style.setProperty("--s", Math.sqrt(kg / d.total).toFixed(4));
      storyEl.style.setProperty("--q", (1 - kg / d.total).toFixed(4));
      storyEl.classList.toggle("under", kg <= d.budget);
      if (warmTrack) paintWarm(warmTrack, d.warm, Math.min(1, Math.max(0, (sc.scrollTop - warmTrack.offsetTop) / Math.max(1, warmTrack.offsetHeight - vh))), warmMode);
      kgEl.textContent = kgFmt(kg);
      savedEl.textContent = "−" + kgFmt(d.total - kg);
      storyEl.classList.toggle("saving", d.total - kg >= 1);
      if (active !== shown) {
        shown = active;
        items.forEach((li, i) => { li.classList.toggle("on", i === active); li.classList.toggle("past", i < active); });
      }
    };
    sc.addEventListener("scroll", () => { if (!tick) { tick = true; requestAnimationFrame(paint); } }, { passive: true });
    window.addEventListener("resize", paint);
    storyEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-story-close]")) return closeStory();
      const pick = e.target.closest("[data-warm-mode]");
      if (pick) {
        warmMode = pick.dataset.warmMode;
        storyEl.querySelectorAll("[data-warm-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.warmMode === warmMode)));
        storyEl.dataset.warm = warmMode;
        warmTrack._cap = -1;
        return paint();
      }
      if (e.target.closest("a[href]")) closeStory(true);
    });
    storyEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); return closeStory(); }
      if (e.key !== "Tab") return;
      // Keep focus inside while it's open.
      const f = [...storyEl.querySelectorAll("button, a[href], [tabindex='0']")];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });
    storyEl._unresize = () => window.removeEventListener("resize", paint);
    paint();
    sc.focus({ preventScroll: true });
  }
  function closeStory(leaving) {
    if (!storyEl) return;
    const el = storyEl;
    storyEl = null;
    el._unresize();
    el.classList.remove("in");
    el.classList.add("out");
    document.body.classList.remove("modal-open", "story-open");
    setTimeout(() => el.remove(), fsReduce() ? 0 : 420);
    if (!leaving && storyFrom && storyFrom.isConnected) storyFrom.focus({ preventScroll: true });
    storyFrom = null;
  }

  // ===== Fresh spin: scroll-linked motion =====
  // On these pages, sections after the hero rise in as they reach the
  // screen, the hero hands a short summary (data-fs-pill on the page) to
  // the top bar as it scrolls away, and a reading line fills under the top
  // bar. CSS reads --rp and --hp (see style.css).
  // items: what rises in (default: everything after the hero). A page can
  // set data-fs-key (redraws with a new key replay the reveal) and
  // data-fs-from/-to (the reading line shows that span of a longer journey).
  const FS_PAGES = [
    { name: "welcome", paths: ["/", "/welcome"], page: ".intro-v2", hero: ".wl", items: ".intro-mission .intro-sec-head, .mission > li, .intro-split > *, .intro-cards > *, .intro-faq > *", onScroll: () => paintWelcome() },
    { name: "results", paths: ["/results"], page: ".results-v2", hero: ".res-hero" },
    { name: "habits", paths: ["/habits", "/check-in"], page: ".hb-page", hero: ".hb3-top-row, .hbf-strip" },
    { name: "survey", paths: ["/"], page: ".survey-v2", hero: ".step-hero", items: ".step-body .q, .step-body > :not(ol):not(ul):not(.q-list)" },
    { name: "survey-done", paths: ["/"], page: ".done-v2", hero: ".cat-hero", items: ".guide-card > .row-between, .answer-tile" },
    { name: "friends", paths: ["/friends"], page: ".fr-page", hero: ".fr-h1", items: ".fr-side > :not(.fr-me), .fr-feed > :not(h1)" },
    { name: "category", prefix: "/explainer/", page: ".cat-v2", hero: ".cat-hero", items: ".cat-sub, .todo-list > li, .cat-col > :not(.cat-sub):not(ol), .cat-aside > *, .cat-steps" },
    { name: "account", paths: ["/account"], page: ".acc-page", hero: ".acc-h1", items: ".acc-quick, .acc-main > :not(h1):not(.acc-row2), .acc-row2 > *" },
  ];
  let fsObs = null, fsPath = "", fsTick = false, fsHero = null, fsCfg = null;
  const fsReduce = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  function freshSpin(path) {
    const bar = document.querySelector(".topbar");
    const cfg = FS_PAGES.find((c) => (c.prefix ? path.startsWith(c.prefix) : c.paths.includes(path)) && app.querySelector(c.page));
    const page = cfg && app.querySelector(cfg.page);
    const hero = page && page.querySelector(cfg.hero);
    const on = !!hero;
    if (fsObs) { fsObs.disconnect(); fsObs = null; }
    fsHero = on ? hero : null;
    fsCfg = on ? cfg : null;
    document.body.classList.toggle("fs-on", on);
    if (!on || cfg.name !== "welcome") { document.body.classList.remove("wl-in"); const tb = document.querySelector(".topbar"); if (tb) tb.classList.remove("on-dark"); }
    FS_PAGES.forEach((c) => document.body.classList.toggle("fs-" + c.name, on && c === cfg));
    if (bar && !bar.querySelector(".read-line")) {
      bar.insertAdjacentHTML("beforeend", '<span class="read-line" aria-hidden="true"><i></i><b></b></span>');
      const brand = bar.querySelector(".brand");
      if (brand) brand.insertAdjacentHTML("afterend", '<span class="nav-total" aria-hidden="true"><span></span> <small></small></span>');
    }
    const key = path + "|" + ((page && page.dataset.fsKey) || "");
    const fresh = fsPath !== key;
    fsPath = key;
    if (!on) return;
    const mini = bar && bar.querySelector(".nav-total");
    if (mini) {
      mini.classList.toggle("none", !page.dataset.fsPill);
      mini.firstChild.textContent = page.dataset.fsPill || "";
      mini.lastChild.textContent = page.dataset.fsUnit || "";
    }
    // Everything after the hero (or the page's own items); cards that sit
    // side by side arrive in turn.
    const targets = [];
    if (cfg.items) targets.push(...page.querySelectorAll(cfg.items));
    else {
      let past = false;
      [...page.children].forEach((el) => {
        if (el === hero || el.contains(hero)) return void (past = true);
        if (!past) return;
        if (el.classList.contains("res-grid")) targets.push(...el.children);
        else targets.push(el);
      });
    }
    const seen = new Map();
    targets.forEach((el) => {
      const k = seen.get(el.parentNode) || 0;
      seen.set(el.parentNode, k + 1);
      if (k) el.style.setProperty("--i", Math.min(k, 3));
    });
    targets.forEach((el) => el.classList.add("cc-rv"));
    // A redraw of the same page (a chart toggle, a tick) just shows everything.
    if (!fresh || fsReduce() || !("IntersectionObserver" in window)) targets.forEach((el) => el.classList.add("is-in"));
    else {
      fsObs = new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("is-in"); fsObs.unobserve(e.target); }
      }), { rootMargin: "0px 0px -12% 0px", threshold: 0.06 });
      targets.forEach((el) => fsObs.observe(el));
    }
    fsScroll();
  }
  function fsScroll() {
    if (!fsHero || !document.body.classList.contains("fs-on")) return;
    if (fsCfg && fsCfg.onScroll) fsCfg.onScroll();
    const max = document.documentElement.scrollHeight - innerHeight;
    let rp = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    const page = fsHero.closest("[data-fs-from]");
    if (page) {
      const from = Number(page.dataset.fsFrom), to = Number(page.dataset.fsTo);
      rp = from + (to - from) * (max > 0 ? rp : 1);
    }
    const bar = document.querySelector(".topbar");
    let hp;
    // A hero that sticks (the phone's level strip) tightens over the first 140px.
    if (getComputedStyle(fsHero).position === "sticky") hp = Math.min(1, scrollY / 140);
    else {
      const r = fsHero.getBoundingClientRect();
      const top = bar ? bar.getBoundingClientRect().bottom : 0;
      hp = Math.min(1, Math.max(0, (top + 40 - r.top) / (r.height * 0.7)));
    }
    if (fsReduce()) hp = hp > 0.5 ? 1 : 0;
    document.body.style.setProperty("--rp", rp.toFixed(4));
    document.body.style.setProperty("--hp", hp.toFixed(4));
  }
  window.addEventListener("scroll", () => {
    if (fsTick) return;
    fsTick = true;
    requestAnimationFrame(() => { fsTick = false; fsScroll(); });
  }, { passive: true });
  window.addEventListener("resize", fsScroll);

  // Plays once per visit, when it scrolls into view.
  function animateProgress() {
    const el = app.querySelector(".pg:not(.pg-seen)");
    if (!el) return;
    el.classList.add("pg-seen");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sig = el.querySelector(".pg-plot").getAttribute("aria-label");
    if (reduce || !("IntersectionObserver" in window) || ui.pgPlayed === sig) {
      el.classList.add("still");
      return el.classList.add("in");
    }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        ui.pgPlayed = sig;
        el.classList.add("in");
      }
    }, { threshold: 0.35 });
    io.observe(el);
  }

  // Results end in action: the three changes that would cut the most, each
  // opening its step (with the guide) on the category page. The saving is
  // one big drawing of your mascot, cut into a slice per move (its share of
  // the saving), the slices filling in one after another.
  function movesHtml(tips) {
    const top = tips.filter((x) => x.t.saving >= 0.5).sort((a, b) => b.t.saving - a.t.saving).slice(0, 3);
    if (!top.length) return "";
    const cut = top.reduce((t, x) => t + x.t.saving, 0);
    const items = piItems();
    const pal = items.find((x) => x.key === piMascot()) || items[0];
    const parts = (D.FUN_COMPARISONS.art[pal.key] || []).map((p) => '<path d="' + p[0] + '"></path>').join("");
    // Tall shapes and heights fill from the ground up; the rest side by side.
    const up = pal.type === "h" || ["shoebill", "sunfish"].includes(pal.key);
    const total = pal.type === "h" ? cubeSide(cut) / pal.size : cut / pal.size;
    const ofA = (/^[aeiou]/i.test(pal.one) ? "an " : "a ") + pal.one;
    const worth = pal.type === "h"
      ? "a cube of CO₂ " + cubeSide(cut).toFixed(1) + " m tall: " + howMany(total, pal)
      : total >= 1 ? howMany(total, pal) : Math.max(1, Math.round(total * 100)) + "% of " + ofA;
    // Slices left to right, by share of the saving (laid out on the
    // drawing's own width once it's on the page).
    let at = 0;
    const slices = top.map((x, i) => {
      const s = { i, c: CAT_COLOR[x.b.key], from: at, share: x.t.saving / cut };
      at += s.share;
      return s;
    });
    const big =
      '<svg class="mv3-big" viewBox="' + (up ? "-1 -6 56 56" : "0 -6 48 56") + '" role="img" aria-label="Your mascot, ' + esc(pal.one) + ", split into the three moves: " +
      top.map((x) => esc(x.t.realisticLabel || x.t.title) + " " + Math.round((x.t.saving / cut) * 100) + "%").join(", ") + '">' +
      '<defs><clipPath id="mv3-sil">' + parts + "</clipPath>" +
      slices.map((s) => '<clipPath id="mv3-band' + s.i + '"><rect class="mv3-band" data-from="' + s.from.toFixed(4) + '" data-share="' + s.share.toFixed(4) + '" x="0" y="-6" width="0" height="56"></rect></clipPath>').join("") + "</defs>" +
      '<g class="mv3-ghost" filter="url(#pi-grey)">' + piArt(pal.key, true, true) + "</g>" +
      slices.map((s) => '<g clip-path="url(#mv3-band' + s.i + ')"><g clip-path="url(#mv3-sil)"><rect x="0" y="-6" width="48" height="56" fill="' + s.c + '"></rect><rect x="0" y="-6" width="48" height="56" fill="url(#pi-sheen)"></rect></g><g class="mv3-shade">' + piArt(pal.key, false, true) + "</g></g>").join("") +
      '<g clip-path="url(#mv3-sil)">' + slices.map((s) => '<line class="mv3-cut" data-at="' + (s.from + s.share).toFixed(4) + '" x1="0" x2="0" y1="-6" y2="50"></line>').slice(0, -1).join("") + "</g>" +
      slices.map((s) => '<g class="mv3-tag" data-mid="' + (s.from + s.share / 2).toFixed(4) + '" style="--d:' + (0.2 + s.i * 0.7).toFixed(2) + 's"><circle r="3.4" fill="' + s.c + '"></circle><text y="1.3" text-anchor="middle" font-size="3.8" font-weight="800" fill="#FFFCF5">' + (s.i + 1) + "</text></g>").join("") +
      "</svg>";
    return (
      '<section class="glass moves mv3' + (up ? " mv3-up" : "") + '" aria-labelledby="moves-h">' + piDefsSvg() +
      '<h2 id="moves-h" class="card-title">Your 3 biggest moves</h2><div class="mv3-in">' +
      '<figure class="mv3-fig">' + big + '<figcaption><b class="display tnum">−<span data-mv-to="' + Math.round(cut) + '">' + kgFmt(cut) + '</span> kg</b><span>a year: ' + esc(worth) + "</span></figcaption></figure>" +
      '<ol class="mv3-list">' +
      top
        .map(
          (x, i) =>
            '<li style="--c:' + CAT_COLOR[x.b.key] + ";--d:" + (0.2 + i * 0.7).toFixed(2) + 's"><a class="move mv3-row" href="' + catHref(x.b.key) + '" data-action="open-move" data-cat="' + x.b.key + '">' +
            '<span class="mv3-n display">' + (i + 1) + "</span>" +
            '<span class="mv3-text"><b class="display">' + esc(capFirst(x.t.realisticLabel || x.t.title)) + '</b><span class="xs muted">' + esc(x.b.label) + " · " + Math.round((x.t.saving / cut) * 100) + "% of " + esc(pal.key === "lettuce" ? "the lettuce" : "your " + (["devito", "lincoln", "argentinosaurus"].includes(pal.key) ? pal.short : pal.short.toLowerCase())) + "</span></span>" +
            '<span class="move-kg"><b class="display tnum">−' + kgFmt(x.t.saving) + '</b><span class="xs muted">kg</span></span>' + icon("chevronRight") + "</a></li>"
        )
        .join("") +
      "</ol></div></section>"
    );
  }
  // Under the chart: your biggest move, and the greener switches beside it.
  function nextStepsHtml(tips) {
    const top = tips.filter((x) => x.t.saving >= 0.5).sort((a, b) => b.t.saving - a.t.saving)[0];
    let sw = 0;
    try { sw = switchAreas(switchBase()).reduce((t, a) => t + (a.save || 0), 0); } catch (e) {}
    return (
      '<div class="res-next">' +
      (top
        ? '<a class="res-next-go move-go" href="' + catHref(top.b.key) + '" data-action="open-move" data-cat="' + top.b.key + '"><span class="res-next-ic">' + ((D.EXPLAINERS[top.b.key] || {}).icon || "") + "</span>" +
          '<span class="res-next-k">Your biggest move</span><b class="display">' + esc(capFirst(top.t.realisticLabel || top.t.title)) + '</b><span class="res-next-kg tnum">−' + kgFmt(top.t.saving) + " kg a year " + icon("arrowRight") + "</span></a>"
        : "") +
      '<a class="res-next-go sw-go" href="/greener-switches/"><span class="res-next-ic">' + icon("leaf") + "</span>" +
      '<span class="res-next-k">Greener switches</span><b class="display">The 7 Acts, worked out for you</b><span class="res-next-kg tnum">' + (sw >= 0.5 ? "Up to −" + kgFmt(sw) + " kg a year " : "See them ") + icon("arrowRight") + "</span></a>" +
      "</div>"
    );
  }
  // Lays the slices on the drawing's real width, then fills them in one
  // after another when the moves scroll into view (once).
  function animateMoves() {
    const el = app.querySelector(".mv3:not(.mv-seen)");
    if (!el) return;
    el.classList.add("mv-seen");
    const svg = el.querySelector(".mv3-big");
    let x0 = 4, y0 = 2, w = 40, h = 44;
    try {
      const b = svg.querySelector(".mv3-ghost").getBBox();
      if (b.width > 4) { x0 = b.x; y0 = b.y; w = b.width; h = b.height; }
    } catch (e) {}
    // Tall shapes and heights (Danny DeVito, a bus) are sliced across and
    // fill from the ground up; wide ones are sliced side by side.
    const up = el.classList.contains("mv3-up");
    const bands = [...el.querySelectorAll(".mv3-band")];
    const bottom = y0 + h;
    if (up) bands.forEach((r) => { r.setAttribute("x", "-6"); r.setAttribute("width", "68"); r.setAttribute("height", "0"); r.setAttribute("y", (bottom - Number(r.dataset.from) * h).toFixed(2)); });
    else bands.forEach((r) => r.setAttribute("x", (x0 + Number(r.dataset.from) * w).toFixed(2)));
    el.querySelectorAll(".mv3-cut").forEach((l) => {
      const a = Number(l.dataset.at);
      if (up) { const y = (bottom - a * h).toFixed(2); l.setAttribute("x1", "-6"); l.setAttribute("x2", "62"); l.setAttribute("y1", y); l.setAttribute("y2", y); }
      else { const x = (x0 + a * w).toFixed(2); l.setAttribute("x1", x); l.setAttribute("x2", x); }
    });
    // Number tags: above each slice, or beside it on the right.
    el.querySelectorAll(".mv3-tag").forEach((g) => {
      const m = Number(g.dataset.mid);
      g.setAttribute("transform", up ? "translate(" + Math.min(52, x0 + w + 4.5).toFixed(2) + " " + (bottom - m * h).toFixed(2) + ")" : "translate(" + (x0 + m * w).toFixed(2) + " -2.4)");
    });
    const fill = (k) => bands.forEach((r) => {
      const len = Number(r.dataset.share) * (up ? h : w) * k(r);
      if (up) { r.setAttribute("height", len.toFixed(2)); r.setAttribute("y", (bottom - Number(r.dataset.from) * h - len).toFixed(2)); }
      else r.setAttribute("width", len.toFixed(2));
    });
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Once per visit: the page redraws when data arrives, and that
    // shouldn't replay it.
    const sig = el.querySelector("[data-mv-to]").dataset.mvTo + location.hash;
    if (reduce || !("IntersectionObserver" in window) || ui.mvPlayed === sig) {
      fill(() => 1);
      el.classList.add("still");
      return el.classList.add("in");
    }
    el.querySelectorAll("[data-mv-to]").forEach((m) => (m.textContent = "0"));
    const play = () => {
      ui.mvPlayed = sig;
      el.classList.add("in");
      const t0 = performance.now(), each = 650, gap = 700, nums = [...el.querySelectorAll("[data-mv-to]")];
      const ease = (v) => 1 - Math.pow(1 - Math.max(0, Math.min(1, v)), 3);
      const tick = (t) => {
        const ms = t - t0 - 200;
        fill((r) => ease((ms - bands.indexOf(r) * gap) / each));
        const all = ease(ms / (gap * (bands.length - 1) + each));
        nums.forEach((m) => (m.textContent = Math.round(Number(m.dataset.mvTo) * all).toLocaleString()));
        if (ms < gap * bands.length + each) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        play();
      }
    }, { threshold: 0.3 });
    io.observe(el);
  }

  // The one main thing to do from Results: your next act, as the primary button.
  function heroNextAct() {
    let a = null;
    try { a = habitActs().acts.find((x) => !x.done && !x.pending); } catch (e) {}
    if (!a) return "";
    const save = a.save >= 0.5 && a.n <= 4 ? '<span class="res-cta-kg tnum">−' + kgFmt(a.save) + " kg</span>" : "";
    return '<a class="btn btn-green res-cta" href="#/habits" data-action="hero-next" data-n="' + a.n + '"><span class="min0"><small>Your next act</small><b>' + esc(a.name) + "</b></span>" + save + icon("arrowRight") + "</a>";
  }
  function renderResults() {
    const fp = footprint(survey);
    const tips = fp.breakdown.map((b) => ({ b, t: tipFor(b.key, survey) }));
    const totalSaving = tips.reduce((sum, x) => sum + x.t.saving, 0);
    const totalMax = tips.reduce((sum, x) => sum + x.t.maxSaving, 0);
    const now = fp.totalYearly;
    const pct = (v) => (now ? Math.round((v / now) * 100) : 0);
    const cmp = ukComparison(fp);
    const budget = D.BUDGET_YEARLY;
    // The path to the budget is like for like (see budgetBasis): no money,
    // plus typical shopping, for you and for the UK average alike.
    const bb = budgetBasis(fp, tips);
    const lifeNow = bb.life;
    const lifeSaving = Math.max(0, totalSaving - bb.moneySave);
    const after = Math.max(0, lifeNow - lifeSaving);
    const afterMax = Math.max(0, lifeNow - Math.max(0, totalMax - bb.moneyMax));
    const lifePct = (v) => (lifeNow ? Math.round((v / lifeNow) * 100) : 0);
    const ukTotal = cmp.uk + bb.shop;
    const snapshots = getSnapshots();
    const mode = ui.showUk ? "bars" : ui.chartMode || "donut";
    const animate = !ui.resultsSeen;
    ui.resultsSeen = true;

    const ukTag = cmp.pct < 5 ? "About the UK average" : cmp.pct + "% " + (cmp.above ? "above" : "below") + " the UK average";
    const budgetRatio = lifeNow / budget;
    const budgetTag = budgetRatio <= 1 ? "Inside the 1.5°C budget" : budgetRatio < 1.5 ? Math.round((budgetRatio - 1) * 100) + "% over the 1.5°C budget" : budgetRatio.toFixed(1).replace(/\.0$/, "") + "× the 1.5°C budget";

    // Path bar scale: room for now, the UK average and the budget.
    const scale = Math.max(lifeNow, ukTotal, budget) * 1.15;
    const W = (v) => Math.min(100, (v / scale) * 100).toFixed(2);
    // Labels near either end line up with the mark instead of centring, so they stay inside the card.
    const edge = (pct) => (pct < 22 ? " edge-l" : pct > 78 ? " edge-r" : "");
    let html = '<div class="container results-v2" data-fs-pill="' + kgFmt(now) + '" data-fs-unit="kg">' + (ui.exampleMode ? "" : celebrationCard() + newFiguresCard());
    if (ui.exampleMode) {
      html +=
        '<div class="glass example-banner"><div><span class="eyebrow">Example result</span><p>This is a typical UK resident\'s footprint, worked out the same way as yours will be.</p></div>' +
        '<button type="button" class="btn btn-green" data-action="start-survey">Start your own ' + icon("arrowRight") + "</button></div>";
    }

    if (!ui.exampleMode && checkInDue() && !(lsGet(KEY_CHECKIN_SNOOZE, 0) > Date.now())) {
      html +=
        '<div class="card callout fade-up"><div class="callout-row"><div class="round-badge">' + icon("calendar") + '</div><div class="grow">' +
        '<h2 class="card-title mb-1">Time for your monthly check-in</h2><p class="sm muted mb-4 max-2xl">It\'s a new month since you last surveyed (' +
        esc(monthLabel(snapshots[snapshots.length - 1].month)) +
        '). Update your answers to see how your footprint has changed.</p>' +
        '<div class="chip-row" style="align-items:center"><a class="btn btn-green" href="#/">Update my survey ' + icon("arrowRight") + "</a>" +
        '<button type="button" class="link-btn checkin-later" data-action="checkin-later">Remind me later</button></div></div></div></div>';
    }

    if (!ui.exampleMode) html += resultTabs(fp, null);

    html +=
      '<section class="glass res-hero' + (animate ? " rise" : "") + '"><div class="res-hero-main">' +
      '<p class="fw-600 muted">Your footprint this year</p>' +
      '<div class="res-total"><span class="display tnum" data-countup="' + Math.round(now) + '">' + kgFmt(animate ? 0 : now) + '</span><span class="muted">kg CO₂e</span></div>' +
      '<div class="res-tags"><span class="res-tag ' + (cmp.pct < 5 ? "" : cmp.above ? "up" : "down") + '">' + ukTag + "</span>" +
      '<a class="res-tag ' + (budgetRatio <= 1 ? "down" : "up") + '" href="#/budget">' + budgetTag + "</a></div></div>" +
      '<div class="res-hero-path"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><span class="fw-600 muted">With realistic changes</span>' +
      (lifeSaving > 0.5 ? '<span class="res-chip">−' + kgFmt(lifeSaving) + " kg · " + lifePct(lifeSaving) + "% less</span>" : "") +
      '</div><div class="res-after"><span class="display tnum">' + kgFmt(after) + '</span><span class="muted">kg a year</span></div>' +
      // Both markers are labelled above the bar; when they're close, the UK one sits a line higher.
      '<div class="path' + (animate ? " animate" : "") + (Math.abs(W(ukTotal) - W(budget)) < 34 ? " two-rows" : "") + '">' +
      '<span class="path-mark budget' + edge(W(budget)) + '" style="left:' + W(budget) + '%"><i>1.5°C · ' + (budget / 1000).toFixed(1) + " t</i></span>" +
      '<span class="path-mark uk' + edge(W(ukTotal)) + '" style="left:' + W(ukTotal) + '%"><i>UK avg · ' + (ukTotal / 1000).toFixed(1) + " t*</i></span>" +
      '<span class="path-now" style="width:' + W(lifeNow) + '%"></span>' +
      '<span class="path-real" style="width:' + W(after) + '%"></span>' +
      '<span class="path-all" style="width:' + W(afterMax) + '%"></span></div>' +
      '<div class="path-legend"><span><i class="lg-all"></i>All the way <b class="tnum">' + kgFmt(afterMax) + "</b></span>" +
      '<span><i class="lg-real"></i>Realistic <b class="tnum">' + kgFmt(after) + "</b></span>" +
      '<span><i class="lg-now"></i>Now <b class="tnum">' + kgFmt(lifeNow) + "</b></span></div>" +
      '<p class="xs muted mt-2">Compared like for like. <a class="link-btn" href="#/budget">How we compare</a></p></div>' + heroNextAct() + "</section>";

    html +=
      '<div class="res-grid">' + (ui.exampleMode ? "" : pictureItHtml()) + '<section class="glass res-chart"><div class="row-between gap-3" style="flex-wrap:wrap">' +
      '<div><h2 class="card-title">Where it comes from</h2><p class="sm muted">Tap one to see how to cut it</p></div>' +
      '<div class="chip-row" style="align-items:center">' +
      '<button type="button" class="uk-toggle' + (ui.showUk ? " on" : "") + '" data-action="toggle-uk" aria-pressed="' + (ui.showUk ? "true" : "false") + '">' +
      '<span class="uk-toggle-track"><span class="uk-toggle-knob"></span></span>UK average</button>' +
      '<div class="seg" role="group" aria-label="Chart type">' +
      '<button type="button" data-action="chart-mode" data-mode="donut" aria-pressed="' + (mode === "donut") + '"' + (mode === "donut" ? ' class="on"' : "") + ">Donut</button>" +
      '<button type="button" data-action="chart-mode" data-mode="bars" aria-pressed="' + (mode === "bars") + '"' + (mode === "bars" ? ' class="on"' : "") + ">Bars</button></div></div></div>" +
      (ui.showUk ? '<div class="chart-legend xs muted mt-3"><span><i class="lg-you"></i>You</span><span><i class="lg-uk"></i>Typical UK resident</span><span>No UK figure for money</span></div>' : "") +
      '<div class="res-chart-body">' + (mode === "bars" ? barsChart(fp) : donutChart(fp)) + "</div>" + (ui.exampleMode ? "" : nextStepsHtml(tips)) +
      (ui.showUk
        ? '<p class="xs muted mt-2">UK averages use official figures: Defra\'s typical weekly diet, ONS trips abroad with DESNZ flight factors, Ofgem energy use and DfT commuting.</p>'
        : "") +
      "</section></div>" + (ui.exampleMode ? "" : movesHtml(tips));

    // Your progress, as a graph: account history if signed in, else the
    // monthly snapshots kept on this device.
    const hist = ui.exampleMode ? [] : historyByDay();
    const sameYear = (d) => d.getFullYear() === new Date().getFullYear();
    if (hist.length) {
      html += progressHtml(
        hist.slice().reverse().map((h) => {
          const d = new Date(h.completedAt);
          return { kg: h.totalYearly, label: d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }), short: d.toLocaleDateString(undefined, sameYear(d) ? { day: "numeric", month: "short" } : { month: "short", year: "2-digit" }) };
        }),
        "Take the survey again in a few months to draw your line."
      );
    } else if (!ui.exampleMode && snapshots.length) {
      html += progressHtml(
        snapshots.map((s) => ({ kg: snapshotYearly(s), label: monthLabel(s.month), short: monthLabel(s.month).replace(/ (\d{2})(\d{2})$/, " ’$2") })),
        "Take the survey again next month to draw your line."
      );
    }

    if (ui.exampleMode) {
      return html + '<div class="center mt-6"><button type="button" class="btn btn-green" data-action="start-survey">Start your own survey ' + icon("arrowRight") + "</button></div></div>";
    }
    html +=
      '<div class="btn-row mt-6"><button type="button" class="btn btn-outline" data-action="edit-survey">' + icon("refresh") + " Edit my answers</button></div>" +
      saveCard() + (historyByDay().length >= 2 ? supportCard() : "") +
      '<p class="xs muted footnote">Estimates, to guide you to your biggest wins. Figures updated ' +
      esc(shortDate(figuresUpdated())) + '. <a class="link-btn" href="/how-we-calculate/">How we calculate</a></p></div>';
    return html;
  }

  // ==================== Explainer page ====================

  // One line about the person's own answers for a category page.
  function categorySummary(cat) {
    if (cat === "water") return answerSummary("energy", survey)[1].split(" · ")[1] || "";
    const step = cat === "energy" ? "energy" : cat;
    const lines = answerSummary(step, survey);
    return cat === "energy" ? lines[0] : lines.join(" · ");
  }

  function renderExplainer(cat) {
    const ex = D.EXPLAINERS[cat];
    if (!ex) {
      location.replace("#/results");
      return "";
    }
    const tip = tipFor(cat, survey);
    const fp = footprint(survey);
    const diet = cat === "meals" ? D.DIET_EXPLAINERS[dietType(survey)] : null;
    const sections = (diet && diet.sections) || ex.sections;
    const idx = Math.max(0, fp.breakdown.findIndex((b) => b.key === cat));
    const item = fp.breakdown[idx] || { yearly: 0, label: ex.title };
    const total = fp.totalYearly || 1;
    const share = Math.max(item.yearly > 0 ? 1 : 0, Math.round((item.yearly / total) * 100));
    const uk = ukAverageByKey()[cat];
    const n = fp.breakdown.length;
    const rank = idx < 3 ? "Your #" + (idx + 1) + " source" : "#" + (idx + 1) + " of " + n + " sources";
    const ukLine =
      uk == null
        ? "No UK average for banking and pensions"
        : "UK average " + kgFmt(uk) + " kg · you're " +
          (Math.abs(item.yearly - uk) / uk < 0.03 ? "about the same" : item.yearly > uk ? Math.round((item.yearly / uk - 1) * 100) + "% above" : Math.round((1 - item.yearly / uk) * 100) + "% below");
    const prev = fp.breakdown[(idx + n - 1) % n];
    const next = fp.breakdown[(idx + 1) % n];
    const sMax = Math.max(item.yearly, uk || 0, 1);
    const bar = (label, v, cls) =>
      '<div><div class="row-between"><span>' + label + '</span><b class="display tnum">' + kgFmt(v) + ' kg</b></div><div class="drop-track"><span class="' + cls + '" style="width:' + Math.max(0, (v / sMax) * 100).toFixed(1) + '%"></span></div></div>';

    let html =
      '<div class="container cat-v2" data-fs-pill="' + esc(CAT_SHORT[cat] || ex.title) + '" data-fs-unit="' + kgFmt(item.yearly) + ' kg">' + resultTabs(fp, cat) +
      '<a class="back-overview" href="#/results">' + icon("chevronLeft") + " Back to overview</a>" +
      '<header class="glass cat-hero rise"><span class="cat-watermark" aria-hidden="true">' + ex.icon + "</span>" +
      '<div class="cat-hero-main"><div class="label-row"><span class="cat-badge">' + ex.icon + '</span><span class="eyebrow">' + rank + "</span></div>" +
      '<h1 class="cat-title display">' + esc(ex.title) + '</h1><p class="cat-why">' + esc(firstSentence(ex.why)) + "</p></div>" +
      '<div class="cat-hero-side"><div class="cat-figs"><div class="cat-kg display tnum">' + kgFmt(item.yearly) + "</div>" +
      '<div class="muted">kg CO₂e a year</div><div class="cat-yours">' + esc(categorySummary(cat)) + "</div>" +
      '<div class="cat-uk">' + esc(ukLine) + "</div></div>" +
      '<figure class="cat-share"><svg viewBox="0 0 42 42" role="img" aria-label="' + share + '% of your total footprint"><circle cx="21" cy="21" r="20" fill="rgba(63,91,58,.12)"></circle>' +
      '<circle cx="21" cy="21" r="10" fill="none" stroke="#3F5B3A" stroke-width="20" pathLength="100" stroke-dasharray="' + share + ' 100" transform="rotate(-90 21 21)"></circle></svg>' +
      '<figcaption><b class="display">' + share + '%</b><span>of your footprint</span></figcaption></figure></div></header>';

    // Diet cards the survey shows are already done are left out (habits are
    // separate: they track changes from here). Flight cards stay, marked
    // Done, so people come back to them.
    const shown = sections.map((s, i) => ({ s, i })).filter(({ s }) => !(diet && sectionDone(cat, s)) && !sectionHidden(cat, s))
      .sort((a, b) => (sectionNA(cat, a.s) ? 1 : 0) - (sectionNA(cat, b.s) ? 1 : 0));
    const live = shown.filter(({ s }) => !sectionNA(cat, s)).length;
    html +=
      '<div class="cat-grid"><section class="cat-col"><div class="row-between gap-3 cat-sub" style="flex-wrap:wrap;align-items:baseline">' +
      '<h2 class="display">' + (live === 0 ? "Nothing to do here" : "Your " + (live === 1 ? "next step" : live + " next steps")) + '</h2><span class="muted">' + (live === 0 ? "None of these apply to you" : "Tap one for the details") + "</span></div>" +
      '<ol class="todo-list">' +
      shown
        .map(({ s, i }, k) => {
          const na = sectionNA(cat, s);
          const done = !na && (cat === "flights" || cat === "banking") && sectionDone(cat, s);
          const tag = done ? '<span class="tag done-tag">Done</span>' : na ? '<span class="tag na-tag">Not applicable</span>' : "";
          return (
            '<li class="section-card todo rise' + (done ? " done" : na ? " na" : "") + '" data-action="open-section" data-index="' + i + '" role="button" tabindex="0" style="animation-delay:' + (0.06 * (k + 1)).toFixed(2) + 's">' +
            '<span class="num-badge' + (k === 0 && !done && !na ? " lead" : "") + '">' + (done ? icon("check") : k + 1) + "</span>" +
            '<div class="min0"><h3 class="todo-title display">' + esc(s.heading) + (tag ? " " + tag : "") + "</h3>" +
            '<p class="todo-body">' + esc(s.body) + "</p>" + sectionTeaser(s) +
            (i === guideIndex(cat) && !na && !done ? '<span class="todo-guide">Step-by-step guide inside ' + icon("arrowRight") + "</span>" : "") + "</div>" +
            '<span class="todo-more">' + icon("chevronRight") + "</span></li>"
          );
        })
        .join("") +
      "</ol>" + usefulLinksCard(cat) + "</section>" +
      '<aside class="cat-aside"><section class="glass cat-drop"><h3 class="display">What this could drop to</h3><div class="stack-3 mt-4">' +
      bar("Now", item.yearly, "d-now") +
      bar("Realistic", Math.max(0, item.yearly - tip.saving), "d-real") +
      bar("All the way", Math.max(0, item.yearly - tip.maxSaving), "d-all") +
      (uk != null ? '<div class="drop-uk">' + bar("Typical UK resident", uk, "d-uk") + "</div>" : "") +
      "</div>" +
      (tip.saving > 0.5 ? '<p class="xs muted mt-3">Realistic: ' + esc(tip.realisticLabel || tip.title) + ".</p>" : "") +
      "</section>" +
      (ex.fact ? '<section class="cat-fact"><span class="eyebrow">Good to know</span><p class="display">' + esc(ex.fact) + "</p></section>" : "") +
      '<section class="cat-plan"><h3 class="display">Build the habit</h3>' +
      '<a class="plan-go" href="#/habits">Open My Habits ' + icon("arrowRight") + "</a></section></aside></div>" +
      '<div class="cat-steps"><a class="cat-step" href="#/explainer/' + prev.key + '">' + icon("chevronLeft") +
      '<span><small>Previous</small><b>' + esc(prev.label) + "</b></span></a>" +
      '<a class="cat-step next" href="#/explainer/' + next.key + '"><span><small>Next</small><b>' + esc(next.label) + "</b></span>" + icon("chevronRight") + "</a></div></div>";
    return html;
  }

  // ---------- step-by-step guide pages ----------

  // The first next step in each category, worked through with numbers from
  // the person's own answers.
  function guideSpec(cat) {
    const tip = tipFor(cat, survey);
    const kg = (v) => Math.round(v);
    if (cat === "meals") {
      const rows = D.MEAL_OPTIONS.slice().sort((a, b) => b.factor - a.factor).map((o) => [o.label, o.factor, o.emoji]);
      const beef = byKey(D.MEAL_OPTIONS, "beef").factor;
      const vegan = byKey(D.MEAL_OPTIONS, "vegan").factor;
      // What to say depends on what's already on the plate.
      const diet = dietType(survey);
      const lowWaste = ((survey.meals || {}).foodWaste || "low") === "low";
      const wasteSteps = [
        ["Plan the week's meals", "A rough plan and a shopping list mean buying only what you'll eat."],
        ["Use the freezer", "Freeze bread, leftovers and veg that's about to turn."],
        ["Check the fridge first", "Eat what's open or nearly out of date before starting something new."],
        ["Trust your senses", "'Best before' is about quality, not safety. Look and smell before you bin it."],
      ];
      const base = { save: tip.saving, saveLabel: "Realistic saving for you", vsTitle: "One day's main meals, kg CO₂e", headline: "1 beef day ≈ " + Math.round(beef / vegan) + " vegan days", unit: "kg", rows, source: "CO2 Counter's meal factors (see How we calculate)." };
      if (diet === "vegan")
        return {
          ...base,
          title: "You eat plant-based. Go a bit further?",
          lede: "Your days are already the lowest-carbon way to eat. You can still go a bit further by wasting less and choosing local, seasonal produce.",
          saveLabel: lowWaste ? "Already low-waste" : "Wasting less could save",
          steps: [
            wasteSteps[0],
            ["Eat local and seasonal", "In-season produce grown nearby needs less heated greenhouse growing, storage and transport. A local veg box makes it easy."],
            wasteSteps[1],
            wasteSteps[3],
          ],
        };
      if (diet === "veggie")
        return {
          ...base,
          title: "You're vegetarian. Go a bit further?",
          lede: "No meat already puts you well below a typical diet. Dairy and eggs are most of what's left, so a few vegan days take you further.",
          steps: [
            ["Pick one or two vegan days", "Start with meals that are nearly vegan already: curries, stir-fries, pasta with tomato sauce."],
            ["Swap the milk", "Oat milk has about {{oat_cut}} less carbon than dairy milk, and works in tea, coffee and cereal."],
            ["Go easy on cheese", "Cheese is the highest-carbon food most vegetarians eat. Use less, with stronger flavours."],
            ["Waste less", "Planning meals and using the freezer stops good food going in the bin."],
          ],
        };
      if (diet === "pescatarian" || diet === "other_meat")
        return {
          ...base,
          title: "Swap a few meat days for plants",
          lede: "You already skip red meat, which is the biggest food change. Swapping a few " + (diet === "pescatarian" ? "fish" : "chicken or fish") + " days for plant-based meals takes you further.",
          steps: [
            ["Pick your swap days", "Choose one or two days a week to go plant-based. The same days each week makes it stick."],
            ["Swap like for like", "Use lentils, beans or tofu in the same recipe: curry, stir-fry, tacos, pasta."],
            ["Keep the flavour", "Smoked paprika, soy sauce, mushrooms and tomato purée give the savoury depth people miss."],
            ["Waste less", "Planning meals and using the freezer stops good food going in the bin."],
          ],
        };
      return {
        ...base,
        title: "Cut red meat first",
        lede: "Beef and lamb are the outliers in any week. Swapping two or three red-meat days for chicken, fish or plants is usually the single biggest food change you can make.",
        steps: [
          ["Pick your swap days", "Choose two or three red-meat days a week to change first. The same days each week makes it stick."],
          ["Swap like for like", "Use chicken, lentils or beans in the same recipe: chilli, bolognese, curry, burgers."],
          ["Keep the flavour", "Smoked paprika, soy sauce, mushrooms and tomato purée give the savoury depth people miss."],
          ["Save beef for when it matters", "Keep it for the meals you love most, rather than the everyday ones."],
        ],
      };
    }
    if (cat === "banking") {
      const b = survey.banking || {};
      const amount = b.amount > 0 ? b.amount : 5000;
      const mine = byKey(D.BANKS, b.bank);
      const best = D.BANKS.reduce((m, x) => (x.factor < m.factor ? x : m), D.BANKS[0]);
      const others = D.BANKS.filter((x) => !x.green);
      const avg = others.reduce((t, x) => t + x.factor, 0) / Math.max(1, others.length);
      const myF = mine ? mine.factor : avg;
      const pension = byKey(D.PENSION_PROVIDERS, b.pensionProvider);
      // Already with a very good bank: show how far they've come from the
      // worst, and the little extra the greenest would add.
      const worst = D.BANKS.reduce((m, x) => (x.factor > m.factor ? x : m), D.BANKS[0]);
      const done = mine && bankRating(mine).key === "vgood";
      const bare = (x) => x.label.replace(/^The /, "");
      return {
        title: done ? (mine.key === best.key ? "You're with the greenest bank" : "You've switched. Go a bit further?") : "Move your money somewhere greener",
        lede: done
          ? "You're already with " + bare(mine) + ", one of the greenest banks: your £" + amount.toLocaleString() + " finances about " + kgFmt(amount * (worst.factor - mine.factor)) + " kg CO₂e a year less than at " + bare(worst) + "." +
            (mine.key === best.key ? " There's no greener bank on our list." : " " + bare(best) + " would cut a little more.")
          : "Banks lend out the money you keep with them. Some lend heavily to fossil fuels, others don't. Switching is a one-off job with a lasting effect.",
        save: Math.max(0, (myF - best.factor) * amount), saveLabel: "Moving £" + amount.toLocaleString() + " to " + best.label,
        vsTitle: "£" + amount.toLocaleString() + " kept for a year, kg CO₂e financed",
        headline: myF > best.factor ? Math.round((1 - best.factor / myF) * 100) + "% less at " + best.label : "You're already with the best bank here", unit: "kg",
        rows: (done ? [[bare(worst) + " (one of the worst)", amount * worst.factor, "🏦"]] : [])
          .concat([[(mine ? mine.label + " (yours)" : "Average high-street bank"), amount * myF, "🏦"]])
          .concat(mine && mine.key === best.key ? [] : [[best.label, amount * best.factor, "🌱"]]),
        source: "Bank factors from CO2 Counter's data (MotherTree bank league table).",
        steps: [
          ["Check how your bank ranks", "Independent league tables rank UK banks by the emissions your money helps finance."],
          ["Pick a greener bank", "Banks like Triodos, the Co-operative Bank and Nationwide avoid or limit fossil-fuel lending."],
          ["Use the switch service", "The free Current Account Switch Service moves your balance, direct debits and standing orders in 7 working days, with a guarantee."],
          pension && pension.unfunded
            ? ["Your pension", pension.label + " isn't invested in companies, so there's nothing to switch. If you have a personal pension too, ask that provider about climate-focused funds."]
            : ["Ask about your pension", (pension && pension.key !== "other" ? "Ask " + pension.label : "Ask your provider") + " which climate-focused funds it offers. Pensions can matter even more than bank accounts."],
        ],
      };
    }
    if (cat === "energy") {
      const e = survey.energy || {};
      const hh = Math.max(1, e.household || 1);
      const year = (f) => (12 * (e.electricityKwh || 0) * f) / hh;
      const std = year(D.ELECTRICITY_FACTOR);
      const green = year(D.GREEN_ELECTRICITY_FACTOR);
      return {
        title: "Switch to a green electricity tariff",
        lede: e.greenTariff
          ? "You're already on a green tariff, which is the biggest single step. Here's what it's saving, and what to do next."
          : "You're on a standard tariff. A 100% renewable one takes a few clicks, needs no new kit, and your supply never stops.",
        save: e.greenTariff ? 0 : std - green, saveLabel: e.greenTariff ? "Already saving you" : "Your share of the saving",
        saveOverride: e.greenTariff ? std - green : null,
        vsTitle: "Your electricity for a year, kg CO₂e", headline: Math.round((1 - D.GREEN_ELECTRICITY_FACTOR / D.ELECTRICITY_FACTOR) * 100) + "% less", unit: "kg",
        rows: [["Standard tariff", std, "⚡"], ["Green tariff", green, "🌱"]],
        source: (e.electricityKwh || 0) + " kWh a month shared by " + hh + (hh === 1 ? " person" : " people") + ". " + D.ELECTRICITY_FACTOR + " kg/kWh standard grid, " + D.GREEN_ELECTRICITY_FACTOR + " kg/kWh green.",
        steps: [
          ["Find your tariff", "It's on your bill or in your supplier's app."],
          ["Look for 100% renewable", "Ask your supplier whether the tariff is backed by 100% renewable electricity."],
          ["Switch", "It takes minutes. Your new supplier handles the move, and the power never cuts out."],
          ["Then turn it down 1°C", "Saves about 8% of heating energy. You'll barely notice."],
        ],
      };
    }
    if (cat === "pets") {
      return {
        title: "Choose food made from by-products",
        lede: "Most of a pet's footprint is its food. Brands made from by-products that would otherwise be wasted have a far smaller footprint than premium cuts.",
        save: tip.saving, saveLabel: "Realistic saving for you",
        vsTitle: "A year of pet food, kg CO₂e", headline: "Dogs ≈ " + (D.DOG_YEARLY / D.CAT_YEARLY).toFixed(1) + "× cats", unit: "kg",
        rows: [["Dog", D.DOG_YEARLY, "🐕"], ["Cat", D.CAT_YEARLY, "🐈"]],
        source: "Typical yearly figures from CO2 Counter's data. Yours is shared across your household.",
        steps: [
          ["Check the label", "Look for \u201cby-products\u201d or \u201canimal derivatives\u201d rather than prime cuts."],
          ["Avoid beef-based recipes", "Chicken or fish recipes are lower."],
          ["Measure portions", "Follow your vet's guidance. Overfeeding wastes food and isn't good for them."],
          ["Ask your vet before big changes", "Especially for insect-based or plant-mixed foods."],
        ],
      };
    }
    if (cat === "flights") {
      const fl = (survey.flights || []).filter((f) => flightKm(f.from, f.to) > 0);
      const allLong = fl.length && fl.every((f) => flightKm(f.from, f.to) > A.SHORT_HAUL_KM);
      return {
        title: !fl.length ? "No flights to switch" : allLong ? "Fly a little less, and in economy" : "Take the train for trips under {{swap_km}} km",
        lede: !fl.length
          ? "You haven't added any flights, so there's nothing to switch. If you travel, the train is usually the low-carbon way to reach the UK and nearby Europe."
          : allLong
            ? "Your flights are too far for the train to be realistic. Flying a little less often, staying longer when you go, and choosing economy are what cut these."
            : "Once airport time is counted, the train is often as quick door to door for shorter trips, and it emits a fraction as much.",
        save: tip.saving, saveLabel: "Realistic saving for you", eqFlights: true,
        vsTitle: "London → Paris and back, per person", headline: Math.round((1 - trainToFlightRatio()) * 100) + "% less by train", unit: "kg",
        rows: [["Plane", A.PARIS_FLIGHT_KG, "✈️"], ["Train", A.PARIS_FLIGHT_KG * trainToFlightRatio(), "🚆"]],
        source: "Eurostar's independently commissioned figures, as used in CO2 Counter.",
        steps: [
          ["Check the train first", "For trips under about {{swap_km}} km, compare door-to-door times, not just the journey itself."],
          ["Book ahead", "Advance rail fares are usually the cheapest."],
          ["Make the journey part of the trip", "No security queues or liquids rules, and you can work, read or watch something the whole way."],
          ["If you do fly, fly economy and direct", "Economy spreads the plane's emissions over more people, and direct routes avoid extra take-offs."],
        ],
      };
    }
    if (cat === "commute") {
      const c = survey.commute || {};
      const d = c.distance || 0;
      const carKey = DAYS.map((x) => c[x]).find((m) => MOTOR_MODES.includes(m)) || "car_petrol";
      const car = byKey(D.COMMUTE_MODES, carKey);
      const day = (k) => byKey(D.COMMUTE_MODES, k).factor * d * 2;
      const n = carDaysOf(survey).length;
      return {
        title: n ? "Swap one car day a week" : "Keep your commute low-carbon",
        lede: n
          ? "You drive " + n + (n === 1 ? " day" : " days") + " a week. Swapping " + (n === 1 ? "it" : "one") + " for the train, the bike or working from home cuts that day's commute to almost nothing."
          : "You don't drive to work, which is already the biggest win. Here's how your options compare.",
        save: tip.saving, saveLabel: n ? "Realistic saving for you" : "Saving so far",
        vsTitle: "Your " + d + " km commute, one day there and back", headline: car && day(carKey) > 0 ? "Train: " + Math.round((1 - day("train") / day(carKey)) * 100) + "% less" : "", unit: "kg",
        rows: [[car.label + (n ? " (yours)" : ""), day(carKey), car.emoji], ["Bus", day("bus"), "🚌"], ["Train", day("train"), "🚆"], ["Walk or bike", 0, "🚲"]],
        source: "DESNZ 2026 factors used in CO2 Counter.",
        steps: [
          ["Pick one day", "Choose the day that's easiest to change, like one with fewer bags or appointments."],
          [d <= A.ACTIVE_TRAVEL_MAX_KM ? "Try the bike" : "Try the train or bus", d <= A.ACTIVE_TRAVEL_MAX_KM ? "At " + d + " km, cycling takes most people about " + Math.max(5, Math.round((d / 15) * 60)) + " minutes, with zero emissions." : "At " + d + " km, the train or bus is the realistic swap, and you can read or rest on the way."],
          ["Or work from home", "One work-from-home day removes that day's commute entirely."],
          ["Plan for an EV later", "When it's time to replace the car, an electric one emits {{ev_share}} as much per km on today's grid."],
        ],
      };
    }
    // water
    const w = survey.water || {};
    const hh = Math.max(1, (survey.energy || {}).household || 1);
    const ukW = D.UK_TYPICAL_SURVEY.water.liters / Math.max(1, D.UK_TYPICAL_SURVEY.energy.household || 1);
    const mine = (w.liters || 0) / hh;
    return {
      title: "Shorter showers",
      lede: "Water is a small part of your footprint, but the fixes are free, quick and lower your energy bill too.",
      save: tip.saving, saveLabel: "Realistic saving for you",
      vsTitle: "Water per person a month, litres", headline: mine < ukW ? "Already below typical" : Math.round((mine / ukW - 1) * 100) + "% above typical", unit: "L",
      rows: [["UK typical", ukW, "💧"], ["You", mine, "💧"]],
      source: "UK typical from CO2 Counter's UK average profile.",
      steps: [
        ["Aim for 4–5 minutes", "A song or two is about right. Heating the water is where most of the energy goes."],
        ["Fit a low-flow showerhead", "A one-off change that cuts hot water use every day."],
        ["Full loads only", "Run the dishwasher and washing machine only when they're full."],
      ],
    };
  }

  // The step-by-step guide, shown inside a category's pop-up for its biggest
  // step (the separate guide page used to repeat the same steps).
  function guideIndex(cat) {
    const ex = D.EXPLAINERS[cat] || {};
    const diet = cat === "meals" && survey ? D.DIET_EXPLAINERS[dietType(survey)] : null;
    const secs = (diet && diet.sections) || ex.sections || [];
    const want = { flights: "trainComparison", banking: "switchAccount" }[cat];
    if (want) return Math.max(0, secs.findIndex((x) => x.dynamicKey === want));
    // Otherwise the first step that's shown and applies to them.
    const i = secs.findIndex((x) => !(diet && sectionDone(cat, x)) && !sectionHidden(cat, x) && !sectionNA(cat, x));
    return Math.max(0, i);
  }
  function guideSheet(cat, withChart) {
    const fp = footprint(survey);
    const g = guideSpec(cat);
    const item = fp.breakdown.find((b) => b.key === cat) || { yearly: 0 };
    const shownSave = g.saveOverride != null ? g.saveOverride : g.save;
    const eqKg = g.eqFlights ? item.yearly : shownSave > 0.5 ? shownSave : item.yearly;
    const eq = equivalents(eqKg);
    const max = Math.max(1e-9, ...g.rows.map((r) => r[1]));
    const val = (v) => (v < 10 && v > 0 ? v.toFixed(2) : kgFmt(v));
    const colours = ["#B8653D", "#D9A441", "#A3B58F", "#6E8B5E", "#3F5B3A"];
    const rowColour = (i, n) => (n <= 2 ? (i === 0 ? colours[0] : colours[4]) : colours[Math.min(4, Math.round((i / (n - 1)) * 4))]);
    const budgetPct = (eqKg / D.BUDGET_YEARLY) * 100;
    const repeat = (n, ic, cap) => Array.from({ length: Math.min(n, cap) }, () => icon(ic)).join("") + (n > cap ? '<span class="xs muted">+' + (n - cap) + "</span>" : "");
    // The guide's own headline and intro, which know what you've already done.
    let html = '<div class="guide-lede"><h3 class="display">' + esc(g.title) + "</h3><p>" + esc(g.lede) + "</p></div>";
    if (withChart)
      html += panel(
        esc(g.vsTitle),
        '<ul class="vs-list">' +
          g.rows
            .map(
              (r, i) =>
                '<li><span class="vs-icon" style="color:' + rowColour(i, g.rows.length) + '">' + r[2] + '</span><span class="vs-label">' + esc(r[0]) + "</span>" +
                '<span class="vs-track"><span style="width:' + Math.max(r[1] > 0 ? 1.5 : 0.6, (r[1] / max) * 100).toFixed(1) + "%;background:" + rowColour(i, g.rows.length) + ";animation-delay:" + (i * 0.12).toFixed(2) + 's"></span></span>' +
                '<span class="vs-val"><b class="display tnum">' + val(r[1]) + "</b> " + g.unit + "</span></li>"
            )
            .join("") +
          '</ul><p class="xs muted mt-2">' + esc(g.source) + "</p>",
        g.headline ? chipBig(esc(g.headline)) : ""
      );
    if (eqKg > 0.5)
      html += panel(
        g.eqFlights ? "What your " + kgFmt(eqKg) + " kg of flying a year looks like" : "What −" + kgFmt(eqKg) + " kg a year looks like",
        '<div class="eq-grid">' +
          '<div class="eq"><div class="row-between"><span>Trees needed to soak it up</span><b class="display tnum">' + kgFmt(eq.trees) + '</b></div><div class="eq-icons green-dark">' + repeat(eq.trees, "tree", 18) + '</div><p class="xs muted">A mature tree absorbs about 20 kg of CO₂ a year.</p></div>' +
          '<div class="eq"><div class="row-between"><span>Share of the 1.5°C budget</span><b class="display tnum">' + (budgetPct < 1 ? budgetPct.toFixed(1) : Math.round(budgetPct)) + '%</b></div><div class="eq-bar"><span style="width:' + Math.min(100, budgetPct).toFixed(1) + '%"></span></div><p class="xs muted">Of one person\'s yearly {{budget_t}} t.</p></div>' +
          '<div class="eq"><div class="row-between"><span>The same as driving</span><b class="display tnum">' + kgFmt(eq.drivingKm) + ' km</b></div><p class="xs muted">In a petrol car. London to Edinburgh is about 650 km.</p></div>' +
          '<div class="eq"><div class="row-between"><span>New phones</span><b class="display tnum">' + kgFmt(eq.phones) + '</b></div><div class="eq-icons">' + repeat(eq.phones, "phone", 8) + '</div><p class="xs muted">Making and charging one phone for a year: about 61 kg.</p></div>' +
          "</div>"
      );
    html += panel(
      "How to do it",
      '<ol class="howto">' + g.steps.map((st, i) => '<li><span class="num-badge display">' + (i + 1) + '</span><div><h3 class="display">' + esc(st[0]) + "</h3><p>" + esc(st[1]) + "</p></div></li>").join("") + "</ol>",
      shownSave >= 0.5 ? chipBig("−" + kgFmt(shownSave) + " kg a year") : chipBig("Already doing this")
    );
    const step = Math.max(0, STEPS.findIndex((x) => x.key === (cat === "water" ? "energy" : cat)));
    html +=
      '<div class="guide-done"><span class="sm">Done it? Update your answers and your results and My Habits catch up.</span>' +
      '<button type="button" class="btn btn-green btn-sm" data-action="update-step" data-step="' + step + '">Update my answers</button>' +
      '<a class="btn btn-outline btn-sm" href="#/habits" data-action="close-and-go">My Habits</a></div>';
    return '<div class="guide-in-sheet">' + html + "</div>";
  }

  // ---------- banking league tables ----------

  const bankRating = (bank) => D.BANK_RATING_BANDS.find((b) => bank.factor <= b.max);
  const rateChip = (key, label) => '<span class="rate rate-' + key + '">' + esc(label) + "</span>";
  const kgFmt = (n) => Math.round(n).toLocaleString();

  function pensionRating(score) {
    if (score >= 7.5) return { key: "vgood", label: "Good" };
    if (score >= 5) return { key: "good", label: "Adequate" };
    if (score >= 2.5) return { key: "bad", label: "Inadequate" };
    return { key: "vbad", label: "Poor" };
  }

  // Whether the survey shows someone is already doing what a guide card
  // suggests.
  function sectionDone(cat, s) {
    const flights = (survey.flights || []).filter((f) => flightKm(f.from, f.to) > 0);
    if (cat === "flights") {
      if (s.dynamicKey === "flightTiers") return flights.length === 0;
      if (s.dynamicKey === "trainComparison") return !flights.some((f) => flightKm(f.from, f.to) <= A.TRAIN_SWAP_MAX_KM);
      if (s.dynamicKey === "cabinComparison") return flights.every((f) => (f.cabin || "economy") === "economy");
      return false;
    }
    if (cat === "meals") return /food waste/i.test(s.heading) && (survey.meals || {}).foodWaste === "low";
    if (cat === "banking") {
      const b = survey.banking || {};
      if (s.dynamicKey === "switchAccount" || s.dynamicKey === "bankLeague") return GREEN_BANKS.includes(b.bank);
      if (s.dynamicKey === "savingsPensions") {
        const p = D.PENSION_CLIMATE_RANKING.find((x) => x.key && x.key === b.pensionProvider);
        return !!(b.pensionPot && p && pensionRating(p.score).key === "vgood");
      }
    }
    return false;
  }

  // The banks in the switching card, and when a guide card doesn't apply.
  const GREEN_BANKS = ["triodos", "co_op", "nationwide"];
  const sectionNA = (cat, s) => {
    // No pension pot, or the unfunded NHS scheme: nothing to switch.
    if (cat === "banking" && s.dynamicKey === "savingsPensions") {
      const b = survey.banking || {};
      return !b.pensionPot || !!(byKey(D.PENSION_PROVIDERS, b.pensionProvider) || {}).unfunded;
    }
    // Driving cards, for people who don't drive to work.
    if (cat === "commute" && (s.dynamicKey === "commuteSwap" || s.dynamicKey === "ifDriving")) return carDaysOf(survey).length === 0;
    // No pets, so none of the pet steps apply.
    if (cat === "pets") return !((survey.pets || {}).dogs > 0 || (survey.pets || {}).cats > 0);
    // No gas, so no boiler to replace.
    if (cat === "energy" && /electrify heating/i.test(s.heading)) return !((survey.energy || {}).gasKwh > 0);
    return false;
  };

  const carDaysOf = (s) => DAYS.filter((d) => MOTOR_MODES.includes((s.commute || {})[d]));
  // Cards that don't apply are shown greyed out (sectionNA) rather than hidden.
  function sectionHidden() {
    return false;
  }



  // One line on the card itself, so the comparison is visible before tapping.
  function sectionTeaser(s) {
    const b = survey.banking || {};
    if (s.dynamicKey === "bankLeague") {
      const bank = byKey(D.BANKS, b.bank);
      if (!bank) return '<p class="xs green-dark fw-600 mt-3">Pick your bank in the survey to see its rating.</p>';
      const rt = bankRating(bank);
      return '<p class="sm mt-3 label-row" style="flex-wrap:wrap">Your bank, ' + esc(bank.label) + ": " + rateChip(rt.key, rt.label) + '<span class="xs green-dark fw-600">Tap to compare</span></p>';
    }
    if (s.dynamicKey === "commuteSwap") {
      const n = carDaysOf(survey).length;
      return n ? '<p class="xs green-dark fw-600 mt-3">You drive ' + n + (n === 1 ? " day" : " days") + " a week. Tap to compare your options.</p>" : "";
    }
    if (s.dynamicKey === "savingsPensions") {
      const p = D.PENSION_CLIMATE_RANKING.find((x) => x.key && x.key === b.pensionProvider);
      if (!p) return "";
      const rt = pensionRating(p.score);
      return '<p class="sm mt-3 label-row" style="flex-wrap:wrap">' + esc(p.label) + ": " + p.rank + " of 12, " + rateChip(rt.key, rt.label) + "</p>";
    }
    return "";
  }




  // Which partner links suit someone's finished survey: no bank that isn't
  // greener than theirs, and commute options only where they're feasible.
  // Eurostar runs from the UK to these countries.
  const EUROSTAR_COUNTRIES = ["France", "Belgium", "Netherlands"];
  function linkFits(cat, l, s) {
    // Food links (recipes, local seasonal veg boxes, less waste) suit
    // everyone, vegans included, so they're never filtered.
    if (!s || !s.completedAt) return true;
    if (cat === "flights" && l.when) {
      const fl = (s.flights || []).filter((f) => flightKm(f.from, f.to) > 0);
      const country = (code) => (airport(code) || {}).country;
      if (l.when === "eurostar")
        return fl.some((f) => [country(f.from), country(f.to)].includes("UK") && [country(f.from), country(f.to)].some((c) => EUROSTAR_COUNTRIES.includes(c)));
      if (l.when === "rail") return fl.some((f) => flightKm(f.from, f.to) <= A.TRAIN_SWAP_MAX_KM);
      if (l.when === "rail_far") return fl.some((f) => flightKm(f.from, f.to) <= A.SHORT_HAUL_KM);
    }
    if (cat === "banking" && l.bank) {
      const own = byKey(D.BANKS, (s.banking || {}).bank);
      const b = byKey(D.BANKS, l.bank);
      return !own || !b || b.factor < own.factor;
    }
    if (cat === "commute" && l.when) {
      const c = s.commute || {};
      const days = DAYS.map((d) => c[d]).filter((m) => m && m !== "wfh");
      const commutes = (c.distance || 0) > 0 && days.length > 0;
      const drivesFuel = days.some((m) => m === "car_petrol" || m === "car_diesel");
      if (l.when === "train") return (commutes && days.some((m) => MOTOR_MODES.includes(m) || m === "bus")) || (s.longTrips || []).some((x) => CAR_MODES.includes(x.mode));
      if (l.when === "cycle") return commutes && c.distance <= A.ACTIVE_TRAVEL_MAX_KM && days.some((m) => m !== "walk_bike");
      if (l.when === "ev") return (commutes && drivesFuel) || ownedCars(s).some((x) => x.fuel !== "ev");
    }
    return true;
  }
  const linksFor = (cat, s) => {
    const who = s || survey;
    const links = D.USEFUL_LINKS[cat];
    if (!links) return null;
    const items = links.items.filter((l) => linkFits(cat, l, who));
    return items.length ? { ...links, items } : null;
  };
  const linkHref = (l) => esc(l.ref || l.url);
  const linkKey = (cat, l) => cat + ":" + l.label.toLowerCase().replace(/^the /, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const linkAttrs = (cat, l, place) =>
    'href="' + linkHref(l) + '" target="_blank" rel="noopener' + (l.ref ? " sponsored" : "") + '" data-link="' + linkKey(cat, l) + '" data-place="' + place + '"' + (l.ref ? ' data-aff="1"' : "");

  // Counts one click per person per link (the database ignores repeats), so
  // the same browser only asks once.
  function recordLinkClick(el) {
    if (!sb || !currentUser) return;
    const key = el.dataset.link;
    const aff = el.dataset.aff === "1";
    // Once per person per link, and once more if they later use the affiliate version.
    const seenAs = key + (aff ? "#aff" : "");
    const seenKey = "co2_link_clicks_" + currentUser.id;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(seenKey) || "[]"); } catch (e) {}
    if (seen.includes(seenAs)) return;
    sb.rpc("record_link_click", aff ? { p_link: key, p_place: el.dataset.place || null, p_affiliate: true } : { p_link: key, p_place: el.dataset.place || null }).then(({ error }) => {
      if (error) return;
      try { localStorage.setItem(seenKey, JSON.stringify(seen.concat(seenAs))); } catch (e) {}
    }, () => {});
  }
  const monogram = (l) =>
    '<span class="mono mono-' + (l.tone || "leaf") + '">' + esc(l.label.replace(/^The /, "").replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("")) + "</span>";

  function usefulLinksCard(cat) {
    const links = linksFor(cat);
    if (!links) return "";
    const tip = tipFor(cat, survey);
    const kg = tip.saving > 0.5 ? tip.saving : tip.maxSaving;
    return offerCard(cat, links, "guide", kg > 0.5 ? "Could cut about <strong>" + Math.round(kg).toLocaleString() + " kg CO₂e a year</strong>." : "");
  }

  // One area's partner tiles, with the disclosure line under them.
  function offerCard(cat, links, place, sub) {
    const paid = links.items.some((l) => l.ref);
    return (
      '<div class="card offer-card mb-6 fade-up" id="switch-' + cat + '"><div class="offer-head"><span class="eyebrow">' + esc(links.eyebrow || "Useful links") + "</span>" +
      '<h2 class="offer-title">' + esc(links.title) + "</h2>" +
      (sub ? '<p class="sm offer-sub">' + sub + "</p>" : "") +
      '</div><div class="offer-grid">' +
      links.items
        .map(
          (l) =>
            '<a class="offer" ' + linkAttrs(cat, l, place) + ">" +
            '<div class="label-row">' + monogram(l) + '<span class="fw-600">' + esc(l.label) + "</span>" +
            (l.ref ? '<span class="tag affiliate-tag ml-auto">Affiliate</span>' : "") + "</div>" +
            '<div class="offer-tags">' + (l.tags || []).map((t) => '<span class="offer-tag">' + esc(t) + "</span>").join("") + "</div>" +
            '<p class="sm muted lh">' + esc(l.note) + "</p>" +
            '<span class="offer-cta">Visit ' + esc(l.label.replace(/^The /, "")) + " " + icon("link") + "</span></a>"
        )
        .join("") +
      '</div><p class="xs muted mt-4">' +
      (paid
        ? "Some of these are referral links: if you switch, CO2 Counter may get a reward at no cost to you. We only list options we'd recommend anyway."
        : "Independent suggestions. We don't get paid for these links.") +
      "</p></div>"
    );
  }

  // Compact logo chips for the same links, used in pop-ups. Results keeps
  // no links on purpose: they're saved for the guide pages.
  function linkChips(cat, max, place) {
    const links = linksFor(cat);
    if (!links) return "";
    return (
      '<div class="chip-links">' +
      links.items
        .slice(0, max || links.items.length)
        .map((l) => '<a class="chip-link" ' + linkAttrs(cat, l, place || "popup") + ">" + monogram(l) + esc(l.label) + (l.ref ? '<span class="affiliate-dot">Affiliate</span>' : "") + "</a>")
        .join("") +
      "</div>"
    );
  }

  function habitsComingSoonCard() {
    return (
      '<div class="card callout strong"><div class="label-row mb-4"><span class="round-badge sm">' + icon("leaf") + '</span><span class="eyebrow">Build these habits</span>' +
      '<span class="tag amber ml-auto">Coming Soon</span></div><div class="coming-soon"><div class="soon-icon">' + icon("leaf") + "</div>" +
      '<h2 class="soon-title">Habit tracking is on the way</h2><p class="sm muted max-sm">We\'re putting the finishing touches on the habit commitment and streak-tracking feature. Check back soon to build greener habits, one step at a time.</p></div></div>' +
      ""
    );
  }

  // Habit tracking isn't built yet: the Habits tab shows the same
  // "coming soon" card as the guides, for everyone.
  function renderHabitsPending() {
    return (
      '<div class="container narrow">' + pageHeader("My Habits", "Coming soon") + habitsComingSoonCard() +
      '<div class="center mt-8"><a class="btn btn-outline" href="#/results">' + icon("arrowLeft") + " Back to results</a></div></div>"
    );
  }

  // Habits has two parts: one-off changes, set out as Real Zero's 7 Acts
  // (realzero.earth/7-acts), and daily habits (coming soon). Acts 1-5 tick
  // themselves from the latest survey; 6 and 7 are ticked by hand.
  // Hand ticks (acts 6 and 7) live in the account (profiles.acts), with a
  // copy on the device; ticks made before saving to the account was
  // possible get merged in the first time the page loads.
  const actsKey = () => "co2_acts_" + ((currentUser && currentUser.id) || "guest");
  const localActs = () => {
    try { return JSON.parse(localStorage.getItem(actsKey()) || "{}"); } catch (e) { return {}; }
  };
  function actsTicked() {
    const uid = currentUser && currentUser.id;
    if (uid && sb && ui.actsFor !== uid) loadActs(uid);
    return ui.actsFor === uid && ui.acts ? ui.acts : localActs();
  }
  async function claimReferral() {
    let code = null;
    try { code = localStorage.getItem("co2_ref"); } catch (e) {}
    if (!code || !currentUser || !sb) return;
    try {
      const { error } = await sb.rpc("claim_referral", { p_code: code });
      if (!error) localStorage.removeItem("co2_ref");
    } catch (e) {}
  }
  async function loadActs(uid) {
    ui.actsFor = uid;
    ui.acts = null;
    ui.actsInfo = null;
    try {
      // Invite code, invitees, and verified acts (null until the SQL is run).
      const { data, error } = await sb.rpc("my_acts");
      if (!error && data && data.code) {
        ui.actsInfo = data;
        // Private link for the bill payer to confirm an energy switch (act 2).
        if (asksBillPayer(survey)) {
          const t = await sb.rpc("my_energy_token");
          if (!t.error && t.data) ui.energyToken = t.data;
        }
      }
    } catch (e) {}
    try {
      const { data, error } = await sb.from("profiles").select("acts").eq("id", uid).maybeSingle();
      if (error) return; // column not added yet: the device copy is used
      const server = (data && data.acts) || {};
      const local = localActs();
      const merged = { ...server };
      Object.keys(local).forEach((k) => { if (local[k]) merged[k] = true; });
      ui.acts = merged;
      try { localStorage.setItem(actsKey(), JSON.stringify(merged)); } catch (e) {}
      if (JSON.stringify(merged) !== JSON.stringify(server)) await sb.from("profiles").update({ acts: merged }).eq("id", uid);
    } catch (e) {}
    if (["/habits", "/switches", "/friends", "/account"].includes(currentPath()) || currentPath().startsWith("/acts/")) render();
  }
  const inviteLink = () => PRODUCTION_URL + (ui.actsInfo && ui.actsInfo.code ? "?ref=" + ui.actsInfo.code : "");
  const MP_COPY = "mp@co2counter.co.uk";
  // A ready-to-edit letter. The reference lets us match the BCC copy to the
  // account; MPs need a name and full address to reply to a constituent.
  // Webmail drafts, for people who use Gmail or Outlook in the browser.
  // Outlook's web link can't add a BCC, so MP letters there need it adding.
  const gmailLink = (m) =>
    "https://mail.google.com/mail/?view=cm&fs=1" + (m.to ? "&to=" + encodeURIComponent(m.to) : "") + (m.bcc ? "&bcc=" + encodeURIComponent(m.bcc) : "") +
    "&su=" + encodeURIComponent(m.subject) + "&body=" + encodeURIComponent(m.body);
  // Outlook: personal accounts (Outlook.com, Hotmail) use outlook.live.com;
  // work and school accounts use outlook.office.com. On phones the Outlook
  // app opens straight to the draft. Each keeps the To, subject and letter.
  const mailQuery = (m, keys) => keys.filter(([k]) => m[k]).map(([k, name]) => name + "=" + encodeURIComponent(m[k])).join("&");
  const outlookLink = (m) => "https://outlook.live.com/mail/0/deeplink/compose?" + mailQuery(m, [["to", "to"], ["subject", "subject"], ["body", "body"]]);
  const outlookWorkLink = (m) => "https://outlook.office.com/mail/deeplink/compose?" + mailQuery(m, [["to", "to"], ["subject", "subject"], ["body", "body"]]);
  const outlookAppLink = (m) => "ms-outlook://compose?" + mailQuery(m, [["to", "to"], ["bcc", "bcc"], ["subject", "subject"], ["body", "body"]]);
  const onPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const webmailButtons = (m, action) => {
    const go = (href, label, kind, blank) => '<a class="mail-chip" href="' + esc(href) + '"' + (blank ? ' target="_blank" rel="noopener"' : "") + ' data-action="' + action + '" data-mail="' + kind + '">' + label + "</a>";
    return (
      '<span class="mail-alt"><span class="mail-alt-k">Or open in</span>' +
      go(gmailLink(m), "Gmail", "gmail", true) +
      (onPhone() ? go(outlookAppLink(m), "Outlook app", "outlook-app", false) : "") +
      go(outlookLink(m), onPhone() ? "Outlook.com" : "Outlook", "outlook", true) +
      go(outlookWorkLink(m), "Work Outlook", "outlook-work", true) + "</span>"
    );
  };
  function mpLetterParts(mp) {
    return { to: mp.email, bcc: MP_COPY, subject: "Climate action: a letter from a constituent", body: decodeURIComponent(mpLetter(mp).split("&body=")[1] || "") };
  }
  function mpLetter(mp) {
    const ref = "CO2-" + ui.actsInfo.code;
    const body =
      "Dear " + mp.name + ",\n\n" +
      "I'm writing as your constituent to ask you to support stronger action on climate change.\n\n" +
      "[Say what matters most to you, for example home insulation, cheaper public transport, renewable energy, or protecting nature.]\n\n" +
      "I've measured my own carbon footprint and I'm cutting it where I can. I'd like to know what you will do in Parliament to help the UK reach net zero, and how you'll vote on climate policy.\n\n" +
      "Yours sincerely,\n\n[Your name]\n[Your full address and postcode]\n\nRef: " + ref;
    return "mailto:" + mp.email + "?bcc=" + encodeURIComponent(MP_COPY) + "&subject=" + encodeURIComponent("Climate action: a letter from a constituent") + "&body=" + encodeURIComponent(body);
  }
  // Parliament's public members API: postcode -> constituency -> MP -> email.
  async function findMp(postcode) {
    ui.mp = { loading: true };
    render();
    try {
      const api = "https://members-api.parliament.uk/api/";
      const found = await (await fetch(api + "Location/Constituency/Search?take=1&searchText=" + encodeURIComponent(postcode))).json();
      const c = found.items && found.items[0] && found.items[0].value;
      const m = c && c.currentRepresentation && c.currentRepresentation.member && c.currentRepresentation.member.value;
      if (!m) throw new Error("none");
      const contact = await (await fetch(api + "Members/" + m.id + "/Contact")).json();
      const emails = (contact.value || []).filter((x) => x.email);
      const email = (emails.find((x) => /parliament/i.test(x.type || "")) || emails[0] || {}).email;
      ui.mp = { name: m.nameDisplayAs, constituency: c.name, email: email || "", id: m.id };
    } catch (e) {
      ui.mp = { error: "We couldn't find an MP for that postcode. Check it and try again." };
    }
    render();
  }
  // Your footprint now, and after the big switches in Real Zero's 7 Acts
  // (Acts 1 to 4, the ones with a figure), for sharing.
  function actsBeforeAfter() {
    if (!survey || !survey.completedAt) return null;
    const now = footprint(survey).totalYearly;
    // The same areas as Acts 1 to 4 on the Habits page (worked out directly,
    // as the Habits page uses this share text itself).
    const keys = asksBillPayer(survey) ? ["banking", "meals", "commute", "flights"] : ["banking", "energy", "meals", "commute", "flights"];
    const cut = switchAreas({ s: survey, mine: true }).filter((a) => keys.includes(a.key) && !a.done).reduce((t, a) => t + (a.save || 0), 0);
    return { now, after: Math.max(0, now - cut), cut };
  }
  const lettuces = (kg) => funNum(kg / D.FUN_COMPARISONS.items[0].size);
  function shareText() {
    const fp = survey && survey.completedAt ? footprint(survey) : null;
    const ba = actsBeforeAfter();
    if (ba && ba.cut >= 50)
      return "My carbon footprint is " + (ba.now / 1000).toFixed(1) + " t CO₂e a year. Real Zero's 7 Acts would take it to " + (ba.after / 1000).toFixed(1) + " t: that's " +
        lettuces(ba.cut) + " Liz Truss lettuces 🥬 less CO₂ a year. Find yours, free, with CO2 Counter" + (ui.actsInfo && ui.actsInfo.code ? " (my invite code: " + ui.actsInfo.code + ")" : "") + ":";
    return (fp ? "I worked out my carbon footprint: " + (fp.totalYearly / 1000).toFixed(1) + " t CO₂e a year. " : "I'm working out my carbon footprint. ") +
      "Find yours, free, with CO2 Counter" + (ui.actsInfo && ui.actsInfo.code ? " (my invite code: " + ui.actsInfo.code + ")" : "") + ":";
  }
  // ---------- before and after picture card ----------
  // Drawn on the phone (nothing is uploaded), then shared as an image with
  // the share text, or shown to press and hold to save.
  function roundRect(x, X, Y, w, h, r) {
    x.beginPath();
    x.moveTo(X + r, Y);
    x.arcTo(X + w, Y, X + w, Y + h, r);
    x.arcTo(X + w, Y + h, X, Y + h, r);
    x.arcTo(X, Y + h, X, Y, r);
    x.arcTo(X, Y, X + w, Y, r);
    x.closePath();
  }
  function wrapText(x, text, X, Y, maxW, lineH) {
    const words = text.split(" ");
    let line = "", y = Y;
    words.forEach((w) => {
      const test = line ? line + " " + w : w;
      if (x.measureText(test).width > maxW && line) {
        x.fillText(line, X, y);
        line = w;
        y += lineH;
      } else line = test;
    });
    if (line) x.fillText(line, X, y);
    return y + lineH;
  }
  // Square post (1080 x 1350) or story (1080 x 1920), light or dark.
  const SHARE_THEMES = {
    light: { bg: "#EFE9DC", card: "rgba(255,252,245,.82)", ink: "#2E2A22", muted: "#5E574B", green: "#3F5B3A", clay: "#9A5130", foot: "#3F5B3A", footInk: "#F6F1E6", glowA: "rgba(183,196,164,.85)", glowB: "rgba(232,200,138,.6)" },
    dark: { bg: "#16211A", card: "rgba(246,241,230,.94)", ink: "#F6F1E6", muted: "#C9D3BC", green: "#A9C795", clay: "#F2B48E", foot: "#E8C88A", footInk: "#16211A", glowA: "rgba(63,91,58,.75)", glowB: "rgba(184,101,61,.35)" },
  };
  const svgImage = (svg) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  async function drawShareCard(ba, fmt, theme, plain) {
    const story = fmt === "story";
    const T = SHARE_THEMES[theme] || SHARE_THEMES.light;
    const W = 1080, H = story ? 1920 : 1350, PAD = 80, top = story ? 110 : 64, gap = story ? 56 : 30;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d");
    try { await document.fonts.load("800 80px 'Bricolage Grotesque'"); await document.fonts.load("700 40px Karla"); } catch (e) {}
    const DISP = "'Bricolage Grotesque', system-ui, sans-serif", BODY = "Karla, system-ui, sans-serif";
    x.fillStyle = T.bg;
    x.fillRect(0, 0, W, H);
    const glow = (cx, cy, r, col) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, col); g.addColorStop(1, col.replace(/[\d.]+\)$/, "0)")); x.fillStyle = g; x.fillRect(0, 0, W, H); };
    glow(W * 0.08, H * 0.06, 620, T.glowA);
    glow(W * 0.96, H, 680, T.glowB);
    // brand
    x.fillStyle = "#3F5B3A";
    roundRect(x, PAD, top, 64, 64, 16);
    x.fill();
    x.save();
    x.translate(PAD + 14, top + 14);
    x.scale(1.5, 1.5);
    x.strokeStyle = "#F6F1E6";
    x.lineWidth = 1.8;
    x.lineCap = x.lineJoin = "round";
    x.stroke(new Path2D("M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10ZM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"));
    x.restore();
    x.fillStyle = T.ink;
    x.font = "800 40px " + DISP;
    x.fillText("CO2 Counter", PAD + 84, top + 46);
    // now -> after
    let y = top + 64 + gap + 34;
    x.fillStyle = T.muted;
    x.font = "700 34px " + BODY;
    x.fillText("My carbon footprint", PAD, y);
    const big = story ? 190 : 128;
    const yN = y + 14 + big * 0.82;
    const t = (kg) => (kg / 1000).toFixed(1);
    const num = (s, X, col, right) => {
      x.font = "800 " + big + "px " + DISP;
      const w1 = x.measureText(s).width;
      x.font = "800 52px " + DISP;
      const w2 = x.measureText(" t").width;
      const X0 = right ? X - w1 - w2 : X;
      x.fillStyle = col;
      x.font = "800 " + big + "px " + DISP;
      x.fillText(s, X0, yN);
      x.font = "800 52px " + DISP;
      x.fillText(" t", X0 + w1, yN);
    };
    num(t(ba.now), PAD, T.clay);
    num(t(ba.after), W - PAD, T.green, true);
    x.fillStyle = T.green;
    x.font = "800 72px " + DISP;
    x.fillText("→", W / 2 - 36, yN - big * 0.28);
    x.font = "700 28px " + BODY;
    x.fillStyle = T.muted;
    x.fillText("a year now", PAD, yN + 42);
    x.fillStyle = T.green;
    const lab = "with the 7 Acts";
    x.fillText(lab, W - PAD - x.measureText(lab).width, yN + 42);
    // footer
    const code = ui.actsInfo && ui.actsInfo.code;
    const footH = story ? 172 : 140, footY = H - top - footH;
    x.fillStyle = T.foot;
    roundRect(x, PAD, footY, W - PAD * 2, footH, 32);
    x.fill();
    x.fillStyle = T.footInk;
    x.font = "800 " + (story ? 50 : 42) + "px " + DISP;
    x.fillText("Find yours, free", PAD + 44, footY + footH / 2 - 4);
    x.font = "600 30px " + BODY;
    x.fillText("co2counter.co.uk", PAD + 44, footY + footH / 2 + 40);
    if (code) {
      x.font = "700 24px " + BODY;
      x.fillText("Invite code", W - PAD - 44 - x.measureText("Invite code").width, footY + footH / 2 - 8);
      x.font = "800 30px " + BODY;
      x.fillText(code, W - PAD - 44 - x.measureText(code).width, footY + footH / 2 + 28);
    }
    // the picture
    const cardY = yN + 42 + gap + 10, cardB = footY - gap, cp = story ? 40 : 28;
    x.fillStyle = T.card;
    roundRect(x, PAD, cardY, W - PAD * 2, cardB - cardY, 36);
    x.fill();
    const it = piItems()[piIndex()];
    const iconS = story ? 110 : 84;
    const vw = W - PAD * 2 - cp * 2, vy = cardY + cp + iconS + 20, vh = cardB - cp - 50 - vy;
    const m = piModel(it, ba.now, ba.after, { w: vw, h: vh, big: true, minPitch: 10, minCell: 64, maxCell: 220, maxPitch: 60, uid: "c" });
    x.fillStyle = "#5E574B";
    x.font = "700 26px " + BODY;
    x.fillText(m.title, PAD + cp + iconS + 20, cardY + cp + iconS / 2 - 14);
    x.fillStyle = "#2E2A22";
    x.font = "800 " + (story ? 64 : 50) + "px " + DISP;
    x.fillText(m.headline, PAD + cp + iconS + 20, cardY + cp + iconS / 2 + (story ? 48 : 38));
    if (!plain) {
      const icon = await svgImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="' + iconS + '" height="' + iconS + '"><defs>' + PI_DEFS + "</defs>" + piArt(it.key, true, true) + "</svg>");
      x.drawImage(icon, PAD + cp, cardY + cp, iconS, iconS);
      const pic = await svgImage(piSvg(m, true));
      const ph = pic.height || vh;
      x.drawImage(pic, PAD + cp, vy + Math.max(0, (vh - ph) / 2), vw, ph);
    } else {
      x.fillStyle = "#5E574B";
      x.font = "600 30px " + BODY;
      wrapText(x, m.caption, PAD + cp, vy + 40, vw, 40);
    }
    // key
    if (m.legend) {
      x.font = "700 22px " + BODY;
      const parts = m.legend.map((l) => ({ l, w: (l[0] ? 26 : 0) + x.measureText(l[2]).width }));
      let lx = (W - parts.reduce((s, p) => s + p.w, 0) - 24 * (parts.length - 1)) / 2;
      const ly = cardB - cp - 12;
      parts.forEach(({ l, w }) => {
        if (l[0] === "dot") { x.fillStyle = l[1]; x.beginPath(); x.arc(lx + 8, ly - 8, 8, 0, Math.PI * 2); x.fill(); }
        else if (l[0] === "sq") { x.fillStyle = l[1]; roundRect(x, lx, ly - 16, 16, 16, 3); x.fill(); }
        else if (l[0] === "dash") { x.strokeStyle = l[1]; x.setLineDash([4, 3]); x.lineWidth = 2; roundRect(x, lx, ly - 16, 16, 16, 3); x.stroke(); x.setLineDash([]); }
        x.fillStyle = l[0] ? (l[1] === "#C9774F" || l[0] === "dash" ? "#9A5130" : "#2E2A22") : "#5E574B";
        x.fillText(l[2], lx + (l[0] ? 26 : 0), ly);
        lx += w + 24;
      });
    }
    return c;
  }
  async function openShareCard() {
    const ba = actsBeforeAfter();
    if (!ba) return;
    const fmt = ui.shareFmt || "post", theme = ui.shareTheme || "light";
    let canvas = await drawShareCard(ba, fmt, theme);
    let url;
    try {
      url = canvas.toDataURL("image/png");
    } catch (e) {
      // Some browsers won't export a canvas with SVG drawn on it.
      canvas = await drawShareCard(ba, fmt, theme, true);
      url = canvas.toDataURL("image/png");
    }
    // Just the picture and the invite link: a sentence as well arrives as
    // a third message in most chat apps.
    const link = inviteLink();
    const file = await new Promise((res) => canvas.toBlob((b) => res(b ? new File([b], "co2counter-before-after.png", { type: "image/png" }) : null), "image/png"));
    // Shown first; its Share button opens the phone's share sheet straight
    // from a tap (Safari only allows sharing right after one).
    ui.shareCard = { file, link };
    const canShareFile = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    const idx = piIndex();
    const seg = (action, val, opts) =>
      '<div class="seg" role="group">' + opts.map(([v, label]) => '<button type="button" data-action="' + action + '" data-v="' + v + '" aria-pressed="' + (v === val) + '"' + (v === val ? ' class="on"' : "") + ">" + label + "</button>").join("") + "</div>";
    modalRoot.innerHTML =
      '<div class="modal-backdrop sheet-backdrop" data-action="close-modal"><div class="sheet share-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-body">' +
      '<div class="sheet-head"><div class="min0"><h2 id="sheet-title" class="display">Your before and after</h2><p class="sheet-habit">Share it, or press and hold the picture to save it</p></div>' +
      '<button type="button" class="sheet-close modal-close" data-action="close-modal" aria-label="Close">' + icon("x") + "</button></div>" + piDefsSvg() +
      '<div class="pi-chips sm-chips" role="tablist" aria-label="Compare with">' +
      piItems().map((it, k) => '<button type="button" role="tab" class="pi-chip' + (k === idx ? " on" : "") + '" aria-selected="' + (k === idx) + '" data-action="share-pick" data-i="' + k + '"><span class="pi-chip-ic">' + piIcon(it.key, 26) + "</span>" + esc(it.short) + "</button>").join("") + "</div>" +
      '<div class="chip-row share-opts">' + seg("share-fmt", fmt, [["post", "Post"], ["story", "Story"]]) + seg("share-theme", theme, [["light", "Light"], ["dark", "Dark"]]) + "</div>" +
      '<img class="share-card-img' + (fmt === "story" ? " story" : "") + '" src="' + url + '" alt="My carbon footprint: ' + (ba.now / 1000).toFixed(1) + " t now, " + (ba.after / 1000).toFixed(1) + " t with the 7 Acts, pictured in " + esc(piItems()[idx].many) + '" />' +
      '<div class="chip-row mt-3">' + (canShareFile ? '<button type="button" class="btn btn-green btn-sm" data-action="share-card-send">' + icon("image") + " Share picture</button>" : "") +
      (navigator.share ? '<button type="button" class="btn btn-outline btn-sm" data-action="share-link-send">' + icon("link") + " Share link</button>" : "") +
      '<a class="btn ' + (canShareFile ? "btn-outline" : "btn-green") + ' btn-sm" href="' + url + '" download="co2counter-before-after.png">' + icon("download") + " Download</a>" +
      '<button type="button" class="btn btn-outline btn-sm" data-action="share-copy-text">' + icon("copy") + " Copy link</button></div>" +
      '<p class="xs muted mt-2">Your link, ' + esc(link.replace(/^https:\/\//, "")) + ", shows a preview card when you send it.</p></div></div></div>";
    document.body.classList.add("modal-open");
    const on = modalRoot.querySelector(".pi-chip.on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // The invite code on its own, and the link, each with a copy button.
  function inviteCodeHtml() {
    const code = ui.actsInfo && ui.actsInfo.code;
    if (!code) return "";
    return (
      '<div class="invite-code"><div class="min0"><span class="eyebrow">Your invite code</span><b class="display tnum">' + esc(code) + "</b></div>" +
      '<button type="button" class="btn btn-green btn-sm" data-action="copy-code">' + icon("copy") + "Copy code</button></div>" +
      '<div class="act-link"><span class="sm">' + esc(inviteLink().replace(/^https:\/\//, "")) + '</span><button type="button" class="btn btn-outline btn-sm" data-action="copy-invite">' + icon("copy") + "Copy link</button></div>" +
      '<p class="xs muted">Friends open the link, or type the code after signing up.</p>'
    );
  }
  const longDate = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  // Postcode -> MP, then the email button with the letter (Habits box and
  // the act 6 page share this).
  // Sending from the app: the Edge Function (supabase/functions/send-letter)
  // sends through Resend, with the person's copy and replies to them.
  async function sendLetter(body) {
    try {
      const { data } = await sb.auth.getSession();
      const token = data && data.session && data.session.access_token;
      if (!token) return { error: "Please sign in again." };
      const res = await fetch(SUPABASE_URL + "/functions/v1/send-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
      if (res.status === 404) return { error: "Sending from the app isn't switched on yet. Use your own email app instead." };
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.ok) return out;
      // Admins also see why, to fix the setup.
      const why = ui.isAdmin && out.detail ? " (" + out.detail + ")" : ui.isAdmin && !res.ok ? " (status " + res.status + ")" : "";
      return { error: (out.error || "Couldn't send just now. Please try again, or use your own email app.") + why };
    } catch (e) {
      // Usually the function isn't deployed yet (the browser can't reach it).
      return { error: "Couldn't send just now. Please try again, or use your own email app." + (ui.isAdmin ? " (Couldn't reach the send-letter function: check it's deployed in Supabase under Edge Functions.)" : "") };
    }
  }
  // The letter without the sign-off placeholders: name and address are
  // added by the server from the boxes below it.
  const mpLetterBody = (mp) =>
    "Dear " + mp.name + ",\n\nI'm writing as your constituent to ask you to support stronger action on climate change.\n\n" +
    "[Say what matters most to you, for example home insulation, cheaper public transport, renewable energy, or protecting nature.]\n\n" +
    "I've measured my own carbon footprint and I'm cutting it where I can. I'd like to know what you will do in Parliament to help the UK reach net zero, and how you'll vote on climate policy.\n\nYours sincerely,";
  function mpSendForm(mp) {
    const st = ui.letterState || {};
    if (st.mpSentTo) return '<p class="sm green-dark fw-700 mt-2">' + icon("check") + " Sent to " + esc(st.mpSentTo) + ". You'll get a copy, and their reply comes straight to you.</p>";
    return (
      '<form id="mp-send-form" class="letter-form mt-2">' +
      '<label class="xs fw-700">Your letter <span class="muted fw-400">(change the part in [brackets])</span><textarea class="input" id="ls-message" rows="11">' + esc(ui.mpDraft || mpLetterBody(mp)) + "</textarea></label>" +
      '<div class="letter-two"><label class="xs fw-700">Your name<input class="input" id="ls-name" autocomplete="name" maxlength="80" value="' + esc(ui.lsName || ui.userName || "") + '" /></label>' +
      '<label class="xs fw-700">Your address<input class="input" id="ls-address" autocomplete="street-address" maxlength="300" placeholder="House number, street, town" value="' + esc(ui.lsAddress || "") + '" /></label></div>' +
      '<p class="xs muted">Your postcode, ' + esc((ui.mpPostcode || "").toUpperCase()) + ", is added. MPs only reply to people in their constituency, so they need your address.</p>" +
      '<button type="submit" class="btn btn-green btn-sm"' + (st.sending ? " disabled" : "") + ">" + (st.sending ? "Sending…" : "Send to " + esc(mp.name)) + "</button>" +
      (st.error ? '<p class="xs red" role="status">' + esc(st.error) + "</p>" : "") +
      '<p class="xs muted">Sent from CO2 Counter\'s address. You get a copy, replies go straight to you, and Act 6 is verified as soon as it\'s sent. We keep only the date, not your letter.</p></form>'
    );
  }

  function mpFinderHtml(info) {
    const mp = ui.mp || {};
    const finder =
      '<form id="mp-form" class="hb-mp-form"><input class="input" id="mp-postcode" autocomplete="postal-code" placeholder="Your postcode" maxlength="10" value="' + esc(ui.mpPostcode || "") + '" aria-label="Your postcode" />' +
      '<button type="submit" class="btn btn-outline btn-sm"' + (mp.loading ? " disabled" : "") + ">" + (mp.loading ? "Finding…" : "Find my MP") + "</button></form>" +
      (mp.error ? '<p class="xs red">' + esc(mp.error) + "</p>" : "");
    const letter = mp.name
      ? '<div class="hb-mp"><p class="sm"><b>' + esc(mp.name) + "</b>, MP for " + esc(mp.constituency) + "</p>" +
        (mp.email
          ? (currentUser ? mpSendForm(mp) : "") +
            (currentUser ? '<details class="letter-alt mt-3"><summary class="sm fw-700">Or use your own email app</summary>' : "") +
            '<div class="hb-share mt-2"><a class="btn ' + (currentUser ? "btn-outline" : "btn-green") + ' btn-sm" href="' + esc(mpLetter(mp)) + '" data-action="mp-sent">Email ' + esc(mp.name.split(" ")[0]) + " " + icon("arrowRight") + "</a>" +
            webmailButtons(mpLetterParts(mp), "mp-sent") + "</div>" +
            '<p class="xs muted mt-2">Outlook on the web can\'t add our copy for you: add ' + MP_COPY + ' as BCC there if you want it verified.</p>' +
            '<p class="xs muted mt-2">Opens your email app with a letter to edit. Add your name and full address: MPs only reply to constituents. We\'re copied in (BCC, ' + MP_COPY + ") so we can verify it, then we delete our copy. Reference CO2-" + esc(info.code) + ".</p>" +
            (currentUser ? "</details>" : "")
          : '<a class="hb-act-link mt-2" href="https://members.parliament.uk/member/' + mp.id + '/contact" target="_blank" rel="noopener">Contact details ' + icon("link") + '</a><p class="xs muted mt-2">If you email them, BCC ' + MP_COPY + " with reference CO2-" + esc(info.code) + " in your message so we can verify it.</p>") +
        "</div>"
      : "";
    return { finder, letter };
  }
  // Act 6: verified when the BCC copy of the letter reaches us. Without the
  // verification set up yet, it falls back to a tick by hand.
  function mobiliseAct(ticked) {
    const base = { n: 6, name: "Mobilise: use your vote", what: "to ask your representatives for action" };
    const info = ui.actsInfo;
    if (!info) return { ...base, manual: "mobilise", done: !!ticked.mobilise, sub: ticked.mobilise ? "Done · ticked by you" : "Tick when you've done it",
      extra: '<a class="hb-act-link" href="https://www.writetothem.com/" target="_blank" rel="noopener">Write to your MP ' + icon("link") + "</a>" };
    const verified = info.verified && info.verified.mobilise;
    if (verified) return { ...base, done: true, verifiedTick: true, sub: "Verified · you wrote to your MP on " + longDate(verified) };
    const { finder, letter } = mpFinderHtml(info);
    return { ...base, done: false, pending: !!ticked.mpSent, sub: ticked.mpSent ? "Waiting for our copy of your letter · this ticks once it arrives" : "Email your MP, and this ticks once our copy arrives", extra: finder + letter };
  }
  function shareButtonsHtml(url, text) {
    return (
      '<span class="hb-share">' +
      '<button type="button" class="hb-act-link" data-action="share-app">' + icon("link") + "Share</button>" +
      '<button type="button" class="hb-act-link" data-action="share-instagram">Instagram</button>' +
      '<a class="hb-act-link" href="https://wa.me/?text=' + text + '" target="_blank" rel="noopener">WhatsApp</a>' +
      '<a class="hb-act-link" href="https://twitter.com/intent/tweet?text=' + text + '" target="_blank" rel="noopener">X</a>' +
      '<a class="hb-act-link" href="https://www.facebook.com/sharer/sharer.php?u=' + url + '" target="_blank" rel="noopener">Facebook</a>' +
      '<a class="hb-act-link" href="#/friends">Add friends</a></span>' + (ui.shareMsg ? '<span class="xs green-dark hb-share-msg">' + esc(ui.shareMsg) + "</span>" : "")
    );
  }
  // Act 7: verified by invite link, once seven people who joined with it
  // have finished the survey.
  function motivateAct(ticked, url, text) {
    const base = { n: 7, name: "Motivate seven other people", what: "to do their 7 Acts" };
    const info = ui.actsInfo;
    const shares = shareButtonsHtml(url, text);
    // Never ticked by hand: only seven people who joined and finished count.
    if (!info) return { ...base, done: false, sub: "Ticks itself once seven people you invite have taken the survey", extra: shares };
    const n = Math.min(7, info.finished || 0);
    const verified = (info.verified && info.verified.motivate) || n >= 7;
    return {
      ...base, done: !!verified, verifiedTick: !!verified,
      sub: verified ? "Verified · seven people you invited have taken the survey" : n + " of 7 people you invited have taken the survey" + (info.joined > n ? " (" + info.joined + " joined)" : ""),
      extra: '<div class="hb-invite">' + inviteCodeHtml() + "</div>" + shares,
    };
  }

  // The page the bill payer opens from the message. No account needed.
  function renderConfirmEnergy() {
    const st = ui.confirmState;
    const body =
      st === "done"
        ? '<h1 class="cat-title display">Thank you</h1><p class="cat-why">That\'s ticked off for them. Switching to renewable electricity cuts your home\'s electricity emissions by {{green_cut}}, every year.</p>' +
          '<a class="btn btn-green mt-4" href="#/">Work out your own footprint ' + icon("arrowRight") + "</a>"
        : st === "bad"
          ? '<h1 class="cat-title display">That link didn\'t work</h1><p class="cat-why">It may have been copied only in part. Ask them to send it again.</p>'
          : '<span class="tag done-tag">Real Zero · Act 2</span><h1 class="cat-title display">Have you switched to a renewable tariff?</h1>' +
            '<p class="cat-why">Someone in your home asked you to switch your electricity to a 100% renewable tariff, and sent you this link. If you have, let them know: it ticks it off on their CO2 Counter. You don\'t need an account.</p>' +
            '<div class="row gap-3 mt-4" style="flex-wrap:wrap"><button type="button" class="btn btn-green" data-action="confirm-energy"' + (st === "saving" ? " disabled" : "") + ">" + (st === "saving" ? "Saving…" : "Yes, we've switched") + "</button>" +
            '<a class="btn btn-outline" href="/greener-switches/">Not yet: how to switch</a></div>';
    return '<div class="container narrow act-page"><header class="glass cat-hero rise"><div class="cat-hero-main">' + body + "</div></header></div>";
  }

  // ---------- 7 Acts pages (acts 5-7; acts 1-4 open Greener switches) ----------

  const ACT_PAGES = { monitor: 5, mobilise: 6, motivate: 7 };
  function actHero(n, title, why, done, statusText) {
    return (
      '<p class="crumbs"><a href="#/habits">My Habits</a> › <span>Act ' + n + " of 7</span></p>" +
      '<header class="glass cat-hero rise"><span class="cat-watermark display act-num" aria-hidden="true">' + n + "</span>" +
      '<div class="cat-hero-main"><span class="tag done-tag">Real Zero · Act ' + n + '</span><h1 class="cat-title display">' + esc(title) + '</h1><p class="cat-why">' + why + "</p></div>" +
      '<div class="cat-hero-side"><div class="cat-figs act-status' + (done ? " done" : "") + '"><span class="hb-box" aria-hidden="true">' + (done ? icon("check") : "") + '</span><b class="display">' + (done ? "Done" : "Not yet") + '</b><span class="muted sm">' + esc(statusText) + "</span></div></div></header>"
    );
  }
  const actStep = (n, title, body) =>
    '<section class="glass guide-card act-step"><div class="label-row"><span class="act-step-n display">' + n + '</span><h2 class="display">' + title + "</h2></div>" + body + "</section>";
  const actLinks = (rows) =>
    '<section class="glass guide-card"><h2 class="display">' + rows.title + '</h2><ul class="act-more">' +
    rows.items.map(([t, b, href]) => '<li><a href="' + href + '" target="_blank" rel="noopener"><b>' + t + "</b><span class=\"sm muted\">" + b + "</span>" + icon("link") + "</a></li>").join("") + "</ul></section>";

  function renderActPage(key) {
    const n = ACT_PAGES[key];
    if (!n) return notFound(true);
    const ready = survey && survey.completedAt;
    const ticked = actsTicked();
    const info = ui.actsInfo;
    let html = '<div class="container narrow act-page">';

    if (key === "monitor") {
      const hist = historyByDay();
      const last = hist[0] || (ready ? { completedAt: survey.completedAt, totalYearly: footprint(survey).totalYearly } : null);
      const first = hist[hist.length - 1];
      const days = last ? Math.floor((Date.now() - Date.parse(last.completedAt)) / 86400000) : null;
      html += actHero(5, "Monitor your CO₂ footprint", "Measuring shows where your biggest cuts are, and measuring again shows what's working. Your survey is the measurement: check in whenever something changes.", !!ready,
        last ? "Last measured " + longDate(last.completedAt) : "Take the survey to measure it");
      html += actStep(1, "Your measurements",
        last
          ? '<ol class="act-hist">' + (hist.length ? hist : [last]).slice(0, 6).map((h, i) =>
              '<li><span class="sm">' + esc(longDate(h.completedAt)) + (i === 0 ? ' <span class="xs muted">latest</span>' : "") + '</span><b class="display tnum">' + kgFmt(h.totalYearly) + " kg</b></li>").join("") + "</ol>" +
            (hist.length > 1 && first ? '<p class="sm mt-3 ' + (last.totalYearly <= first.totalYearly ? "green-dark" : "clay") + '">' + (last.totalYearly <= first.totalYearly ? "▼ " : "▲ ") + kgFmt(Math.abs(last.totalYearly - first.totalYearly)) + " kg a year since your first, on " + esc(longDate(first.completedAt)) + ".</p>" : "") +
            '<a class="btn btn-outline btn-sm mt-3" href="#/results">See your results ' + icon("arrowRight") + "</a>"
          : '<p class="sm muted">You haven\'t measured your footprint yet. It takes about five minutes.</p><a class="btn btn-green mt-3" href="#/">Take the survey ' + icon("arrowRight") + "</a>");
      html += actStep(2, "When to measure again",
        '<p class="sm">Every three months, or after a big change: moving home, a new car, a new job, switching bank or energy, or changing how you eat.</p>' +
        (days != null && days >= 90 ? '<p class="sm fw-700 mt-2">It\'s been ' + days + " days since you last measured. Time for a check-in.</p>" : days != null ? '<p class="sm muted mt-2">You measured ' + (days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago") + ".</p>" : "") +
        (ready ? '<button type="button" class="btn btn-green btn-sm mt-3" data-action="whats-changed">Update my survey ' + icon("arrowRight") + "</button>" : ""));
      html += actStep(3, "Cut where you can", '<p class="sm">Your results show your biggest areas first, and Acts 1 to 4 are the switches that cut them.</p><a class="btn btn-outline btn-sm mt-3" href="/greener-switches/">See your switches ' + icon("arrowRight") + "</a>");
    }

    if (key === "mobilise") {
      const verified = info && info.verified && info.verified.mobilise;
      const done = info ? !!verified : !!ticked.mobilise;
      html += actHero(6, "Mobilise: use your vote", "Personal choices matter, and so do the rules everyone lives by. MPs read what their constituents send them, and a letter in your own words is one of the most direct ways to show that climate matters to voters where you live.", done,
        verified ? "Verified · you wrote to your MP on " + longDate(verified) : !info ? (ticked.mobilise ? "Ticked by you" : "Write to your MP, then tick it") : ticked.mpSent ? "Waiting for our copy of your letter" : "Write to your MP to complete it");
      if (info && !verified) {
        const { finder, letter } = mpFinderHtml(info);
        const mp = ui.mp || {};
        html += actStep(1, "Find your MP", '<p class="sm mb-3">Enter your postcode. We look it up on Parliament\'s own records.</p>' + finder + (mp.name ? '<p class="sm mt-3"><b>' + esc(mp.name) + "</b>, MP for " + esc(mp.constituency) + "</p>" : ""));
        html += actStep(2, "Send your letter",
          mp.name
            ? letter.replace(/<p class="sm"><b>[^<]*<\/b>, MP for [^<]*<\/p>/, "") +
              (mp.email ? '<details class="act-letter mt-3"><summary class="sm fw-700">Preview the letter</summary><pre>' + esc(decodeURIComponent(mpLetter(mp).split("&body=")[1] || "")) + "</pre></details>" : "")
            : '<p class="sm muted">Find your MP first. Then a button opens your own email app with a letter ready to edit: say what matters to you, and add your name and address.</p>');
        html += actStep(3, "We verify it", '<p class="sm">We\'re copied in (BCC, ' + MP_COPY + "), so your MP doesn't see us. When our copy arrives we match your reference, <b>CO2-" + esc(info.code) + "</b>, tick this act as verified and delete the email.</p>");
      } else if (!info) {
        html += actStep(1, "Write to your MP", '<p class="sm">WriteToThem finds your MP from your postcode and sends your message for you.</p><a class="btn btn-green btn-sm mt-3" href="https://www.writetothem.com/" target="_blank" rel="noopener">Write to your MP ' + icon("link") + "</a>");
        html += actStep(2, "Tick it off", '<button type="button" class="btn btn-outline btn-sm" data-action="tick-act" data-act="mobilise">' + (ticked.mobilise ? "Untick" : "I've written to my MP") + "</button>");
      } else {
        html += actStep(1, "Thank you", '<p class="sm">Your letter to your MP is verified. Keep an eye out for your MP\'s reply, and write again when climate votes come up.</p>');
      }
      html += actLinks({ title: "More ways to use your voice", items: [
        ["Register to vote", "Takes about 5 minutes. You need to be registered to vote in elections.", "https://www.gov.uk/register-to-vote"],
        ["Write to your councillors", "Councils run planning, transport and housing. WriteToThem finds yours.", "https://www.writetothem.com/"],
        ["Sign or start a petition", "Parliament considers petitions with 100,000 signatures for debate.", "https://petition.parliament.uk/"],
        ["Find your MP's contact details", "Including their office and surgery details.", "https://members.parliament.uk/FindYourMP"],
      ] });
    }

    if (key === "motivate") {
      const nDone = info ? Math.min(7, info.finished || 0) : 0;
      const verified = info && ((info.verified && info.verified.motivate) || nDone >= 7);
      const done = !!verified;
      const url = encodeURIComponent(inviteLink());
      const text = encodeURIComponent(shareText() + " " + inviteLink());
      html += actHero(7, "Motivate seven other people", "Change spreads through the people we know. The seventh act is to get seven others measuring their footprint and doing their own 7 Acts.", done,
        !info ? "Ticks itself once seven people you invite have taken the survey" : verified ? "Verified · seven people you invited have taken the survey" : nDone + " of 7 so far");
      if (info) {
        html += actStep(1, "Your progress",
          '<div class="act-dots" role="img" aria-label="' + nDone + ' of 7">' + [0, 1, 2, 3, 4, 5, 6].map((i) => '<span class="' + (i < nDone ? "on" : "") + '">' + (i < nDone ? icon("check") : "") + "</span>").join("") + "</div>" +
          '<p class="sm mt-3"><b>' + nDone + " of 7</b> people you invited have taken the survey" + (info.joined > nDone ? ", and " + (info.joined - nDone) + " more have joined but not finished yet" : "") + ".</p>" +
          '<p class="xs muted mt-2">Someone counts when they sign up with your link and finish their survey. We never show you who they are or their answers.</p>');
        // Reductions by people who joined with an invite: yours, and everyone's.
        const cutLine = (kg) => '<b class="display tnum act-cut">−' + kgFmt(kg) + ' kg</b><span class="sm muted"> CO₂e a year</span>';
        html += actStep(2, "Your invites' impact",
          '<div class="act-impact"><div><span class="eyebrow">People you invited</span>' +
            (info.cut != null
              ? '<p>' + cutLine(info.cut) + '</p><p class="xs muted">Cut between them since their first survey, across ' + info.cut_people + (info.cut_people === 1 ? " person" : " people") + " who've measured twice.</p>"
              : '<p class="sm muted mt-1">Once two or more people you invited have updated their survey, you\'ll see how much they\'ve cut between them.</p>') +
          '</div><div><span class="eyebrow">Everyone\'s invites</span>' +
            (info.global_cut != null
              ? '<p>' + cutLine(info.global_cut) + '</p><p class="xs muted">Cut by the ' + kgFmt(info.global_people) + " people who joined CO2 Counter through a friend and have measured twice.</p>"
              : '<p class="sm muted mt-1">The total across CO2 Counter appears once enough people who joined through a friend have measured twice.</p>') +
          "</div></div>" +
          '<p class="xs muted mt-3">A reduction is the drop from someone\'s first survey to their latest. Totals only: we never show anyone\'s own figures.</p>');
        html += actStep(3, "Your invite code", '<div class="stack-3">' + inviteCodeHtml() + "</div>" + '<div class="mt-3">' + shareButtonsHtml(url, text) + "</div>");
        // Someone handed just a code can still be counted for their friend.
        html += actStep(4, "Got a code from a friend?",
          '<form id="claim-form" class="hb-mp-form"><input class="input" id="claim-code" placeholder="e.g. ABC234" maxlength="12" autocomplete="off" aria-label="Friend\'s invite code" />' +
          '<button type="submit" class="btn btn-outline btn-sm">Use code</button></form>' +
          (ui.claimMsg ? '<p class="xs mt-2 ' + (ui.claimMsg.ok ? "green-dark" : "red") + '" role="status">' + esc(ui.claimMsg.text) + "</p>" : "") +
          '<p class="xs muted mt-2">Enter it before you finish your first survey. You count towards their Act 7 once you have. Each person can only be counted once.</p>');
      } else {
        html += actStep(1, "Share CO2 Counter", shareButtonsHtml(url, text) + '<p class="xs muted mt-3">This act can\'t be ticked by hand: it ticks itself once seven people you invite have taken the survey.</p>');
      }
      html += actStep(info ? 5 : 2, "Ideas that work",
        '<ul class="act-ideas">' +
        '<li><b>Start a group.</b> Make one on the <a href="#/friends">Friends</a> page for your team, family or housemates, and compare progress together.</li>' +
        "<li><b>Share your result.</b> Your footprint is a good conversation starter. The share message includes it.</li>" +
        "<li><b>Bring it to work.</b> Staff networks and green teams are a natural fit, and many employers run sustainability weeks.</li>" +
        "<li><b>Do it together.</b> Taking the survey side by side takes five minutes and makes it easy to start.</li></ul>");
    }
    return html + '<div class="center mt-6"><a class="btn btn-outline" href="#/habits">' + icon("arrowLeft") + " Back to My Habits</a></div></div>";
  }

  // The 7 Acts with their state, for My Habits and the Account tile.
  function habitActs() {
    const ready = survey && survey.completedAt;
    const areas = ready ? switchAreas({ s: survey, mine: true }) : [];
    const area = (k) => areas.find((a) => a.key === k);
    const ticked = actsTicked();
    const travel = ready ? [area("commute"), area("flights")] : [];
    const travelSave = travel.reduce((t, a) => t + (a.done ? 0 : a.save), 0);
    const auto = (a) => (ready ? { done: a.done, save: a.done ? 0 : a.save, sub: a.done ? (a.save >= 0.5 ? "Done · could go a bit further, −" + kgFmt(a.save) + " kg" : "Done · " + a.doneTitle.replace(/^You're /, "you're ").replace(/^You /, "you ").replace(/^No /, "no ")) : a.save >= 0.5 ? "Not yet · could save " + kgFmt(a.save) + " kg a year" : "Not yet" } : { done: false, sub: "Finish your survey to see" });
    const url = encodeURIComponent(inviteLink());
    const text = encodeURIComponent(shareText() + " " + inviteLink());
    const billPayer = asksBillPayer(ready ? survey : null);
    const travelDone = ready && travel.every((a) => a.done);
    const acts = [
      { n: 1, name: "Move your money", what: "away from banks that finance fossil fuels", icon: SW_ICONS.banking, cat: "banking", ...(ready ? auto(area("banking")) : auto()) },
      billPayer
        ? { n: 2, name: "Move your energy", what: "to a 100% renewable supplier, and electrify", icon: SW_ICONS.energy, done: !!energyVerified(), pending: !energyVerified() && !!ticked.energyAsked,
            sub: energyVerified() ? "Verified · they confirmed the switch on " + longDate(energyVerified())
              : ticked.energyAsked ? "Asked · waiting for them to confirm they've switched" : "Someone else chooses your supplier: ask them to switch",
            extra: energyAskBox(), keepExtra: true, energy: true }
        : { n: 2, name: "Move your energy", what: "to a 100% renewable supplier, and electrify", icon: SW_ICONS.energy, cat: "energy", ...(ready ? auto(area("energy")) : auto()) },
      { n: 3, name: "More plant-based food", what: "seasonal and local where you can", icon: SW_ICONS.meals, cat: "meals", ...(ready ? auto(area("meals")) : auto()) },
      { n: 4, name: "More green travel", what: "walk, cycle, take the train, fly less", icon: HB_TRAIN, cat: travel.length && travel[0].done ? "flights" : "commute",
        done: travelDone, save: travelDone ? 0 : travelSave,
        sub: !ready ? "Finish your survey to see" : travelDone ? "Done · green commute and no flights" :
          [travel[0].done ? "Commute done" : "Commute not yet", travel[1].done ? "no flights" : "flights not yet"].join(" · ") + (travelSave >= 0.5 ? " · could save " + kgFmt(travelSave) + " kg a year" : "") },
      { n: 5, name: "Monitor your CO₂ footprint", what: "and cut where you can", icon: HB_CHART, href: "#/acts/monitor", done: !!ready, sub: ready ? "Done · you've measured it with CO2 Counter" : "Take the survey to tick this one" },
      { ...mobiliseAct(ticked), icon: HB_VOTE },
      { ...motivateAct(ticked, url, text), icon: SW_ICONS.motivate },
    ];
    return { acts, ready, billPayer };
  }
  // My Habits as a game: a level for the acts you've done, your next best
  // act, a tile per act that opens into its quest (the picture, the links,
  // the steps), badges, and a little party when an act is newly banked.
  const HB_LEVELS = [[0, "Seed"], [1, "Sprout"], [3, "Sapling"], [5, "Tree"], [7, "Forest"]];
  const HB_COL = { 1: "#3F5B3A", 2: "#B27A14", 3: "#557546", 4: "#3E7A8A", 5: "#2B3F28", 6: "#6F4E63", 7: "#B8653D" };
  const HB_BADGE = { 1: "Clean money", 2: "Renewable home", 3: "Plant power", 4: "Green miles", 5: "First measure", 6: "Your voice", 7: "Team builder" };
  const HB_WHY = {
    1: "Your savings get lent out. Move them and they fund homes and wind farms, not oil.",
    2: "Power from wind, sun and water instead of gas.",
    3: "Food is a big slice for most people. A few plant-based days a week cuts it fast.",
    4: "Swap a regular car trip or flight for a train, a bus or a bike.",
    5: "What gets measured gets cut. Retake the survey and watch your line fall.",
    6: "MPs read letters from the people they represent. One letter counts.",
    7: "Friends copy friends. Seven of you doing the 7 Acts is seven times the cut.",
  };
  const HB_STEPS = {
    1: [["Pick a bank below", "The Current Account Switch Service moves everything for you in 7 working days."], ["Open an account and switch", ""], ["Update your survey to bank it", ""]],
    2: [["Pick a supplier below", "Switching online takes about 10 minutes. Your new supplier does the rest."], ["Switch online", ""], ["Update your survey to bank it", ""]],
    3: [["Try a box or a recipe kit", "Start with one meal a week."], ["Swap a few meals a week", ""], ["Update your survey to bank it", ""]],
    4: [["Pick a trip you make often", "Start with one trip, not all of them."], ["Try it by train, bus or bike", ""], ["Update your survey to bank it", ""]],
    5: [["Retake the survey", "About 5 minutes, every few months."], ["See what changed", ""], ["Come back next season", ""]],
    6: [["Find your MP", "About 5 minutes with the letter we start for you."], ["Send the letter", ""], ["It ticks itself when our copy arrives", ""]],
    7: [["Share your invite link", "One link, sent to anyone."], ["Friends take the survey", ""], ["Ticks itself when seven have", ""]],
  };
  const HB_STAR = "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9Z";
  // A hand-drawn outline for each level: [path, part] (g ground, t trunk, l leaves, d detail).
  const HB_TREES = {"seed":[["M8 86c14-3 28-1 40 1s30 3 44 0c8-1 15-1 20 0","g"],["M20 97c6-1 11 0 16 1M70 99c7-1 14-1 20 0M40 103c5 0 9 0 13 1","d"],["M52 84c3-6 11-9 17-6 5 3 5 10 0 14-6 4-15 3-17-2-1-2-1-4 0-6z","l"],["M56 88c3-4 7-6 11-6","d"],["M58 94c-1 3-3 5-6 6M62 95c0 3 1 6 3 8","t"],["M63 79c0-6 1-11 4-15","t"],["M67 64c3-3 7-4 10-3-2 4-6 5-10 3z","l"],["M30 80l1 1M84 80l1 0M92 92l1 1M24 92l1 0M104 95l1 0","d"]],"sprout":[["M10 94c15-3 30-2 44 0s32 2 46-1c5-1 9 0 12 1","g"],["M24 101c5-1 10-1 15 0M66 101c6-1 12-1 18 0","d"],["M60 94c1-10-1-19 1-28 1-6 0-12 1-17","t"],["M61 58c-5-9-16-12-26-9 2 10 13 16 26 11","l"],["M61 55c4-10 15-15 27-13-2 11-13 18-27 15","l"],["M44 52c5 1 10 3 15 6M79 46c-5 2-11 5-16 9","d"],["M38 90c1-3 0-5-1-7M41 90c1-2 2-4 4-5M84 91c0-3 1-5 2-6M87 92c1-1 3-2 5-2","d"]],"sapling":[["M8 96c16-3 32-2 48 0 16 1 33 2 48-1 4-1 8 0 11 1","g"],["M58 96c1-14 0-27 2-40 1-9 0-17 2-25","t"],["M60 62c-7-4-12-10-15-18M61 50c6-4 11-10 13-17M60 76c6-3 12-6 18-11","t"],["M45 44c-7-2-13 2-15 8 7 2 13-1 15-8z","l"],["M46 43c-1-7 3-12 9-13 1 7-3 12-9 13z","l"],["M74 33c1-7 6-11 12-11 0 7-5 11-12 11z","l"],["M73 34c6-3 12-1 15 4-6 3-12 1-15-4z","l"],["M78 65c3-6 9-8 15-6-3 6-9 8-15 6z","l"],["M62 31c-4-6-3-12 1-16 4 5 3 11-1 16z","l"],["M59 66c-6-1-11 2-13 7 6 1 11-2 13-7z","l"],["M30 92c0-3-1-5-2-6M33 92c1-2 2-3 4-4M90 93c0-2 1-4 2-5","d"]],"tree":[["M6 98c16-3 33-2 50-1 17 1 34 2 50-1 4 0 7 0 10 1","g"],["M53 97c3-9 3-19 3-29l-1-16M67 97c-3-9-3-19-3-29l1-16","t"],["M53 97c-5 1-9 0-13 2M67 97c5 1 9 0 13 2M58 97l-2 3M63 97l2 3","t"],["M56 66c-6-3-11-8-14-14M64 62c5-3 10-8 12-14M60 70l0-24","t"],["M59.9 13.1Q70.7 5.7 75.3 17.2Q91.7 15.7 89.6 28.6Q99.4 33.9 93.8 41.9Q98.1 53.1 84.1 57.7Q83.9 69.6 70.7 66.1Q60.2 73.0 50.3 64.3Q37.2 68.1 36.0 57.0Q21.7 53.7 28.7 42.9Q18.3 34.4 30.5 28.6Q28.6 18.8 41.6 19.4Q47.5 8.7 59.9 13.1Z","l"],["M34 44c2-3 5-5 9-5M78 36c3 0 6 2 8 4M44 68c3 1 6 1 9 0M75 64c2-1 4-3 5-5","d"],["M86 52l1 1M38 56l1 1M70 30l1 1M50 30l1 0","d"]],"forest":[["M4 98c18-3 36-2 54-1 18 1 36 2 54-1 3 0 6 0 8 1","g"],["M61 97c1-8 1-16 0-28M67 97c-1-8-1-16 0-28","t"],["M64.7 20.3Q74.8 17.4 79.2 26.8Q92.5 28.0 89.8 38.8Q95.3 47.4 86.6 54.1Q85.6 66.8 71.4 65.4Q62.8 71.7 54.4 66.0Q42.1 64.8 40.7 53.8Q31.8 48.4 38.6 40.9Q35.1 30.0 47.1 26.6Q53.0 16.4 64.7 20.3Z","l"],["M64 72c-4-4-7-9-8-15M65 69c3-3 6-7 7-12","d"],["M23 97l0-12","t"],["M23 38c-3 6-7 11-11 15 3 0 5 0 7-1-4 7-9 12-14 16 4 1 8 1 11-1-4 7-9 12-14 16 9 1 23 1 34 0-5-4-10-9-13-16 3 2 7 2 11 1-5-4-9-9-12-16 2 1 5 1 7 1-4-4-7-9-6-15z","l"],["M100 97c1-6 1-11 0-17","t"],["M99.8 53.7Q107.5 52.8 110.6 59.9Q115.6 66.1 110.1 72.0Q107.8 78.3 101.0 77.4Q92.3 79.2 89.3 71.0Q84.5 65.9 89.1 60.7Q91.9 53.3 99.8 53.7Z","l"],["M14 93c0-2-1-4-2-5M44 94c1-2 2-3 4-4M80 93c0-2 1-4 2-5M112 93c1-1 2-2 4-3","d"],["M51 40c2-2 5-3 8-3M94 62c1-2 3-3 5-3","d"]]};
  const hbTree = (name, cls, draw) =>
    '<svg class="hb3-tree ' + (cls || "") + (draw ? " draw" : "") + '" viewBox="0 0 120 110" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    HB_TREES[name.toLowerCase()].map(([d, t], i) => '<path class="tr-' + t + '" d="' + d + '" pathLength="1" style="--n:' + i + '"></path>').join("") + "</svg>";
  const KEY_HB_WON = "co2_hb_won"; // acts already celebrated, per account

  function renderHabitsPage() {
    const { acts, ready } = habitActs();
    syncSunday(acts);
    const state = (a) => (a.done ? "done" : a.pending ? "wait" : "todo");
    const made = acts.filter((a) => a.done).length;
    const waiting = acts.filter((a) => state(a) === "wait").length;
    const toSave = acts.slice(0, 4).reduce((t, a) => t + (a.done || !a.save ? 0 : a.save), 0);
    const animate = !ui.habitsSeen;
    ui.habitsSeen = true;
    if (!ui.hbOpen) ui.hbOpen = {};
    const lv = HB_LEVELS.reduce((k, l, i) => (made >= l[0] ? i : k), 0);
    const nextLv = HB_LEVELS[lv + 1];
    const toNext = nextLv ? nextLv[0] - made : 0;
    const lvPct = nextLv ? Math.max(8, Math.round(((made - HB_LEVELS[lv][0]) / (nextLv[0] - HB_LEVELS[lv][0])) * 100)) : 100;
    const toNextText = nextLv ? toNext + (toNext === 1 ? " act" : " acts") + " to " + nextLv[1] : "Top level";

    // Newly banked acts get a party, once (the first visit counts too).
    const wonKey = KEY_HB_WON + (currentUser ? ":" + currentUser.id : "");
    if (!ui.hbWin || ui.hbWin.key !== wonKey) {
      const before = lsGet(wonKey, []);
      const doneNow = acts.filter((a) => a.done).map((a) => a.n);
      const fresh = doneNow.filter((n) => !before.includes(n));
      lsSet(wonKey, doneNow);
      ui.hbWin = { key: wonKey, list: fresh };
      if (fresh.length) setTimeout(() => haptic("success"), 450);
    }
    const fresh = (ui.hbWin.list || []).map((n) => acts.find((a) => a.n === n)).filter((a) => a && a.done);

    const people = () => {
      const info = ui.actsInfo;
      if (!info) return "";
      const n = Math.min(7, info.finished || 0);
      const joined = Math.min(7, Math.max(n, info.joined || 0));
      const dots = Array.from({ length: 7 }, (_, i) => '<span class="' + (i < n ? "fin" : i < joined ? "joined" : "") + '">' + icon(i < n ? "check" : i < joined ? "user" : "plus") + "</span>").join("");
      return '<div class="hb-ppl" role="img" aria-label="' + n + " of 7 invited people have taken the survey, " + joined + ' have joined">' + dots + "</div>" +
        '<div class="hb3-xp" aria-hidden="true"><i style="--w:' + Math.max(4, (n / 7) * 100).toFixed(1) + '%"></i></div>' +
        '<p class="hb3-note"><b>' + n + " of 7</b> have taken the survey" + (n < 7 ? " · " + (7 - n) + " more for <b>Team builder</b>" : "") + "</p>";
    };
    let areas = [];
    try { areas = switchAreas(ready ? { s: survey, mine: true } : { s: switchBaseTypical(), mine: false }); } catch (e) {}
    const areaOf = (k) => areas.find((x) => x.key === k);
    const offerList = (keys) => {
      const seen = {}, list = [];
      keys.forEach((k) => {
        const ar = areaOf(k);
        if (!ar || ar.askHtml) return;
        (ar.links || []).forEach((l) => { if (!seen[l.label]) { seen[l.label] = 1; list.push({ k, ar, l }); } });
      });
      return list;
    };
    const offers = (keys) => {
      const list = offerList(keys);
      if (!list.length) return "";
      const paid = list.some((x) => x.l.ref);
      const bank = keys.includes("banking");
      const lead = bank ? "Switch to one of these banks" : keys.includes("energy") ? "Switch to a renewable supplier" : keys.includes("meals") ? "Try one of these" : "Make the switch with one of these";
      return (
        '<p class="hb-offers-lead display">' + lead + "</p>" +
        '<ul class="hb-offers">' +
        list.map(({ k, ar, l }, i) => {
          const name = l.label === "The Man in Seat 61" ? "Seat 61" : l.label.replace(/^The /, "");
          // Only the bank list is ranked (by the league table), so only it has a top pick.
          return '<li style="--k:' + i + '"><a class="hb-offer" ' + linkAttrs(k, l, "habits") + ">" + (bank && i === 0 ? '<span class="hb3-top">★ Top of the league</span>' : "") +
            '<span class="display sw-mono">' + esc(monogramText(l.label)) + "</span>" +
            '<span class="min0"><b class="display">' + esc(l.label) + (l.ref ? ' <span class="tag affiliate-tag">Affiliate</span>' : "") + '</b><span class="xs muted">' + esc(l.note) + "</span></span>" +
            '<span class="hb-offer-go"><span>' + esc(ar.verb + " " + name).replace(/-/g, "\u2011") + icon("link") + "</span></span></a></li>";
        }).join("") + "</ul>" +
        '<p class="xs muted">' + (bank ? "Chosen using the bank league table. " : "") + (paid ? "Some of these are referral links: if you switch, CO2 Counter may get a reward at no cost to you." : bank ? "" : "Independent suggestions. We don't get paid for these links.") + "</p>"
      );
    };
    // Now and realistic as two bubbles, their areas matching the kg.
    const fpNow = ready ? footprint(survey) : null;
    const kgOf = (keys) => (fpNow ? fpNow.breakdown.filter((b) => keys.includes(b.key)).reduce((t, b) => t + b.yearly, 0) : 0);
    const cutOf = (keys) => (ready ? keys.reduce((t, k) => t + (tipFor(k, survey).saving || 0), 0) : 0);
    const mini = (label, now, cut, whole) => {
      if (!ready) return "";
      if (now < 0.5)
        return '<figure class="hb-mini empty"><figcaption>' + esc(label) + '</figcaption><p class="xs muted">Nothing counted yet. ' +
          (label === "Your money footprint" ? "Add your bank and pension in the survey to see it." : "Your survey has none here.") + "</p></figure>";
      const after = Math.max(0, now - cut), pct = now ? Math.round((cut / now) * 100) : 0;
      const d = Math.max(22, 128 * Math.sqrt(after / now));
      const inside = d >= 70;
      const real = '<b class="display tnum">' + kgFmt(after) + "</b><span>Realistic</span>";
      const ofWhole = whole && fpNow && fpNow.totalYearly && cut >= 0.5 ? Math.round((cut / fpNow.totalYearly) * 100) : 0;
      return (
        '<figure class="hb-mini" role="img" aria-label="' + esc(label) + ": " + kgFmt(now) + " kg a year now" + (cut >= 0.5 ? ", " + kgFmt(after) + " kg with a realistic change" : "") + '">' +
        '<figcaption><span>' + esc(label) + "</span><span>kg CO₂e a year</span></figcaption>" +
        '<div class="hb3-bubs"><span class="hb3-bub now"><span><b class="display tnum">' + kgFmt(now) + "</b><span>Now</span></span></span>" +
        '<span class="hb3-dash" aria-hidden="true"></span>' +
        '<span class="hb3-bubcol">' + (inside ? "" : '<span class="hb3-reallab">' + real + "</span>") +
        '<span class="hb3-bub real" style="--r:' + (d / 128).toFixed(3) + '">' + (inside ? "<span>" + real + "</span>" : "") + "</span></span></div>" +
        '<p class="hb-mini-cut">' + (cut >= 0.5 ? "−" + kgFmt(cut) + " kg a year · " + pct + "% less" : "Already about as low as it goes") + "</p>" +
        (ofWhole ? '<p class="hb3-ofwhole">' + ofWhole + "% of your whole footprint</p>" : "") + "</figure>"
      );
    };
    const steps = (a) =>
      '<div class="hb3-quest"><span class="hb3-k">Your quest</span><ol>' +
      HB_STEPS[a.n].map((s, i) => '<li class="' + (a.done ? "done" : i === 0 ? "on" : "") + '"><span class="hb3-sn">' + (a.done ? icon("check") : i + 1) + "</span><span>" + esc(s[0]) + "</span></li>").join("") +
      "</ol>" + (HB_STEPS[a.n][0][1] ? '<p class="hb3-time">' + icon("clock") + esc(HB_STEPS[a.n][0][1]) + "</p>" : "") + "</div>";
    const split = (pic, rest) => (pic ? '<div class="hb-split">' + pic + '<div class="hb-split-r">' + rest + "</div></div>" : rest);
    const explain = (cats) =>
      cats.map(([cat, label]) => '<a class="btn btn-outline btn-sm hb-more" href="' + catHref(cat) + '" data-action="open-move" data-cat="' + cat + '">' + esc(label) + " " + icon("arrowRight") + "</a>").join("");
    // "I've switched" takes you to that step of the survey, which banks it.
    const stepOf = (cat) => Math.max(0, STEPS.findIndex((s) => s.key === cat));
    const banked = (a, cat) =>
      ready && !a.done && !a.pending && a.save >= 0.5
        ? '<button type="button" class="hb3-win-btn" data-action="hb-update" data-step="' + stepOf(cat) + '">' + icon("check") + "I've switched · update my survey</button>"
        : "";
    const foot = (inner) => '<div class="hb-explain-row hb3-foot">' + inner + "</div>";
    const streak = () => {
      const hist = historyByDay().map((h) => monthKey(new Date(h.completedAt)));
      const months = (hist.length ? hist : getSnapshots().map((s) => s.month)).concat(ready && survey.completedAt ? [monthKey(new Date(survey.completedAt))] : []);
      const now = new Date();
      const six = Array.from({ length: 6 }, (_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)));
      const n = new Set(months).size;
      return (
        '<div class="hb3-streak"><span class="hb3-k">Your surveys</span><div class="hb3-months">' +
        six.map((m, i) => '<span class="' + (months.includes(m) ? "on" : i === 5 ? "due" : "") + '"><i></i>' + esc(monthLabel(m).split(" ")[0]) + "</span>").join("") +
        '</div><p class="hb3-note">' + (n ? "<b>" + n + (n === 1 ? " survey" : " surveys") + "</b> so far." + (months.includes(six[5]) ? " Done this month." : " Do one this month to keep it going.") : "Take your first survey to start.") + "</p></div>"
      );
    };
    const inside = (a) => {
      const pageLink = (h) => '<a class="hb-page-link xs fw-700" href="' + h + '">More on this act ' + icon("arrowRight") + "</a>";
      const why = '<p class="hb3-why">' + esc(HB_WHY[a.n]) + "</p>";
      if (a.n === 6) {
        const how = ui.actsInfo && !a.done
          ? '<ol class="hb-how2"><li>Write your letter here, or in Gmail or Outlook</li><li>We\'re copied in, so your MP doesn\'t see us</li><li>We match your reference, tick it and delete our copy</li></ol>' : "";
        const tick = a.manual ? '<button type="button" class="hb-tick btn btn-outline btn-sm" data-action="tick-act" data-act="' + a.manual + '" role="checkbox" aria-checked="' + a.done + '">' + icon("check") + (a.done ? " Done" : " Mark as done") + "</button>" : "";
        return why + split(steps(a), (ui.actsInfo && !a.done ? '<p class="xs muted">Find your MP on Parliament\'s own records.</p>' : "") + (a.done ? "" : a.extra || "") + how + tick + pageLink("#/acts/mobilise"));
      }
      if (a.n === 7) {
        const code = ui.actsInfo && ui.actsInfo.code;
        return why + split(steps(a),
          people() +
          (code ? '<div class="hb-inv"><div class="min0"><span class="hb-box-label">Your invite code</span><b class="display tnum">' + esc(code) + '</b></div><button type="button" class="btn btn-outline btn-sm" data-action="copy-code">' + icon("copy") + "Copy</button></div>" : "") +
          '<div class="chip-row"><button type="button" class="btn btn-green hb3-big" data-action="invite-share">' + icon("link") + " Invite friends</button>" +
          '<a class="btn btn-outline btn-sm" href="#/friends">Add friends</a></div>' +
          (ui.shareMsg ? '<p class="xs green-dark">' + esc(ui.shareMsg) + "</p>" : "") + pageLink("#/acts/motivate")
        );
      }
      if (a.n === 5)
        return why + split(
          '<div class="hb3-left">' + mini("Your whole footprint", fpNow ? fpNow.totalYearly : 0, fpNow ? fpNow.breakdown.reduce((t, b) => t + (tipFor(b.key, survey).saving || 0), 0) : 0) + steps(a) + "</div>",
          streak() +
          foot('<a class="btn btn-green hb3-big" href="#/" data-action="start-survey">' + (ready ? "Update my survey" : "Take the survey") + " " + icon("arrowRight") + "</a>" +
            (ready ? '<a class="btn btn-outline btn-sm hb-more" href="#/results">Explain more ' + icon("arrowRight") + "</a>" : "")) +
          '<a class="hb-page-link xs fw-700" href="#/acts/monitor">More on this act ' + icon("arrowRight") + "</a>");
      if (a.n === 4)
        return why + travelFlow({ commute: areaOf("commute"), flights: areaOf("flights") }, undefined, ready) + split('<div class="hb3-left">' + mini("Your travel footprint", kgOf(["commute", "flights"]), cutOf(["commute", "flights"]), true) + steps(a) + "</div>",
          offers(["commute", "flights"]) + foot(banked(a, travelStep(a)) + explain([["commute", "Explain more: commute"], ["flights", "Explain more: flights"]])));
      const cat = { 1: "banking", 2: "energy", 3: "meals" }[a.n];
      const name = { 1: "Your money footprint", 2: "Your home energy footprint", 3: "Your food footprint" }[a.n];
      return why + split('<div class="hb3-left">' + mini(name, kgOf([cat]), cutOf([cat]), true) + steps(a) + "</div>",
        (a.energy ? a.extra || "" : offers([cat])) + foot((a.energy ? "" : banked(a, cat)) + explain([[cat, "Explain more"]])));
    };
    // Act 4's survey step: the commute unless that's done.
    const travelStep = (a) => (a.cat === "flights" ? "flights" : "commute");
    const shows = (a) => ready && !a.done && a.save >= 0.5;
    const subOf = (a) => (shows(a) ? String(a.sub).replace(/ · could save [\d,]+ kg a year$/, "") : a.sub);
    const chip = (a) =>
      a.done ? '<span class="hb3-chip done">' + icon(hbVerified(a) ? "shield" : "check") + (hbVerified(a) ? "Verified" : "Banked") + "</span>"
        : a.pending ? '<span class="hb3-chip wait">' + icon("clock") + "Waiting</span>"
        : shows(a) ? '<span class="hb3-chip kg"><b class="tnum">−' + kgFmt(a.save) + "</b> kg</span>"
        : a.n === 7 && ui.actsInfo ? '<span class="hb3-chip">' + Math.min(7, ui.actsInfo.finished || 0) + " of 7</span>"
        : '<span class="hb3-chip">' + (ready || a.n > 5 ? "Ready" : "Survey first") + "</span>";
    const reward = (a) =>
      '<span class="hb3-medal" aria-hidden="true"><span>' +
      (a.done ? icon("check") + "<small>Banked</small>" : shows(a) ? '<b class="display tnum">−' + kgFmt(a.save) + "</b><small>kg a year</small>" : '<b class="display">+1</b><small>act</small>') +
      "</span></span>";
    // The badge sits on the act's icon once it's banked.
    const node = (a) =>
      '<span class="hb-node ' + state(a) + '" aria-hidden="true">' + svgPath(a.icon, 22) +
      (a.done ? '<span class="hb3-pin" title="' + esc(HB_BADGE[a.n]) + '">' + icon("check") + "</span>" : a.pending ? '<span class="hb3-pin wait">' + icon("clock") + "</span>" : "") + "</span>";
    const row = (a, i) => {
      const cls = "hb-row hb-card hb3-tile " + state(a) + (a.done ? " done" : a.pending ? " pending" : "");
      return (
        '<li class="hb-item" id="hb-act-' + a.n + '" style="--i:' + i + ";--c:" + HB_COL[a.n] + '">' +
        '<details class="hb-acc" data-n="' + a.n + '"' + (ui.hbOpen[a.n] ? " open" : "") + '><summary class="' + cls + '"' + (a.cat ? ' data-cat="' + a.cat + '"' : "") + ">" +
        node(a) + '<span class="hb3-actn">Act ' + a.n + ' <span class="hb3-q">· Quest</span></span>' +
        '<span class="min0 hb-body"><span class="display hb-name">' + esc(a.name) + '</span><span class="hb-sub">' + esc(subOf(a)) + "</span></span>" +
        chip(a) + reward(a) + '<span class="sr-only">' + (a.done ? "done" : a.pending ? "waiting" : "not done yet") + "</span>" +
        '<span class="hb-chev" aria-hidden="true">' + icon("x") + "</span></summary>" +
        '<div class="hb-acc-body">' + inside(a) + "</div></details></li>"
      );
    };

    // Seven ring segments with small gaps, starting at the top.
    const R = 94, C = 120, gap = 5;
    const pt = (deg) => { const r = ((deg - 90) * Math.PI) / 180; return [C + R * Math.cos(r), C + R * Math.sin(r)]; };
    const COL = { done: "#E8C88A", wait: "#7FA3AE", todo: "transparent" };
    const segs = acts.map((a, i) => {
      const a0 = i * (360 / 7) + gap / 2, a1 = (i + 1) * (360 / 7) - gap / 2;
      const [x0, y0] = pt(a0), [x1, y1] = pt(a1), [tx, ty] = pt((i + 0.5) * (360 / 7));
      const d = "M" + x0.toFixed(1) + " " + y0.toFixed(1) + "A" + R + " " + R + " 0 0 1 " + x1.toFixed(1) + " " + y1.toFixed(1);
      const len = Math.ceil((R * Math.PI * (a1 - a0)) / 180);
      const st = state(a);
      return {
        path: '<path d="' + d + '" fill="none" stroke="rgba(246,241,230,.14)" stroke-width="30"/>' +
          '<path class="' + (animate ? "hb-seg" : "") + '" d="' + d + '" fill="none" stroke="' + COL[st] + '" stroke-width="30" style="--len:' + len + ";stroke-dasharray:" + len + ";animation-delay:" + (0.3 + i * 0.12).toFixed(2) + 's"/>',
        label: '<text x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="middle" dominant-baseline="central" fill="' + (st === "todo" ? "#C9D3BC" : "#22331F") + '">' + a.n + "</text>",
      };
    });
    const ring =
      '<div class="hb-ring-box"><svg class="hb-ring" width="240" height="240" viewBox="0 0 240 240" role="img" aria-label="' + made + " of 7 acts done" + (waiting ? ", " + waiting + " waiting for confirmation" : "") + '">' +
      segs.map((s) => s.path).join("") + segs.map((s) => s.label).join("") + "</svg>" +
      '<div class="hb-ring-mid"><div><b class="display tnum">' + made + "<small>/7</small></b><span>done" + (waiting ? " · " + waiting + " waiting" : "") + "</span></div></div></div>";

    // Your next best act: the biggest saving still to bank.
    const best = acts.slice(0, 4).filter((a) => shows(a) && !a.pending).sort((x, y) => y.save - x.save)[0] || acts.find((a) => !a.done && !a.pending);
    const spot = !ready
      ? '<section class="hb3-spot" aria-label="Start here"><span class="hb3-k">Start here</span><div class="hb3-spot-main"><span class="hb3-spot-ic">' + svgPath(HB_CHART, 26) + '</span><div class="min0"><b class="display">Take the survey</b><span>Acts 1 to 5 tick themselves from it</span></div></div>' +
        '<button type="button" class="hb3-go" data-action="start-survey">Let\'s go ' + icon("arrowRight") + "</button></section>"
      : best
        ? '<section class="hb3-spot" aria-label="Your next best act"><span class="hb3-k">Your next best act</span><div class="hb3-spot-main"><span class="hb3-spot-ic" style="background:' + HB_COL[best.n] + '">' + svgPath(best.icon, 26) + '</span><div class="min0"><b class="display">' + esc(best.name) + "</b><span>" +
          (shows(best) ? "−" + kgFmt(best.save) + " kg a year to bank" : "Act " + best.n + " · ready when you are") + "</span></div></div>" +
          '<button type="button" class="hb3-go" data-action="hb-go" data-n="' + best.n + '">Let\'s do it ' + icon("arrowRight") + "</button></section>"
        : '<section class="hb3-spot" aria-label="All done"><span class="hb3-k">Forest level</span><div class="hb3-spot-main"><span class="hb3-spot-ic">' + svgPath(HB_STAR, 26) + '</span><div class="min0"><b class="display">All seven done</b><span>Keep measuring to keep your line falling</span></div></div></section>';

    // The party for newly banked acts.
    const party = fresh.length
      ? (() => {
          const top = fresh.slice().sort((x, y) => (y.n <= 4 ? 1 : 0) - (x.n <= 4 ? 1 : 0))[0];
          const conf = Array.from({ length: 22 }, (_, k) => '<i style="left:' + ((k * 37) % 100) + "%;--d:" + ((k % 9) * 0.06).toFixed(2) + "s;--x:" + (((k * 29) % 60) - 30) + "px;--r:" + ((k * 53) % 360) + "deg;background:" + ["#E8C88A", "#3F5B3A", "#B8653D", "#7FA3AE", "#D9A441", "#6F4E63"][k % 6] + '"></i>').join("");
          const others = fresh.filter((a) => a !== top).map((a) => HB_BADGE[a.n]);
          return (
            '<section class="hb3-party" role="status" aria-label="Badge unlocked: ' + esc(HB_BADGE[top.n]) + '"><span class="hb3-conf" aria-hidden="true">' + conf + "</span>" +
            '<span class="hb3-big-medal" aria-hidden="true"><i class="hb3-rays"></i><span>' + svgPath(top.icon, 40) + "</span></span>" +
            '<div class="hb3-party-t"><span class="hb3-k">Badge unlocked</span><b class="display">' + esc(HB_BADGE[top.n]) + "</b>" +
            "<span>Act " + top.n + " banked" + (others.length ? ", plus " + esc(others.join(", ")) : "") + ". You're level " + (lv + 1) + ", " + HB_LEVELS[lv][1] + ".</span></div>" +
            '<button type="button" class="hb3-go" data-action="hb-party-off">Nice!</button></section>'
          );
        })()
      : "";

    const order = [1, 2, 3, 4, 5, 6, 7];
    const badges =
      '<section class="hb3-badges" aria-labelledby="hb3-bh"><div class="hb3-bhead"><h2 id="hb3-bh" class="display">Badges</h2><span>' + (made + (made === 7 ? 1 : 0)) + " of 8</span></div><ul>" +
      order.map((n) => { const a = acts.find((x) => x.n === n); return '<li class="' + (a.done ? "got" : "") + '"><span>' + svgPath(a.icon, 22) + "</span><b>" + esc(HB_BADGE[n]) + "</b><small>" + (a.done ? "Unlocked" : "Act " + n) + "</small></li>"; }).join("") +
      '<li class="' + (made === 7 ? "got" : "") + '"><span>' + svgPath(HB_STAR, 22) + "</span><b>Seven strong</b><small>" + (made === 7 ? "Unlocked" : "All 7") + "</small></li></ul></section>";

    const hero = '<header class="hb-hero">' +
      '<div class="hb-top"><span class="hb-eyebrow">My Habits</span><a class="hb-rz" href="https://www.realzero.earth/7-acts" target="_blank" rel="noopener" aria-label="Real Zero, who made the 7 Acts (opens their site)"><span>The 7 Acts by</span><img src="/icons/realzero-56.png" srcset="/icons/realzero-56.png 1x, /icons/realzero.png 3x" width="141" height="22" alt="Real Zero" /></a></div>' +
      '<div class="hb3-lv">' + ring + '<div class="hb3-lvt"><span class="hb3-lvchip">Level ' + (lv + 1) + "</span>" +
      '<div class="hb3-name"><h1 class="display">' + HB_LEVELS[lv][1] + '<span class="sr-only">: ' + made + " done, " + (7 - made) + " to go.</span></h1>" + hbTree(HB_LEVELS[lv][1], "now", animate) + "</div>" +
      '<div class="hb3-xp gold" aria-hidden="true"><i style="--w:' + lvPct + '%"></i></div><span class="hb3-lvnext">' + (nextLv ? hbTree(nextLv[1], "next") : "") + toNextText + "</span></div></div>" +
      (ready && toSave >= 0.5 ? '<p class="hb-tosave"><b class="display tnum">−' + kgFmt(toSave) + "</b><span>kg a year still up for grabs in Acts 1 to 4</span></p>" : "") +
      '<p class="hb-lede">Real Zero\'s <b>7 Acts</b> are the changes that cut the most. ' + (ready ? "Acts 1 to 5 tick themselves from your survey." : "Take the survey and acts 1 to 5 tick themselves.") +
      ' <a class="hb-explain" href="https://www.realzero.earth/7-acts" target="_blank" rel="noopener">What are the 7 Acts?' + icon("link") + "</a></p>" +
      '<div class="hb-chips">' + (ready ? '<a class="hb-swlink" href="/greener-switches/"><span class="hb-sw-long">See your switches</span><span class="hb-sw-short">Switches</span> ' + icon("arrowRight") + "</a>" : '<a class="hb-swlink" href="#/" data-action="start-survey">Take the survey ' + icon("arrowRight") + "</a>") + "</div>" + "</header>";
    // On a phone: one short to-do list, and each act opens as a full-screen
    // sheet (pick one, then step by step how to do it).
    if (onPhoneScreen() && currentPath() === "/habits/level")
      return '<div class="container hb-page hb2 hb3 hbf-level">' + hero +
        '<p class="hbf-pass-k">Your passport: a stamp for each act you do</p>' + badges + "</div>";
    if (onPhoneScreen()) {
      hbSheetBuild = (fresh) => hbPhoneSheet({ acts, ready, inside, offerList, kgOf, cutOf, explain, stepOf, travelStep, banked, areaOf }, fresh);
      return hbPhonePage({ acts, ready, made, lv, nextLv, toSave, party, shows, state });
    }
    hbSheetBuild = null;
    const DAILY = [SW_ICONS.meals, SW_ICONS.water, HB_WALK];
    return (
      '<div class="container hb-page hb2 hb3' + (animate ? " hb-anim" : "") + '" data-fs-pill="' + made + "/7 · " + HB_LEVELS[lv][1] + '" data-fs-unit="">' +
      party + '<div class="hb3-top-row">' + hero + spot + "</div>" + sundayOffer(acts) +
      '<section class="hb-acts" aria-labelledby="hb3-ah"><div class="hb3-ahead"><h2 id="hb3-ah" class="display">The 7 Acts</h2><span>Tap one to start</span></div>' +
      '<ol class="hb-list hb3-grid">' + acts.map(row).join("") + "</ol></section>" + badges +
      '<section class="hb-soon" aria-labelledby="hb-daily"><span class="hb-soon-tag">Coming soon</span><p><b id="hb-daily" class="display">Daily habits</b> streaks for small daily things, like a meat-free lunch</p>' +
      '<span class="hb-soon-ics" aria-hidden="true">' + DAILY.map((d) => "<i>" + svgPath(d, 16) + "</i>").join("") + "</span></section>" +
      '<p class="xs muted hb-credit"><a class="hb-rz-foot" href="https://www.realzero.earth/7-acts" target="_blank" rel="noopener"><img src="/icons/realzero-56.png" width="115" height="18" alt="Real Zero" /></a>The 7 Acts are by Real Zero, used with their permission.</p></div>'
    );
  }
  // ---------- My Habits on a phone ----------
  let hbSheetBuild = null;
  const HBF_CAT = { 1: ["banking"], 2: ["energy"], 3: ["meals"], 4: ["commute", "flights"] };
  // Step by step, for each place we send you. [title, detail, the step with the link?]
  const hbHowTo = (k, l) => {
    const name = l.label.replace(/^The /, "");
    const L = l.label;
    if (k === "banking")
      return [
        ["Apply online with " + name, "About 15 minutes. Have photo ID and your addresses for the last 3 years ready.", 1],
        ["Choose to switch your account", "Say yes to the Current Account Switch Service and give your old bank's sort code and account number."],
        ["Pick a switch date", "Your salary, direct debits and standing orders all move across in 7 working days. It's free and guaranteed."],
        ["That's it", "Your old account closes on the switch date, and payments sent to it are passed on to " + name + "."],
      ];
    if (k === "energy")
      return [
        ["Find a recent bill", "You'll need your postcode and how much you use a year in kWh. It's on the bill or in your supplier's app."],
        ["Get a quote from " + name, "Pick their 100% renewable tariff.", 1],
        ["Sign up", "Give a meter reading on the day you switch, or a smart meter sends it for you."],
        [name + " does the rest", "They tell your old supplier. It takes about 5 working days and your power never goes off."],
      ];
    if (k === "meals" && L === "Fork Ranger")
      return [
        ["Open Fork Ranger", "Browse quick vegetarian recipes.", 1],
        ["Pick two or three for this week", "Start with meals you already like, made without meat."],
        ["Shop with its list", "It builds the shopping list for you."],
        ["Add a day each week", "One more plant-based day a week until it's just how you eat."],
      ];
    if (k === "meals")
      return [
        ["Choose a box from " + name, "A veg box or a plant-based recipe box.", 1],
        ["Pick a delivery day", "Every week or every other week. You can pause or skip any time."],
        ["Plan meals around what arrives", "Two or three plant-based dinners from each box is a good start."],
        ["Add a day each week", "One more plant-based day a week until it's just how you eat."],
      ];
    if (k === "commute" && l.when === "train")
      return [
        ["Search your commute on " + name, "Put in your home and work stations.", 1],
        ["Compare the cost", "Look at a season ticket or a flexi season against what driving costs you, parking included."],
        ["Try it one day a week", "See how the journey fits your day before you commit."],
        ["Make it your usual way in", "Once it works, swap more car days for the train."],
      ];
    if (k === "commute" && l.when === "ev")
      return [
        ["Check your employer offers " + name, "Ask HR or look on your staff benefits site.", 1],
        ["Choose an electric car", "Get a quote. The lease comes out of your salary before tax."],
        ["Sort out charging", "A home charger, or charging at work, before the car arrives."],
        ["Swap your old car for it", "Every mile you drive now runs on electricity."],
      ];
    if (k === "commute")
      return [
        ["Check your employer is signed up with " + name, "Ask HR if you're not sure.", 1],
        ["Choose a bike or e-bike", "From one of their partner shops, and get a quote."],
        ["Apply through work", "It's paid from your salary before tax, usually over 12 months, which saves you about a third or more."],
        ["Swap a car day for the bike", "Start with one day a week, then add more."],
      ];
    if (L === "Eurostar")
      return [
        ["Search your trip on Eurostar", "London to Paris, Brussels or Amsterdam.", 1],
        ["Book early", "The cheapest seats go first."],
        ["Leave time for checks", "Security and passports are done before you board, at St Pancras."],
        ["Carry on by train", "From Paris, Brussels or Amsterdam, trains go on across Europe."],
      ];
    if (L === "The Man in Seat 61")
      return [
        ["Find your destination on Seat 61", "It has a guide for almost everywhere.", 1],
        ["Follow its route", "It tells you which trains to take, and where to change."],
        ["Book each part where it says", "Often the train company's own site is cheapest."],
        ["Enjoy the journey", "Next time you'd fly, check Seat 61 first."],
      ];
    return [
      ["Search your trip on " + name, "Door to door, with the stations nearest to you.", 1],
      ["Compare it with flying", "Count the trip to the airport and getting there early."],
      ["Book ahead", "Advance tickets are usually the cheapest."],
      ["Check the train first next time", "For the UK and nearby Europe it's often as quick."],
    ];
  };

  // Checked by us (the MP letter, the invite link, the bill payer's confirmation), not just ticked.
  const hbVerified = (a) => !!a.done && (!!a.verifiedTick || /^Verified/.test(a.sub || ""));
  function hbPhonePage(o) {
    const { acts, ready, made, lv, nextLv, toSave, party, shows, state } = o;
    const toNext = nextLv ? nextLv[0] - made : 0;
    const tile = (a) => '<span class="hbf-ic" style="background:' + HB_COL[a.n] + '" aria-hidden="true">' + svgPath(a.icon, 22) + "</span>";
    const right = (a) =>
      a.done ? '<span class="hbf-r done">' + icon(hbVerified(a) ? "shield" : "check") + "<small>" + (hbVerified(a) ? "Verified" : "Done") + "</small></span>"
        : a.pending ? '<span class="hbf-r"><b>' + icon("clock") + "</b><small>Waiting</small></span>"
        : shows(a) ? '<span class="hbf-r"><b class="tnum">−' + kgFmt(a.save) + ' kg</b><small>a year</small></span>'
        : a.n === 6 ? '<span class="hbf-r"><b>1 letter</b><small>to your MP</small></span>'
        : a.n === 7 && ui.actsInfo ? '<span class="hbf-r"><b class="tnum">' + Math.min(7, ui.actsInfo.finished || 0) + ' of 7</b><small>friends joined</small></span>'
        : '<span class="hbf-r"><small>' + (ready || a.n > 5 ? "Ready" : "Survey first") + "</small></span>";
    const row = (a, next) =>
      '<li><button type="button" class="hbf-row ' + state(a) + (a.pending ? " pending" : "") + '" data-action="hb-open" data-n="' + a.n + '">' + tile(a) +
      '<span class="min0 hbf-t">' + (next ? '<span class="hbf-next">Next</span>' : "") + '<b class="display">' + esc(a.name) + "</b>" +
      (hbVerified(a) || a.pending ? '<small class="hbf-sub' + (a.pending ? " wait" : "") + '">' + esc(String(a.sub).replace(/^Verified · /, "").replace(/ · this ticks once it arrives$/, "")) + "</small>" : "") + "</span>" +
      right(a) + '<span class="hbf-chev" aria-hidden="true">' + icon("chevronRight") + "</span></button></li>";
    const todo = acts.filter((a) => !a.done);
    const done = acts.filter((a) => a.done);
    const nextOne = todo.find((a) => !a.pending);
    const ringDeg = Math.round((made / 7) * 360);
    return (
      '<div class="container hb-page hbf" data-fs-pill="' + made + "/7 · " + HB_LEVELS[lv][1] + '" data-fs-unit="">' + party +
      '<a class="hbf-strip" href="#/habits/level" aria-label="Your level and badges"><span class="hbf-ring" style="--p:' + ringDeg + 'deg" aria-hidden="true"><b class="tnum">' + made + "<small>/7</small></b></span>" +
      '<div class="min0 hbf-lv"><h1 class="display">' + HB_LEVELS[lv][1] + '<span class="sr-only">: ' + made + " of 7 acts done</span></h1><span>Level " + (lv + 1) + " · " + (nextLv ? toNext + " to " + nextLv[1] : "Top level") + "</span></div>" +
      (ready && toSave >= 0.5 ? '<div class="hbf-togo"><b class="display tnum">−' + kgFmt(toSave) + "</b><span>kg a year to go</span></div>" : "") + '<span class="hbf-strip-go" aria-hidden="true">' + icon("chevronRight") + "</span></a>" +
      sundayOffer(acts) +
      (ready ? "" : '<button type="button" class="hbf-start" data-action="start-survey"><b class="display">Take the survey first</b><span>Acts 1 to 5 tick themselves from it</span>' + icon("arrowRight") + "</button>") +
      (todo.length
        ? '<section class="hbf-sec" aria-labelledby="hbf-todo"><div class="hbf-h"><h2 id="hbf-todo" class="display">To do</h2><span>' + todo.length + ' left</span></div><ul class="hbf-list">' + todo.map((a) => row(a, a === nextOne)).join("") + "</ul></section>"
        : '<section class="hbf-all"><b class="display">All seven done</b><span>Keep measuring to keep your line falling.</span></section>') +
      (done.length ? '<details class="hbf-done"' + (ui.hbDoneOpen ? " open" : "") + '><summary class="display">Done (' + done.length + ")" + (done.some(hbVerified) ? '<span class="hbf-vcount">' + icon("shield") + done.filter(hbVerified).length + " verified</span>" : "") + icon("chevronRight") + '</summary><ul class="hbf-list">' + done.map((a) => row(a)).join("") + "</ul></details>" : "") +
      '<div class="hbf-credit"><a class="hb-rz-foot" href="https://www.realzero.earth/7-acts" target="_blank" rel="noopener"><img src="/icons/realzero-56.png" width="115" height="18" alt="Real Zero" /></a>' +
      '<p class="hb-lede xs muted">The 7 Acts are by Real Zero, used with their permission. <a class="hb-explain" href="https://www.realzero.earth/7-acts" target="_blank" rel="noopener">What are the 7 Acts?' + icon("link") + "</a></p></div></div>"
    );
  }

  // Act 4 as a little flow chart: green commute and green one-off trips,
  // joined by a line to green travel, which lights up once both are done.
  function travelFlow(areas, branch, ready) {
    const node = (k, title, ic) => {
      const ar = areas[k] || {}, done = ready && !!ar.done;
      const sub = done ? icon("check") + "Done" : ready && ar.save >= 0.5 ? "−" + kgFmt(ar.save) + " kg a year" : ready ? "Not yet" : "Survey first";
      return '<button type="button" class="tf-node' + (done ? " done" : "") + (branch === k ? " on" : "") + '"' + (branch !== undefined ? ' data-action="hb-branch" data-k="' + k + '" aria-pressed="' + (branch === k) + '"' : "") + ">" +
        '<span class="tf-ic" aria-hidden="true">' + svgPath(ic, 18) + "</span>" +
        '<b class="display">' + title + '</b><span class="tf-sub">' + sub + "</span></button>";
    };
    const both = ready && areas.commute && areas.flights && areas.commute.done && areas.flights.done;
    return (
      '<div class="tf" role="group" aria-label="Green travel: your commute and one-off trips">' +
      '<div class="tf-top">' + node("commute", "Green commute", SW_ICONS.commute) + node("flights", "Green one-off trips", SW_ICONS.flights) + "</div>" +
      '<div class="tf-lines' + (ready && areas.commute && areas.commute.done ? " c" : "") + (ready && areas.flights && areas.flights.done ? " f" : "") + (both ? " full" : "") + '" aria-hidden="true"><i class="l"></i><i class="r"></i><i class="m"></i></div>' +
      '<div class="tf-main' + (both ? " done" : "") + '"><span class="tf-ic" aria-hidden="true">' + svgPath(HB_TRAIN, 18) + (both ? '<span class="tf-tick">' + icon("check") + "</span>" : "") + '</span><span class="min0"><b class="display">Green travel</b><span class="tf-sub">' +
      (both ? "Done · both halves are green" : "Unlocks when both are done") + "</span></span></div></div>"
    );
  }

  function hbPhoneSheet(o, fresh) {
    const { acts, ready, inside, offerList, kgOf, cutOf, explain, stepOf, banked, areaOf } = o;
    const st = ui.hbSheet;
    const a = acts.find((x) => x.n === st.n);
    if (!a) return "";
    // Act 4 has two halves: your commute, and one-off trips.
    let flow = "", branch = null;
    if (a.n === 4) {
      const c = areaOf("commute") || {}, f = areaOf("flights") || {};
      branch = st.branch || (ready && c.done && !f.done ? "flights" : "commute");
      st.branch = branch;
      flow = travelFlow({ commute: c, flights: f }, branch, ready);
    }
    const keys = !a.energy && (branch ? [branch] : HBF_CAT[a.n]);
    const list = keys ? offerList(keys) : [];
    const pick = st.stage === "how" ? list[st.i] : null;
    const close = '<button type="button" class="sheet-close modal-close" data-action="close-modal" aria-label="Close">' + icon("x") + "</button>";
    let head, body, foot = "";
    if (a.energy) {
      const asking = st.stage === "ask" && !energyVerified();
      const now = kgOf(["energy"]), cut = cutOf(["energy"]), after = Math.max(0, now - cut);
      const pct = now ? Math.round((cut / now) * 100) : 0;
      const status = a.sub && (a.pending || a.done) ? '<p class="hbf-status' + (a.done ? " done" : a.pending ? " wait" : "") + '">' + icon(a.done ? "check" : a.pending ? "clock" : "info") + "<span>" + esc(a.sub) + "</span></p>" : "";
      if (asking) {
        const who = askWho() === "home" ? "them" : "your landlord";
        head = '<div class="hbf-shead"><button type="button" class="hbf-back" data-action="hb-sheet-back">' + icon("chevronLeft") + "Back</button>" + close + "</div>";
        const sent = !!actsTicked().energyAsked || !!energyVerified(), conf = !!energyVerified();
        const step = (t, d, extra, done) => '<li' + (done ? ' class="done"' : "") + '><span class="hbf-sn display"></span><div class="min0"><b class="display">' + t + "</b><p>" + d + "</p>" + (extra || "") + "</div></li>";
        body =
          '<div class="hbf-prov"><span class="hbf-ic" style="background:' + HB_COL[2] + '" aria-hidden="true">' + svgPath(a.icon, 22) + '</span><div class="min0"><span class="hbf-k">Act 2 of 7 · Move your energy</span><h2 id="sheet-title" class="display">How to ask ' + who + "</h2></div></div>" +
          '<ol class="hbf-steps numbered">' +
          step("Send them our message", "It has your home's numbers in it" + (ui.energyToken ? ", and a link for them to tap once they've switched." : "."), energyAskTiles(), sent) +
          step("They switch online", "About 10 minutes with Good Energy, Ecotricity or Octopus Energy. The power never goes off.", "", conf) +
          step("They tap the link in your message", "It tells us they've switched. They don't need an account.", "", conf) +
          step("It ticks itself", "Act 2 is verified, then you update your survey so your results show it.", "", !!a.done) +
          "</ol>";
        foot = a.pending ? '<div class="hbf-foot"><p>' + icon("clock") + " Asked · waiting for them to confirm they've switched</p></div>" : "";
      } else {
        head =
          '<div class="hbf-shead"><span class="hbf-ic" style="background:' + HB_COL[a.n] + '" aria-hidden="true">' + svgPath(a.icon, 22) + '</span><div class="min0"><span class="hbf-k">Act 2 of 7</span><h2 id="sheet-title" class="display">' + esc(a.name) + "</h2></div>" + close + "</div>";
        body =
          '<p class="hbf-why">' + esc(HB_WHY[2]) + "</p>" + status +
          (ready && now >= 0.5 && cut >= 0.5
            ? '<div class="hbf-line"><span><span class="tnum">' + kgFmt(now) + "</span> → <b class=\"tnum\">" + kgFmt(after) + '</b> kg a year</span><b class="display tnum">−' + pct + '%</b><i style="--w:' + Math.max(4, 100 - pct) + '%"></i></div>' : "") +
          '<section class="hbf-act" aria-labelledby="hbf-ask-h"><span class="hbf-k">Your act</span><h3 id="hbf-ask-h" class="display">Ask them to switch</h3>' +
          (energyVerified()
            ? '<div class="hb2 hb3">' + energyAskBox() + "</div>"
            : '<p class="sm">Someone else chooses your supplier, so your part is asking them. Who is it?</p><ul class="hbf-opts">' +
              [["landlord", "My landlord", "We'll write it for a landlord, about the property"], ["home", "Someone at home", "A friendly message to whoever pays the bills"]].map(([k, l, d]) =>
                '<li><button type="button" class="hbf-opt" data-action="hb-ask" data-who="' + k + '"><span class="hbf-ic" style="background:' + HB_COL[2] + '" aria-hidden="true">' + svgPath(k === "home" ? SW_ICONS.motivate : SW_ICONS.energy, 20) + '</span><span class="min0"><b class="display">' + l + "</b><span>" + d + "</span></span>" + icon("chevronRight") + "</button></li>").join("") + "</ul>") +
          "</section>" +
          '<div class="hbf-more">' + explain([["energy", "Explain more"]]) + "</div>";
      }
    } else if (pick) {
      const { k, l } = pick;
      const name = l.label.replace(/^The /, "");
      const verb = k === "banking" || k === "energy" ? "switch to " + name : "get started with " + name;
      head = '<div class="hbf-shead"><button type="button" class="hbf-back" data-action="hb-sheet-back">' + icon("chevronLeft") + "Back</button>" + close + "</div>";
      body =
        '<div class="hbf-prov"><span class="display sw-mono">' + esc(monogramText(l.label)) + '</span><div class="min0"><span class="hbf-k">Act ' + a.n + " of 7 · " + esc(a.name) + '</span><h2 id="sheet-title" class="display">How to ' + esc(verb) + "</h2></div></div>" +
        '<ol class="hbf-steps">' +
        hbHowTo(k, l).map((s, i) =>
          '<li><span class="hbf-sn display">' + (i + 1) + '</span><div class="min0"><b class="display">' + esc(s[0]) + "</b><p>" + esc(s[1]) + "</p>" +
          (s[2] ? '<a class="btn btn-green btn-sm hbf-open" ' + linkAttrs(k, l, "habits") + ">Open " + esc(name) + " " + icon("link") + "</a>" : "") + "</div></li>").join("") +
        "</ol>" +
        (l.ref ? '<p class="xs muted">This is a referral link: if you switch, CO2 Counter may get a reward at no cost to you.</p>' : "");
      const won = banked(a, k);
      foot = won
        ? '<div class="hbf-foot"><p>Done it? This opens that question in your survey so it counts.</p>' + won.replace("I've switched · update my survey", "I've switched").replace('class="hb3-win-btn"', 'class="hb3-win-btn hbf-cta"') + "</div>"
        : !ready ? '<div class="hbf-foot"><button type="button" class="btn btn-green hbf-cta" data-action="start-survey">Take the survey first ' + icon("arrowRight") + "</button></div>" : "";
    } else {
      head =
        '<div class="hbf-shead"><span class="hbf-ic" style="background:' + HB_COL[a.n] + '" aria-hidden="true">' + svgPath(a.icon, 22) + '</span><div class="min0"><span class="hbf-k">Act ' + a.n + ' of 7</span><h2 id="sheet-title" class="display">' + esc(a.name) + "</h2></div>" + close + "</div>";
      if (keys && (list.length || branch)) {
        const now = kgOf(keys), cut = cutOf(keys), after = Math.max(0, now - cut);
        const pct = now ? Math.round((cut / now) * 100) : 0;
        const bArea = branch ? areaOf(branch) || {} : null;
        const lead = a.n === 1 ? "Switch to one of these banks" : a.n === 2 ? "Switch to a renewable supplier" : a.n === 3 ? "Try one of these" : branch === "flights" ? "Go by train instead" : "Make your commute greener";
        const cats = branch ? [[branch, "Explain more"]] : [[keys[0], "Explain more"]];
        body =
          '<p class="hbf-why">' + esc(HB_WHY[a.n]) + "</p>" + flow +
          (branch
            ? ready && bArea.done ? '<p class="hbf-donenote">' + icon("check") + esc(bArea.doneTitle || "Done") + "</p>" : ""
            : a.done ? '<p class="hbf-donenote">' + icon("check") + esc(a.sub) + "</p>" : "") +
          (ready && now >= 0.5 && cut >= 0.5
            ? '<div class="hbf-line"><span><span class="tnum">' + kgFmt(now) + "</span> → <b class=\"tnum\">" + kgFmt(after) + '</b> kg a year</span><b class="display tnum">−' + pct + '%</b><i style="--w:' + Math.max(4, 100 - pct) + '%"></i></div>' : "") +
          (list.length ? '<h3 class="display hbf-lead">' + lead + "</h3>" : "") + '<ul class="hbf-opts">' +
          list.map(({ l }, i) =>
            '<li><button type="button" class="hbf-opt" data-action="hb-pick" data-i="' + i + '"><span class="display sw-mono">' + esc(monogramText(l.label)) + '</span><span class="min0"><b class="display">' + esc(l.label) + "</b><span>" + esc(l.note) + "</span></span>" + icon("chevronRight") + "</button></li>").join("") +
          "</ul>" + (a.n === 1 ? '<p class="xs muted">Chosen using the bank league table.</p>' : "") +
          '<div class="hbf-more">' + explain(cats) + "</div>";
      } else body = '<div class="hb2 hb3 hbf-inside" style="--c:' + HB_COL[a.n] + '">' + (a.sub ? '<p class="hbf-status' + (a.done ? " done" : a.pending ? " wait" : "") + '">' + icon(a.done ? "check" : a.pending ? "clock" : "info") + "<span>" + esc(a.sub) + "</span></p>" : "") + inside(a) + "</div>";
    }
    return (
      '<div class="modal-backdrop sheet-backdrop hbf-bd" data-action="close-modal"><div class="sheet hbf-sheet' + (fresh === true ? "" : " hbf-still") + '" role="dialog" aria-modal="true" aria-labelledby="sheet-title">' +
      '<div class="sheet-body hbf-body' + (fresh === "fwd" ? " hbf-fwd" : fresh === "back" ? " hbf-bk" : "") + '" id="hb-act-' + a.n + '">' + head + body + "</div>" + foot + "</div></div>"
    );
  }
  // Draws the open act's sheet. fresh: true (slides up), "fwd"/"back" (a new page), or false (a redraw).
  function paintHbSheet(fresh) {
    if (!hbSheetBuild || !ui.hbSheet) return;
    const bd = modalRoot.querySelector(".hbf-bd");
    const y = bd && !fresh ? bd.scrollTop : 0;
    modalRoot.innerHTML = glyphify(fillTokens(hbSheetBuild(fresh)));
    document.body.classList.add("modal-open");
    const nb = modalRoot.querySelector(".hbf-bd");
    if (nb) nb.scrollTop = y;
  }
  const ACT_SHORT = { 1: "Money", 2: "Energy", 3: "Food", 4: "Travel", 5: "Measure", 6: "Your MP", 7: "Invite 7" };
  const HB_TRAIN = "M6 4h12a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a2 2 0 0 1 2-2ZM4 11h16M8 21l2-3M16 21l-2-3M8.5 14.5v.01M15.5 14.5v.01";
  const HB_CHART = "M4 20V10M10 20V4M16 20v-7M2 20h20";
  const HB_VOTE = "M4 13h16v7H4zM8 13V5h8v8M10.5 8.5l1.5 1.5 3-3";
  const HB_WALK = "M13 4.5a1.5 1.5 0 1 0 0-.1M10 21l2-6 3 3v3M9 12l3-4 3 2 3 1M12 8l-2 5";

  function openSectionDialog(cat, index) {
    const ex = D.EXPLAINERS[cat];
    if (!ex) return;
    const diet = cat === "meals" ? D.DIET_EXPLAINERS[dietType(survey)] : null;
    const sections = (diet && diet.sections) || ex.sections;
    const habits = (diet && diet.habits) || ex.habits;
    const s = sections[index];
    if (!s) return;
    const shown = sections.map((x, i) => ({ x, i })).filter(({ x }) => !(diet && sectionDone(cat, x)) && !sectionHidden(cat, x));
    const pos = Math.max(0, shown.findIndex((o) => o.i === index));
    const prev = shown[(pos + shown.length - 1) % shown.length];
    const next = shown[(pos + 1) % shown.length];

    let body;
    if (s.dynamicKey === "flightTiers") body = tiersSheet();
    else if (s.dynamicKey === "trainComparison") body = trainSheet();
    else if (s.dynamicKey === "cabinComparison") body = cabinSheet();
    else if (s.dynamicKey === "commuteSwap") body = commuteSheet();
    else if (s.dynamicKey === "ifDriving") body = vehicleSheet();
    else if (s.dynamicKey === "bankLeague") body = bankSheet();
    else if (s.dynamicKey === "switchAccount") body = switchSheet();
    else if (s.dynamicKey === "savingsPensions") body = pensionSheet();
    else if (s.dynamicKey === "greenTariff") body = greenTariffSheet();
    else if (s.dynamicKey === "cheeseDairy") body = cheeseSheet();
    else body = "";
    // The biggest step carries the guide: comparison (unless the step has
    // its own), what the saving looks like, and how to do it.
    if (index === guideIndex(cat) && !sectionNA(cat, s)) body += guideSheet(cat, !s.dynamicKey || cat === "banking");

    modalRoot.innerHTML = glyphify(fillTokens(
      '<div class="modal-backdrop sheet-backdrop" data-action="close-modal"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">' +
        (shown.length > 1
          ? '<div class="sheet-tabs" role="tablist" aria-label="' + esc(ex.title) + ' next steps">' +
            shown.map(({ x, i }) => '<button type="button" role="tab" aria-selected="' + (i === index) + '" class="' + (i === index ? "on" : "") + '" data-action="open-section" data-index="' + i + '">' + esc(x.heading) + "</button>").join("") +
            "</div>"
          : "") +
        '<div class="sheet-body"><div class="sheet-head"><span class="cat-badge sheet-icon">' + ex.icon + '</span><div class="min0"><h2 id="sheet-title" class="display">' + esc(s.heading) + "</h2>" +
        (habits[index] ? '<p class="sheet-habit">Pairs with habit: ' + esc(habits[index].label) + "</p>" : "") + "</div>" +
        '<button type="button" class="sheet-close modal-close" data-action="close-modal" aria-label="Close">' + icon("x") + "</button></div>" +
        '<p class="sheet-lede">' + esc(s.body) + "</p>" + body +
        (shown.length > 1
          ? '<div class="sheet-nav"><button type="button" class="btn btn-outline" data-action="open-section" data-index="' + prev.i + '">' + icon("chevronLeft") + " " + esc(prev.x.heading) + "</button>" +
            '<button type="button" class="btn btn-outline" data-action="open-section" data-index="' + next.i + '">' + esc(next.x.heading) + " " + icon("chevronRight") + "</button></div>"
          : "") +
        "</div></div></div>"
    ));
    document.body.classList.add("modal-open");
    const backdrop = modalRoot.querySelector(".sheet-backdrop");
    if (backdrop) backdrop.scrollTop = 0;
    // Keep the open step's tab in view in the sideways-scrolling strip.
    const tab = modalRoot.querySelector(".sheet-tabs .on");
    if (tab) tab.parentNode.scrollLeft = tab.offsetLeft - 16;
  }

  // ---------- pop-up sheets (Glass v2) ----------

  const sheetBar = (label, value, max, colour, extra) =>
    '<li class="sbar' + (extra && extra.mine ? " mine" : "") + '"><span class="sbar-label">' + label + "</span>" +
    '<span class="sbar-track"><span style="width:' + Math.min(100, Math.max(value > 0 ? 1.5 : 0.8, (value / Math.max(max, 1e-9)) * 100)).toFixed(1) + "%;background:" + colour + '"></span></span>' +
    '<span class="sbar-val display tnum">' + (extra && extra.text != null ? extra.text : kgFmt(value)) + "</span></li>";
  const chipBig = (text) => '<span class="sheet-chip display">' + text + "</span>";
  const panel = (label, inner, chip) =>
    '<section class="sheet-panel"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><span class="eyebrow">' + label + "</span>" + (chip || "") + "</div>" + inner + "</section>";
  const tiles = (list) =>
    '<div class="sheet-tiles">' + list.map(([n, t, cls]) => '<div class="sheet-tile' + (cls ? " " + cls : "") + '"><b class="display tnum">' + n + "</b><span>" + t + "</span></div>").join("") + "</div>";

  function tiersSheet() {
    const mine = flightTier(survey).tier;
    const totals = flightTotals(survey);
    const heights = [70, 105, 145, 185];
    const colours = ["rgba(143,165,138,.3)", "rgba(143,165,138,.3)", "rgba(217,164,65,.35)", "rgba(184,101,61,.4)"];
    const stairs =
      '<div class="stairs">' +
      D.FLIGHT_TIERS.map(
        (t, j) =>
          '<div class="stair-col">' + (t.tier === mine ? '<span class="you-here display">You are here</span>' : "") +
          '<div class="stair' + (t.tier === mine ? " mine" : "") + '" style="height:' + heights[j] + "px;background:" + (t.tier === mine ? "var(--em-600)" : colours[j]) + ";animation-delay:" + j * 0.1 + 's"><span class="display">' + t.label + "</span>" +
          '<span class="stair-planes">' + icon("plane").repeat([0, 2, 4, 6][j]) + "</span></div></div>"
      ).join("") +
      '</div><div class="stair-notes">' + D.FLIGHT_TIERS.map((t) => "<div><b>" + esc(t.criteria) + "</b><br><span>" + esc(t.description) + "</span></div>").join("") + "</div>";
    let html = panel("How often you fly", stairs);
    if (totals.items.length) {
      html += panel(
        "Your flights",
        '<ul class="sbars">' +
          totals.items
            .map((f) => sheetBar(esc(f.label) + (f.co2 > D.BUDGET_YEARLY ? ' <span class="over-tag">' + (f.co2 / D.BUDGET_YEARLY).toFixed(1) + "× your budget</span>" : ""), f.co2, D.BUDGET_YEARLY, "var(--clay)", { text: kgFmt(f.co2) + " kg" }))
            .join("") +
          '</ul><p class="xs muted mt-2">Bar length against your yearly 1.5°C budget of 2,500 kg.</p>'
      );
      const eq = equivalents(totals.total);
      html += tiles([
        [Math.round(totals.pctOfTarget) + "%", "of your yearly 1.5°C budget", "clay"],
        [kgFmt(eq.trees), "trees to soak it up for a year"],
        [kgFmt(eq.phones), "new phones made and charged"],
        [kgFmt(eq.drivingKm), "km driven in a petrol car"],
      ]);
      html += '<p class="sheet-close-line display">One less flight a year, however many you take, is a real step in the right direction.</p>';
    } else {
      html += '<p class="sheet-close-line display">No flights this year: you\'re in the lowest tier. Nice.</p>';
    }
    return html;
  }

  function trainSheet() {
    const ratio = A.PARIS_TRAIN_KG / A.PARIS_FLIGHT_KG;
    const trips = (survey.flights || []).filter((f) => {
      const km = flightKm(f.from, f.to);
      return km > 0 && km < A.TRAIN_SWAP_MAX_KM;
    });
    const routes = [{ label: "London → Paris, return", plane: A.PARIS_FLIGHT_KG, train: A.PARIS_TRAIN_KG, note: "Eurostar's independently commissioned figures." }].concat(
      trips.map((f) => ({ label: "Your trip: " + routeLabel(f), plane: flightKg(f), train: flightKg(f) * ratio, note: "Train estimated at the same ratio as London–Paris." }))
    );
    const max = Math.max(...routes.map((r) => r.plane));
    let html = panel(
      "Plane or train, per person",
      routes
        .map(
          (r) =>
            '<div class="route"><p class="display route-label">' + esc(r.label) + '</p><ul class="sbars">' +
            sheetBar(icon("plane") + " Plane", r.plane, max, "var(--clay)", { text: kgFmt(r.plane) + " kg" }) +
            sheetBar("🚆 Train", r.train, max, "var(--em-600)", { text: (r.train < 10 ? r.train.toFixed(1) : kgFmt(r.train)) + " kg" }) +
            '</ul><p class="xs muted">' + esc(r.note) + "</p></div>"
        )
        .join(""),
      chipBig(Math.round((1 - ratio) * 100) + "% less by train")
    );
    const saving = trips.reduce((t, f) => t + flightKg(f) * (1 - ratio), 0);
    const beefDay = factorOf(D.MEAL_OPTIONS, "beef");
    html += tiles(
      (saving > 0.5
        ? [
            ["−" + kgFmt(saving) + " kg", trips.length === 1 ? "if your trip went by train" : "if your short trips went by train", "lead"],
            [kgFmt(equivalents(saving).trees) + " trees", "that's how much it would save"],
          ]
        : [["−" + kgFmt(A.PARIS_FLIGHT_KG - A.PARIS_TRAIN_KG) + " kg", "London–Paris return by train instead", "lead"]]
      ).concat([[A.PARIS_TRAIN_KG < beefDay ? "Less than a beef day" : kgFmt(A.PARIS_TRAIN_KG) + " kg", "London–Paris return by train, vs a day of beef meals (" + beefDay.toFixed(1) + " kg)"]])
    );
    if (!trips.length) html += '<p class="xs muted mt-2">None of your flights are under 4,000 km, so there\'s no train swap to show for them.</p>';
    return html;
  }

  function cabinSheet() {
    const flights = (survey.flights || []).filter((f) => flightKm(f.from, f.to) > 0);
    const econ = byKey(D.CABINS, "economy");
    const longX = D.CABINS.map((c, j) => [
      j === 0 ? "1×" : (c.long / econ.long).toFixed(1).replace(/\.0$/, "") + "×",
      c.label.replace(" class", "").replace(" economy", ""),
      ["var(--em-600)", "#4a6b45", "#8a6420", "#8a4424"][j],
      ["rgba(63,91,58,.12)", "rgba(143,165,138,.2)", "rgba(217,164,65,.2)", "rgba(184,101,61,.16)"][j],
    ]);
    const longHtml =
      '<div class="cabin-x">' + longX.map(([x, l, ink, bg]) => '<div style="background:' + bg + '"><b class="display" style="color:' + ink + '">' + x + "</b><span>" + esc(l) + "</span></div>").join("") + "</div>" +
      '<p class="sm mt-3">Direct routes help too: take-off and landing burn the most fuel, so fewer legs mean fewer emissions.</p>';
    if (!flights.length) return panel("On long-haul, by seat", longHtml) + '<p class="xs muted mt-2">You haven\'t added any flights. If you do fly, economy is always the lowest-carbon seat.</p>';
    const kgFor = (key) => flights.reduce((t, f) => t + flightKm(f.from, f.to) * flightFactor(f.from, f.to, key) * legs(f) * (f.trips || 1), 0);
    const rows = D.CABINS.map((c) => ({ c, kg: kgFor(c.key) }));
    const max = Math.max(...rows.map((r) => r.kg), 1);
    const cabinsUsed = [...new Set(flights.map((f) => f.cabin || "economy"))];
    const mineKey = cabinsUsed.length === 1 ? cabinsUsed[0] : null;
    const colours = ["var(--em-600)", "#8fa58a", "var(--honey)", "var(--clay)"];
    const bus = rows.find((r) => r.c.key === "business").kg / Math.max(rows[0].kg, 1e-9);
    const title = flights.length === 1 ? "Your " + routeLabel(flights[0]).replace(/^.*[→⇄] ?/, "") + " trip, by seat" : "Your " + flights.length + " flights, by seat";
    return (
      panel(
        title,
        '<ul class="sbars">' +
          rows.map((r, j) => sheetBar(esc(r.c.label) + (r.c.key === mineKey ? ' <span class="tag done-tag">Yours</span>' : ""), r.kg, max, colours[j], { text: kgFmt(r.kg) + " kg", mine: r.c.key === mineKey })).join("") +
          '</ul><p class="xs muted mt-2">DESNZ 2026 flight factors. Short-haul has no premium economy or first class in DESNZ, so those use economy and business.</p>',
        chipBig("Business = " + bus.toFixed(1).replace(/\.0$/, "") + "× economy")
      ) + panel("On long-haul the gap grows", longHtml)
    );
  }

  function commuteSheet() {
    const c = survey.commute || {};
    const km = Number(c.distance) || 0;
    const days = carDaysOf(survey);
    const n = days.length;
    if (!n || !km) return '<p class="sm">Add your commute distance and the days you drive in the survey to see your options.</p>';
    const W = D.WEEKS_PER_YEAR;
    const perDay = (mode) => factorOf(D.COMMUTE_MODES, mode) * km * 2;
    const carKey = c[days[0]];
    const car = byKey(D.COMMUTE_MODES, carKey);
    const year = (mode) => perDay(mode) * n * W;
    const modes = [
      [car.label + " (yours)", year(carKey), "var(--clay)"],
      ["Bus", year("bus"), "var(--honey)"],
      ["Electric car", year("ev"), "#8fa58a"],
      ["Train", year("train"), "#6e8b5e"],
      [km <= A.ACTIVE_TRAVEL_MAX_KM ? "Walk or bike" : "Walk or bike (far at " + km + " km)", 0, "var(--em-600)"],
      ["Work from home", 0, "var(--em-600)"],
    ].filter((m) => m[0] !== "Electric car" || carKey !== "ev");
    const max = Math.max(...modes.map((m) => m[1]), 1);
    const carDayKg = days.map((d) => perDay(c[d])).sort((x, y) => y - x);
    const swap = (k) => carDayKg.slice(0, k).reduce((t, kg) => t + kg - perDay("train"), 0) * W;
    return (
      panel(
        "Your " + n + " driving " + (n === 1 ? "day" : "days") + ", for a year",
        '<ul class="sbars">' + modes.map(([l, v, col]) => sheetBar(esc(l), v, max, col, { text: kgFmt(v) + " kg" })).join("") + "</ul>" +
          '<p class="xs muted mt-2">' + km + " km each way, there and back, DESNZ 2026 factors.</p>",
        chipBig("Train saves " + kgFmt(year(carKey) - year("train")) + " kg")
      ) +
      panel(
        "Swap some days to the train",
        '<div class="swap-tiles">' +
          Array.from({ length: n }, (_, i) => i + 1)
            .map((k) => '<div style="--a:' + (0.12 + (k / n) * 0.8).toFixed(2) + '" class="' + (k / n > 0.55 ? "dark" : "") + '"><span>' + k + (k === 1 ? " day" : " days") + ' a week</span><b class="display tnum">−' + kgFmt(swap(k)) + " kg</b><small>a year</small></div>")
            .join("") +
          "</div>"
      ) +
      '<p class="xs muted mt-3">' + nightNote + "</p>"
    );
  }

  // "If you must drive": what changing the vehicle saves, and the
  // salary-sacrifice schemes that make a bike or an electric car cheaper.
  function vehicleSheet() {
    const c = survey.commute || {};
    const km = Number(c.distance) || 0;
    const days = carDaysOf(survey);
    const n = days.length;
    const links = D.USEFUL_LINKS.commute.items.filter((l) => l.topic === "vehicle" && linkFits("commute", l, survey));
    let html = "";
    if (n && km) {
      const W = D.WEEKS_PER_YEAR;
      const yearOf = (mode) => factorOf(D.COMMUTE_MODES, mode) * km * 2 * n * W;
      const carKey = c[days[0]];
      const car = byKey(D.COMMUTE_MODES, carKey);
      const rows = [[car.label + " (yours)", yearOf(carKey), "var(--clay)"]]
        .concat(carKey === "ev" ? [] : [["Electric car", yearOf("ev"), "#8fa58a"]])
        .concat([["Bike or e-bike", 0, "var(--em-600)"]]);
      const max = Math.max(1, ...rows.map((r) => r[1]));
      html += panel(
        "Your " + n + " driving " + (n === 1 ? "day" : "days") + " a week, for a year",
        '<ul class="sbars">' + rows.map(([l, v, col]) => sheetBar(esc(l), v, max, col, { text: kgFmt(v) + " kg" })).join("") + "</ul>" +
          '<p class="xs muted mt-2">' + km + " km each way, there and back. An e-bike's charging is close to zero by comparison.</p>",
        carKey === "ev" ? "" : chipBig("Electric saves " + kgFmt(yearOf(carKey) - yearOf("ev")) + " kg")
      );
    }
    // Only the schemes that suit the answers: cycling for short commutes,
    // an electric car for people who drive petrol or diesel.
    const fits = (when) => D.USEFUL_LINKS.commute.items.some((l) => l.when === when && linkFits("commute", l, survey));
    const schemes = [
      fits("cycle") ? '<section class="sheet-panel"><span class="eyebrow">Cycle to Work</span><p class="sm mt-2">Most employers, including the NHS, offer a Cycle to Work scheme: a bike or e-bike and safety kit, paid from your salary before tax and National Insurance, so it costs noticeably less. Ask HR or check your staff benefits site.</p></section>' : "",
      fits("ev") ? '<section class="sheet-panel"><span class="eyebrow">Salary-sacrifice electric car</span><p class="sm mt-2">Many employers, including NHS trusts, let you lease an electric car from your salary before tax. Electric cars have a low benefit-in-kind tax, so it\'s often cheaper than leasing one yourself. Check what your employer offers.</p></section>' : "",
    ].filter(Boolean);
    if (!links.length) return html + '<p class="xs muted mt-3">' + nightNote + "</p>";
    html +=
      (schemes.length ? '<div class="sheet-two">' + schemes.join("") + "</div>" : "") +
      panel("Schemes to look at", '<div class="chip-links">' + links.map((l) => '<a class="chip-link" ' + linkAttrs("commute", l, "popup") + ">" + monogram(l) + esc(l.label) + (l.ref ? '<span class="affiliate-dot">Affiliate</span>' : "") + "</a>").join("") + "</div>" +
        '<p class="xs muted mt-2">Your employer has to offer the scheme, and some use a particular provider. Independent suggestions; we don\'t get paid for these links.</p>') +
      '<p class="xs muted mt-3">' + nightNote + "</p>";
    return html;
  }

  // For people who don't choose their supplier: a message to whoever does,
  // with the whole home's saving, by email (their own app) or copied.
  const asksBillPayer = (s) => !!s && s.energy && s.energy.billPayer === "other" && !s.energy.greenTariff;
  // The sign-off: the name typed in the form, else their display name.
  const signName = () => (ui.esName || ui.userName || "").trim();
  function energyAskText(forApp) {
    const e = survey.energy || {};
    const year = 12 * (e.electricityKwh || 0);
    const cut = year * (D.ELECTRICITY_FACTOR - D.GREEN_ELECTRICITY_FACTOR);
    const pct = Math.round((1 - D.GREEN_ELECTRICITY_FACTOR / D.ELECTRICITY_FACTOR) * 100);
    const list = D.USEFUL_LINKS.energy.items.map((l) => "• " + l.label + ": " + l.url).join("\n");
    const tapLink = !forApp && ui.energyToken ? "Once it's switched, could you tap this link to let me know? It ticks it off for me on CO2 Counter, and you don't need an account:\n" + confirmLink() + "\n\n" : "";
    // A landlord gets a more formal letter about the property.
    if (askWho() === "landlord")
      return {
        subject: "Switching the property's electricity to a renewable tariff",
        body:
          "Dear [Landlord's name],\n\nI'm writing about [your address]. Could the electricity supply for the property be switched to a 100% renewable tariff? For our home it would cut the electricity's carbon footprint by about " + kgFmt(cut) + " kg CO₂e a year (" + pct + "% less), and green tariffs are often a similar price.\n\n" +
          "These suppliers offer them:\n" + list + "\n\nSwitching takes a few minutes online, the new supplier handles everything, and the power never goes off. I'm happy to help with anything you need, such as meter readings.\n\n" +
          tapLink + "Kind regards,\n" + (signName() || "[Your name]"),
      };
    return {
      subject: "Could we switch to a renewable electricity tariff?",
      body:
        "Hi,\n\nCould we switch our electricity to a 100% renewable tariff? For our home it would cut the electricity's carbon footprint by about " + kgFmt(cut) + " kg CO₂e a year (" + pct + "% less), and green tariffs are often a similar price.\n\n" +
        "These suppliers offer them:\n" + list + "\n\nSwitching takes a few minutes online, the new supplier handles everything, and the power never goes off.\n\n" +
        (forApp ? "Thanks,\n" + signName() : tapLink + "Thanks,\n" + (signName() || "[Your name]")),
    };
  }
  const askWho = () => ui.askWho || "landlord";
  const confirmLink = () => PRODUCTION_URL + "#/confirm/energy?t=" + ui.energyToken;
  const energyVerified = () => ui.actsInfo && ui.actsInfo.verified && ui.actsInfo.verified.energy;
  function energyAskBox() {
    // Confirmed by the bill payer: update the survey so results show it.
    if (energyVerified())
      return (
        '<div class="ask-box"><p class="sm"><b>They\'ve confirmed the switch.</b> Update your survey so your results show the green tariff.</p>' +
        '<button type="button" class="btn btn-green btn-sm mt-2" data-action="set-green-done">We\'re on a green tariff now ' + icon("check") + "</button></div>"
      );
    const t = energyAskText();
    const asked = actsTicked().energyAsked;
    const st = ui.letterState || {};
    // Sent from their own email for now: it reaches the inbox far more
    // reliably than mail from our domain. The private link in the message
    // still verifies the act when the bill payer taps it.
    const href = "mailto:?subject=" + encodeURIComponent(t.subject) + "&body=" + encodeURIComponent(t.body);
    return (
      '<div class="ask-box"><p class="sm">' +
      (asked
        ? "You've asked. " + (ui.energyToken ? "When they tap the link in your message to say you've switched, this act is verified." : "Send it again any time.")
        : "Someone else chooses your supplier, so your switch is asking them. Here's a message ready to send, with your home's numbers in it" + (ui.energyToken ? ", and a link for them to tap once you've switched." : ".")) +
      "</p>" +
      '<div class="ask-who mt-2" role="radiogroup" aria-label="Who is it to?"><span class="xs fw-700">Who\'s it to?</span>' +
      [["landlord", "My landlord"], ["home", "Someone at home"]].map(([k, l]) => '<button type="button" class="chip' + (askWho() === k ? " on" : "") + '" role="radio" aria-checked="' + (askWho() === k) + '" data-action="ask-who" data-who="' + k + '">' + l + "</button>").join("") + "</div>" +
      energyAskButtons() + "</div>"
    );
  }
  // On a phone: one big Email button, then a tile for each app.
  function energyAskTiles() {
    const t = energyAskText();
    const m = { subject: t.subject, body: t.body };
    const asked = actsTicked().energyAsked;
    const href = "mailto:?subject=" + encodeURIComponent(t.subject) + "&body=" + encodeURIComponent(t.body);
    const mark = (bg, inner) => '<span class="send-ic" style="background:' + bg + '" aria-hidden="true">' + inner + "</span>";
    const tile = (attrs, ic, label) => '<a class="send-tile" ' + attrs + ">" + ic + "<span>" + label + "</span></a>";
    const MAIL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
    const CHAT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z"/></svg>';
    return (
      '<a class="send-main" href="' + esc(href) + '" data-action="energy-asked">' + MAIL + (asked ? "Email them again" : "Email them") + "</a>" +
      '<div class="send-grid">' +
      tile('href="' + esc(gmailLink(m)) + '" target="_blank" rel="noopener" data-action="energy-asked" data-mail="gmail"', mark("#EA4335", "G"), "Gmail") +
      (onPhone()
        ? tile('href="' + esc(outlookAppLink(m)) + '" data-action="energy-asked" data-mail="outlook-app"', mark("#0F6CBD", "O"), "Outlook")
        : tile('href="' + esc(outlookLink(m)) + '" target="_blank" rel="noopener" data-action="energy-asked" data-mail="outlook"', mark("#0F6CBD", "O"), "Outlook")) +
      tile('href="https://wa.me/?text=' + encodeURIComponent(t.body) + '" target="_blank" rel="noopener" data-action="energy-asked"', mark("#25D366", CHAT), "WhatsApp") +
      '<button type="button" class="send-tile" data-action="copy-energy-ask">' + mark("#6B6455", icon("copy")) + "<span>Copy</span></button>" +
      "</div>" +
      '<p class="send-more">Or in a browser: ' +
      (onPhone() ? '<a href="' + esc(outlookLink(m)) + '" target="_blank" rel="noopener" data-action="energy-asked" data-mail="outlook">Outlook.com</a> · ' : "") +
      '<a href="' + esc(outlookWorkLink(m)) + '" target="_blank" rel="noopener" data-action="energy-asked" data-mail="outlook-work">Work Outlook</a></p>' +
      (ui.askMsg ? '<p class="xs green-dark mt-2">' + esc(ui.askMsg) + "</p>" : "") +
      '<p class="xs muted mt-2">Add their email address' + (askWho() === "home" ? "" : ", and your address") + ". Sending from your own email means it lands in their inbox, not junk.</p>"
    );
  }
  // Email them, the webmail apps, copy and WhatsApp, with the ready message.
  function energyAskButtons() {
    const t = energyAskText();
    const asked = actsTicked().energyAsked;
    const href = "mailto:?subject=" + encodeURIComponent(t.subject) + "&body=" + encodeURIComponent(t.body);
    return (
      '<div class="hb-share mt-2"><a class="btn btn-green btn-sm" href="' + esc(href) + '" data-action="energy-asked">' + (asked ? "Email them again " : "Email them ") + icon("arrowRight") + "</a>" +
      webmailButtons({ subject: t.subject, body: t.body }, "energy-asked") +
      '<button type="button" class="hb-act-link" data-action="copy-energy-ask">' + icon("copy") + "Copy message</button>" +
      '<a class="hb-act-link" href="https://wa.me/?text=' + encodeURIComponent(t.body) + '" target="_blank" rel="noopener" data-action="energy-asked">WhatsApp</a></div>' +
      (ui.askMsg ? '<p class="xs green-dark mt-2">' + esc(ui.askMsg) + "</p>" : "") +
      '<p class="xs muted mt-2">Your email app, Gmail or Outlook opens with the message ready: add their email address, and your address if it\'s your landlord. Sending from your own email means it lands in their inbox, not junk.</p>'
    );
  }

  // Standard against green for their own electricity, then the suppliers.
  function greenTariffSheet() {
    const e = survey.energy || {};
    const hh = Math.max(1, e.household || 1);
    const year = (f) => (12 * (e.electricityKwh || 0) * f) / hh;
    const std = year(D.ELECTRICITY_FACTOR);
    const green = year(D.GREEN_ELECTRICITY_FACTOR);
    const max = Math.max(1, std);
    let html = panel(
      "Your electricity for a year, kg CO₂e",
      '<ul class="sbars">' +
        sheetBar("Standard tariff" + (e.greenTariff ? "" : " (yours)"), std, max, "var(--clay)", { text: kgFmt(std) + " kg", mine: !e.greenTariff }) +
        sheetBar("Green tariff" + (e.greenTariff ? " (yours)" : ""), green, max, "var(--em-600)", { text: kgFmt(green) + " kg", mine: !!e.greenTariff }) +
        "</ul>" +
        '<p class="xs muted mt-2">' + kgFmt(e.electricityKwh || 0) + " kWh a month" + (hh > 1 ? ", your share of " + hh : "") + ". Grid " + D.ELECTRICITY_FACTOR + " kg per kWh, renewable " + D.GREEN_ELECTRICITY_FACTOR + ".</p>",
      e.greenTariff ? chipBig("Already saving " + kgFmt(std - green) + " kg") : chipBig("Switching saves " + kgFmt(std - green) + " kg")
    );
    if (asksBillPayer(survey)) return html + panel("Ask whoever chooses your supplier", energyAskBox());
    const links = linksFor("energy");
    if (links)
      html += panel(
        e.greenTariff ? "Renewable suppliers, if you move again" : "Renewable suppliers to look at",
        linkChips("energy", 0, "popup") + '<p class="xs muted mt-2">Switching takes a few minutes, your new supplier handles it, and your power never cuts out.</p>'
      );
    return html;
  }

  // Cheese and dairy: kilo for kilo against meat, what dropping cheese, milk
  // and eggs would save on their vegetarian days, and where the animals come from.
  function cheeseSheet() {
    const c = mealCounts(survey);
    const veggieDays = c.veggie || 0;
    const perDay = Math.max(0, factorOf(D.MEAL_OPTIONS, "veggie") - factorOf(D.MEAL_OPTIONS, "vegan"));
    const yearly = perDay * veggieDays * D.WEEKS_PER_YEAR;
    const rows = [
      ["Cheese", A.CHEESE_KG, "var(--clay)"],
      ["Pork", D.MEAT_PER_KG.pork, "#D9A441"],
      ["Chicken", D.MEAT_PER_KG.chicken, "#8fa58a"],
    ];
    const max = Math.max(...rows.map((r) => r[1]));
    let html = panel(
      "Kilo for kilo, kg CO₂e",
      '<ul class="sbars">' + rows.map(([l, v, col]) => sheetBar(l, v, max, col, { text: (Math.round(v * 10) / 10) + " kg", mine: l === "Cheese" })).join("") + "</ul>" +
        '<p class="xs muted mt-2">It takes about 10 litres of milk to make 1 kg of hard cheese, so cheese carries the cows\' emissions in concentrated form. A litre of dairy milk is about ' + A.DAIRY_MILK_KG + " kg CO₂e, oat milk " + A.OAT_MILK_KG + ". Poore & Nemecek (2018).</p>",
      chipBig("Cheese ≈ " + (A.CHEESE_KG / D.MEAT_PER_KG.chicken).toFixed(1) + "× chicken")
    );
    html += panel(
      "Without cheese, milk and eggs",
      '<p class="sm">' +
        (veggieDays > 0
          ? "A vegan day is about " + (Math.round(perDay * 100) / 100) + " kg CO₂e lower than a vegetarian one. Making your " + plural(Math.round(veggieDays), "vegetarian day") + " a week dairy- and egg-free would save about <strong>" + kgFmt(yearly) + " kg a year</strong>."
          : "A vegan day is about " + (Math.round(perDay * 100) / 100) + " kg CO₂e lower than a vegetarian one, almost all of it from cheese, milk and eggs.") +
        " You don't have to go all the way: oat milk and half the cheese gets you a good part of it.</p>",
      yearly > 0.5 ? chipBig("−" + kgFmt(yearly) + " kg a year") : ""
    );
    html += panel(
      "Factory farming",
      '<p class="sm">Most UK milk, eggs and pork come from intensive farms. Dairy cows are made pregnant about once a year to keep them giving milk.</p>' +
        '<p class="sm mt-2">Pigs are mostly killed with gas: about 90% of pigs in England and Wales are stunned with high-concentration CO₂ before slaughter (Food Standards Agency, 2024). In October 2025 the government\'s Animal Welfare Committee recommended phasing this out within five years, finding it causes pain, breathing distress and fear. Meat industry bodies oppose a ban.</p>' +
        '<p class="sm mt-2">In spring 2026 the campaign group Project Slingshot ran its "Don\'t Buy It" adverts against these gas chambers across the London Underground.</p>' +
        '<p class="xs muted mt-2">Sources: <a href="https://www.fwi.co.uk/news/farm-policy/animal-welfare-committee-seeks-end-to-co2-stunning-of-pigs" target="_blank" rel="noopener">Farmers Weekly on the Animal Welfare Committee report</a> · <a href="https://www.globenewswire.com/news-release/2026/04/30/3284510/0/en/don-t-buy-it-celebrities-back-provocative-project-slingshot-campaign-to-end-gas-chambers-for-pigs.html" target="_blank" rel="noopener">Project Slingshot campaign</a></p>'
    );
    return html;
  }

  const nightNote = "Work nights or early shifts? Buses and trains may not be running, and walking or cycling in the dark isn't always safe or practical. Only count the swaps that work for your shifts.";

  function bankSheet() {
    const b = survey.banking || {};
    const bank = byKey(D.BANKS, b.bank);
    const sorted = D.BANKS.slice().sort((x, y) => x.factor - y.factor);
    const best = sorted[0];
    const max = sorted[sorted.length - 1].factor * 1000;
    const bandColour = { vgood: "var(--em-600)", good: "#8fa58a", bad: "var(--honey)", vbad: "var(--clay)" };
    const legend =
      '<span class="band-legend">' + D.BANK_RATING_BANDS.map((x) => '<span><i style="background:' + bandColour[x.key] + '"></i>' + x.label + "</span>").join("") + "</span>";
    let html = panel(
      "kg CO₂e financed per £1,000, a year",
      legend + '<ul class="sbars bank-bars">' +
        sorted
          .map((x) => {
            const me = bank && x.key === bank.key;
            const which = D.WHICH_BANK_RATINGS[x.key] === "green" ? ' <span class="which-eco">Which? Eco</span>' : "";
            return sheetBar(esc(x.label) + (me ? " (yours)" : "") + which, x.factor * 1000, max, bandColour[bankRating(x).key], { text: kgFmt(x.factor * 1000), mine: me });
          })
          .join("") +
        "</ul>"
    );
    const amount = Number(b.amount) || 0;
    if (bank && amount > 0) {
      const rt = bankRating(bank);
      html +=
        '<div class="sheet-tiles two"><div class="sheet-tile ' + (rt.key === "vgood" ? "lead" : "clay-soft") + '"><span>' + esc(bank.label) + " · your bank · " + rt.label + '</span><b class="display tnum">' + kgFmt(amount * bank.factor) +
        " kg a year</b><span>financed by your £" + amount.toLocaleString() + "</span></div>" +
        (bank.key === best.key
          ? '<div class="sheet-tile lead"><span>You\'re with the greenest bank here</span><b class="display">Nothing to switch</b><span>Your money is already working well.</span></div>'
          : '<div class="sheet-tile lead"><span>At ' + esc(best.label) + " · " + bankRating(best).label + '</span><b class="display tnum">' + kgFmt(amount * best.factor) + " kg a year</b><span>the same £" +
            amount.toLocaleString() + ", " + Math.round((1 - best.factor / bank.factor) * 100) + "% less</span></div>") +
        "</div>";
    } else {
      html += '<p class="sm mt-3">' + (bank ? "Add your savings in the survey to see how much CO₂ your money finances." : "Choose your bank in the survey's Money step to see your own comparison.") + "</p>";
    }
    return (
      html +
      '<p class="xs muted mt-3">Source: MotherTree bank carbon emissions league table (2021). Which? Eco: a Which? Eco Provider with no fossil-fuel exposure (Which? and Reclaim Finance, October 2023). ' +
      "The two can disagree: Lloyds and Halifax finance relatively little but lack a full fossil-fuel exclusion policy, so Which? rates them red.</p>"
    );
  }

  function switchSheet() {
    const greener = D.BANKS.slice().sort((x, y) => x.factor - y.factor).slice(0, 5);
    const support =
      isNativeApp() || !STRIPE_PAYMENT_LINK
        ? "Coming soon: a CO2 Counter assistant (MCP) to help you switch, step by step."
        : 'Coming soon: a CO2 Counter assistant (MCP) to help you switch, step by step. <a class="link-btn" href="' + esc(supportUrl()) + '">Help us build it by supporting CO2 Counter</a>.';
    return (
      panel(
        "Three steps, about 7 working days",
        '<ol class="howto">' +
          [
            ["Pick a greener bank", "One rated Very good or Good on the league table."],
            ["Open an account, choose a switch date", "Ask for a full switch using the Current Account Switch Service."],
            ["Done, guaranteed", "Your balance, direct debits and standing orders move for you. Payments to your old account are redirected."],
          ].map(([t, b2], i) => '<li><span class="num-badge display">' + (i + 1) + '</span><div><h3 class="display">' + t + "</h3><p>" + b2 + "</p></div></li>").join("") +
          '</ol><div class="mt-4"><a class="btn btn-green" href="' + D.CASS_URL + '" target="_blank" rel="noopener">Go to the Current Account Switch Service ' + icon("arrowRight") + "</a></div>"
      ) +
      panel(
        "Greener banks to switch to",
        '<div class="chip-wrap mt-3">' + greener.map((x) => '<span class="q-chip static">' + esc(x.label) + '<span class="q-chip-sub tnum">' + kgFmt(x.factor * 1000) + "</span></span>").join("") + "</div>" +
          '<p class="xs muted mt-2">kg CO₂e financed per £1,000 a year. The service is free, run by Pay.UK, and used by most UK banks and building societies.</p>' +
          (linksFor("banking") ? '<p class="sm fw-600 mt-3 mb-2">Switch pages:</p>' + linkChips("banking", 0, "popup") : "")
      ) +
      '<p class="xs muted mt-3">' + support + "</p>"
    );
  }

  function pensionSheet() {
    const b = survey.banking || {};
    const mine = D.PENSION_CLIMATE_RANKING.find((x) => x.key && x.key === b.pensionProvider);
    const chosen = byKey(D.PENSION_PROVIDERS, b.pensionProvider);
    const top = D.PENSION_CLIMATE_RANKING[0];
    const max = Math.max(...D.PENSION_CLIMATE_RANKING.map((x) => x.score));
    const note = mine
      ? ""
      : chosen && chosen.unfunded
      ? '<p class="sm mt-2">' + esc(chosen.label) + " isn't invested in companies: pensions are paid from government funds, so it doesn't add to your footprint and there's nothing to switch. The ranking covers invested workplace schemes, for any other pension you have.</p>"
      : chosen && chosen.key !== "other"
      ? '<p class="sm mt-2">' + esc(chosen.label) + " isn't in this ranking, which covers the 12 largest workplace pension providers.</p>"
      : '<p class="sm mt-2">Choose your pension provider in the survey\'s Money step to see where it ranks.</p>';
    return (
      '<div class="sheet-two">' +
      '<section class="sheet-panel"><span class="eyebrow">Savings</span><p class="sm mt-2">Banks lend out savings just like current-account money, so the bank league table applies here too. Keep savings with a greener bank.</p></section>' +
      '<section class="sheet-panel"><span class="eyebrow">Pension</span><p class="sm mt-2">Often the biggest money lever. Ask your provider which climate-focused fund options they offer and whether you can switch.</p></section></div>' +
      panel(
        "Workplace pension climate ranking",
        '<ol class="sbars rank-bars">' +
          D.PENSION_CLIMATE_RANKING.map((x) => {
            const me = mine && x === mine;
            return sheetBar('<span class="rank-n display">' + x.rank + "</span>" + esc(x.label) + (me ? " (yours)" : ""), x.score, max, me ? "var(--em-600)" : "#8fa58a", { text: x.score.toFixed(1), mine: me });
          }).join("") +
          "</ol>" + note +
          '<p class="xs muted mt-2">Higher is better, out of 10. Make My Money Matter, Climate Action Report 2025: climate commitments, targets, fossil fuels, deforestation and stewardship. It rates climate action, not your fund\'s footprint. Not financial advice.</p>',
        chipBig(mine ? esc(mine.label) + " is " + mine.rank : esc(top.label) + " is 1st")
      )
    );
  }

  function closeModal() {
    ui.hbSheet = null;
    modalRoot.innerHTML = "";
    document.body.classList.remove("modal-open");
  }









  // ==================== How we calculate page ====================

  // Public, free page explaining sources and approach. It deliberately
  // describes the method in words without exact factors or formulas.
  function renderMethod() {
    const section = (title, body) =>
      '<div class="section-card static fade-up"><h2 class="fw-600 mb-2">' + esc(title) + '</h2><div class="sm muted lh method">' + body + "</div></div>";
    const list = (items) => "<ul>" + items.map((i) => "<li>" + i + "</li>").join("") + "</ul>";
    return (
      '<div class="container narrow">' + pageHeader("How we calculate", "Where the numbers come from", "info") +
      '<p class="muted lh mb-8">CO2 Counter estimates your yearly carbon footprint from a short survey about how you live. ' +
      "Every figure is an estimate built from published data. It's designed to show where your biggest opportunities are, not to audit your exact emissions.</p>" +
      '<div class="stack-6 mb-10">' +
      section(
        "What we measure",
        "<p>Seven areas of everyday life:</p>" +
          list([
            "<strong>Food</strong>: your main meal each day, how often you eat out, and how much food is wasted",
            "<strong>Commute and travel</strong>: how you travel to work each day and how far, counting the journey there and back, plus other regular weekly travel and long journeys by land. For long journeys we work out the distance from the two towns: the straight line between them plus 25% for the way roads and railways wind (town locations from GeoNames, geonames.org). If you own a car, we add a share of making it: the emissions of building a car of that size and fuel (ICCT, 2021) spread over " + A.CAR_LIFE_YEARS + " years, a typical UK car's life, and split between the people who share it. If you give your yearly mileage, any miles your commute and trips don't already cover count as other driving, using UK government factors for your car's size and fuel",
            "<strong>Flights</strong>: each flight's distance between airports and the cabin class",
            "<strong>Home energy</strong>: electricity and gas use, whether you're on a green tariff, shared across your household",
            "<strong>Water</strong>: household water use, shared across your household",
            "<strong>Pets</strong>: the footprint of feeding dogs and cats",
            "<strong>Banking and pensions</strong>: the emissions your bank and pension fund finance with your money",
          ]) +
          "<p>Some things aren't measured yet, including shopping, other heating fuels, drinks and snacks, and services such as insurance and phone contracts. " +
          "For shopping we add a typical UK figure under your total (see below), and public services and infrastructure are shown separately as your shared footprint.</p>"
      ) +
      section(
        "How your estimate is worked out",
        "<p>For each answer we take the activity (a kilowatt-hour of gas, a kilometre by car, a beef meal, a long-haul flight in economy) and multiply it by a " +
          "typical published emission factor for that activity, measured in kilograms of CO₂-equivalent. CO₂-equivalent includes other greenhouse gases " +
          "such as methane from livestock.</p>" +
          "<p>Weekly habits are scaled up to a year, and household energy, water and pets are shared between the people you live with. " +
          "Flight distances are calculated between the two airports, with an allowance for real-world routing.</p>" +
          "<p>Food is counted a whole day at a time. Vegan, vegetarian and fish days use the measured daily footprints of each diet group in Choręziak &amp; Rzymski (2025, <em>Nutrients</em>). " +
          "A meat day is a vegetarian day plus a " + Math.round(D.PORTION * 1000) + " g portion of that meat, using Poore &amp; Nemecek's (2018, <em>Science</em>) global averages per kilogram.</p>"
      ) +
      section(
        "Banking and pensions",
        "<p>Banks lend out your savings, and pension funds invest in companies. A share of those companies' emissions is counted as yours, in proportion to the money involved. " +
          "This is known as financed emissions.</p>" +
          "<p>Bank figures come from MotherTree's 2021 analysis of UK banks' financed emissions.</p>" +
          "<p>Pension figures come from each provider's own climate report (TCFD report), using the carbon footprint of its default fund, the fund most savers are in. " +
          "These cover the companies' direct and energy-related emissions (Scope 1 and 2). " +
          "Where we couldn't get a provider's current figure, or you're not sure who your provider is, we use an average across the largest UK workplace pension schemes. " +
          "We refresh these figures as providers publish new reports.</p>"
      ) +
      section(
        "Comparing you with the UK average",
        "<p>Many UK-average figures include things this survey doesn't ask about, so comparing your total with them would be misleading. " +
          "Instead we build a typical UK resident's answers to the same survey from official statistics, and run them through exactly the same calculations:</p>" +
          list([
            "Home energy: Ofgem's typical household gas and electricity use, and ONS household sizes",
            "Food: Defra's Family Food survey of what households buy each week",
            "Commuting: the Department for Transport's National Travel Survey",
            "Flights: ONS figures on trips abroad by UK residents",
            "Water: Consumer Council for Water figures on daily use per person",
            "Pets: UK Pet Food's pet population figures",
          ]) +
          "<p>The comparison covers food, commuting, flights, home energy, water and pets. Banking and pensions aren't included, because there's no reliable " +
          "per-person UK figure for them. Where official data doesn't exist (for example, how often people eat out), we use a reasonable assumption.</p>"
      ) +
      section(
        "Assumed shopping",
        "<p>Shopping isn't part of the survey yet, so under your total we add a typical UK figure of about " + (D.ASSUMED_SHOPPING.totalKg / 1000).toFixed(1) +
          " tonnes a year. It comes from the government's official carbon footprint figures for what UK households spend on clothes and shoes, household goods " +
          "(furniture, appliances, homeware), electronics and phones, and hobbies and leisure, split across the whole population. It's the same for everyone until shopping is added to the survey.</p>"
      ) +
      section(
        "Your shared footprint",
        "<p>Some emissions belong to everyone in the UK together: the NHS, schools, councils and defence, and the roads, buildings and equipment the country invests in. " +
          "The government's official carbon footprint figures split these across the whole population, which comes to about " + (D.SHARED_FOOTPRINT.totalKg / 1000).toFixed(1) + " tonnes per person a year. " +
          "We show it as a fixed line under your total, because it's the same for everyone and your answers don't change it.</p>" +
          "<p>Together with what the survey measures, this brings your figure closer to the full UK average of about {{uk_total_t}} tonnes per person. Some spending, like insurance, phone contracts and other services, isn't in the survey yet.</p>"
      ) +
      section(
        "The 1.5°C budget",
        "<p>To keep global warming to 1.5°C, lifestyle footprints need to fall to about {{budget_t}} tonnes of CO₂-equivalent per person a year by 2030 (Hot or Cool Institute). " +
          "The budget covers food, home, travel, goods and leisure, but not banks and pensions or public services, so we compare like with like: your survey without money, plus typical shopping. " +
          'Your bank and pension are shown on their own. <a class="link-btn" href="#/budget">What\'s in the budget and how we compare</a></p>'
      ) +
      section(
        "Picture it: trees, phones and your fair share",
        "<p>Picture it on the results page shows your footprint now and after the 7 Acts in three everyday ways. <strong>Trees:</strong> " + esc(D.EVERYDAY_COMPARISONS.treeSource) +
          " We count the trees that, each growing for a year, would soak up your CO₂: your footprint ÷ " + D.EVERYDAY_COMPARISONS.treeKgYear + " kg. <strong>Phone charges:</strong> " + esc(D.EVERYDAY_COMPARISONS.phoneSource) +
          " We work out its CO₂ with the same UK grid figure as your home electricity: " + esc(phoneWorking()) + ", then divide your footprint by it." +
          " <strong>Fair share:</strong> your footprint ÷ the 1.5°C budget of about 2.5 t per person a year (Hot or Cool Institute, 2021).</p>" +
          '<p class="xs">Sources: <a href="https://www.arborday.org/" target="_blank" rel="noopener">Arbor Day Foundation</a> · ' +
          '<a href="https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references" target="_blank" rel="noopener">US EPA, Greenhouse Gas Equivalencies: calculations and references</a> · ' +
          '<a href="https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting" target="_blank" rel="noopener">UK Government GHG conversion factors (DESNZ)</a> · ' +
          '<a href="' + BUDGET_SOURCE_URL + '" target="_blank" rel="noopener">Hot or Cool Institute, 1.5-Degree Lifestyles</a></p>'
      ) +
      section(
        "Picture your year, and what if everyone lived like you?",
        "<p>Watch it shrink, on Picture it, shows your footprint as a disc whose area is your kilograms, shrinking as your three biggest moves are taken off.</p>" +
          "<p>It then asks what would happen if all 8.2 billion people lived like you. This is an illustration, not a climate model:</p>" +
          list([
            "<strong>The past</strong> is measured: the Met Office's HadCRUT5 global temperature for each year since 1850, shown against the 1850 to 1900 average, with an 11-year average drawn over it.",
            "<strong>Today</strong> is the 20-year trend, about 1.4°C, rather than one year's figure, which jumps around.",
            "<strong>If the world carries on</strong> follows Climate Action Tracker's estimate for today's policies: about 2.7°C by 2100. World emissions start at about 57 billion tonnes a year (UNEP Emissions Gap Report 2024).",
            "<strong>If everyone lived like you</strong> takes your full footprint (your survey without money, plus assumed shopping and your shared footprint), multiplies it by the world's population each year (UN World Population Prospects 2024) and holds it there until 2100. Extra warming is taken as proportional to the emissions added, on the same scale that takes today's policies to 2.7°C. That scale, about 0.36°C per 1,000 billion tonnes, is close to the IPCC's estimate for CO₂.",
            "<strong>If everyone made every change you could</strong> does the same with your footprint after every change on Results (the All the way figure), plus the same shopping and shared footprint. You choose which to see, or both, before the chart plays.",
          ]) +
          "<p>Because your shared footprint is in it, even a very small personal footprint doesn't reach zero. And the 1.5°C budget is meant to keep falling after 2030, so holding today's 2.5 tonnes flat until 2100 would still pass 2°C.</p>"
      ) +
      section(
        "Fun comparisons",
        "<p>To make tonnes easier to picture, Picture it and the share card also compare your footprint with some less everyday things. By weight: Liz Truss's lettuce (the Daily Star's iceberg, about 0.5 kg), and typical adults of some unusual animals, from a 100 g axolotl to a 1.3-tonne narwhal, plus an Argentinosaurus (an estimated 70 tonnes). " +
          "As a gas: CO₂ weighs about 1.87 kg a cubic metre (at 15°C at sea level), so a tonne fills a cube about 8 m tall, which we measure in published heights: Danny DeVito (1.47 m), Abraham Lincoln (1.93 m), a London double-decker bus (4.38 m) and a giraffe (about 5.5 m). They're for fun and scale, not precision.</p>"
      ) +
      section(
        "Potential savings",
        "<p>For each area we show two figures: what a <strong>realistic</strong> change would save, and the most you could save <strong>going all the way</strong>.</p>" +
          "<p>Realistic changes:</p>" +
          list([
            "Flights: if you take several long-haul flights, keeping one in economy; swapping a single long-haul trip for a shorter one; taking the train for trips up to {{swap_km}} km, keeping one of those flights if you take three or more; and flying other trips up to {{medium_km}} km in economy",
            "Commute and travel: walking or cycling on driving days for journeys up to 10 km, or train or bus for longer ones, and the train for long journeys you'd otherwise drive",
            "Food: swapping the highest-impact meals for lower-impact ones, tailored to your diet",
            "Home energy: switching to a renewable electricity tariff",
            "Water and pets: using less water, and choosing lower-impact pet food",
            "Banking and pensions: moving savings to a bank that doesn't fund fossil fuels, and choosing a climate-focused pension fund",
          ]) +
          "<p>Going all the way:</p>" +
          list([
            "Flights: not flying",
            "Commute and travel: no travel emissions, by working from home, walking and cycling, and holidaying closer to home",
            "Food: a fully plant-based diet with little waste",
            "Home energy: a renewable tariff plus a heat pump instead of gas",
            "Water and pets: bigger cuts in water use, and alternative-protein pet food",
          ]) +
          "<p>Savings are capped so no area can save more than it emits.</p>"
      ) +
      figureUpdatesSection() +
      section(
        "Limitations",
        list([
          "These are estimates from typical factors, not measurements of your actual bills, journeys or purchases.",
          "Financed emissions are counted using the industry's standard approach, which also counts them in other people's footprints, so they're best read on their own.",
          "Pension figures cover only companies' direct and energy emissions, not their supply chains or the use of their products, which can be much larger.",
          "Published data is updated over time. We review sources regularly, and figures may change as better data becomes available.",
        ])
      ) +
      "</div>" +
      '<div class="center"><a class="btn btn-green" href="#/">Take the survey ' + icon("arrowRight") + "</a></div></div>"
    );
  }

  // ==================== The 1.5°C budget ====================
  // What the 2.5 t budget covers, and how your footprint is compared with it.
  function renderBudget() {
    const t = (kg) => (kg / 1000).toFixed(1);
    const card = (title, body) => '<div class="section-card static fade-up"><h2 class="fw-600 mb-2">' + esc(title) + '</h2><div class="sm muted lh method">' + body + "</div></div>";
    const done = survey && survey.completedAt;
    const fp = done ? footprint(survey) : null;
    const bb = fp ? budgetBasis(fp) : null;
    const yours = fp
      ? '<section class="glass budget-you fade-up"><span class="eyebrow">Your figures</span>' +
        '<div class="budget-sum"><div><b class="display tnum">' + t(fp.totalYearly - bb.money) + ' t</b><span class="xs muted">your survey, without money</span></div><span class="budget-op" aria-hidden="true">+</span>' +
        '<div><b class="display tnum">' + t(bb.shop) + ' t</b><span class="xs muted">typical shopping</span></div><span class="budget-op" aria-hidden="true">=</span>' +
        '<div class="hl"><b class="display tnum">' + t(bb.life) + ' t</b><span class="xs muted">compared with the budget</span></div></div>' +
        '<p class="sm mt-3">That\'s <b>' + budgetPhrase(bb.life) + "</b> of " + t(D.BUDGET_YEARLY) + " t." +
        (bb.money >= 0.5 ? " Your bank and pension add another <b>" + t(bb.money) + " t</b>, shown on their own." : "") + "</p></section>"
      : "";
    const inOut = (rows) => '<ul class="budget-list">' + rows.map(([ok, text]) => '<li class="' + (ok ? "in" : "out") + '"><span aria-hidden="true">' + (ok ? "✓" : "✕") + "</span>" + text + "</li>").join("") + "</ul>";
    return (
      '<div class="container narrow">' + pageHeader("The 1.5°C budget", "What it covers, and how we compare you with it", "info") +
      yours +
      '<div class="stack-6 mb-10">' +
      card("Where 2.5 tonnes comes from",
        "<p>To keep global warming to 1.5°C, the Hot or Cool Institute's <em>1.5-Degree Lifestyles</em> report (2021) works out how far each person's lifestyle footprint needs to fall, sharing what's left of the world's carbon budget fairly between everyone: " +
          "about <strong>2.5 tonnes</strong> of CO₂e a person by 2030, <strong>1.4 tonnes</strong> by 2040 and <strong>0.7 tonnes</strong> by 2050. We use the 2030 figure. " +
          '<a class="link-btn" href="' + BUDGET_SOURCE_URL + '" target="_blank" rel="noopener">The report</a></p>') +
      card("What the budget covers",
        "<p>It's a <em>lifestyle</em> footprint: the emissions from what households consume.</p>" +
          inOut([
            [true, "Food and drink"],
            [true, "Home energy and water"],
            [true, "Travel, including flights"],
            [true, "Goods: clothes, electronics, furniture and the like"],
            [true, "Leisure and services: hobbies, holidays, eating out"],
            [false, "Money in banks and pensions (financed emissions)"],
            [false, "Public services and infrastructure, like the NHS, schools and roads"],
          ])) +
      card("How we compare you with it",
        "<p>We compare like with like. From your survey we take everything except your bank and pension: food, commuting and travel, flights, home energy, water and pets. " +
          "Shopping isn't in the survey yet, so we add a typical UK figure of " + t(D.ASSUMED_SHOPPING.totalKg) + " t, the same as the budget would count. That total is what we put against the budget, and the UK average on the results page is worked out the same way.</p>" +
          "<p>Your bank and pension are still in your footprint, and still count. We show them on their own because the budget doesn't include them, and because financed emissions are also counted in the footprints of the companies they fund, so adding them would mix two different kinds of figure.</p>" +
          "<p>Public services and infrastructure (about " + t(D.SHARED_FOOTPRINT.totalKg) + " t a person between them) are left out of both, as the budget leaves them out too. They're shown on the results page as your shared footprint.</p>") +
      card("Why your headline total is different",
        "<p>The big number on your results page is everything the survey measures, including your bank and pension, so it's the one to watch as you make changes. " +
          "The comparison with the budget takes money out and adds typical shopping, so the two figures won't match.</p>") +
      "</div>" +
      '<div class="center chip-row" style="justify-content:center">' + (done ? '<a class="btn btn-green" href="#/results">Back to my results ' + icon("arrowRight") + "</a>" : '<a class="btn btn-green" href="#/">Take the survey ' + icon("arrowRight") + "</a>") +
      '<a class="btn btn-outline" href="/how-we-calculate/">How we calculate</a></div></div>'
    );
  }

  // ==================== Inputs (admin) ====================
  // Every figure the footprint is worked out with: name, number and source.
  // Saving goes through save_input() in Supabase, which only admins can
  // call; the page itself is only shown to admins.

  const inputLog = { loaded: false, loading: false, rows: [] };
  async function loadInputLog() {
    if (!sb || inputLog.loading) return;
    inputLog.loading = true;
    try {
      const { data, error } = await sb.rpc("input_changelog", { p_limit: 50 });
      inputLog.rows = !error && Array.isArray(data) ? data : [];
    } catch (e) {
      inputLog.rows = [];
    }
    inputLog.loaded = true;
    inputLog.loading = false;
    const path = currentPath();
    if (path === "/inputs" || path === "/how-we-calculate") render();
  }

  async function checkAdmin() {
    ui.isAdmin = false;
    if (!currentUser || !sb) return;
    try {
      const { data } = await sb.rpc("is_admin");
      ui.isAdmin = data === true;
    } catch (e) {}
  }

  const inputDef = (key) => INPUT_DEFS.find((d) => d.key === key);
  const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const numText = (v) => (v == null || !isFinite(v) ? "–" : String(Math.round(v * 1e6) / 1e6));

  // The newest edit, or the day the built-in figures were last checked.
  function figuresUpdated() {
    const dates = Object.values(inputMeta).map((m) => m.updatedAt).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : D.FIGURES_BUILT_IN;
  }

  // Sources due a new edition, grouped so one report shows once.
  function inputReminders() {
    const now = new Date();
    const groups = {};
    INPUT_DEFS.forEach((d) => {
      if (!d.asOf || !d.every) return;
      const edited = inputMeta[d.key] && inputMeta[d.key].updatedAt;
      const from = edited ? new Date(edited) : new Date(d.asOf + "-01");
      const due = new Date(from.getFullYear(), from.getMonth() + d.every, 1);
      if (due > now) return;
      const src = edited ? inputMeta[d.key].source || d.source : d.source;
      const g = (groups[src] ||= { source: src, due, labels: [] });
      if (due < g.due) g.due = due;
      g.labels.push(d.label);
    });
    return Object.values(groups).sort((a, b) => a.due - b.due);
  }

  function inputRow(d) {
    const v = liveInputs[d.key];
    const meta = inputMeta[d.key];
    const src = meta ? meta.source : d.source;
    const edited = meta && Math.abs(v - BUILT_IN[d.key]) > 1e-9;
    return (
      '<div class="inp-row" data-input-row="' + d.key + '">' +
      '<div class="inp-name"><label class="fw-700" for="inp-' + d.key + '">' + esc(d.label) + '</label><span class="xs muted">' + esc(d.unit) + "</span></div>" +
      '<input class="input inp-val tnum" id="inp-' + d.key + '" type="number" step="any" min="0" inputmode="decimal" value="' + esc(numText(v)) + '" data-input-key="' + d.key + '" data-was="' + esc(numText(v)) + '" />' +
      '<textarea class="input inp-src" rows="2" maxlength="1000" aria-label="Source for ' + esc(d.label) + '" data-input-src="' + d.key + '" data-was="' + esc(src) + '">' + esc(src) + "</textarea>" +
      '<div class="inp-foot"><span class="xs muted">' +
      (meta ? "Changed " + esc(shortDate(meta.updatedAt)) + (edited ? " · built-in " + esc(numText(BUILT_IN[d.key])) : "") : "Built-in figure") + "</span>" +
      '<span class="inp-btns">' +
      (edited ? '<button type="button" class="link-btn xs" data-action="reset-input" data-key="' + d.key + '">Reset to built-in</button>' : "") +
      '<button type="button" class="btn btn-green btn-sm" data-action="save-input" data-key="' + d.key + '" disabled>Save</button></span></div></div>'
    );
  }

  function renderInputs() {
    if (!inputLog.loaded) loadInputLog();
    const q = (ui.inputQuery || "").trim().toLowerCase();
    const defs = INPUT_DEFS.filter((d) => !q || (d.label + " " + d.group + " " + d.unit + " " + d.key).toLowerCase().includes(q));
    const groups = [...new Set(defs.map((d) => d.group))];
    const edits = Object.keys(inputMeta).length;
    const reminders = inputReminders();
    const day = (k) => Math.round((liveInputs.food_veggie_day + liveInputs.portion * liveInputs["meat_" + k]) * 100) / 100;
    const derived = {
      Food: "Meat days worked out from these: chicken " + day("chicken") + " · pork " + day("pork") + " · beef " + day("beef") + " · lamb " + day("lamb") + " kg CO₂e a day.",
      Flights: "Train vs plane for other trips: " + Math.round((liveInputs.paris_train / liveInputs.paris_plane) * 1000) / 10 + "% of the flight's emissions.",
    };
    let html =
      '<div class="container inputs-page">' + pageHeader("Inputs", "The figures every footprint is worked out with", "chart") +
      (ui.inputMsg ? '<p class="inp-msg ' + (ui.inputMsg.ok ? "ok" : "err") + '" role="status">' + esc(ui.inputMsg.text) + "</p>" : "") +
      '<section class="glass inp-summary"><div><p class="eyebrow">Figures last updated</p><p class="display inp-date">' + esc(shortDate(figuresUpdated())) + "</p>" +
      '<p class="xs muted">' + INPUT_DEFS.length + " inputs · " + edits + " changed from built-in. Saving updates the site for everyone straight away. " +
      "Finished surveys keep the figures they were worked out with; new surveys use these.</p></div>" +
      '<div class="inp-tools"><input class="input" type="search" id="input-search" placeholder="Search inputs" aria-label="Search inputs" value="' + esc(ui.inputQuery || "") + '" />' +
      '<button type="button" class="btn btn-outline btn-sm" data-action="export-inputs">' + icon("arrowRight") + " Export CSV</button></div></section>";
    if (reminders.length) {
      html +=
        '<details class="glass inp-due"><summary><span class="card-title">Due for a check</span><span class="inp-due-count">' + reminders.length + (reminders.length === 1 ? " source" : " sources") +
        '</span></summary><p class="xs muted mb-2">These sources have usually published a new edition by now. Check each one and save any new figures.</p><ul>' +
        reminders.map((r) => "<li><b>" + esc(r.source) + '</b><span class="xs muted">' + esc(r.labels.slice(0, 4).join(", ") + (r.labels.length > 4 ? " and " + (r.labels.length - 4) + " more" : "")) + " · due since " + esc(r.due.toLocaleDateString(undefined, { month: "short", year: "numeric" })) + "</span></li>").join("") +
        "</ul></details>";
    }
    html += groups
      .map((g) => '<section class="glass inp-group"><h2 class="card-title">' + esc(g) + "</h2>" + (derived[g] && !q ? '<p class="xs muted mb-2">' + esc(derived[g]) + "</p>" : "") + defs.filter((d) => d.group === g).map(inputRow).join("") + "</section>")
      .join("");
    if (!defs.length) html += '<p class="muted center mt-4">No inputs match “' + esc(q) + "”.</p>";
    html += '<section class="glass inp-group"><h2 class="card-title">Change log</h2>';
    if (!inputLog.loaded) html += stateCard({ kind: "loading", inline: true, title: "", text: "Loading the change log…" });
    else if (!inputLog.rows.length) html += '<p class="sm muted">No changes yet. Everything is on the built-in figures.</p>';
    else {
      html +=
        '<ul class="inp-log">' +
        inputLog.rows
          .map((r, i) => {
            const d = inputDef(r.key);
            return (
              '<li><span class="xs muted">' + esc(shortDate(r.changed_at)) + '</span><span class="min0"><b>' + esc(d ? d.label : r.key) + '</b> <span class="tnum">' + esc(numText(r.old_value)) + " → " + esc(numText(r.new_value)) + "</span>" +
              (r.source ? '<span class="xs muted inp-log-src">' + esc(r.source) + "</span>" : "") + "</span>" +
              (d && r.old_value != null && i === inputLog.rows.findIndex((x) => x.key === r.key) ? '<button type="button" class="link-btn xs" data-action="undo-input" data-index="' + i + '">Undo</button>' : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul>";
    }
    return html + "</section></div>";
  }

  async function saveInput(key, value, source, note) {
    const d = inputDef(key);
    const was = liveInputs[key];
    const { error } = await sb.rpc("save_input", { p_key: key, p_value: value, p_source: source, p_old_value: was });
    if (error) {
      ui.inputMsg = { ok: false, text: "Couldn't save " + d.label + ": " + (error.message || "please try again.") };
    } else {
      await loadInputs();
      inputLog.loaded = false;
      ui.inputMsg = { ok: true, text: (note || "Saved") + ": " + d.label + " " + numText(was) + " → " + numText(value) + "." };
    }
    render();
  }

  // The public log on "How we calculate".
  function figureUpdatesSection() {
    if (!inputLog.loaded) loadInputLog();
    const rows = inputLog.rows.slice(0, 10);
    return (
      '<div class="section-card static fade-up"><h2 class="fw-600 mb-2">Figure updates</h2><div class="sm muted lh method">' +
      "<p>We update the figures as soon as new data is published. Figures last updated: <strong>" + esc(shortDate(figuresUpdated())) + "</strong>. " +
      "Your results keep the figures from when you took the survey; your next survey uses the latest ones.</p>" +
      (rows.length
        ? "<ul>" + rows.map((r) => { const d = inputDef(r.key); return "<li>" + esc(shortDate(r.changed_at)) + ": " + esc(d ? d.label : r.key) + " " + esc(numText(r.old_value)) + " → " + esc(numText(r.new_value)) + (d ? " " + esc(d.unit) : "") + (r.source ? " (" + esc(r.source) + ")" : "") + "</li>"; }).join("") + "</ul>"
        : "<p>No changes since the figures were last checked on " + esc(shortDate(D.FIGURES_BUILT_IN)) + ".</p>") +
      "</div></div>"
    );
  }

  function exportInputs() {
    const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [["Group", "Input", "Value", "Unit", "Built-in", "Source", "Last changed", "Key"].map(cell).join(",")];
    INPUT_DEFS.forEach((d) => {
      const meta = inputMeta[d.key];
      lines.push([d.group, d.label, numText(liveInputs[d.key]), d.unit, numText(BUILT_IN[d.key]), meta ? meta.source : d.source, meta ? meta.updatedAt.slice(0, 10) : "", d.key].map(cell).join(","));
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "co2counter-inputs-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ==================== Greener switches & About (public) ====================
  // Open to everyone, signed in or not, so visitors and affiliate reviewers
  // can see what we recommend and how partners are chosen. Every figure is
  // worked out from the Inputs: the visitor's own survey once they've taken
  // it, else a typical UK resident.

  const SW_ICONS = {
    banking: "M3 9.5 12 4l9 5.5H3ZM5.5 10v7M10 10v7M14 10v7M18.5 10v7M3 20h18",
    energy: "M13 2 4 14h7l-1 8 9-12h-7Z",
    meals: "M3 12h18a9 9 0 0 1-18 0ZM9 3.5c-1 1.2 1 2.3 0 3.5M13 3.5c-1 1.2 1 2.3 0 3.5",
    flights: "M10.5 5c.5-2 2.5-2 3 0l.5 4 6.5 4v2l-6.5-2v4.5l2 1.5v1.5L12 19.5 8 20.5V19l2-1.5V13l-6.5 2v-2L10 9Z",
    commute: "M3.5 15.5v-3.5l2.5-5.5h12l2.5 5.5v3.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1ZM3.5 12h17",
    pets: "M12 13c-3 0-5.5 3-5.5 5.5 0 1.5 1.5 2 3 1.5s3.5-.5 5 0 3 0 3-1.5C17.5 16 15 13 12 13ZM5 9.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0M16 9.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0M8.5 5.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0M12.5 5.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0",
    water: "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z",
    mobilise: "M3 6h18v12H3ZM3 6l9 7 9-7",
    motivate: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14c2 .7 3.5 2.8 3.5 6",
  };
  const svgPath = (d, size, extra) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || "") + '><path d="' + d + '"></path></svg>';
  const leafMark = (size) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100" aria-hidden="true"><path d="M22 80C22 44 46 20 82 18c0 38-24 62-60 62Z" fill="#EFE9DC"></path><rect x="36" y="40" width="7" height="22" rx="3.5" fill="#3F5B3A"></rect><rect x="46" y="47" width="7" height="15" rx="3.5" fill="#3F5B3A"></rect><rect x="56" y="54" width="7" height="8" rx="3.5" fill="#D9A441"></rect></svg>';
  const TONES = { leaf: ["#3F5B3A", "#F6F1E6"], amber: ["#E8C88A", "#2E2A22"], plum: ["#6F4E63", "#F6F1E6"], sky: ["#7FA3AE", "#14262B"] };
  const domainOf = (u) => u.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  const fmtKg = (n) => (n < 10 && n > 0 ? (Math.round(n * 100) / 100).toString() : kgFmt(n));

  // The survey the page is worked out from, and who it belongs to.
  function switchBase() {
    if (survey && survey.completedAt) return { s: survey, mine: true };
    return { s: switchBaseTypical(), mine: false };
  }
  function switchBaseTypical() {
    const s = normaliseSurvey(JSON.parse(JSON.stringify(D.UK_TYPICAL_SURVEY)));
    s.flights = D.UK_TYPICAL_SURVEY.flights;
    const worst = D.BANKS.slice().sort((a, b) => b.factor - a.factor)[0];
    s.banking = { ...s.banking, amount: A.EXAMPLE_SAVINGS, bank: worst.key };
    return s;
  }

  // The five areas, with savings and a before/after for each.
  function switchAreas(base) {
    const s = base.s;
    const swap = (fn) => { const keep = survey; survey = s; try { return fn(); } finally { survey = keep; } };
    const saving = (cat) => swap(() => { const t = tipFor(cat, s); return Math.max(0, t.saving || 0); });
    const banks = D.BANKS.slice().sort((a, b) => a.factor - b.factor);
    const best = banks[0];
    const own = byKey(D.BANKS, s.banking.bank);
    const amount = base.mine && s.banking.amount > 0 && own ? s.banking.amount : A.EXAMPLE_SAVINGS;
    const worst = banks[banks.length - 1];
    // Already with a very good bank: compare with the worst instead, and
    // say how much further the greenest would go.
    const bankDone = base.mine && own && s.banking.amount > 0 && bankRating(own).key === "vgood";
    const before = bankDone ? worst : base.mine && own && s.banking.amount > 0 ? own : worst;
    const bankAfter = bankDone ? own : best;
    const further = bankDone ? amount * (own.factor - best.factor) : 0;
    const energyDone = base.mine && !!s.energy.greenTariff;
    // Food: vegan or vegetarian already. Flights: none to swap.
    const diet = dietType(s);
    const foodDone = base.mine && (diet === "vegan" || diet === "veggie");
    const myFlights = (s.flights || []).filter((f) => flightKm(f.from, f.to) > 0);
    const flightsDone = base.mine && !myFlights.length;
    // Commute: nothing to switch without a commute, or when every trip is
    // already on foot, by bike or from home, and there's no car to change.
    const cm = s.commute || {};
    const cmDays = DAYS.map((d) => cm[d]).filter((m) => m && m !== "wfh");
    const noCommute = !(cm.distance > 0 && cmDays.length);
    const commuteDone = base.mine && !ownedCars(s).some((x) => x.fuel !== "ev") && cmDays.every((m) => m === "walk_bike");
    const elecKwh = (12 * (s.energy.electricityKwh || 0)) / householdOf(s) || (D.UK_PROFILE.electricityKwh / D.UK_PROFILE.household);
    const dist = s.commute.distance || D.UK_PROFILE.commuteKm;
    const day = (k) => byKey(D.MEAL_OPTIONS, k).factor;
    const petrol = petrolKm();
    const train = factorOf(D.COMMUTE_MODES, "train");
    // Compare someone's own heaviest day, not beef unless they eat it: a
    // vegetarian against vegan, a vegan against a typical UK day.
    const counts = mealCounts(s);
    const MEATS = ["beef", "lamb", "pork", "chicken", "fish"];
    const heaviest = MEATS.filter((k) => counts[k] > 0).sort((a, b) => day(b) - day(a))[0];
    const ukCounts = mealCounts(D.UK_TYPICAL_SURVEY);
    const ukDays = Object.values(ukCounts).reduce((t, v) => t + v, 0) || 1;
    const ukDay = Object.keys(ukCounts).reduce((t, k) => t + day(k) * ukCounts[k], 0) / ukDays;
    const food = !base.mine
      ? { beforeLabel: "Beef", before: day("beef"), afterLabel: "Vegan", after: day("vegan"), what: "A beef day" }
      : diet === "vegan"
        ? { beforeLabel: "Typical UK day", before: ukDay, afterLabel: "Yours: vegan", after: day("vegan") }
        : diet === "veggie"
          ? { beforeLabel: "Yours: vegetarian", before: day("veggie"), afterLabel: "Vegan", after: day("vegan") }
          : heaviest
            ? { beforeLabel: "Yours: " + byKey(D.MEAL_OPTIONS, heaviest).label.toLowerCase(), before: day(heaviest), afterLabel: "Vegan", after: day("vegan"), what: "A " + byKey(D.MEAL_OPTIONS, heaviest).label.toLowerCase() + " day" }
            : { beforeLabel: "Typical UK day", before: ukDay, afterLabel: "Vegan", after: day("vegan") };
    const times = (a, b) => { const r = a / b; return r >= 1.95 ? Math.round(r) + " times" : r >= 1.15 ? r.toFixed(1) + " times" : "about the same as"; };
    return [
      { key: "banking", short: "Bank", effort: "One-off · about 7 working days", ex: 22, save: saving("banking"), verb: "Switch to", independent: true, panel: "#3F5B3A", panelInk: "#F6F1E6", dropInk: "#E8C88A",
        done: bankDone,
        doneTitle: further > 0.5 ? "You've switched. Go a bit further?" : "You're with the greenest bank",
        fact: bankDone
          ? "You're already with " + own.label.replace(/^The /, "") + ", one of the greenest banks. Your £" + kgFmt(amount) + " there finances about " + kgFmt(amount * (worst.factor - own.factor)) + " kg CO₂e a year less than at " + worst.label.replace(/^The /, "") + "." +
            (further > 0.5 ? " You could go a bit further: " + best.label.replace(/^The /, "") + " would cut another " + kgFmt(further) + " kg a year." : " There's no greener bank on our list.")
          : "Banks lend out the money you keep with them. The free Current Account Switch Service moves your account in 7 working days, guaranteed, direct debits and all.",
        vsTitle: "£" + kgFmt(amount) + " for a year, kg CO₂e financed", beforeLabel: before.label.replace(/^The /, ""), before: amount * before.factor,
        afterLabel: (bankDone ? "Yours: " : "") + bankAfter.label.replace(/^The /, ""), after: amount * bankAfter.factor },
      { key: "energy", short: "Energy", effort: "One-off · a few minutes", ex: 8, save: saving("energy"), verb: "Switch to", panel: "#D9A441", panelInk: "#2E2A22", dropInk: "#2B4128",
        done: energyDone,
        doneTitle: "You're on a green tariff",
        askHtml: base.mine && asksBillPayer(s) ? '<p class="sm mt-3">Someone else chooses your supplier, so your switch is asking them.</p>' + habitsBtn("Ask them from My Habits") : "",
        fact: base.mine && asksBillPayer(s)
          ? "Someone else chooses your supplier, so the switch is asking them. A renewable tariff would cut your home's electricity emissions by {{green_cut}}."
          : energyDone
          ? "You're already on a renewable tariff, which cuts your electricity emissions by {{green_cut}}. Going further means using less: heating, insulation and, in time, a heat pump."
          : "A renewable tariff can cut electricity emissions by {{green_cut}}, with no new equipment, and your power never cuts out during the switch.",
        vsTitle: (base.mine ? "Your" : "Typical") + " electricity for a year, kg CO₂e", beforeLabel: "Standard", before: elecKwh * D.ELECTRICITY_FACTOR, afterLabel: energyDone ? "Yours: green tariff" : "Green tariff", after: elecKwh * D.GREEN_ELECTRICITY_FACTOR },
      { key: "meals", short: "Food", effort: "Ongoing · a weekly habit", ex: 84, save: saving("meals"), verb: "Explore", panel: "#6E8B5E", panelInk: "#F6F1E6", dropInk: "#F6F1E6",
        done: foodDone,
        doneTitle: diet === "vegan" ? "You eat plant-based. Go a bit further?" : "You're vegetarian. Go a bit further?",
        fact: foodDone
          ? diet === "vegan"
            ? "Your days are already plant-based, the lowest-carbon way to eat. You can still go a bit further by wasting less and choosing local, seasonal produce: a veg box helps with both."
            : "No meat already puts you well below a typical diet. You could go a bit further with a few vegan days: dairy and eggs are most of what's left."
          : food.what
            ? food.what + " emits " + times(food.before, food.after) + " a vegan day" + (base.mine ? ", and it's your highest-carbon day of food" : "") + ". A veg box or a recipe app makes the swap the easy option."
            : "Swapping a few meat days for plant-based ones is the biggest food change. A veg box or a recipe app makes it the easy option.",
        vsTitle: "A day of food, kg CO₂e", beforeLabel: food.beforeLabel, before: food.before, afterLabel: food.afterLabel, after: food.after },
      { key: "commute", short: "Commute", effort: "Ongoing · a day a week", ex: 70, save: saving("commute"), verb: "Visit", panel: "#7FA3AE", panelInk: "#14262B", dropInk: "#14262B",
        done: commuteDone,
        doneTitle: noCommute ? "No commute to switch" : "You already walk or cycle",
        fact: commuteDone
          ? noCommute
            ? "You don't commute, so there's nothing to switch here. If that changes, walking, cycling or the train are the ones to look at."
            : "You already walk or cycle to work, so your commute is as low as it gets. Nothing to switch here."
          : "Your commute repeats over 200 times a year. Swapping car days for the train or a bike, or going electric through a salary-sacrifice scheme, adds up fast.",
        vsTitle: (base.mine ? "Your " : "A ") + (Math.round(dist * 10) / 10) + " km commute, one day, kg CO₂e", beforeLabel: "Petrol car", before: dist * 2 * petrol,
        afterLabel: commuteDone && !noCommute ? "Yours: walk or cycle" : "Train", after: commuteDone && !noCommute ? 0 : dist * 2 * train },
      { key: "flights", short: "Flights", effort: "When you travel · per trip", ex: 59, save: saving("flights"), verb: "Plan with", panel: "#B8653D", panelInk: "#FFF7EE", dropInk: "#FFF7EE",
        done: flightsDone,
        doneTitle: "No flights to switch",
        fact: flightsDone
          ? "You haven't added any flights, so there's nothing to switch. For trips in the UK and nearby Europe, the train is usually the low-carbon way to go."
          : base.mine && myFlights.length && myFlights.every((f) => flightKm(f.from, f.to) > A.SHORT_HAUL_KM)
            ? "Your flights are too far for the train to be realistic. The switches here are flying a little less often and choosing economy, which shares the plane's emissions between more people."
            : "Once airport time is counted, the train is often as quick door to door for shorter trips, and it emits a fraction as much.",
        vsTitle: "London → Paris, return, kg CO₂e", beforeLabel: "Plane", before: A.PARIS_FLIGHT_KG, afterLabel: "Train", after: A.PARIS_TRAIN_KG },
    ].map((a) => {
      // Your own page only shows the links that suit your answers.
      const fit = base.mine ? linksFor(a.key, s) : D.USEFUL_LINKS[a.key];
      return { ...a, title: a.done ? a.doneTitle : D.USEFUL_LINKS[a.key].title, eyebrow: D.USEFUL_LINKS[a.key].eyebrow, links: fit ? fit.items : [] };
    });
  }

  // Real Zero's 7 Acts: the five footprint switches are acts 1-4, and
  // acts 6 and 7 work through other people. Their effect can't honestly be
  // put in kg, so they sit on the chart as medium impact, low effort.
  const ACT_NO = { banking: 1, energy: 2, meals: 3, commute: 4, flights: 4, mobilise: 6, motivate: 7 };
  const habitsBtn = (label) => '<a class="btn btn-green mt-4" href="#/habits">' + label + " " + icon("arrowRight") + "</a>";
  function indirectActs(base, typicalSave) {
    const info = base.mine ? ui.actsInfo : null;
    const ticked = base.mine ? actsTicked() : {};
    const mpDone = base.mine && (info ? !!(info.verified && info.verified.mobilise) : !!ticked.mobilise);
    const friends = info ? Math.min(7, info.finished || 0) : 0;
    const motDone = base.mine && !!info && !!((info.verified && info.verified.motivate) || friends >= 7);
    const url = encodeURIComponent(inviteLink());
    const text = encodeURIComponent(shareText() + " " + inviteLink());
    return [
      {
        key: "mobilise", short: "Your MP", title: mpDone ? "You've written to your MP" : "Write to your MP", effort: "One-off · one letter", ex: 32, ey: 52,
        panel: "#6F4E63", panelInk: "#F6F1E6", done: mpDone, big: "650", bigLabel: "MPs vote on the UK's climate laws",
        fact: "Your switches cut your own footprint. The rules everyone lives by cut everyone's, and MPs make them. A letter in your own words is one of the most direct ways to show that climate matters to voters where you live.",
        action: mpDone ? "" : currentUser ? habitsBtn("Write to your MP in My Habits") : '<a class="btn btn-green mt-4" href="#/acts/mobilise">Write to your MP ' + icon("arrowRight") + "</a>",
        page: "#/acts/mobilise", status: mpDone ? "Done" : info && ticked.mpSent ? "Waiting for our copy" : "Not yet",
      },
      {
        key: "motivate", short: "Friends", title: motDone ? "Seven people are in" : "Bring seven people with you", effort: "One-off · a few messages", ex: 46, ey: 72,
        panel: "#2B4128", panelInk: "#F6F1E6", done: motDone,
        big: "~" + (Math.round((typicalSave * 7) / 100) / 10).toString() + " t", bigLabel: "a year if seven people each made a typical person's switches",
        fact: "Change spreads through the people we know. When people you invite take the survey and make their own switches, their cuts add up on your Act 7 page." +
          (info && info.cut != null ? " So far, the people you invited have cut " + kgFmt(info.cut) + " kg a year between them." : ""),
        action: motDone
          ? ""
          : currentUser
            ? (info ? '<p class="sm mt-3"><b>' + friends + " of 7</b> people you invited have taken the survey.</p>" : "") + habitsBtn("Invite people from My Habits")
            : '<div class="sw-act-box">' + shareButtonsHtml(url, text) + "</div>",
        page: "#/acts/motivate", status: motDone ? "Done" : info ? friends + " of 7" : "Not yet",
      },
    ];
  }

  function renderSwitches() {
    const base = switchBase();
    const fp = footprint(base.s);
    const areas = switchAreas(base);
    const total = areas.reduce((t, a) => t + a.save, 0);
    const typical = base.mine ? switchAreas({ s: switchBaseTypical(), mine: false }).reduce((t, a) => t + a.save, 0) : total;
    const others = indirectActs(base, typical);
    const who = base.mine ? "for you" : "for a typical person";
    ui.switchModel = { foot: fp.totalYearly, saves: areas.map((a) => a.save) };
    if (!ui.switchOn) ui.switchOn = areas.map(() => false);
    // Five equal steps of a round size, just above the biggest saving.
    const step = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((x) => x * 5 >= Math.max(1, ...areas.map((a) => a.save)) * 1.1) || 5000;
    const maxSave = step * 5;
    const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const board =
      '<div class="sw-board"><div class="sw-board-head"><span class="display">' + (base.mine ? "Your switchboard" : "Switchboard") + "</span>" +
      '<button type="button" class="sw-all" data-action="switch-all">Turn all on</button></div><ul>' +
      areas
        .map(
          (a, i) =>
            '<li class="sw-row" data-sw="' + i + '"><span class="sw-tile">' + svgPath(SW_ICONS[a.key], 22) + "</span>" +
            '<span class="min0"><span class="display sw-short">' + a.short + (a.done ? '<span class="sw-done">' + icon("check") + "Done</span>" : "") + '</span><span class="sw-effort">Act ' + ACT_NO[a.key] + " · " + (a.done ? (a.save >= 0.5 ? "Could go a bit further" : "Nothing more to switch") : a.effort) + "</span></span>" +
            '<span class="sw-save tnum">' + (a.save >= 0.5 ? "−" + kgFmt(a.save) : "0") + "</span>" +
            '<button type="button" class="sw-tog" role="switch" aria-checked="false" aria-label="' + esc(a.title) + ", saves " + kgFmt(a.save) + ' kg a year" data-action="flip-switch" data-i="' + i + '"><span class="sw-knob"></span></button></li>'
        )
        .join("") +
      '</ul><p class="sw-board-sub">Through others</p><ul>' +
      others
        .map(
          (a) =>
            '<li class="sw-row sw-row-ind"><span class="sw-tile">' + svgPath(SW_ICONS[a.key], 22) + "</span>" +
            '<span class="min0"><span class="display sw-short">' + a.short + (a.done ? '<span class="sw-done">' + icon("check") + "Done</span>" : "") + '</span><span class="sw-effort">Act ' + ACT_NO[a.key] + " · indirect impact</span></span>" +
            '<a class="sw-ind-go" href="/greener-switches/" data-action="jump-switch" data-cat="' + a.key + '">' + esc(a.status) + icon("chevronRight") + "</a></li>"
        )
        .join("") +
      '</ul><div class="sw-foot"><div class="sw-foot-row"><span>' + (base.mine ? "Your footprint" : "A typical footprint") + '</span><span><b class="display tnum" id="sw-foot">' + kgFmt(fp.totalYearly) + "</b> kg a year</span></div>" +
      '<div class="sw-track"><div class="sw-bar" id="sw-bar" style="width:100%"></div></div><div class="display tnum sw-saved" id="sw-saved">Flip a switch to see the saving</div></div></div>';
    const bubbles = areas
      .map((a, i) => {
        const size = Math.round(40 + Math.sqrt(a.save / Math.max(1, ...areas.map((x) => x.save))) * 48);
        return (
          '<div class="sw-stem" style="left:' + a.ex + "%;height:" + ((a.save / maxSave) * 100).toFixed(2) + "%;border-color:" + a.panel + '"></div>' +
          '<div class="sw-pin" style="left:' + a.ex + "%;bottom:" + ((a.save / maxSave) * 100).toFixed(2) + '%">' +
          '<a class="sw-bub" href="/greener-switches/" data-action="jump-switch" data-cat="' + a.key + '" aria-label="' + a.short + ": saves " + kgFmt(a.save) + " kg a year, " + a.effort +
          '" style="width:' + size + "px;height:" + size + "px;left:-" + size / 2 + "px;top:-" + size / 2 + "px;background:" + a.panel + ";color:" + a.panelInk + ";animation-delay:" + (0.2 + i * 0.12).toFixed(2) + 's">' +
          svgPath(SW_ICONS[a.key], Math.round(size * 0.36)) + "</a>" +
          '<span class="sw-blab" style="bottom:' + (size / 2 + 8) + 'px"><span class="display">' + a.short + '</span><span class="display tnum sw-blab-kg">−' + kgFmt(a.save) + " kg</span><span>" + a.effort.split(" · ")[1] + "</span></span></div>"
        );
      })
      .join("") +
      // Acts 6 and 7: medium impact, low effort, outlined, no kg figure.
      others
        .map(
          (a, i) =>
            '<div class="sw-pin" style="left:' + a.ex + "%;bottom:" + a.ey + '%">' +
            '<a class="sw-bub sw-bub-ind" href="/greener-switches/" data-action="jump-switch" data-cat="' + a.key + '" aria-label="' + a.short + ": indirect impact, " + a.effort +
            '" style="width:58px;height:58px;left:-29px;top:-29px;background:' + a.panel + ";color:" + a.panelInk + ";animation-delay:" + (0.8 + i * 0.12).toFixed(2) + 's">' +
            svgPath(SW_ICONS[a.key], 21) + "</a>" +
            '<span class="sw-blab" style="bottom:37px"><span class="display">' + a.short + '</span><span class="display sw-blab-kg">Indirect</span><span>' + a.effort.split(" · ")[1] + "</span></span></div>"
        )
        .join("");
    const plot =
      '<section class="sw-sec"><div class="sw-sec-head"><div><span class="sw-kicker">Where to start</span><h2 class="display">Impact against effort</h2></div>' +
      "<p>Start top left: big saving, little effort.</p></div>" +
      '<div class="sw-plot"><span class="sw-ytitle">KG SAVED A YEAR ↑</span><div class="sw-area"><div class="sw-quick"></div><div class="sw-vmid"></div><div class="sw-hmid"></div>' +
      ticks.map((f) => '<div class="sw-tick' + (f ? "" : " zero") + '" style="bottom:' + f * 100 + '%"><span class="tnum">' + kgFmt(maxSave * f) + "</span></div>").join("") +
      '<span class="sw-q" style="left:12px;top:12px;color:#2B4128">★ Quick wins</span><span class="sw-q" style="right:4px;top:calc(50% - 26px)">Big, but a habit</span>' +
      '<span class="sw-q" style="left:12px;top:calc(50% + 10px)">Easy extras</span><span class="sw-q" style="right:4px;top:calc(50% + 10px)">Slow burners</span>' +
      bubbles + '</div><div class="sw-xaxis"><span>Once, in minutes</span><i></i><b>MORE EFFORT →</b><i></i><span>Every day, a habit</span></div></div>' +
      '<ul class="sw-legend">' + areas.map((a) => '<li><a href="/greener-switches/" data-action="jump-switch" data-cat="' + a.key + '"><span class="sw-leg-dot" style="background:' + a.panel + ";color:" + a.panelInk + '">' + svgPath(SW_ICONS[a.key], 16) + '</span><span class="display">' + a.short + '</span><span class="tnum sw-leg-kg">−' + kgFmt(a.save) + ' kg</span><span class="sw-leg-when">' + a.effort.split(" · ")[1] + "</span></a></li>").join("") +
      others.map((a) => '<li><a href="/greener-switches/" data-action="jump-switch" data-cat="' + a.key + '"><span class="sw-leg-dot sw-leg-ind" style="background:' + a.panel + ";color:" + a.panelInk + '">' + svgPath(SW_ICONS[a.key], 16) + '</span><span class="display">' + a.short + '</span><span class="sw-leg-kg">Indirect</span><span class="sw-leg-when">' + a.effort.split(" · ")[1] + "</span></a></li>").join("") + "</ul></section>";

    const feats = areas
      .map((a, i) => {
        const drop = a.before > 0 ? Math.round((1 - a.after / a.before) * 100) : 0;
        const paid = a.links.some((l) => l.ref);
        return (
          '<section class="sw-feat' + (i % 2 ? " flip" : "") + '" id="switch-' + a.key + '"><div class="sw-feat-in">' +
          '<div class="sw-panel" style="background:' + a.panel + ";color:" + a.panelInk + '">' + svgPath(SW_ICONS[a.key], 260, ' class="sw-panel-bg"') +
          '<div class="sw-panel-top"><span class="display tnum sw-no">Act ' + ACT_NO[a.key] + '</span><span class="sw-drop"><b class="display tnum" style="color:' + a.dropInk + '">−' + drop + "%</b><span>less CO₂e</span></span></div>" +
          '<div><div class="sw-vs-title">' + esc(a.vsTitle) + '</div><div class="sw-vs"><span>' + esc(a.beforeLabel) + '</span><span class="sw-vs-track"><span class="sw-vs-before"></span></span><b class="display tnum">' + fmtKg(a.before) + "</b>" +
          "<span>" + esc(a.afterLabel) + '</span><span class="sw-vs-track"><span class="sw-vs-after" style="width:' + Math.max(0, Math.min(100, (a.after / (a.before || 1)) * 100)).toFixed(1) + '%"></span></span><b class="display tnum">' + fmtKg(a.after) + "</b></div></div></div>" +
          '<div class="sw-body"><div class="chip-row">' + (a.done ? '<span class="sw-chip dark">' + icon("check") + "Already done</span>" : a.save > 0.5 ? '<span class="sw-chip dark tnum">−' + kgFmt(a.save) + " kg a year " + who + "</span>" : "") +
          '<span class="sw-chip">' + icon("clock") + esc(a.effort) + "</span></div>" +
          '<h2 class="display">' + esc(a.title) + "</h2><p class=\"sw-fact\">" + esc(a.done ? a.fact : firstSentence(a.fact)) + "</p>" + (a.askHtml || "") + (a.links.length && !a.askHtml ? '<div class="sw-offers">' +
          a.links
            .map((l) => {
              const tone = TONES[l.tone] || TONES.leaf;
              const name = l.label === "The Man in Seat 61" ? "Seat 61" : l.label.replace(/^The /, "");
              return (
                '<a class="sw-offer" ' + linkAttrs(a.key, l, "switches") + '><span class="sw-offer-head"><span class="display sw-mono" style="background:' + tone[0] + ";color:" + tone[1] + '">' + esc(monogramText(l.label)) + "</span>" +
                '<span class="min0"><span class="display sw-offer-name">' + esc(l.label) + "</span><span class=\"sw-domain\">" + esc(domainOf(l.url)) + "</span></span>" +
                (l.ref ? '<span class="tag affiliate-tag ml-auto">Affiliate</span>' : "") + "</span>" +
                '<span class="sw-tags">' + (l.tags || []).map((t) => "<span>" + esc(t) + "</span>").join("") + "</span>" +
                '<span class="sw-note">' + esc(l.note) + '</span><span class="sw-go">' + esc(a.verb + " " + name) + icon("arrowRight") + "</span></a>"
              );
            })
            .join("") +
          "</div>" + (paid ? '<p class="sw-disc">Some of these are referral links: if you switch, CO2 Counter may get a reward at no cost to you.</p>' : "") : "") + "</div></div></section>"
        );
      })
      .join("");
    return (
      '<div class="container sw-page">' +
      '<header class="sw-hero"><div class="sw-hero-main"><span class="ab-pill rise">Greener switches · the 7 Acts</span>' +
      '<h1 class="display rise d1">The 7 Acts.<br><span>Up to ' + kgFmt(total) + " kg</span> a year, and more through others.</h1>" +
      '<p class="rise d2">Real Zero\'s <a href="#/habits">7 Acts</a>, worked out ' + (base.mine ? "for your footprint" : "for a typical UK footprint") +
      ". Flip a switch to see the saving.</p></div>" + board + "</header>" +
      plot + feats +
      others
        .map(
          (a, i) =>
            '<section class="sw-feat' + ((areas.length + i) % 2 ? " flip" : "") + '" id="switch-' + a.key + '"><div class="sw-feat-in">' +
            '<div class="sw-panel" style="background:' + a.panel + ";color:" + a.panelInk + '">' + svgPath(SW_ICONS[a.key], 260, ' class="sw-panel-bg"') +
            '<div class="sw-panel-top"><span class="display tnum sw-no">Act ' + ACT_NO[a.key] + '</span><span class="sw-drop"><b class="display">Indirect</b><span>impact</span></span></div>' +
            '<div><b class="display tnum sw-big">' + esc(a.big) + '</b><p class="sw-big-label">' + esc(a.bigLabel) + "</p></div></div>" +
            '<div class="sw-body"><div class="chip-row">' + (a.done ? '<span class="sw-chip dark">' + icon("check") + "Already done</span>" : "") +
            '<span class="sw-chip">' + icon("clock") + esc(a.effort) + "</span></div>" +
            '<h2 class="display">' + esc(a.title) + '</h2><p class="sw-fact">' + esc(a.fact) + "</p>" + a.action +
            '<p class="sw-disc"><a href="' + a.page + '">More on Act ' + ACT_NO[a.key] + " " + icon("arrowRight") + "</a></p></div></div></section>"
        )
        .join("") +

      '<section class="sw-band"><div><h2 class="display">Independent, always</h2><p>Picked for the climate first, mostly links that pay us nothing. Banks are chosen by the bank league table, whether or not a link pays us, and pension picks are never affiliate links. <a href="/about/">How we choose</a></p></div>' +
      '<a class="sw-band-cta" href="#/">' + (base.mine ? "Update your survey" : "Find your biggest switch") + icon("arrowRight") + "</a></section>" +
      '<p class="xs muted sw-note-foot">' + (base.mine ? "Savings are worked out from your latest survey." : "Savings are for a typical UK resident with £" + kgFmt(A.EXAMPLE_SAVINGS) + " in a high-street bank. Take the survey to see yours.") +
      ' <a class="link-btn" href="/how-we-calculate/">How we calculate</a></p></div>'
    );
  }

  const monogramText = (label) => label.replace(/^The /, "").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  // Switchboard: updates in place, so the page doesn't jump while you play.
  function updateSwitchboard() {
    const m = ui.switchModel;
    if (!m || !document.getElementById("sw-foot")) return;
    const saved = m.saves.reduce((t, v, i) => t + (ui.switchOn[i] ? v : 0), 0);
    app.querySelectorAll(".sw-row[data-sw]").forEach((row) => {
      const on = !!ui.switchOn[Number(row.dataset.sw)];
      row.classList.toggle("on", on);
      row.querySelector(".sw-tog").setAttribute("aria-checked", on ? "true" : "false");
    });
    const all = ui.switchOn.every(Boolean);
    app.querySelector(".sw-all").textContent = all ? "Turn all off" : "Turn all on";
    const target = Math.max(0, m.foot - saved);
    const el = document.getElementById("sw-foot");
    const from = Number(el.dataset.v || m.foot);
    el.dataset.v = target;
    const t0 = performance.now();
    cancelAnimationFrame(ui.switchRaf);
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / 700);
      const v = from + (target - from) * (1 - Math.pow(1 - k, 3));
      el.textContent = kgFmt(v);
      if (k < 1) ui.switchRaf = requestAnimationFrame(tick);
    };
    ui.switchRaf = requestAnimationFrame(tick);
    document.getElementById("sw-bar").style.width = ((target / (m.foot || 1)) * 100).toFixed(1) + "%";
    document.getElementById("sw-saved").textContent = saved > 0.5 ? "−" + kgFmt(saved) + " kg a year (" + Math.round((saved / m.foot) * 100) + "% less)" : "Flip a switch to see the saving";
  }

  // On first view the switches turn on one by one, until someone touches one.
  function startSwitchDemo() {
    (ui.switchTimers || []).forEach(clearTimeout);
    if (ui.switchTouched) return updateSwitchboard();
    ui.switchOn = ui.switchModel.saves.map(() => false);
    updateSwitchboard();
    ui.switchTimers = ui.switchModel.saves.map((_, i) =>
      setTimeout(() => {
        if (ui.switchTouched || currentPath() !== "/switches") return;
        ui.switchOn[i] = true;
        updateSwitchboard();
      }, 700 + i * 450)
    );
  }

  function renderAbout() {
    // Signed in with a finished survey: their own answers and footprint (on
    // the figures their survey uses). Otherwise a typical UK resident.
    const mine = !!(currentUser && survey && survey.completedAt);
    const typ = mine ? footprint(survey) : withInputs(liveInputs, () => footprint(D.UK_TYPICAL_SURVEY));
    const p = D.UK_PROFILE;
    const meatDaysUk = Math.round((p.chickenG + p.porkG + p.beefG + p.lambG) / (D.PORTION * 1000));
    const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
    const ownAnswers = () => {
      const s = survey;
      const c = mealCounts(s);
      const meat = Math.round(["chicken", "pork", "beef", "lamb"].reduce((t, k) => t + (c[k] || 0), 0));
      const diet = byKey(D.DIETS, s.meals.diet);
      const meals = s.meals.diet && s.meals.diet !== "meat_eater" && diet ? diet.label : meat ? "Meat on " + plural(meat, "day") + " a week" : "No meat days";
      const kwh = Math.round((s.energy.electricityKwh || 0) * 12);
      const energy = kgFmt(kwh) + " kWh power" + (s.energy.gasKwh > 0 ? ", gas heating" : "") + (s.energy.greenTariff ? ", green tariff" : "");
      const n = (s.flights || []).length;
      const flights = n ? plural(n, "flight") + " this year" : "No flights";
      const modes = DAYS.slice(0, 5).map((d) => s.commute[d]).filter(Boolean);
      const top = modes.sort((a, b) => modes.filter((m) => m === b).length - modes.filter((m) => m === a).length)[0];
      const mode = byKey(D.COMMUTE_MODES, top);
      const commute = !mode || top === "wfh" ? "Mostly from home" : (s.commute.distance || 0) + " km, mostly " + mode.label.toLowerCase().replace(/ \(.*\)/, "");
      const pets = petWords(s.pets);
      const water = kgFmt((s.water.liters || 0) / 30.4 / householdOf(s)) + " litres a day";
      return [meals, energy, flights, commute, pets, water];
    };
    const values = mine
      ? ownAnswers()
      : ["Meat on about " + meatDaysUk + " days a week", kgFmt(p.electricityKwh) + " kWh power, gas heating", "About " + Math.round(p.flightsPerPerson) + " return flight a year",
         Math.round(p.commuteKm * 10) / 10 + " km, mostly by car", "A share of a pet", kgFmt(p.waterLitres) + " litres a day"];
    const answers = [["meals", "Meals"], ["energy", "Home energy"], ["flights", "Flights"], ["commute", "Commute"], ["pets", "Pets"], ["water", "Water"]]
      .map(([k, label], i) => ({ k, label, value: values[i], top: 90 + i * 62, y: 115 + i * 62 }));
    const resultHref = mine ? "#/results" : "#/example";
    const factors = [
      ["DESNZ", "UK greenhouse gas conversion factors", "#3F5B3A", "#F6F1E6"], ["Defra", "UK carbon footprint and food data", "#8FA58A", "#1F2D1C"],
      ["ONS", "UK household statistics", "#7FA3AE", "#14262B"], ["Ofgem", "Typical home energy use", "#D9A441", "#2E2A22"],
      ["DfT", "Travel statistics", "#B8653D", "#FFF7EE"], ["Food", "Peer-reviewed food research", "#6F4E63", "#F6F1E6"],
    ].map(([tag, what, bg, ink], i) => ({ tag, what, bg, ink, left: 317 + i * 62, x: 345 + i * 62 }));
    const dots = [
      ...answers.flatMap((a, i) => [0, 1].map((j) => ({ path: "M260 " + a.y + "C350 " + a.y + " 340 300 425 300", s: 9, c: "#3F5B3A", dur: 2.6, delay: -(i * 0.43 + j * 1.3) }))),
      ...factors.map((f, i) => ({ path: "M" + f.x + " 70C" + f.x + " 150 500 130 500 225", s: 8, c: "#D9A441", dur: 2.2, delay: -(i * 0.37) })),
      ...[0, 1, 2, 3, 4].map((i) => ({ path: "M575 300H740", s: 11, c: i % 2 ? "#D9A441" : "#3F5B3A", dur: 1.6, delay: -(i * 0.32) })),
    ];
    const totalT = (typ.totalYearly / 1000).toFixed(1);
    const mix = typ.breakdown.filter((b) => b.yearly > 0).map((b) => '<span style="width:' + ((b.yearly / typ.totalYearly) * 100).toFixed(1) + "%;background:" + CAT_COLOR[b.key] + '"></span>').join("");
    const paidCount = Object.values(D.USEFUL_LINKS).reduce((t, c) => t + c.items.filter((l) => l.ref).length, 0);
    const answerTile = (q, phone) =>
      phone
        ? '<div class="ab-q-ph"><span class="ab-q-ic">' + svgPath(SW_ICONS[q.k], 16) + '</span><span class="display">' + q.label + "</span></div>"
        : '<div class="ab-src" style="top:' + q.top + 'px"><span class="ab-q-ic">' + svgPath(SW_ICONS[q.k], 18) + '</span><span class="min0"><span class="display ab-src-l">' + q.label + "</span><span class=\"ab-src-v\">" + esc(q.value) + "</span></span></div>";
    const factorChip = (f, phone) =>
      '<span class="display ab-fac' + (phone ? " ph" : "") + '" title="' + f.what + '" style="' + (phone ? "" : "left:" + f.left + "px;") + "background:" + f.bg + ";color:" + f.ink + '">' + f.tag + "</span>";
    const beliefs = [
      ["01", "Count it honestly.", "Real UK factors, shown openly. No guilt, and no inflated numbers to scare you into acting."],
      ["02", "Make the next step obvious.", "A number alone changes nothing. We point to the few changes that matter most for you."],
    ];
    const principles = [
      ["Climate first", "We recommend what cuts the most carbon, even when there's nothing in it for us.", "rgba(63,91,58,.14)", "#3F5B3A", "M5 19c0-8 5-13 14-14 0 9-5 14-14 14ZM5 19l7-7"],
      ["Free options too", "Free guides like The Man in Seat 61 and Fork Ranger sit alongside paid services.", "rgba(127,163,174,.22)", "#3E6672", "M4 6h16M4 12h16M4 18h10"],
      ["Figures stay ours", "No partner can change or sponsor the numbers in your results.", "rgba(217,164,65,.22)", "#8A5F12", "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z"],
      ["Money stays clean", "Banks are picked from the league table, whether or not a link pays us. Pension suggestions are never affiliate links.", "rgba(184,101,61,.18)", "#8C4A2A", "M3 10l9-6 9 6M5 10v8M19 10v8M9.5 10v8M14.5 10v8M3 20h18"],
    ];
    const stats = [
      ["£0", "To use, for everyone. No paywall, no premium tier.", "#3F5B3A", "#F6F1E6"],
      ...(isNativeApp() ? [] : [["£2", "A year, if you'd like to support it. Entirely optional.", "#E8C88A", "#2E2A22"]]),
      [String(paidCount), (paidCount === 1 ? "Affiliate link" : "Affiliate links") + " on the site today.", "rgba(255,252,245,.75)", "#2E2A22"],
    ];
    const tick = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EFE9DC" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ab-tick" d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';
    return (
      '<div class="container ab-page">' +
      '<header class="ab-hero"><span class="ab-pill rise">About CO2 Counter</span>' +
      '<h1 class="display rise d1">Your footprint, counted honestly. <span>Then made smaller.</span></h1>' +
      '<p class="rise d2">CO2 Counter is a free, six-step survey that works out your yearly carbon footprint from official UK data, then shows you the changes that cut it the most.</p>' +
      '<ul class="ab-promises rise d3" aria-label="Our promises">' + ["Free for everyone", "Independent", "Official UK data", isNativeApp() ? "No ads" : "Kept going by supporters"].map((t) => "<li><span>" + tick + "</span>" + t + "</li>").join("") + "</ul></header>" +

      '<section class="ab-sec" aria-labelledby="ab-sources"><div class="ab-src-head"><div><div class="ab-kicker">Where the numbers come from</div><h2 id="ab-sources" class="display ab-h2">Official data in. <span>Your estimate out.</span></h2></div>' +
      '<div class="ab-note">' + svgPath("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v6M12 7.5v.01", 22) + "<p><strong>It's an estimate, not a meter reading.</strong> The factors are UK averages, so your real footprint will differ a little. It's accurate enough to show where your biggest savings are.</p></div></div>" +
      '<div class="ab-diagram"><div class="ab-dia-desk"><svg width="1000" height="470" viewBox="0 0 1000 470" aria-hidden="true" class="ab-lines">' +
      '<g fill="none" stroke="#B7C4A4" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round">' + answers.map((a) => '<path d="M260 ' + a.y + "C350 " + a.y + ' 340 300 425 300"></path>').join("") + "</g>" +
      '<g fill="none" stroke="#E8C88A" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round">' + factors.map((f) => '<path d="M' + f.x + " 70C" + f.x + ' 150 500 130 500 225"></path>').join("") + "</g>" +
      '<path d="M575 300H740" fill="none" stroke="#A3B58F" stroke-width="3" stroke-dasharray="2 8" stroke-linecap="round"></path></svg>' +
      '<div class="ab-lab" style="left:0;top:52px;width:260px">1 · Your answers</div>' + answers.map((q) => answerTile(q)).join("") +
      '<div class="ab-lab honey" style="left:300px;width:400px;top:0;text-align:center">2 · Official UK factors</div>' + factors.map((f) => factorChip(f)).join("") +
      '<div aria-hidden="true">' + dots.map((d) => '<span class="ab-dot" style="width:' + d.s + "px;height:" + d.s + "px;background:" + d.c + ";offset-path:path('" + d.path + "');animation-duration:" + d.dur + "s;animation-delay:" + d.delay.toFixed(2) + 's"></span>').join("") + "</div>" +
      '<div class="ab-core" style="left:425px;top:225px;width:150px;height:150px;border-radius:44px">' + leafMark(86) + "</div>" +
      '<div class="ab-calc"><div class="display">The calculator</div><div>answers × factors</div></div>' +
      '<div class="ab-lab" style="left:740px;top:52px;width:260px">3 · Your footprint</div>' +
      '<a href="' + resultHref + '" class="ab-result"><div class="row-between"><span class="ab-res-l">' + (mine ? "Your footprint" : "Typical UK footprint") + '</span><span class="ab-est">Estimate</span></div>' +
      '<div class="display tnum ab-res-n">' + totalT + "<span> t</span></div><div class=\"ab-res-u\">CO₂e a year</div>" +
      '<div class="ab-mix" aria-hidden="true">' + mix + '</div><div class="ab-res-cta">' + (mine ? "See your results" : "See an example result") + '<span aria-hidden="true">→</span></div></a></div>' +
      '<div class="ab-dia-phone"><div class="ab-lab-ph">1 · Your answers</div><div class="ab-q-grid">' + answers.map((q) => answerTile(q, true)).join("") + "</div>" +
      '<div class="ab-vline" aria-hidden="true"><span></span><span style="animation-delay:-.6s"></span></div>' +
      '<div class="ab-ph-mid"><div class="ab-fac-row">' + factors.map((f) => factorChip(f, true)).join("") + '</div><div class="ab-lab-ph honey">2 · × official UK factors</div>' +
      '<div class="ab-core ph">' + leafMark(64) + "</div></div>" +
      '<div class="ab-vline" aria-hidden="true"><span class="honey"></span><span style="animation-delay:-.6s"></span></div>' +
      '<a href="' + resultHref + '" class="ab-result ph"><div class="row-between"><span class="ab-lab-ph light">3 · ' + (mine ? "Your" : "Typical") + ' footprint</span><span class="ab-est">Estimate</span></div>' +
      '<div class="display tnum ab-res-n">' + totalT + '<span> t</span> <small>CO₂e a year</small></div></a></div></div></section>' +
      '<section class="ab-sec ab-who" aria-labelledby="ab-who"><div class="ab-founder"><div class="ab-kicker">Who runs it</div><h2 id="ab-who" class="display">One independent project, answerable only to the people using it.</h2>' +
      '<div class="ab-person"><span class="display ab-initials" aria-hidden="true">' + esc(initials(OPERATOR_NAME)) + '</span><div><div class="display ab-name">' + esc(OPERATOR_NAME) + '</div><div class="muted">Runs CO2 Counter, UK</div></div></div>' +
      "<p>CO2 Counter isn't owned or funded by any energy company, bank or other business. It's free for everyone" + (isNativeApp() ? "." : ", and people who find it useful can support it for £2 a year.") + "</p>" +
      '<a href="mailto:' + esc(CONTACT_EMAIL) + '" class="ab-mail">' + svgPath("M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 7l9 6 9-6", 18) + esc(CONTACT_EMAIL) + "</a></div>" +
      '<div class="ab-stats">' + stats.map(([big, t, bg, ink]) => '<div class="ab-stat" style="background:' + bg + ";color:" + ink + '"><span class="display tnum">' + big + "</span><span>" + t + "</span></div>").join("") + "</div></section>" +
      '<section class="ab-sec" aria-labelledby="ab-principles"><div class="ab-kicker">What we believe</div><h2 id="ab-principles" class="display ab-h2">The climate comes first. <span>Every time.</span></h2>' +
      '<ol class="ab-beliefs">' + beliefs.map(([n, t, b]) => '<li class="ab-belief"><span class="display tnum ab-bno">' + n + '</span><h3 class="display">' + t + "</h3><p>" + b + "</p></li>").join("") + "</ol>" +
      '<div class="ab-principles">' +
      principles.map(([t, b, bg, ink, d]) => '<div class="ab-pcard"><span class="ab-pic" style="background:' + bg + ";color:" + ink + '">' + svgPath(d, 26) + '</span><h3 class="display">' + t + "</h3><p>" + b + "</p></div>").join("") +
      '</div><p class="ab-see"><a class="link-btn" href="/greener-switches/">See all our greener switches</a></p></section>' +
      '<section class="ab-sec ab-aff" aria-labelledby="ab-aff"><div class="ab-aff-text"><div class="ab-kicker">Affiliate links</div><h2 id="ab-aff" class="display">If we ever earn from a link, you\'ll see this tag.</h2>' +
      "<p>Some links may earn us a small fee, at no extra cost to you. Those links always carry the tag. " +
      (paidCount ? "Right now <strong>" + paidCount + " of our links " + (paidCount === 1 ? "is an affiliate link" : "are affiliate links") + "</strong>" : "Right now <strong>none of our links are affiliate links</strong>") +
      ", and bank or pension suggestions never will be.</p></div>" +
      '<div class="ab-aff-demo"><div class="ab-example">Example only</div><div class="ab-aff-tile"><span class="display ab-aff-mono" aria-hidden="true">GE</span><div class="min0"><div class="ab-aff-name"><span class="display">Green energy supplier</span><span class="tag affiliate-tag">Affiliate</span></div><div class="muted">100% renewable tariff · example.co.uk</div></div></div>' +
      '<div class="ab-aff-hint">' + svgPath("M12 19V5M6 11l6-6 6 6", 22) + "This honey-coloured tag means we'd earn a fee.</div></div></section>" +
      '<section class="ab-band"><div><h2 class="display">Six steps. A few minutes.</h2><p>See your footprint, how it compares to the UK average, and where to start.</p></div>' +
      '<div class="chip-row"><a href="#/" class="ab-cta">Take the survey<span aria-hidden="true">→</span></a><a href="/greener-switches/" class="ab-cta2">See greener switches</a></div></section></div>'
    );
  }

  // ==================== Analytics (owner) ====================
  // Everyone's latest survey worked out with the figures it was taken with,
  // as averages with standard deviations, plus each partner link's
  // click-throughs, affiliate uses and the survey switches that followed.
  // Data comes from owner_analytics() in Supabase (admins only), where
  // people are a scrambled id, never an account.

  const analytics = { loaded: false, loading: false, error: "", data: null, at: null };
  // Owner view of the 7 Acts: invites, letters, verifications. Totals only.
  function actsAnalyticsHtml(a) {
    const head = '<section class="glass an-card"><h2 class="card-title">The 7 Acts</h2>';
    if (!a) return head + '<p class="sm muted">Run the 7 Acts analytics SQL in Supabase to see invites, letters and verified acts here.</p></section>';
    const r = a.referrals || {}, l = a.letters || {}, v = a.verified || {}, e = a.energy_asks || {}, h = a.hand_ticks || {};
    const tile = (label, value, sub) => '<div class="an-tile"><span class="eyebrow">' + label + '</span><b class="display tnum">' + value + '</b><span class="xs muted">' + sub + "</span></div>";
    const n = (x) => kgFmt(Number(x) || 0);
    const latest = (analytics.data && analytics.data.latest) || [];
    const askers = latest.filter((x) => x.data && x.data.energy && x.data.energy.billPayer === "other" && !x.data.energy.greenTariff).length;
    return (
      head + '<p class="sm muted">Invites, letters sent from the app and verified acts. People are scrambled ids, as everywhere here.</p>' +
      '<h3 class="display mt-4">Invites (Act 7)</h3><div class="an-tiles mt-2">' +
      tile("Joined by invite", n(r.joined), n(r.finished) + " finished the survey") +
      tile("People inviting", n(r.inviters), n(r.codes) + " have an invite code") +
      tile("Cut by invitees", r.cut != null ? "−" + n(r.cut) + " kg" : "–", "a year, across " + n(r.cut_people) + " who've measured twice") +
      tile("Act 7 verified", n(v.motivate), "seven invitees finished") + "</div>" +
      ((r.top || []).length
        ? '<div class="an-table an-table-3" role="table"><div class="an-tr an-th" role="row"><span role="columnheader">Top inviters</span><span role="columnheader">Joined</span><span role="columnheader">Finished</span></div>' +
          r.top.map((t) => '<div class="an-tr" role="row"><span role="cell"><code>' + esc(t.u) + '</code></span><span class="tnum" role="cell">' + n(t.joined) + '</span><span class="tnum" role="cell">' + n(t.finished) + "</span></div>").join("") + "</div>"
        : "") +
      '<h3 class="display mt-4">Letters and verified acts</h3><div class="an-tiles mt-2">' +
      tile("MP letters sent", n((l.mp || {}).total), n((l.mp || {}).month) + " in the last 30 days") +
      tile("Act 6 verified", n(v.mobilise), "MP letters sent or BCC'd · " + n(h.mobilise) + " ticked by hand") +
      tile("Bill payer messages", n((l.energy || {}).total), n((l.energy || {}).month) + " in the last 30 days · " + n(h.energy_asked) + " asked by any route") +
      tile("Switch confirmed", n(v.energy), "of " + n(e.links) + " confirm links · " + askers + (askers === 1 ? " person doesn't" : " people don't") + " choose their supplier") + "</div></section>"
    );
  }

  async function loadAnalytics() {
    if (!sb || analytics.loading) return;
    analytics.loading = true;
    try {
      const { data, error } = await sb.rpc("owner_analytics");
      if (error) throw error;
      analytics.data = data || {};
      analytics.error = "";
      // The 7 Acts totals (null until that SQL is run).
      try {
        const acts = await sb.rpc("owner_acts_analytics");
        analytics.acts = acts.error ? null : acts.data;
      } catch (e2) {
        analytics.acts = null;
      }
      // Surveys finished without an account (null until that SQL is run).
      try {
        const gs = await sb.rpc("admin_guest_surveys");
        analytics.guests = gs.error ? null : gs.data;
      } catch (e4) {
        analytics.guests = null;
      }
      // Reports from Report buttons (null until the safety SQL is run).
      try {
        const rp = await sb.rpc("admin_reports");
        analytics.reports = rp.error ? null : rp.data || [];
      } catch (e3) {
        analytics.reports = null;
      }
      analytics.at = new Date();
    } catch (e) {
      analytics.error = (e && e.message) || "Couldn't load the analytics.";
    }
    analytics.loaded = true;
    analytics.loading = false;
    if (currentPath() === "/analytics") render();
  }

  function stats(values) {
    const n = values.length;
    if (!n) return { n: 0, mean: 0, sd: 0, median: 0 };
    const mean = values.reduce((t, v) => t + v, 0) / n;
    const sd = n > 1 ? Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1)) : 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    return { n, mean, sd, median };
  }

  // A saved survey's footprint, worked out with the figures it was taken with.
  function savedFootprint(data) {
    const s = normaliseSurvey(data);
    return withInputs(s.factors || BUILT_IN, () => footprint(s));
  }

  // What counts as a survey switch for each category's links (prev -> next).
  const MEAT_KEYS = ["chicken", "pork", "beef", "lamb"];
  const meatDays = (s) => (s.meals.diet && s.meals.diet !== "meat_eater" ? 0 : D.DAYS.filter((d) => MEAT_KEYS.includes(s.meals[d])).length);
  const carDays = (s) => ["Mon", "Tue", "Wed", "Thu", "Fri"].filter((d) => ["car_petrol", "car_diesel"].includes(s.commute[d])).length;
  const SWITCH_RULES = {
    meals: { label: "ate meat on fewer days", test: (a, b) => meatDays(b) < meatDays(a) },
    commute: { label: "drove to work on fewer days", test: (a, b) => carDays(b) < carDays(a) },
    flights: { label: "took fewer flights", test: (a, b) => b.flights.length < a.flights.length },
    energy: { label: "moved to a renewable tariff", test: (a, b) => !a.energy.greenTariff && !!b.energy.greenTariff },
    banking: { label: "moved to a greener bank", test: (a, b) => D.WHICH_BANK_RATINGS[a.banking.bank] !== "green" && D.WHICH_BANK_RATINGS[b.banking.bank] === "green" },
  };
  // A bank link only counts a move to that bank.
  const bankFor = (label) => (D.BANKS.find((b) => b.label === label) || {}).key;

  function analyticsModel() {
    const d = analytics.data || {};
    const fps = (d.latest || []).map((r) => savedFootprint(r.data));
    const totals = stats(fps.map((f) => f.totalYearly));
    const cats = CATEGORIES.map((key) => {
      const vals = fps.map((f) => (f.breakdown.find((b) => b.key === key) || {}).yearly || 0);
      return { key, ...stats(vals) };
    }).sort((a, b) => b.mean - a.mean);
    // Consecutive surveys per person, oldest first.
    const byUser = {};
    (d.history || []).forEach((h) => (byUser[h.u] ||= []).push({ at: new Date(h.at), s: normaliseSurvey(h.data) }));
    const steps = [];
    Object.entries(byUser).forEach(([u, list]) => {
      list.sort((a, b) => a.at - b.at);
      for (let i = 1; i < list.length; i++) steps.push({ u, at: list[i].at, a: list[i - 1].s, b: list[i].s });
    });
    const clicks = (d.clicks || []).map((c) => ({ ...c, at: new Date(c.at) }));
    const known = new Set();
    const rows = [];
    Object.entries(D.USEFUL_LINKS).forEach(([cat, card]) => {
      const rule = SWITCH_RULES[cat];
      const switchers = rule ? new Set(steps.filter((x) => rule.test(x.a, x.b)).map((x) => x.u)) : new Set();
      card.items.forEach((l) => {
        const key = linkKey(cat, l);
        known.add(key);
        const mine = clicks.filter((c) => c.link === key);
        const bank = cat === "banking" ? bankFor(l.label) : null;
        const test = bank ? (a, b) => a.banking.bank !== bank && b.banking.bank === bank : rule && rule.test;
        const after = test ? new Set(steps.filter((x) => test(x.a, x.b) && mine.some((c) => c.u === x.u && c.at < x.at)).map((x) => x.u)).size : null;
        const all = bank ? new Set(steps.filter((x) => test(x.a, x.b)).map((x) => x.u)).size : switchers.size;
        rows.push({ cat, label: l.label, key, clicks: mine.length, aff: mine.filter((c) => c.aff).length, hasRef: !!l.ref, pending: l.affiliate || "", after, all, rule: bank ? "moved to " + l.label : rule ? rule.label : "" });
      });
    });
    // Links that have since been removed from the site.
    const old = {};
    clicks.filter((c) => !known.has(c.link)).forEach((c) => (old[c.link] ||= []).push(c));
    Object.entries(old).forEach(([key, list]) => rows.push({ cat: key.split(":")[0], label: key.split(":")[1] + " (removed)", key, clicks: list.length, aff: list.filter((c) => c.aff).length, after: null, all: null, rule: "" }));
    // Anonymous breakdowns: latest footprint and change since each
    // person's first survey, for every role and group with 3+ people.
    const latestBy = {};
    (d.latest || []).forEach((r, i) => (latestBy[r.u] = fps[i].totalYearly));
    const changeOf = (us) => {
      const list = us.map((u) => (byUser[u] || [])).filter((l) => l.length > 1);
      if (!list.length) return null;
      const first = list.reduce((t, l) => t + savedFootprint(l[0].s).totalYearly, 0);
      const last = list.reduce((t, l) => t + savedFootprint(l[l.length - 1].s).totalYearly, 0);
      return first ? (last - first) / first : null;
    };
    const breakdown = (label, us) => {
      const vals = us.map((u) => latestBy[u]).filter((v) => v != null);
      return { label, members: us.length, ...stats(vals), change: changeOf(us) };
    };
    // Role: the Account page answer, else the survey's optional question.
    const roleBy = {};
    (d.latest || []).forEach((r) => { const role = r.data && r.data.about && r.data.about.role; if (role) roleBy[r.u] = role; });
    (d.people || []).forEach((p) => { if (p.role) roleBy[p.u] = p.role; });
    const everyone = Array.from(new Set((d.latest || []).map((r) => r.u).concat((d.people || []).map((p) => p.u))));
    const people = everyone.map((u) => ({ u, role: roleBy[u] || null }));
    const roles = ROLES.map(([k, l]) => breakdown(l, people.filter((p) => p.role === k).map((p) => p.u))).concat([breakdown("Not given", people.filter((p) => !p.role).map((p) => p.u))]);
    const groups = (d.groups || []).map((g) => breakdown(g.name, g.members || []));
    // Research consent lives on the profile only.
    const research = (d.people || []).filter((p) => p.research).map((p) => p.u);
    return { totals, cats, rows, people: fps.length, accounts: d.accounts || 0, surveys: (d.history || []).length, clickPeople: new Set(clicks.map((c) => c.u)).size, roles, groups, research, fps, latestUsers: (d.latest || []).map((r) => r.u), roleOf: Object.fromEntries(people.map((p) => [p.u, p.role])) };
  }

  // Opted-in people only: answers and footprint, no name, email or account id.
  function exportResearch() {
    const m = analyticsModel();
    const d = analytics.data || {};
    const ok = new Set(m.research);
    const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const head = ["id", "role", "completed", "total_kg"].concat(CATEGORIES.map((c) => c + "_kg"), ["answers_json"]);
    const lines = [head.map(cell).join(",")];
    (d.latest || []).forEach((r, i) => {
      if (!ok.has(r.u)) return;
      const fp = m.fps[i];
      const s = { ...r.data };
      delete s.factors;
      lines.push([r.u, m.roleOf[r.u] || "", r.data.completedAt || "", Math.round(fp.totalYearly)].concat(CATEGORIES.map((c) => Math.round((fp.breakdown.find((b) => b.key === c) || {}).yearly || 0)), [JSON.stringify(s)]).map(cell).join(","));
    });
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "co2counter-research-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Mean bars with a ±1 SD whisker, laid out like the Results chart.
  function sdChart(cats) {
    const top = niceCeil(Math.max(1, ...cats.map((c) => c.mean + c.sd)));
    const pct = (v) => (Math.max(0, Math.min(v, top)) / top) * 100;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => '<span class="bars-grid" style="bottom:calc(52px + (100% - 52px) * ' + f + ')"><i class="tnum">' + kgFmt(top * f) + "</i></span>").join("");
    return (
      '<div class="bars an-bars"><div class="bars-plot">' + grid +
      cats
        .map(
          (c) =>
            '<div class="bars-col" aria-label="' + esc(CAT_SHORT[c.key]) + ": average " + kgFmt(c.mean) + " kg, standard deviation " + kgFmt(c.sd) + ' kg">' +
            '<span class="bars-track"><span class="bar-you" style="--h:' + pct(c.mean).toFixed(2) + "%;background:" + CAT_COLOR[c.key] + '"></span>' +
            (c.n > 1 ? '<span class="bar-sd" style="--lo:' + pct(c.mean - c.sd).toFixed(2) + "%;--hi:" + pct(c.mean + c.sd).toFixed(2) + '%"></span>' : "") +
            '</span><span class="bars-name">' + esc(CAT_SHORT[c.key]) + '</span><span class="bars-sub tnum">' + kgFmt(c.mean) + " ± " + kgFmt(c.sd) + "</span></div>"
        )
        .join("") +
      "</div></div>"
    );
  }

  // Reports people send with the Report button. Apple expects reported
  // names and groups to be dealt with within 24 hours.
  function reportsCard() {
    const list = analytics.reports;
    if (list == null) return '<section class="glass an-card"><h2 class="card-title">Reports</h2><p class="sm muted">Run run-in-supabase-safety.sql in Supabase to switch on Report and Block.</p></section>';
    const open = list.filter((r) => r.status === "open");
    const done = { dismissed: "Dismissed", name_cleared: "Name cleared", group_removed: "Group removed" };
    const row = (r) =>
      '<li class="an-report' + (r.status === "open" ? " open" : "") + '"><div class="min0"><b>' + esc(r.target_name || "(no name)") + '</b> <span class="xs muted">' + (r.kind === "group" ? "group" : "person") +
      (r.current_name && r.current_name !== r.target_name ? " · now " + esc(r.current_name) : "") + "</span>" +
      '<p class="xs">' + esc(REPORT_REASONS[r.reason] || r.reason) + (r.details ? ": " + esc(r.details) : "") + '</p><p class="xs muted">' + new Date(r.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " · reporter " + esc(r.reporter) + "</p></div>" +
      (r.status === "open"
        ? '<div class="chip-row">' + (r.kind === "group" ? '<button type="button" class="btn btn-sm btn-outline btn-danger" data-action="resolve-report" data-id="' + r.id + '" data-do="remove_group">Remove group</button>' : '<button type="button" class="btn btn-sm btn-outline btn-danger" data-action="resolve-report" data-id="' + r.id + '" data-do="clear_name">Clear name</button>') +
          '<button type="button" class="btn btn-sm btn-outline" data-action="resolve-report" data-id="' + r.id + '" data-do="dismiss">Dismiss</button></div>'
        : '<span class="xs muted">' + (done[r.status] || r.status) + "</span>") + "</li>";
    return (
      '<section class="glass an-card" id="an-reports"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 class="card-title">Reports</h2><span class="xs ' + (open.length ? "clay fw-700" : "muted") + '">' + open.length + " open</span></div>" +
      '<p class="sm muted">From the Report button on people and groups. Deal with open ones within 24 hours: clear an offensive name, remove a group, or dismiss.</p>' +
      (list.length ? '<ul class="an-reports mt-3">' + list.slice(0, 40).map(row).join("") + "</ul>" : '<p class="sm muted mt-3">No reports yet.</p>') +
      (ui.reportMsg ? '<p class="xs mt-2 red" role="status">' + esc(ui.reportMsg) + "</p>" : "") + "</section>"
    );
  }

  function renderAnalytics() {
    if (!analytics.loaded) loadAnalytics();
    let html = '<div class="container analytics-page">' + pageHeader("Analytics", "How people use CO2 Counter", "chart");
    if (!analytics.loaded) return html + stateCard({ kind: "loading", title: "Loading the analytics", text: "Adding up everyone's latest surveys." }) + "</div>";
    if (analytics.error) return html + stateCard({ kind: "error", icon: "refresh", title: "Couldn't load the analytics", text: esc(analytics.error), actions: [["Try again", 'data-action="refresh-analytics"', true]] }) + "</div>";
    // Letters to MPs arrive by BCC with a reference; verifying ticks act 6.
    html +=
      '<section class="glass an-card"><h2 class="card-title">Verify a letter to an MP</h2><p class="sm muted">Letters BCC\'d to ' + MP_COPY + " carry a reference like CO2-ABC123. Enter it to verify that person's act 6, then delete the email.</p>" +
      '<form id="verify-mp-form" class="hb-mp-form mt-3"><input class="input" id="verify-mp-code" placeholder="CO2-ABC123" maxlength="12" aria-label="Reference" /><button type="submit" class="btn btn-green btn-sm">Verify</button></form>' +
      (ui.verifyMsg ? '<p class="xs mt-2 ' + (ui.verifyMsg.ok ? "green-dark" : "red") + '" role="status">' + esc(ui.verifyMsg.text) + "</p>" : "") + "</section>";
    html += reportsCard();
    const m = analyticsModel();
    const t = m.totals;
    const uk = withInputs(liveInputs, () => footprint(D.UK_TYPICAL_SURVEY).totalYearly);
    const tile = (label, value, sub) => '<div class="an-tile"><span class="eyebrow">' + label + '</span><b class="display tnum">' + value + '</b><span class="xs muted">' + sub + "</span></div>";
    html +=
      '<section class="glass an-card"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 class="card-title">Average footprint</h2>' +
      '<span class="xs muted">Latest survey of each person · updated ' + esc(analytics.at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })) +
      ' <button type="button" class="link-btn xs" data-action="refresh-analytics">Refresh</button></span></div>' +
      '<div class="an-tiles">' +
      tile("Average", t.n ? kgFmt(t.mean) : "–", "kg CO₂e a year") +
      tile("Standard deviation", t.n > 1 ? "± " + kgFmt(t.sd) : "–", t.n > 1 ? "two-thirds of people fall within " + kgFmt(Math.max(0, t.mean - t.sd)) + "–" + kgFmt(t.mean + t.sd) : "needs 2+ surveys") +
      tile("Median", t.n ? kgFmt(t.median) : "–", "half are above, half below") +
      tile("People", m.people, m.accounts + " accounts · " + m.surveys + " surveys taken") +
      "</div>" +
      (analytics.guests
        ? '<p class="sm mt-3"><b>+ ' + Number(analytics.guests.total || 0).toLocaleString() + "</b> surveys finished without an account" + (analytics.guests.last30 != null ? " (" + Number(analytics.guests.last30).toLocaleString() + " in the last 30 days)" : "") +
          '. <span class="muted">Only counted: nothing about the person or their answers is saved, so they\'re not in the figures above.</span></p>'
        : "") +
      '<p class="xs muted mt-3">For reference, a typical UK resident on today\'s figures: ' + kgFmt(uk) + " kg. Each survey is worked out with the figures it was taken with.</p></section>";
    html +=
      '<section class="glass an-card"><h2 class="card-title">Average by area</h2><p class="sm muted">Bars show the average; the line shows ± one standard deviation.</p>' +
      (t.n ? '<div class="mt-4">' + sdChart(m.cats) + "</div>" : '<p class="muted mt-3">No finished surveys yet.</p>') +
      "</section>";
    const MIN = 3;
    const table = (title, sub, list) => {
      const shown = list.filter((x) => x.members > 0);
      return (
        '<section class="glass an-card"><h2 class="card-title">' + title + '</h2><p class="sm muted">' + sub + " Rows with fewer than " + MIN + " people with results are hidden so nobody can be picked out.</p>" +
        (shown.length
          ? '<div class="an-table" role="table"><div class="an-tr an-th" role="row"><span role="columnheader">' + (title.includes("role") ? "Role" : "Group") + '</span><span role="columnheader">People</span><span role="columnheader">Average ± SD</span><span role="columnheader">Change since first survey</span></div>' +
            shown.map((x) =>
              '<div class="an-tr" role="row"><span role="cell" class="fw-700">' + esc(x.label) + '</span><span role="cell" class="tnum" data-label="People">' + x.members + "</span>" +
              (x.n >= MIN
                ? '<span role="cell" class="tnum" data-label="Average ± SD">' + kgFmt(x.mean) + " ± " + kgFmt(x.sd) + ' kg</span><span role="cell" class="tnum" data-label="Change since first survey">' + (x.change == null ? "–" : (x.change < 0 ? "▼ " : "▲ ") + Math.abs(Math.round(x.change * 100)) + "%") + "</span>"
                : '<span role="cell" class="muted xs" data-label="Average ± SD">Fewer than ' + MIN + ' with results</span><span role="cell" data-label="Change since first survey"></span>') +
              "</div>"
            ).join("") + "</div>"
          : '<p class="muted mt-3">Nobody yet.</p>') +
        "</section>"
      );
    };
    html += actsAnalyticsHtml(analytics.acts);
    html += table("By role", "From the optional \"What best describes your work?\" in the survey (Money step).", m.roles) + table("By group", "Groups people have made on the Friends page.", m.groups);
    html +=
      '<section class="glass an-card"><h2 class="card-title">Research data</h2><p class="sm muted">' + m.research.length + (m.research.length === 1 ? " person has" : " people have") +
      " opted in to sharing their answers for research (Account page). The download has their answers and footprints with a scrambled id instead of any name or email, and their role if given.</p>" +
      '<button type="button" class="btn btn-outline btn-sm mt-3" data-action="export-research"' + (m.research.length ? "" : " disabled") + ">Download research data (CSV)</button></section>";
    const groups = [...new Set(m.rows.map((r) => r.cat))];
    const totalClicks = m.rows.reduce((a, r) => a + r.clicks, 0);
    html +=
      '<section class="glass an-card"><h2 class="card-title">Partner links</h2><p class="sm muted">Counted once per person. <b>Switched after clicking</b> is people who clicked the link and, in a later survey, made that change; the number in brackets is everyone who made it.</p>' +
      '<p class="xs muted mt-1">' + totalClicks + " click-throughs from " + m.clickPeople + (m.clickPeople === 1 ? " person" : " people") + ".</p>" +
      '<div class="an-table" role="table"><div class="an-tr an-th" role="row"><span role="columnheader">Site</span><span role="columnheader">Click-throughs</span><span role="columnheader">Affiliate uses</span><span role="columnheader">Switched after clicking</span></div>' +
      groups
        .map((g) => {
          const rows = m.rows.filter((r) => r.cat === g);
          const rule = SWITCH_RULES[g];
          return (
            '<div class="an-group" role="row"><span role="cell">' + esc((D.EXPLAINERS[g] || {}).title || g) + (rule ? ' <span class="xs muted">· a switch is when someone ' + esc(rule.label) + "</span>" : "") + "</span></div>" +
            rows
              .map(
                (r) =>
                  '<div class="an-tr" role="row"><span role="cell" class="fw-700">' + esc(r.label) + "</span>" +
                  '<span role="cell" class="tnum" data-label="Click-throughs">' + r.clicks + "</span>" +
                  '<span role="cell" class="tnum" data-label="Affiliate uses">' + (r.hasRef ? r.aff : r.aff ? r.aff : '<span class="muted xs">' + (r.pending ? "no link yet (" + esc(r.pending.replace(/^pending:\s*/, "applied: ")) + ")" : "no programme") + "</span>") + "</span>" +
                  '<span role="cell" class="tnum" data-label="Switched after clicking">' + (r.after == null ? "–" : r.after + ' <span class="muted xs">(' + r.all + ")</span>") + "</span></div>"
              )
              .join("")
          );
        })
        .join("") +
      "</div></section>";
    return html + "</div>";
  }

  // ==================== Friends page ====================

  const friends = { loaded: false, loading: false, rows: [], board: [], myName: "", error: "", msg: "" };

  async function loadFriends() {
    if (!currentUser || !sb || friends.loading) return;
    friends.loading = true;
    const me = currentUser.id;
    try {
      const [{ data: rows }, { data: board }, { data: mine }, prog] = await Promise.all([
        sb.from("friendships").select("*").or("requester_id.eq." + me + ",addressee_id.eq." + me),
        sb.rpc("friends_footprints"),
        sb.from("profiles").select("display_name").eq("id", me).maybeSingle(),
        // Most improved; missing until the SQL is run, which is fine.
        sb.rpc("friends_progress").then((x) => x, () => ({ data: null })),
      ]);
      friends.progress = (prog && !prog.error && prog.data) || [];
      // The feed and cheers; missing until the feed SQL is run.
      const [feed, cheers] = await Promise.all([
        sb.rpc("friends_feed").then((x) => x, () => ({ error: true })),
        sb.rpc("my_cheers").then((x) => x, () => ({ error: true })),
      ]);
      friends.feedReady = !!(feed && !feed.error && Array.isArray(feed.data));
      friends.feed = friends.feedReady ? feed.data.filter((x) => x && x.post_key && x.at && !isNaN(new Date(x.at))) : [];
      friends.cheersGot = (cheers && !cheers.error && Number(cheers.data)) || 0;
      await loadGroups();
      // People you've blocked (missing until the safety SQL is run).
      const bl = await sb.rpc("my_blocks").then((x) => x, () => ({ error: true }));
      friends.safetyReady = !!(bl && !bl.error && Array.isArray(bl.data));
      friends.blocks = friends.safetyReady ? bl.data : [];
      const list = rows || [];
      const otherIds = [...new Set(list.map((r) => (r.requester_id === me ? r.addressee_id : r.requester_id)))];
      const names = {};
      if (otherIds.length) {
        const { data: profs } = await sb.from("profiles").select("id, display_name").in("id", otherIds);
        (profs || []).forEach((p) => (names[p.id] = p.display_name || "Friend"));
      }
      friends.rows = list.map((r) => {
        const otherId = r.requester_id === me ? r.addressee_id : r.requester_id;
        return { id: r.id, status: r.status, otherId, name: names[otherId] || "Someone", iAsked: r.requester_id === me };
      });
      friends.board = (board || []).slice().sort((a, b) => a.total_yearly - b.total_yearly);
      friends.myName = (mine && mine.display_name) || "";
    } catch (e) {
      friends.error = "Couldn't load your friends. Check your connection and try again.";
    }
    friends.loaded = true;
    friends.loading = false;
    if (currentPath() === "/friends" || currentPath() === "/account") render();
  }

  // ---------- groups ----------
  // Anyone can start a group and share its code; members see each other's
  // names and yearly totals (group_board in Supabase), never answers.
  async function loadGroups() {
    try {
      const { data, error } = await sb.rpc("my_groups");
      if (error) throw error;
      friends.groups = (Array.isArray(data) ? data : []).filter((g) => g && g.id && g.code);
      friends.groupsReady = Array.isArray(data);
    } catch (e) {
      friends.groups = [];
      friends.groupsReady = false; // the SQL hasn't been run yet
    }
    if (!friends.groups.some((g) => g.id === ui.groupSel)) ui.groupSel = friends.groups.length ? friends.groups[0].id : null;
    if (ui.groupSel) await loadGroupBoard(ui.groupSel);
  }

  async function loadGroupBoard(id) {
    try {
      const { data } = await sb.rpc("group_board", { p_group: id });
      friends.groupBoards = { ...(friends.groupBoards || {}), [id]: (data || []).slice().sort((a, b) => (a.total_yearly == null) - (b.total_yearly == null) || a.total_yearly - b.total_yearly) };
    } catch (e) {}
  }

  async function groupAction(fn, okMsg) {
    friends.groupMsg = "";
    friends.groupOk = false;
    try {
      const r = await fn();
      if (r && r.error) throw r.error;
      friends.groupMsg = typeof okMsg === "function" ? okMsg(r) : okMsg;
      friends.groupOk = true;
      return r;
    } catch (e) {
      const msg = (e && e.message) || "";
      // Before the groups SQL is run the functions don't exist yet.
      friends.groupMsg = /does not exist|could not find the function|schema cache/i.test(msg)
        ? "Groups aren't switched on yet." + (ui.isAdmin ? " Run run-in-supabase-groups.sql in Supabase to switch them on." : " Please try again soon.")
        : msg || "Something went wrong. Please try again.";
    } finally {
      await loadGroups();
      render();
    }
  }

  // ---------- notifications (app only) ----------
  // Sunday reminder: scheduled on the phone itself (no server), every Sunday
  // at 10am with your next big switch, until Acts 1 to 4 are all done.
  // Friends' activity (iOS): Apple push, sent by the push-notify function
  // when a friend retakes the survey, cheers you on, or accepts your request.
  // Both are offered once, and can be switched on or off on the Account page.
  const KEY_SUNDAY = "co2_notify_sunday"; // "on" | "off"
  const KEY_FEEDPUSH = "co2_notify_feed"; // "on" | "off"
  const KEY_PUSHTOKEN = "co2_push_token";
  const SUNDAY_ID = 7001;
  const NOTIF_OFF_MSG = "Notifications are off for CO2 Counter. To allow them, open your phone's Settings, then Notifications, then CO2 Counter.";
  const nativePlugins = {};
  const NO_PLUGIN_MSG = "This build of the app can't reach your phone's notifications. Please update the app.";
  const plugin = (name) => {
    if (!isNativeApp() || !window.Capacitor.registerPlugin) return null;
    return nativePlugins[name] || (nativePlugins[name] = window.Capacitor.registerPlugin(name));
  };
  const canFeedPush = () => isNativeApp() && !!window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "ios";
  const switchesLeft = (acts) => (survey && survey.completedAt ? (acts || habitActs().acts).slice(0, 4).filter((a) => !a.done) : null);
  function sundayText(left) {
    const top = left.slice().sort((a, b) => (b.save || 0) - (a.save || 0))[0];
    return {
      title: "Your Sunday switch",
      body: top.name + (top.save >= 0.5 ? ": could save about " + kgFmt(top.save) + " kg a year." : ".") + " " + (left.length === 4 ? "4 big switches to go." : 4 - left.length + " of 4 big switches done."),
    };
  }
  let sundaySig = null;
  async function syncSunday(acts) {
    const LN = plugin("LocalNotifications");
    if (!LN) return;
    const left = switchesLeft(acts);
    const on = lsGet(KEY_SUNDAY, "") === "on" && left && left.length > 0;
    const t = on ? sundayText(left) : null;
    const sig = on ? t.title + "|" + t.body : "off";
    if (sig === sundaySig) return;
    sundaySig = sig;
    try {
      await LN.cancel({ notifications: [{ id: SUNDAY_ID }] });
      if (on) await LN.schedule({ notifications: [{ id: SUNDAY_ID, title: t.title, body: t.body, schedule: { on: { weekday: 1, hour: 10, minute: 0 }, allowWhileIdle: true }, extra: { route: "#/habits" } }] });
    } catch (e) {
      sundaySig = null;
    }
  }
  async function turnOnSunday() {
    const LN = plugin("LocalNotifications");
    if (!LN) { ui.flash = NO_PLUGIN_MSG; render(); return; }
    try {
      let perm = await LN.checkPermissions();
      if (perm.display !== "granted") perm = await LN.requestPermissions();
      if (perm.display !== "granted") {
        lsSet(KEY_SUNDAY, "off");
        ui.notifBlocked = true;
        ui.flash = NOTIF_OFF_MSG;
      } else {
        lsSet(KEY_SUNDAY, "on");
        ui.flash = "Done. We'll remind you on Sunday mornings until your four big switches are done.";
      }
    } catch (e) {
      ui.flash = "Couldn't switch on reminders. Please try again.";
    }
    sundaySig = null;
    await syncSunday();
    render();
  }
  async function turnOffSunday() {
    lsSet(KEY_SUNDAY, "off");
    sundaySig = null;
    await syncSunday();
    render();
  }
  let pushListening = false;
  async function registerPush() {
    const PN = plugin("PushNotifications");
    if (!PN || !currentUser) return;
    if (!pushListening) {
      pushListening = true;
      await PN.addListener("registration", (t) => {
        ui.pushRegErr = "";
        lsSet(KEY_PUSHTOKEN, t.value);
        if (currentUser && sb) sb.rpc("save_push_token", { p_token: t.value, p_platform: "ios" }).then(() => {}, () => {});
      });
      await PN.addListener("registrationError", (err) => {
        ui.pushRegErr = (err && err.error) || "unknown error";
        ui.notifTest = "Friends' notifications couldn't be set up on this phone" + (err && err.error ? " (" + err.error + ")" : "") + ". Sunday reminders still work.";
        if (currentPath() === "/account") render();
      });
      await PN.addListener("pushNotificationActionPerformed", (a) => {
        const d = (a && a.notification && a.notification.data) || {};
        location.hash = /^#\/[a-z]/.test(d.route || "") ? d.route : "#/friends";
      });
    }
    await PN.register();
  }
  // Ask our server to push to this phone through Apple, and say plainly
  // which step failed if it doesn't arrive.
  async function testRemotePush() {
    const PN = plugin("PushNotifications");
    if (!PN) return "not available in this version of the app.";
    let perm = await PN.checkPermissions();
    if (perm.receive !== "granted") perm = await PN.requestPermissions();
    if (perm.receive !== "granted") return "switched off for CO2 Counter in Settings.";
    ui.pushRegErr = "";
    await registerPush();
    for (let i = 0; i < 20 && !ui.pushRegErr && !lsGet(KEY_PUSHTOKEN, ""); i++) await new Promise((r) => setTimeout(r, 250));
    if (ui.pushRegErr)
      return "this phone couldn't get a push address from Apple (" + ui.pushRegErr + "). " +
        (/aps-environment|entitlement/i.test(ui.pushRegErr) ? "The app needs rebuilding with Push Notifications switched on in Xcode." : "");
    const token = lsGet(KEY_PUSHTOKEN, "");
    if (!token) return "this phone hasn't had a push address from Apple yet. Rebuild the app with Push Notifications switched on in Xcode, then try again.";
    if (lsGet(KEY_FEEDPUSH, "") !== "on") lsSet(KEY_FEEDPUSH, "on");
    try {
      const { error } = await sb.rpc("save_push_token", { p_token: token, p_platform: "ios" });
      if (error) return "couldn't save this phone on our server (" + error.message + "). Is the push SQL from schema.sql run in Supabase?";
    } catch (e) {}
    try {
      const { data } = await sb.auth.getSession();
      const jwt = data && data.session && data.session.access_token;
      const res = await fetch(SUPABASE_URL + "/functions/v1/push-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + jwt },
        body: JSON.stringify({ kind: "test" }),
      });
      if (res.status === 404) return "our push-notify server function isn't deployed.";
      const out = await res.json().catch(() => ({}));
      if (out.error === "Unknown kind") return "our push-notify server function is an old version. Redeploy it from supabase/functions/push-notify.";
      if (out.error) return "the server said: " + out.error;
      if (out.problem === "server") return "the Apple push key isn't set up on our server yet (APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY secrets in Supabase).";
      if (out.problem === "wait") return "wait a few seconds between tests.";
      if (out.problem === "no-token") return "our server has no push address for you yet. Try again in a moment.";
      if (out.ok) return "sent. It should arrive in a few seconds.";
      const why = String((out.results || []).find((r) => r !== "ok") || "");
      const hint = /InvalidProviderToken/.test(why) ? " The APNs Key ID, Team ID or .p8 key on the server don't match."
        : /DeviceTokenNotForTopic|TopicDisallowed/.test(why) ? " The app's bundle ID doesn't match APNS_BUNDLE_ID."
        : /gone/.test(why) ? " Apple didn't recognise this phone's address; reopen the app and try again."
        : "";
      return "Apple refused it (" + why.replace(/^error /, "") + ")." + hint;
    } catch (e) {
      return "couldn't reach our server (" + ((e && e.message) || "network") + ").";
    }
  }
  async function turnOnFeedPush() {
    const PN = plugin("PushNotifications");
    if (!PN) { ui.flash = NO_PLUGIN_MSG; render(); return; }
    try {
      let perm = await PN.checkPermissions();
      if (perm.receive !== "granted") perm = await PN.requestPermissions();
      if (perm.receive !== "granted") {
        lsSet(KEY_FEEDPUSH, "off");
        ui.notifBlocked = true;
        ui.flash = NOTIF_OFF_MSG;
      } else {
        lsSet(KEY_FEEDPUSH, "on");
        await registerPush();
        ui.flash = "Done. We'll tell you when friends retake the survey or cheer you on.";
      }
    } catch (e) {
      ui.flash = "Couldn't switch on notifications. Please try again.";
    }
    render();
  }
  async function forgetPushToken() {
    const t = lsGet(KEY_PUSHTOKEN, "");
    if (t && sb && currentUser) {
      try {
        await sb.rpc("remove_push_token", { p_token: t });
      } catch (e) {}
    }
  }
  async function turnOffFeedPush() {
    lsSet(KEY_FEEDPUSH, "off");
    await forgetPushToken();
    render();
  }
  // Tell friends (through push-notify) about something you just did. Runs on
  // the website too, so app users hear about friends who use the site.
  async function notifyFriends(body) {
    if (!sb || !currentUser) return;
    try {
      const { data } = await sb.auth.getSession();
      const token = data && data.session && data.session.access_token;
      if (!token) return;
      await fetch(SUPABASE_URL + "/functions/v1/push-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
    } catch (e) {}
  }
  let notifStarted = false;
  function notifStart() {
    if (!isNativeApp()) return;
    if (!notifStarted) {
      notifStarted = true;
      const LN = plugin("LocalNotifications");
      if (LN)
        Promise.resolve(LN.addListener("localNotificationActionPerformed", (a) => {
          const r = a && a.notification && a.notification.extra && a.notification.extra.route;
          location.hash = r || "#/habits";
        })).catch(() => {});
    }
    syncSunday();
    if (currentUser && canFeedPush() && lsGet(KEY_FEEDPUSH, "") === "on") registerPush().catch(() => {});
    // Turned down before? Show how to allow them, on the Account page.
    const LN = plugin("LocalNotifications");
    if (LN && LN.checkPermissions)
      Promise.resolve(LN.checkPermissions()).then((perm) => {
        const blocked = !!perm && perm.display === "denied";
        if (blocked !== !!ui.notifBlocked) {
          ui.notifBlocked = blocked;
          if (currentPath() === "/account") render();
        }
      }).catch(() => {});
  }
  const notifCard = (id, title, text, onAction, onLabel, noAction) =>
    '<section class="glass notif-offer" aria-labelledby="' + id + '"><span class="notif-ic" aria-hidden="true">' + icon("bell") + '</span><div class="min0 grow"><h2 id="' + id + '" class="display">' + title + '</h2><p class="sm muted">' + text + "</p>" +
    '<div class="chip-row mt-3"><button type="button" class="btn btn-green btn-sm" data-action="' + onAction + '">' + onLabel + '</button><button type="button" class="btn btn-outline btn-sm" data-action="' + noAction + '">No thanks</button></div></div></section>';
  function sundayOffer(acts) {
    if (!isNativeApp() || lsGet(KEY_SUNDAY, "")) return "";
    const left = switchesLeft(acts);
    if (!left || !left.length) return "";
    return notifCard("nf-sun", "A nudge on Sundays?", "One reminder each Sunday morning with your next big switch, until all four are done.", "notif-sunday-on", "Remind me on Sundays", "notif-sunday-no");
  }
  function feedOffer() {
    if (!canFeedPush() || lsGet(KEY_FEEDPUSH, "")) return "";
    if (!friends.rows.some((f) => f.status === "accepted")) return "";
    return notifCard("nf-feed", "Know when friends make a move", "Get a notification when a friend retakes the survey, cheers you on or accepts your request.", "notif-feed-on", "Turn on", "notif-feed-no");
  }
  function notifSettingsCard() {
    if (!isNativeApp()) return "";
    const row = (title, text, on, action) =>
      '<div class="acc-row"><span class="acc-row-text"><b class="display">' + title + "</b>" + text + "</span>" +
      '<button type="button" class="notif-switch' + (on ? " on" : "") + '" role="switch" aria-checked="' + on + '" aria-label="' + title + '" data-action="' + action + '"><span></span></button></div>';
    return (
      '<section class="glass acc-box" aria-labelledby="acc-notif"><h2 id="acc-notif" class="display">Notifications</h2>' +
      row("Sunday reminder", "Your next big switch, each Sunday morning until all four are done.", lsGet(KEY_SUNDAY, "") === "on", "notif-sunday-toggle") +
      (canFeedPush() ? row("Friends' activity", "When friends retake the survey, cheer you on or accept your request.", lsGet(KEY_FEEDPUSH, "") === "on", "notif-feed-toggle") : "") +
      // iPhone only asks once: if notifications were turned down, say how to allow them.
      (ui.notifBlocked
        ? '<div class="notif-blocked" role="status"><p class="sm">Notifications are switched off for CO2 Counter in your iPhone\'s Settings. Allow them there, then come back and switch these on.</p>' +
          '<button type="button" class="btn btn-green btn-sm" data-action="open-app-settings">Open Settings</button></div>'
        : "") +
      // A quick way to check notifications reach this phone.
      '<div class="notif-test"><button type="button" class="btn btn-outline btn-sm" data-action="notif-test">' + icon("bell") + " Send a test notification</button>" +
      (ui.notifTest ? '<p class="xs muted" role="status">' + esc(ui.notifTest) + "</p>" : "") + "</div>" +
      "</section>"
    );
  }

  // ---------- report and block ----------
  // A small "..." button on people and groups opens a sheet to report them
  // to us or block them. Blocking removes the friendship, stops new
  // requests and hides them from your group boards.
  const REPORT_REASONS = { offensive_name: "Offensive name", harassment: "Harassment or bullying", spam: "Spam or fake account", other: "Something else" };
  const safetyBtn = (kind, id, name) =>
    id ? '<button type="button" class="fr-more-btn" data-action="safety" data-kind="' + kind + '" data-id="' + esc(id) + '" data-name="' + esc(name || "") + '" aria-label="' + (kind === "user" ? "Report or block " : "Report ") + esc(name || "") + '">' + icon("more") + "</button>" : "";
  function openSafety() {
    const sf = ui.safety;
    if (!sf) return closeModal();
    const person = sf.kind === "user";
    const reasons = Object.keys(REPORT_REASONS).map((k) =>
      '<label class="sf-reason"><input type="radio" name="sf-reason" value="' + k + '"' + (sf.reason === k ? " checked" : "") + " /> " + REPORT_REASONS[k] + "</label>").join("");
    const body = sf.done
      ? '<p class="sheet-lede">' + esc(sf.done) + '</p><button type="button" class="btn btn-green mt-2 modal-close" data-action="close-modal">Done</button>'
      : '<section class="sheet-panel"><span class="eyebrow">Report</span><p class="sm muted">' + (person ? "Tell us if their name is offensive, or they're harassing you or spamming." : "Tell us if this group's name is offensive or it's being used for spam.") + " We review every report within 24 hours.</p>" +
        '<div class="sf-reasons">' + reasons + "</div>" +
        '<label class="xs fw-700">Anything else? (optional)<textarea class="input" id="sf-details" rows="2" maxlength="500">' + esc(sf.details || "") + "</textarea></label>" +
        '<button type="button" class="btn btn-outline mt-2" data-action="safety-report"' + (sf.busy ? " disabled" : "") + ">Send report</button></section>" +
        (person
          ? '<section class="sheet-panel"><span class="eyebrow">Block</span><p class="sm muted">Removes ' + esc(sf.name || "them") + " from your friends, stops them sending you requests and hides them from your group boards. They aren't told.</p>" +
            (sf.confirmBlock
              ? '<div class="chip-row mt-2"><button type="button" class="btn btn-danger" data-action="safety-block"' + (sf.busy ? " disabled" : "") + ">Yes, block " + esc(sf.name || "them") + '</button><button type="button" class="btn btn-outline" data-action="safety-unconfirm">Cancel</button></div>'
              : '<button type="button" class="btn btn-outline btn-danger mt-2" data-action="safety-confirm">Block ' + esc(sf.name || "them") + "</button>") +
            "</section>"
          : "") +
        (sf.error ? '<p class="xs red mt-2" role="status">' + esc(sf.error) + "</p>" : "");
    modalRoot.innerHTML =
      '<div class="modal-backdrop sheet-backdrop" data-action="close-modal"><div class="sheet sf-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-body">' +
      '<div class="sheet-head"><div class="min0"><h2 id="sheet-title" class="display">' + esc(sf.name || (person ? "This person" : "This group")) + '</h2><p class="sheet-habit">' + (person ? "Report or block" : "Report this group") + "</p></div>" +
      '<button type="button" class="sheet-close modal-close" data-action="close-modal" aria-label="Close">' + icon("x") + "</button></div>" + body + "</div></div></div>";
    document.body.classList.add("modal-open");
  }
  const safetyErr = (e) => {
    const m = (e && e.message) || "";
    return /does not exist|could not find the function|schema cache/i.test(m) ? "Reporting isn't switched on yet. Please email " + CONTACT_EMAIL + " instead." : m || "Something went wrong. Please try again.";
  };
  function blockedHtml() {
    const list = friends.blocks || [];
    if (!list.length) return "";
    return '<div class="fr-label">Blocked</div><div class="fr-plist">' + list.map((b) =>
      '<div class="fr-prow">' + frAv(b.user_id, b.name, 28) + '<span class="grow fw-600 truncate">' + esc(b.name) + '</span><button type="button" class="fr-btn ghost" data-action="unblock" data-id="' + esc(b.user_id) + '">Unblock</button></div>').join("") + "</div>";
  }

  function groupsHtml() {
    const groups = friends.groups || [];
    const g = groups.find((x) => x.id === ui.groupSel);
    let body;
    if (!groups.length) body = '<p class="sm muted mt-3">Start a group for your team, ward, class or friends, then share its code. Members see each other\'s yearly totals, never answers.</p>';
    else {
      const rows = (friends.groupBoards || {})[g.id] || [];
      const done = rows.filter((r) => r.total_yearly != null);
      const maxT = Math.max(1, ...done.map((r) => Number(r.total_yearly)));
      const avg = done.length ? done.reduce((t, r) => t + Number(r.total_yearly), 0) / done.length : 0;
      const changes = rows.filter((r) => r.surveys > 1 && r.first_total > 0);
      const change = changes.length ? changes.reduce((t, r) => t + (r.latest_total - r.first_total), 0) / changes.reduce((t, r) => t + Number(r.first_total), 0) : null;
      const link = PRODUCTION_URL + "#/friends?join=" + g.code;
      body =
        (groups.length > 1
          ? '<div class="chip-row group-tabs mt-3" role="tablist" aria-label="Your groups">' + groups.map((x) => '<button type="button" role="tab" aria-selected="' + (x.id === g.id) + '" class="btn btn-sm ' + (x.id === g.id ? "btn-green" : "btn-outline") + '" data-action="select-group" data-id="' + x.id + '">' + esc(x.name) + "</button>").join("") + "</div>"
          : "") +
        '<div class="group-head mt-3"><div class="min0 grow"><h3 class="display group-name">' + esc(g.name) + '</h3><p class="xs muted">' + g.members + (g.members === 1 ? " member" : " members") + (g.is_owner ? " · you started it" : "") + "</p></div>" +
        '<button type="button" class="btn btn-sm ' + (ui.groupShare ? "btn-green" : "btn-outline") + ' group-share-btn" data-action="group-share" aria-expanded="' + !!ui.groupShare + '">' + icon("link") + " Share</button>" + (g.is_owner ? "" : safetyBtn("group", g.id, g.name)) + "</div>" +
        (ui.groupShare
          ? '<div class="group-code"><span class="min0"><span class="xs muted">Invite code</span><b class="display tnum">' + esc(g.code) + "</b></span>" +
            '<button type="button" class="btn btn-sm btn-outline" data-action="copy-group" data-link="' + esc(link) + '" data-code="' + esc(g.code) + '">' + icon("copy") + " Copy</button>" +
            '<button type="button" class="btn btn-sm btn-green" data-action="group-share-send" data-link="' + esc(link) + '" data-code="' + esc(g.code) + '">' + icon("link") + " Share</button></div>"
          : "") +
        '<div class="group-stats mt-3"><div><span class="eyebrow">Average</span><b class="display tnum">' + (done.length ? (avg / 1000).toFixed(1) + " t" : "–") + '</b><span class="xs muted">a year · ' + done.length + " with results</span></div>" +
        '<div><span class="eyebrow">Change</span><b class="display tnum ' + (change != null && change < 0 ? "green" : change > 0 ? "clay" : "") + '">' + (change == null ? "–" : (change < 0 ? "▼ " : "▲ ") + Math.abs(Math.round(change * 100)) + "%") + '</b><span class="xs muted">since first surveys</span></div></div>' +
        (done.length
          ? '<ol class="board mt-4">' +
            done.map((r, i) => '<li class="' + (r.is_self ? "me" : "") + '"><span class="board-n display">' + (i + 1) + '</span><span class="board-name">' + esc(r.display_name) + (r.is_self ? " (you)" : "") + (!r.is_self && r.user_id ? safetyBtn("user", r.user_id, r.display_name) : "") + '</span><span class="board-bar"><span style="width:' + ((r.total_yearly / maxT) * 100).toFixed(1) + '%"></span></span><span class="board-t"><b class="display tnum">' + (r.total_yearly / 1000).toFixed(1) + '</b> <small class="muted">t / yr</small></span></li>').join("") +
            "</ol>"
          : '<p class="sm muted mt-3">No one has finished the survey yet.</p>') +
        (rows.length > done.length ? '<p class="xs muted mt-2">' + (rows.length - done.length) + " member" + (rows.length - done.length === 1 ? " hasn't" : "s haven't") + " finished the survey yet.</p>" : "") +
        '<div class="chip-row mt-4"><button type="button" class="btn btn-sm btn-outline" data-action="leave-group" data-id="' + g.id + '">Leave group</button>' +
        (g.is_owner ? '<button type="button" class="btn btn-sm btn-outline btn-danger" data-action="delete-group" data-id="' + g.id + '">Delete group</button>' : "") + "</div>";
    }
    return (
      '<section class="glass guide-card"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 class="display">Groups</h2><span class="muted grp-sub">Teams, wards, classes, anyone</span></div>' +
      (friends.groupMsg ? '<p class="xs mt-2 ' + (friends.groupOk ? "green-dark" : "red") + '" role="status">' + esc(friends.groupMsg) + "</p>" : "") + body + "</section>"
    );
  }

  // The 6-character code from whatever was pasted: the code itself, the
  // invite link, or the whole "Join my group..." message.
  function groupCodeFrom(text) {
    const t = String(text || "").trim();
    const m = t.match(/join=([A-Za-z0-9]{6})(?![A-Za-z0-9])/) || t.match(/\bcode\s*:?\s*([A-Za-z0-9]{6})\b/i) || t.match(/^([A-Za-z0-9]{6})$/);
    return m ? m[1].toUpperCase() : null;
  }

  function groupFormsHtml() {
    const invite = (location.hash.split("?")[1] || "").match(/(?:^|&)join=([A-Za-z0-9]{6})/);
    const open = invite ? "join" : ui.groupForm || "";
    const tile = (k, ic, title, sub) =>
      '<button type="button" class="gs-tile' + (open === k ? " on" : "") + '" data-action="group-form" data-form="' + k + '" aria-expanded="' + (open === k) + '"><span class="gs-ic" aria-hidden="true">' + icon(ic) + '</span><b class="display">' + title + "</b><span>" + sub + "</span></button>";
    return (
      '<section class="glass fr-box fr-gstart" aria-labelledby="gs-h"><h2 id="gs-h" class="display">' + ((friends.groups || []).length ? "Another group?" : "Groups") + "</h2>" +
      '<p class="sm muted">Compare totals with your team, ward, class or family.</p>' +
      '<div class="gs-tiles">' + tile("start", "plus", "Start a group", "Name it, then share the code") + tile("join", "link", "Join a group", "Got a code or a link?") + "</div>" +
      (open === "start"
        ? '<form id="group-create-form" class="gs-form"><input class="input" id="group-name" maxlength="60" minlength="2" required placeholder="e.g. Ward 7, Year 10 science" aria-label="Group name" /><button type="submit" class="btn btn-green">Create</button></form>'
        : open === "join"
          ? (invite ? '<p class="sm green-dark fw-600 mt-3">You\'ve been invited to a group. Press Join to accept.</p>' : "") +
            '<form id="group-join-form" class="gs-form"><input class="input tnum" id="group-code" maxlength="300" required placeholder="Code or link, e.g. 5EBTF4" aria-label="Group code" autocapitalize="characters" spellcheck="false" value="' + (invite ? esc(invite[1].toUpperCase()) : "") + '" /><button type="submit" class="btn btn-green">Join</button></form>'
          : "") +
      "</section>"
    );
  }

  const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

  // "You're 2nd of 5" and what it would take to move up.
  function rankInfo() {
    const board = friends.board;
    const i = board.findIndex((b) => b.is_self);
    if (i < 0 || board.length < 2) return null;
    const me = board[i];
    const best = CATEGORIES.map((c) => ({ c, tip: tipFor(c, survey) })).sort((a, b) => b.tip.saving - a.tip.saving)[0];
    const href = best && best.tip.saving > 0.5 ? "#/explainer/" + best.c : "";
    let nudge;
    if (i === 0) {
      const next = board[1];
      nudge = "You're in the lead, " + kgFmt(next.total_yearly - me.total_yearly) + " kg a year ahead of " + esc(next.display_name) + ". Keep it up!";
    } else {
      const ahead = board[i - 1];
      const gap = me.total_yearly - ahead.total_yearly;
      nudge =
        "You're " + kgFmt(gap) + " kg a year behind " + esc(ahead.display_name) + ". " +
        (href
          ? best.tip.saving >= gap
            ? "<strong>" + esc(capFirst(best.tip.realisticLabel || best.tip.title)) + "</strong> would save about " + kgFmt(best.tip.saving) + " kg and put you ahead."
            : "<strong>" + esc(capFirst(best.tip.realisticLabel || best.tip.title)) + "</strong>, your biggest win, would close " + Math.round((best.tip.saving / gap) * 100) + "% of the gap."
          : "");
    }
    return { label: ordinal(i + 1) + " of " + board.length, nudge, href };
  }

  function mostImprovedHtml() {
    const rows = (friends.progress || [])
      .filter((p) => p.surveys >= 2 && Number(p.first_total) > 0 && Math.round(Number(p.latest_total) - Number(p.first_total)) !== 0)
      .map((p) => ({ ...p, change: Number(p.latest_total) - Number(p.first_total), pct: (Number(p.latest_total) - Number(p.first_total)) / Number(p.first_total) }))
      .sort((a, b) => a.pct - b.pct);
    if (!rows.length) {
      return '<p class="sm muted">Take a new survey every few months. Whoever cuts their footprint the most, compared with their first survey, tops this board. Anyone can win it, whatever their starting point.</p>';
    }
    return (
      '<div class="stack-2">' +
      rows
        .map((p, i) => {
          const down = p.change < 0;
          return (
            '<div class="month-row' + (p.is_self ? " me" : "") + '"><div class="label-row min0"><span class="num-badge' + (i === 0 && down ? " rank-1" : "") + '">' + (i + 1) +
            '</span><span class="sm fw-500 truncate">' + esc(p.is_self ? (friends.myName ? friends.myName + " (you)" : "You") : p.display_name) + "</span></div>" +
            '<div class="label-row shrink0"><span class="xs fw-600 ' + (down ? "green" : p.change > 0 ? "red" : "muted") + '">' + (down ? "▼ " : p.change > 0 ? "▲ " : "") +
            Math.abs(Math.round(p.pct * 100)) + "%</span>" + '<span class="xs muted">' + (down ? "−" : p.change > 0 ? "+" : "") + fixed(Math.abs(p.change)) + " kg</span></div></div>"
          );
        })
        .join("") +
      "</div>" +
      '<p class="xs muted mt-3">Change from each person\'s first survey to their latest. Only people who\'ve done at least two surveys appear.</p>'
    );
  }

  // ---------- Friends: social feed (Glass v2) ----------
  const FR_COLOURS = [["#7FA3AE", "#14262B"], ["#D9A441", "#2E2A22"], ["#B8653D", "#FFF7EE"], ["#8FA58A", "#1F2D1C"], ["#6F4E63", "#F6F1E6"], ["#A3B58F", "#1F2D1C"], ["#E8C88A", "#2E2A22"]];
  function frColour(id, self) {
    if (self) return ["#3F5B3A", "#F6F1E6"];
    let h = 0;
    for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return FR_COLOURS[h % FR_COLOURS.length];
  }
  const frAv = (id, name, size, self, extra) => {
    const [bg, ink] = frColour(id, self);
    return '<span class="fr-av' + (extra ? " " + extra : "") + '" style="width:' + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.36) + "px;background:" + bg + ";color:" + ink + '" aria-hidden="true">' + esc(initials(name) || "?") + "</span>";
  };
  const tonnes = (kg) => (Number(kg) / 1000).toFixed(1);
  const frWhen = (t) => {
    const d = new Date(t), days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days < 1) { const h = Math.floor((Date.now() - d.getTime()) / 3600000); return h < 1 ? "Just now" : h + (h === 1 ? " hour ago" : " hours ago"); }
    if (days === 1) return "Yesterday";
    if (days < 7) return days + " days ago";
    if (days < 14) return "Last week";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
  };

  // Each person's yearly total at a moment, from their retakes in the feed.
  function totalAt(uid, t, events) {
    const mine = events.filter((e) => e.user_id === uid).sort((a, b) => new Date(a.at) - new Date(b.at));
    const before = mine.filter((e) => new Date(e.at) <= t);
    if (before.length) return Number(before[before.length - 1].after_total);
    const after = mine.find((e) => new Date(e.at) > t);
    if (after) return after.before_total == null ? null : Number(after.before_total);
    const b = friends.board.find((x) => x.user_id === uid);
    return b && new Date(b.updated_at || 0) <= t ? Number(b.total_yearly) : null;
  }
  // Last month's standings: who moved up or down, and the circle's net change.
  function monthlyPost() {
    const events = (friends.feed || []).filter((e) => e.kind === "retake" || e.kind === "first");
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const ids = friends.board.map((b) => b.user_id);
    const at = (t) => ids.map((id) => ({ id, v: totalAt(id, t, events) })).filter((x) => x.v != null).sort((a, b) => a.v - b.v);
    const atEnd = at(end), atStart = at(start);
    if (atEnd.length < 2) return null;
    const both = atEnd.filter((x) => atStart.some((y) => y.id === x.id));
    const net = both.reduce((s, x) => s + x.v - atStart.find((y) => y.id === x.id).v, 0);
    const retakes = events.filter((e) => e.kind === "retake" && new Date(e.at) >= start && new Date(e.at) < end).length;
    const month = start.toLocaleDateString(undefined, { month: "long" });
    const rows = atEnd.map((x, i) => {
      const was = atStart.findIndex((y) => y.id === x.id);
      const b = friends.board.find((y) => y.user_id === x.id) || {};
      const move = was < 0 ? "New" : was === i ? "–" : was > i ? "▲ " + (was - i) : "▼ " + (i - was);
      return '<li class="' + (b.is_self ? "me" : "") + '"><span class="fr-n">' + (i + 1) + "</span>" + frAv(x.id, b.display_name, 28, b.is_self) +
        '<span class="fr-mname">' + esc(b.is_self ? "You" : b.display_name) + '</span><span class="fr-move ' + (move[0] === "▲" ? "up" : move[0] === "▼" ? "down" : move === "New" ? "new" : "") + '">' + move + "</span></li>";
    }).join("");
    return {
      at: end, tag: ["Monthly", "green"], name: "CO2 Counter", verb: "monthly standings", av: '<span class="fr-av" style="width:44px;height:44px;font-size:15px;background:#3F5B3A;color:#F6F1E6" aria-hidden="true">CO</span>',
      body: '<div class="fr-pcard dark"><div class="fr-pcard-top"><span class="fr-eyeb">Your circle in ' + esc(month) + "</span>" +
        (both.length && Math.round(net) !== 0 ? '<span><b class="display tnum fr-big honey">' + (net <= 0 ? "−" : "+") + kgFmt(Math.abs(net)) + '</b> <span class="fr-small">kg a year, net</span></span>' : "") +
        '</div><ol class="fr-moves">' + rows + '</ol><p class="fr-small mt-2">' + retakes + (retakes === 1 ? " retake" : " retakes") + " last month</p></div>",
      link: ["Full standings", "#fr-standings"],
    };
  }
  // A nudge from your own results: what moves you up the board.
  function nextMovePost() {
    const board = friends.board, i = board.findIndex((b) => b.is_self);
    if (i < 1 || !survey || !survey.completedAt) return null;
    const ahead = board[i - 1], gap = Number(board[i].total_yearly) - Number(ahead.total_yearly);
    const best = CATEGORIES.map((c) => ({ c, tip: tipFor(c, survey) })).sort((a, b) => b.tip.saving - a.tip.saving)[0];
    if (!best || best.tip.saving < 0.5) return null;
    return {
      at: new Date(), pin: true, tag: ["For you", "honey"], name: "Your next move", verb: "", when: "Based on your latest results", av: frAv(currentUser.id, friends.myName || "You", 44, true),
      body: '<p class="fr-ptext">You\'re ' + kgFmt(gap) + " kg a year behind " + esc(ahead.display_name) + ".</p>" +
        '<div class="fr-pcard tip"><span>' + esc(capFirst(best.tip.realisticLabel || best.tip.title)) + ' saves about <b class="honey">' + kgFmt(best.tip.saving) + " kg</b>" +
        (best.tip.saving >= gap ? " and would put you ahead of " + esc(ahead.display_name) + "." : ", " + Math.round((best.tip.saving / gap) * 100) + "% of the gap.") +
        '</span><a class="fr-btn honey" href="' + catHref(best.c) + '">See how ' + icon("arrowRight") + "</a></div>",
    };
  }
  function feedPosts() {
    const rankOf = (uid) => friends.board.findIndex((b) => b.user_id === uid);
    const posts = (friends.feed || []).map((e) => {
      const who = e.is_self ? "You" : e.display_name;
      const base = { key: e.post_key, uid: e.user_id, kind: e.kind, at: new Date(e.at), name: who, av: frAv(e.user_id, e.display_name, 44, e.is_self), when: frWhen(e.at), social: !e.is_self, mine: e.is_self, cheers: e.cheers || 0, cheered: !!e.cheered, cheerers: e.cheerers || [] };
      // A retake that changed nothing isn't news.
      if (e.kind === "retake" && Math.round(Number(e.after_total) - Number(e.before_total)) === 0) return null;
      if (e.kind === "retake") {
        const before = Number(e.before_total), after = Number(e.after_total), up = after > before;
        const pct = before > 0 ? Math.round((Math.abs(after - before) / before) * 100) : 0;
        const scale = Math.max(10000, before, after) * 1.05;
        const r = rankOf(e.user_id);
        return {
          ...base, verb: "retook the survey", tag: ["Retake", up ? "clay" : "green"],
          body: '<div class="fr-pcard ' + (up ? "up" : "down") + '"><div class="fr-pcard-top"><span><b class="display tnum fr-big">' + (up ? "▲" : "▼") + pct + '%</b> <span class="fw-700">' + (up ? "+" : "−") + kgFmt(Math.abs(after - before)) + " kg a year</span></span>" +
            (r >= 0 && friends.board.length > 1 ? '<span class="fr-small muted">' + (e.is_self ? "You're " : "Now ") + ordinal(r + 1) + " on your board</span>" : "") + "</div>" +
            '<div class="fr-ba"><span>Before</span><span class="fr-track"><span style="width:' + ((before / scale) * 100).toFixed(1) + '%"></span></span><b class="tnum">' + tonnes(before) + " t</b>" +
            '<span>Now</span><span class="fr-track now"><span style="width:' + ((after / scale) * 100).toFixed(1) + '%"></span></span><b class="tnum">' + tonnes(after) + " t</b></div></div>",
          link: ["Compare", "#fr-standings"],
        };
      }
      if (e.kind === "first")
        return { ...base, verb: e.is_self ? "took your first survey" : "took their first survey", tag: ["New", "sky"],
          body: '<p class="fr-ptext">' + (e.is_self ? "Your" : "Their") + " first footprint: <b>" + tonnes(e.after_total) + " t</b> a year.</p>" };
      return { ...base, name: e.display_name, verb: "is now your friend", tag: ["Friends", "sky"], social: true,
        body: "" };
    });
    const extra = [monthlyPost(), nextMovePost()].filter(Boolean);
    return [...extra.filter((p) => p.pin), ...[...posts.filter(Boolean), ...extra.filter((p) => !p.pin)].sort((a, b) => b.at - a.at)];
  }
  function postHtml(p, i) {
    p = { cheers: 0, cheered: false, cheerers: [], ...p };
    const cheer = p.social && p.key
      ? '<button type="button" class="fr-cheer' + (p.cheered ? " on" : "") + '" data-action="cheer" data-key="' + esc(p.key) + '" aria-pressed="' + p.cheered + '">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="' + (p.cheered ? "currentColor" : "none") + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 3 2l-1 4h6a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/></svg>' +
        (p.cheered ? "Cheered" : "Cheer") + ' <span class="tnum">' + p.cheers + "</span></button>"
      : p.mine && p.cheers ? '<span class="fr-cheer static"><span class="tnum">' + p.cheers + "</span> " + (p.cheers === 1 ? "cheer" : "cheers") + "</span>" : "";
    const others = p.cheers - (p.cheered ? 1 : 0) - p.cheerers.length;
    const who = p.cheerers && p.cheerers.length ? esc(p.cheerers.join(", ")) + (others > 0 ? " and " + others + (others === 1 ? " other" : " others") : "") : p.social && p.key ? (p.verb === "is now your friend" ? "Say hello" : "Send some encouragement") : "";
    const foot = cheer || p.link ? '<div class="fr-pfoot">' + cheer + '<span class="fr-cheerers">' + who + "</span>" + (p.link ? '<a href="' + p.link[1] + '" data-action="fr-jump">' + p.link[0] + " →</a>" : "") + "</div>" : "";
    return (
      '<article class="glass fr-post" style="animation-delay:' + (0.05 + Math.min(i, 8) * 0.07).toFixed(2) + 's"><header class="fr-phead">' + p.av +
      '<span class="min0 fr-pwho"><b class="display">' + esc(p.name) + "</b> " + (p.verb ? '<span class="fr-verb">' + esc(p.verb) + "</span>" : "") + '<span class="fr-when">' + esc(p.when || frWhen(p.at)) + "</span></span>" +
      '<span class="fr-tag ' + p.tag[1] + '">' + esc(p.tag[0]) + "</span></header>" + p.body + foot + "</article>"
    );
  }
  // One stack per person (and one for new friends), newest post on top, so a
  // busy circle doesn't turn into a long list. Tap to fan a stack out.
  function feedStacks(posts) {
    const stacks = [], byKey = {};
    posts.forEach((p) => {
      const k = p.uid ? (p.kind === "friend" ? "friends" : "u:" + p.uid) : null;
      if (k && byKey[k]) byKey[k].items.push(p);
      else {
        const st = { key: k, items: [p] };
        if (k) byKey[k] = st;
        stacks.push(st);
      }
    });
    return stacks;
  }
  function stackHtml(st, i) {
    if (st.items.length === 1) return postHtml(st.items[0], i);
    const n = st.items.length - 1, top = st.items[0];
    const open = !!(ui.feedOpen && ui.feedOpen[st.key]);
    const label = st.key === "friends" ? n + " more new " + (n === 1 ? "friend" : "friends") : n + " more from " + (top.mine ? "you" : top.name);
    const btn = (txt) => '<button type="button" class="fr-stack-btn" data-action="feed-stack" data-key="' + esc(st.key) + '" aria-expanded="' + open + '">' + txt + "</button>";
    return open
      ? '<div class="fr-stack open">' + st.items.map((p, j) => postHtml(p, i + j)).join("") + btn("Show less") + "</div>"
      : '<div class="fr-stack closed"><div class="fr-pile" data-n="' + Math.min(n, 2) + '">' + postHtml(top, i) + "</div>" + btn("+" + esc(label)) + "</div>";
  }
  function standingsHtml() {
    const myName = friends.myName || (currentUser.email || "").split("@")[0];
    const tab = ui.standTab === "imp" ? "imp" : "board";
    const nameOf = (b) => (b.is_self ? (friends.myName ? friends.myName + " (you)" : "You") : b.display_name);
    let rows;
    if (tab === "board") {
      const maxT = Math.max(1, ...friends.board.map((b) => Number(b.total_yearly)));
      rows = friends.board.map((b, i) => ({ id: b.user_id, self: b.is_self, name: nameOf(b), w: (Number(b.total_yearly) / maxT) * 100, val: tonnes(b.total_yearly) + " t", cls: "", first: i === 0 }));
    } else {
      rows = (friends.progress || [])
        .filter((p) => p.surveys >= 2 && Number(p.first_total) > 0 && Math.round(Number(p.latest_total) - Number(p.first_total)) !== 0)
        .map((p) => ({ p, pct: (Number(p.latest_total) - Number(p.first_total)) / Number(p.first_total) }))
        .sort((a, b) => a.pct - b.pct)
        .map(({ p, pct }) => ({ id: p.user_id, self: p.is_self, name: nameOf(p), w: Math.min(100, Math.abs(pct) * 400), val: (pct < 0 ? "▼" : pct > 0 ? "▲" : "") + Math.abs(Math.round(pct * 100)) + "%", cls: pct < 0 ? "down" : pct > 0 ? "up" : "" }));
    }
    const latest = friends.board.reduce((t, b) => Math.max(t, new Date(b.updated_at || 0).getTime()), 0);
    return (
      '<section class="glass fr-box" id="fr-standings" aria-labelledby="fr-st-h"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 id="fr-st-h" class="display">Standings</h2>' +
      (latest ? '<span class="xs muted">Updated ' + new Date(latest).toLocaleDateString(undefined, { day: "numeric", month: "long" }) + "</span>" : "") + "</div>" +
      '<div class="fr-tabs" role="tablist" aria-label="Standings">' +
      [["board", "Lowest footprint"], ["imp", "Most improved"]].map(([k, l]) => '<button type="button" role="tab" aria-selected="' + (tab === k) + '" class="' + (tab === k ? "on" : "") + '" data-action="stand-tab" data-tab="' + k + '">' + l + "</button>").join("") + "</div>" +
      (rows.length
        ? '<ol class="fr-stand">' + rows.map((r, i) => '<li class="' + (r.self ? "me" : "") + '"><span class="fr-n' + (r.first && tab === "board" ? " gold" : "") + '">' + (i + 1) + "</span>" + frAv(r.id, r.self ? myName : r.name, 34, r.self) +
            '<span class="min0"><span class="fr-sname">' + esc(r.name) + '</span><span class="fr-sbar ' + r.cls + '"><span style="width:' + r.w.toFixed(1) + '%"></span></span></span><b class="display tnum fr-sval ' + r.cls + '">' + r.val + "</b></li>").join("") + "</ol>"
        : tab === "board"
          ? stateCard({ inline: true, icon: "chart", title: "No one to compare with yet", text: "Add friends to compare yearly totals. Lowest wins.", actions: [["Find a friend", 'data-action="fr-find"', true]] })
          : stateCard({ inline: true, icon: "trendDown", title: "No changes yet", text: "Retake the survey every few months. The biggest cut wins.", actions: [["Update my survey", 'href="#/" data-action="whats-changed"', true]] })) +
      (rows.length ? '<p class="xs muted mt-2">' + (tab === "board" ? "Yearly totals of friends who've finished the survey." : "Change since each person's first survey.") + "</p>" : "") + "</section>"
    );
  }
  function renderFriends() {
    if (!friends.loaded) {
      loadFriends();
      if (friends.error) return '<div class="container">' + stateCard({ kind: "error", icon: "refresh", title: "Couldn't load your friends", text: "Check your connection, then try again.", actions: [["Try again", 'data-action="friends-retry"', true]] }) + "</div>";
      return '<div class="container">' + stateCard({ kind: "loading", title: "Loading your friends", text: "Their totals, your groups and the feed." }) + "</div>";
    }
    // Nothing to show at all: say what went wrong and how to fix it.
    if (friends.error && !(friends.rows || []).length && !(friends.board || []).length)
      return '<div class="container">' + stateCard({ kind: "error", icon: "refresh", title: "Couldn't load your friends", text: "Check your connection, then try again. Your own results are safe on this phone.", actions: [["Try again", 'data-action="friends-retry"', true], ["Go to my results", 'href="#/results"']] }) + "</div>";
    const incoming = friends.rows.filter((f) => f.status === "pending" && !f.iAsked);
    const outgoing = friends.rows.filter((f) => f.status === "pending" && f.iAsked);
    const accepted = friends.rows.filter((f) => f.status === "accepted");
    const rank = accepted.length ? rankInfo() : null;
    const myName = friends.myName || (currentUser.email || "").split("@")[0];
    const meBoard = friends.board.find((b) => b.is_self);
    const myProg = (friends.progress || []).find((p) => p.is_self && p.surveys >= 2 && Number(p.first_total) > 0);
    const myPct = myProg ? Math.round(((Number(myProg.latest_total) - Number(myProg.first_total)) / Number(myProg.first_total)) * 100) : null;
    const pctTxt = myPct == null || myPct === 0 ? "" : '<span class="fr-pct ' + (myPct <= 0 ? "down" : "up") + '">' + (myPct <= 0 ? "▼ " : "▲ ") + Math.abs(myPct) + "%</span>";
    actsTicked();
    const info = ui.actsInfo;
    const done7 = info ? Math.min(7, info.finished || 0) : 0;

    // You
    const me =
      '<section class="glass fr-me rise" aria-label="You"><div class="fr-me-top">' + frAv(currentUser.id, myName, 60, true, "ringed") +
      '<span class="min0 grow"><span class="display fr-me-name">' + esc(myName) + '</span><span class="fr-me-sub">' + (ui.username ? "@" + esc(ui.username) : "") + (ui.username && rank ? " · " : "") + (rank ? esc(rank.label) : "") + "</span></span>" +
      (meBoard ? '<span class="fr-me-t"><b class="display tnum">' + tonnes(meBoard.total_yearly) + "<small> t</small></b>" + pctTxt + "</span>" : "") + "</div>" +
      '<div class="fr-me-stats"><div class="dark"><b class="display tnum">' + (meBoard ? tonnes(meBoard.total_yearly) + "<small> t</small>" : "–") + "</b>" + (pctTxt || '<span class="fr-small">a year</span>') + "</div>" +
      '<div><b class="display tnum">' + accepted.length + '</b><span class="fr-small">' + (accepted.length === 1 ? "friend" : "friends") + "</span></div>" +
      '<div class="cheers"><b class="display tnum">' + (friends.cheersGot || 0) + '</b><span class="fr-small">cheers</span></div></div>' +
      "</section>";

    // Add a friend, waiting, manage
    const manage =
      '<section class="glass fr-box fr-manage" aria-labelledby="fr-add-h"><h2 id="fr-add-h" class="display">Add a friend</h2>' +
      '<form id="friend-form" class="fr-addform fr-search" role="search"><span class="fr-search-ic" aria-hidden="true">' + icon("search") + '</span><input class="input" type="search" id="friend-email" placeholder="Search a username, or type an email" aria-label="Search for a friend by username, or type their email" required autocapitalize="none" autocomplete="off" spellcheck="false" enterkeyhint="search" /><button type="submit" class="btn btn-green">Add</button></form>' +
      '<div id="fr-results" class="fr-results" aria-live="polite">' + frResultsHtml() + "</div>" +
      frSuggestHtml(accepted, outgoing, incoming) +
      (ui.username ? '<p class="xs muted mt-2 fr-myname">Friends can find you as <b>@' + esc(ui.username) + '</b> <button type="button" class="link-btn" data-action="copy-username">Copy</button></p>' : "") +
      (friends.msg ? '<p class="xs mt-2 ' + (friends.msgOk ? "green-dark fw-700" : "red") + '">' + esc(friends.msg) + "</p>" : "") +
      '<p class="xs muted mt-1">Friends see each other\'s yearly totals, never answers.</p>' +
      (outgoing.length
        ? '<div class="fr-label">Waiting for a reply</div>' + outgoing.map((f) => '<div class="fr-prow">' + frAv(f.otherId, f.name, 32, false, "dashed") + '<span class="grow fw-700 truncate">' + esc(f.name) + '</span><button type="button" class="fr-btn ghost" data-action="friend-remove" data-id="' + f.id + '">Cancel</button></div>').join("")
        : "") +
      '<details class="fr-details"' + (ui.frManageOpen ? " open" : "") + "><summary>Manage friends, blocking and your name</summary>" +
      (accepted.length
        ? '<div class="fr-plist">' + accepted.map((f) => '<div class="fr-prow">' + frAv(f.otherId, f.name, 28) + '<span class="grow fw-600 truncate">' + esc(f.name) + '</span><button type="button" class="fr-btn ghost clay" data-action="friend-remove" data-id="' + f.id + '">Remove</button>' + safetyBtn("user", f.otherId, f.name) + "</div>").join("") + "</div>"
        : '<p class="xs muted mt-2">No friends yet.</p>') + blockedHtml() +
      '<form id="name-form" class="fr-nameform"><label class="xs fw-700" for="display-name">Name your friends see</label><span class="fr-addform"><input class="input" id="display-name" maxlength="40" placeholder="e.g. Sam" value="' +
      esc(friends.myName) + '" /><button type="submit" class="btn btn-outline">Save</button></span></form></details></section>';

    // Friends strip
    const people = [
      ...friends.board.filter((b) => !b.is_self).map((b) => ({ id: b.user_id, name: b.display_name, done: true })),
      ...accepted.filter((f) => !friends.board.some((b) => b.user_id === f.otherId)).map((f) => ({ id: f.otherId, name: f.name, done: false })),
    ];
    const leader = friends.board[0];
    const story = (p) => {
      const prog = (friends.progress || []).find((x) => x.user_id === p.id && x.surveys >= 2 && Number(x.first_total) > 0);
      const pct = prog ? Math.round(((Number(prog.latest_total) - Number(prog.first_total)) / Number(prog.first_total)) * 100) : null;
      const lead = leader && leader.user_id === p.id && friends.board.length > 1;
      const badge = lead ? ["1st", "gold"] : pct != null && pct !== 0 ? [(pct < 0 ? "▼" : "▲") + Math.abs(pct) + "%", pct < 0 ? "down" : "up"] : !p.done ? ["New", "new"] : null;
      const ring = !p.done ? "dash" : lead ? "gold" : pct != null && pct > 0 ? "up" : "down";
      return '<li class="fr-story ' + ring + '"><span class="fr-story-av">' + frAv(p.id, p.name, 62) + (badge ? '<span class="fr-badge ' + badge[1] + '">' + badge[0] + "</span>" : "") + '</span><span class="fr-story-n">' + esc(p.name) + "</span></li>";
    };
    const strip =
      '<ul class="fr-strip" aria-label="Your friends">' + people.map(story).join("") +
      '<li class="fr-story dash"><button type="button" class="fr-story-av" data-action="fr-find" aria-label="Add a friend"><span class="fr-av fr-plus" style="width:62px;height:62px">' + icon("plus") + '</span></button><span class="fr-story-n">Add</span></li></ul>';

    const reqs = incoming.map((f) =>
      '<div class="fr-req rise">' + frAv(f.otherId, f.name, 42) + '<span class="grow min0"><b>' + esc(f.name) + "</b> wants to be friends</span>" +
      '<button type="button" class="fr-btn green" data-action="friend-accept" data-id="' + f.id + '">Accept</button>' +
      '<button type="button" class="fr-btn ghost sq" data-action="friend-remove" data-id="' + f.id + '" aria-label="Decline ' + esc(f.name) + '\'s request">' + icon("x") + "</button>" + safetyBtn("user", f.otherId, f.name) + "</div>").join("");

    const posts = feedPosts();
    const stacks = feedStacks(posts);
    const shown = ui.feedShown || 5;
    const feed =
      feedOffer() + '<div class="fr-feedhead"><h2 class="display">Feed</h2></div>' +
      (posts.length && onPhoneScreen() && !ui.feedAll && posts.length > 1
        ? '<div class="fr-stack closed fr-feedpile"><div class="fr-pile" data-n="' + Math.min(posts.length - 1, 2) + '">' + postHtml(posts[0], 0) + "</div>" +
          '<button type="button" class="fr-stack-btn" data-action="feed-all" aria-expanded="false">See all ' + posts.length + " updates</button></div>"
        : posts.length ? stacks.slice(0, shown).map(stackHtml).join("") + (onPhoneScreen() && ui.feedAll ? '<button type="button" class="fr-stack-btn fr-feedless" data-action="feed-all" aria-expanded="true">Show just the latest</button>' : "") +
          (stacks.length > shown ? '<button type="button" class="btn btn-outline btn-sm fr-older" data-action="feed-more">Show older posts</button>' : '<p class="center sm muted">You\'re all caught up</p>')
        : accepted.length
          ? stateCard({ inline: true, icon: "calendar", title: "No news yet", text: "When friends retake the survey, it shows up here. Retake yours to get things going.", actions: [["Update my survey", 'href="#/" data-action="whats-changed"', true]] })
          : stateCard({ inline: true, icon: "user", title: "Your feed is empty", text: "Add friends to see their retakes and cheer them on. Lowest footprint wins.", actions: [["Find a friend", 'data-action="fr-find"', true]] })) +
      (friends.feedReady === false && accepted.length ? '<p class="xs muted center">Cheers and retakes appear once the latest database update is run.</p>' : "");

    return (
      '<div class="container friends-v2 fr-page" data-fs-pill="' + esc(myName) + '" data-fs-unit="' + (meBoard ? kgFmt(meBoard.total_yearly) + ' kg' : '') + '">' + (friends.error ? stateCard({ kind: "error", inline: true, icon: "refresh", title: "Couldn't refresh", text: "Showing what we had. Check your connection.", actions: [["Try again", 'data-action="friends-retry"', true]] }) : "") +
      '<div class="fr-layout"><aside class="fr-side">' + me + manage + groupFormsHtml() + "</aside>" +
      '<main class="fr-feed"><h1 class="display fr-h1">Friends</h1>' + strip + reqs + standingsHtml() + ((friends.groups || []).length || !friends.groupsReady ? groupsHtml() : "") + feed + "</main></div></div>"
    );
  }


  // ---------- finding friends ----------
  // Usernames that start with what you've typed (3 letters or more), as you type.
  const frSearch = { q: "", rows: [], busy: false, off: false };
  let frSearchTimer = null;
  function frResultsHtml() {
    const q = frSearch.q.replace(/^@/, "");
    if (q.length < 3 || q.includes("@")) return "";
    if (frSearch.busy && !frSearch.rows.length) return '<p class="xs muted fr-res-note">Searching…</p>';
    if (!frSearch.rows.length) return frSearch.off ? "" : '<p class="xs muted fr-res-note">No one with a username starting “' + esc(q) + '”. Try their email.</p>';
    const rel = (id) => friends.rows.find((f) => f.otherId === id);
    return '<ul class="fr-res">' + frSearch.rows.map((r) => {
      const f = rel(r.id);
      const state = f ? (f.status === "accepted" ? "Friends" : f.iAsked ? "Asked" : "") : "";
      return '<li>' + frAv(r.id, r.display_name || r.username, 36) + '<span class="min0 grow"><b class="truncate">' + esc(r.display_name || r.username) + '</b><span class="xs muted">@' + esc(r.username) + "</span></span>" +
        (state ? '<span class="fr-res-state">' + state + "</span>" : '<button type="button" class="fr-btn green" data-action="friend-add" data-username="' + esc(r.username) + '">' + (f ? "Accept" : "Add") + "</button>") + "</li>";
    }).join("") + "</ul>";
  }
  function frPaintResults() {
    const box = document.getElementById("fr-results");
    if (box) box.innerHTML = glyphify(frResultsHtml());
  }
  function frSearchInput(v) {
    frSearch.q = String(v || "").trim();
    clearTimeout(frSearchTimer);
    const q = frSearch.q.replace(/^@/, "");
    if (q.length < 3 || q.includes("@") || !sb || frSearch.off) { frSearch.rows = []; frPaintResults(); return; }
    frSearch.busy = true;
    frPaintResults();
    frSearchTimer = setTimeout(async () => {
      const asked = q;
      const { data, error } = await sb.rpc("search_usernames", { q: asked });
      if (frSearch.q.replace(/^@/, "") !== asked) return;
      frSearch.busy = false;
      // Before the database update is run, fall back to the exact lookup on Add.
      if (error) { frSearch.off = true; frSearch.rows = []; }
      else frSearch.rows = data || [];
      frPaintResults();
    }, 250);
  }
  // People in your groups you're not friends with yet.
  function frSuggestHtml(accepted, outgoing, incoming) {
    const known = new Set([...accepted, ...outgoing, ...incoming].map((f) => f.otherId));
    const seen = new Set(), list = [];
    Object.values(friends.groupBoards || {}).forEach((rows) => (rows || []).forEach((r) => {
      if (!r.user_id || r.is_self || known.has(r.user_id) || seen.has(r.user_id)) return;
      seen.add(r.user_id);
      list.push(r);
    }));
    if (!list.length) return "";
    return '<div class="fr-label">From your groups</div><ul class="fr-res">' + list.slice(0, 5).map((r) =>
      '<li>' + frAv(r.user_id, r.display_name, 36) + '<span class="min0 grow"><b class="truncate">' + esc(r.display_name) + "</b></span>" +
      '<button type="button" class="fr-btn green" data-action="friend-add-id" data-id="' + esc(r.user_id) + '">Add</button></li>').join("") + "</ul>";
  }
  async function addFriendId(id) {
    friends.msg = "";
    friends.msgOk = false;
    const { error } = await sb.from("friendships").insert({ requester_id: currentUser.id, addressee_id: id, status: "pending" });
    friends.msg = error ? "Couldn't send the request." : "Request sent.";
    friends.msgOk = !error;
    friends.loaded = false;
    await loadFriends();
  }

  async function addFriend(email) {
    friends.msg = "";
    friends.msgOk = false;
    const clean = email.trim().toLowerCase().replace(/^@/, "");
    if (!clean) return;
    const byEmail = clean.includes("@");
    const { data: foundId, error } = byEmail
      ? await sb.rpc("find_user_by_email", { lookup_email: clean })
      : await sb.rpc("find_user_by_username", { lookup_username: clean });
    const existing = friends.rows.find((f) => f.otherId === foundId);
    if (error) friends.msg = "Something went wrong looking that up.";
    else if (!foundId) friends.msg = byEmail ? "No CO2 Counter account uses that email." : "No CO2 Counter account has that username.";
    else if (foundId === currentUser.id) friends.msg = "That's your own account.";
    else if (existing && existing.status === "accepted") friends.msg = "You're already friends.";
    else if (existing && existing.iAsked) friends.msg = "You've already sent them a request.";
    else if (existing) {
      await sb.from("friendships").update({ status: "accepted" }).eq("id", existing.id);
      friends.msg = "They'd already asked you, so you're now friends.";
      friends.msgOk = true;
    } else {
      const { error: insertError } = await sb.from("friendships").insert({ requester_id: currentUser.id, addressee_id: foundId, status: "pending" });
      friends.msg = insertError ? "Couldn't send the request." : "Request sent.";
      friends.msgOk = !insertError;
    }
    if (friends.msgOk) { frSearch.q = ""; frSearch.rows = []; }
    friends.loaded = false;
    await loadFriends();
  }

  // ==================== Privacy & Terms pages ====================

  function contactLink() {
    return CONTACT_EMAIL ? '<a class="link-btn" href="mailto:' + esc(CONTACT_EMAIL) + '">' + esc(CONTACT_EMAIL) + "</a>" : "[contact email to be added]";
  }

  function legalPage(title, intro, sections) {
    return (
      '<div class="container narrow">' + pageHeader(title, "Last updated " + LEGAL_UPDATED, "info") +
      '<p class="muted lh mb-8">' + intro + '</p><div class="stack-6 mb-10">' +
      sections
        .map(([h, body]) => '<div class="section-card static"><h2 class="fw-600 mb-2">' + esc(h) + '</h2><div class="sm muted lh method">' + body + "</div></div>")
        .join("") +
      "</div></div>"
    );
  }

  const ul = (items) => "<ul>" + items.map((i) => "<li>" + i + "</li>").join("") + "</ul>";
  const operator = () => (OPERATOR_NAME ? esc(OPERATOR_NAME) : "[operator name to be added]");

  function renderPrivacy() {
    return legalPage(
      "Privacy policy",
      "This policy explains what personal data CO2 Counter (co2counter.co.uk) collects, why, who it's shared with, and your rights. CO2 Counter is run by " +
        operator() + ' ("we", "us"), who is the data controller. Questions or requests: ' + contactLink() + ".",
      [
        [
          "What we collect",
          ul([
            "<strong>Survey answers</strong>: your answers about food, travel, flights, home energy, water, pets, banking and pensions. If you don't have an account, these stay on your device only, and we only count that a survey was finished and when, with nothing about you or your answers.",
            "<strong>Account details</strong>: your email address and a securely hashed password, if you create an account.",
            "<strong>Optional details</strong>: if you choose to, what best describes your work (for example, nurse or teacher), and whether you agree to share your answers for research.",
            "<strong>Groups</strong>: the groups you create or join on the Friends page. Other members of a group see your display name and yearly total, never your answers.",
            "<strong>Habits</strong>: the actions you tick yourself on the Habits page, so they're there on any device, and which of your 7 Acts we've verified.",
            "<strong>Invites</strong>: your invite code, and who joined CO2 Counter with it. You see how many of them have finished the survey and, once at least two have measured twice, how much they've cut between them. Never who they are or their answers.",
            "<strong>Asking the bill payer to switch</strong>: if someone else chooses your energy supplier, your message to them includes a private link. When they tap it to confirm the switch, we record only the date.",
            "<strong>Letters sent from the app</strong>: if you send a letter to your MP or a message to whoever pays your energy bills from CO2 Counter, it's sent through our email provider, Resend, from our address, with a copy to you and replies going to you. We keep only the date and the type of letter, not what you wrote or your address.",
            "<strong>Letters to your MP</strong>: if you email your MP from the Habits page, we're copied in (BCC) so we can verify it. We record only the date it arrived and delete the email, which will include your name and address.",
            "<strong>Notifications (app only)</strong>: Sunday reminders are scheduled on your phone, and nothing about them is sent to us. If you turn on notifications about friends' activity, we store your phone's push token (an address Apple gives your phone for notifications) until you turn them off, sign out or delete your account.",
            "<strong>Reports and blocks</strong>: if you report someone or a group, we keep the report (the reason, anything you add, and the name at the time) so we can review it. If you block someone, we keep that so they can't contact you. The person you report or block isn't told.",
            "<strong>Partner link clicks</strong>: if you're signed in and open one of the partner sites we suggest (such as an energy supplier or bank), we record which link you opened and whether it was an affiliate link, once per link.",
            "<strong>Support details</strong>: if you choose to support CO2 Counter, the status and renewal date of your support and a reference to your customer record at Stripe. We never see or store your card details.",
            "<strong>Technical data</strong>: our web host and service providers log basic request data such as IP addresses to run and secure the service.",
          ])
        ],
        [
          "Why we use it",
          ul([
            "To work out and show your footprint, save your answers to your account, and record any support you've chosen to give. The legal basis is performing our contract with you.",
            "To keep the service secure and working. The legal basis is our legitimate interests.",
            "If you opt in to research (Account page): to share your survey answers and footprint, without your name, email or username, with research and health partners studying how people can cut emissions. The legal basis is your consent, which you can withdraw at any time on the Account page.",
            "To produce overall statistics that help us improve CO2 Counter, such as average footprints and how many people open each partner link and later make that change. These only ever show totals and averages, never individuals. The legal basis is our legitimate interests.",
            "To keep payment records, as the law requires. The legal basis is legal obligation.",
          ]) +
            "<p>We don't sell your data, show adverts, or use tracking or analytics cookies.</p>",
        ],
        [
          "Anonymised data",
          "<p>When you create an account, you agree that we can use anonymised data from CO2 Counter. This is what it means:</p>" +
            ul([
              "<strong>What it is</strong>: totals and averages worked out across many people, such as the average footprint in a group, a role or an area of life, or how many people made a switch. It never includes your name, email, username or answers on their own, and it can't be traced back to you.",
              "<strong>How we use it</strong>: to improve CO2 Counter, to show overall figures in the app, and to publish or share summaries, for example with charities, researchers or health organisations working on climate and health.",
              "<strong>The legal basis</strong>: our legitimate interests in improving the service and helping people cut emissions. Once data is truly anonymised it is no longer personal data. You can object at any time by emailing " + contactLink() + ".",
              "<strong>Research is separate</strong>: sharing <em>your own</em> survey answers (without your name, email or username) with research partners only happens if you tick the optional research box, at sign-up or on your Account page. You can untick it at any time.",
            ]) +
            "<p>We record which version of this policy you agreed to and when, so we can show what you were told.</p>",
        ],
        [
          "Who we share it with",
          "<p>Only the providers that run the service for us:</p>" +
            ul([
              "<strong>Supabase</strong>: sign-in and database (your account, saved answers and support status).",
              "<strong>Stripe</strong>: payments and subscriptions. Stripe handles your card details under its own privacy policy.",
              "<strong>GitHub Pages</strong>: hosting the website.",
              "<strong>Apple Push Notification service</strong>: delivers app notifications about friends' activity, if you turn them on.",
              "<strong>postcodes.io</strong>: if you use <em>Work it out from two postcodes</em> for your commute, the two postcodes are looked up there to find the distance. We don't save them.",
              "<strong>DVSA MOT history service</strong>: if you look up your car's miles from its number plate, the plate is sent to the DVSA to read its MOT mileage. We don't save the plate, only the miles you keep.",
            ]) +
            "<p>Some of these providers may process data outside the UK. Where they do, they rely on safeguards recognised under UK data protection law, such as adequacy regulations or standard contractual clauses.</p>",
        ],
        [
          "Storage on your device",
          "<p>The site stores your survey answers, habits, check-ins and sign-in session in your browser's local storage so it can work. These aren't tracking cookies. Clearing your browser's site data removes them, and signing out or deleting your account clears them on that device.</p>",
        ],
        [
          "How long we keep it",
          "<p>We keep your account data until you delete your account. Deleting it removes your account, saved answers and support record straight away. Stripe keeps payment records for as long as the law requires.</p>",
        ],
        [
          "Your rights",
          "<p>Under UK data protection law you can ask to access, correct or delete your data, receive a copy of it, or object to or restrict how we use it. You can delete your account at any time from the Account page. For anything else, email " +
            contactLink() +
            `. If you're unhappy with how we've handled your data, you can complain to the Information Commissioner's Office (<a class="link-btn" href="https://ico.org.uk" target="_blank" rel="noopener">ico.org.uk</a>).</p>`,
        ],
        ["Children", "<p>CO2 Counter is intended for people aged 13 and over. You must be 13 or over to create an account.</p>"],
        ["Changes", "<p>If we change this policy, we'll update this page and the date above. Significant changes will be highlighted on the site.</p>"],
      ]
    );
  }

  function renderTerms() {
    return legalPage(
      "Terms of use",
      "These terms apply when you use CO2 Counter (co2counter.co.uk), run by " + operator() + ' ("we", "us"). By using the site you agree to them. Contact: ' + contactLink() + ".",
      [
        [
          "What CO2 Counter is",
          "<p>CO2 Counter estimates your carbon footprint from your answers to a survey, and suggests ways to reduce it. Results are estimates based on typical published figures, not measurements. They're for general information and aren't financial, investment or professional advice. Check with a qualified adviser before making financial decisions, such as moving a pension.</p>",
        ],
        [
          "Your account",
          "<p>You must be 13 or over to create an account. You're responsible for keeping your password safe and for what happens on your account. Please give a real email address so we can contact you about your account or membership. You can delete your account at any time from the Account page.</p>",
        ],
        // In the iPhone app: no talk of outside payments (App Store rules).
        isNativeApp()
          ? ["Free to use", "<p>CO2 Counter is free to use, including the survey, your full results, tips and guides. There are no ads, and we never sell your data.</p>"]
          : [
          "Free use and optional support",
          ul([
            "CO2 Counter is free to use, including the survey, your full results, tips and guides. You can optionally support it for <strong>£2 a year</strong>, paid through Stripe. Supporting doesn't change what you can use.",
            "Support <strong>renews automatically each year</strong> until you cancel. You can cancel at any time with <em>Manage subscription</em> on the Account page.",
            "If we change the price, we'll tell you at least 30 days before your next renewal, and you can cancel before it applies.",
            "<strong>Refunds:</strong> if you change your mind, email us within 14 days of joining or renewing and we'll refund that payment in full.",
            "Deleting your account doesn't cancel your subscription. Please cancel it first.",
          ]),
        ],
        [
          "Using the site fairly",
          "<p>Please don't misuse the service: no attempts to break or overload it, access other people's data, or copy and resell its content. Names, usernames and group names must not be offensive, abusive or misleading, and you mustn't use CO2 Counter to harass anyone. We may suspend accounts that do.</p>" +
            "<p>You can report a person or group, or block someone, with the <strong>…</strong> button next to them on the Friends page. We review reports within 24 hours and will remove offensive names or groups, and suspend accounts that break these terms.</p>",
        ],
        [
          "Our content",
          "<p>The site's text, design, calculations and guides belong to us or our licensors. You're welcome to use your own results however you like.</p>",
        ],
        [
          "Availability and changes",
          "<p>We'll try to keep the site available and accurate, but we can't promise it will always be uninterrupted or error-free. We may update features, data sources and estimates over time. If we ever close the service, we'll give notice and refund supporters for any unused part of their year.</p>",
        ],
        [
          "Our liability",
          "<p>Nothing in these terms limits liability that can't legally be limited, such as for death or personal injury caused by negligence, or for fraud, and your statutory consumer rights are unaffected. Otherwise, we're not responsible for decisions you make based on estimates from the site, and our total liability to you is limited to the amount you've paid us in the previous 12 months.</p>",
        ],
        [
          "Changes and law",
          "<p>We may update these terms. If a change affects your support payments, we'll let you know in advance. These terms are governed by the law of England and Wales, and you can bring a claim in the courts where you live in the UK.</p>",
        ],
      ]
    );
  }

  // ==================== Habits page ====================

  function renderHabits() {
    const committed = allCommitted();
    const total = CATEGORIES.reduce((sum, c) => sum + D.EXPLAINERS[c].habits.length, 0);
    const done = CATEGORIES.reduce((sum, c) => sum + committed[c].length, 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const active = CATEGORIES.filter((c) => committed[c].length > 0);

    let html =
      '<div class="container narrow">' + pageHeader("My Habits", "Everything you've committed to") +
      '<div class="card mb-8 fade-up"><div class="row-between mb-3"><div class="label-row green-dark">' + icon("chart") +
      '<span class="sm fw-500 upper">Overall progress</span></div><span class="sm muted">' + done + "/" + total + "</span></div>" +
      '<div class="progress"><div style="width:' + pct + '%"></div></div><p class="xs muted mt-2">' + pct + "% of all suggested habits</p></div>";

    if (!active.length) {
      html +=
        stateCard({ icon: "leaf", title: "No habits yet", text: "Your 7 Acts live in My Habits.", actions: [["Go to My Habits", 'href="#/habits"', true]] });
    } else {
      html += '<div class="stack-5">';
      html += active
        .map((c) => {
          const ex = D.EXPLAINERS[c];
          const ids = committed[c];
          const p = Math.round((ids.length / ex.habits.length) * 100);
          return (
            '<div class="card mb-0 fade-up"><div class="row-between mb-4"><div class="label-row"><span class="emoji-row">' + ex.icon + '</span><div><h3 class="sm fw-600">' + esc(ex.title) +
            '</h3><p class="xs muted">' + ids.length + " of " + ex.habits.length + ' committed</p></div></div><a class="btn btn-ghost btn-sm muted" href="#/explainer/' + c + '">Edit ' +
            icon("arrowRight") + '</a></div><div class="progress thin mb-4"><div style="width:' + p + '%"></div></div><div class="stack-2">' +
            ex.habits
              .filter((h) => ids.includes(h.id))
              .map(
                (h) =>
                  '<button type="button" class="habit-chip" data-action="remove-habit" data-cat="' + c + '" data-id="' + h.id + '"><span class="tick">' + icon("check") +
                  '</span><span><span class="sm fw-500 green-darker block">' + esc(h.label) + '</span><span class="xs muted block mt-0">' + esc(h.tip) + "</span></span></button>"
              )
              .join("") +
            "</div></div>"
          );
        })
        .join("");
      html += "</div>";
    }
    return html + '<p class="xs muted center mt-8">Tap a habit to remove it. Habits are saved on this device.</p></div>';
  }

  // ==================== Check-in page ====================

  function checkInHeader() {
    const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    return pageHeader("Daily Check-in", today);
  }

  function renderCheckIn() {
    const groups = checkInGroups(survey);
    const all = groups.flatMap((g) => g.habits);
    if (!all.length) {
      return (
        '<div class="container narrow">' + checkInHeader() +
        stateCard({ icon: "calendar", title: "Nothing to check in yet", text: "Your 7 Acts live in My Habits.", actions: [["Go to My Habits", 'href="#/habits"', true]] }) + "</div>"
      );
    }
    const active = all.filter((h) => h.stage.active);
    const locked = groups.flatMap((g) => g.habits.filter((h) => !h.stage.active).map((h) => ({ ...h, categoryTitle: g.title, categoryIcon: g.icon })));
    const doneToday = active.filter((h) => streak(h.id).checkedToday).length;
    const streakDays = active.reduce((sum, h) => sum + streak(h.id).count, 0);
    const goals = active.filter((h) => h.goal);
    const goalsDone = goals.filter((h) => goalFor(h.id).done).length;
    const pct = active.length ? Math.round((doneToday / active.length) * 100) : 0;

    let html =
      '<div class="container narrow">' + checkInHeader() +
      '<div class="card hero mb-8 fade-up"><div class="glow small"></div><div class="rel"><div class="row-between mb-3"><div class="label-row green-dark">' + icon("flame") +
      '<span class="sm fw-500 upper">Today\'s check-in</span></div><span class="sm muted">' + doneToday + "/" + active.length + " done today</span></div>" +
      '<div class="progress mb-4"><div class="grad" style="width:' + pct + '%"></div></div><div class="grid-2-fixed gap-3">' +
      '<div class="stat-box orange"><div class="label-row xs fw-500 upper">' + icon("flame") + 'Streak days</div><p class="stat-num">' + streakDays + '</p><p class="tiny2 muted">across all active habits</p></div>' +
      '<div class="stat-box emerald"><div class="label-row xs fw-500 upper">' + icon("target") + 'Goals</div><p class="stat-num">' + goalsDone + '<span class="muted normal md">/' + goals.length +
      '</span></p><p class="tiny2 muted">longer-term goals completed</p></div></div></div></div><div class="stack-5">';

    html += groups
      .map((g) => {
        const habits = g.habits.filter((h) => h.stage.active);
        if (!habits.length) return "";
        return (
          '<div class="card mb-0 fade-up"><div class="row-between mb-4"><div class="label-row"><span class="emoji-row">' + g.icon + '</span><h3 class="sm fw-600">' + esc(g.title) +
          '</h3></div><a class="btn btn-ghost btn-sm muted" href="#/explainer/' + g.category + '">Edit ' + icon("arrowRight") + '</a></div><div class="stack-2">' +
          habits.map(habitCard).join("") + "</div></div>"
        );
      })
      .join("");
    html += "</div>";

    if (locked.length) {
      html +=
        '<div class="locked-card fade-up"><div class="label-row mb-1">' + icon("lock", "muted") + '<h3 class="sm fw-600 muted">Unlocking soon</h3></div>' +
        '<p class="xs muted mb-4">New habits unlock every 7 days so you can focus on a few at a time.</p><div class="stack-2">' +
        locked
          .map(
            (h) =>
              '<div class="locked-row"><span class="emoji-md">' + h.categoryIcon + '</span><div class="grow min0"><p class="sm fw-500 muted truncate">' + esc(h.label) +
              '</p><p class="xs muted truncate">' + esc(h.categoryTitle) + " · " + esc(h.tip) + '</p></div><span class="tag amber">' + h.stage.unlocksInDays + "d</span></div>"
          )
          .join("") +
        "</div></div>";
    }
    return html + '<p class="xs muted center mt-8">Check in daily to grow your 🔥 streaks. Goal habits can also be marked complete at the end.</p></div>';
  }

  function habitCard(h) {
    const st = streak(h.id);
    const week = lastDays(h.id, 7);
    const goal = h.goal ? goalFor(h.id) : null;
    const done = !!(goal && goal.done);
    const overdue = goal && !done && new Date(goal.deadline) < new Date(new Date().toDateString());
    return (
      '<div class="habit-card' + (st.checkedToday ? " checked" : "") + '"><div class="habit-row"><div class="flame' + (st.count > 0 ? " hot" : "") +
      '"><span class="emoji-md">🔥</span><span class="tiny fw-600">' + st.count + '</span></div><div class="grow min0"><p class="sm fw-500' +
      (st.checkedToday ? " green-darker" : "") + '">' + esc(h.label) + '</p><p class="xs muted mt-0">' + esc(h.tip) + '</p><div class="week-dots">' +
      week
        .map((d, i) => {
          const today = i === week.length - 1;
          return '<span class="dot' + (d.checked ? " on" : today ? " today" : "") + '">' + (d.checked ? icon("check") : today ? "<i></i>" : "") + "</span>";
        })
        .join("") +
      "</div>" +
      (goal
        ? '<div class="goal-row">' + icon("target", "muted sm") + '<input type="date" class="input xs-input" value="' + esc(goal.deadline) + '" data-goal="' + h.id + '"' +
          (done ? " disabled" : "") + " />" + (overdue ? '<span class="xs fw-500 amber-text">Overdue</span>' : "") + '<span class="grow"></span>' +
          '<button type="button" class="btn btn-sm ' + (done ? "btn-outline" : "btn-green") + '" data-action="complete-goal" data-id="' + h.id + '">' +
          (done ? icon("refresh") + " Undo" : "Complete") + "</button></div>"
        : "") +
      '<button type="button" class="btn btn-sm mt-3 checkin-btn ' + (st.checkedToday ? "btn-outline" : "btn-green") + '" data-action="check-in" data-id="' + h.id + '"' +
      (done ? " disabled" : "") + ">" + (st.checkedToday ? icon("check") + " Done today" : "Check in") + "</button></div></div></div>"
    );
  }

  // ==================== Account page ====================

  function renderAccount() {
    const fp = footprint(survey);
    const hist = historyByDay();
    const change = hist.length > 1 ? hist[0].totalYearly - hist[hist.length - 1].totalYearly : 0;
    if (!friends.loaded && !friends.loading) loadFriends();
    const friendCount = friends.rows.filter((f) => f.status === "accepted").length;
    const rank = friendCount ? rankInfo() : null;
    const name = ui.userName && ui.userName !== "App user" ? ui.userName : ui.username || "Your account";
    const { acts } = habitActs();
    const actsDone = acts.filter((a) => a.done).length;
    const m = membership || {};
    const supporter = !m.owner && (isSupporter() || (!FREE_MODE && !m.free));
    const firstAt = currentUser.created_at || (hist.length ? hist[hist.length - 1].completedAt : null);
    const since = firstAt ? new Date(firstAt).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "";
    const pct = hist.length > 1 && Math.abs(change) >= 1 ? Math.round((Math.abs(change) / hist[hist.length - 1].totalYearly) * 100) : null;

    // Your plan
    let planTag, planText, planExtra = "";
    if (m.owner) { planTag = "Owner"; planText = "Owner account: free, with full access."; }
    else if (FREE_MODE && !isSupporter()) {
      planTag = "Free";
      planText = isNativeApp() ? "Everything is free. No ads, and we never sell your data." : "Everything is free. If it's helped you, chip in £2 a year to cover running costs. No ads, and we never sell your data.";
      if (!isNativeApp() && STRIPE_PAYMENT_LINK)
        planExtra = '<a class="acc-support" href="' + esc(supportUrl()) + '">' + icon("heart") + 'Support for £2 a year</a><p class="acc-fine">Secure payment by Stripe. Cancel any time.</p>';
    } else if (m.free && m.status !== "active") { planTag = "Free"; planText = "You've been given full access, free of charge."; }
    else {
      const until = m.until ? m.until.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
      planTag = FREE_MODE ? "Supporter" : "Member";
      planText = (FREE_MODE ? "Supporter · £2 a year. Thank you! " : "CO2 Counter membership · £2 a year. ") +
        (m.status === "active" && until ? "Renews on " + esc(until) + "." : until ? "Access until " + esc(until) + "." : "Active.");
      if (STRIPE_PORTAL_URL && !isNativeApp())
        planExtra = '<a class="acc-support ghost" href="' + esc(STRIPE_PORTAL_URL) + '" target="_blank" rel="noopener">Manage subscription</a>';
    }

    const tiles =
      '<div class="acc-tiles">' +
      '<a class="dark" href="#/results"><b class="display tnum">' + (survey && survey.completedAt ? (fp.totalYearly / 1000).toFixed(1) + "<small> t</small>" : "–") + "</b>" +
      '<span class="' + (pct != null ? (change < 0 ? "honey fw-700" : "clay-l fw-700") : "") + '">' + (pct != null ? (change < 0 ? "▼ " : "▲ ") + pct + "%" : "a year") + "</span></a>" +
      '<a href="#/friends"><b class="display tnum">' + (rank ? ordinal(friends.board.findIndex((b) => b.is_self) + 1) : friendCount) + "</b><span>" +
      (rank ? "of " + friends.board.length + " friends" : friendCount === 1 ? "friend" : "friends") + "</span></a>" +
      '<a class="honey-bg" href="#/habits"><b class="display tnum">' + actsDone + "<small>/7</small></b><span>acts done</span></a></div>";
    const me =
      '<section class="glass acc-me rise" aria-label="Your profile"><div class="acc-me-top">' + frAv(currentUser.id, name, 64, true, "ringed") +
      '<span class="min0 grow"><span class="display acc-name">' + esc(name) + '</span><span class="acc-sub">' + [ui.username ? "@" + esc(ui.username) : "", since ? "since " + esc(since) : ""].filter(Boolean).join(" · ") + "</span></span></div>" +
      tiles + '<button type="button" class="acc-signout" data-action="sign-out">' + icon("logOut") + "Sign out</button></section>";
    const LINKS = [
      ["Retake survey", "#/", "M20 11A8 8 0 1 0 18 16.5M20 5v6h-6", "#3F5B3A", "#F6F1E6"],
      ["View results", "#/results", HB_CHART, "rgba(63,91,58,.12)", "#3F5B3A"],
      ["Friends", "#/friends", SW_ICONS.motivate, "rgba(127,163,174,.22)", "#2E5560"],
      ["My Habits", "#/habits", "M5 12.5l4.5 4.5L19 7.5", "rgba(217,164,65,.22)", "#8A5F12"],
    ];
    const quick =
      '<nav class="glass acc-quick" aria-label="Shortcuts"><div class="acc-qtitle">Shortcuts</div><ul>' +
      LINKS.map(([l, h, d, bg, ink]) => '<li><a class="acc-qlink" href="' + h + '"><span class="acc-qicon" style="background:' + bg + ";color:" + ink + '">' + svgPath(d, 18) + "</span><span>" + l + "</span>" + icon("chevronRight") + "</a></li>").join("") +
      "</ul></nav>";

    const details = [["Name", name], ["Username", ui.username ? "@" + ui.username : "Not set"], ["Email", currentUser.email || ""]];
    const profile =
      '<section class="glass acc-box" aria-labelledby="acc-prof"><h2 id="acc-prof" class="display">Profile</h2><dl class="acc-dl">' +
      details.map(([k, v]) => "<div><dt>" + k + "</dt><dd>" + esc(v) + "</dd></div>").join("") +
      "<div><dt>Saved</dt><dd>" + (canSync() ? "Synced across your devices" : "On this device") + "</dd></div></dl>" +
      '<p class="xs mt-2"><a href="#/friends">Change the name friends see</a></p></section>';
    const plan =
      '<section class="acc-box acc-plan" aria-labelledby="acc-plan"><div class="row-between gap-3"><h2 id="acc-plan" class="display">Your plan</h2><span class="acc-tag">' + planTag + "</span></div>" +
      '<p class="acc-plan-p">' + planText + "</p>" + planExtra + "</section>";

    const subscribed = !m.owner && m.status === "active";
    const del = !ui.confirmDelete
      ? '<button type="button" class="acc-btn danger" data-action="delete-account">Delete my account</button>'
      : "";
    const confirm = ui.confirmDelete
      ? '<div class="acc-confirm rise">' +
        (subscribed
          ? '<p class="sm"><span class="fw-600">Cancel your subscription first.</span> Deleting your account doesn\'t stop Stripe charging your card next year.' +
            (STRIPE_PORTAL_URL && !isNativeApp() ? ' <a class="link-btn" href="' + esc(STRIPE_PORTAL_URL) + '" target="_blank" rel="noopener">Manage subscription</a>' : "") + "</p>"
          : "") +
        '<div class="acc-confirm-row"><input class="input" type="text" id="delete-confirm" autocomplete="off" placeholder="Type DELETE to confirm" aria-label="Type DELETE to confirm" />' +
        '<button type="button" class="acc-btn solid-danger" data-action="confirm-delete">Delete permanently</button><button type="button" class="acc-btn" data-action="cancel-delete">Cancel</button></div>' +
        (ui.deleteErr ? '<p class="xs red mt-2">' + esc(ui.deleteErr) + "</p>" : "") + "</div>"
      : "";
    const data =
      '<section class="glass acc-box" aria-labelledby="acc-data"><h2 id="acc-data" class="display">Your data</h2>' +
      '<div class="acc-row"><span class="acc-row-text">Clear what\'s saved on this device. Your account copy stays. This can\'t be undone.</span>' +
      '<button type="button" class="acc-btn" data-action="clear-habits">Clear my plan</button><button type="button" class="acc-btn danger" data-action="clear-all">Clear everything</button></div>' +
      '<div class="acc-delete"><div class="acc-row"><span class="acc-row-text"><b class="display">Delete account</b>Permanently deletes your account, survey answers and any support record.</span>' + del + "</div>" + confirm + "</div></section>";

    return (
      '<div class="container account-v2 acc-page" data-fs-pill="' + esc(name) + '" data-fs-unit=""><div class="acc-layout"><aside class="acc-side">' + me + quick + "</aside>" +
      '<main class="acc-main"><h1 class="display acc-h1">Account</h1><div class="acc-row2">' + profile + plan + "</div>" +
      aboutYouCard() + notifSettingsCard() +
      (ui.isAdmin
        ? '<section class="glass acc-box acc-owner" aria-labelledby="acc-owner-h"><span class="eyebrow">Only you see this</span><h2 id="acc-owner-h" class="display mt-2">Owner tools</h2>' +
          // Letters to MPs arrive by BCC with a reference; verifying ticks act 6.
          '<h3 class="display acc-owner-k">Verify a letter to an MP</h3><p class="sm muted">Letters BCC\'d to ' + MP_COPY + " carry a reference like CO2-ABC123. Enter it to verify that person's act 6, then delete the email.</p>" +
          '<form id="verify-mp-form" class="hb-mp-form mt-2"><input class="input" id="verify-mp-code" placeholder="CO2-ABC123" maxlength="12" aria-label="Reference" autocapitalize="characters" spellcheck="false" /><button type="submit" class="btn btn-green btn-sm">Verify</button></form>' +
          (ui.verifyMsg ? '<p class="xs mt-2 ' + (ui.verifyMsg.ok ? "green-dark" : "red") + '" role="status">' + esc(ui.verifyMsg.text) + "</p>" : "") +
          '<p class="sm muted mt-4">Figures last updated ' + esc(shortDate(figuresUpdated())) + ".</p>" +
          '<div class="chip-row mt-2"><a class="btn btn-outline btn-sm" href="#/analytics">' + icon("chart") + ' Analytics and reports</a><a class="btn btn-outline btn-sm" href="#/inputs">Inputs ' + icon("arrowRight") + "</a></div></section>"
        : "") +
      data + appLinks() + "</main></div></div>"
    );
  }

  // Optional: what you do (for anonymous totals by role) and research consent.
  const ROLES = [
    ["doctor", "Doctor"], ["nurse_midwife", "Nurse or midwife"], ["ahp", "Allied health professional"], ["paramedic", "Paramedic"],
    ["other_health", "Other healthcare role"], ["education", "Education"], ["student", "Student"], ["other", "Something else"],
  ];
  async function loadAboutYou() {
    ui.aboutYou = { loading: true };
    try {
      const { data, error } = await sb.from("profiles").select("role, research_opt_in").eq("id", currentUser.id).maybeSingle();
      ui.aboutYou = error ? { failed: true } : { role: (data && data.role) || "", research_opt_in: !!(data && data.research_opt_in) };
    } catch (e) {
      ui.aboutYou = { failed: true };
    }
    if (currentPath() === "/account") render();
  }
  function aboutYouCard() {
    if (!ui.aboutYou) loadAboutYou();
    const a = ui.aboutYou || {};
    if (a.loading || a.failed) return "";
    return (
      // What you do is asked once, in the survey's Money step; this card is
      // just the research choice.
      '<section class="glass guide-card"><span class="eyebrow">Research · optional</span>' +
      '<form id="about-you-form" class="stack-3 mt-2">' +
      '<label class="check-label research-consent"><input type="checkbox" id="about-research"' + (a.research_opt_in ? " checked" : "") + " /> <span><b>Share my answers for research.</b> Your survey answers and footprint, without your name, email or username, may be shared with research and health partners studying how people can cut emissions. You can turn this off at any time.</span></label>" +
      '<div class="row-between gap-3" style="flex-wrap:wrap"><button type="submit" class="btn btn-green">Save</button>' +
      (ui.aboutMsg ? '<span class="xs ' + (ui.aboutMsg.ok ? "green-dark" : "red") + '" role="status">' + esc(ui.aboutMsg.text) + "</span>" : "") + "</div></form></section>"
    );
  }

  // Deleting removes the login; survey answers and membership go with it
  // (they reference auth.users with on delete cascade). Stripe isn't told,
  // so members are asked to cancel their subscription first.
  function deleteAccountCard() {
    const m = membership || {};
    const subscribed = !m.owner && m.status === "active";
    let body;
    if (!ui.confirmDelete) {
      body =
        '<p class="xs muted mb-4">Permanently delete your account and everything saved with it: your survey answers and any support record. This can\'t be undone.</p>' +
        '<button type="button" class="btn btn-outline btn-sm btn-danger" data-action="delete-account">' + icon("trash") + " Delete my account</button>";
    } else {
      body =
        (subscribed
          ? '<p class="sm mb-3"><span class="fw-600">Cancel your subscription first.</span> Deleting your account doesn\'t stop Stripe charging your card next year.' +
            (STRIPE_PORTAL_URL && !isNativeApp()
              ? ' <a class="link-btn" href="' + esc(STRIPE_PORTAL_URL) + '" target="_blank" rel="noopener">Manage subscription</a>'
              : "") +
            "</p>"
          : "") +
        '<label class="xs">Type <span class="fw-600">DELETE</span> to confirm<input class="input mt-1" type="text" id="delete-confirm" autocomplete="off" /></label>' +
        (ui.deleteErr ? '<p class="xs red mt-2">' + esc(ui.deleteErr) + "</p>" : "") +
        '<div class="chip-row mt-3"><button type="button" class="btn btn-sm btn-delete" data-action="confirm-delete">Delete my account permanently</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="cancel-delete">Cancel</button></div>';
    }
    return '<section class="glass cat-drop danger-card"><h2 class="display side-title">Delete account</h2>' + body + "</section>";
  }

  const MIN_PASSWORD = 8;

  const authNotes = () =>
    (ui.authErr ? '<p class="auth-note error" role="alert">' + esc(ui.authErr) + "</p>" : "") +
    (ui.authMsg ? '<p class="auth-note ok" role="status">' + esc(ui.authMsg) + "</p>" : "");

  // A password box with its own Show/Hide button and a tick that appears
  // once both boxes match. `confirm` marks the retype box, which also gets
  // a line saying whether the two match.
  function passwordField(id, label, autocomplete, confirm) {
    return (
      '<div><label class="xs" for="' + id + '">' + label + '</label><div class="pw-wrap mt-1">' +
      '<input class="input" type="password" id="' + id + '" minlength="' + MIN_PASSWORD + '" required autocomplete="' + autocomplete + '"' +
      (confirm ? ' aria-describedby="' + id + '-match"' : "") + " />" +
      '<span class="pw-tick" hidden>' + icon("check") + "</span>" +
      '<button type="button" class="pw-toggle" data-action="toggle-pw" data-target="' + id + '" aria-label="Show password">Show</button></div>' +
      (confirm ? '<p class="pw-match xs" id="' + id + '-match" aria-live="polite"></p>' : "") + "</div>"
    );
  }

  // Ticks and "Passwords match" for whichever pair of boxes is on screen.
  function updatePasswordMatch() {
    [["auth-password", "auth-password2"], ["new-password", "new-password2"]].forEach(([id1, id2]) => {
      const a = document.getElementById(id1);
      const b = document.getElementById(id2);
      if (!a || !b) return;
      const match = b.value.length > 0 && a.value === b.value;
      const good = match && a.value.length >= MIN_PASSWORD;
      [a, b].forEach((el) => {
        el.parentNode.querySelector(".pw-tick").hidden = !good;
        el.classList.toggle("pw-good", good);
      });
      const line = document.getElementById(id2 + "-match");
      if (!line) return;
      let text = "";
      let cls = "";
      if (match && good) {
        text = "Passwords match";
        cls = "ok";
      } else if (match) {
        text = "Passwords match, but need at least " + MIN_PASSWORD + " characters";
        cls = "bad";
      } else if (b.value.length && b.value.length >= a.value.length) {
        text = "Passwords don't match";
        cls = "bad";
      }
      line.textContent = text;
      line.className = "pw-match xs " + cls;
    });
  }

  const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

  const usernameField = (id) =>
    '<div><label class="xs" for="' + id + '">Username</label><div class="pw-wrap mt-1">' +
    '<input class="input" type="text" id="' + id + '" required maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false" value="' +
    esc(ui.authUsername) + '" aria-describedby="' + id + '-hint" />' +
    '<span class="pw-tick" hidden>' + icon("check") + "</span></div>" +
    '<p class="pw-match xs" id="' + id + '-hint" aria-live="polite">3 to 20 letters, numbers or _. Friends see this.</p></div>';

  // Live "available / taken" under the username box.
  let usernameTimer = null;
  function checkUsername(input) {
    const name = input.value.trim();
    const hint = document.getElementById(input.id + "-hint");
    const tick = input.parentNode.querySelector(".pw-tick");
    const set = (text, cls, ok) => {
      hint.textContent = text;
      hint.className = "pw-match xs " + cls;
      tick.hidden = !ok;
      input.classList.toggle("pw-good", ok);
    };
    clearTimeout(usernameTimer);
    if (!name) return set("3 to 20 letters, numbers or _. Friends see this.", "", false);
    if (/[^A-Za-z0-9_]/.test(name)) return set("Only letters, numbers and _ (no spaces).", "bad", false);
    if (name.length < 3) return set("At least 3 characters.", "", false);
    if (!USERNAME_RE.test(name)) return set("Use 3 to 20 letters, numbers or _.", "bad", false);
    set("Checking…", "", false);
    usernameTimer = setTimeout(async () => {
      const ok = await usernameAvailable(name);
      if (input.value.trim() !== name) return;
      if (ok === false) set("That username is taken.", "bad", false);
      else set("Available", "ok", true);
    }, 350);
  }

  // true / false, or null if the check couldn't run (then the database has
  // the final say).
  async function usernameAvailable(name) {
    if (!sb) return null;
    try {
      const { data, error } = await sb.rpc("username_available", { name });
      return error ? null : !!data;
    } catch (e) {
      return null;
    }
  }

  const emailField = () =>
    '<label class="xs">Email<input class="input mt-1" type="email" id="auth-email" required autocomplete="email" value="' + esc(ui.authEmail) + '" /></label>';

  function authForm() {
    if (ui.recovery) {
      return (
        '<form id="recovery-form" class="auth-form" novalidate>' +
        passwordField("new-password", "New password (at least " + MIN_PASSWORD + " characters)", "new-password") +
        passwordField("new-password2", "Retype new password", "new-password", true) +
        authNotes() +
        '<button type="submit" class="btn btn-green btn-block">Save new password</button></form>'
      );
    }
    if (ui.authSentTo) {
      return (
        '<div class="auth-form"><div class="auth-sent">' + icon("check") + "</div>" +
        '<p class="sm">We\'ve sent a confirmation link to <strong>' + esc(ui.authSentTo) + "</strong>. Open it to finish creating your account, and you'll be signed in.</p>" +
        '<p class="xs muted">Can\'t see it? Check your junk or spam folder. Each link only works once.</p>' +
        authNotes() +
        '<button type="button" class="btn btn-outline btn-block" data-action="resend-confirm">Send the link again</button>' +
        '<div class="chip-row"><button type="button" class="link-btn" data-action="auth-mode" data-mode="signin">Back to sign in</button></div></div>'
      );
    }
    if (ui.authMode === "reset") {
      return (
        '<form id="reset-form" class="auth-form" novalidate><p class="sm muted">Enter your account email and we\'ll send you a link to choose a new password.</p>' +
        emailField() + authNotes() +
        '<button type="submit" class="btn btn-green btn-block">Send reset link</button>' +
        '<div class="chip-row"><button type="button" class="link-btn" data-action="auth-mode" data-mode="signin">Back to sign in</button></div></form>'
      );
    }
    const signup = ui.authMode === "signup";
    return (
      '<form id="auth-form" class="auth-form" novalidate>' +
      (signup ? usernameField("auth-username") : "") +
      emailField() +
      (signup
        ? passwordField("auth-password", "Password (at least " + MIN_PASSWORD + " characters)", "new-password") +
          passwordField("auth-password2", "Retype password", "new-password", true)
        : passwordField("auth-password", "Password", "current-password")) +
      (signup
        ? '<label class="auth-check"><input type="checkbox" id="auth-agree"' + (ui.authAgree ? " checked" : "") + ' /><span>I agree to the <a class="link-btn" href="/terms/" target="_blank" rel="noopener">Terms</a> and have read the <a class="link-btn" href="/privacy/" target="_blank" rel="noopener">Privacy policy</a>, including how we use anonymised totals.</span></label>' +
          '<label class="auth-check optional"><input type="checkbox" id="auth-research"' + (ui.authResearch ? " checked" : "") + ' /><span><b>Optional:</b> share my survey answers for research, without my name, email or username. You can change this any time on your Account page.</span></label>'
        : "") +
      authNotes() +
      '<button type="submit" class="btn btn-green btn-block">' + (signup ? "Create account" : "Sign in") + "</button>" +
      '<div class="chip-row auth-links">' +
      (signup
        ? '<button type="button" class="link-btn" data-action="auth-mode" data-mode="signin">Have an account? Sign in</button>'
        : '<button type="button" class="link-btn" data-action="auth-mode" data-mode="signup">Need an account? Sign up</button>' +
          '<button type="button" class="link-btn" data-action="auth-mode" data-mode="reset">Forgot password?</button>') +
      "</div></form>"
    );
  }

  // Supabase's error messages, in plainer words.
  function friendlyAuthError(e) {
    const code = (e && (e.code || e.error_code)) || "";
    const msg = (e && e.message) || "";
    if (code === "invalid_credentials" || /invalid login credentials/i.test(msg))
      return "That email and password don't match. Check them and try again, or use Forgot password.";
    if (code === "email_not_confirmed" || /email not confirmed/i.test(msg))
      return "You need to confirm your email before signing in.";
    if (code === "over_email_send_rate_limit" || /rate limit|security purposes/i.test(msg))
      return "We've sent a few emails already. Please wait a minute and try again.";
    if (code === "same_password") return "Your new password must be different from your old one.";
    if (code === "weak_password") return msg || "Please choose a stronger password.";
    if (code === "validation_failed" || /invalid format|unable to validate email/i.test(msg)) return "Please enter a valid email address.";
    if (/fetch|network/i.test(msg)) return "We couldn't reach the server. Check your connection and try again.";
    return msg || "Something went wrong. Please try again.";
  }

  // Checks shared by sign-up and set-new-password; returns an error or "".
  function passwordProblem(p1, p2) {
    if (p1.length < MIN_PASSWORD) return "Your password needs at least " + MIN_PASSWORD + " characters.";
    if (p1 !== p2) return "The two passwords don't match. Please type them again.";
    return "";
  }

  // Supabase appends its tokens to this URL's hash, so it must not carry a
  // route of its own; start() tidies the hash up afterwards.
  // Inside the iOS app the page's own origin (capacitor://localhost) can't be
  // opened from an email, so links go to the website instead.
  const PRODUCTION_URL = "https://co2counter.co.uk/";
  function authRedirectUrl() {
    const native = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    return native ? PRODUCTION_URL : location.origin + "/";
  }

  async function submitAuth() {
    if (!sb) {
      ui.authErr = "Couldn't reach the sign-in service. Check your connection and reload.";
      return render();
    }
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    ui.authEmail = email; // keep it filled in if the form re-renders with an error
    ui.authErr = "";
    ui.authMsg = "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      ui.authErr = "Please enter a valid email address.";
      return render();
    }
    try {
      if (ui.authMode === "signup") {
        const username = document.getElementById("auth-username").value.trim();
        ui.authUsername = username;
        if (!USERNAME_RE.test(username)) {
          ui.authErr = "Please choose a username: 3 to 20 letters, numbers or _ (no spaces).";
          return render();
        }
        if ((await usernameAvailable(username)) === false) {
          ui.authErr = "That username is taken. Please choose another.";
          return render();
        }
        const problem = passwordProblem(password, document.getElementById("auth-password2").value);
        if (problem) {
          ui.authErr = problem;
          return render();
        }
        ui.authAgree = document.getElementById("auth-agree").checked;
        ui.authResearch = document.getElementById("auth-research").checked;
        if (!ui.authAgree) {
          ui.authErr = "Please tick the box to agree to the Terms and Privacy policy.";
          return render();
        }
        // Saved to the profile by the sign-up trigger: which policy they
        // agreed to (and when), and their research choice.
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { emailRedirectTo: authRedirectUrl(), data: { username, privacy_version: PRIVACY_VERSION, research_opt_in: ui.authResearch } },
        });
        // The database refuses a username someone has just taken.
        if (error && /database error saving new user|duplicate key|unique constraint|username/i.test(error.message || "")) {
          ui.authErr = "That username was just taken. Please choose another.";
          return render();
        }
        if (error) throw error;
        // Supabase answers a sign-up for an existing email with a user that
        // has no identities, and sends nothing.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          ui.authMode = "signin";
          ui.authErr = "There's already an account with this email. Sign in below, or use Forgot password if you can't remember it.";
          return render();
        }
        if (!data.session) {
          ui.authSentTo = email;
          return render();
        }
      } else {
        if (!password) {
          ui.authErr = "Please enter your password.";
          return render();
        }
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) {
          // Not confirmed yet: send a fresh link and say so.
          if (error.code === "email_not_confirmed" || /not confirmed/i.test(error.message || "")) {
            await sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: authRedirectUrl() } });
            ui.authSentTo = email;
            ui.authMsg = "You need to confirm your email before signing in, so we've sent you a new link.";
            return render();
          }
          throw error;
        }
      }
      await afterSignIn();
    } catch (e) {
      ui.authErr = friendlyAuthError(e);
      render();
    }
  }

  async function submitReset() {
    const email = document.getElementById("auth-email").value.trim();
    ui.authEmail = email;
    ui.authErr = "";
    ui.authMsg = "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      ui.authErr = "Please enter a valid email address.";
      return render();
    }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl() });
    if (error) ui.authErr = friendlyAuthError(error);
    // Same message whether or not the account exists, so the form can't be
    // used to find out who has one.
    else ui.authMsg = "If there's an account for " + email + ", we've sent it a link to reset the password. Check your inbox (and junk folder).";
    render();
  }

  async function submitNewPassword() {
    const p1 = document.getElementById("new-password").value;
    const problem = passwordProblem(p1, document.getElementById("new-password2").value);
    ui.authErr = problem;
    if (problem) return render();
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) {
      ui.authErr = /session|jwt|expired/i.test(error.message || "")
        ? "Your reset link has expired. Please request a new one."
        : friendlyAuthError(error);
      return render();
    }
    ui.recovery = false;
    ssSet(KEY_RECOVERY, false);
    ui.authErr = "";
    ui.flash = "Your password has been changed and you're signed in.";
    await afterSignIn();
    location.hash = canSync() ? "#/results" : "#/";
    render();
  }

  // Accounts made before usernames existed are asked to pick one. If the
  // username was given at sign-up but never reached the profile, save it.
  // Accounts that agreed to an older privacy policy (or signed up before we
  // recorded it) see a one-time notice; OK records the new version.
  async function checkPrivacyVersion() {
    ui.privacyNotice = false;
    if (!currentUser || !sb) return;
    try {
      const { data, error } = await sb.from("profiles").select("privacy_version").eq("id", currentUser.id).maybeSingle();
      if (error || !data) return; // not set up in the database yet
      if (data.privacy_version === PRIVACY_VERSION) return;
      // Agreed at sign-up but the trigger didn't save it: save it now.
      if ((currentUser.user_metadata || {}).privacy_version === PRIVACY_VERSION) return acceptPrivacy(true);
      ui.privacyNotice = true;
    } catch (e) {}
  }
  async function acceptPrivacy(quiet) {
    ui.privacyNotice = false;
    if (!quiet) render();
    try {
      await sb.from("profiles").update({ privacy_version: PRIVACY_VERSION, privacy_accepted_at: new Date().toISOString() }).eq("id", currentUser.id);
    } catch (e) {}
  }

  async function ensureUsername() {
    checkPrivacyVersion().then(() => ui.privacyNotice && render());
    ui.needUsername = false;
    if (!currentUser || !sb) return;
    try {
      const { data, error } = await sb.from("profiles").select("username, display_name").eq("id", currentUser.id).maybeSingle();
      if (error) return; // usernames not set up in the database yet
      if (data && data.username) return;
      const wanted = ((currentUser.user_metadata || {}).username || "").trim();
      if (USERNAME_RE.test(wanted)) {
        const { error: saveErr } = await sb
          .from("profiles")
          .upsert({ id: currentUser.id, username: wanted, display_name: (data && data.display_name) || wanted });
        if (!saveErr) return;
      }
      ui.needUsername = true;
    } catch (e) {}
  }

  function renderChooseUsername() {
    return gateShell(
      "Choose a username",
      "Pick the name your friends will see. You can't share one with anyone else.",
      '<form id="username-form" class="auth-form" novalidate>' + usernameField("choose-username") + authNotes() +
        '<button type="submit" class="btn btn-green btn-block">Save username</button></form>'
    );
  }

  async function submitUsername() {
    const name = document.getElementById("choose-username").value.trim();
    ui.authUsername = name;
    ui.authErr = "";
    if (!USERNAME_RE.test(name)) {
      ui.authErr = "Use 3 to 20 letters, numbers or _ (no spaces).";
      return render();
    }
    const { data: existing } = await sb.from("profiles").select("display_name").eq("id", currentUser.id).maybeSingle();
    const { error } = await sb
      .from("profiles")
      .upsert({ id: currentUser.id, username: name, display_name: (existing && existing.display_name) || name });
    if (error) {
      ui.authErr = /duplicate|unique/i.test(error.message || "") ? "That username is taken. Please choose another." : "Couldn't save your username. Please try again.";
      return render();
    }
    ui.needUsername = false;
    ui.authUsername = "";
    ui.userName = (existing && existing.display_name) || name;
    friends.loaded = false;
    ui.flash = "Username saved. Friends can now find you as " + name + ".";
    render();
  }

  async function afterSignIn() {
    await refreshUser();
    ui.authMsg = "";
    ui.authErr = "";
    ui.authSentTo = "";
    await ensureUsername();
    ui.userName = currentUser ? await displayName(currentUser) : "";
    await checkMembership();
    await checkAdmin();
    claimReferral();
    if (canSync()) {
      // Answers entered on this device as a guest are uploaded if the
      // account has nothing saved yet.
      survey = await loadSurvey();
      saveSurveyRemote(survey);
      await loadHistory();
      if (currentPath() === "/account") location.hash = "#/results";
    }
    notifStart();
    render();
  }

  // ==================== login & paywall screens ====================

  // On a phone the website's footer is hidden, so its pages live here, as a
  // grouped list like an iPhone's Settings.
  function appLinks() {
    const rows = [["#/about", "About CO2 Counter"], ["#/how-we-calculate", "How we calculate"], ["#/budget", "The 1.5°C budget"], ["#/switches", "Greener switches"], ["#/privacy", "Privacy"], ["#/terms", "Terms"]];
    return '<nav class="app-links" aria-label="About CO2 Counter"><h2 class="app-links-h">About</h2><ul>' +
      rows.map(([h, l]) => '<li><a href="' + h + '"><span>' + l + "</span>" + icon("chevronRight") + "</a></li>").join("") + "</ul></nav>";
  }

  function gateShell(title, subtitle, body) {
    return (
      '<div class="gate"><div class="gate-card fade-up"><div class="gate-brand"><span class="page-badge">' + icon("leaf") +
      '</span><span class="brand-name lg">CO2 Counter</span></div><h1 class="gate-title">' + esc(title) + "</h1>" +
      (subtitle ? '<p class="sm muted mb-5">' + esc(subtitle) + "</p>" : "") + body + "</div>" + (currentPath() === "/account" ? appLinks() : "") + "</div>"
    );
  }

  function renderLogin() {
    if (ui.recovery) return gateShell("Choose a new password", "Type your new password twice to make sure it's right.", authForm());
    if (ui.authSentTo) return gateShell("Check your inbox", "", authForm());
    if (ui.authMode === "reset") return gateShell("Reset your password", "", authForm());
    const signup = ui.authMode === "signup";
    return gateShell(
      signup ? "Create your account" : "Sign in",
      signup ? "Save your results and see your full breakdown." : "Welcome back. Sign in to see your results.",
      authForm()
    );
  }

  // Email links carry a one-time code that the page only uses when the
  // person taps the button. Email scanners (Outlook's, for one) open links
  // to check them, which would use up a link that verified straight away.
  function renderVerify() {
    const recovery = ui.pendingVerify.type === "recovery";
    return gateShell(
      recovery ? "Reset your password" : "Confirm your email",
      recovery ? "Tap below to choose a new password." : "One last step: tap below to confirm your email and sign in.",
      '<div class="auth-form">' + authNotes() +
        '<button type="button" class="btn btn-green btn-block" data-action="verify-link">' +
        (recovery ? "Choose a new password" : "Confirm my email") + "</button></div>"
    );
  }

  function paymentUrl() {
    const params = new URLSearchParams({ client_reference_id: currentUser.id, prefilled_email: currentUser.email || "" });
    return STRIPE_PAYMENT_LINK + (STRIPE_PAYMENT_LINK.includes("?") ? "&" : "?") + params.toString();
  }

  const MEMBER_PERKS = [
    "Where your footprint comes from, category by category",
    "Personal tips with the savings each one could make",
    "Step-by-step guides to cut each part of your footprint",
    "Your answers saved across all your devices, with your history over time",
  ];

  const perksList = () =>
    '<ul class="perks">' + MEMBER_PERKS.map((p) => "<li>" + icon("check") + "<span>" + esc(p) + "</span></li>").join("") + "</ul>";

  // The join button (or the reason it can't be shown) for a signed-in
  // non-member, or a sign-up prompt for a guest.
  function joinAction() {
    if (!currentUser) {
      return (
        '<button type="button" class="btn btn-green btn-block" data-action="start-signup">Create an account and join</button>' +
        '<p class="xs muted mt-2 center">Already have an account? <button type="button" class="link-btn" data-action="start-signin">Sign in</button></p>'
      );
    }
    const m = membership || {};
    let action;
    if (ui.confirmingPayment) {
      action = '<div class="label-row center-row"><div class="spinner sm"></div><span class="sm muted">Confirming your payment…</span></div>';
    } else if (m.error) {
      action =
        '<p class="sm red mb-3">We couldn\'t check your membership. Check your connection and try again.</p>' +
        '<button type="button" class="btn btn-green btn-block" data-action="recheck-membership">Try again</button>';
    } else if (isNativeApp()) {
      // App Store rules: no purchase button or link to an outside payment
      // page inside the iOS app.
      action =
        '<p class="sm">To join, visit <span class="fw-600">co2counter.co.uk</span> in your web browser and sign in with this account. Then come back here.</p>' +
        '<button type="button" class="btn btn-outline btn-block mt-4" data-action="recheck-membership">I\'ve joined, check again</button>';
    } else if (!STRIPE_PAYMENT_LINK) {
      action = '<p class="sm muted">Payments aren\'t switched on yet. Please check back soon.</p>';
    } else {
      action =
        '<a class="btn btn-green btn-block" href="' + esc(paymentUrl()) + '">Join for £2 a year</a>' +
        '<p class="xs muted mt-2 center">Secure payment by Stripe. Renews yearly; cancel any time. By joining you agree to our ' +
        '<a class="link-btn" href="/terms/">Terms</a> and <a class="link-btn" href="/privacy/">Privacy policy</a>.</p>' +
        '<button type="button" class="link-btn mt-3" data-action="recheck-membership">Already paid? Check again</button>';
    }
    if (ui.paymentTimedOut && !ui.confirmingPayment) {
      action =
        '<p class="sm mb-3">Your payment is still being confirmed. This usually takes a few seconds.</p>' + action;
    }
    return action;
  }

  function renderPaywall() {
    return gateShell(
      "Join CO2 Counter",
      "Signed in as " + (currentUser.email || ""),
      '<div class="price"><span class="price-num">£2</span><span class="muted"> / year</span></div>' + perksList() + joinAction() +
        '<div class="center mt-5"><button type="button" class="link-btn muted-link" data-action="sign-out">Sign out</button>' +
        (ui.confirmDelete ? "" : ' · <button type="button" class="link-btn muted-link" data-action="delete-account">Delete account</button>') +
        "</div>" +
        (ui.confirmDelete ? '<div class="mt-5">' + deleteAccountCard() + "</div>" : "")
    );
  }

  // Free results: the yearly total and how it compares with the UK
  // average, then an invitation to unlock the rest.
  function renderResultsPreview() {
    const fp = footprint(survey);
    const cmp = ukComparison(fp);
    return (
      '<div class="container narrow">' + pageHeader("Your Carbon Footprint") +
      '<div class="card hero fade-up"><div class="glow"></div><div class="rel">' +
      '<p class="sm muted">Your estimated footprint</p>' +
      '<div class="big-number"><span class="num">' + fp.totalYearly.toLocaleString(undefined, { maximumFractionDigits: 0 }) +
      '</span><span class="unit">kg CO₂e / year</span></div>' +
      '<p class="sm muted mt-1">≈ ' + (fp.totalYearly / 1000).toFixed(1) + " tonnes</p>" +
      '<div class="chip-row mt-5">' + ukPill(cmp) + "</div>" + ukNote(cmp) + sharedLine(fp.totalYearly) + "</div></div>" +
      '<div class="card callout strong fade-up"><div class="label-row mb-4"><span class="round-badge sm">' + icon("lock") +
      '</span><span class="eyebrow">' + (FREE_MODE ? "See your full results, free" : "Unlock your full results") + "</span></div>" +
      '<h3 class="tip-title">See where your footprint comes from, and how to cut it</h3>' +
      (FREE_MODE
        ? '<p class="sm muted mb-2">Create a free account (it takes a minute) to see everything below. Your answers are saved to it.</p>' + perksList() +
          '<div class="max-sm"><button type="button" class="btn btn-green btn-block" data-action="start-signup">Create a free account</button>' +
          '<p class="xs muted mt-2 center">Already have an account? <button type="button" class="link-btn" data-action="start-signin">Sign in</button></p></div></div>'
        : '<div class="price mb-0"><span class="price-num">£2</span><span class="muted"> / year</span></div>' + perksList() +
          '<div class="max-sm">' + joinAction() + "</div></div>") +
      '<div class="btn-row"><button type="button" class="btn btn-outline" data-action="edit-survey">' + icon("refresh") + " Edit my answers</button></div>" +
      '<p class="xs muted footnote">Estimates are approximate and based on typical lifecycle emission factors. <a class="link-btn" href="/how-we-calculate/">How we calculate</a></p></div>'
    );
  }

  // Members-only pages: guests are asked to sign in, non-members to join.
  function renderLocked() {
    if (!currentUser) return renderLogin();
    return renderPaywall();
  }

  // After Stripe checkout the webhook may land a moment after the person is
  // sent back here, so poll briefly before giving up.
  async function waitForPayment() {
    ui.confirmingPayment = true;
    render();
    for (let i = 0; i < 15; i++) {
      await checkMembership();
      if (membership && membership.access) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    ui.confirmingPayment = false;
    ui.paymentTimedOut = !(membership && membership.access);
    if (membership && membership.access) survey = await loadSurvey();
    render();
  }

  // ==================== routing & rendering ====================

  // Public pages also have real addresses (co2counter.co.uk/about/ and so
  // on, built by scripts/build-pages.mjs) so search engines can find them.
  const PAGE_PATHS = { "/about/": "/about", "/greener-switches/": "/switches", "/how-we-calculate/": "/how-we-calculate", "/budget/": "/budget", "/example/": "/example", "/privacy/": "/privacy", "/terms/": "/terms" };
  function currentPath() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return PAGE_PATHS[location.pathname.replace(/\/?$/, "/")] || "/";
    return hash.split("?")[0];
  }

  function render() {
    const path = currentPath();
    // While a new survey is open, every other page shows the finished one.
    if (ui.newSurvey) survey = path === "/" ? ui.draft : ui.prevSurvey;
    applyInputs(path === "/example" ? liveInputs : factorsFor(survey));
    // Leaving the survey ends an edit; the Survey tab asks again next time.
    if (path !== "/") ui.editing = false;
    if (path !== "/results") ui.celebrate = null;
    const parts = path.split("/").filter(Boolean);
    let html;
    const member = canSync();
    const full = hasFullAccess();
    if (!authChecked || !survey || (currentUser && !membership)) html = spinner;
    else if (ui.pendingVerify) html = renderVerify();
    else if (ui.recovery) html = renderLogin();
    else if (currentUser && ui.needUsername && !["/privacy", "/terms", "/how-we-calculate", "/budget", "/about", "/switches"].includes(path)) html = renderChooseUsername();
    else if (path === "/welcome") html = renderIntro();
    else if (path === "/example") html = renderExample();
    else if (path === "/") html = showIntroFirst() ? renderIntro() : renderSurvey();
    else if (path === "/how-we-calculate") html = renderMethod();
    else if (path === "/budget") html = renderBudget();
    else if (path === "/privacy") html = renderPrivacy();
    else if (path === "/terms") html = renderTerms();
    else if (path === "/about") html = renderAbout();
    else if (path === "/switches") html = renderSwitches();
    else if (path === "/analytics")
      html = ui.isAdmin ? renderAnalytics() : adminsOnly("the analytics");
    else if (path === "/inputs")
      html = ui.isAdmin ? renderInputs() : adminsOnly("the figures");
    else if ((path === "/results" || (parts[0] === "explainer" && parts[1])) && !survey.completedAt) html = noResultsYet();
    else if (path === "/results") html = full ? renderResults() : renderResultsPreview();
    else if (parts[0] === "explainer" && parts[1]) html = full ? renderExplainer(parts[1]) : renderLocked();
    else if (parts[0] === "guide" && parts[1]) {
      // Old guide links open the category with the guide's pop-up.
      if (D.EXPLAINERS[parts[1]]) ui.openSheet = { cat: parts[1], index: guideIndex(parts[1]) };
      location.replace("#/explainer/" + parts[1]);
      return;
    }
    else if (path === "/check-in" || path === "/habits" || path === "/habits/level") html = renderHabitsPage();
    else if (parts[0] === "acts" && parts[1]) html = renderActPage(parts[1]);
    else if (path === "/confirm/energy") html = renderConfirmEnergy();
    else if (path === "/friends") html = member ? renderFriends() : renderLocked();
    else if (path === "/account") html = member ? renderAccount() : renderLocked();
    else html = notFound(false);
    setNav(path === "/habits/level" ? "/habits" : parts[0] === "explainer" || parts[0] === "guide" || path === "/example" ? "/results" : path === "/welcome" || (path === "/" && html.includes("intro-v2")) ? "" : path);
    if (ui.privacyNotice && currentUser && html !== spinner && path !== "/privacy") {
      html =
        '<div class="flash privacy-note" role="status">' + icon("info") + "<span>We've updated our privacy policy, including how we use anonymised totals. " +
        '<a class="link-btn" href="/privacy/">Read it</a></span><button type="button" class="btn btn-green btn-sm" data-action="accept-privacy">OK</button></div>' + html;
    }
    // Offline: say so, and that the page is what's saved on this phone.
    if (!navigator.onLine && html !== spinner)
      html = '<div class="offline-note" role="status">' + icon("info") + "<span><b>You're offline.</b> Showing what's saved on this phone. Changes save when you're back online.</span></div>" + html;
    if (ui.flash && html !== spinner) {
      html =
        '<div class="flash" role="status">' + icon("check") + "<span>" + esc(ui.flash) + "</span>" +
        '<button type="button" class="icon-btn" data-action="dismiss-flash" aria-label="Dismiss">' + icon("x") + "</button></div>" + html;
    }
    // Re-rendering a form after an error shouldn't wipe the passwords
    // someone just typed.
    const kept = PASSWORD_IDS.map((id) => [id, document.getElementById(id)]).filter(([, el]) => el && el.value);
    // Cards slide in the first time you see a page; after that it just shows.
    document.body.classList.toggle("calm", seenPaths.has(path));
    if (html !== spinner) seenPaths.add(path);
    app.innerHTML = glyphify(fillTokens(html));
    shellSync();
    countUp();
    animateMoves();
    animateProgress();
    freshSpin(path);
    // A link straight to one step (a "biggest move" on Results, or an old
    // guide link) opens its pop-up once the category page is drawn.
    if (ui.openSheet && parts[0] === "explainer" && parts[1] === ui.openSheet.cat) {
      const o = ui.openSheet;
      ui.openSheet = null;
      setTimeout(() => openSectionDialog(o.cat, o.index), 30);
    }
    if ((path === "/habits" || path === "/check-in") && ui.hbSheet && hbSheetBuild) paintHbSheet(false);
    if (path === "/switches" && app.querySelector(".sw-board")) startSwitchDemo();
    if (path === "/switches" && ui.jumpSwitch) {
      const card = document.getElementById("switch-" + ui.jumpSwitch);
      ui.jumpSwitch = null;
      if (card) setTimeout(() => card.scrollIntoView({ block: "start" }), 50);
    }
    kept.forEach(([id, el]) => {
      const now = document.getElementById(id);
      if (now) now.value = el.value;
    });
    updatePasswordMatch();
    // A screen whose data arrives a moment later gets its place back then,
    // unless you've already started scrolling.
    if (ui.restoreScroll && (ui.restoreScroll.path !== path || Date.now() - ui.restoreScroll.t > 2500)) ui.restoreScroll = null;
    if (ui.restoreScroll && html !== spinner) {
      const r = ui.restoreScroll;
      if (document.documentElement.scrollHeight - innerHeight >= r.y - 2) { window.scrollTo(0, r.y); ui.restoreScroll = null; }
    }
    watchTitle();
    syncNextDock(path);
    // From the Next act bar on another page: open that act once Habits is drawn.
    if ((path === "/habits" || path === "/check-in") && ui.openActAfter && hbSheetBuild) {
      ui.hbSheet = { n: ui.openActAfter, stage: "pick" };
      ui.openActAfter = null;
      paintHbSheet(true);
    }
  }


  // ---------- the Next act bar (phone) ----------
  // Once you scroll down My Habits or Results, a slim bar slides up above
  // the tab bar with the next act to do. Tap it to open that act.
  let nextDock = null;
  function syncNextDock(path) {
    if (!nextDock) {
      nextDock = document.createElement("a");
      nextDock.id = "next-dock";
      nextDock.className = "next-dock";
      nextDock.href = "#/habits";
      nextDock.setAttribute("data-action", "next-dock");
      document.body.appendChild(nextDock);
    }
    let a = null;
    if (onPhoneScreen() && (path === "/habits" || path === "/check-in" || path === "/results") && survey && survey.completedAt) {
      try { a = habitActs().acts.find((x) => !x.done && !x.pending); } catch (e) {}
    }
    if (!a) {
      nextDock.hidden = true;
      nextDock.classList.remove("on");
      return;
    }
    const save = a.save >= 0.5 && a.n <= 4 ? "−" + kgFmt(a.save) + " kg" : a.n === 6 ? "1 letter" : a.n === 7 ? "Invite 7" : "";
    nextDock.dataset.n = a.n;
    nextDock.setAttribute("aria-label", "Next act: " + a.name);
    nextDock.innerHTML = glyphify('<span class="nd-ic" style="background:' + HB_COL[a.n] + '" aria-hidden="true">' + svgPath(a.icon, 18) + '</span><span class="min0 nd-t"><small>Next act</small><b class="display">' + esc(a.name) + "</b></span>" +
      (save ? '<span class="nd-kg tnum">' + save + "</span>" : "") + '<span class="nd-go" aria-hidden="true">' + icon("chevronRight") + "</span>");
    nextDock.hidden = false;
    dockScroll();
  }
  function dockScroll() {
    if (!nextDock || nextDock.hidden) return;
    // On My Habits: once the list's own "Next" row has scrolled away.
    // Shown once the page's own next-act button (the Next row, or the button
    // on Results) has scrolled away, so the two never show at once.
    const mark = app.querySelector(".hbf-list .hbf-next");
    const own = mark ? mark.closest(".hbf-row") : app.querySelector(".res-cta");
    const on = own ? own.getBoundingClientRect().bottom < 40 : window.scrollY > 260;
    nextDock.classList.toggle("on", on);
  }
  window.addEventListener("scroll", () => requestAnimationFrame(dockScroll), { passive: true });

  const seenPaths = new Set();
  window.addEventListener("online", () => render());
  window.addEventListener("offline", () => render());
  const PASSWORD_IDS = ["auth-password", "auth-password2", "new-password", "new-password2"];

  function onRouteChange() {
    // Moving on from a real page address (/about/ ...) inside the app: show
    // the usual /#/… address rather than /about/#/….
    if (location.pathname !== "/" && location.hash && !/^\/(?:index\.html)?$/.test(location.pathname)) history.replaceState(null, "", "/" + location.hash);
    closeModal();
    ui.shownStep = null;
    ui.flash = "";
    ui.inputMsg = null;
    ui.switchTouched = false;
    ui.switchOn = null;
    // Friends shows what it has straight away and refreshes in the background.
    if (currentPath() === "/friends") {
      friends.msg = "";
      if (friends.loaded) setTimeout(() => loadFriends(), 0);
    }
    ui.commuteOpen = null;
    ui.airport = null;
    if (currentPath() !== "/results") ui.selectedCategory = null;
    // Which way are we going? Back to where we came from, into an inner
    // screen, or across the tabs.
    const from = lastRoute, to = currentPath();
    if (from) scrollMem[from] = window.scrollY;
    let dir = null;
    if (!navTrail) navTrail = [to];
    else if (from !== to) {
      if (navTrail.length > 1 && navTrail[navTrail.length - 2] === to) { dir = "pop"; navTrail.pop(); }
      else if (pathDepth(to) === 1 && pathDepth(from || "/") === 1) { dir = "tab"; navTrail = [to]; }
      else if (pathDepth(to) === 2) { dir = "push"; navTrail.push(to); if (navTrail.length > 12) navTrail.splice(1, 1); }
      else { dir = "pop"; navTrail = [to]; }
    }
    const intent = navIntent;
    navIntent = null;
    lastRoute = to;
    render();
    // Every page opens at the top, whether from a tab, Back or a link.
    window.scrollTo(0, 0);
    ui.restoreScroll = null;
    // A browser's own back swipe animates by itself, so only our Back slides.
    glide(dir === "pop" ? (intent === "back" ? "pop" : null) : dir);
  }

  function setPath(obj, path, value) {
    const [a, b] = path.split(".");
    obj[a] = { ...(obj[a] || {}), [b]: value };
  }

  // Moving between questions: the current one fades out, then the next
  // fades in (straight away for people who prefer reduced motion).
  let qFadeTimer = null;
  function fadeToQuestion(q) {
    const go = () => {
      qFadeTimer = null;
      ui.q = q;
      render();
      const top = document.querySelector(".step-body");
      if (top && top.getBoundingClientRect().top < 0) window.scrollTo(0, 0);
    };
    clearTimeout(qFadeTimer);
    const list = document.querySelector(".q-list.one");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!list || reduce) return go();
    list.classList.add("q-leave");
    qFadeTimer = setTimeout(go, 180);
  }
  // Single-choice answers move on by themselves, after a beat to show the
  // tick. Not on a step's last question, so a new section never jumps in.
  function autoAdvance() {
    const step = ui.step, q = ui.q;
    if (currentPath() !== "/" || q >= (ui.qCount || 1) - 1) return;
    setTimeout(() => {
      if (currentPath() === "/" && ui.step === step && ui.q === q) fadeToQuestion(q + 1);
    }, 320);
  }

  // ==================== events ====================

  const actions = {
    "goto-step": (el) => {
      ui.step = Number(el.dataset.step);
      ui.q = 0;
      ui.commuteOpen = null;
      ui.airport = null;
      render();
    },
    "prev-step": () => {
      ui.airport = null;
      if (ui.q > 0) return fadeToQuestion(ui.q - 1);
      else if (ui.step > 0) {
        ui.step--;
        ui.q = 99; // the previous step's last question
      }
      render();
      window.scrollTo(0, 0);
    },
    "next-step": () => {
      ui.airport = null;
      ui.commuteOpen = null;
      if (ui.q < (ui.qCount || 1) - 1) return fadeToQuestion(ui.q + 1);
      else if (ui.step < STEPS.length - 1) {
        ui.step++;
        ui.q = 0;
        render();
        window.scrollTo(0, 0);
      } else finishSurvey();
    },
    "set-diet": (el) => {
      const d = byKey(D.DIETS, el.dataset.key);
      const meals = { ...survey.meals, diet: d.key };
      if (d.mealKey) DAYS.forEach((day) => (meals[day] = d.mealKey));
      survey.meals = meals;
      surveyChanged();
      render();
      autoAdvance();
    },
    "set-meal": (el) => {
      survey.meals = { ...survey.meals, [el.dataset.day]: el.dataset.key };
      const i = DAYS.indexOf(el.dataset.day);
      if (i < DAYS.length - 1) ui.mealDay = DAYS[i + 1];
      surveyChanged();
      render();
    },
    "set-eatout": (el) => {
      survey.meals = { ...survey.meals, eatOut: Number(el.dataset.value) };
      surveyChanged();
      render();
      autoAdvance();
    },
    "set-waste": (el) => {
      survey.meals = { ...survey.meals, foodWaste: el.dataset.key };
      surveyChanged();
      render();
    },
    "toggle-commute": (el) => {
      ui.commuteOpen = el.dataset.day;
      render();
    },
    "set-commute": (el) => {
      survey.commute = { ...survey.commute, [el.dataset.day]: el.dataset.key };
      const i = DAYS.indexOf(el.dataset.day);
      ui.commuteOpen = i < DAYS.length - 1 ? DAYS[i + 1] : el.dataset.day;
      surveyChanged();
      render();
    },
    "add-travel": (el) => {
      if (el.dataset.kind === "extra") survey.extraTravel = survey.extraTravel.concat({ mode: "car_petrol", km: 0 });
      else survey.longTrips = survey.longTrips.concat({ from: "", to: "", mode: "train", km: 0, returnTrip: true });
      surveyChanged();
      render();
    },
    "remove-travel": (el) => {
      const i = Number(el.dataset.index);
      const key = el.dataset.kind === "extra" ? "extraTravel" : "longTrips";
      survey[key] = survey[key].filter((_, idx) => idx !== i);
      surveyChanged();
      render();
    },
    "set-car-owns": (el) => {
      const owns = el.dataset.value;
      survey.car = { ...(survey.car || {}), owns };
      if (owns === "yes" && !survey.cars.length) survey.cars = [{ fuel: "petrol", size: "medium", share: 1, miles: 0 }];
      if (owns === "no") survey.cars = [];
      surveyChanged();
      render();
      // "Yes" opens the car's details on the same question.
      if (owns === "no") autoAdvance();
    },
    "set-car": (el) => {
      const i = Number(el.dataset.index);
      survey.cars = survey.cars.map((c, idx) => (idx === i ? { ...c, [el.dataset.key]: el.dataset.value } : c));
      surveyChanged();
      render();
    },
    "add-car": () => {
      survey.cars = survey.cars.concat({ fuel: "petrol", size: "medium", share: 1, miles: 0 });
      surveyChanged();
      render();
    },
    "dup-car": (el) => {
      const i = Number(el.dataset.index);
      survey.cars = survey.cars.slice(0, i + 1).concat({ ...survey.cars[i] }, survey.cars.slice(i + 1));
      surveyChanged();
      render();
      flashCopy(i + 1, "car");
    },
    "remove-car": (el) => {
      const i = Number(el.dataset.index);
      survey.cars = survey.cars.filter((_, idx) => idx !== i);
      if (!survey.cars.length) survey.car = { ...(survey.car || {}), owns: "no" };
      surveyChanged();
      render();
    },
    "add-flight": () => {
      survey.flights = survey.flights.concat({ from: "", to: "", cabin: "economy", returnTrip: true, date: new Date().toISOString().slice(0, 10) });
      surveyChanged();
      render();
    },
    // A copy goes straight under the original, ready to tweak (e.g. the date).
    "dup-flight": (el) => {
      const i = Number(el.dataset.index);
      survey.flights = survey.flights.slice(0, i + 1).concat({ ...survey.flights[i] }, survey.flights.slice(i + 1));
      ui.airport = null;
      surveyChanged();
      render();
      flashCopy(i + 1);
    },
    "dup-travel": (el) => {
      const i = Number(el.dataset.index);
      const key = el.dataset.kind === "extra" ? "extraTravel" : "longTrips";
      survey[key] = survey[key].slice(0, i + 1).concat({ ...survey[key][i] }, survey[key].slice(i + 1));
      surveyChanged();
      render();
      flashCopy(i + 1, el.dataset.kind);
    },
    "remove-flight": (el) => {
      const i = Number(el.dataset.index);
      survey.flights = survey.flights.filter((_, idx) => idx !== i);
      ui.airport = null;
      surveyChanged();
      render();
    },
    "open-airport": (el) => {
      const index = Number(el.dataset.index);
      const field = el.dataset.field;
      const same = ui.airport && ui.airport.index === index && ui.airport.field === field;
      ui.airport = same ? null : { index, field };
      ui.airportQuery = "";
      render();
      const input = document.getElementById("airport-search");
      if (input) input.focus();
    },
    "pick-airport": (el) => {
      const { index, field } = ui.airport;
      survey.flights = survey.flights.map((f, i) => (i === index ? { ...f, [field]: el.dataset.code } : f));
      ui.airport = null;
      surveyChanged();
      render();
    },
    // After the bill payer confirms: record the green tariff in the survey.
    "set-green-done": () => {
      survey.energy = { ...survey.energy, greenTariff: true };
      surveyChanged();
      ui.flash = "Survey updated: you're on a green tariff.";
      render();
    },
    "confirm-energy": async () => {
      const token = (location.hash.match(/[?&]t=([A-Za-z0-9]+)/) || [])[1];
      ui.confirmState = "saving";
      render();
      try {
        const { data, error } = await sb.rpc("confirm_energy_switch", { p_token: token || "" });
        ui.confirmState = !error && data ? "done" : "bad";
      } catch (e) {
        ui.confirmState = "bad";
      }
      render();
    },
    "set-billpayer": (el) => {
      survey.energy = { ...survey.energy, billPayer: el.dataset.value };
      surveyChanged();
      render();
      autoAdvance();
    },
    "energy-asked": () => {
      const t = { ...actsTicked(), energyAsked: true };
      try { localStorage.setItem(actsKey(), JSON.stringify(t)); } catch (e) {}
      if (ui.acts) ui.acts = t;
      if (currentUser && sb) sb.from("profiles").update({ acts: t }).eq("id", currentUser.id).then(() => {}, () => {});
      setTimeout(render, 300);
    },
    "ask-who": (el) => {
      ui.askWho = el.dataset.who;
      render();
    },
    "copy-energy-ask": async () => {
      try { await navigator.clipboard.writeText(energyAskText().body); ui.askMsg = "Copied. Paste it into a message to them."; } catch (e) { ui.askMsg = "Couldn't copy. Select the text in your email app instead."; }
      actions["energy-asked"]();
    },
    "set-green": (el) => {
      survey.energy = { ...survey.energy, greenTariff: el.dataset.value === "1" };
      surveyChanged();
      render();
      // "No" asks who chooses the supplier on the same question.
      if (el.dataset.value === "1") autoAdvance();
    },
    "step-field": (el) => {
      const [x, y] = el.dataset.field.split(".");
      const now = Number((survey[x] || {})[y]) || 0;
      const v = Math.max(Number(el.dataset.min) || 0, Math.round((now + Number(el.dataset.delta)) * 10) / 10);
      setPath(survey, el.dataset.field, v);
      surveyChanged();
      render();
    },
    // A link inside a clickable card: let the link do its job.
    go: () => {},
    "start-survey": () => {
      lsSet(KEY_SEEN_INTRO, true);
      if (location.pathname !== "/" && !/^\/index\.html$/.test(location.pathname)) {
        // From a real page address (/example/ ...): over to the survey.
        history.replaceState(null, "", "/#/");
        onRouteChange();
      } else if (location.hash === "#/" || location.hash === "") render();
      else location.hash = "#/";
      window.scrollTo(0, 0);
    },
    "meal-count": (el) => {
      const counts = mealDayCounts(survey);
      const total = Object.values(counts).reduce((t, v) => t + v, 0);
      const k = el.dataset.key, delta = Number(el.dataset.delta);
      if (delta > 0 && total >= 7) return;
      counts[k] = Math.max(0, (counts[k] || 0) + delta);
      survey.meals = mealsFromCounts(survey.meals, counts);
      surveyChanged();
      render();
    },
    "add-extra": (el) => {
      const b = survey.banking || {};
      const extra = (Array.isArray(b.extra) ? b.extra : []).concat(el.dataset.kind === "pension" ? { kind: "pension", provider: "", amount: 0 } : { kind: "bank", bank: "", amount: 0 });
      survey.banking = { ...b, extra };
      surveyChanged();
      render();
    },
    "remove-extra": (el) => {
      const b = survey.banking || {};
      survey.banking = { ...b, extra: (b.extra || []).filter((_, i) => i !== Number(el.dataset.i)) };
      surveyChanged();
      render();
    },
    "pc-toggle": (el, e) => {
      e.preventDefault();
      ui.pcFind = { ...(ui.pcFind || {}), open: !(ui.pcFind && ui.pcFind.open) };
      render();
    },
    "pick-meal-day": (el) => {
      ui.mealDay = el.dataset.day;
      render();
    },
    "toggle-green": () => {
      survey.energy = { ...survey.energy, greenTariff: !survey.energy.greenTariff };
      surveyChanged();
      render();
    },
    "select-category": (el) => {
      location.hash = "#/explainer/" + el.dataset.key;
    },
    "chart-mode": (el) => {
      ui.chartMode = el.dataset.mode;
      if (ui.chartMode === "donut" && ui.showUk) {
        ui.showUk = false;
        lsSet(KEY_SHOW_UK, false);
      }
      lsSet("co2_chart_mode", ui.chartMode);
      render();
    },
    "open-move": (el, e) => {
      e.preventDefault();
      const cat = el.dataset.cat;
      // Flights moves land on the Flights page itself; others open their guide.
      if (cat !== "flights") ui.openSheet = { cat, index: guideIndex(cat) };
      if (currentPath() === "/explainer/" + cat) render();
      else location.hash = "#/explainer/" + cat;
    },
    "update-step": (el) => {
      const step = Number(el.dataset.step) || 0;
      closeModal();
      actions["whats-changed"]();
      ui.reviewing = false;
      ui.fromReview = true;
      ui.step = step;
      ui.q = 0;
      location.hash = "#/";
      render();
      window.scrollTo(0, 0);
    },
    "close-and-go": (el, e) => {
      e.preventDefault();
      closeModal();
      location.hash = el.getAttribute("href");
    },
    "top-opportunity": () => {
      ui.selectedCategory = null;
      render();
    },
    "open-section": (el) => {
      const parts = currentPath().split("/").filter(Boolean);
      openSectionDialog(parts[1], Number(el.dataset.index));
    },
    "ph-more": (el) => {
      const li = el.closest(".ph-more-li");
      const prev = (li || el).previousElementSibling;
      const t = prev && (prev.classList.contains("ph-clamp") ? prev : prev.querySelector(".ph-clamp"));
      if (t) t.classList.add("open");
      (li || el).remove();
    },
    // The title bar's Back: where you came from, else the screen above.
    "nav-back": (el) => {
      const to = el.dataset.to;
      if (!to) return;
      navIntent = "back";
      if (navTrail && navTrail.length > 1 && navTrail[navTrail.length - 2] === to) history.back();
      else location.hash = "#" + to;
    },
    "close-modal": (el, e) => {
      if (e.target === el || el.classList.contains("modal-close")) closeModal();
    },
    "remove-habit": (el) => {
      const cat = el.dataset.cat;
      lsSet(KEY_HABITS + cat, committedHabits(cat).filter((id) => id !== el.dataset.id));
      render();
    },
    "check-in": (el) => {
      toggleCheckIn(el.dataset.id);
      render();
    },
    "complete-goal": (el) => {
      const id = el.dataset.id;
      updateGoal(id, { done: !goalFor(id).done });
      render();
    },
    "auth-mode": (el) => {
      const email = document.getElementById("auth-email");
      if (email) ui.authEmail = email.value.trim();
      ui.authMode = el.dataset.mode;
      ui.authSentTo = "";
      ui.authErr = "";
      ui.authMsg = "";
      render();
    },
    "toggle-pw": (el) => {
      const input = document.getElementById(el.dataset.target);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      el.textContent = show ? "Hide" : "Show";
      el.setAttribute("aria-label", show ? "Hide password" : "Show password");
    },
    "resend-confirm": async () => {
      ui.authErr = "";
      ui.authMsg = "";
      const { error } = await sb.auth.resend({ type: "signup", email: ui.authSentTo, options: { emailRedirectTo: authRedirectUrl() } });
      if (error) ui.authErr = friendlyAuthError(error);
      else ui.authMsg = "Sent. It can take a minute to arrive.";
      render();
    },
    "verify-link": async (el) => {
      const { tokenHash, type } = ui.pendingVerify;
      el.disabled = true;
      el.textContent = "One moment…";
      const { data, error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
      ui.pendingVerify = null;
      if (error || !data || !data.session) {
        ui.authMode = "signin";
        ui.authErr =
          type === "recovery"
            ? "That reset link has expired or has already been used. Ask for a new one below."
            : "That link has expired or has already been used. If you've confirmed your email before, just sign in. If not, sign in anyway and we'll send you a fresh link.";
        if (type === "recovery") ui.authMode = "reset";
        location.hash = "#/account";
        return render();
      }
      if (type === "recovery") {
        ui.recovery = true;
        ssSet(KEY_RECOVERY, true);
        await refreshUser();
        await checkMembership();
        return render();
      }
      ui.flash = "Your email is confirmed and you're signed in.";
      await afterSignIn();
      render();
    },
    "toggle-uk": () => {
      ui.showUk = !ui.showUk;
      lsSet(KEY_SHOW_UK, ui.showUk);
      render();
    },
    "dismiss-flash": () => {
      ui.flash = "";
      render();
    },
    "update-figures": () => {
      if (location.hash !== "#/") history.pushState(null, "", "#/");
      actions["whats-changed"]();
    },
    "save-input": (el) => {
      const key = el.dataset.key;
      const d = inputDef(key);
      const val = document.querySelector('[data-input-key="' + key + '"]');
      const src = document.querySelector('[data-input-src="' + key + '"]');
      const value = Number(val.value);
      if (val.value.trim() === "" || !isFinite(value) || value < 0) {
        ui.inputMsg = { ok: false, text: d.label + " needs a number of 0 or more." };
        return render();
      }
      const was = liveInputs[key];
      if (was > 0 && Math.abs(value - was) / was > 0.5 && !window.confirm(d.label + " would change by " + Math.round((Math.abs(value - was) / was) * 100) + "% (" + numText(was) + " → " + numText(value) + "). Save it?")) return;
      el.disabled = true;
      el.textContent = "Saving…";
      saveInput(key, value, src.value.trim());
    },
    "reset-input": (el) => {
      const key = el.dataset.key;
      saveInput(key, BUILT_IN[key], inputDef(key).source, "Reset to built-in");
    },
    "undo-input": (el) => {
      const r = inputLog.rows[Number(el.dataset.index)];
      if (!r || r.old_value == null) return;
      const before = inputLog.rows.find((x, i) => i > Number(el.dataset.index) && x.key === r.key);
      saveInput(r.key, r.old_value, before ? before.source : inputDef(r.key).source, "Undone");
    },
    "export-inputs": () => exportInputs(),
    "select-group": async (el) => {
      ui.groupSel = el.dataset.id;
      friends.groupMsg = "";
      await loadGroupBoard(ui.groupSel);
      render();
    },
    "friends-retry": () => {
      friends.error = "";
      friends.loaded = false;
      render();
    },
    "fr-find": () => {
      const inp = document.getElementById("friend-email");
      if (!inp) return;
      inp.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      setTimeout(() => inp.focus(), 250);
    },
    "friend-add": (el) => addFriend(el.dataset.username),
    "friend-add-id": (el) => addFriendId(el.dataset.id),
    "copy-username": async () => {
      try { await navigator.clipboard.writeText("@" + ui.username); friends.msg = "Username copied."; friends.msgOk = true; } catch (e) { friends.msg = "Your username is @" + ui.username; friends.msgOk = true; }
      render();
    },
    "group-share": () => {
      ui.groupShare = !ui.groupShare;
      render();
    },
    "group-share-send": async (el) => {
      const text = "Join my group on CO2 Counter: " + el.dataset.link + " (code " + el.dataset.code + ")";
      if (navigator.share) {
        try { await navigator.share({ text }); } catch (e) {}
        return;
      }
      actions["copy-group"](el);
    },
    "group-form": (el) => {
      ui.groupForm = ui.groupForm === el.dataset.form ? "" : el.dataset.form;
      render();
      if (ui.groupForm) setTimeout(() => { const i = document.getElementById(ui.groupForm === "join" ? "group-code" : "group-name"); if (i) i.focus(); }, 60);
    },
    "feed-all": () => {
      ui.feedAll = !ui.feedAll;
      render();
    },
    "copy-group": async (el) => {
      const text = "Join my group on CO2 Counter: " + el.dataset.link + " (code " + el.dataset.code + ")";
      try {
        await navigator.clipboard.writeText(text);
        friends.groupMsg = "Invite copied. Paste it into a message or email.";
      } catch (e) {
        friends.groupMsg = "Share this code: " + el.dataset.code;
      }
      friends.groupOk = true;
      render();
    },
    "leave-group": (el) => {
      if (!window.confirm("Leave this group? You can rejoin with its code.")) return;
      groupAction(() => sb.rpc("leave_group", { p_group: el.dataset.id }), "You've left the group.");
    },
    "delete-group": (el) => {
      if (!window.confirm("Delete this group for everyone? This can't be undone.")) return;
      groupAction(() => sb.rpc("delete_group", { p_group: el.dataset.id }), "Group deleted.");
    },
    "export-research": () => exportResearch(),
    "flip-switch": (el) => {
      ui.switchTouched = true;
      const i = Number(el.dataset.i);
      ui.switchOn[i] = !ui.switchOn[i];
      updateSwitchboard();
    },
    "switch-all": () => {
      ui.switchTouched = true;
      const v = !ui.switchOn.every(Boolean);
      ui.switchOn = ui.switchOn.map(() => v);
      updateSwitchboard();
    },
    "tick-act": async (el) => {
      const t = { ...actsTicked() };
      t[el.dataset.act] = !t[el.dataset.act];
      try { localStorage.setItem(actsKey(), JSON.stringify(t)); } catch (e) {}
      if (currentUser && ui.actsFor === currentUser.id && ui.acts) ui.acts = t;
      render();
      if (currentUser && sb) {
        try { await sb.from("profiles").update({ acts: t }).eq("id", currentUser.id); } catch (e) {}
      }
    },
    // The mailto opens as normal; this just remembers it was sent.
    "mp-sent": () => {
      const t = { ...actsTicked(), mpSent: true };
      try { localStorage.setItem(actsKey(), JSON.stringify(t)); } catch (e) {}
      if (ui.acts) ui.acts = t;
      if (currentUser && sb) sb.from("profiles").update({ acts: t }).eq("id", currentUser.id).then(() => {}, () => {});
      setTimeout(render, 300);
    },
    "copy-code": async () => {
      try { await navigator.clipboard.writeText(ui.actsInfo.code); ui.shareMsg = "Invite code copied: " + ui.actsInfo.code; } catch (e) { ui.shareMsg = "Your code is " + ui.actsInfo.code; }
      render();
    },
    "copy-invite": async () => {
      try { await navigator.clipboard.writeText(inviteLink()); ui.shareMsg = "Invite link copied."; } catch (e) { ui.shareMsg = "Couldn't copy. Select the link instead."; }
      render();
    },
    // One message: the link, which shows the site's preview card.
    "share-app": async () => {
      try {
        if (navigator.share) await navigator.share({ url: inviteLink() });
        else { await navigator.clipboard.writeText(inviteLink()); ui.shareMsg = "Link copied. Paste it into a message or post."; render(); }
      } catch (e) {}
    },
    // Instagram has no share link: copy the words, then open Instagram to
    // paste them into a story or post.
    "share-instagram": async () => {
      try { await navigator.clipboard.writeText(shareText() + " " + inviteLink()); } catch (e) {}
      ui.shareMsg = "Copied. Paste it into an Instagram story or post, with a link sticker to co2counter.co.uk.";
      render();
      window.open("https://www.instagram.com/", "_blank", "noopener");
    },
    "jump-switch": (el, e) => {
      e.preventDefault();
      const card = document.getElementById("switch-" + el.dataset.cat);
      if (card) return card.scrollIntoView({ behavior: "smooth", block: "start" });
      // From the Habits page: open the switches page at that switch.
      ui.jumpSwitch = el.dataset.cat;
      location.hash = "#/switches";
    },
    "refresh-analytics": () => {
      analytics.loaded = false;
      render();
    },
    "sign-out": async () => {
      // This phone stops getting the signed-out account's notifications.
      if (isNativeApp()) await forgetPushToken();
      if (sb) await sb.auth.signOut();
      currentUser = null;
      membership = null;
      ui.isAdmin = false;
      friends.loaded = false;
      friends.rows = [];
      friends.board = [];
      ui.userName = "";
      ui.authMode = "signin";
      // The next person to use this device shouldn't see these answers.
      lsRemove(KEY_SURVEY);
      lsRemove(KEY_HISTORY);
      ui.history = [];
      ui.newSurvey = ui.reviewing = ui.fromReview = false;
      ui.draft = ui.prevSurvey = null;
      survey = normaliseSurvey(null);
      ui.step = 0;
      ui.q = 0;
      location.hash = "#/";
      render();
    },
    "start-signup": () => {
      ui.authMode = "signup";
      ui.authSentTo = "";
      ui.authErr = "";
      ui.authMsg = "";
      location.hash = "#/account";
      render();
    },
    "start-signin": () => {
      ui.authMode = "signin";
      ui.authSentTo = "";
      ui.authErr = "";
      ui.authMsg = "";
      location.hash = "#/account";
      render();
    },
    "recheck-membership": async () => {
      membership = null;
      render();
      await checkMembership();
      if (canSync()) survey = await loadSurvey();
      render();
    },
    "clear-habits": () => {
      CATEGORIES.forEach((c) => lsRemove(KEY_HABITS + c));
      render();
    },
    cheer: async (el) => {
      const post = (friends.feed || []).find((p) => p.post_key === el.dataset.key);
      if (!post || !sb) return;
      // Show it straight away, then save; put it back if saving fails.
      const was = !!post.cheered;
      post.cheered = !was;
      post.cheers = Math.max(0, (post.cheers || 0) + (was ? -1 : 1));
      render();
      const { data, error } = await sb.rpc("toggle_cheer", { p_key: post.post_key });
      if (error) {
        post.cheered = was;
        post.cheers = Math.max(0, post.cheers + (was ? 1 : -1));
        render();
      } else if (!!data !== post.cheered) {
        post.cheered = !!data;
        post.cheers = Math.max(0, post.cheers + (data ? 1 : -1));
        render();
      }
      if (!error && data) notifyFriends({ kind: "cheer", key: post.post_key });
    },
    "accept-privacy": () => acceptPrivacy(),
    "feed-stack": (el) => {
      ui.feedOpen = ui.feedOpen || {};
      ui.feedOpen[el.dataset.key] = !ui.feedOpen[el.dataset.key];
      render();
    },
    "feed-more": () => {
      ui.feedShown = (ui.feedShown || 5) + 5;
      render();
    },
    "notif-sunday-on": () => turnOnSunday(),
    "notif-sunday-no": () => {
      lsSet(KEY_SUNDAY, "off");
      render();
    },
    // The app's own page in the iPhone's Settings (Notifications is there).
    "open-app-settings": () => {
      ui.notifBlocked = false;
      window.location.href = "app-settings:";
    },
    "notif-test": async () => {
      const LN = plugin("LocalNotifications");
      if (!LN) { ui.notifTest = NO_PLUGIN_MSG; render(); return; }
      try {
        let perm = await LN.checkPermissions();
        if (perm.display !== "granted") perm = await LN.requestPermissions();
        if (perm.display !== "granted") {
          ui.notifBlocked = true;
          ui.notifTest = "Notifications are switched off for CO2 Counter, so the test can't show.";
        } else {
          await LN.schedule({ notifications: [{ id: 7002, title: "CO2 Counter", body: "Notifications are working. You'll get your Sunday switch here.", schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true }, extra: { route: "#/account" } }] });
          ui.notifTest = "Sent. It arrives in about 5 seconds, even if you leave the app.";
          // Friends' notifications come from our server through Apple: test that too.
          if (canFeedPush() && currentUser) {
            ui.notifTest += " Checking friends' notifications…";
            render();
            ui.notifTest = "Sunday reminders work (a test arrives in about 5 seconds). Friends' notifications: " + (await testRemotePush());
          }
        }
      } catch (e) {
        ui.notifTest = "The test couldn't be sent: " + ((e && e.message) || "unknown error") + ".";
      }
      render();
    },
    "notif-sunday-toggle": () => (lsGet(KEY_SUNDAY, "") === "on" ? turnOffSunday() : turnOnSunday()),
    "notif-feed-on": () => turnOnFeedPush(),
    "notif-feed-no": () => {
      lsSet(KEY_FEEDPUSH, "off");
      render();
    },
    "notif-feed-toggle": () => (lsGet(KEY_FEEDPUSH, "") === "on" ? turnOffFeedPush() : turnOnFeedPush()),
    safety: (el) => {
      ui.safety = { kind: el.dataset.kind, id: el.dataset.id, name: el.dataset.name, reason: "" };
      openSafety();
    },
    "safety-confirm": () => {
      ui.safety.confirmBlock = true;
      openSafety();
    },
    "safety-unconfirm": () => {
      ui.safety.confirmBlock = false;
      openSafety();
    },
    "safety-report": async () => {
      const sf = ui.safety;
      const picked = document.querySelector('input[name="sf-reason"]:checked');
      sf.details = (document.getElementById("sf-details") || {}).value || "";
      if (!picked) {
        sf.error = "Please pick a reason.";
        return openSafety();
      }
      sf.reason = picked.value;
      sf.busy = true;
      sf.error = "";
      openSafety();
      try {
        const { error } = await sb.rpc("report_content", sf.kind === "user" ? { p_user: sf.id, p_reason: sf.reason, p_details: sf.details } : { p_group: sf.id, p_reason: sf.reason, p_details: sf.details });
        if (error) throw error;
        sf.done = sf.kind === "user"
          ? "Thanks for telling us. We'll review it within 24 hours. You can also block " + (sf.name || "them") + " so they can't contact you."
          : "Thanks for telling us. We'll review it within 24 hours and remove the group if it breaks our rules. You can leave the group at any time.";
      } catch (e) {
        sf.error = safetyErr(e);
      }
      sf.busy = false;
      openSafety();
    },
    "safety-block": async () => {
      const sf = ui.safety;
      sf.busy = true;
      openSafety();
      try {
        const { error } = await sb.rpc("block_user", { p_user: sf.id });
        if (error) throw error;
        ui.safety = null;
        closeModal();
        friends.msg = "Blocked " + (sf.name || "them") + ". You can unblock them under Manage friends.";
        friends.msgOk = true;
        friends.loaded = false;
        await loadFriends();
        return;
      } catch (e) {
        sf.error = safetyErr(e);
      }
      sf.busy = false;
      openSafety();
    },
    unblock: async (el) => {
      await sb.rpc("unblock_user", { p_user: el.dataset.id });
      ui.frManageOpen = true;
      friends.loaded = false;
      await loadFriends();
    },
    "resolve-report": async (el) => {
      if (el.dataset.do !== "dismiss" && !window.confirm(el.dataset.do === "remove_group" ? "Remove this group for everyone?" : "Clear this person's name and username?")) return;
      const { error } = await sb.rpc("admin_resolve_report", { p_id: Number(el.dataset.id), p_action: el.dataset.do });
      ui.reportMsg = error ? error.message : "";
      const rp = await sb.rpc("admin_reports");
      if (!rp.error) analytics.reports = rp.data || [];
      render();
    },
    "share-card": () => openShareCard(),
    "invite-share": async () => {
      if (actsBeforeAfter()) return openShareCard();
      try {
        if (navigator.share) await navigator.share({ url: inviteLink() });
        else { await navigator.clipboard.writeText(inviteLink()); ui.shareMsg = "Invite link copied. Paste it into a message."; render(); }
      } catch (e) {}
    },
    "checkin-later": () => {
      lsSet(KEY_CHECKIN_SNOOZE, Date.now() + 7 * 86400000);
      render();
    },
    "share-pick": (el) => {
      ui.piIdx = Number(el.dataset.i);
      if (currentPath() === "/results") render();
      openShareCard();
    },
    "share-fmt": (el) => {
      ui.shareFmt = el.dataset.v;
      openShareCard();
    },
    "share-theme": (el) => {
      ui.shareTheme = el.dataset.v;
      openShareCard();
    },
    "pi-view": (el) => {
      ui.piView = el.dataset.key;
      ui.piPicking = false;
      lsSet(KEY_PI_VIEW, el.dataset.key);
      const tabs = document.querySelector(".pi-tabs"), left = tabs ? tabs.scrollLeft : null;
      render();
      const t2 = document.querySelector(".pi-tabs");
      if (t2 && left != null) t2.scrollLeft = left;
    },
    "pi-mascot-pick": () => {
      ui.piPicking = !ui.piPicking;
      render();
    },
    "pi-mascot-set": (el) => {
      lsSet(KEY_MASCOT, el.dataset.key);
      ui.piPicking = false;
      render();
    },
    // Picture your year: the full-screen story.
    "pi-story": (el) => openStory(el),
    // Share: the card opens on your mascot.
    "pi-share": () => {
      const v = piView();
      const k = piMine().key;
      ui.piIdx = Math.max(0, piItems().findIndex((x) => x.key === k));
      openShareCard();
    },
    "share-card-send": async () => {
      const sc = ui.shareCard;
      if (!sc) return;
      try {
        await navigator.share({ files: [sc.file] });
      } catch (e) {}
    },
    "share-link-send": async () => {
      try {
        await navigator.share({ url: inviteLink() });
      } catch (e) {}
    },
    "share-copy-text": async (el) => {
      try {
        await navigator.clipboard.writeText(inviteLink());
        el.textContent = "Link copied";
      } catch (e) {}
    },
    "stand-tab": (el) => {
      ui.standTab = el.dataset.tab;
      render();
    },
    "fr-jump": (el, e) => {
      e.preventDefault();
      const t = document.getElementById(el.getAttribute("href").slice(1));
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    "friend-accept": async (el) => {
      const { error: accErr } = await sb.from("friendships").update({ status: "accepted" }).eq("id", el.dataset.id);
      if (!accErr) notifyFriends({ kind: "friend", id: el.dataset.id });
      friends.loaded = false;
      await loadFriends();
    },
    "friend-remove": async (el) => {
      await sb.from("friendships").delete().eq("id", el.dataset.id);
      friends.loaded = false;
      await loadFriends();
    },
    "delete-account": () => {
      ui.confirmDelete = true;
      ui.deleteErr = "";
      render();
    },
    "cancel-delete": () => {
      ui.confirmDelete = false;
      ui.deleteErr = "";
      render();
    },
    "confirm-delete": async () => {
      const typed = (document.getElementById("delete-confirm") || {}).value || "";
      if (typed.trim().toUpperCase() !== "DELETE") {
        ui.deleteErr = "Type DELETE to confirm.";
        return render();
      }
      const { error } = await sb.rpc("delete_own_account");
      if (error) {
        ui.deleteErr = "Couldn't delete your account. Please try again.";
        return render();
      }
      await sb.auth.signOut().catch(() => {});
      [KEY_SURVEY, KEY_SNAPSHOTS, KEY_GOALS, KEY_STREAKS, KEY_HISTORY].forEach(lsRemove);
      ui.history = [];
      ui.newSurvey = ui.reviewing = ui.fromReview = false;
      ui.draft = ui.prevSurvey = null;
      CATEGORIES.forEach((c) => {
        lsRemove(KEY_HABITS + c);
        lsRemove(KEY_STAGE + c);
      });
      currentUser = null;
      membership = null;
      ui.confirmDelete = false;
      ui.userName = "";
      survey = normaliseSurvey(null);
      ui.step = 0;
      ui.q = 0;
      location.hash = "#/";
      render();
      alert("Your account has been deleted.");
    },
    // Starts from blank answers. Nothing is saved until they change
    // something, so leaving straight away keeps the old survey.
    "new-survey": () => {
      ui.reviewing = ui.fromReview = false;
      ui.prevSurvey = survey;
      ui.draft = normaliseSurvey(null);
      survey = ui.draft;
      ui.newSurvey = true;
      ui.editing = false;
      ui.step = 0;
      ui.q = 0;
      render();
      window.scrollTo(0, 0);
    },
    "whats-changed": () => {
      ui.prevSurvey = survey;
      const copy = JSON.parse(JSON.stringify(survey));
      delete copy.completedAt;
      delete copy.factors; // a new survey uses the latest figures
      ui.draft = normaliseSurvey(copy);
      survey = ui.draft;
      ui.newSurvey = true;
      ui.reviewing = true;
      ui.fromReview = false;
      ui.editing = false;
      render();
      window.scrollTo(0, 0);
    },
    // "Change" on one step of the completed-survey page: a quick update
    // that opens straight on that step.
    "quick-edit": (el) => {
      actions["whats-changed"]();
      actions["review-edit"](el);
    },
    "review-edit": (el) => {
      ui.reviewing = false;
      ui.fromReview = true;
      ui.step = Number(el.dataset.step) || 0;
      ui.q = 0;
      render();
      window.scrollTo(0, 0);
    },
    "review-back": () => {
      ui.reviewing = true;
      ui.fromReview = false;
      ui.airport = null;
      render();
      window.scrollTo(0, 0);
    },
    "review-save": () => finishSurvey(),
    "cancel-new-survey": () => {
      survey = ui.prevSurvey || survey;
      ui.newSurvey = ui.reviewing = ui.fromReview = false;
      ui.draft = null;
      ui.prevSurvey = null;
      ui.step = 0;
      ui.q = 0;
      ui.flash = "New survey cancelled. Your previous answers are unchanged.";
      render();
      window.scrollTo(0, 0);
    },
    // My Habits: "I've switched" opens that step of the survey to update.
    "hb-update": (el) => {
      actions["whats-changed"]();
      actions["review-edit"](el);
      if (location.hash !== "#/") location.hash = "#/";
    },
    "hero-next": (el, e) => {
      if (e) e.preventDefault();
      const n = +el.dataset.n;
      if (onPhoneScreen()) return actions["next-dock"](el, e);
      ui.hbOpen = { [n]: true };
      location.hash = "#/habits";
    },
    "next-dock": (el, e) => {
      if (e) e.preventDefault();
      const n = +el.dataset.n;
      haptic();
      if (["/habits", "/check-in"].includes(currentPath()) && hbSheetBuild) {
        ui.hbSheet = { n, stage: "pick" };
        paintHbSheet(true);
      } else {
        ui.openActAfter = n;
        location.hash = "#/habits";
      }
    },
    // On a phone, an act opens as a full-screen sheet.
    "hb-open": (el) => {
      ui.hbSheet = { n: +el.dataset.n, stage: "pick" };
      haptic();
      paintHbSheet(true);
    },
    "hb-pick": (el) => {
      if (!ui.hbSheet) return;
      ui.hbSheet.stage = "how";
      ui.hbSheet.i = +el.dataset.i;
      haptic();
      paintHbSheet("fwd");
    },
    "hb-ask": (el) => {
      if (!ui.hbSheet) return;
      ui.askWho = el.dataset.who;
      ui.hbSheet.stage = "ask";
      haptic();
      paintHbSheet("fwd");
    },
    "hb-branch": (el) => {
      if (!ui.hbSheet) return;
      ui.hbSheet.branch = el.dataset.k;
      ui.hbSheet.stage = "pick";
      haptic();
      paintHbSheet(false);
    },
    "hb-sheet-back": () => {
      if (!ui.hbSheet) return;
      ui.hbSheet.stage = "pick";
      paintHbSheet("back");
    },
    // Your next best act: open it and bring it into view.
    "hb-go": (el) => {
      const d = app.querySelector('#hb-act-' + el.dataset.n + ' details');
      if (!d) return;
      hbCloseOthers(d);
      d.open = true;
      hbScroll(d);
    },
    "hb-party-off": () => {
      if (ui.hbWin) ui.hbWin.list = [];
      const p = app.querySelector(".hb3-party");
      if (p) p.remove();
    },
    "dismiss-celebrate": () => {
      ui.celebrate = null;
      render();
    },
    "edit-survey": () => {
      ui.editBase = JSON.parse(JSON.stringify(survey));
      ui.editing = true;
      ui.step = 0;
      ui.q = 0;
      if (location.hash === "#/" || location.hash === "") render();
      else location.hash = "#/";
      window.scrollTo(0, 0);
    },
    "clear-all": async () => {
      if (!confirm("Clear your survey answers and habits? This can't be undone.")) return;
      await clearSurvey();
      CATEGORIES.forEach((c) => lsRemove(KEY_HABITS + c));
      survey = normaliseSurvey(null);
      ui.step = 0;
      ui.q = 0;
      render();
    },
  };

  // A light tap of haptics (iPhone app) when you pick an answer or flip a switch.
  const HAPTIC_SEL = ".option-card, .q-chip, .day-btn, .chip, [role=radio], [role=checkbox], [role=switch], .pi-pick-btn, .sw-toggle, .step-btn";
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[data-link]");
    if (link) recordLinkClick(link);
    if (e.target.closest && e.target.closest(HAPTIC_SEL)) haptic();
    const el = e.target.closest("[data-action]");
    if (el && actions[el.dataset.action]) {
      actions[el.dataset.action](el, e);
      return;
    }
    // Clicking anywhere else closes an open airport picker.
    if (ui.airport && !e.target.closest(".picker")) {
      ui.airport = null;
      render();
    }
  });

  // While typing on a phone the keyboard is up: hide the tab bar so it
  // doesn't sit on top of the form.
  const isTypingField = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable ||
    (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|range|file|color|reset|image)$/i.test(el.type)));
  document.addEventListener("focusin", (e) => { if (isTypingField(e.target)) document.body.classList.add("typing"); });
  document.addEventListener("focusout", () => setTimeout(() => { if (!isTypingField(document.activeElement)) document.body.classList.remove("typing"); }, 80));
  if (window.visualViewport) {
    const kb = () => document.body.classList.toggle("kb-open", window.innerHeight - window.visualViewport.height > 150);
    window.visualViewport.addEventListener("resize", kb);
  }

  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches || !d.matches("details.hb-acc")) return;
    ui.hbOpen = ui.hbOpen || {};
    ui.hbOpen[d.dataset.n] = d.open;
    if (d.open) {
      d.classList.remove("hb-slide");
      void d.offsetWidth;
      d.classList.add("hb-slide");
      if (Date.now() - hbTapAt < 800) hbScroll(d);
    }
  }, true);
  // A tapped act grows into its quest card: bring its top into view.
  let hbTapAt = 0;
  // One act open at a time: tapping one closes the others.
  document.addEventListener("click", (e) => {
    const s = e.target.closest && e.target.closest("details.hb-acc > summary");
    if (!s) return;
    hbTapAt = Date.now();
    if (!s.parentElement.open) hbCloseOthers(s.parentElement);
  }, true);
  function hbCloseOthers(keep) {
    app.querySelectorAll("details.hb-acc[open]").forEach((o) => { if (o !== keep) o.open = false; });
  }
  function hbScroll(d) {
    requestAnimationFrame(() => {
      const r = d.getBoundingClientRect();
      const top = (document.querySelector(".topbar") || {}).offsetHeight || 0;
      if (r.top < top + 8 || r.top > innerHeight * 0.45) window.scrollTo({ top: Math.max(0, scrollY + r.top - top - 12), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (modalRoot.innerHTML) closeModal();
      else if (ui.airport) {
        ui.airport = null;
        render();
      } else {
        // Close an open act on My Habits, back to its tile.
        const open = [...app.querySelectorAll(".hb3 details.hb-acc[open]")];
        const mine = e.target.closest && e.target.closest("details.hb-acc[open]");
        const d = mine || open[open.length - 1];
        if (d && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
          d.open = false;
          const s = d.querySelector("summary");
          if (s) s.focus();
        }
      }
    }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".section-card")) {
      e.preventDefault();
      e.target.click();
    }
  });

  // Typing into a field updates the survey without re-rendering (which would
  // steal focus); fields whose value is shown elsewhere re-render on change.
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (PASSWORD_IDS.includes(t.id)) return updatePasswordMatch();
    if (t.id === "auth-username" || t.id === "choose-username") return checkUsername(t);
    if (t.id === "friend-email") return frSearchInput(t.value);
    if (t.id === "group-code") {
      const code = groupCodeFrom(t.value);
      if (code && t.value !== code) t.value = code;
      return;
    }
    if (t.id === "airport-search") {
      ui.airportQuery = t.value;
      const list = document.getElementById("airport-list");
      const f = survey.flights[ui.airport.index];
      if (list) list.innerHTML = airportOptions(f && f[ui.airport.field]);
      return;
    }
    if (t.id === "input-search") {
      ui.inputQuery = t.value;
      render();
      const box = document.getElementById("input-search");
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      return;
    }
    if (t.dataset.inputKey || t.dataset.inputSrc) {
      const key = t.dataset.inputKey || t.dataset.inputSrc;
      const row = t.closest(".inp-row");
      const dirty = [...row.querySelectorAll("[data-was]")].some((x) => x.value.trim() !== x.dataset.was);
      row.classList.toggle("dirty", dirty);
      row.querySelector('[data-action="save-input"][data-key="' + key + '"]').disabled = !dirty;
      return;
    }
    if (t.dataset.extra != null && t.tagName === "INPUT") {
      const i = Number(t.dataset.extra);
      const b = survey.banking || {};
      survey.banking = { ...b, extra: (b.extra || []).map((x, k) => (k === i ? { ...x, amount: Math.max(0, Number(t.value) || 0) } : x)) };
      surveyChanged();
      return;
    }
    if (t.dataset.field && t.tagName === "INPUT") {
      let v = Number(t.value);
      if (t.dataset.field === "energy.household") v = Math.max(1, v);
      setPath(survey, t.dataset.field, v);
      surveyChanged();
    }
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.field) {
      if (t.tagName === "SELECT") {
        setPath(survey, t.dataset.field, t.value);
        surveyChanged();
        // Keep the Account page's answer in step with the survey's.
        if (t.dataset.field === "about.role" && currentUser && sb) {
          sb.from("profiles").update({ role: t.value || null }).eq("id", currentUser.id).then(() => {}, () => {});
          if (ui.aboutYou) ui.aboutYou = { ...ui.aboutYou, role: t.value };
        }
      }
      if (t.dataset.rerender) render();
      // Picking a bank or pension provider moves on, like a tapped answer.
      if (t.dataset.field === "banking.bank" || t.dataset.field === "banking.pensionProvider") {
        if (!t.dataset.rerender) render();
        autoAdvance();
      }
    } else if (t.dataset.extra != null && t.tagName === "SELECT") {
      const i = Number(t.dataset.extra);
      const b = survey.banking || {};
      survey.banking = { ...b, extra: (b.extra || []).map((x, k) => (k === i ? { ...x, [t.dataset.extraField]: t.value } : x)) };
      surveyChanged();
      render();
    } else if (t.dataset.flight) {
      const i = Number(t.dataset.flight);
      const value = t.type === "checkbox" ? t.checked : t.value;
      survey.flights = survey.flights.map((f, idx) => (idx === i ? { ...f, [t.dataset.flightField]: value } : f));
      surveyChanged();
      render();
    } else if (t.dataset.car) {
      const i = Number(t.dataset.car);
      const f = t.dataset.key;
      const value = f === "share" ? Math.max(1, Math.round(Number(t.value) || 1)) : Math.max(0, Number(t.value) || 0);
      survey.cars = survey.cars.map((c, idx) => (idx === i ? { ...c, [f]: value } : c));
      surveyChanged();
      render();
    } else if (t.dataset.travel) {
      const key = t.dataset.travel === "extra" ? "extraTravel" : "longTrips";
      const i = Number(t.dataset.index);
      const f = t.dataset.key;
      const value = t.type === "checkbox" ? t.checked : f === "km" ? Math.max(0, Number(t.value) || 0) : t.value;
      survey[key] = survey[key].map((x, idx) => {
        if (idx !== i) return x;
        const next = { ...x, [f]: value };
        // Two known places fill in the distance; it can still be overtyped.
        if ((f === "from" || f === "to") && key === "longTrips") {
          const km = landKm(next.from, next.to);
          if (km) next.km = km;
        }
        return next;
      });
      surveyChanged();
      render();
    } else if (t.dataset.goal) {
      updateGoal(t.dataset.goal, { deadline: t.value });
      render();
    }
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.id === "friend-form") {
      e.preventDefault();
      addFriend(document.getElementById("friend-email").value);
      return;
    }
    if (e.target.id === "group-create-form") {
      e.preventDefault();
      const name = document.getElementById("group-name").value;
      await groupAction(async () => {
        const r = await sb.rpc("create_group", { p_name: name });
        if (!r.error && r.data && r.data[0]) ui.groupSel = r.data[0].id;
        return r;
      }, (r) => "Group created. Share the code " + ((r && r.data && r.data[0] && r.data[0].code) || "") + " to invite people.");
      return;
    }
    if (e.target.id === "group-join-form") {
      e.preventDefault();
      const typed = document.getElementById("group-code").value;
      const code = groupCodeFrom(typed) || typed.trim().toUpperCase();
      await groupAction(async () => {
        const r = await sb.rpc("join_group", { p_code: code });
        if (!r.error && r.data) ui.groupSel = r.data;
        return r;
      }, "You've joined the group.");
      if (friends.groupOk && location.hash.includes("join=")) {
        history.replaceState(null, "", "#/friends");
        render();
      }
      return;
    }
    if (e.target.id === "mp-send-form") {
      e.preventDefault();
      // Read everything before the form is redrawn.
      const message = document.getElementById("ls-message").value;
      const name = document.getElementById("ls-name").value.trim();
      const address = document.getElementById("ls-address").value.trim();
      Object.assign(ui, { mpDraft: message, lsName: name, lsAddress: address });
      ui.letterState = { sending: true };
      render();
      const out = await sendLetter({ kind: "mp", postcode: ui.mpPostcode, name, address, message });
      ui.letterState = out.error ? { error: out.error } : { mpSentTo: out.to };
      if (!out.error) ui.flash = "Sent to " + out.to + ". You'll get a copy, and their reply comes straight to you.";
      if (!out.error && ui.actsInfo) ui.actsInfo = { ...ui.actsInfo, verified: { ...(ui.actsInfo.verified || {}), mobilise: new Date().toISOString() } };
      render();
      return;
    }
    if (/^mot-form-\d+$/.test(e.target.id)) {
      e.preventDefault();
      const i = Number(e.target.dataset.carIndex);
      const reg = document.getElementById("mot-reg-" + i).value.trim();
      ui.mot = { ...(ui.mot || {}), [i]: { reg, busy: true } };
      render();
      let out = {};
      try {
        const { data } = await sb.auth.getSession();
        const token = data && data.session && data.session.access_token;
        const res = await fetch(SUPABASE_URL + "/functions/v1/mot-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + (token || SUPABASE_ANON_KEY) },
          body: JSON.stringify({ reg }),
        });
        out = await res.json().catch(() => ({}));
      } catch (err) {
        out = { error: "Couldn't look that up just now. Please try again, or enter the miles yourself." };
      }
      if (out.ok && out.milesPerYear) {
        const fuel = motFuel(out.fuelType || "");
        survey.cars = survey.cars.map((c, k) => (k === i ? { ...c, miles: out.milesPerYear, ...(fuel ? { fuel } : {}) } : c));
        surveyChanged();
        ui.mot[i] = { reg, ok: true, msg: [out.make, out.model].filter(Boolean).join(" ") + ": about " + kgFmt(out.milesPerYear) + " miles a year from its MOTs. We've put that in." };
      } else ui.mot[i] = { reg, msg: out.ok ? "Its MOT records don't have enough readings to work out a yearly figure yet." : out.error || "Couldn't look that up." };
      return render();
    }
    if (e.target.id === "pc-form") {
      e.preventDefault();
      const from = document.getElementById("pc-from").value.trim();
      const to = document.getElementById("pc-to").value.trim();
      ui.pcFind = { open: true, from, to };
      if (!from || !to) {
        ui.pcFind.msg = "Add both: where you start and where you work.";
        return render();
      }
      ui.pcFind.busy = true;
      render();
      try {
        const out = await findCommuteKm(from, to);
        if (out.error) ui.pcFind = { open: true, from, to, msg: out.error };
        else {
          survey.commute = { ...survey.commute, distance: out.km };
          surveyChanged();
          ui.pcFind = { open: true, from, to, ok: true, msg: "About " + out.km + " km each way. We've put that in above." };
        }
      } catch (err) {
        ui.pcFind = { open: true, from, to, msg: "Couldn't look that up just now. Check your connection, or enter a rough distance above." };
      }
      return render();
    }
    if (e.target.id === "energy-send-form") {
      e.preventDefault();
      const to = document.getElementById("es-to").value.trim();
      const name = document.getElementById("es-name").value.trim();
      let message = document.getElementById("es-message").value;
      // Sign it with the name in the box (it may have been changed).
      const old = (ui.esName || ui.userName || "").trim();
      if (name && old && old !== name && message.trimEnd().endsWith("\n" + old)) message = message.trimEnd().slice(0, -old.length) + name;
      else if (name && /Thanks,\s*$/.test(message)) message = message.trimEnd() + "\n" + name;
      Object.assign(ui, { esTo: to, esName: name, esDraft: message });
      ui.letterState = { sending: true };
      render();
      const out = await sendLetter({ kind: "energy", to, name, message });
      ui.letterState = out.error ? { error: out.error } : { energySentTo: to };
      if (!out.error) actions["energy-asked"]();
      render();
      return;
    }
    if (e.target.id === "claim-form") {
      e.preventDefault();
      const code = document.getElementById("claim-code").value.trim().toUpperCase();
      if (!code) return;
      if (ui.actsInfo && code === ui.actsInfo.code) {
        ui.claimMsg = { ok: false, text: "That's your own code. Share it with friends instead." };
      } else {
        const { data, error } = await sb.rpc("claim_referral", { p_code: code });
        ui.claimMsg = error ? { ok: false, text: "Couldn't use that code. Please try again." }
          : data ? { ok: true, text: "Done. You're counted towards your friend's Act 7 once you've finished your survey." }
          : { ok: false, text: "That code didn't work. Check it, or you may already be counted for someone." };
      }
      render();
      return;
    }
    if (e.target.id === "mp-form") {
      e.preventDefault();
      ui.mpPostcode = document.getElementById("mp-postcode").value.trim();
      if (ui.mpPostcode.length >= 5) findMp(ui.mpPostcode);
      return;
    }
    if (e.target.id === "verify-mp-form") {
      e.preventDefault();
      const code = document.getElementById("verify-mp-code").value.trim();
      if (!code) return;
      const { data, error } = await sb.rpc("verify_mp_letter", { p_code: code });
      ui.verifyMsg = error ? { ok: false, text: /reference/i.test(error.message || "") ? "No account has that reference." : "Couldn't verify: " + (error.message || "try again") } : { ok: true, text: "Verified for " + data + "." };
      render();
      return;
    }
    if (e.target.id === "about-you-form") {
      e.preventDefault();
      const research = document.getElementById("about-research").checked;
      const patch = { research_opt_in: research };
      if (research && !ui.aboutYou.research_opt_in) patch.research_opted_at = new Date().toISOString();
      const { error } = await sb.from("profiles").update(patch).eq("id", currentUser.id);
      ui.aboutMsg = error ? { ok: false, text: "Couldn't save. Please try again." } : { ok: true, text: "Saved." };
      if (!error) ui.aboutYou = { ...ui.aboutYou, research_opt_in: research };
      render();
      return;
    }
    if (e.target.id === "name-form") {
      e.preventDefault();
      const name = document.getElementById("display-name").value.trim().slice(0, 40);
      const { error } = await sb.from("profiles").upsert({ id: currentUser.id, display_name: name });
      friends.msg = error ? "Couldn't save your name." : "";
      friends.myName = error ? friends.myName : name;
      ui.userName = name || ui.userName;
      render();
      return;
    }
    if (e.target.id === "auth-form") {
      e.preventDefault();
      submitAuth();
    } else if (e.target.id === "username-form") {
      e.preventDefault();
      submitUsername();
    } else if (e.target.id === "reset-form") {
      e.preventDefault();
      submitReset();
    } else if (e.target.id === "recovery-form") {
      e.preventDefault();
      submitNewPassword();
    }
  });

  // Habits and streaks live in localStorage, so pick up changes made in
  // another tab when this one regains focus.
  window.addEventListener("focus", () => {
    const p = currentPath();
    if (p === "/habits" || p === "/check-in") render();
  });

  // Tapping a tab: remember it came from the tab bar (so the tab keeps its
  // place); tapping the tab you're on scrolls back to the top.
  const tabbarEl = document.getElementById("tabbar");
  if (tabbarEl) {
    tabbarEl.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-route]");
      if (!a) return;
      if (a.getAttribute("data-route") === currentPath()) {
        e.preventDefault();
        if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
        return;
      }
      navIntent = "tab";
    });
  }
  // My Habits on a phone: remember whether Done is folded open.
  document.addEventListener("toggle", (e) => {
    if (e.target.classList && e.target.classList.contains("hbf-done")) ui.hbDoneOpen = e.target.open;
  }, true);
  // Pop-up sheets on a phone: pull down to close.
  let sheetDrag = null;
  modalRoot.addEventListener("touchstart", (e) => {
    if (!onPhoneScreen() || e.touches.length !== 1) return;
    const sheet = e.target.closest(".sheet");
    const bd = e.target.closest(".modal-backdrop");
    if (!sheet || !bd || bd.scrollTop > 0) return;
    if (e.target.closest(".sheet-tabs, input, textarea, select, .chip-scroll, .pi-track, .sw-offers")) return;
    sheetDrag = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, t0: Date.now(), sheet, bd, dy: 0, on: false };
  }, { passive: true });
  modalRoot.addEventListener("touchmove", (e) => {
    const d = sheetDrag;
    if (!d) return;
    const dy = e.touches[0].clientY - d.y0, dx = e.touches[0].clientX - d.x0;
    if (!d.on) {
      if (Math.abs(dx) > Math.abs(dy) || dy < -4) { sheetDrag = null; return; }
      if (dy < 8) return;
      d.on = true;
      d.sheet.style.transition = "none";
      d.sheet.style.animation = "none";
    }
    d.dy = Math.max(0, dy - 8);
    d.sheet.style.transform = "translateY(" + d.dy + "px)";
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  const sheetRelease = () => {
    const d = sheetDrag;
    sheetDrag = null;
    if (!d || !d.on) return;
    const fast = d.dy / Math.max(1, Date.now() - d.t0) > 0.55;
    d.sheet.style.transition = "transform 0.3s cubic-bezier(0.2, 0.85, 0.25, 1)";
    if (d.dy > 110 || (fast && d.dy > 30)) {
      d.sheet.style.transform = "translateY(105vh)";
      d.bd.style.transition = "opacity 0.3s";
      d.bd.style.opacity = "0";
      haptic();
      setTimeout(closeModal, 260);
    } else d.sheet.style.transform = "";
  };
  modalRoot.addEventListener("touchend", sheetRelease);
  modalRoot.addEventListener("touchcancel", sheetRelease);
  // In the iPhone app (and from the home screen), swipe in from the left
  // edge to go back, like any iPhone app. Safari has its own swipe.
  const swipeBackOn = () => onPhoneScreen() && (isNativeApp() || window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches));
  let edge = null;
  document.addEventListener("touchstart", (e) => {
    if (!swipeBackOn() || e.touches.length !== 1 || modalRoot.innerHTML) return;
    const t = e.touches[0];
    const back = document.getElementById("nav-back");
    if (t.clientX > 22 || !back || back.hidden) return;
    edge = { x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, on: false };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!edge) return;
    const t = e.touches[0], dx = t.clientX - edge.x0, dy = t.clientY - edge.y0;
    if (!edge.on) {
      if (Math.abs(dy) > Math.abs(dx) || dx < 0) { edge = null; return; }
      if (dx < 10) return;
      edge.on = true;
      app.style.transition = "none";
    }
    edge.dx = Math.max(0, dx);
    app.style.transform = "translateX(" + edge.dx + "px)";
    app.style.opacity = String(Math.max(0.35, 1 - edge.dx / (innerWidth * 1.4)));
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  const edgeRelease = () => {
    const d = edge;
    edge = null;
    if (!d || !d.on) return;
    const fast = d.dx / Math.max(1, Date.now() - d.t0) > 0.5;
    app.style.transition = "transform 0.25s cubic-bezier(0.2, 0.85, 0.25, 1), opacity 0.25s";
    if (d.dx > innerWidth * 0.33 || (fast && d.dx > 40)) {
      app.style.transform = "translateX(" + innerWidth + "px)";
      app.style.opacity = "0";
      haptic();
      setTimeout(() => {
        app.style.transition = app.style.transform = app.style.opacity = "";
        const back = document.getElementById("nav-back");
        if (back && !back.hidden) actions["nav-back"](back);
      }, 200);
    } else {
      app.style.transform = "";
      app.style.opacity = "";
      setTimeout(() => { app.style.transition = ""; }, 260);
    }
  };
  document.addEventListener("touchend", edgeRelease);
  document.addEventListener("touchcancel", edgeRelease);

  window.addEventListener("hashchange", onRouteChange);
  lastRoute = currentPath();
  navTrail = [lastRoute];

  // Only a real change of width redraws Results: on an iPhone the page
  // "resizes" every time Safari's toolbar slides in or out while you scroll.
  let resizeTimer = null, lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      moveTabInk();
      if (Math.abs(window.innerWidth - lastWidth) < 2) return;
      lastWidth = window.innerWidth;
      if (currentPath() === "/results") render();
    }, 200);
  });

  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });

  // Open straight onto your page from what this phone already has (your
  // answers, your membership, your name); the network catches up and the
  // page quietly refreshes. No spinner when you open the app.
  function savedUser() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!/^sb-.+-auth-token$/.test(k)) continue;
        const v = JSON.parse(localStorage.getItem(k));
        const u = v && (v.user || (v.currentSession && v.currentSession.user));
        if (u && u.id) return u;
      }
    } catch (e) {}
    return null;
  }
  function paintFromPhone(user, fromEmail, fromCheckout) {
    if (!user || fromEmail || fromCheckout || ui.pendingVerify || ui.recovery) return false;
    const m = lsGet(KEY_MEMBER_CACHE, null), me = lsGet(KEY_ME_CACHE, null);
    if (!m || m.uid !== user.id || !lsGet(KEY_SURVEY, null)) return false;
    if (!currentUser) currentUser = user;
    authChecked = true;
    membership = { ...m, until: m.until ? new Date(m.until) : null };
    if (me && me.uid === user.id) {
      ui.userName = me.name;
      if (me.username) ui.username = me.username;
    }
    survey = localSurvey();
    ui.history = lsGet(KEY_HISTORY, []);
    const home = (location.pathname === "/" || /\/index\.html$/.test(location.pathname)) && /^#?$/.test(location.hash);
    if (home && survey.completedAt) history.replaceState(null, "", location.pathname + "#/habits");
    render();
    return true;
  }

  async function start() {
    // Links from sign-up confirmation and password-reset emails land with
    // Supabase's tokens in the hash; supabase-js consumes them on startup.
    const linkParams = new URLSearchParams((location.hash.replace(/^#/, "") + "&" + location.search.replace(/^\?/, "")));
    const fromEmail = linkParams.has("access_token") || linkParams.has("error_description") || linkParams.has("token_hash");
    const linkType = linkParams.get("type");
    if (linkParams.get("token_hash")) ui.pendingVerify = { tokenHash: linkParams.get("token_hash"), type: linkType === "recovery" ? "recovery" : linkType || "signup" };
    if (linkType === "recovery" || ssGet(KEY_RECOVERY)) ui.recovery = true;
    if (linkType === "recovery") ssSet(KEY_RECOVERY, true);
    if (linkType === "signup" && linkParams.has("access_token")) ui.flash = "Your email is confirmed and you're signed in.";
    if (linkType === "email_change" && linkParams.has("access_token")) ui.flash = "Your email address has been updated.";
    if (linkParams.has("error_description")) {
      ui.authErr = /expired|invalid/i.test(linkParams.get("error_description"))
        ? "That link has expired or has already been used. Some email providers, like Outlook, open links to check them, which can use them up. If you were creating an account it's probably confirmed already, so try signing in. If it isn't, we'll send you a fresh link."
        : linkParams.get("error_description");
    }
    // Stripe sends people back to ?checkout=success after paying.
    const fromCheckout = /checkout=success/.test(location.search);
    // Signed in on this phone before? Draw your page in the very first frame.
    let painted = paintFromPhone(savedUser(), fromEmail, fromCheckout);
    if (!painted) render();
    await refreshUser();
    if (fromEmail || fromCheckout) {
      const to = fromCheckout ? "#/results" : linkParams.has("error_description") && !currentUser ? "#/account" : "#/";
      history.replaceState(null, "", location.pathname + to);
    }
    // A recovery flag left over from a link that didn't sign anyone in.
    if (ui.recovery && !currentUser) {
      ui.recovery = false;
      ssSet(KEY_RECOVERY, false);
    }
    if (!painted) painted = paintFromPhone(currentUser, fromEmail, fromCheckout);
    if (currentUser) {
      await ensureUsername();
      ui.userName = await displayName(currentUser);
      lsSet(KEY_ME_CACHE, { uid: currentUser.id, name: ui.userName, username: ui.username || "" });
      await checkMembership();
      checkAdmin().then(() => ui.isAdmin && render());
      claimReferral();
    }
    // The latest figures from the Inputs page (the cached ones are already in use).
    loadInputs().then((changed) => changed && render());
    // Members get their saved answers; everyone else uses this device's.
    survey = await loadSurvey();
    await loadHistory();
    notifStart();
    // Coming back with a finished survey: start on your plan (or your results
    // when signed out), not on the survey you've already done.
    const bareHome = (location.pathname === "/" || /\/index\.html$/.test(location.pathname)) && /^#?$/.test(location.hash);
    if (bareHome && !fromEmail && !fromCheckout && survey && survey.completedAt) history.replaceState(null, "", location.pathname + (currentUser ? "#/habits" : "#/results"));
    render();
    // Friends is ready before you tap it.
    if (currentUser && canSync() && !friends.loaded) loadFriends();
    if (fromCheckout && FREE_MODE) {
      ui.flash = "Thank you for supporting CO2 Counter! It really helps keep it running.";
      render();
      // The webhook can land a moment after the redirect.
      for (let i = 0; i < 8 && currentUser && !isSupporter(); i++) {
        await new Promise((res) => setTimeout(res, 2000));
        await checkMembership();
      }
      render();
    } else if (currentUser && !membership.access && fromCheckout) waitForPayment();
    if (sb) {
      sb.auth.onAuthStateChange((event) => {
        if (event === "PASSWORD_RECOVERY") {
          ui.recovery = true;
          ssSet(KEY_RECOVERY, true);
          render();
        }
      });
    }
  }

  start();
})();
