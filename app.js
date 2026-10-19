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
  const LEGAL_UPDATED = "19 October 2026";

  const D = window.ECO_DATA;
  const DAYS = D.DAYS;
  const CATEGORIES = Object.keys(D.EXPLAINERS);

  const KEY_SURVEY = "ecoimpact_survey";
  const KEY_SNAPSHOTS = "ecoimpact_monthly_snapshots";
  // Completed surveys on this device (guests, and a fallback when offline).
  const KEY_HISTORY = "co2_survey_history";
  // Set while someone who came from a reset link still has to choose a new
  // password, so a reload doesn't skip that step. Per tab only.
  const KEY_RECOVERY = "co2_password_recovery";
  const KEY_HABITS = "ecoimpact_habits_"; // + category
  const KEY_STAGE = "ecoimpact_stage_"; // + category
  const KEY_GOALS = "ecoimpact_goals";
  const KEY_STREAKS = "ecoimpact_goal_streaks";

  const SHORT_HAUL_KM = 1500;
  // Savings assumptions (see tipFor).
  const ACTIVE_TRAVEL_MAX_KM = 10; // one-way; beyond this, train/bus is the realistic swap
  const MOTOR_MODES = ["car_petrol", "car_diesel", "ev", "motorcycle"];
  const TRAIN_TO_FLIGHT_RATIO = 4 / 123; // Eurostar vs flight, London–Paris
  const HEAT_PUMP_COP = 3;
  const MEDIUM_HAUL_KM = 4000;
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

  const ICONS = {
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
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
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
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
      const { data } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
      if (data && data.display_name) return data.display_name;
    } catch (e) {}
    return "App user";
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
    return local;
  }

  async function saveSurveyRemote(s) {
    if (!currentUser || !sb) return;
    const row = { user_id: currentUser.id, survey_data: s, updated_at: new Date().toISOString() };
    try {
      // total_yearly lets friends see your total (friends_footprints()).
      // If the database doesn't have that column yet, save without it.
      const { error } = await sb.from("survey_responses").upsert({ ...row, total_yearly: Math.round(footprint(s).totalYearly) });
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
    return D.AIRPORTS.find((a) => a.code === code);
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
      if (km < SHORT_HAUL_KM) shortHaul += legs(f);
      else if (km < MEDIUM_HAUL_KM) mediumHaul += legs(f);
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
    const otherYearly = extraTravelYearly(s) + longTripsYearly(s);
    items.push({
      key: "commute",
      label: "Commute & Travel",
      icon: "🚗",
      yearly: commuteWeekly * D.WEEKS_PER_YEAR + otherYearly,
      detail: "~" + commuteWeekly.toFixed(1) + " kg CO₂e per week commuting" + (otherYearly > 0 ? " · " + Math.round(otherYearly) + " kg other travel" : ""),
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
  function dietType(s) {
    const meals = DAYS.map((d) => s.meals && s.meals[d]).filter(Boolean);
    if (meals.length === 0) return "other_meat";
    const count = (keys) => meals.filter((m) => keys.includes(m)).length;
    const red = count(["beef", "lamb", "pork"]);
    const chicken = count(["chicken"]);
    const fish = count(["fish"]);
    const veggie = count(["veggie"]);
    if (count(["vegan"]) === meals.length) return "vegan";
    if (red === 0 && fish === 0 && veggie > 0) return "veggie";
    if (red === 0 && chicken === 0 && fish > 0) return "pescatarian";
    if (red > 2) return "red_meat_high";
    if (red >= 1) return "red_meat_low";
    return "other_meat";
  }

  function mealsTip(s) {
    const meals = DAYS.map((d) => s.meals && s.meals[d]).filter(Boolean);
    const count = (keys) => meals.filter((m) => keys.includes(m)).length;
    const chicken = count(["chicken"]);
    const fish = count(["fish"]);
    const veggie = count(["veggie"]);
    const veganKg = 1.38;
    const veggieKg = 2.45;
    const chickenKg = D.MEAT_PER_KG.chicken * D.PORTION;
    const fishKg = D.MEAT_PER_KG.fish * D.PORTION;
    const W = D.WEEKS_PER_YEAR;
    switch (dietType(s)) {
      case "red_meat_high":
        return {
          title: "Cut back on red meat (>2×/week)",
          body: "Beef and lamb are the most carbon-intensive foods by far — a single beef portion emits over 8× more than chicken and ~17× more than a vegan day. With red meat on more than two days a week, this is your biggest food lever. Drop to 1–2 red-meat days and swap the rest for chicken, fish or plant-based meals to cut well over 1,800 kg CO₂e a year.",
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
    const beef = D.MEAT_PER_KG.beef * D.PORTION;
    const lamb = D.MEAT_PER_KG.lamb * D.PORTION;
    const chicken = D.MEAT_PER_KG.chicken * D.PORTION;
    return (
      DAYS.reduce((sum, d) => {
        const m = s.meals && s.meals[d];
        if (m === "beef") return sum + (beef - chicken);
        if (m === "lamb") return sum + (lamb - chicken);
        return sum;
      }, 0) * D.WEEKS_PER_YEAR
    );
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
        const long = distance > ACTIVE_TRAVEL_MAX_KM;
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
            ? "Driving is one of the largest personal emission sources. For a commute of more than 10 km, taking the train or bus instead of the car on your driving days cuts most of it — and working from home or cycling some days takes it to zero."
            : "Driving is one of the largest personal emission sources. For a commute of 10 km or less, walking or cycling instead of driving removes those emissions completely — an e-bike makes longer or hillier trips easy.",
          saving,
          maxSaving: categoryYearly("commute", s),
          realisticLabel: (long ? "train or bus on driving days" : "walking or cycling on driving days") + (tripSaving > 0 ? ", and the train for long journeys you drive" : ""),
          maxLabel: "no travel emissions, by working from home, walking and cycling, and holidaying closer to home",
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
        const long = flights.filter((f) => flightKm(f.from, f.to) > MEDIUM_HAUL_KM);
        const short = flights.filter((f) => {
          const km = flightKm(f.from, f.to);
          return km > 0 && km <= MEDIUM_HAUL_KM;
        });
        const typicalShortKg =
          short.length ? avg(short, economyKg) : flightKm("LHR", "BCN") * flightFactor("LHR", "BCN", "economy") * (long.length === 1 ? legs(long[0]) : 1);
        let remaining = 0;
        const parts = [];
        if (long.length > 1) {
          remaining += avg(long, economyKg);
          parts.push("one long-haul trip in economy");
        } else if (long.length === 1) {
          remaining += typicalShortKg;
          parts.push("a short-haul trip in economy instead of long-haul");
        }
        if (short.length >= 3) {
          remaining += avg(short, economyKg) + (short.length - 1) * avg(short, economyKg) * TRAIN_TO_FLIGHT_RATIO;
          parts.push("one short-haul trip in economy, the rest by train");
        } else if (short.length > 0) {
          remaining += short.length * avg(short, economyKg) * TRAIN_TO_FLIGHT_RATIO;
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
          const after = (12 * ((e.electricityKwh || 0) + (e.gasKwh || 0) / HEAT_PUMP_COP) * D.GREEN_ELECTRICITY_FACTOR) / householdOf(s);
          return Math.max(0, categoryYearly("energy", s) - after);
        })(),
        title: "Switch to a green energy tariff",
        body: "Grid electricity emits ~0.23 kg CO₂e per kWh. A green/renewable tariff can cut that by over 80%, instantly lowering one of your biggest contributors.",
        saving:
          s.energy && s.energy.greenTariff
            ? 0
            : (12 * ((s.energy && s.energy.electricityKwh) || 0) * (D.ELECTRICITY_FACTOR - D.GREEN_ELECTRICITY_FACTOR)) /
              householdOf(s),
      }),
      water: () => ({
        title: "Reduce your water usage",
        body: "Heating and treating water uses energy. Shorter showers, fixing leaks, and water-efficient fixtures can cut your water footprint meaningfully over a year.",
        saving: (12 * (((s.water && s.water.liters) || 0) / 1000) * D.WATER_FACTOR * 0.2) / householdOf(s),
        maxSaving: (12 * (((s.water && s.water.liters) || 0) / 1000) * D.WATER_FACTOR * 0.4) / householdOf(s),
        realisticLabel: "using a fifth less water",
        maxLabel: "using 40% less, with efficient fittings and short showers",
      }),
      pets: () => {
        const p = s.pets || {};
        return {
          title: "Consider your pets' diet",
          body: "A medium dog's food can emit as much as a small car over a year. Choosing lower-meat or sustainable pet food brands can reduce their footprint without compromising nutrition.",
          saving:
            (((p.dogs || 0) * D.DOG_YEARLY + (p.cats || 0) * D.CAT_YEARLY) * 0.25) / householdOf(s),
          maxSaving:
            (((p.dogs || 0) * D.DOG_YEARLY + (p.cats || 0) * D.CAT_YEARLY) * 0.5) / householdOf(s),
          realisticLabel: "lower-impact pet food",
          maxLabel: "by-product or alternative-protein pet food",
        };
      },
      banking: () => {
        const b = s.banking || {};
        const bank = byKey(D.BANKS, b.bank);
        const greenest = D.BANKS[0].factor;
        const bankSaving = !bank || bank.factor <= greenest ? 0 : (b.amount || 0) * (bank.factor - greenest);
        const pension = pensionProvider(b);
        const pensionSaving = Math.max(0, pensionKg(b.pensionPot, pension.tPerMillion - D.GREEN_PENSION_T_PER_MILLION));
        const bankBody =
          "Traditional banks finance fossil fuel projects with your deposits. Moving your savings to a bank that doesn't fund fossil fuels (e.g. Triodos, Co-op) can reduce your financed emissions by up to 85%.";
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
          title: "Move your money to a greener bank",
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

  function equivalents(kg) {
    if (kg <= 0) return { trees: 0, phones: 0, drivingKm: 0 };
    return {
      trees: Math.round(kg / 20),
      phones: Math.round(kg / 61),
      drivingKm: Math.round(kg / 0.17625),
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
    document.querySelectorAll("#nav a").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("data-route") === path);
    });
  }

  // ==================== state ====================

  let survey = null;
  const ui = {
    step: 0,
    commuteOpen: null, // day whose mode picker is open
    airport: null, // { index, field } of the open airport picker
    airportQuery: "",
    selectedCategory: null, // Results page bar/tip selection
    authMode: "signin",
    authEmail: "",
    authMsg: "",
    authErr: "",
    userName: "",
    recovery: false,
    authSentTo: "", // email a confirmation link was just sent to
    flash: "", // one-off message shown at the top of the next page
    pendingVerify: null, // { tokenHash, type } from an email link, until tapped
    authUsername: "",
    needUsername: false, // signed in, but the account has no username yet
    newSurvey: false, // taking a new survey; the finished one is kept until it's done
    draft: null,
    prevSurvey: null,
    history: [], // completed surveys, newest first: { completedAt, totalYearly }
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
    const date = isNaN(when) ? "" : " on " + new Date(when).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    return (
      '<div class="container narrow">' + pageHeader("Carbon Footprint Survey") +
      '<div class="card center fade-up"><div class="round-badge center-block mb-4">' + icon("check") + "</div>" +
      '<h2 class="card-title mb-2">You\'ve already completed your survey</h2>' +
      '<p class="sm muted max-sm center-block mb-5">You finished it' + date + ". Would you like to take a new survey? " +
      "Your current results are kept in your history, and you can cancel before you finish. To change just a few answers, use <strong>Edit my answers</strong> at the bottom of your results.</p>" +
      '<div class="chip-row" style="justify-content:center">' +
      '<button type="button" class="btn btn-green" data-action="new-survey">' + icon("refresh") + " Take a new survey</button>" +
      '<a class="btn btn-outline" href="#/results">View my results ' + icon("arrowRight") + "</a></div></div></div>"
    );
  }

  function renderSurvey() {
    if (survey.completedAt && !ui.editing) return renderSurveyDone();
    const step = STEPS[ui.step];
    const pct = ((ui.step + 1) / STEPS.length) * 100;
    const chips = STEPS.map((s, i) => {
      const cls = i === ui.step ? "current" : i < ui.step ? "done" : "";
      return (
        '<button type="button" class="step-chip ' + cls + '" data-action="goto-step" data-step="' + i + '">' +
        "<span>" + s.icon + '</span><span class="hide-sm">' + esc(s.title) + "</span></button>"
      );
    }).join("");
    const last = ui.step === STEPS.length - 1;
    const newBanner = ui.newSurvey
      ? '<div class="panel p-4 mb-6 row-between gap-3" style="flex-wrap:wrap"><p class="sm">You\'re taking a new survey. Your previous results stay saved until you finish, and are kept in your history.</p>' +
        '<button type="button" class="btn btn-outline btn-sm" data-action="cancel-new-survey">' + icon("x") + " Cancel new survey</button></div>"
      : "";
    return (
      '<div class="container">' +
      pageHeader("Carbon Footprint Survey", "Step " + (ui.step + 1) + " of " + STEPS.length) + newBanner +
      '<div class="mb-8"><div class="progress thin"><div style="width:' + pct + '%"></div></div>' +
      '<div class="step-chips">' + chips + "</div></div>" +
      '<div class="survey-card">' +
      '<div class="mb-6"><h2 class="step-title">' + esc(step.title) + '</h2><p class="muted sm">' + esc(step.subtitle) + "</p></div>" +
      '<div class="step-body fade-in">' + step.render() + "</div>" +
      '<div class="step-nav">' +
      '<button type="button" class="btn btn-ghost" data-action="prev-step"' + (ui.step === 0 ? " disabled" : "") + ">" +
      icon("chevronLeft") + " Back</button>" +
      '<button type="button" class="btn btn-green" data-action="next-step">' +
      (last ? (ui.editing ? "Save and see results" : "See my results") : "Continue") + " " + icon("chevronRight") + "</button>" +
      "</div></div></div>"
    );
  }

  function optionCard(selected, attrs, inner, extraCls) {
    return (
      '<button type="button" class="option-card ' + (extraCls || "") + (selected ? " selected" : "") + '" ' + attrs + ">" + inner + "</button>"
    );
  }

  function renderMealsStep() {
    const m = survey.meals;
    const diet = m.diet || "";
    let html = '<p class="muted sm mb-6">First, what\'s your overall diet?</p><div class="grid-2-4 mb-8">';
    html += D.DIETS.map((d) =>
      optionCard(
        diet === d.key,
        'data-action="set-diet" data-key="' + d.key + '"',
        '<span class="emoji-lg">' + d.emoji + '</span><span class="fw-500 sm">' + esc(d.label) + '</span><span class="muted xs">' + esc(d.desc) + "</span>"
      )
    ).join("");
    html += "</div>";

    if (diet === "meat_eater") {
      html += '<div class="divider-label"><span></span><em>Pick each day\'s main meal</em><span></span></div><div class="day-grid">';
      html += DAYS.map((day) => {
        const chosen = byKey(D.MEAL_OPTIONS, m[day]);
        return (
          '<div class="panel p-4"><div class="row-between mb-3"><span class="fw-500">' + day + "</span>" +
          (chosen ? '<span class="pill">' + chosen.factor + " kg</span>" : "") +
          '</div><div class="meal-grid">' +
          D.MEAL_OPTIONS.map(
            (o) =>
              '<button type="button" title="' + esc(o.label) + '" class="meal-btn' + (m[day] === o.key ? " selected" : "") +
              '" data-action="set-meal" data-day="' + day + '" data-key="' + o.key + '"><span class="emoji-md">' + o.emoji +
              '</span><span class="tiny">' + esc(o.label) + "</span></button>"
          ).join("") +
          "</div></div>"
        );
      }).join("");
      html += "</div>";
    } else if (diet) {
      const d = byKey(D.DIETS, diet);
      html +=
        '<div class="note-green">✅ We\'ll estimate your week based on a ' + esc(d.label.toLowerCase()) +
        ' diet. Switch to <span class="fw-500">Meat eater</span> to customise day by day.</div>';
    }

    if (diet) {
      html +=
        '<div class="mt-8 mb-2"><p class="sm fw-500 mb-1">How often do you eat out or get a takeaway?</p>' +
        '<p class="muted xs mb-4">Restaurant meals have a higher footprint (bigger portions, more waste). We apply a 1.78× multiplier to each eating-out day.</p></div>' +
        '<div class="chip-row mb-8">' +
        D.EAT_OUT_OPTIONS.map(
          (o) =>
            '<button type="button" class="choice-chip' + ((m.eatOut || 0) === o.value ? " selected" : "") +
            '" data-action="set-eatout" data-value="' + o.value + '">' + esc(o.label) + "</button>"
        ).join("") +
        "</div>" +
        '<div class="mb-2"><p class="sm fw-500 mb-1">How much food do you waste?</p>' +
        '<p class="muted xs mb-4">Wasted food means wasted emissions. Pick the level that best matches your household.</p></div>' +
        '<div class="grid-2-4">' +
        D.FOOD_WASTE.map((o) =>
          optionCard(
            (m.foodWaste || "low") === o.key,
            'data-action="set-waste" data-key="' + o.key + '"',
            '<span class="emoji-md2">' + o.emoji + '</span><span class="fw-500 sm">' + esc(o.label) + '</span><span class="tiny muted">×' + o.multiplier + " footprint</span>",
            "compact"
          )
        ).join("") +
        "</div>";
    }
    return html;
  }

  function renderCommuteStep() {
    const c = survey.commute;
    const distance = c.distance == null ? 10 : c.distance;
    let html =
      '<p class="muted sm mb-6">Tap each day to log how you commuted — your week, at a glance.</p>' +
      '<div class="panel p-4 mb-6"><label class="sm fw-500" for="commute-distance">Average one-way distance (km)</label>' +
      '<input id="commute-distance" class="input mt-2 w-160" type="number" min="0" value="' + esc(distance) + '" data-field="commute.distance" data-rerender="1" /></div>' +
      '<div class="timeline">';
    html += DAYS.map((day) => {
      const mode = byKey(D.COMMUTE_MODES, c[day]);
      const open = ui.commuteOpen === day;
      let row =
        '<div class="timeline-row"><span class="timeline-dot"></span>' +
        '<button type="button" class="day-row" data-action="toggle-commute" data-day="' + day + '">' +
        '<span class="day-label">' + day + '</span><span class="emoji-row">' + (mode ? mode.emoji : "➕") + "</span>" +
        '<span class="grow"><span class="sm fw-500 block truncate">' + (mode ? esc(mode.label) : "Tap to choose") + "</span>" +
        (mode && distance > 0 ? '<span class="xs muted block">' + (mode.factor * distance * 2).toFixed(2) + " kg CO₂e / day (there and back)</span>" : "") +
        '</span><span class="xs muted">change</span></button></div>';
      if (open) {
        row +=
          '<div class="popover-inline"><p class="xs muted mb-2">How did you commute on ' + day + '?</p><div class="grid-2 gap-sm">' +
          D.COMMUTE_MODES.map(
            (o) =>
              '<button type="button" class="mode-btn' + (c[day] === o.key ? " selected" : "") + '" data-action="set-commute" data-day="' + day +
              '" data-key="' + o.key + '"><span class="emoji-md">' + o.emoji + '</span><span class="xs">' + esc(o.label) + "</span></button>"
          ).join("") +
          "</div></div>";
      }
      return row;
    }).join("");
    return html + "</div>" + renderExtraTravel() + renderLongTrips();
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
      '<div class="panel p-5 mt-8"><h3 class="sm fw-600">Other travel each week</h3>' +
      '<p class="xs muted mt-1 mb-4">Regular trips outside your commute, like the school run, the weekly shop or visiting family. Add a rough total distance for the week.</p>' +
      '<div class="stack-3">' + rows + "</div>" +
      '<button type="button" class="btn btn-outline btn-sm mt-3" data-action="add-travel" data-kind="extra">' + icon("plus") + " Add weekly travel</button></div>"
    );
  }

  function renderLongTrips() {
    const rows = survey.longTrips
      .map((x, i) => {
        const kg = longTripKg(x);
        return (
          '<div class="panel p-4"><div class="travel-row">' +
          '<div class="grow minw-160"><label class="xs">Journey</label><input class="input mt-1" type="text" maxlength="60" placeholder="e.g. Train to Devon" value="' + esc(x.label || "") +
          '" data-travel="long" data-index="' + i + '" data-key="label" /></div>' +
          '<div class="grow minw-160"><label class="xs">How</label>' + travelModeSelect("long", i, x.mode) + "</div>" +
          '<div class="w-150"><label class="xs">km one way</label><input class="input mt-1" type="number" min="0" value="' + esc(x.km || 0) +
          '" data-travel="long" data-index="' + i + '" data-key="km" /></div>' +
          '<button type="button" class="icon-btn danger-hover" data-action="remove-travel" data-kind="long" data-index="' + i + '" aria-label="Remove">' + icon("trash") + "</button></div>" +
          '<div class="row-between mt-3"><label class="check-label"><input type="checkbox"' + (x.returnTrip ? " checked" : "") +
          ' data-travel="long" data-index="' + i + '" data-key="returnTrip" /> Return trip</label>' +
          '<span class="sm fw-500">' + (kg > 0 ? Math.round(kg) + " kg CO₂e" : "") + "</span></div></div>"
        );
      })
      .join("");
    return (
      '<div class="panel p-5 mt-4"><h3 class="sm fw-600">Long journeys each year</h3>' +
      '<p class="xs muted mt-1 mb-4">Trips by land, like a train to Devon or Spain, or a drive to Scotland. Flights go in the next step. ' +
      "Rough distances from London: Devon ~300 km, Manchester ~300 km, Edinburgh ~650 km, Paris ~460 km, Barcelona ~1,500 km.</p>" +
      '<div class="stack-3">' + rows + "</div>" +
      '<button type="button" class="btn btn-outline btn-sm mt-3" data-action="add-travel" data-kind="long">' + icon("plus") + " Add a journey</button></div>"
    );
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
    const list = D.AIRPORTS.filter((a) => !q || (a.city + " " + a.code + " " + a.country).toLowerCase().includes(q));
    if (!list.length) return '<p class="picker-empty">No airport found.</p>';
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
    let html =
      '<p class="muted sm mb-6">This is your standing <span class="fw-500 fg">flight checklist</span> — add trips as you book them and they stay saved, so you only enter each one once. Pick a start and end airport and when you flew; we\'ll work out the distance. Tick <span class="fw-500 fg">Return trip</span> for there-and-back journeys.</p>' +
      '<div class="stack-3 max-2xl">';
    if (!flights.length) {
      html +=
        '<div class="empty-box">' + icon("plane", "muted big") +
        '<p class="muted sm">No flights added yet. Great if you don\'t fly — or tap below to add one.</p></div>';
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
          '<button type="button" class="icon-btn danger-hover" data-action="remove-flight" data-index="' + i + '" aria-label="Remove flight">' + icon("trash") + "</button>" +
          "</div></div>"
        );
      })
      .join("");
    return html + '</div><button type="button" class="btn btn-outline mt-4" data-action="add-flight">' + icon("plus") + " Add a flight</button>";
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
    return (
      '<p class="muted sm mb-6">Enter your monthly home energy and water usage. Both are split across your household.</p>' +
      '<div class="grid-2 gap-4 max-xl">' +
      numberCard("Electricity (kWh / month)", "energy.electricityKwh", e.electricityKwh == null ? 0 : e.electricityKwh, "Typical household: 200–400 kWh") +
      numberCard("Gas (kWh / month)", "energy.gasKwh", e.gasKwh == null ? 0 : e.gasKwh, "Typical household: 500–1200 kWh") +
      "</div>" +
      '<div class="panel p-5 mt-4 max-xl row-between"><div><label class="sm fw-500">Green / renewable electricity tariff</label>' +
      '<p class="xs muted mt-1">Cuts electricity emissions by up to 80%.</p></div>' +
      '<button type="button" role="switch" aria-checked="' + !!e.greenTariff + '" class="switch' + (e.greenTariff ? " on" : "") +
      '" data-action="toggle-green"><span></span></button></div>' +
      '<div class="mt-4 max-xl">' + numberCard("Water (litres / month)", "water.liters", w.liters == null ? 0 : w.liters, "A typical person uses ~3,000–5,000 L per month.") + "</div>" +
      '<div class="mt-4 max-xl">' +
      numberCard("People in your home", "energy.household", e.household == null ? 2 : e.household, "Energy, water and pet footprints are split across your household.", 1, "w-120") +
      "</div>"
    );
  }

  function renderPetsStep() {
    const p = survey.pets;
    return (
      '<p class="muted sm mb-6">How many pets do you have? Their diet adds to your footprint.</p>' +
      '<div class="grid-2 gap-4 max-xl">' +
      numberCard("🐕 Dogs", "pets.dogs", p.dogs == null ? 0 : p.dogs, "~770 kg CO₂e / year each") +
      numberCard("🐈 Cats", "pets.cats", p.cats == null ? 0 : p.cats, "~310 kg CO₂e / year each") +
      "</div>"
    );
  }

  function renderBankingStep() {
    const b = survey.banking;
    const pension = byKey(D.PENSION_PROVIDERS, b.pensionProvider);
    return (
      '<p class="muted sm mb-6">Your bank and pension invest your money in projects and companies — this matters more than people think.</p>' +
      '<div class="grid-2 gap-4 max-xl">' +
      numberCard("Total savings / deposits (£)", "banking.amount", b.amount == null ? 0 : b.amount) +
      '<div class="panel p-5"><label class="sm fw-500">Your bank</label><select class="input mt-2" data-field="banking.bank" data-type="text">' +
      '<option value=""' + (b.bank ? "" : " selected") + " disabled>Select your bank</option>" +
      D.BANKS.map((x) => '<option value="' + x.key + '"' + (x.key === b.bank ? " selected" : "") + ">" + (x.green ? "🌱 " : "") + esc(x.label) + "</option>").join("") +
      "</select></div></div>" +
      '<p class="sm fw-500 mt-8 mb-1">Your pension</p><p class="xs muted mb-4">Add up your workplace and personal pension pots. Leave it at 0 if you don\'t have one.</p>' +
      '<div class="grid-2 gap-4 max-xl">' +
      numberCard("Pension pot (£)", "banking.pensionPot", b.pensionPot == null ? 0 : b.pensionPot) +
      '<div class="panel p-5"><label class="sm fw-500">Pension provider</label><select class="input mt-2" data-field="banking.pensionProvider" data-type="text" data-rerender="1">' +
      '<option value=""' + (b.pensionProvider ? "" : " selected") + " disabled>Select your provider</option>" +
      D.PENSION_PROVIDERS.map((x) => '<option value="' + x.key + '"' + (x.key === b.pensionProvider ? " selected" : "") + ">" + esc(x.label) + "</option>").join("") +
      "</select>" +
      (pension ? '<p class="xs muted mt-2">' + pension.tPerMillion + " t CO₂e per £1m invested · " + esc(pension.source) + "</p>" : "") +
      "</div></div>"
    );
  }

  // ==================== Results page ====================

  const BAR_COLORS = ["#2f6b4f", "#4a95a5", "#dca23a", "#8a73c9", "#d2728c", "#b5895a", "#7b8a83"];

  // The typical UK resident's yearly kg per category (the same profile as
  // the UK comparison), for the dashed markers on the chart.
  function ukAverageByKey() {
    const out = {};
    footprint(D.UK_TYPICAL_SURVEY).breakdown.forEach((b) => {
      if (D.UK_COMPARISON_KEYS.includes(b.key)) out[b.key] = b.yearly;
    });
    return out;
  }

  function barChart(breakdown, selectedKey) {
    const uk = ukAverageByKey();
    // Sized to the screen so labels stay readable on phones.
    const W = Math.round(Math.max(300, Math.min(900, window.innerWidth - 64)));
    const H = 280;
    const left = 40;
    const bottom = 70;
    const top = 10;
    const max = Math.max(1, ...breakdown.map((b) => Math.max(b.yearly, uk[b.key] || 0)));
    const niceMax = niceCeil(max);
    const plotH = H - top - bottom;
    const slot = (W - left - 10) / breakdown.length;
    const barW = slot * 0.7;
    let svg = '<svg class="bar-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Yearly emissions by category">';
    for (let i = 0; i <= 4; i++) {
      const v = (niceMax / 4) * i;
      const y = top + plotH - (v / niceMax) * plotH;
      svg += '<text x="' + (left - 6) + '" y="' + (y + 4) + '" class="axis" text-anchor="end">' + Math.round(v) + "</text>";
      svg += '<line x1="' + left + '" x2="' + W + '" y1="' + y + '" y2="' + y + '" class="grid-line" />';
    }
    breakdown.forEach((b, i) => {
      const h = Math.max(0, (b.yearly / niceMax) * plotH);
      const x = left + i * slot + (slot - barW) / 2;
      const y = top + plotH - h;
      const op = selectedKey === b.key ? 1 : 0.45;
      svg +=
        '<g class="bar" data-action="select-category" data-key="' + b.key + '"><title>' + esc(b.label) + ": " + b.yearly.toFixed(0) +
        " kg CO₂e / year" + (uk[b.key] != null ? " (UK average " + uk[b.key].toFixed(0) + " kg)" : "") +
        '</title><rect x="' + (left + i * slot) + '" y="' + top + '" width="' + slot + '" height="' + plotH + '" fill="transparent" />' +
        '<path d="' + roundedTop(x, y, barW, h, 8) + '" fill="' + BAR_COLORS[i % BAR_COLORS.length] + '" opacity="' + op + '" />' +
        (uk[b.key] != null
          ? '<line class="uk-mark" x1="' + (x - 4) + '" x2="' + (x + barW + 4) + '" y1="' + (top + plotH - (uk[b.key] / niceMax) * plotH) +
            '" y2="' + (top + plotH - (uk[b.key] / niceMax) * plotH) + '" />'
          : "") +
        "</g>";
      const lx = x + barW / 2;
      const ly = top + plotH + 12;
      svg += '<text x="' + lx + '" y="' + ly + '" class="axis small" text-anchor="end" transform="rotate(-40 ' + lx + " " + ly + ')">' + esc(b.label) + "</text>";
    });
    return svg + "</svg>";
  }

  function niceCeil(v) {
    const step = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (m * step >= v) return m * step;
    }
    return 10 * step;
  }

  function roundedTop(x, y, w, h, r) {
    if (h <= 0) return "";
    r = Math.min(r, h, w / 2);
    return (
      "M" + x + "," + (y + h) + " V" + (y + r) + " Q" + x + "," + y + " " + (x + r) + "," + y +
      " H" + (x + w - r) + " Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + " V" + (y + h) + " Z"
    );
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
      '<p class="xs muted mt-3">Secure payment by Stripe. Optional: everything stays free either way. <a class="link-btn" href="#/terms">Terms</a></p></div>'
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

  function renderResults() {
    const fp = footprint(survey);
    const savings = fp.breakdown.map((b) => {
      const t = tipFor(b.key, survey);
      return { key: b.key, saving: t.saving, max: t.maxSaving };
    });
    const totalSaving = savings.reduce((sum, s) => sum + s.saving, 0);
    const totalMax = savings.reduce((sum, s) => sum + s.max, 0);
    const after = Math.max(0, fp.totalYearly - totalSaving);
    const afterMax = Math.max(0, fp.totalYearly - totalMax);
    const pct = (v) => (fp.totalYearly ? Math.round((v / fp.totalYearly) * 100) : 0);
    const savingFor = (key) => savings.find((s) => s.key === key) || { saving: 0, max: 0 };
    const cmp = ukComparison(fp);
    const budgetPct = Math.round((fp.totalYearly / D.BUDGET_YEARLY) * 100);
    const selected = ui.selectedCategory || fp.biggest.key;
    const tip = tipFor(selected, survey);
    const snapshots = getSnapshots();

    let html = '<div class="container">' + pageHeader("Your Carbon Footprint");

    html +=
      '<div class="card hero fade-up"><div class="glow"></div><div class="rel">' +
      '<p class="sm muted">Your estimated footprint</p>' +
      '<div class="big-number"><span class="num">' + fp.totalYearly.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</span><span class="unit">kg CO₂e / year</span></div>' +
      '<p class="sm muted mt-1">≈ ' + (fp.totalYearly / 1000).toFixed(1) + " tonnes</p>" +
      '<div class="chip-row mt-5">' + ukPill(cmp) + '<span class="stat-pill solid">' + icon("target", "sm") + budgetPct +
      "% of the 1.5°C budget</span></div>" + ukNote(cmp) + sharedLine(fp.totalYearly) + "</div></div>";

    if (checkInDue()) {
      html +=
        '<div class="card callout fade-up"><div class="callout-row"><div class="round-badge">' + icon("calendar") + '</div><div class="grow">' +
        '<h2 class="card-title mb-1">Time for your monthly check-in</h2><p class="sm muted mb-4 max-2xl">It\'s a new month since you last surveyed (' +
        esc(monthLabel(snapshots[snapshots.length - 1].month)) +
        '). Re-take the survey to see how your footprint has changed and keep your progress chart up to date.</p>' +
        '<a class="btn btn-green" href="#/">Re-take the survey ' + icon("arrowRight") + "</a></div></div></div>";
    }

    html +=
      '<div class="card"><h2 class="card-title mb-1">Where it comes from</h2><p class="sm muted mb-3">Tap a bar to see how to improve it.</p>' +
      '<div class="chart-legend xs muted mb-4"><span><i class="lg-you"></i>You</span><span><i class="lg-uk"></i>Typical UK resident</span></div>' +
      '<div class="chart-wrap">' + barChart(fp.breakdown, selected) + "</div>" +
      '<p class="xs muted mt-2">UK averages use official figures: Defra\'s typical weekly diet, ONS trips abroad with DESNZ flight factors, Ofgem energy use and DfT commuting. ' +
      "There's no UK average for banking and pensions.</p></div>";

    html +=
      '<div class="card callout strong fade-up"><div class="label-row mb-4"><span class="round-badge sm">' + icon("trendDown") + "</span>" +
      '<span class="eyebrow">' + (ui.selectedCategory ? "How to improve this" : "Your biggest opportunity") + "</span></div>" +
      '<h3 class="tip-title">' + esc(tip.title) + '</h3><p class="sm muted lh mb-5 max-2xl">' + esc(tip.body) + "</p>" +
      (tip.saving > 0.5 || tip.maxSaving > 0.5 ? savingSummary(tip) : "") +
      (!ui.selectedCategory ? '<p class="xs muted mt-4">This is your largest source of emissions. Tap any bar above to explore other areas.</p>' : "") +
      '<div><a class="btn btn-green mt-5" href="#/explainer/' + selected + '">Learn how to reduce &amp; build habits ' + icon("arrowRight") + "</a></div></div>";

    if (totalMax > 0.5) {
      html +=
        '<div class="card fade-up"><div class="label-row mb-4"><span class="round-badge sm">' + icon("trendDown") + '</span><h2 class="card-title">If you build these habits</h2></div>' +
        '<p class="sm muted mb-6 max-2xl">Realistic changes across your categories could cut your footprint by about <span class="fw-600 green-dark">' +
        pct(totalSaving) + "%</span> (" + totalSaving.toFixed(0) + " kg CO₂e a year). Going all the way, it could fall by up to <span class=\"fw-600 green-dark\">" +
        pct(totalMax) + "%</span> (" + totalMax.toFixed(0) + ' kg).</p><div class="stack-3">' +
        compareBar("Now", fp.totalYearly, fp.totalYearly, "muted") +
        compareBar("With realistic changes", after, fp.totalYearly, "emerald") +
        compareBar("Going all the way", afterMax, fp.totalYearly, "deep") +
        "</div></div>";
    }

    html += '<div class="grid-2 gap-3 mb-8">';
    html += fp.breakdown
      .map((b) => {
        const sv = savingFor(b.key);
        return (
          '<div class="cat-row' + (selected === b.key ? " selected" : "") + '"><button type="button" class="cat-main" data-action="select-category" data-key="' + b.key + '">' +
          '<span class="emoji-row">' + b.icon + '</span><span class="min0"><span class="fw-500 sm block">' + esc(b.label) + '</span><span class="xs muted block truncate">' +
          esc(b.detail) + "</span></span></button>" +
          '<div class="cat-side"><div class="right"><p class="fw-600">' + b.yearly.toFixed(0) + '</p><p class="xs muted">kg/yr</p>' +
          (sv.saving > 0.5 ? '<p class="tiny green">−' + sv.saving.toFixed(0) + " realistic</p>" : "") +
          (sv.max > sv.saving + 0.5 ? '<p class="tiny muted">up to −' + sv.max.toFixed(0) + "</p>" : "") +
          '</div><a class="icon-btn round" href="#/explainer/' + b.key + '" aria-label="Learn how to reduce ' + esc(b.label) + '">' + icon("arrowRight") + "</a></div></div>"
        );
      })
      .join("");
    html += "</div>";

    const hist = historyByDay();
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
    } else if (snapshots.length) {
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

    html +=
      '<div class="btn-row"><button type="button" class="btn btn-outline" data-action="edit-survey">' + icon("refresh") + " Edit my answers</button>" +
      '<button type="button" class="btn btn-green" data-action="top-opportunity">' + icon("arrowRight") + " Show my top opportunity</button></div>" +
      saveCard() + supportCard() +
      '<p class="xs muted footnote">Estimates are approximate and based on typical lifecycle emission factors. Use as a guide to find your biggest opportunities to reduce impact. <a class="link-btn" href="#/how-we-calculate">How we calculate</a></p></div>';
    return html;
  }

  // ==================== Explainer page ====================

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
    const item = fp.breakdown.find((b) => b.key === cat);
    const budgetPct = item ? Math.round((item.yearly / D.BUDGET_YEARLY) * 100) : null;

    let html =
      '<div class="container narrow"><a class="btn btn-ghost btn-sm back-link" href="#/results">' + icon("arrowLeft") + " Back</a>" +
      '<div class="mb-8 fade-up"><div class="label-row mb-3"><span class="emoji-xl">' + ex.icon + '</span><h1 class="explainer-title">' + esc(ex.title) +
      '</h1></div><p class="muted lh">' + esc(ex.why) + "</p></div>" +
      '<div class="grid-2 gap-3 mb-8">' +
      '<div class="panel green p-5"><div class="eyebrow-sm green-dark">' + icon("trendDown") + ' Your potential saving</div><p class="stat">' +
      (tip.saving > 0.5 ? "~" + tip.saving.toFixed(0) : "—") + '<span class="sm muted normal"> kg CO₂e / year</span></p><p class="xs muted mt-1">Realistic: ' +
      esc(tip.realisticLabel || tip.title) + "</p>" +
      (tip.maxSaving > tip.saving + 0.5
        ? '<p class="xs muted mt-1">Up to ~' + tip.maxSaving.toFixed(0) + " kg going all the way: " + esc(tip.maxLabel || "") + "</p>"
        : "") +
      "</div>" +
      (budgetPct !== null
        ? '<div class="panel p-5"><div class="eyebrow-sm muted">' + icon("target") + ' vs 1.5°C budget</div><p class="stat">' + budgetPct +
          '%<span class="sm muted normal"> of yearly target</span></p><p class="xs muted mt-1">Target is 2,500 kg a year (2.5 t)</p></div>'
        : "") +
      "</div>";

    html +=
      '<div class="stack-6 mb-10">' +
      sections
        .map(
          (s, i) =>
            '<div class="section-card fade-up" data-action="open-section" data-index="' + i + '" role="button" tabindex="0"><h2 class="label-row fw-600 mb-2">' +
            '<span class="num-badge">' + (i + 1) + "</span>" + esc(s.heading) + icon("info", "ml-auto faint") + '</h2><p class="sm muted lh">' + esc(s.body) + "</p>" +
            sectionTeaser(s) + "</div>"
        )
        .join("") +
      "</div>";

    html +=
      habitsComingSoonCard() +
      '<div class="center mt-8"><a class="btn btn-outline" href="#/">' + icon("arrowLeft") + " Back to survey</a></div></div>";
    return html;
  }

  // ---------- banking league tables ----------

  const bankRating = (bank) => D.BANK_RATING_BANDS.find((b) => bank.factor <= b.max);
  const rateChip = (key, label) => '<span class="rate rate-' + key + '">' + esc(label) + "</span>";
  const WHICH_LABELS = { green: "Eco", amber: "Amber", red: "Red" };
  const kgFmt = (n) => Math.round(n).toLocaleString();

  function pensionRating(score) {
    if (score >= 7.5) return { key: "vgood", label: "Good" };
    if (score >= 5) return { key: "good", label: "Adequate" };
    if (score >= 2.5) return { key: "bad", label: "Inadequate" };
    return { key: "vbad", label: "Poor" };
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
    if (s.dynamicKey === "savingsPensions") {
      const p = D.PENSION_CLIMATE_RANKING.find((x) => x.key && x.key === b.pensionProvider);
      if (!p) return "";
      const rt = pensionRating(p.score);
      return '<p class="sm mt-3 label-row" style="flex-wrap:wrap">' + esc(p.label) + ": " + p.rank + " of 12, " + rateChip(rt.key, rt.label) + "</p>";
    }
    return "";
  }

  function bankLeagueHtml() {
    const b = survey.banking || {};
    const bank = byKey(D.BANKS, b.bank);
    const best = D.BANKS.reduce((m, x) => (x.factor < m.factor ? x : m), D.BANKS[0]);
    let mine;
    if (!bank) {
      mine = '<p class="sm">Choose your bank in the survey\'s Banking step to see your personal comparison.</p>';
    } else {
      const rt = bankRating(bank);
      const amount = Number(b.amount) || 0;
      mine =
        '<p class="sm label-row" style="flex-wrap:wrap"><strong>Your bank: ' + esc(bank.label) + "</strong>" + rateChip(rt.key, rt.label) +
        (D.WHICH_BANK_RATINGS[bank.key] ? '<span class="xs muted">Which?: ' + WHICH_LABELS[D.WHICH_BANK_RATINGS[bank.key]] + "</span>" : "") + "</p>" +
        (amount > 0
          ? '<p class="sm mt-2">Your £' + amount.toLocaleString() + " there finances about <strong>" + kgFmt(amount * bank.factor) + " kg CO₂e a year</strong>. " +
            (bank.key === best.key
              ? "That's already the greenest bank in the table."
              : "At " + esc(best.label) + ", the greenest bank in the table, it would be about " + kgFmt(amount * best.factor) + " kg: <strong>" +
                kgFmt(amount * (bank.factor - best.factor)) + " kg less</strong> (" + Math.round((1 - best.factor / bank.factor) * 100) + "% lower).") + "</p>"
          : '<p class="xs muted mt-2">Add your savings in the survey to see how much CO₂ your money finances.</p>');
    }
    const rows = D.BANKS.slice()
      .sort((x, y) => x.factor - y.factor)
      .map((x, i) => {
        const rt = bankRating(x);
        const w = D.WHICH_BANK_RATINGS[x.key];
        return (
          '<tr' + (bank && x.key === bank.key ? ' class="me"' : "") + "><td>" + (i + 1) + "</td><td>" + esc(x.label) + (bank && x.key === bank.key ? " (you)" : "") +
          "</td><td class=\"num\">" + kgFmt(x.factor * 1000) + "</td><td>" + rateChip(rt.key, rt.label) + "</td><td>" +
          (w ? rateChip(w === "green" ? "vgood" : w === "amber" ? "bad" : "vbad", WHICH_LABELS[w]) : '<span class="xs muted">–</span>') + "</td></tr>"
        );
      })
      .join("");
    return (
      '<div class="popup-body"><div class="panel green p-4">' + mine + "</div>" +
      '<p class="xs fw-600 upper muted mt-2">Independent league table</p>' +
      '<div class="league-wrap"><table class="league league-banks"><thead><tr><th>#</th><th>Bank</th><th class="num">kg per £1k</th><th>Rating</th><th>Which?</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" +
      '<p class="xs muted">Emissions: MotherTree bank carbon emissions league table (2021), CO₂e financed per pound held. Our rating bands: Very good under 45 kg, Good under 75, Bad under 150, Very bad 150+ per £1,000. ' +
      "kg per £1k: kg CO₂e a year for every £1,000 held. Which?: Which? and Reclaim Finance review of fossil-fuel policies (October 2023); Eco = Which? Eco Provider, with no fossil-fuel exposure; – = not assessed. The two can disagree: Lloyds and Halifax finance relatively little but lack a full fossil-fuel exclusion policy, so Which? rates them red.</p></div>"
    );
  }

  function switchAccountHtml() {
    const support =
      isNativeApp() || !STRIPE_PAYMENT_LINK
        ? "Coming soon: a CO2 Counter assistant (MCP) to help you switch, step by step."
        : 'Coming soon: a CO2 Counter assistant (MCP) to help you switch, step by step. <a class="link-btn" href="' + esc(supportUrl()) + '">Help us build it by supporting CO2 Counter</a>.';
    return (
      '<div class="popup-body"><p class="sm">The <strong>Current Account Switch Service</strong> is free and run by Pay.UK, and most UK banks and building societies use it. ' +
      "Open an account with your new bank and ask for a full switch: it moves your balance, direct debits and standing orders in 7 working days, " +
      "redirects payments sent to your old account, and is protected by the Current Account Switch Guarantee.</p>" +
      '<p class="sm">Greener choices for an everyday account include Nationwide and The Co-operative Bank, both Which? Eco Providers.</p>' +
      '<div><a class="btn btn-green" href="' + D.CASS_URL + '" target="_blank" rel="noopener">Go to the Current Account Switch Service ' + icon("arrowRight") + "</a></div>" +
      '<div class="panel p-4 mt-2"><p class="xs muted">' + support + "</p></div></div>"
    );
  }

  function savingsPensionsHtml() {
    const b = survey.banking || {};
    const mine = D.PENSION_CLIMATE_RANKING.find((x) => x.key && x.key === b.pensionProvider);
    const chosen = byKey(D.PENSION_PROVIDERS, b.pensionProvider);
    let mineHtml;
    if (mine) {
      const rt = pensionRating(mine.score);
      mineHtml =
        '<p class="sm label-row" style="flex-wrap:wrap"><strong>Your provider: ' + esc(mine.label) + "</strong>" + rateChip(rt.key, rt.label) + "</p>" +
        '<p class="sm mt-2">Ranked <strong>' + mine.rank + " of 12</strong> with " + mine.score + "/10 for climate action.</p>";
    } else if (chosen && chosen.key !== "other") {
      mineHtml = '<p class="sm"><strong>Your provider: ' + esc(chosen.label) + "</strong> isn't in this ranking, which covers the 12 largest workplace pension providers.</p>";
    } else {
      mineHtml = '<p class="sm">Choose your pension provider in the survey\'s Banking step to see how it ranks.</p>';
    }
    const rows = D.PENSION_CLIMATE_RANKING.map((x) => {
      const rt = pensionRating(x.score);
      const me = mine && x.key === mine.key;
      return '<tr' + (me ? ' class="me"' : "") + "><td>" + x.rank + "</td><td>" + esc(x.label) + (me ? " (you)" : "") + '</td><td class="num">' + x.score.toFixed(1) + "</td><td>" + rateChip(rt.key, rt.label) + "</td></tr>";
    }).join("");
    return (
      '<div class="popup-body"><p class="sm"><strong>Savings:</strong> a bank lends out savings just like current-account money, so the bank league table applies here too. ' +
      "Building societies and ethical banks such as Nationwide, The Co-operative Bank and Triodos tend to come out best.</p>" +
      '<p class="sm"><strong>Pensions:</strong> often the biggest lever. Ask your provider or HR for a climate-focused or fossil-free fund; switching usually takes a few minutes online.</p>' +
      '<div class="panel green p-4">' + mineHtml + "</div>" +
      '<p class="xs fw-600 upper muted mt-2">Independent pension ranking</p>' +
      '<div class="league-wrap"><table class="league"><thead><tr><th>#</th><th>Provider</th><th class="num">/10</th><th>Rating</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" +
      '<p class="xs muted">Make My Money Matter, Climate Action Report 2025 (February 2025): climate commitments, targets, fossil fuels, deforestation and stewardship. It rates providers\' climate action, not the carbon footprint of your fund; ' +
      "your footprint figure uses each provider\'s own published (TCFD) data. Not financial advice.</p></div>"
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

  function openSectionDialog(cat, index) {
    const diet = cat === "meals" ? D.DIET_EXPLAINERS[dietType(survey)] : null;
    const sections = (diet && diet.sections) || D.EXPLAINERS[cat].sections;
    const habits = (diet && diet.habits) || D.EXPLAINERS[cat].habits;
    const s = sections[index];
    if (!s) return;
    let content = null;
    if (s.dynamicKey === "flightTiers") content = flightTiersContent();
    if (s.dynamicKey === "trainComparison") content = trainContent();
    const subtitle = habits[index] ? "Pairs with habit: " + habits[index].label : null;

    let body;
    if (s.dynamicKey === "bankLeague") body = bankLeagueHtml();
    else if (s.dynamicKey === "switchAccount") body = switchAccountHtml();
    else if (s.dynamicKey === "savingsPensions") body = savingsPensionsHtml();
    else if (content && content.isTrainPopup) body = trainPopupHtml(content);
    else if (content) body = flightPopupHtml(content);
    else body = '<div class="empty-box small"><p class="sm muted">Detailed guide coming soon.</p></div>';

    modalRoot.innerHTML =
      '<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
      '<button type="button" class="modal-close" data-action="close-modal" aria-label="Close">' + icon("x") + "</button>" +
      '<h2 id="modal-title" class="modal-title">' + icon("info", "green") + esc(s.heading) + "</h2>" +
      (subtitle ? '<p class="sm green-dark">' + esc(subtitle) + "</p>" : "") + body + "</div></div>";
    modalRoot.innerHTML = glyphify(modalRoot.innerHTML);
    document.body.classList.add("modal-open");
  }

  function closeModal() {
    modalRoot.innerHTML = "";
    document.body.classList.remove("modal-open");
  }

  const EQUIV_ICONS = { Target: "🎯", TreePine: "🌳", Smartphone: "📱", Car: "🚗", Globe: "🌍" };

  function flightTiersContent() {
    const tier = flightTier(survey);
    const totals = flightTotals(survey);
    if (tier.total === 0) {
      return {
        executiveSummary: "You haven't logged any flights — you're in Tier 1 with zero aviation emissions. That's the lowest-impact tier.",
        userTier: 1,
        equivalents: [],
      };
    }
    const eq = equivalents(totals.total);
    const pct = Math.round(totals.pctOfTarget);
    return {
      executiveSummary: {
        text: "This will be one of the most impactful changes, for the least amount of effort. The reason being it does not require you to change anything about your day to day life, but rather stop doing things in your day-to-day life. However, it is a lot easier said than done. The introduction largely explains why we need to reduce flights but to make it more understandable I have put some more metrics below.",
        reminder: "Remember, 1 less flight a year, no matter how many you take is an important step in the right direction!",
      },
      userTier: tier.tier,
      perFlight: totals.items,
      equivalents: [
        { category: "1.5°C target", icon: "Target", count: null, label: pct + "% of 1.5°C target", sub: "one person's yearly budget", extra: totals.total.toFixed(0) + " kg CO₂e / year · target 2,500 kg" },
        { category: "Tree equivalent", icon: "TreePine", count: eq.trees, label: eq.trees + " mature trees", sub: "absorbing CO₂ for a whole year" },
        { category: "Phone equivalent", icon: "Smartphone", count: eq.phones, label: eq.phones + " iPhones (14)", sub: "manufacturing + charging for a year" },
        { category: "Driving equivalent", icon: "Car", count: null, label: eq.drivingKm.toLocaleString() + " km driven", sub: "equivalent car emissions" },
      ],
    };
  }

  function flightPopupHtml(c) {
    const label = (t) => '<p class="eyebrow-xs">' + t + "</p>";
    let html = '<div class="popup-body"><div>' + label("Executive Summary");
    if (typeof c.executiveSummary === "string") html += '<p class="sm muted lh">' + esc(c.executiveSummary) + "</p>";
    else
      html +=
        '<p class="sm muted lh">' + esc(c.executiveSummary.text) + "</p>" +
        (c.executiveSummary.reminder ? '<p class="sm fw-500 lh mt-2">' + esc(c.executiveSummary.reminder) + "</p>" : "");
    html += "</div><div>" + label("Flight Frequency Tiers") + '<div class="stack-2">';
    html += D.FLIGHT_TIERS.map((t) => {
      const mine = t.tier === c.userTier;
      return (
        '<div class="tier' + (mine ? " mine" : "") + '"><div class="label-row mb-0"><span class="xs fw-700 ' + (mine ? "green-dark" : "muted") + '">' + t.label + "</span>" +
        (mine ? '<span class="tag solid">YOU ARE HERE</span>' : "") + '</div><p class="xs fw-500">' + esc(t.criteria) + '</p><p class="xs muted mt-0">' + esc(t.description) + "</p></div>"
      );
    }).join("");
    html += "</div></div>";
    if (c.equivalents.length) {
      html += "<div>" + label("Your Flight Equivalents") + '<div class="stack-4">';
      html += c.equivalents
        .map((e) => {
          const em = EQUIV_ICONS[e.icon] || "ℹ️";
          const visual = e.count
            ? '<div class="icon-row">' + em.repeat(Math.min(e.count, 60)) + (e.count > 60 ? '<span class="xs green fw-500"> +' + (e.count - 60) + "</span>" : "") + "</div>"
            : '<div class="emoji-lg mb-2">' + em + "</div>";
          return (
            '<div class="equiv"><p class="eyebrow-xs amber">' + esc(e.category) + "</p>" + visual + '<p class="equiv-label">' + esc(e.label) + '</p><p class="xs muted">' + esc(e.sub) + "</p>" +
            (e.extra ? '<p class="xs muted">' + esc(e.extra) + "</p>" : "") + "</div>"
          );
        })
        .join("");
      html += "</div></div>";
    }
    if (c.perFlight && c.perFlight.length) {
      html +=
        "<div>" + label("Breakdown by flight") + '<div class="stack-2">' +
        c.perFlight
          .map(
            (f) =>
              '<div class="mini-row"><span class="xs fw-500 truncate">' + esc(f.label) + '</span><span class="xs muted nowrap">' + f.co2.toFixed(0) + " kg · " +
              f.pctOfTarget.toFixed(1) + "% of target</span></div>"
          )
          .join("") +
        "</div></div>";
    }
    return html + "</div>";
  }

  const PARIS_FLIGHT_KG = 123;
  const PARIS_TRAIN_KG = 4;

  function trainContent() {
    const ratio = PARIS_TRAIN_KG / PARIS_FLIGHT_KG;
    const rows = (survey.flights || [])
      .filter((f) => {
        const km = flightKm(f.from, f.to);
        return km > 0 && km < MEDIUM_HAUL_KM;
      })
      .map((f) => {
        const kg = flightKg(f);
        return { label: routeLabel(f), flightKg: kg, trainKg: kg * ratio };
      });
    return {
      isTrainPopup: true,
      text:
        "This may not be most impactful for your entire footprint, due to longer haul flights that cannot be replaced by train. What is important is that 1 short-haul flight replaced by yourself vs one short-haul flight replaced by someone that barely flies still has the same impact for the planet!\n" +
        "According to independently-commissioned figures, EuroStar reports a return journey from London-to-Paris is ~4kg CO₂ per person, whereas a flight is ~123kg CO₂. 97% less! But also, less than most meat-based meals. If we again compare this to our 1.5°C target per year, 4kg = 0.16% whereas 123kg = 4.92%. What a difference!\n" +
        "Here are some more equivalence figures below, for the stats nerds.",
      rows: [{ label: "London → Paris (return)", flightKg: PARIS_FLIGHT_KG, trainKg: PARIS_TRAIN_KG }].concat(rows),
      equivalents: [
        { type: "target", category: "1.5°C target", icon: "Target", sub: "CO₂ emissions / 2,500 kg yearly target" },
        { type: "icons", category: "Tree equivalence", icon: "TreePine", sub: "20 kg CO₂ absorbed per mature tree / year", perKg: 20, unit: "trees" },
        { type: "icons", category: "Phone equivalence", icon: "Smartphone", sub: "61 kg CO₂ per iPhone 14 (manufacture + a year's charging)", perKg: 61, unit: "phones" },
        { type: "bars", category: "Driving equivalence", icon: "Car", sub: "0.17625 kg CO₂ per km in an average car", perKm: 0.17625 },
      ],
      seeNote: "See Tier 3 or 4",
    };
  }

  const one = (n) => (Math.round(n * 10) / 10).toFixed(1);

  function compareRows(label, flightVal, trainVal, max, fmt) {
    const w = (v) => Math.max(3, (v / max) * 100) + "%";
    const line = (em, v, cls) =>
      '<div class="cmp-line"><span class="cmp-emoji">' + em + '</span><div class="cmp-track"><div class="' + cls + '" style="width:' + w(v) + '"></div></div><span class="cmp-val ' + cls + '">' + fmt(v) + "</span></div>";
    return '<div class="mini-card"><p class="xs fw-500 mb-1">' + esc(label) + "</p>" + line("✈️", flightVal, "flight") + line("🚆", trainVal, "train") + "</div>";
  }

  function iconCount(count, em, cls) {
    const whole = Math.floor(count);
    const frac = count - whole;
    const cap = 60;
    const shown = Math.min(whole, cap);
    let html = '<div class="icon-row ' + cls + '">';
    for (let i = 0; i < shown; i++) html += "<span>" + em + "</span>";
    if (frac > 0 && shown < cap) html += '<span style="opacity:' + frac.toFixed(2) + '">' + em + "</span>";
    if (count > cap) html += '<span class="xs fw-500"> +' + one(count - cap) + "</span>";
    return html + "</div>";
  }

  function trainPopupHtml(c) {
    const rows = c.rows;
    let html =
      '<div class="popup-body"><div><p class="eyebrow-xs">Executive Summary</p><p class="sm muted lh pre-line">' + esc(c.text) + "</p></div>" +
      '<div><p class="eyebrow-xs">Equivalence</p><div class="stack-5">';
    html += c.equivalents
      .map((e) => {
        const em = EQUIV_ICONS[e.icon] || "ℹ️";
        let body = "";
        if (e.type === "target") {
          const vals = rows.map((r) => ({ f: (r.flightKg / D.BUDGET_YEARLY) * 100, t: (r.trainKg / D.BUDGET_YEARLY) * 100 }));
          const max = Math.max(...vals.flatMap((v) => [v.f, v.t]), 1);
          body = rows.map((r, i) => compareRows(r.label, vals[i].f, vals[i].t, max, (v) => v.toFixed(2) + "%")).join("");
        } else if (e.type === "bars") {
          const vals = rows.map((r) => ({ f: r.flightKg / e.perKm, t: r.trainKg / e.perKm }));
          const max = Math.max(...vals.flatMap((v) => [v.f, v.t]), 1);
          body = rows.map((r, i) => compareRows(r.label, vals[i].f, vals[i].t, max, (v) => Math.round(v).toLocaleString() + " km")).join("");
        } else {
          body = rows
            .map((r) => {
              const f = r.flightKg / e.perKg;
              const t = r.trainKg / e.perKg;
              return (
                '<div class="mini-card"><p class="xs fw-500 mb-1">' + esc(r.label) + "</p>" +
                '<div class="cmp-line"><span class="cmp-emoji">✈️</span><div class="grow min0">' + iconCount(f, em, "flight") + '</div><span class="cmp-val flight nowrap">' + one(f) + " " + e.unit + "</span></div>" +
                '<div class="cmp-line"><span class="cmp-emoji">🚆</span><div class="grow min0">' + iconCount(t, em, "train") + '</div><span class="cmp-val train nowrap">' + one(t) + " " + e.unit + "</span></div></div>"
              );
            })
            .join("");
        }
        return (
          '<div class="equiv"><div class="label-row mb-0"><span>' + em + '</span><p class="eyebrow-xs amber mb-0">' + esc(e.category) + '</p></div><p class="xs muted mb-2">' + esc(e.sub) +
          '</p><div class="stack-2">' + body + "</div></div>"
        );
      })
      .join("");
    html += "</div></div>" + (c.seeNote ? '<p class="xs muted italic center">' + esc(c.seeNote) + "</p>" : "");
    return html + "</div>";
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
            "<strong>Commute and travel</strong>: how you travel to work each day and how far, counting the journey there and back, plus other regular weekly travel and long journeys by land",
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
          "Flight distances are calculated between the two airports, with an allowance for real-world routing.</p>"
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
          "The government's official carbon footprint figures split these across the whole population, which comes to about 2.4 tonnes per person a year. " +
          "We show it as a fixed line under your total, because it's the same for everyone and your answers don't change it.</p>" +
          "<p>Together with what the survey measures, this brings your figure closer to the full UK average of about 10 tonnes per person. Some spending, like insurance, phone contracts and other services, isn't in the survey yet.</p>"
      ) +
      section(
        "The 1.5°C budget",
        "<p>To keep global warming to 1.5°C, average emissions need to fall to roughly 2.5 tonnes of CO₂-equivalent per person per year. " +
          "We show your footprint as a share of that, as a sense of scale.</p>"
      ) +
      section(
        "Potential savings",
        "<p>For each area we show two figures: what a <strong>realistic</strong> change would save, and the most you could save <strong>going all the way</strong>.</p>" +
          "<p>Realistic changes:</p>" +
          list([
            "Flights: if you take several long-haul flights, keeping one in economy; swapping a single long-haul trip for a short-haul one; and taking the train for short-haul trips, keeping one short-haul flight if you take three or more",
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

  // ==================== Friends page ====================

  const friends = { loaded: false, loading: false, rows: [], board: [], myName: "", error: "", msg: "" };

  async function loadFriends() {
    if (!currentUser || !sb || friends.loading) return;
    friends.loading = true;
    const me = currentUser.id;
    try {
      const [{ data: rows }, { data: board }, { data: mine }] = await Promise.all([
        sb.from("friendships").select("*").or("requester_id.eq." + me + ",addressee_id.eq." + me),
        sb.rpc("friends_footprints"),
        sb.from("profiles").select("display_name").eq("id", me).maybeSingle(),
      ]);
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
    if (currentPath() === "/friends") render();
  }

  function renderFriends() {
    if (!friends.loaded) {
      loadFriends();
      return spinner;
    }
    const incoming = friends.rows.filter((f) => f.status === "pending" && !f.iAsked);
    const outgoing = friends.rows.filter((f) => f.status === "pending" && f.iAsked);
    const accepted = friends.rows.filter((f) => f.status === "accepted");
    const row = (f, buttons) =>
      '<div class="friend-row"><span class="sm fw-500 truncate">' + esc(f.name) + '</span><span class="chip-row">' +
      buttons.map(([label, action, cls]) => '<button type="button" class="btn btn-sm ' + cls + '" data-action="' + action + '" data-id="' + f.id + '">' + label + "</button>").join("") +
      "</span></div>";
    const section = (title, body) => '<div class="card"><h2 class="card-title mb-4">' + title + "</h2>" + body + "</div>";
    let html = '<div class="container narrow">' + pageHeader("Friends", "Compare footprints with people you know", "user");
    if (friends.error) html += '<p class="sm red mb-4">' + esc(friends.error) + "</p>";

    // Leaderboard
    const meOnBoard = friends.board.find((b) => b.is_self);
    let board;
    if (!accepted.length) board = '<p class="sm muted">Add friends below to compare your yearly footprints.</p>';
    else {
      board =
        '<div class="stack-2">' +
        friends.board
          .map(
            (b, i) =>
              '<div class="month-row' + (b.is_self ? " me" : "") + '"><div class="label-row min0"><span class="num-badge">' + (i + 1) + '</span><span class="sm fw-500 truncate">' +
              esc(b.is_self ? (friends.myName ? friends.myName + " (you)" : "You") : b.display_name) + '</span></div><div class="label-row shrink0"><span class="fw-600">' +
              (b.total_yearly / 1000).toFixed(1) + '</span><span class="xs muted">t / yr</span></div></div>'
          )
          .join("") +
        "</div>" +
        (!meOnBoard ? '<p class="xs muted mt-3">Finish the survey to appear on the leaderboard.</p>' : "") +
        (accepted.length > friends.board.filter((b) => !b.is_self).length
          ? '<p class="xs muted mt-3">Friends who haven\'t finished the survey yet won\'t appear until they do.</p>'
          : "");
    }
    html += section("Leaderboard", board + '<p class="xs muted mt-3">Lowest footprint first. Friends only ever see each other\'s yearly totals, never your answers.</p>');

    // Your name
    html += section(
      "Your name",
      '<p class="xs muted mb-3">This is what your friends see.</p><form id="name-form" class="chip-row"><input class="input grow" id="display-name" maxlength="40" placeholder="e.g. Sam" value="' +
        esc(friends.myName) + '" /><button type="submit" class="btn btn-outline">Save</button></form>'
    );

    // Add a friend
    html += section(
      "Add a friend",
      '<form id="friend-form" class="chip-row"><input class="input grow" type="text" id="friend-email" placeholder="Their username or email" required autocapitalize="none" spellcheck="false" /><button type="submit" class="btn btn-green">Send request</button></form>' +
        '<p class="xs muted mt-2">They need a CO2 Counter account. Usernames aren\'t case-sensitive.</p>' +
        (friends.msg ? '<p class="xs mt-2 ' + (friends.msgOk ? "green-dark" : "red") + '">' + esc(friends.msg) + "</p>" : "")
    );

    if (incoming.length)
      html += section("Requests for you", '<div class="stack-2">' + incoming.map((f) => row(f, [["Accept", "friend-accept", "btn-green"], ["Decline", "friend-remove", "btn-outline"]])).join("") + "</div>");
    if (outgoing.length)
      html += section("Waiting for a reply", '<div class="stack-2">' + outgoing.map((f) => row(f, [["Cancel", "friend-remove", "btn-outline"]])).join("") + "</div>");
    if (accepted.length)
      html += section("Your friends", '<div class="stack-2">' + accepted.map((f) => row(f, [["Remove", "friend-remove", "btn-outline"]])).join("") + "</div>");
    return html + "</div>";
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
            "<strong>Support details</strong>: if you choose to support CO2 Counter, the status and renewal date of your support and a reference to your customer record at Stripe. We never see or store your card details.",
            "<strong>Technical data</strong>: our web host and service providers log basic request data such as IP addresses to run and secure the service.",
          ])
        ],
        [
          "Why we use it",
          ul([
            "To work out and show your footprint, save your answers to your account, and record any support you've chosen to give. The legal basis is performing our contract with you.",
            "To keep the service secure and working. The legal basis is our legitimate interests.",
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
    const profile =
      '<div class="row-between gap-3"><div class="min0 grow"><p class="fw-600 truncate">' + esc(ui.userName || "App user") + '</p><p class="sm muted truncate">' +
      esc(currentUser.email) + '</p></div><button type="button" class="btn btn-outline btn-sm" data-action="sign-out">' + icon("logOut") + " Sign out</button></div>";
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

    return (
      '<div class="container narrow">' + pageHeader("Account", "Your profile & saved data", "user") +
      '<div class="card"><div class="label-row mb-4">' + icon("user", "green") + '<span class="sm fw-500 upper green-dark">Profile</span></div>' + profile + "</div>" +
      '<div class="card"><div class="label-row mb-4">' + icon("calendar", "green") + '<span class="sm fw-500 upper green-dark">' + (FREE_MODE ? "Your plan" : "Membership") + "</span></div>" + plan + "</div>" +
      (FREE_MODE && !m.owner && !isSupporter() ? supportCard() : "") +
      '<div class="card"><div class="label-row mb-4">' + icon("database", "green") + '<span class="sm fw-500 upper green-dark">Your saved data</span></div>' +
      '<div class="grid-2 gap-3"><div class="data-box"><p class="xs muted">Footprint</p><p class="stat-num">' + fp.totalYearly.toFixed(0) +
      '</p><p class="xs muted">kg CO₂e / year</p></div><div class="data-box"><p class="xs muted">Committed habits</p><p class="stat-num">' + habitCount +
      '</p><p class="xs muted">across ' + CATEGORIES.length + " categories</p></div></div>" +
      '<div class="chip-row mt-5"><a class="btn btn-outline btn-sm" href="#/">' + icon("leaf") + ' Retake survey</a><a class="btn btn-outline btn-sm" href="#/results">' +
      icon("chart") + " View results</a></div></div>" +
      '<div class="card"><div class="label-row mb-1">' + icon("trash", "red") + '<span class="sm fw-500 upper red">Data management</span></div>' +
      '<p class="xs muted mb-4">Clear stored data from this device. This can\'t be undone.</p><div class="chip-row">' +
      '<button type="button" class="btn btn-outline btn-sm" data-action="clear-habits">' + icon("trash") + " Clear habits</button>" +
      '<button type="button" class="btn btn-outline btn-sm btn-danger" data-action="clear-all">' + icon("trash") + " Clear everything</button></div></div>" +
      deleteAccountCard() + "</div>"
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
    return (
      '<div class="card"><div class="label-row mb-1">' + icon("user", "red") + '<span class="sm fw-500 upper red">Delete account</span></div>' + body + "</div>"
    );
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
        ? '<p class="xs muted center">By creating an account you agree to our <a class="link-btn" href="#/terms">Terms</a> and <a class="link-btn" href="#/privacy">Privacy policy</a>.</p>'
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
    return native ? PRODUCTION_URL : location.origin + location.pathname;
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
        '<a class="link-btn" href="#/terms">Terms</a> and <a class="link-btn" href="#/privacy">Privacy policy</a>.</p>' +
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
      '<p class="xs muted footnote">Estimates are approximate and based on typical lifecycle emission factors. <a class="link-btn" href="#/how-we-calculate">How we calculate</a></p></div>'
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

  function currentPath() {
    const hash = location.hash.replace(/^#/, "") || "/";
    return hash.split("?")[0];
  }

  function render() {
    const path = currentPath();
    // While a new survey is open, every other page shows the finished one.
    if (ui.newSurvey) survey = path === "/" ? ui.draft : ui.prevSurvey;
    // Leaving the survey ends an edit; the Survey tab asks again next time.
    if (path !== "/") ui.editing = false;
    const parts = path.split("/").filter(Boolean);
    let html;
    const member = canSync();
    const full = hasFullAccess();
    if (!authChecked || !survey || (currentUser && !membership)) html = spinner;
    else if (ui.pendingVerify) html = renderVerify();
    else if (ui.recovery) html = renderLogin();
    else if (currentUser && ui.needUsername && !["/privacy", "/terms", "/how-we-calculate"].includes(path)) html = renderChooseUsername();
    else if (path === "/") html = renderSurvey();
    else if (path === "/how-we-calculate") html = renderMethod();
    else if (path === "/privacy") html = renderPrivacy();
    else if (path === "/terms") html = renderTerms();
    else if (path === "/results") html = full ? renderResults() : renderResultsPreview();
    else if (parts[0] === "explainer" && parts[1]) html = full ? renderExplainer(parts[1]) : renderLocked();
    else if (path === "/check-in" || path === "/habits") html = renderHabitsPending();
    else if (path === "/friends") html = member ? renderFriends() : renderLocked();
    else if (path === "/account") html = member ? renderAccount() : renderLocked();
    else html = '<div class="container"><div class="empty-card"><h2 class="fw-600 mb-1">Page not found</h2><a class="btn btn-green mt-4" href="#/">Go to the survey</a></div></div>';
    setNav(parts[0] === "explainer" ? "" : path);
    const accountLink = document.querySelector('#nav a[data-route="/account"]');
    if (accountLink) accountLink.textContent = currentUser ? "Account" : "Sign in";
    if (ui.flash && html !== spinner) {
      html =
        '<div class="flash" role="status">' + icon("check") + "<span>" + esc(ui.flash) + "</span>" +
        '<button type="button" class="icon-btn" data-action="dismiss-flash" aria-label="Dismiss">' + icon("x") + "</button></div>" + html;
    }
    // Re-rendering a form after an error shouldn't wipe the passwords
    // someone just typed.
    const kept = PASSWORD_IDS.map((id) => [id, document.getElementById(id)]).filter(([, el]) => el && el.value);
    app.innerHTML = glyphify(html);
    kept.forEach(([id, el]) => {
      const now = document.getElementById(id);
      if (now) now.value = el.value;
    });
    updatePasswordMatch();
  }

  const PASSWORD_IDS = ["auth-password", "auth-password2", "new-password", "new-password2"];

  function onRouteChange() {
    closeModal();
    ui.flash = "";
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
      } else {
        if (ui.newSurvey) {
          survey = ui.draft;
          ui.newSurvey = false;
          ui.draft = null;
          ui.prevSurvey = null;
        }
        survey.completedAt = new Date().toISOString();
        surveyChanged();
        ui.editing = false;
        saveSnapshot(footprint(survey).totalYearly);
        recordHistory(survey);
        location.hash = "#/results";
      }
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
      ui.commuteOpen = ui.commuteOpen === el.dataset.day ? null : el.dataset.day;
      render();
    },
    "set-commute": (el) => {
      survey.commute = { ...survey.commute, [el.dataset.day]: el.dataset.key };
      ui.commuteOpen = null;
      surveyChanged();
      render();
    },
    "add-travel": (el) => {
      if (el.dataset.kind === "extra") survey.extraTravel = survey.extraTravel.concat({ mode: "car_petrol", km: 0 });
      else survey.longTrips = survey.longTrips.concat({ label: "", mode: "train", km: 0, returnTrip: true });
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
    "add-flight": () => {
      survey.flights = survey.flights.concat({ from: "", to: "", cabin: "economy", returnTrip: true, date: new Date().toISOString().slice(0, 10) });
      surveyChanged();
      render();
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
    "toggle-green": () => {
      survey.energy = { ...survey.energy, greenTariff: !survey.energy.greenTariff };
      surveyChanged();
      render();
    },
    "select-category": (el) => {
      ui.selectedCategory = el.dataset.key;
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
    "dismiss-flash": () => {
      ui.flash = "";
      render();
    },
    "sign-out": async () => {
      if (sb) await sb.auth.signOut();
      currentUser = null;
      membership = null;
      friends.loaded = false;
      friends.rows = [];
      friends.board = [];
      ui.userName = "";
      ui.authMode = "signin";
      // The next person to use this device shouldn't see these answers.
      lsRemove(KEY_SURVEY);
      lsRemove(KEY_HISTORY);
      ui.history = [];
      ui.newSurvey = false;
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
      ui.newSurvey = false;
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
      ui.prevSurvey = survey;
      ui.draft = normaliseSurvey(null);
      survey = ui.draft;
      ui.newSurvey = true;
      ui.editing = false;
      ui.step = 0;
      render();
      window.scrollTo(0, 0);
    },
    "cancel-new-survey": () => {
      survey = ui.prevSurvey || survey;
      ui.newSurvey = false;
      ui.draft = null;
      ui.prevSurvey = null;
      ui.step = 0;
      ui.flash = "New survey cancelled. Your previous answers are unchanged.";
      render();
      window.scrollTo(0, 0);
    },
    "edit-survey": () => {
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
    } else if (t.dataset.travel) {
      const key = t.dataset.travel === "extra" ? "extraTravel" : "longTrips";
      const i = Number(t.dataset.index);
      const f = t.dataset.key;
      const value = t.type === "checkbox" ? t.checked : f === "km" ? Math.max(0, Number(t.value) || 0) : t.value;
      survey[key] = survey[key].map((x, idx) => (idx === i ? { ...x, [f]: value } : x));
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
    }
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
