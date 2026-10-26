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
  const LEGAL_UPDATED = "26 October 2026";

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
    pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
    link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
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
    return result;
  }

  const isSupporter = () => !!(membership && ["active", "trialing", "past_due"].includes(membership.status));
  // Full results and guides: any signed-in user in free mode (free, but an
  // account lets us see who uses the app), otherwise members.
  const hasFullAccess = () => (FREE_MODE ? !!currentUser : !!(currentUser && membership && membership.access));
  // Answers saved to the account (and Friends): any signed-in user in free
  // mode, otherwise members.
  const canSync = () => !!currentUser && (FREE_MODE || !!(membership && membership.access));

  const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

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
      } catch (e) {}
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
      waste && waste.key !== "low" ? waste.label.split(" ")[0].toLowerCase() + " waste" : null,
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
      yearly: ((pets.dogs || 0) * D.DOG_YEARLY + (pets.cats || 0) * D.CAT_YEARLY) / household,
      detail: (pets.dogs || 0) + (pets.cats || 0) + " pet(s)",
    });

    const banking = s.banking || {};
    const bank = byKey(D.BANKS, banking.bank);
    const pension = pensionProvider(banking);
    const pot = banking.pensionPot || 0;
    items.push({
      key: "banking",
      label: "Banking & Pension",
      icon: "🏦",
      yearly: (banking.amount || 0) * factorOf(D.BANKS, banking.bank) + pensionKg(pot, pension.tPerMillion),
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
        const pensionSaving = Math.max(0, pensionKg(b.pensionPot, pension.tPerMillion - D.GREEN_PENSION_T_PER_MILLION));
        // Already with a very good bank: say so, and how much further the greenest goes.
        const greenestBank = D.BANKS.slice().sort((x, y) => x.factor - y.factor)[0];
        const bankDone = bank && bankRating(bank).key === "vgood";
        const bankBody = bankDone
          ? "You're already with " + bank.label.replace(/^The /, "") + ", one of the greenest banks." +
            (bankSaving > 0.5 ? " You could go a bit further: moving to " + greenestBank.label.replace(/^The /, "") + " would cut about " + kgFmt(bankSaving) + " kg a year more." : " There's no greener bank on our list.")
          : "Traditional banks finance fossil fuel projects with your deposits. Moving your savings to a bank that doesn't fund fossil fuels (e.g. Triodos, Co-op) can reduce your financed emissions by up to {{bank_cut}}.";
        if (pensionSaving > bankSaving) {
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
            saving: bankSaving + pensionSaving,
            realisticLabel: "a greener bank and a climate-focused pension fund",
          };
        }
        return {
          realisticLabel: "a greener bank and a climate-focused pension fund",
          title: bankDone ? (bankSaving > 0.5 ? "You've switched bank. Go a bit further?" : "You're with the greenest bank") : "Move your money to a greener bank",
          body: bankBody + (pensionSaving > 0 ? " Switching your pension to a climate-focused fund helps too." : ""),
          saving: bankSaving + pensionSaving,
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

  const spinner = '<div class="center-pad"><div class="spinner"></div></div>';

  function setNav(path) {
    document.querySelectorAll("#nav a, #nav-avatar").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("data-route") === path);
    });
    const av = document.getElementById("nav-avatar");
    if (av) {
      const name = ui.userName && ui.userName !== "App user" ? ui.userName : ui.username || currentUser?.email || "";
      const label = currentUser ? initials(name) : "";
      av.innerHTML = label ? label : icon("user");
      av.setAttribute("aria-label", currentUser ? "Account" : "Sign in");
    }
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
  function renderSurveyDone() {
    const when = Date.parse(survey.completedAt);
    const longDate = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    const now = footprint(survey).totalYearly;
    const hist = historyByDay();
    const latest = hist[0];
    const first = hist[hist.length - 1];
    const change = hist.length > 1 ? latest.totalYearly - first.totalYearly : 0;
    const choice = (cls, badge, ic, title, body, btn) =>
      '<div class="choice ' + cls + ' rise">' + (badge ? '<span class="choice-badge">' + badge + "</span>" : "") + '<span class="choice-icon">' + icon(ic) + "</span>" +
      '<h2 class="display">' + title + "</h2><p>" + body + "</p>" + btn + "</div>";
    const historyHtml = hist.length
      ? '<ol class="timeline-v2">' +
        [latest].concat(hist.length > 1 ? [first] : [])
          .map(
            (h, i) =>
              '<li class="' + (i === 0 ? "now" : "") + '"><span class="tl-dot"></span><div><p class="xs muted">' + esc(longDate(Date.parse(h.completedAt))) +
              (i === 0 ? " · latest" : " · first survey") + '</p><p class="display tnum tl-kg">' + kgFmt(h.totalYearly) + " kg</p>" +
              (i === 0 && hist.length > 1 && Math.abs(change) >= 1
                ? '<p class="sm fw-700 ' + (change < 0 ? "green" : "clay") + '">' + (change < 0 ? "▼ " : "▲ ") + kgFmt(Math.abs(change)) + " kg (" +
                  Math.round((Math.abs(change) / first.totalYearly) * 100) + "%) since your first</p>"
                : "") + "</div></li>"
          )
          .join("") +
        "</ol>" + (hist.length > 2 ? '<p class="xs muted mt-2">' + hist.length + " surveys in total.</p>" : "")
      : '<p class="sm muted mt-3">Your surveys will show here, so you can see how far you\'ve come.</p>';
    return (
      '<div class="container done-v2">' +
      '<header class="glass cat-hero rise"><span class="cat-watermark" aria-hidden="true">' + icon("clipboard") + "</span>" +
      '<div class="cat-hero-main done-head"><span class="done-tick">' + icon("check") + "</span><div>" +
      '<h1 class="cat-title display">You\'ve completed your survey</h1><p class="cat-why">' +
      (isNaN(when) ? "" : "You finished it on <strong>" + esc(longDate(when)) + "</strong>. ") +
      "Has anything changed since? A quick update starts from your last answers, so you only change what's different.</p></div></div>" +
      '<div class="cat-figs"><div class="muted">Your last result</div><div class="cat-kg display tnum" data-countup="' + Math.round(now) + '">0</div><div class="muted">kg CO₂e a year</div></div></header>' +
      '<section class="choices">' +
      choice("lead", "Recommended", "pencil", "Quick update", "Start from your last answers and change only what's different. Takes a couple of minutes.",
        '<button type="button" class="btn btn-honey btn-block" data-action="whats-changed">Anything changed?</button>') +
      choice("glass", "", "refresh", "Start from scratch", "A fresh survey with blank answers, if a lot has changed.",
        '<button type="button" class="btn btn-outline btn-block" data-action="new-survey">Start a new survey</button>') +
      choice("glass", "", "chart", "View my results", "Nothing's changed? Jump back to your breakdown and next steps.",
        '<a class="btn btn-outline btn-block" href="#/results">See results ' + icon("arrowRight") + "</a>") +
      "</section>" +
      '<p class="sm muted done-note">Either way, your current results stay in your history, and you can cancel before you finish.</p>' +
      '<div class="cat-grid"><section class="glass guide-card cat-col"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline">' +
      '<h2 class="display">Your last answers</h2><span class="muted">Change just one step</span></div><div class="answer-tiles">' +
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
      "</div></section>" +
      '<aside class="cat-aside"><section class="glass cat-drop"><h2 class="display">Your history</h2>' + historyHtml +
      '<p class="xs muted mt-3">Updating every few months shows how far you\'ve come, and counts towards Most improved on the Friends page.</p></section></aside></div></div>'
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

  function renderIntro() {
    const cta = (label) => '<button type="button" class="btn btn-green intro-cta" data-action="start-survey">' + label + " " + icon("arrowRight") + "</button>";
    const faq = [
      ["Do I need an account?", "You can take the whole survey as a guest. To see your full results, create a free account: it also keeps your answers safe across your devices."],
      ["How accurate is it?", "It's an estimate using typical lifecycle emission factors. It's built to show your biggest levers clearly, not to be a precise audit."],
      ["How is it free?", 'Supporters chip in £2 a year, and some partner links (marked "Affiliate") may earn us a small commission at no cost to you. Partners never change your figures. <a href="/about/">About us</a> · <a href="/greener-switches/">Greener switches</a>'],
      ["What do I need to have to hand?", "Nothing essential. An energy bill helps with the home step, and a rough idea of your savings and pension helps with money, but ballpark answers are fine."],
    ];
    return (
      '<div class="container intro-v2">' +
      '<header class="intro-hero"><div class="intro-hero-main">' +
      '<span class="eyebrow rise">Free for everyone · no ads</span>' +
      '<h1 class="display intro-title rise" style="animation-delay:.08s">Know your footprint.<br><span>Shrink it,</span> one habit at a time.</h1>' +
      '<p class="intro-lead rise" style="animation-delay:.16s">Answer six short steps about your week. We estimate your yearly carbon footprint, show where it really comes from, and point you to the changes that make the biggest difference for you.</p>' +
      '<div class="chip-row rise" style="animation-delay:.24s">' + cta(survey.completedAt ? "Update my survey" : "Start the survey") +
      '<a class="btn btn-outline" href="/example/">See an example result</a></div>' +
      '<div class="intro-trust">' + ["No account needed to start", "Answers save as you go", "We never sell your data"].map((t) => "<span>" + icon("check") + t + "</span>").join("") + "</div></div>" +
      '<div class="intro-floaty" aria-hidden="true"><svg viewBox="0 0 100 100"><rect width="100" height="100" rx="26" fill="#3F5B3A"/><path d="M22 80C22 44 46 20 82 18c0 38-24 62-60 62Z" fill="#EFE9DC"/><rect class="ib1" x="36" y="40" width="7" height="22" rx="3.5" fill="#3F5B3A"/><rect class="ib2" x="46" y="47" width="7" height="15" rx="3.5" fill="#3F5B3A"/><rect class="ib3" x="56" y="54" width="7" height="8" rx="3.5" fill="#D9A441"/></svg>' +
      '<div class="glass intro-budget"><span class="xs muted">1.5°C budget</span><span class="display">{{budget_t}} t <small>a person, a year</small></span></div></div></header>' +
      '<section class="intro-mission"><div class="intro-sec-head"><div><span class="eyebrow">Our mission</span><h2 class="display">From "what\'s my footprint?" to habits that stick</h2></div>' +
      "<p>Most people don't know where their emissions really come from. We make it clear, then make it doable.</p></div>" +
      '<ol class="mission">' +
      INTRO_STEPS.map(
        ([ic, t, b, soon], i) =>
          '<li class="glass mission-step" style="--i:' + i + '"><span class="mission-dot display">' + (i + 1) + '</span><span class="mission-icon">' + icon(ic) + "</span>" +
          '<h3 class="display">' + t + "</h3><p>" + b + "</p>" + (soon ? '<span class="nav-soon">Coming soon</span>' : "") + "</li>"
      ).join("") +
      "</ol></section>" +
      '<section class="intro-split"><div><h2 class="display">What we look at</h2><p>Six parts of everyday life, including one most calculators miss: where your money sits.</p><ul class="intro-chips">' +
      STEPS.map((st) => "<li>" + st.icon + esc(st.title) + "</li>").join("") +
      '</ul></div><div class="intro-why"><span class="eyebrow">Why it matters</span><span class="display intro-why-num">{{budget_t}} t</span>' +
      "<p>is roughly each person's yearly share of CO₂e if we're to keep warming to 1.5°C. Most of us in the UK are well above it, and small, repeated changes are how we close the gap.</p></div></section>" +
      '<section class="intro-cards">' +
      [
        ["chart", "Built on official figures", 'We use UK government emission factors and published data from sources like DESNZ, Defra, Ofgem and the ONS. <a href="/how-we-calculate/">How we calculate</a>'],
        ["shield", "Your data stays yours", "No ads, and we never sell your data. Answers stay on your device until you choose to create an account."],
        ["heart", "Free, kept going by supporters", "Everything is free. If it helps you, you can chip in £2 a year to cover running costs."],
      ].map(([ic, t, b]) => '<div class="glass intro-card"><span class="cat-badge">' + icon(ic) + '</span><h3 class="display">' + t + "</h3><p>" + b + "</p></div>").join("") +
      "</section>" +
      '<section class="intro-faq"><h2 class="display">Questions people ask</h2>' +
      faq.map(([q, a]) => '<details class="glass faq"><summary><span>' + q + "</span>" + icon("chevronDown") + "</summary><p>" + a + "</p></details>").join("") +
      "</section>" +
      '<section class="intro-final"><div><h2 class="display">Ready? Six short steps.</h2><p>Meals, commute, flights, home, pets and money.</p></div>' + cta("Start the survey") + "</section></div>"
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
        "Eat out " + (m.eatOut || 0) + "× a week · " + (waste ? waste.label.split(" ")[0] : "Low") + " food waste",
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
        Math.round(e.electricityKwh || 0).toLocaleString() + " kWh electricity, " + Math.round(e.gasKwh || 0).toLocaleString() + " kWh gas a month" + (e.greenTariff ? " · green tariff" : ""),
        ((e.household || 1) === 1 ? "1 person" : (e.household || 1) + " people") + " at home · " + Math.round((s.water && s.water.liters) || 0).toLocaleString() + " L water a month",
      ];
    }
    if (key === "pets") {
      const p = s.pets || {};
      return [(p.dogs || 0) + (p.cats || 0) ? [p.dogs ? plural(p.dogs, "dog") : "", p.cats ? plural(p.cats, "cat") : ""].filter(Boolean).join(", ") : "No pets"];
    }
    if (key === "banking") {
      const b = s.banking || {};
      const bank = byKey(D.BANKS, b.bank);
      const pension = byKey(D.PENSION_PROVIDERS, b.pensionProvider);
      return [
        (bank ? bank.label : "Bank not chosen") + " · £" + (b.amount || 0).toLocaleString(),
        pension && pension.unfunded ? "Pension: " + pension.label : b.pensionPot ? "Pension: " + (pension ? pension.label : "provider not chosen") + " · £" + b.pensionPot.toLocaleString() : "No pension added",
      ];
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
    const pct = Math.round(((ui.step + 1) / n) * 100);
    qAnimate = ui.shownStep !== ui.step;
    ui.shownStep = ui.step;
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
      '<div class="container survey-v2">' + newBanner +
      '<nav class="section-tabs" aria-label="Survey steps">' + tabs + "</nav>" +
      '<header class="glass step-hero' + (qAnimate ? " rise" : "") + '"><span class="cat-watermark" aria-hidden="true">' + step.icon + "</span>" +
      '<div class="step-hero-main"><span class="eyebrow">Step ' + (ui.step + 1) + " of " + n + "</span>" +
      '<h1 class="cat-title display">' + esc(step.title) + '</h1><p class="cat-why">' + esc(STEP_INTRO[step.key] || step.subtitle) + "</p></div>" +
      '<div class="cat-hero-side"><div class="cat-figs"><div class="step-kg display tnum">' + kgFmt(kg) + '</div><div class="muted">kg CO₂e a year so far</div></div>' +
      '<figure class="cat-share"><svg viewBox="0 0 42 42" role="img" aria-label="Step ' + (ui.step + 1) + " of " + n + '"><circle cx="21" cy="21" r="20" fill="rgba(63,91,58,.12)"></circle>' +
      '<circle cx="21" cy="21" r="10" fill="none" stroke="#3F5B3A" stroke-width="20" pathLength="100" stroke-dasharray="' + pct + ' 100" transform="rotate(-90 21 21)"></circle></svg>' +
      "<figcaption><span>" + (ui.step + 1) + " of " + n + " steps</span></figcaption></figure></div></header>" +
      '<div class="step-body">' + step.render() + "</div>" +
      '<div class="step-nav-v2">' +
      (prev
        ? '<button type="button" class="btn btn-outline" data-action="prev-step">' + icon("chevronLeft") + " Back: " + esc(STEP_TAB[prev.key]) + "</button>"
        : ui.newSurvey || ui.editing ? '<a class="btn btn-outline" href="#/results">Back to results</a>' : "<span></span>") +
      '<button type="button" class="btn btn-green" data-action="next-step">' +
      (last ? (ui.editing ? "Save and see results" : "See my results") : "Next: " + esc(STEP_TAB[next.key])) + " " + icon("chevronRight") + "</button>" +
      "</div></div>"
    );
  }

  const STEP_TAB = { meals: "Meals", commute: "Commute", flights: "Flights", energy: "Home & water", pets: "Pets", banking: "Money" };
  const STEP_INTRO = {
    meals: "A few quick questions about what you eat. Food is often the biggest part of a footprint.",
    commute: "How you get around day to day. It repeats over 200 times a year, so it adds up.",
    flights: "Flights are rare but large. Add the trips you took in the last 12 months.",
    energy: "Your energy and water use. Have a recent bill handy if you can.",
    pets: "Just two quick counts.",
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
      '<li class="q' + (qAnimate ? " rise" : "") + (o.note ? " q-note" : "") + '" style="animation-delay:' + (0.06 * n).toFixed(2) + 's">' +
      '<span class="qn' + (n === 1 && !o.note ? " lead" : "") + '">' + (o.note ? icon("info") : n) + "</span>" +
      '<div class="min0"><h2 class="qt">' + title + (o.optional ? ' <span class="q-opt">Optional</span>' : "") + "</h2>" +
      (hint ? '<p class="qh">' + hint + "</p>" : "") + (body ? '<div class="q-body">' + body + "</div>" : "") + "</div></li>"
    );
  }
  const qList = (cards) => '<ol class="q-list">' + cards.join("") + "</ol>";
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
        "If you mix it up, choose <strong>Meat eater</strong> and pick day by day.",
        '<div class="q-grid">' +
          D.DIETS.map((d) =>
            optionCard(diet === d.key, 'data-action="set-diet" data-key="' + d.key + '"', '<span class="opt-title display">' + esc(d.label) + '</span><span class="opt-sub">' + esc(d.desc) + "</span>", "q-opt-card")
          ).join("") +
          "</div>"
      )
    );
    let n = 2;
    if (diet === "meat_eater") {
      const day = DAYS.includes(ui.mealDay) ? ui.mealDay : DAYS.find((d) => !m[d]) || "Mon";
      const cur = m[day];
      const days =
        '<div class="day-pick">' +
        DAYS.map((d) => {
          const o = byKey(D.MEAL_OPTIONS, m[d]);
          return (
            '<button type="button" class="day-btn' + (d === day ? " on" : "") + '" data-action="pick-meal-day" data-day="' + d + '" aria-pressed="' + (d === day) +
            '" aria-label="' + DAY_NAMES[d] + ": " + (o ? esc(o.label) : "not chosen") + '"><span class="display">' + d + "</span>" +
            '<i style="background:' + (o ? dayDot(o.factor, 8, 3, 2) : "transparent") + '"' + (o ? "" : ' class="empty"') + "></i>" +
            '<span class="day-val">' + (o ? esc(o.key === "veggie" ? "Veggie" : o.label) : "Choose") + '</span><span class="day-kg tnum">' + (o ? o.factor.toFixed(2) + " kg" : "") + "</span></button>"
          );
        }).join("") +
        "</div>";
      const chosen = byKey(D.MEAL_OPTIONS, cur);
      const veg = byKey(D.MEAL_OPTIONS, "veggie");
      const tip =
        chosen && veg && chosen.factor > veg.factor * 2
          ? '<p class="q-tip">Swapping ' + DAY_NAMES[day] + "'s " + esc(chosen.label.toLowerCase()) + " for a vegetarian meal would save about " +
            kgFmt((chosen.factor - veg.factor) * D.WEEKS_PER_YEAR) + " kg a year.</p>"
          : "";
      cards.push(
        qCard(
          n++,
          "What was each day's main meal?",
          "Pick a day, then choose what you ate.",
          days +
            '<div class="q-sub"><p class="q-sub-title display">' + DAY_NAMES[day] + '</p><div class="chip-wrap">' +
            D.MEAL_OPTIONS.map((o) => chip(cur === o.key, 'data-action="set-meal" data-day="' + day + '" data-key="' + o.key + '"', esc(o.label), o.factor.toFixed(2) + " kg")).join("") +
            "</div>" + tip + "</div>"
        )
      );
    } else if (diet) {
      const d = byKey(D.DIETS, diet);
      cards.push(qCard(n++, "Your week", "We'll estimate your week from a " + esc(d.label.toLowerCase()) + " diet. Choose <strong>Meat eater</strong> above to pick day by day.", ""));
    }
    if (diet) {
      cards.push(
        qCard(
          n++,
          "How often do you eat out or get a takeaway?",
          "Each one counts as " + D.EAT_OUT_MULTIPLIER + "× a meal at home: bigger portions and more waste.",
          '<div class="chip-wrap">' + D.EAT_OUT_OPTIONS.map((o) => chip((m.eatOut || 0) === o.value, 'data-action="set-eatout" data-value="' + o.value + '"', esc(o.label))).join("") + "</div>"
        )
      );
      cards.push(
        qCard(
          n++,
          "How much food do you throw away?",
          "Wasted food means wasted emissions.",
          '<div class="q-grid">' +
            D.FOOD_WASTE.map((o) =>
              optionCard((m.foodWaste || "low") === o.key, 'data-action="set-waste" data-key="' + o.key + '"', '<span class="opt-title display">' + esc(o.label.split(" ")[0]) + '</span><span class="opt-sub tnum">' + esc((o.label.match(/\((.*)\)/) || [])[1] || "") + "</span>", "q-opt-card")
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
      qCard(2, "How far is your commute, one way?", "A rough figure is fine. We count there and back.", stepper("commute.distance", distance, 1, 0, "km", "One-way distance in km")),
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
        '<div class="chip-wrap">' + chip(!!e.greenTariff, 'data-action="set-green" data-value="1"', "Yes") + chip(!e.greenTariff, 'data-action="set-green" data-value="0"', "No") + "</div>"
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
      goodToKnow("A medium dog's food can emit as much as a small car over a year. You don't need to change your pet, just what goes in the bowl."),
    ]);
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
  function countUp() {
    app.querySelectorAll("[data-countup]").forEach((el) => {
      const to = Number(el.dataset.countup);
      if (el.textContent !== "0" || !to) return;
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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

  function renderResults() {
    const fp = footprint(survey);
    const tips = fp.breakdown.map((b) => ({ b, t: tipFor(b.key, survey) }));
    const totalSaving = tips.reduce((sum, x) => sum + x.t.saving, 0);
    const totalMax = tips.reduce((sum, x) => sum + x.t.maxSaving, 0);
    const now = fp.totalYearly;
    const after = Math.max(0, now - totalSaving);
    const afterMax = Math.max(0, now - totalMax);
    const pct = (v) => (now ? Math.round((v / now) * 100) : 0);
    const cmp = ukComparison(fp);
    const budget = D.BUDGET_YEARLY;
    const ukTotal = cmp.uk;
    const best = tips.slice().sort((x, y) => y.t.saving - x.t.saving)[0];
    const lead = best && best.t.saving > 0.5 ? best : tips[0];
    const top3 = fp.breakdown.slice(0, 3);
    const top3Pct = pct(top3.reduce((t, b) => t + b.yearly, 0));
    const snapshots = getSnapshots();
    const mode = ui.showUk ? "bars" : ui.chartMode || "donut";
    const animate = !ui.resultsSeen;
    ui.resultsSeen = true;

    const ratio = now / budget;
    const ukText =
      cmp.pct < 5 ? "about the same as the UK average" : '<span class="' + (cmp.above ? "clay" : "green") + ' fw-700">' + cmp.pct + "% " + (cmp.above ? "above" : "below") + "</span> the UK average";
    const budgetText =
      ratio <= 1 ? "inside the 1.5°C budget" : ratio < 1.5 ? Math.round((ratio - 1) * 100) + "% over the 1.5°C budget" : ratio.toFixed(1).replace(/\.0$/, "") + " times the 1.5°C budget";

    // Path bar scale: room for now, the UK average and the budget.
    const scale = Math.max(now, ukTotal, budget) * 1.15;
    const W = (v) => Math.min(100, (v / scale) * 100).toFixed(2);
    // Labels near either end line up with the mark instead of centring, so they stay inside the card.
    const edge = (pct) => (pct < 22 ? " edge-l" : pct > 78 ? " edge-r" : "");
    const realisticLine =
      after <= budget
        ? "Realistic changes put you inside the 1.5°C budget."
        : after < ukTotal
        ? "Realistic changes take you below the UK average." + (afterMax <= budget ? " Going all the way puts you inside the 1.5°C budget." : "")
        : afterMax <= budget
        ? "Going all the way puts you inside the 1.5°C budget."
        : "Every step down counts. The biggest wins are below.";

    let html = '<div class="container results-v2">' + (ui.exampleMode ? "" : celebrationCard() + newFiguresCard());
    if (ui.exampleMode) {
      html +=
        '<div class="glass example-banner"><div><span class="eyebrow">Example result</span><p>This is a typical UK resident\'s footprint, worked out the same way as yours will be.</p></div>' +
        '<button type="button" class="btn btn-green" data-action="start-survey">Start your own ' + icon("arrowRight") + "</button></div>";
    }

    if (!ui.exampleMode && checkInDue()) {
      html +=
        '<div class="card callout fade-up"><div class="callout-row"><div class="round-badge">' + icon("calendar") + '</div><div class="grow">' +
        '<h2 class="card-title mb-1">Time for your monthly check-in</h2><p class="sm muted mb-4 max-2xl">It\'s a new month since you last surveyed (' +
        esc(monthLabel(snapshots[snapshots.length - 1].month)) +
        '). Update your answers to see how your footprint has changed.</p>' +
        '<a class="btn btn-green" href="#/">Update my survey ' + icon("arrowRight") + "</a></div></div></div>";
    }

    if (!ui.exampleMode) html += resultTabs(fp, null);

    html +=
      '<section class="glass res-hero' + (animate ? " rise" : "") + '"><div class="res-hero-main">' +
      '<p class="fw-600 muted">Your footprint this year</p>' +
      '<div class="res-total"><span class="display tnum" data-countup="' + Math.round(now) + '">' + kgFmt(animate ? 0 : now) + '</span><span class="muted">kg CO₂e</span></div>' +
      '<p class="res-lead">That\'s ' + ukText + " on the things we can compare, and " + budgetText + ".</p>" +
      '<details class="res-more"><summary>What about shopping and public services?</summary>' + sharedLine(now) + "</details></div>" +
      '<div class="res-hero-path"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><span class="fw-600 muted">With realistic changes</span>' +
      (totalSaving > 0.5 ? '<span class="res-chip">−' + kgFmt(totalSaving) + " kg · " + pct(totalSaving) + "% less</span>" : "") +
      '</div><div class="res-after"><span class="display tnum">' + kgFmt(after) + '</span><span class="muted">kg a year</span></div>' +
      '<div class="path' + (animate ? " animate" : "") + '">' +
      '<span class="path-mark budget' + edge(W(budget)) + '" style="left:' + W(budget) + '%"><i>1.5°C · ' + (budget / 1000).toFixed(1) + " t</i></span>" +
      '<span class="path-mark uk' + edge(W(ukTotal)) + '" style="left:' + W(ukTotal) + '%"><i>UK avg · ' + (ukTotal / 1000).toFixed(1) + " t*</i></span>" +
      '<span class="path-now" style="width:' + W(now) + '%"></span>' +
      '<span class="path-real" style="width:' + W(after) + '%"></span>' +
      '<span class="path-all" style="width:' + W(afterMax) + '%"></span></div>' +
      '<div class="path-legend"><span><i class="lg-all"></i>All the way <b class="tnum">' + kgFmt(afterMax) + "</b></span>" +
      '<span><i class="lg-real"></i>Realistic <b class="tnum">' + kgFmt(after) + "</b></span>" +
      '<span><i class="lg-now"></i>Now <b class="tnum">' + kgFmt(now) + "</b></span></div>" +
      '<p class="sm muted mt-2">' + realisticLine + "</p>" +
      '<p class="xs muted mt-1">*The UK average leaves out banking and pensions, as there\'s no UK figure for them. On the same basis you\'re at ' +
      (cmp.mine / 1000).toFixed(1) + " t.</p></div></section>";

    html +=
      '<div class="res-grid"><section class="glass res-chart"><div class="row-between gap-3" style="flex-wrap:wrap">' +
      '<div><h2 class="card-title">Where it comes from</h2><p class="sm muted">Tap a category to see how to improve it</p></div>' +
      '<div class="chip-row" style="align-items:center">' +
      '<button type="button" class="uk-toggle' + (ui.showUk ? " on" : "") + '" data-action="toggle-uk" aria-pressed="' + (ui.showUk ? "true" : "false") + '">' +
      '<span class="uk-toggle-track"><span class="uk-toggle-knob"></span></span>UK average</button>' +
      '<div class="seg" role="group" aria-label="Chart type">' +
      '<button type="button" data-action="chart-mode" data-mode="donut" aria-pressed="' + (mode === "donut") + '"' + (mode === "donut" ? ' class="on"' : "") + ">Donut</button>" +
      '<button type="button" data-action="chart-mode" data-mode="bars" aria-pressed="' + (mode === "bars") + '"' + (mode === "bars" ? ' class="on"' : "") + ">Bars</button></div></div></div>" +
      (ui.showUk ? '<div class="chart-legend xs muted mt-3"><span><i class="lg-you"></i>You</span><span><i class="lg-uk"></i>Typical UK resident</span><span>No UK figure for money</span></div>' : "") +
      '<div class="res-chart-body">' + (mode === "bars" ? barsChart(fp) : donutChart(fp)) + "</div>" +
      (ui.showUk
        ? '<p class="xs muted mt-2">UK averages use official figures: Defra\'s typical weekly diet, ONS trips abroad with DESNZ flight factors, Ofgem energy use and DfT commuting.</p>'
        : "") +
      "</section>" +
      '<aside class="res-aside">' +
      (lead
        ? '<section class="res-opp"><span class="eyebrow">Your biggest opportunity</span><h3 class="display">' + esc(lead.t.title) + "</h3>" +
          (lead.t.saving > 0.5 ? '<p class="res-opp-kg display tnum">−' + kgFmt(lead.t.saving) + " <small>kg a year</small></p>" : "") +
          '<a class="btn btn-honey btn-block" href="' + catHref(lead.b.key) + '">See how ' + icon("arrowRight") + "</a></section>"
        : "") +
      '<section class="glass res-three"><h3 class="display">Biggest three</h3><p class="sm">' +
      top3.map((b) => esc(b.label)).join(", ").replace(/, ([^,]*)$/, " and $1") + " make up <b>" + top3Pct + "%</b> of your footprint. Start there for the biggest difference.</p></section>" +
      "</aside></div>";

    const hist = ui.exampleMode ? [] : historyByDay();
    if (hist.length) {
      const recent = hist.slice(0, 6);
      const dateOf = (h) => new Date(h.completedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      const first = hist[hist.length - 1];
      const change = hist.length > 1 ? recent[0].totalYearly - first.totalYearly : 0;
      html +=
        '<div class="card"><div class="label-row mb-4">' + icon("calendar", "green") + '<h2 class="card-title">Your progress</h2></div>' +
        (hist.length > 1
          ? '<p class="sm mb-4">Since your first survey on ' + dateOf(first) + ", your footprint has " +
            (change < 0 ? '<strong class="green-dark">fallen by ' + fixed(-change) + " kg a year</strong>." : change > 0 ? '<strong class="red">risen by ' + fixed(change) + " kg a year</strong>." : "stayed the same.") + "</p>"
          : "") +
        '<div class="stack-2">' +
        recent
          .map((h, i) => {
            const prev = recent[i + 1];
            const diff = prev ? h.totalYearly - prev.totalYearly : null;
            const cls = diff > 0 ? "red" : diff < 0 ? "green" : "muted";
            return (
              '<div class="month-row"><div class="label-row min0"><span class="sm fw-500 truncate">' + esc(dateOf(h)) + "</span>" +
              (i === 0 ? '<span class="tag green">Latest</span>' : "") +
              '</div><div class="label-row shrink0">' +
              (diff !== null ? '<span class="xs fw-500 ' + cls + '">' + (diff > 0 ? "▲" : diff < 0 ? "▼" : "—") + " " + Math.abs(diff).toFixed(0) + " kg</span>" : "") +
              '<span class="fw-600">' + fixed(h.totalYearly) + '</span><span class="xs muted">kg/yr</span></div></div>'
            );
          })
          .join("") +
        "</div>" +
        (hist.length < 2 ? '<p class="xs muted mt-3">Take a new survey in a few months to see how your footprint changes.</p>' : "") +
        "</div>";
    } else if (!ui.exampleMode && snapshots.length) {
      const recent = snapshots.slice(-6).reverse();
      html +=
        '<div class="card"><div class="label-row mb-4">' + icon("calendar", "green") + '<h2 class="card-title">Your progress</h2></div><div class="stack-2">' +
        recent
          .map((s, i) => {
            const prev = recent[i + 1];
            const diff = prev ? snapshotYearly(s) - snapshotYearly(prev) : null;
            const cls = diff > 0 ? "red" : diff < 0 ? "green" : "muted";
            return (
              '<div class="month-row"><div class="label-row min0"><span class="sm fw-500 truncate">' + esc(monthLabel(s.month)) + "</span>" +
              (s.month === monthKey() ? '<span class="tag green">This month</span>' : "") +
              '</div><div class="label-row shrink0">' +
              (diff !== null ? '<span class="xs fw-500 ' + cls + '">' + (diff > 0 ? "▲" : diff < 0 ? "▼" : "—") + " " + Math.abs(diff).toFixed(0) + " kg</span>" : "") +
              '<span class="fw-600">' + fixed(snapshotYearly(s)) + '</span><span class="xs muted">kg/yr</span></div></div>'
            );
          })
          .join("") +
        "</div>" +
        (snapshots.length < 2 ? '<p class="xs muted mt-3">Complete the survey again next month to start tracking your trend.</p>' : "") +
        "</div>";
    }

    if (ui.exampleMode) {
      return html + '<div class="center mt-6"><button type="button" class="btn btn-green" data-action="start-survey">Start your own survey ' + icon("arrowRight") + "</button></div></div>";
    }
    html +=
      '<div class="btn-row mt-6"><button type="button" class="btn btn-outline" data-action="edit-survey">' + icon("refresh") + " Edit my answers</button>" +
      '<a class="btn btn-green" href="' + catHref(lead ? lead.b.key : fp.biggest.key) + '">' + icon("arrowRight") + " Show my top opportunity</a></div>" +
      saveCard() + supportCard() +
      '<p class="xs muted footnote">Estimates are approximate and based on typical lifecycle emission factors. Use as a guide to find your biggest opportunities to reduce impact. Figures last updated ' +
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
      '<div class="container cat-v2">' + resultTabs(fp, cat) +
      '<a class="back-overview" href="#/results">' + icon("chevronLeft") + " Back to overview</a>" +
      '<header class="glass cat-hero rise"><span class="cat-watermark" aria-hidden="true">' + ex.icon + "</span>" +
      '<div class="cat-hero-main"><div class="label-row"><span class="cat-badge">' + ex.icon + '</span><span class="eyebrow">' + rank + "</span></div>" +
      '<h1 class="cat-title display">' + esc(ex.title) + '</h1><p class="cat-why">' + esc(ex.why) + "</p></div>" +
      '<div class="cat-hero-side"><div class="cat-figs"><div class="cat-kg display tnum">' + kgFmt(item.yearly) + "</div>" +
      '<div class="muted">kg CO₂e a year</div><div class="cat-yours">' + esc(categorySummary(cat)) + "</div>" +
      '<div class="cat-uk">' + esc(ukLine) + "</div></div>" +
      '<figure class="cat-share"><svg viewBox="0 0 42 42" role="img" aria-label="' + share + '% of your total footprint"><circle cx="21" cy="21" r="20" fill="rgba(63,91,58,.12)"></circle>' +
      '<circle cx="21" cy="21" r="10" fill="none" stroke="#3F5B3A" stroke-width="20" pathLength="100" stroke-dasharray="' + share + ' 100" transform="rotate(-90 21 21)"></circle></svg>' +
      '<figcaption><b class="display">' + share + '%</b><span>of your footprint</span></figcaption></figure></div></header>';

    // Diet cards the survey shows are already done are left out (habits are
    // separate: they track changes from here). Flight cards stay, marked
    // Done, so people come back to them.
    const shown = sections.map((s, i) => ({ s, i })).filter(({ s }) => !(diet && sectionDone(cat, s)) && !sectionHidden(cat, s));
    html +=
      '<div class="cat-grid"><section class="cat-col"><div class="row-between gap-3 cat-sub" style="flex-wrap:wrap;align-items:baseline">' +
      '<h2 class="display">Your ' + (shown.length === 1 ? "next step" : shown.length + " next steps") + '</h2><span class="muted">Tap one for the details</span></div>' +
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
            (k === 0 ? '<a class="todo-guide" href="#/guide/' + cat + '" data-action="go">Step-by-step guide, with comparisons ' + icon("arrowRight") + "</a>" : "") + "</div>" +
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
      '<section class="cat-plan"><h3 class="display">Build the habit</h3><p class="sm">Habit tracking is coming soon, so you can tick these off week by week.</p>' +
      '<span class="soon-pill">Coming soon</span></section></aside></div>' +
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
          title: "You already eat plant-based",
          lede: "Your days are already the lowest-carbon way to eat." + (lowWaste ? " There's nothing more to switch here." : " Wasting less food is the one thing left to go further."),
          saveLabel: lowWaste ? "Nothing more to switch" : "Wasting less could save",
          steps: wasteSteps,
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

  function renderGuide(cat) {
    const ex = D.EXPLAINERS[cat];
    if (!ex) {
      location.replace("#/results");
      return "";
    }
    const fp = footprint(survey);
    const g = guideSpec(cat);
    const idx = Math.max(0, fp.breakdown.findIndex((b) => b.key === cat));
    const item = fp.breakdown[idx] || { yearly: 0 };
    const next = fp.breakdown[(idx + 1) % fp.breakdown.length];
    const shownSave = g.saveOverride != null ? g.saveOverride : g.save;
    const eqKg = g.eqFlights ? item.yearly : shownSave > 0.5 ? shownSave : item.yearly;
    const eq = equivalents(eqKg);
    const max = Math.max(1e-9, ...g.rows.map((r) => r[1]));
    const val = (v) => (v < 10 && v > 0 ? v.toFixed(2) : kgFmt(v));
    const colours = ["#B8653D", "#D9A441", "#A3B58F", "#6E8B5E", "#3F5B3A"];
    const rowColour = (i, n) => (n <= 2 ? (i === 0 ? colours[0] : colours[4]) : colours[Math.min(4, Math.round((i / (n - 1)) * 4))]);
    const diet = cat === "meals" ? D.DIET_EXPLAINERS[dietType(survey)] : null;
    const others = ((diet && diet.sections) || ex.sections).map((x) => x.heading).filter((h) => h !== g.title).slice(0, 3);
    const budgetPct = (eqKg / D.BUDGET_YEARLY) * 100;
    const repeat = (n, ic, cap) => Array.from({ length: Math.min(n, cap) }, () => icon(ic)).join("") + (n > cap ? '<span class="xs muted">+' + (n - cap) + "</span>" : "");
    return (
      '<div class="container guide-v2">' + resultTabs(fp, cat) +
      '<p class="crumbs"><a href="#/results">Overview</a> › <a href="#/explainer/' + cat + '">' + esc(ex.title) + "</a> › <span>Guide</span></p>" +
      '<header class="glass cat-hero rise"><span class="cat-watermark" aria-hidden="true">' + ex.icon + "</span>" +
      '<div class="cat-hero-main"><span class="tag done-tag">Your biggest step here</span><h1 class="cat-title display">' + esc(g.title) + '</h1><p class="cat-why">' + esc(g.lede) + "</p></div>" +
      '<div class="cat-hero-side"><div class="cat-figs"><div class="muted">' + esc(g.saveLabel) + "</div>" +
      (shownSave >= 0.5
        ? '<div class="cat-kg display tnum green-dark">−' + kgFmt(shownSave) + '</div><div class="muted">kg CO₂e a year</div>'
        : '<div class="cat-kg display green-dark">' + icon("check") + '</div><div class="muted">You\'re already doing this</div>') +
      "</div></div></header>" +
      '<section class="glass guide-card rise" style="animation-delay:.06s"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:flex-end"><div><span class="eyebrow">Side by side</span>' +
      '<h2 class="display">' + esc(g.vsTitle) + "</h2></div>" + (g.headline ? '<span class="display guide-headline">' + esc(g.headline) + "</span>" : "") + "</div>" +
      '<ul class="vs-list">' +
      g.rows
        .map(
          (r, i) =>
            '<li><span class="vs-icon" style="color:' + rowColour(i, g.rows.length) + '">' + r[2] + '</span><span class="vs-label">' + esc(r[0]) + "</span>" +
            '<span class="vs-track"><span style="width:' + Math.max(r[1] > 0 ? 1.5 : 0.6, (r[1] / max) * 100).toFixed(1) + "%;background:" + rowColour(i, g.rows.length) + ";animation-delay:" + (i * 0.12).toFixed(2) + 's"></span></span>' +
            '<span class="vs-val"><b class="display tnum">' + val(r[1]) + "</b> " + g.unit + "</span></li>"
        )
        .join("") +
      '</ul><p class="xs muted mt-3">' + esc(g.source) + "</p></section>" +
      (eqKg > 0.5
        ? '<section class="glass guide-card rise" style="animation-delay:.12s"><span class="eyebrow">What that looks like</span><h2 class="display">' +
          (g.eqFlights ? "What your " + kgFmt(eqKg) + " kg of flying a year looks like" : "What −" + kgFmt(eqKg) + " kg a year looks like") + "</h2>" +
          '<div class="eq-grid">' +
          '<div class="eq"><div class="row-between"><span>Trees needed to soak it up</span><b class="display tnum">' + kgFmt(eq.trees) + '</b></div><div class="eq-icons green-dark">' + repeat(eq.trees, "tree", 18) + '</div><p class="xs muted">A mature tree absorbs about 20 kg of CO₂ a year.</p></div>' +
          '<div class="eq"><div class="row-between"><span>Share of the 1.5°C budget</span><b class="display tnum">' + (budgetPct < 1 ? budgetPct.toFixed(1) : Math.round(budgetPct)) + '%</b></div><div class="eq-bar"><span style="width:' + Math.min(100, budgetPct).toFixed(1) + '%"></span></div><p class="xs muted">Of one person\'s yearly {{budget_t}} t.</p></div>' +
          '<div class="eq"><div class="row-between"><span>The same as driving</span><b class="display tnum">' + kgFmt(eq.drivingKm) + ' km</b></div><p class="xs muted">In a petrol car. London to Edinburgh is about 650 km.</p></div>' +
          '<div class="eq"><div class="row-between"><span>New phones</span><b class="display tnum">' + kgFmt(eq.phones) + '</b></div><div class="eq-icons">' + repeat(eq.phones, "phone", 8) + '</div><p class="xs muted">Making and charging one phone for a year: about 61 kg.</p></div>' +
          "</div></section>"
        : "") +
      '<div class="cat-grid"><section class="glass guide-card cat-col"><h2 class="display">How to do it</h2><ol class="howto">' +
      g.steps.map((st, i) => '<li><span class="num-badge display">' + (i + 1) + '</span><div><h3 class="display">' + esc(st[0]) + "</h3><p>" + esc(st[1]) + "</p></div></li>").join("") +
      "</ol></section>" +
      '<aside class="cat-aside">' + (ex.fact ? '<section class="cat-fact"><span class="eyebrow">Good to know</span><p class="display">' + esc(ex.fact) + "</p></section>" : "") +
      (others.length
        ? '<section class="glass cat-drop"><h3 class="display">More ways to cut it</h3><ul class="more-ways">' +
          others.map((h) => '<li><a href="#/explainer/' + cat + '">' + esc(h) + icon("chevronRight") + "</a></li>").join("") + "</ul></section>"
        : "") +
      "</aside></div>" +
      '<div class="cat-steps"><a class="cat-step" href="#/explainer/' + cat + '">' + icon("chevronLeft") + "<span><small>Back to</small><b>" + esc(ex.title) + "</b></span></a>" +
      '<a class="cat-step next" href="#/guide/' + next.key + '"><span><small>Next guide</small><b>' + esc(next.label) + "</b></span>" + icon("chevronRight") + "</a></div></div>"
    );
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
    if (cat !== "banking" || s.dynamicKey !== "savingsPensions") return false;
    const b = survey.banking || {};
    return !b.pensionPot || !!(byKey(D.PENSION_PROVIDERS, b.pensionProvider) || {}).unfunded;
  };

  // Driving cards only make sense for people who drive to work.
  const carDaysOf = (s) => DAYS.filter((d) => MOTOR_MODES.includes((s.commute || {})[d]));
  function sectionHidden(cat, s) {
    return cat === "commute" && (s.dynamicKey === "commuteSwap" || s.dynamicKey === "ifDriving") && carDaysOf(survey).length === 0;
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
    // Food: going by the meals someone has entered so far.
    if (cat === "meals" && l.when && s) {
      const diet = dietType(s);
      const lowWaste = ((s.meals || {}).foodWaste || "low") === "low";
      if (l.when === "meat") return diet !== "veggie" && diet !== "vegan";
      if (l.when === "plants") return diet !== "vegan";
      if (l.when === "waste") return diet !== "vegan" || !lowWaste;
    }
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
    return offerCard(cat, links, "guide", kg > 0.5 ? "Making this change could cut about <strong>" + Math.round(kg).toLocaleString() + " kg CO₂e a year</strong> from your footprint." : "");
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
      if (!error && data) ui.actsInfo = data;
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
    if (currentPath() === "/habits") render();
  }
  const inviteLink = () => PRODUCTION_URL + (ui.actsInfo && ui.actsInfo.code ? "?ref=" + ui.actsInfo.code : "");
  const MP_COPY = "mp@co2counter.co.uk";
  // A ready-to-edit letter. The reference lets us match the BCC copy to the
  // account; MPs need a name and full address to reply to a constituent.
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
  function shareText() {
    const fp = survey && survey.completedAt ? footprint(survey) : null;
    return (fp ? "I worked out my carbon footprint: " + (fp.totalYearly / 1000).toFixed(1) + " t CO₂e a year. " : "I'm working out my carbon footprint. ") +
      "Find yours, free, with CO2 Counter:";
  }
  const longDate = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  // Act 6: verified when the BCC copy of the letter reaches us. Without the
  // verification set up yet, it falls back to a tick by hand.
  function mobiliseAct(ticked) {
    const base = { n: 6, name: "Mobilise: use your vote", what: "to ask your representatives for action" };
    const info = ui.actsInfo;
    if (!info) return { ...base, manual: "mobilise", done: !!ticked.mobilise, sub: ticked.mobilise ? "Done · ticked by you" : "Tick when you've done it",
      extra: '<a class="hb-act-link" href="https://www.writetothem.com/" target="_blank" rel="noopener">Write to your MP ' + icon("link") + "</a>" };
    const verified = info.verified && info.verified.mobilise;
    if (verified) return { ...base, done: true, verifiedTick: true, sub: "Verified · your letter to your MP reached us on " + longDate(verified) };
    const mp = ui.mp || {};
    const finder =
      '<form id="mp-form" class="hb-mp-form"><input class="input" id="mp-postcode" autocomplete="postal-code" placeholder="Your postcode" maxlength="10" value="' + esc(ui.mpPostcode || "") + '" aria-label="Your postcode" />' +
      '<button type="submit" class="btn btn-outline btn-sm"' + (mp.loading ? " disabled" : "") + ">" + (mp.loading ? "Finding…" : "Find my MP") + "</button></form>" +
      (mp.error ? '<p class="xs red">' + esc(mp.error) + "</p>" : "");
    const letter = mp.name
      ? '<div class="hb-mp"><p class="sm"><b>' + esc(mp.name) + "</b>, MP for " + esc(mp.constituency) + "</p>" +
        (mp.email
          ? '<a class="btn btn-green btn-sm mt-2" href="' + esc(mpLetter(mp)) + '" data-action="mp-sent">Email ' + esc(mp.name.split(" ")[0]) + " " + icon("arrowRight") + "</a>" +
            '<p class="xs muted mt-2">Opens your email app with a letter to edit. Add your name and full address: MPs only reply to constituents. We\'re copied in (BCC, ' + MP_COPY + ") so we can verify it, then we delete our copy. Reference CO2-" + esc(info.code) + ".</p>"
          : '<a class="hb-act-link mt-2" href="https://members.parliament.uk/member/' + mp.id + '/contact" target="_blank" rel="noopener">Contact details ' + icon("link") + '</a><p class="xs muted mt-2">If you email them, BCC ' + MP_COPY + " with reference CO2-" + esc(info.code) + " in your message so we can verify it.</p>") +
        "</div>"
      : "";
    return { ...base, done: false, sub: ticked.mpSent ? "Waiting for our copy of your letter · this ticks once it arrives" : "Email your MP, and this ticks once our copy arrives", extra: finder + letter };
  }
  // Act 7: verified by invite link, once seven people who joined with it
  // have finished the survey.
  function motivateAct(ticked, url, text) {
    const base = { n: 7, name: "Motivate seven other people", what: "to do their 7 Acts" };
    const info = ui.actsInfo;
    const shares =
      '<span class="hb-share">' +
      '<button type="button" class="hb-act-link" data-action="share-app">' + icon("link") + "Share</button>" +
      '<button type="button" class="hb-act-link" data-action="share-instagram">Instagram</button>' +
      '<a class="hb-act-link" href="https://wa.me/?text=' + text + '" target="_blank" rel="noopener">WhatsApp</a>' +
      '<a class="hb-act-link" href="https://twitter.com/intent/tweet?text=' + text + '" target="_blank" rel="noopener">X</a>' +
      '<a class="hb-act-link" href="https://www.facebook.com/sharer/sharer.php?u=' + url + '" target="_blank" rel="noopener">Facebook</a>' +
      '<a class="hb-act-link" href="#/friends">Add friends</a></span>' + (ui.shareMsg ? '<span class="xs green-dark hb-share-msg">' + esc(ui.shareMsg) + "</span>" : "");
    if (!info) return { ...base, manual: "motivate", done: !!ticked.motivate, sub: ticked.motivate ? "Done · ticked by you" : "Share CO2 Counter, then tick when seven have joined in", extra: shares };
    const n = Math.min(7, info.finished || 0);
    const verified = (info.verified && info.verified.motivate) || n >= 7;
    return {
      ...base, done: !!verified, verifiedTick: !!verified,
      sub: verified ? "Verified · seven people you invited have taken the survey" : n + " of 7 people you invited have taken the survey" + (info.joined > n ? " (" + info.joined + " joined)" : ""),
      extra: '<span class="xs muted hb-invite">Your invite link: <b>' + esc(inviteLink().replace(/^https:\/\//, "")) + "</b></span>" + shares,
    };
  }

  function renderHabitsPage() {
    const ready = survey && survey.completedAt;
    const areas = ready ? switchAreas({ s: survey, mine: true }) : [];
    const area = (k) => areas.find((a) => a.key === k);
    const ticked = actsTicked();
    const travel = ready ? [area("commute"), area("flights")] : [];
    const travelSave = travel.reduce((t, a) => t + (a.done ? 0 : a.save), 0);
    const auto = (a) => (ready ? { done: a.done, sub: a.done ? (a.save >= 0.5 ? "Done · could go a bit further, −" + kgFmt(a.save) + " kg" : "Done · " + a.doneTitle.replace(/^You're /, "you're ").replace(/^You /, "you ").replace(/^No /, "no ")) : a.save >= 0.5 ? "Not yet · could save " + kgFmt(a.save) + " kg a year" : "Not yet" } : { done: false, sub: "Finish your survey to see" });
    const url = encodeURIComponent(inviteLink());
    const text = encodeURIComponent(shareText() + " " + inviteLink());
    const acts = [
      { n: 1, name: "Move your money", what: "away from banks that finance fossil fuels", cat: "banking", ...(ready ? auto(area("banking")) : auto()) },
      { n: 2, name: "Move your energy", what: "to a 100% renewable supplier, and electrify", cat: "energy", ...(ready ? auto(area("energy")) : auto()) },
      { n: 3, name: "More plant-based food", what: "seasonal and local where you can", cat: "meals", ...(ready ? auto(area("meals")) : auto()) },
      { n: 4, name: "More green travel", what: "walk, cycle, take the train, fly less", cat: travel.length && travel[0].done ? "flights" : "commute",
        done: ready && travel.every((a) => a.done),
        sub: !ready ? "Finish your survey to see" : travel.every((a) => a.done) ? "Done · green commute and no flights" :
          [travel[0].done ? "Commute done" : "Commute not yet", travel[1].done ? "no flights" : "flights not yet"].join(" · ") + (travelSave >= 0.5 ? " · could save " + kgFmt(travelSave) + " kg a year" : "") },
      { n: 5, name: "Monitor your CO₂ footprint", what: "and cut where you can", href: ready ? "#/results" : "#/", done: !!ready, sub: ready ? "Done · you've measured it with CO2 Counter" : "Take the survey to tick this one" },
      mobiliseAct(ticked),
      motivateAct(ticked, url, text),
    ];
    const made = acts.filter((a) => a.done).length;
    const box = (a) => '<span class="hb-box" aria-hidden="true">' + (a.done ? icon("check") : "") + "</span>";
    const body = (a) =>
      '<span class="min0"><span class="fw-600 hb-name"><span class="hb-n">' + a.n + "</span>" + esc(a.name) + '</span><span class="xs muted hb-what">' + esc(a.what) + '</span><span class="xs hb-sub' + (a.done ? " green-dark" : " muted") + '">' + esc(a.sub) + "</span></span>";
    const rows = acts
      .map((a) =>
        (a.extra && !a.manual) || (a.verifiedTick && !a.cat && !a.href)
          ? '<li class="hb-item"><div class="hb-row' + (a.done ? " done" : "") + '">' + box(a) + body(a) + "<span></span></div>" + (a.done || !a.extra ? "" : '<div class="hb-extra">' + a.extra + "</div>") + "</li>"
          : a.manual
          ? '<li class="hb-item"><div class="hb-row' + (a.done ? " done" : "") + '"><button type="button" class="hb-tick" data-action="tick-act" data-act="' + a.manual + '" role="checkbox" aria-checked="' + a.done + '" aria-label="' + esc(a.name) + '">' + box(a) + "</button>" + body(a) + "<span></span></div>" +
            '<div class="hb-extra">' + a.extra + "</div></li>"
          : '<li class="hb-item"><a class="hb-row' + (a.done ? " done" : "") + '" href="' + (a.href || "/greener-switches/") + '"' + (a.cat && ready ? ' data-action="jump-switch" data-cat="' + a.cat + '"' : "") + ">" + box(a) + body(a) +
            '<span class="sr-only">' + (a.done ? "done" : "not done yet") + "</span>" + icon("chevronRight") + "</a></li>"
      )
      .join("");
    return (
      '<div class="container narrow">' + pageHeader("My Habits", "One-off changes, and habits you keep") +
      '<section class="card mb-6 fade-up"><div class="label-row mb-2"><span class="round-badge sm">' + icon("refresh") + '</span><h2 class="card-title">One-off changes</h2>' +
      '<span class="tag ml-auto">The 7 Acts</span></div>' +
      '<p class="sm muted mb-4">Real Zero\'s <a href="https://www.realzero.earth/7-acts" target="_blank" rel="noopener">7 Acts</a> for individuals. <b class="green-dark">' + made + " of 7</b> done" + (ready ? ", going by your latest survey." : ".") + "</p>" +
      '<ul class="hb-list">' + rows + "</ul>" +
      '<a class="btn btn-green btn-block mt-4" href="/greener-switches/">' + (ready ? "See your switches in full " : "See the switches ") + icon("arrowRight") + "</a></section>" +
      '<section class="card fade-up"><div class="label-row mb-3"><span class="round-badge sm">' + icon("leaf") + '</span><h2 class="card-title">Daily habits</h2>' +
      '<span class="tag amber ml-auto">Coming soon</span></div><p class="sm muted">Small things you do every day, like a meat-free lunch or a shorter shower, with streaks to keep you going. We\'re building this next.</p></section></div>'
    );
  }

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
    else body = pos === 0 ? '<a class="todo-guide" href="#/guide/' + cat + '" data-action="go">Step-by-step guide, with comparisons ' + icon("arrowRight") + "</a>" : "";

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
        "<p>To keep global warming to 1.5°C, average emissions need to fall to roughly {{budget_t}} tonnes of CO₂-equivalent per person per year. " +
          "We show your footprint as a share of that, as a sense of scale.</p>"
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
    if (!inputLog.loaded) html += '<p class="sm muted">Loading…</p>';
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
  };
  const svgPath = (d, size, extra) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || "") + '><path d="' + d + '"></path></svg>';
  const leafMark = (size) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100" aria-hidden="true"><path d="M22 80C22 44 46 20 82 18c0 38-24 62-60 62Z" fill="#EFE9DC"></path><rect x="36" y="40" width="7" height="22" rx="3.5" fill="#3F5B3A"></rect><rect x="46" y="47" width="7" height="15" rx="3.5" fill="#3F5B3A"></rect><rect x="56" y="54" width="7" height="8" rx="3.5" fill="#D9A441"></rect></svg>';
  const TONES = { leaf: ["#3F5B3A", "#F6F1E6"], amber: ["#E8C88A", "#2E2A22"], plum: ["#6F4E63", "#F6F1E6"], sky: ["#7FA3AE", "#14262B"] };
  const domainOf = (u) => u.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  const fmtKg = (n) => (n < 10 && n > 0 ? (Math.round(n * 100) / 100).toString() : kgFmt(n));

  // The survey the page is worked out from, and who it belongs to.
  function switchBase() {
    if (survey && survey.completedAt) return { s: survey, mine: true };
    const s = normaliseSurvey(JSON.parse(JSON.stringify(D.UK_TYPICAL_SURVEY)));
    s.flights = D.UK_TYPICAL_SURVEY.flights;
    const worst = D.BANKS.slice().sort((a, b) => b.factor - a.factor)[0];
    s.banking = { ...s.banking, amount: A.EXAMPLE_SAVINGS, bank: worst.key };
    return { s, mine: false };
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
        fact: energyDone
          ? "You're already on a renewable tariff, which cuts your electricity emissions by {{green_cut}}. Going further means using less: heating, insulation and, in time, a heat pump."
          : "A renewable tariff can cut electricity emissions by {{green_cut}}, with no new equipment, and your power never cuts out during the switch.",
        vsTitle: (base.mine ? "Your" : "Typical") + " electricity for a year, kg CO₂e", beforeLabel: "Standard", before: elecKwh * D.ELECTRICITY_FACTOR, afterLabel: energyDone ? "Yours: green tariff" : "Green tariff", after: elecKwh * D.GREEN_ELECTRICITY_FACTOR },
      { key: "meals", short: "Food", effort: "Ongoing · a weekly habit", ex: 84, save: saving("meals"), verb: "Explore", panel: "#6E8B5E", panelInk: "#F6F1E6", dropInk: "#F6F1E6",
        done: foodDone,
        doneTitle: diet === "vegan" ? "You already eat plant-based" : "You're vegetarian. Go a bit further?",
        fact: foodDone
          ? diet === "vegan"
            ? "Your days are already plant-based, the lowest-carbon way to eat." + (saving("meals") >= 0.5 ? " Wasting less food is the one thing left to go further." : " Nothing more to switch here.")
            : "No meat already puts you well below a typical diet. You could go a bit further with a few vegan days: dairy and eggs are most of what's left."
          : food.what
            ? food.what + " emits " + times(food.before, food.after) + " a vegan day" + (base.mine ? ", and it's your highest-carbon day of food" : "") + ". A veg box or a recipe app makes the swap the easy option."
            : "Swapping a few meat days for plant-based ones is the biggest food change. A veg box or a recipe app makes it the easy option.",
        vsTitle: "A day of food, kg CO₂e", beforeLabel: food.beforeLabel, before: food.before, afterLabel: food.afterLabel, after: food.after },
      { key: "flights", short: "Flights", effort: "When you travel · per trip", ex: 50, save: saving("flights"), verb: "Plan with", panel: "#B8653D", panelInk: "#FFF7EE", dropInk: "#FFF7EE",
        done: flightsDone,
        doneTitle: "No flights to switch",
        fact: flightsDone
          ? "You haven't added any flights, so there's nothing to switch. For trips in the UK and nearby Europe, the train is usually the low-carbon way to go."
          : base.mine && myFlights.length && myFlights.every((f) => flightKm(f.from, f.to) > A.SHORT_HAUL_KM)
            ? "Your flights are too far for the train to be realistic. The switches here are flying a little less often and choosing economy, which shares the plane's emissions between more people."
            : "Once airport time is counted, the train is often as quick door to door for shorter trips, and it emits a fraction as much.",
        vsTitle: "London → Paris, return, kg CO₂e", beforeLabel: "Plane", before: A.PARIS_FLIGHT_KG, afterLabel: "Train", after: A.PARIS_TRAIN_KG },
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
    ].map((a) => {
      // Your own page only shows the links that suit your answers.
      const fit = base.mine ? linksFor(a.key, s) : D.USEFUL_LINKS[a.key];
      return { ...a, title: a.done ? a.doneTitle : D.USEFUL_LINKS[a.key].title, eyebrow: D.USEFUL_LINKS[a.key].eyebrow, links: fit ? fit.items : [] };
    });
  }

  function renderSwitches() {
    const base = switchBase();
    const fp = footprint(base.s);
    const areas = switchAreas(base);
    const total = areas.reduce((t, a) => t + a.save, 0);
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
            '<span class="min0"><span class="display sw-short">' + a.short + (a.done ? '<span class="sw-done">' + icon("check") + "Done</span>" : "") + '</span><span class="sw-effort">' + (a.done ? (a.save >= 0.5 ? "Could go a bit further" : "Nothing more to switch") : a.effort) + "</span></span>" +
            '<span class="sw-save tnum">' + (a.save >= 0.5 ? "−" + kgFmt(a.save) : "0") + "</span>" +
            '<button type="button" class="sw-tog" role="switch" aria-checked="false" aria-label="' + esc(a.title) + ", saves " + kgFmt(a.save) + ' kg a year" data-action="flip-switch" data-i="' + i + '"><span class="sw-knob"></span></button></li>'
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
      .join("");
    const plot =
      '<section class="sw-sec"><div class="sw-sec-head"><div><span class="sw-kicker">Where to start</span><h2 class="display">Impact against effort</h2></div>' +
      "<p>Bigger bubbles save more. Start top left, where the saving is big and the effort is small. Tap a bubble to jump to it.</p></div>" +
      '<div class="sw-plot"><span class="sw-ytitle">KG SAVED A YEAR ↑</span><div class="sw-area"><div class="sw-quick"></div><div class="sw-vmid"></div><div class="sw-hmid"></div>' +
      ticks.map((f) => '<div class="sw-tick' + (f ? "" : " zero") + '" style="bottom:' + f * 100 + '%"><span class="tnum">' + kgFmt(maxSave * f) + "</span></div>").join("") +
      '<span class="sw-q" style="left:12px;top:12px;color:#2B4128">★ Quick wins</span><span class="sw-q" style="right:4px;top:calc(50% - 26px)">Big, but a habit</span>' +
      '<span class="sw-q" style="left:12px;top:calc(50% + 10px)">Easy extras</span><span class="sw-q" style="right:4px;top:calc(50% + 10px)">Slow burners</span>' +
      bubbles + '</div><div class="sw-xaxis"><span>Once, in minutes</span><i></i><b>MORE EFFORT →</b><i></i><span>Every day, a habit</span></div></div>' +
      '<ul class="sw-legend">' + areas.map((a) => '<li><a href="/greener-switches/" data-action="jump-switch" data-cat="' + a.key + '"><span class="sw-leg-dot" style="background:' + a.panel + ";color:" + a.panelInk + '">' + svgPath(SW_ICONS[a.key], 16) + '</span><span class="display">' + a.short + '</span><span class="tnum sw-leg-kg">−' + kgFmt(a.save) + ' kg</span><span class="sw-leg-when">' + a.effort.split(" · ")[1] + "</span></a></li>").join("") + "</ul></section>";
    const feats = areas
      .map((a, i) => {
        const drop = a.before > 0 ? Math.round((1 - a.after / a.before) * 100) : 0;
        const paid = a.links.some((l) => l.ref);
        return (
          '<section class="sw-feat' + (i % 2 ? " flip" : "") + '" id="switch-' + a.key + '"><div class="sw-feat-in">' +
          '<div class="sw-panel" style="background:' + a.panel + ";color:" + a.panelInk + '">' + svgPath(SW_ICONS[a.key], 260, ' class="sw-panel-bg"') +
          '<div class="sw-panel-top"><span class="display tnum sw-no">0' + (i + 1) + '</span><span class="sw-drop"><b class="display tnum" style="color:' + a.dropInk + '">−' + drop + "%</b><span>less CO₂e</span></span></div>" +
          '<div><div class="sw-vs-title">' + esc(a.vsTitle) + '</div><div class="sw-vs"><span>' + esc(a.beforeLabel) + '</span><span class="sw-vs-track"><span class="sw-vs-before"></span></span><b class="display tnum">' + fmtKg(a.before) + "</b>" +
          "<span>" + esc(a.afterLabel) + '</span><span class="sw-vs-track"><span class="sw-vs-after" style="width:' + Math.max(0, Math.min(100, (a.after / (a.before || 1)) * 100)).toFixed(1) + '%"></span></span><b class="display tnum">' + fmtKg(a.after) + "</b></div></div></div>" +
          '<div class="sw-body"><div class="chip-row">' + (a.done ? '<span class="sw-chip dark">' + icon("check") + "Already done</span>" : '<span class="sw-chip honey">' + esc(a.eyebrow) + "</span>") + '<span class="sw-chip">' + icon("clock") + esc(a.effort) + "</span>" +
          (a.save > 0.5 ? '<span class="sw-chip dark tnum">−' + kgFmt(a.save) + " kg a year " + who + "</span>" : "") + "</div>" +
          '<h2 class="display">' + esc(a.title) + "</h2><p class=\"sw-fact\">" + esc(a.fact) + "</p>" + (a.links.length ? '<div class="sw-offers">' +
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
          '</div><p class="sw-disc">' +
          (a.independent ? "Chosen using the bank league table. These are never affiliate links." : paid ? "Some of these are referral links: if you switch, CO2 Counter may get a reward at no cost to you." : "Independent suggestions. We don't get paid for these links.") +
          "</p>" : "") + "</div></div></section>"
        );
      })
      .join("");
    return (
      '<div class="container sw-page">' +
      '<header class="sw-hero"><div class="sw-hero-main"><span class="ab-pill rise">Greener switches</span>' +
      '<h1 class="display rise d1">Five switches.<br><span>Up to ' + kgFmt(total) + " kg</span> a year.</h1>" +
      '<p class="rise d2">The biggest, easiest changes ' + (base.mine ? "for your footprint" : "for a typical UK footprint") + ", with options we'd recommend anyway. Flip a switch to see what it saves.</p></div>" + board + "</header>" +
      plot + feats +
      '<section class="sw-band"><div><h2 class="display">Independent, always</h2><p>Picked for the climate first, including options that pay us nothing. Partners never change anyone\'s figures, and bank and pension picks are never affiliate links. <a href="/about/">How we choose</a></p></div>' +
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
    app.querySelectorAll(".sw-row").forEach((row) => {
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
      const pets = [s.pets.dogs ? plural(Math.round(s.pets.dogs), "dog") : "", s.pets.cats ? plural(Math.round(s.pets.cats), "cat") : ""].filter(Boolean).join(", ") || "No pets";
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
      ["03", "Stay on your side.", "Nobody pays to be ranked higher. Suggestions are picked for the climate, not for a fee."],
    ];
    const principles = [
      ["Climate first", "We recommend what cuts the most carbon, even when there's nothing in it for us.", "rgba(63,91,58,.14)", "#3F5B3A", "M5 19c0-8 5-13 14-14 0 9-5 14-14 14ZM5 19l7-7"],
      ["Free options too", "Free guides like The Man in Seat 61 and Fork Ranger sit alongside paid services.", "rgba(127,163,174,.22)", "#3E6672", "M4 6h16M4 12h16M4 18h10"],
      ["Figures stay ours", "No partner can change or sponsor the numbers in your results.", "rgba(217,164,65,.22)", "#8A5F12", "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z"],
      ["Money stays clean", "Bank and pension suggestions come from the league table and are never affiliate links.", "rgba(184,101,61,.18)", "#8C4A2A", "M3 10l9-6 9 6M5 10v8M19 10v8M9.5 10v8M14.5 10v8M3 20h18"],
    ];
    const stats = [
      ["£0", "To use, for everyone. No paywall, no premium tier.", "#3F5B3A", "#F6F1E6"],
      ["£2", "A year, if you'd like to support it. Entirely optional.", "#E8C88A", "#2E2A22"],
      [String(paidCount), (paidCount === 1 ? "Affiliate link" : "Affiliate links") + " on the site today.", "rgba(255,252,245,.75)", "#2E2A22"],
    ];
    const tick = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EFE9DC" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ab-tick" d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';
    return (
      '<div class="container ab-page">' +
      '<header class="ab-hero"><span class="ab-pill rise">About CO2 Counter</span>' +
      '<h1 class="display rise d1">Your footprint, counted honestly. <span>Then made smaller.</span></h1>' +
      '<p class="rise d2">CO2 Counter is a free, six-step survey that works out your yearly carbon footprint from official UK data, then shows you the changes that cut it the most.</p>' +
      '<ul class="ab-promises rise d3" aria-label="Our promises">' + ["Free for everyone", "Independent", "Official UK data", "Kept going by supporters"].map((t) => "<li><span>" + tick + "</span>" + t + "</li>").join("") + "</ul></header>" +
      '<section class="ab-sec" aria-labelledby="ab-beliefs"><h2 id="ab-beliefs" class="ab-kicker">What we believe</h2><ol class="ab-beliefs">' +
      beliefs.map(([n, t, b]) => '<li class="ab-belief"><span class="display tnum ab-bno">' + n + '</span><h3 class="display">' + t + "</h3><p>" + b + "</p></li>").join("") + "</ol></section>" +
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
      "<p>CO2 Counter isn't owned or funded by any energy company, bank or other business. It's free for everyone, and people who find it useful can support it for £2 a year.</p>" +
      '<a href="mailto:' + esc(CONTACT_EMAIL) + '" class="ab-mail">' + svgPath("M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 7l9 6 9-6", 18) + esc(CONTACT_EMAIL) + "</a></div>" +
      '<div class="ab-stats">' + stats.map(([big, t, bg, ink]) => '<div class="ab-stat" style="background:' + bg + ";color:" + ink + '"><span class="display tnum">' + big + "</span><span>" + t + "</span></div>").join("") + "</div></section>" +
      '<section class="ab-sec" aria-labelledby="ab-principles"><div class="ab-kicker">How we choose partners</div><h2 id="ab-principles" class="display ab-h2">The climate comes first. <span>Every time.</span></h2><div class="ab-principles">' +
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
  async function loadAnalytics() {
    if (!sb || analytics.loading) return;
    analytics.loading = true;
    try {
      const { data, error } = await sb.rpc("owner_analytics");
      if (error) throw error;
      analytics.data = data || {};
      analytics.error = "";
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
    const people = d.people || [];
    const roles = ROLES.map(([k, l]) => breakdown(l, people.filter((p) => p.role === k).map((p) => p.u))).concat([breakdown("Not given", people.filter((p) => !p.role).map((p) => p.u))]);
    const groups = (d.groups || []).map((g) => breakdown(g.name, g.members || []));
    const research = people.filter((p) => p.research).map((p) => p.u);
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

  function renderAnalytics() {
    if (!analytics.loaded) loadAnalytics();
    let html = '<div class="container analytics-page">' + pageHeader("Analytics", "How people use CO2 Counter", "chart");
    if (!analytics.loaded) return html + '<section class="glass an-card"><p class="muted">Loading…</p></section></div>';
    if (analytics.error) return html + '<section class="glass an-card"><p class="fw-700">Couldn\'t load the analytics</p><p class="sm muted">' + esc(analytics.error) + '</p><button type="button" class="btn btn-outline btn-sm mt-3" data-action="refresh-analytics">Try again</button></section></div>';
    // Letters to MPs arrive by BCC with a reference; verifying ticks act 6.
    html +=
      '<section class="glass an-card"><h2 class="card-title">Verify a letter to an MP</h2><p class="sm muted">Letters BCC\'d to ' + MP_COPY + " carry a reference like CO2-ABC123. Enter it to verify that person's act 6, then delete the email.</p>" +
      '<form id="verify-mp-form" class="hb-mp-form mt-3"><input class="input" id="verify-mp-code" placeholder="CO2-ABC123" maxlength="12" aria-label="Reference" /><button type="submit" class="btn btn-green btn-sm">Verify</button></form>' +
      (ui.verifyMsg ? '<p class="xs mt-2 ' + (ui.verifyMsg.ok ? "green-dark" : "red") + '" role="status">' + esc(ui.verifyMsg.text) + "</p>" : "") + "</section>";
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
    html += table("By role", "From the optional \"What best describes your work?\" on the Account page.", m.roles) + table("By group", "Groups people have made on the Friends page.", m.groups);
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
      await loadGroups();
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
      friends.groupMsg = (e && e.message) || "Something went wrong. Please try again.";
    } finally {
      await loadGroups();
      render();
    }
  }

  function groupsHtml() {
    if (!friends.groupsReady) return "";
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
        '<div class="group-head mt-4"><div class="min0"><h3 class="display group-name">' + esc(g.name) + '</h3><p class="xs muted">' + g.members + (g.members === 1 ? " member" : " members") + (g.is_owner ? " · you started it" : "") + "</p></div>" +
        '<div class="group-code"><span class="xs muted">Code</span><b class="display tnum">' + esc(g.code) + '</b><button type="button" class="btn btn-sm btn-outline" data-action="copy-group" data-link="' + esc(link) + '" data-code="' + esc(g.code) + '">' + icon("copy") + " Copy invite</button></div></div>" +
        '<div class="stat-tiles mt-4"><div class="stat-tile"><span class="eyebrow">Average</span><b class="display tnum">' + (done.length ? (avg / 1000).toFixed(1) + " t" : "–") + '</b><span class="xs muted">a year, ' + done.length + " with results</span></div>" +
        '<div class="stat-tile"><span class="eyebrow">Change</span><b class="display tnum ' + (change != null && change < 0 ? "green" : change > 0 ? "clay" : "") + '">' + (change == null ? "–" : (change < 0 ? "▼ " : "▲ ") + Math.abs(Math.round(change * 100)) + "%") + '</b><span class="xs muted">since members\' first surveys</span></div></div>' +
        (done.length
          ? '<ol class="board mt-4">' +
            done.map((r, i) => '<li class="' + (r.is_self ? "me" : "") + '"><span class="board-n display">' + (i + 1) + '</span><span class="board-name">' + esc(r.display_name) + (r.is_self ? " (you)" : "") + '</span><span class="board-bar"><span style="width:' + ((r.total_yearly / maxT) * 100).toFixed(1) + '%"></span></span><span class="board-t"><b class="display tnum">' + (r.total_yearly / 1000).toFixed(1) + '</b> <small class="muted">t / yr</small></span></li>').join("") +
            "</ol>"
          : '<p class="sm muted mt-3">No one has finished the survey yet.</p>') +
        (rows.length > done.length ? '<p class="xs muted mt-2">' + (rows.length - done.length) + " member" + (rows.length - done.length === 1 ? " hasn't" : "s haven't") + " finished the survey yet.</p>" : "") +
        '<div class="chip-row mt-4"><button type="button" class="btn btn-sm btn-outline" data-action="leave-group" data-id="' + g.id + '">Leave group</button>' +
        (g.is_owner ? '<button type="button" class="btn btn-sm btn-outline btn-danger" data-action="delete-group" data-id="' + g.id + '">Delete group</button>' : "") + "</div>";
    }
    return (
      '<section class="glass guide-card"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 class="display">Groups</h2><span class="muted">Teams, wards, classes, anyone</span></div>' +
      (friends.groupMsg ? '<p class="xs mt-2 ' + (friends.groupOk ? "green-dark" : "red") + '" role="status">' + esc(friends.groupMsg) + "</p>" : "") + body + "</section>"
    );
  }

  function groupFormsHtml() {
    if (!friends.groupsReady) return "";
    const invite = (location.hash.split("?")[1] || "").match(/(?:^|&)join=([A-Za-z0-9]{6})/);
    return (
      '<section class="glass cat-drop"><h2 class="display side-title">Start a group</h2><p class="sm muted mb-3">Give it a name, then share the code.</p>' +
      '<form id="group-create-form" class="stack-2"><input class="input" id="group-name" maxlength="60" minlength="2" required placeholder="e.g. Ward 7, Year 10 science" aria-label="Group name" /><button type="submit" class="btn btn-green btn-block">Create group</button></form></section>' +
      '<section class="glass cat-drop"><h2 class="display side-title">Join a group</h2>' + (invite ? '<p class="sm mb-3 green-dark fw-600">You\'ve been invited to a group. Press Join to accept.</p>' : '<p class="sm muted mb-3">Enter the 6-character code someone shared with you.</p>') +
      '<form id="group-join-form" class="stack-2"><input class="input tnum" id="group-code" maxlength="6" required placeholder="e.g. 5EBTF4" aria-label="Group code" autocapitalize="characters" spellcheck="false" value="' + (invite ? esc(invite[1].toUpperCase()) : "") + '" /><button type="submit" class="btn btn-outline btn-block">Join</button></form>' +
      '<p class="xs muted mt-2">Group members see your display name and yearly total.</p></section>'
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
      .filter((p) => p.surveys >= 2 && Number(p.first_total) > 0)
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

  function renderFriends() {
    if (!friends.loaded) {
      loadFriends();
      return spinner;
    }
    const incoming = friends.rows.filter((f) => f.status === "pending" && !f.iAsked);
    const outgoing = friends.rows.filter((f) => f.status === "pending" && f.iAsked);
    const accepted = friends.rows.filter((f) => f.status === "accepted");
    const btns = (f, list) =>
      '<span class="chip-row">' + list.map(([label, action, cls]) => '<button type="button" class="btn btn-sm ' + cls + '" data-action="' + action + '" data-id="' + f.id + '">' + label + "</button>").join("") + "</span>";
    const side = (title, body) => '<section class="glass cat-drop"><h2 class="display side-title">' + title + "</h2>" + body + "</section>";
    const nameOf = (b) => (b.is_self ? (friends.myName ? friends.myName + " (you)" : "You") : b.display_name);
    const rank = accepted.length ? rankInfo() : null;
    const meOnBoard = friends.board.find((b) => b.is_self);

    let html =
      '<div class="container friends-v2">' + (friends.error ? '<p class="sm red mb-4">' + esc(friends.error) + "</p>" : "") +
      '<header class="glass cat-hero rise"><span class="cat-watermark" aria-hidden="true">' + icon("user") + "</span>" +
      '<div class="cat-hero-main"><span class="eyebrow">Friends</span><h1 class="cat-title display">Compare with people you know</h1>' +
      "<p class=\"cat-why\">Friends only ever see each other's yearly totals, never your answers.</p></div>" +
      (rank
        ? '<div class="rank-side"><p class="display rank-big">You\'re ' + rank.label + '</p><p class="sm">' + rank.nudge + "</p>" +
          (rank.href ? '<a class="todo-guide" href="' + rank.href + '">See how ' + icon("arrowRight") + "</a>" : "") + "</div>"
        : "") +
      "</header>";

    // Leaderboard
    let board;
    if (!accepted.length) board = '<p class="sm muted mt-3">Add friends to compare your yearly footprints. Lowest footprint wins.</p>';
    else {
      const podium = friends.board.slice(0, 3);
      const maxT = Math.max(1, ...friends.board.map((b) => b.total_yearly));
      board =
        (podium.length >= 2
          ? '<div class="podium">' +
            [1, 0, 2]
              .filter((i) => podium[i])
              .map(
                (i) =>
                  '<div class="podium-spot place-' + (i + 1) + (podium[i].is_self ? " me" : "") + '"><span class="podium-name">' + esc(nameOf(podium[i])) + "</span>" +
                  '<span class="podium-total display">' + (podium[i].total_yearly / 1000).toFixed(1) + ' t</span><span class="podium-step"><b class="display">' + (i + 1) + "</b></span></div>"
              )
              .join("") +
            "</div>"
          : "") +
        '<ol class="board">' +
        friends.board
          .map(
            (b, i) =>
              '<li class="' + (b.is_self ? "me" : "") + '"><span class="board-n display">' + (i + 1) + '</span><span class="board-name">' + esc(nameOf(b)) + "</span>" +
              '<span class="board-bar"><span style="width:' + ((b.total_yearly / maxT) * 100).toFixed(1) + '%"></span></span>' +
              '<span class="board-t"><b class="display tnum">' + (b.total_yearly / 1000).toFixed(1) + '</b> <small class="muted">t / yr</small></span></li>'
          )
          .join("") +
        "</ol>" +
        (!meOnBoard ? '<p class="xs muted mt-3">Finish the survey to appear on the leaderboard.</p>' : "") +
        (accepted.length > friends.board.filter((b) => !b.is_self).length ? '<p class="xs muted mt-3">Friends who haven\'t finished the survey yet won\'t appear until they do.</p>' : "");
    }
    html +=
      '<div class="cat-grid"><div class="cat-col stack-5">' +
      '<section class="glass guide-card"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 class="display">Leaderboard</h2><span class="muted">Lowest footprint first</span></div>' + board + "</section>" +
      (accepted.length
        ? '<section class="glass guide-card"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 class="display">Most improved</h2><span class="muted">Since each person\'s first survey</span></div><div class="mt-4">' +
          mostImprovedHtml() + "</div></section>"
        : "") +
      groupsHtml() +
      '</div><aside class="cat-aside">' + groupFormsHtml() +
      side(
        "Add a friend",
        '<p class="sm muted mb-3">They need a CO2 Counter account. Usernames aren\'t case-sensitive.</p><form id="friend-form" class="stack-2"><input class="input" type="text" id="friend-email" placeholder="Their username or email" aria-label="Friend\'s username or email" required autocapitalize="none" spellcheck="false" /><button type="submit" class="btn btn-green btn-block">Send request</button></form>' +
          (friends.msg ? '<p class="xs mt-2 ' + (friends.msgOk ? "green-dark" : "red") + '">' + esc(friends.msg) + "</p>" : "")
      ) +
      (incoming.length ? side("Requests for you", '<div class="stack-2">' + incoming.map((f) => '<div class="friend-row"><span class="sm fw-600 truncate">' + esc(f.name) + "</span>" + btns(f, [["Accept", "friend-accept", "btn-green"], ["Decline", "friend-remove", "btn-outline"]]) + "</div>").join("") + "</div>") : "") +
      (outgoing.length ? side("Waiting for a reply", '<div class="stack-2">' + outgoing.map((f) => '<div class="friend-row"><span class="sm fw-600 truncate">' + esc(f.name) + "</span>" + btns(f, [["Cancel", "friend-remove", "btn-outline"]]) + "</div>").join("") + "</div>") : "") +
      (accepted.length
        ? side(
            "Your friends · " + accepted.length,
            '<div class="stack-2">' +
              accepted.map((f) => '<div class="friend-row"><span class="label-row min0"><span class="nav-avatar sm-av">' + esc(initials(f.name) || "?") + '</span><span class="sm fw-600 truncate">' + esc(f.name) + "</span></span>" + btns(f, [["Remove", "friend-remove", "btn-outline"]]) + "</div>").join("") +
              "</div>"
          )
        : "") +
      side(
        "Your name",
        '<p class="sm muted mb-3">This is what your friends see.</p><form id="name-form" class="stack-2"><input class="input" id="display-name" maxlength="40" placeholder="e.g. Sam" aria-label="Your display name" value="' +
          esc(friends.myName) + '" /><button type="submit" class="btn btn-outline btn-block">Save</button></form>'
      ) +
      "</aside></div></div>";
    return html;
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
            "<strong>Survey answers</strong>: your answers about food, travel, flights, home energy, water, pets, banking and pensions. If you don't have an account, these stay on your device only.",
            "<strong>Account details</strong>: your email address and a securely hashed password, if you create an account.",
            "<strong>Optional details</strong>: if you choose to, what best describes your work (for example, nurse or teacher), and whether you agree to share your answers for research.",
            "<strong>Groups</strong>: the groups you create or join on the Friends page. Other members of a group see your display name and yearly total, never your answers.",
            "<strong>Habits</strong>: the actions you tick yourself on the Habits page, so they're there on any device, and which of your 7 Acts we've verified.",
            "<strong>Invites</strong>: your invite code, and who joined CO2 Counter with it. You see how many of them have finished the survey, never who they are or their answers.",
            "<strong>Letters to your MP</strong>: if you email your MP from the Habits page, we're copied in (BCC) so we can verify it. We record only the date it arrived and delete the email, which will include your name and address.",
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
          "Who we share it with",
          "<p>Only the providers that run the service for us:</p>" +
            ul([
              "<strong>Supabase</strong>: sign-in and database (your account, saved answers and support status).",
              "<strong>Stripe</strong>: payments and subscriptions. Stripe handles your card details under its own privacy policy.",
              "<strong>GitHub Pages</strong>: hosting the website.",
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
        ["Children", "<p>CO2 Counter is intended for people aged 16 and over.</p>"],
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
          "<p>You're responsible for keeping your password safe and for what happens on your account. Please give a real email address so we can contact you about your account or membership. You can delete your account at any time from the Account page.</p>",
        ],
        [
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
          "<p>Please don't misuse the service: no attempts to break or overload it, access other people's data, or copy and resell its content. We may suspend accounts that do.</p>",
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
        '<div class="empty-card"><div class="emoji-xl mb-3">🌱</div><h2 class="fw-600 mb-1">No habits yet</h2>' +
        '<p class="sm muted mb-5 max-sm center-block">Explore your results and commit to habits that fit your life — they\'ll show up here.</p>' +
        '<a class="btn btn-green" href="#/results">See my results ' + icon("arrowRight") + "</a></div>";
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
        '<div class="empty-card"><div class="emoji-xl mb-3">📋</div><h2 class="fw-600 mb-1">Nothing to check in yet</h2>' +
        '<p class="sm muted mb-5 max-sm center-block">Commit to some habits from your results first — then come back here each day to build your streaks.</p>' +
        '<a class="btn btn-green" href="#/results">See my results ' + icon("arrowRight") + "</a></div></div>"
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
    const habitCount = CATEGORIES.reduce((sum, c) => sum + committedHabits(c).length, 0);
    const hist = historyByDay();
    const change = hist.length > 1 ? hist[0].totalYearly - hist[hist.length - 1].totalYearly : 0;
    if (!friends.loaded && !friends.loading) loadFriends();
    const friendCount = friends.rows.filter((f) => f.status === "accepted").length;
    const rank = friendCount ? rankInfo() : null;
    const name = ui.userName && ui.userName !== "App user" ? ui.userName : ui.username || "Your account";
    const m = membership || {};
    let plan;
    if (m.owner) plan = '<p class="fw-600">Owner account</p><p class="sm muted">Free, with full access.</p>';
    else if (FREE_MODE && !isSupporter()) plan = '<p class="fw-600">Free account</p><p class="sm muted">Everything on CO2 Counter is free. You can support it below if you\'d like to.</p>';
    else if (m.free && m.status !== "active") plan = '<p class="fw-600">Free access</p><p class="sm muted">You\'ve been given full access, free of charge.</p>';
    else {
      const until = m.until ? m.until.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
      plan =
        '<p class="fw-600">' + (FREE_MODE ? "Supporter · £2 a year" : "CO2 Counter membership · £2 a year") + '</p><p class="sm muted">' +
        (m.status === "active" && until ? "Renews on " + esc(until) + "." : until ? "Access until " + esc(until) + "." : "Active.") +
        "</p>" +
        (STRIPE_PORTAL_URL && !isNativeApp()
          ? '<a class="btn btn-outline btn-sm mt-3" href="' + esc(STRIPE_PORTAL_URL) + '" target="_blank" rel="noopener">Manage subscription</a>'
          : "");
    }

    const tile = (label, value, sub, cls) =>
      '<div class="stat-tile' + (cls ? " " + cls : "") + '"><span class="sm muted">' + label + '</span><span class="display tnum stat-tile-num">' + value + "</span>" + (sub ? '<span class="xs">' + sub + "</span>" : "") + "</div>";
    return (
      '<div class="container account-v2">' +
      '<header class="glass cat-hero rise"><span class="cat-watermark" aria-hidden="true">' + icon("user") + "</span>" +
      '<div class="account-id"><span class="account-av display">' + esc(initials(name) || "?") + "</span><div class=\"min0\">" +
      '<span class="eyebrow">Account</span><h1 class="cat-title display account-name">' + esc(name) + "</h1>" +
      '<p class="cat-why">' + (ui.username ? "@" + esc(ui.username) + " · " : "") + esc(currentUser.email) + "</p></div></div>" +
      '<button type="button" class="btn btn-outline" data-action="sign-out">' + icon("logOut") + " Sign out</button></header>" +
      '<div class="cat-grid"><div class="cat-col stack-5">' +
      '<section class="glass guide-card"><div class="row-between gap-3" style="flex-wrap:wrap;align-items:baseline"><h2 class="display">Your saved data</h2><span class="muted">' +
      (canSync() ? "Synced across your devices" : "Saved on this device") + '</span></div><div class="stat-tiles">' +
      tile("Footprint", '<span data-countup="' + Math.round(fp.totalYearly) + '">0</span>', "kg CO₂e a year") +
      tile("Surveys taken", Math.max(hist.length, survey.completedAt ? 1 : 0), hist.length > 1 && Math.abs(change) >= 1 ? '<b class="' + (change < 0 ? "green" : "clay") + '">' + (change < 0 ? "▼ " : "▲ ") + Math.round((Math.abs(change) / hist[hist.length - 1].totalYearly) * 100) + "% since your first</b>" : "") +
      tile("Friends", friendCount, rank ? "You're " + rank.label : "") +
      tile("Habits", habitCount, "tracking coming soon", "honey") +
      '</div><div class="chip-row mt-5"><a class="btn btn-green" href="#/">Retake survey</a><a class="btn btn-outline" href="#/results">View results</a><a class="btn btn-outline" href="#/friends">Friends</a></div></section>' +
      '<section class="glass guide-card"><span class="eyebrow">' + (FREE_MODE ? "Your plan" : "Membership") + "</span><div class=\"mt-2\">" + plan + "</div>" +
      (FREE_MODE && !m.owner && !isSupporter() && !isNativeApp() && STRIPE_PAYMENT_LINK
        ? '<div class="mt-4"><a class="btn btn-green" href="' + esc(supportUrl()) + '">' + icon("heart") + ' Support for £2 a year</a><p class="xs muted mt-2">Secure payment by Stripe. Cancel any time. No ads, and we never sell your data.</p></div>'
        : "") +
      "</section>" +
      aboutYouCard() +
      (ui.isAdmin
        ? '<section class="glass guide-card"><span class="eyebrow">Admin</span><h2 class="display mt-2">Inputs</h2><p class="sm muted">Change the figures every footprint is worked out with, with a source for each. Figures last updated ' +
          esc(shortDate(figuresUpdated())) + '.</p><div class="chip-row mt-4"><a class="btn btn-green" href="#/inputs">Open Inputs ' + icon("arrowRight") + '</a><a class="btn btn-outline" href="#/analytics">' + icon("chart") + " Analytics</a></div></section>"
        : "") +
      "</div>" +
      '<aside class="cat-aside"><section class="glass cat-drop"><h2 class="display side-title">Clear data on this device</h2><p class="sm muted">This can\'t be undone.</p>' +
      '<div class="chip-row mt-3"><button type="button" class="btn btn-outline btn-sm" data-action="clear-habits">Clear habits</button>' +
      '<button type="button" class="btn btn-outline btn-sm btn-danger" data-action="clear-all">Clear everything</button></div></section>' +
      deleteAccountCard() + "</aside></div></div>"
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
      '<section class="glass guide-card"><span class="eyebrow">About you · optional</span><h2 class="display mt-2">Help us understand who uses CO2 Counter</h2>' +
      '<form id="about-you-form" class="stack-3 mt-3"><label class="xs fw-700" for="about-role">What best describes your work?</label>' +
      '<select class="input q-select" id="about-role"><option value="">Prefer not to say</option>' + ROLES.map(([k, l]) => '<option value="' + k + '"' + (a.role === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select>" +
      '<p class="xs muted">Only used for anonymous totals, like the average footprint of nurses. Never shown to anyone with your name.</p>' +
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
      authNotes() +
      '<button type="submit" class="btn btn-green btn-block">' + (signup ? "Create account" : "Sign in") + "</button>" +
      (signup
        ? '<p class="xs muted center">By creating an account you agree to our <a class="link-btn" href="/terms/">Terms</a> and <a class="link-btn" href="/privacy/">Privacy policy</a>.</p>'
        : "") +
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
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: authRedirectUrl(), data: { username } } });
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
  async function ensureUsername() {
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
    render();
  }

  // ==================== login & paywall screens ====================

  function gateShell(title, subtitle, body) {
    return (
      '<div class="gate"><div class="gate-card fade-up"><div class="gate-brand"><span class="page-badge">' + icon("leaf") +
      '</span><span class="brand-name lg">CO2 Counter</span></div><h1 class="gate-title">' + esc(title) + "</h1>" +
      (subtitle ? '<p class="sm muted mb-5">' + esc(subtitle) + "</p>" : "") + body + "</div></div>"
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
  const PAGE_PATHS = { "/about/": "/about", "/greener-switches/": "/switches", "/how-we-calculate/": "/how-we-calculate", "/example/": "/example", "/privacy/": "/privacy", "/terms/": "/terms" };
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
    else if (currentUser && ui.needUsername && !["/privacy", "/terms", "/how-we-calculate", "/about", "/switches"].includes(path)) html = renderChooseUsername();
    else if (path === "/welcome") html = renderIntro();
    else if (path === "/example") html = renderExample();
    else if (path === "/") html = showIntroFirst() ? renderIntro() : renderSurvey();
    else if (path === "/how-we-calculate") html = renderMethod();
    else if (path === "/privacy") html = renderPrivacy();
    else if (path === "/terms") html = renderTerms();
    else if (path === "/about") html = renderAbout();
    else if (path === "/switches") html = renderSwitches();
    else if (path === "/analytics")
      html = ui.isAdmin ? renderAnalytics() : '<div class="container"><div class="empty-card"><h2 class="fw-600 mb-1">Admins only</h2><p class="sm muted">Sign in with an admin account to see the analytics.</p><a class="btn btn-green mt-4" href="#/account">Go to my account</a></div></div>';
    else if (path === "/inputs")
      html = ui.isAdmin ? renderInputs() : '<div class="container"><div class="empty-card"><h2 class="fw-600 mb-1">Admins only</h2><p class="sm muted">Sign in with an admin account to change the figures.</p><a class="btn btn-green mt-4" href="#/account">Go to my account</a></div></div>';
    else if (path === "/results") html = full ? renderResults() : renderResultsPreview();
    else if (parts[0] === "explainer" && parts[1]) html = full ? renderExplainer(parts[1]) : renderLocked();
    else if (parts[0] === "guide" && parts[1]) html = full ? renderGuide(parts[1]) : renderLocked();
    else if (path === "/check-in" || path === "/habits") html = renderHabitsPage();
    else if (path === "/friends") html = member ? renderFriends() : renderLocked();
    else if (path === "/account") html = member ? renderAccount() : renderLocked();
    else html = '<div class="container"><div class="empty-card"><h2 class="fw-600 mb-1">Page not found</h2><a class="btn btn-green mt-4" href="#/">Go to the survey</a></div></div>';
    setNav(parts[0] === "explainer" || parts[0] === "guide" || path === "/example" ? "/results" : path === "/welcome" || (path === "/" && html.includes("intro-v2")) ? "" : path);
    if (ui.flash && html !== spinner) {
      html =
        '<div class="flash" role="status">' + icon("check") + "<span>" + esc(ui.flash) + "</span>" +
        '<button type="button" class="icon-btn" data-action="dismiss-flash" aria-label="Dismiss">' + icon("x") + "</button></div>" + html;
    }
    // Re-rendering a form after an error shouldn't wipe the passwords
    // someone just typed.
    const kept = PASSWORD_IDS.map((id) => [id, document.getElementById(id)]).filter(([, el]) => el && el.value);
    app.innerHTML = glyphify(fillTokens(html));
    countUp();
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
  }

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
    if (currentPath() === "/friends") {
      friends.loaded = false;
      friends.msg = "";
    }
    ui.commuteOpen = null;
    ui.airport = null;
    if (currentPath() !== "/results") ui.selectedCategory = null;
    render();
    window.scrollTo(0, 0);
  }

  function setPath(obj, path, value) {
    const [a, b] = path.split(".");
    obj[a] = { ...(obj[a] || {}), [b]: value };
  }

  // ==================== events ====================

  const actions = {
    "goto-step": (el) => {
      ui.step = Number(el.dataset.step);
      ui.commuteOpen = null;
      ui.airport = null;
      render();
    },
    "prev-step": () => {
      ui.step = Math.max(0, ui.step - 1);
      ui.airport = null;
      render();
      window.scrollTo(0, 0);
    },
    "next-step": () => {
      ui.airport = null;
      ui.commuteOpen = null;
      if (ui.step < STEPS.length - 1) {
        ui.step++;
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
    "set-green": (el) => {
      survey.energy = { ...survey.energy, greenTariff: el.dataset.value === "1" };
      surveyChanged();
      render();
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
    "top-opportunity": () => {
      ui.selectedCategory = null;
      render();
    },
    "open-section": (el) => {
      const parts = currentPath().split("/").filter(Boolean);
      openSectionDialog(parts[1], Number(el.dataset.index));
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
    "share-app": async () => {
      const text = shareText();
      try {
        if (navigator.share) await navigator.share({ title: "CO2 Counter", text, url: inviteLink() });
        else { await navigator.clipboard.writeText(text + " " + inviteLink()); ui.shareMsg = "Copied. Paste it into a message or post."; render(); }
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
    "friend-accept": async (el) => {
      await sb.from("friendships").update({ status: "accepted" }).eq("id", el.dataset.id);
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
      ui.flash = "New survey cancelled. Your previous answers are unchanged.";
      render();
      window.scrollTo(0, 0);
    },
    "dismiss-celebrate": () => {
      ui.celebrate = null;
      render();
    },
    "edit-survey": () => {
      ui.editBase = JSON.parse(JSON.stringify(survey));
      ui.editing = true;
      ui.step = 0;
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
      render();
    },
  };

  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[data-link]");
    if (link) recordLinkClick(link);
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (modalRoot.innerHTML) closeModal();
      else if (ui.airport) {
        ui.airport = null;
        render();
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
      }
      if (t.dataset.rerender) render();
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
      const code = document.getElementById("group-code").value;
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
      const role = document.getElementById("about-role").value || null;
      const research = document.getElementById("about-research").checked;
      const patch = { role, research_opt_in: research };
      if (research && !ui.aboutYou.research_opt_in) patch.research_opted_at = new Date().toISOString();
      const { error } = await sb.from("profiles").update(patch).eq("id", currentUser.id);
      ui.aboutMsg = error ? { ok: false, text: "Couldn't save. Please try again." } : { ok: true, text: "Saved." };
      if (!error) ui.aboutYou = { ...ui.aboutYou, role, research_opt_in: research };
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

  window.addEventListener("hashchange", onRouteChange);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentPath() === "/results") render();
    }, 200);
  });

  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });

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
    render();
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
    if (currentUser) {
      await ensureUsername();
      ui.userName = await displayName(currentUser);
      await checkMembership();
      checkAdmin().then(() => ui.isAdmin && render());
      claimReferral();
    }
    // The latest figures from the Inputs page (the cached ones are already in use).
    loadInputs().then((changed) => changed && render());
    // Members get their saved answers; everyone else uses this device's.
    survey = await loadSurvey();
    await loadHistory();
    render();
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
