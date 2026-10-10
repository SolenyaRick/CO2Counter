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
  const STRIPE_PORTAL_URL = "https://billing.stripe.com/p/login/9B6eVd0a4g2X4Gbc2K5EY00";
  const WEBSITE_URL = "https://co2counter.co.uk/";

  const D = window.ECO_DATA;
  const DAYS = D.DAYS;
  const CATEGORIES = Object.keys(D.EXPLAINERS);

  const KEY_SURVEY = "ecoimpact_survey";
  const KEY_SNAPSHOTS = "ecoimpact_monthly_snapshots";
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
        result.status = row.status || "";
        result.until = row.current_period_end ? new Date(row.current_period_end) : null;
      }
    } catch (e) {
      result.error = true;
    }
    membership = result;
    return result;
  }

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
          lsSet(KEY_SURVEY, s);
          return s;
        }
        // A member with nothing saved yet keeps the answers they gave on
        // this device as a guest, now stored on their account.
        const local = lsGet(KEY_SURVEY, null);
        if (!error && local && membership && membership.access) saveSurveyRemote(normaliseSurvey(local));
      } catch (e) {}
    }
    return normaliseSurvey(lsGet(KEY_SURVEY, null));
  }

  async function saveSurveyRemote(s) {
    if (!currentUser || !sb) return;
    try {
      await sb.from("survey_responses").upsert({
        user_id: currentUser.id,
        survey_data: s,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {}
  }

  let saveTimer = null;
  function surveyChanged() {
    lsSet(KEY_SURVEY, survey);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSurveyRemote(survey), 600);
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

  // Great-circle distance with a 10% uplift for real-world routing.
  function flightKm(from, to) {
    const a = airport(from);
    const b = airport(to);
    if (!a || !b) return 0;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h)) * 1.1;
  }

  const cabinFactor = (key) => factorOf(D.CABINS, key);

  // A pot with no provider picked counts as "other" (the sector average).
  function pensionProvider(b) {
    return byKey(D.PENSION_PROVIDERS, b.pensionProvider) || byKey(D.PENSION_PROVIDERS, "other");
  }

  // kg CO2e per year from a pension pot at a given t CO2e per £1m invested.
  const pensionKg = (pot, tPerMillion) => ((pot || 0) * tPerMillion) / 1000;
  // A ticked "Return trip" counts the distance both ways. Flights saved
  // before the box existed have no flag and stay one-way.
  const legs = (f) => (f.returnTrip ? 2 : 1);
  const flightKg = (f) => flightKm(f.from, f.to) * cabinFactor(f.cabin) * legs(f);
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
    items.push({
      key: "commute",
      label: "Commute & Travel",
      icon: "🚗",
      yearly: commuteWeekly * D.WEEKS_PER_YEAR,
      detail: "~" + commuteWeekly.toFixed(1) + " kg CO₂e per week",
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
        const saving =
          DAYS.filter((d) => MOTOR_MODES.includes(c[d])).reduce((sum, d) => sum + perDay(c[d]), 0) * D.WEEKS_PER_YEAR;
        return {
          title: "Rethink your daily commute",
          body: long
            ? "Driving is one of the largest personal emission sources. For a commute of more than 10 km, taking the train or bus instead of the car on your driving days cuts most of it — and working from home or cycling some days takes it to zero."
            : "Driving is one of the largest personal emission sources. For a commute of 10 km or less, walking or cycling instead of driving removes those emissions completely — an e-bike makes longer or hillier trips easy.",
          saving,
          maxSaving: categoryYearly("commute", s),
          realisticLabel: long ? "train or bus on driving days" : "walking or cycling on driving days",
          maxLabel: "no commuting emissions, by working from home or walking and cycling",
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
        const economyKg = (f) => flightKm(f.from, f.to) * cabinFactor("economy") * legs(f);
        const avg = (list, fn) => (list.length ? list.reduce((t, f) => t + fn(f), 0) / list.length : 0);
        const long = flights.filter((f) => flightKm(f.from, f.to) > MEDIUM_HAUL_KM);
        const short = flights.filter((f) => {
          const km = flightKm(f.from, f.to);
          return km > 0 && km <= MEDIUM_HAUL_KM;
        });
        const typicalShortKg =
          short.length ? avg(short, economyKg) : flightKm("LHR", "BCN") * cabinFactor("economy") * (long.length === 1 ? legs(long[0]) : 1);
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
    confirmingPayment: false,
    paymentTimedOut: false,
  };

  const app = document.getElementById("app");
  const modalRoot = document.getElementById("modal-root");

  // ==================== Survey page ====================

  const STEPS = [
    { key: "meals", title: "Weekly Meals", subtitle: "What you eat, day by day", icon: "🍽️", render: renderMealsStep },
    { key: "commute", title: "Daily Commute", subtitle: "How you get around", icon: "🚗", render: renderCommuteStep },
    { key: "flights", title: "Flight Checklist", subtitle: "Your saved flights", icon: "✈️", render: renderFlightsStep },
    { key: "energy", title: "Home & Water", subtitle: "Energy, gas & water", icon: "⚡", render: renderEnergyStep },
    { key: "pets", title: "Pets", subtitle: "Furry companions", icon: "🐾", render: renderPetsStep },
    { key: "banking", title: "Banking & Pension", subtitle: "Where your money lives", icon: "🏦", render: renderBankingStep },
  ];

  function renderSurvey() {
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
    return (
      '<div class="container">' +
      pageHeader("Carbon Footprint Survey", "Step " + (ui.step + 1) + " of " + STEPS.length) +
      '<div class="mb-8"><div class="progress thin"><div style="width:' + pct + '%"></div></div>' +
      '<div class="step-chips">' + chips + "</div></div>" +
      '<div class="survey-card">' +
      '<div class="mb-6"><h2 class="step-title">' + esc(step.title) + '</h2><p class="muted sm">' + esc(step.subtitle) + "</p></div>" +
      '<div class="step-body fade-in">' + step.render() + "</div>" +
      '<div class="step-nav">' +
      '<button type="button" class="btn btn-ghost" data-action="prev-step"' + (ui.step === 0 ? " disabled" : "") + ">" +
      icon("chevronLeft") + " Back</button>" +
      '<button type="button" class="btn btn-green" data-action="next-step">' +
      (last ? "See my results" : "Continue") + " " + icon("chevronRight") + "</button>" +
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
    return html + "</div>";
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
        const cabin = byKey(D.CABINS, f.cabin) || D.CABINS[0];
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
            ? '<div class="sm"><span class="muted">' + (km * legs(f)).toFixed(0) + ' km · </span><span class="fw-500">' + (km * cabin.factor * legs(f)).toFixed(0) + " kg CO₂e</span></div>"
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

  const BAR_COLORS = ["#10b981", "#06b6d4", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"];

  function barChart(breakdown, selectedKey) {
    // Sized to the screen so labels stay readable on phones.
    const W = Math.round(Math.max(300, Math.min(900, window.innerWidth - 64)));
    const H = 280;
    const left = 40;
    const bottom = 70;
    const top = 10;
    const max = Math.max(1, ...breakdown.map((b) => b.yearly));
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
        ' kg CO₂e / year</title><rect x="' + (left + i * slot) + '" y="' + top + '" width="' + slot + '" height="' + plotH + '" fill="transparent" />' +
        '<path d="' + roundedTop(x, y, barW, h, 8) + '" fill="' + BAR_COLORS[i % BAR_COLORS.length] + '" opacity="' + op + '" /></g>';
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
      "% of the 1.5°C budget</span></div>" + ukNote(cmp) + "</div></div>";

    if (checkInDue()) {
      html +=
        '<div class="card callout fade-up"><div class="callout-row"><div class="round-badge">' + icon("calendar") + '</div><div class="grow">' +
        '<h2 class="card-title mb-1">Time for your monthly check-in</h2><p class="sm muted mb-4 max-2xl">It\'s a new month since you last surveyed (' +
        esc(monthLabel(snapshots[snapshots.length - 1].month)) +
        '). Re-take the survey to see how your footprint has changed and keep your progress chart up to date.</p>' +
        '<a class="btn btn-green" href="#/">Re-take the survey ' + icon("arrowRight") + "</a></div></div></div>";
    }

    html +=
      '<div class="card"><h2 class="card-title mb-1">Where it comes from</h2><p class="sm muted mb-6">Tap a bar to see how to improve it.</p>' +
      '<div class="chart-wrap">' + barChart(fp.breakdown, selected) + "</div></div>";

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

    if (snapshots.length) {
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
      '<div class="btn-row"><a class="btn btn-outline" href="#/">' + icon("refresh") + ' Retake survey</a>' +
      '<button type="button" class="btn btn-green" data-action="top-opportunity">' + icon("arrowRight") + " Show my top opportunity</button></div>" +
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
            '<span class="num-badge">' + (i + 1) + "</span>" + esc(s.heading) + icon("info", "ml-auto faint") + '</h2><p class="sm muted lh">' + esc(s.body) + "</p></div>"
        )
        .join("") +
      "</div>";

    html +=
      '<div class="card callout strong"><div class="label-row mb-4"><span class="round-badge sm">' + icon("leaf") + '</span><span class="eyebrow">Build these habits</span>' +
      '<span class="tag amber ml-auto">Coming Soon</span></div><div class="coming-soon"><div class="soon-icon">' + icon("leaf") + "</div>" +
      '<h2 class="soon-title">Habit tracking is on the way</h2><p class="sm muted max-sm">We\'re putting the finishing touches on the habit commitment and streak-tracking feature. Check back soon to build greener habits, one step at a time.</p></div></div>' +
      '<div class="center mt-8"><a class="btn btn-outline" href="#/">' + icon("arrowLeft") + " Back to survey</a></div></div>";
    return html;
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
    if (content && content.isTrainPopup) body = trainPopupHtml(content);
    else if (content) body = flightPopupHtml(content);
    else body = '<div class="empty-box small"><p class="sm muted">Detailed guide coming soon.</p></div>';

    modalRoot.innerHTML =
      '<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
      '<button type="button" class="modal-close" data-action="close-modal" aria-label="Close">' + icon("x") + "</button>" +
      '<h2 id="modal-title" class="modal-title">' + icon("info", "green") + esc(s.heading) + "</h2>" +
      (subtitle ? '<p class="sm green-dark">' + esc(subtitle) + "</p>" : "") + body + "</div></div>";
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
            "<strong>Commuting</strong>: how you travel to work each day and how far, counting the journey there and back",
            "<strong>Flights</strong>: each flight's distance between airports and the cabin class",
            "<strong>Home energy</strong>: electricity and gas use, whether you're on a green tariff, shared across your household",
            "<strong>Water</strong>: household water use, shared across your household",
            "<strong>Pets</strong>: the footprint of feeding dogs and cats",
            "<strong>Banking and pensions</strong>: the emissions your bank and pension fund finance with your money",
          ]) +
          "<p>Some things aren't measured yet, including shopping (clothes, electronics, furniture), leisure travel by car or train, other heating fuels, " +
          "drinks and snacks, and public services. Your total covers only the areas above.</p>"
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
            "Commuting: walking or cycling on driving days for journeys up to 10 km, or train or bus for longer ones",
            "Food: swapping the highest-impact meals for lower-impact ones, tailored to your diet",
            "Home energy: switching to a renewable electricity tariff",
            "Water and pets: using less water, and choosing lower-impact pet food",
            "Banking and pensions: moving savings to a bank that doesn't fund fossil fuels, and choosing a climate-focused pension fund",
          ]) +
          "<p>Going all the way:</p>" +
          list([
            "Flights: not flying",
            "Commuting: no commuting emissions, by working from home or walking and cycling",
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
    else {
      const until = m.until ? m.until.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
      plan =
        '<p class="fw-600">CO2 Counter membership · £2 a year</p><p class="sm muted">' +
        (m.status === "active" && until ? "Renews on " + esc(until) + "." : until ? "Access until " + esc(until) + "." : "Active.") +
        "</p>" +
        (STRIPE_PORTAL_URL && !isNativeApp()
          ? '<a class="btn btn-outline btn-sm mt-3" href="' + esc(STRIPE_PORTAL_URL) + '" target="_blank" rel="noopener">Manage subscription</a>'
          : "");
    }

    return (
      '<div class="container narrow">' + pageHeader("Account", "Your profile & saved data", "user") +
      '<div class="card"><div class="label-row mb-4">' + icon("user", "green") + '<span class="sm fw-500 upper green-dark">Profile</span></div>' + profile + "</div>" +
      '<div class="card"><div class="label-row mb-4">' + icon("calendar", "green") + '<span class="sm fw-500 upper green-dark">Membership</span></div>' + plan + "</div>" +
      '<div class="card"><div class="label-row mb-4">' + icon("database", "green") + '<span class="sm fw-500 upper green-dark">Your saved data</span></div>' +
      '<div class="grid-2 gap-3"><div class="data-box"><p class="xs muted">Footprint</p><p class="stat-num">' + fp.totalYearly.toFixed(0) +
      '</p><p class="xs muted">kg CO₂e / year</p></div><div class="data-box"><p class="xs muted">Committed habits</p><p class="stat-num">' + habitCount +
      '</p><p class="xs muted">across ' + CATEGORIES.length + " categories</p></div></div>" +
      '<div class="chip-row mt-5"><a class="btn btn-outline btn-sm" href="#/">' + icon("leaf") + ' Retake survey</a><a class="btn btn-outline btn-sm" href="#/results">' +
      icon("chart") + " View results</a></div></div>" +
      '<div class="card"><div class="label-row mb-1">' + icon("trash", "red") + '<span class="sm fw-500 upper red">Data management</span></div>' +
      '<p class="xs muted mb-4">Clear stored data from this device. This can\'t be undone.</p><div class="chip-row">' +
      '<button type="button" class="btn btn-outline btn-sm" data-action="clear-habits">' + icon("trash") + " Clear habits</button>" +
      '<button type="button" class="btn btn-outline btn-sm btn-danger" data-action="clear-all">' + icon("trash") + " Clear everything</button></div></div></div>"
    );
  }

  function authForm() {
    if (ui.recovery) {
      return (
        '<form id="recovery-form" class="auth-form"><p class="sm fw-500">Set a new password</p>' +
        '<label class="xs">New password<input class="input mt-1" type="password" id="new-password" minlength="6" required autocomplete="new-password" /></label>' +
        (ui.authErr ? '<p class="xs red">' + esc(ui.authErr) + "</p>" : "") +
        '<button type="submit" class="btn btn-green">Save password</button></form>'
      );
    }
    const signup = ui.authMode === "signup";
    return (
      '<form id="auth-form" class="auth-form"><p class="sm muted">Existing CO2 Tracker accounts work here too.</p>' +
      '<label class="xs">Email<input class="input mt-1" type="email" id="auth-email" required autocomplete="email" value="' + esc(ui.authEmail) + '" /></label>' +
      '<label class="xs">Password<input class="input mt-1" type="password" id="auth-password" minlength="6" required autocomplete="' +
      (signup ? "new-password" : "current-password") + '" /></label>' +
      (ui.authErr ? '<p class="xs red">' + esc(ui.authErr) + "</p>" : "") +
      (ui.authMsg ? '<p class="xs green-dark">' + esc(ui.authMsg) + "</p>" : "") +
      '<button type="submit" class="btn btn-green btn-block">' + (signup ? "Create account" : "Sign in") + "</button>" +
      '<div class="chip-row"><button type="button" class="link-btn" data-action="toggle-auth-mode">' + (signup ? "Have an account? Sign in" : "Need an account? Sign up") + "</button>" +
      (signup ? "" : '<button type="button" class="link-btn" data-action="forgot">Forgot password?</button>') + "</div></form>"
    );
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
    try {
      if (ui.authMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: authRedirectUrl() } });
        if (error) throw error;
        if (!data.session) {
          ui.authMsg = "Check your email to confirm your account, then sign in.";
          ui.authMode = "signin";
          return render();
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await afterSignIn();
    } catch (e) {
      ui.authErr = (e && e.message) || "Something went wrong. Please try again.";
      render();
    }
  }

  async function afterSignIn() {
    await refreshUser();
    ui.authMsg = "";
    ui.authErr = "";
    ui.userName = currentUser ? await displayName(currentUser) : "";
    await checkMembership();
    if (membership && membership.access) {
      // Answers entered on this device as a guest are uploaded if the
      // account has nothing saved yet.
      survey = await loadSurvey();
      saveSurveyRemote(survey);
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
    if (ui.recovery) return gateShell("Set a new password", "", authForm());
    const signup = ui.authMode === "signup";
    return gateShell(
      signup ? "Create your account" : "Sign in",
      "Work out your carbon footprint and find your biggest wins.",
      authForm()
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
    "Your answers saved across all your devices",
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
        '<p class="xs muted mt-2 center">Secure payment by Stripe. Renews yearly; cancel any time.</p>' +
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
        '<div class="center mt-5"><button type="button" class="link-btn muted-link" data-action="sign-out">Sign out</button></div>'
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
      '<div class="chip-row mt-5">' + ukPill(cmp) + "</div>" + ukNote(cmp) + "</div></div>" +
      '<div class="card callout strong fade-up"><div class="label-row mb-4"><span class="round-badge sm">' + icon("lock") +
      '</span><span class="eyebrow">Unlock your full results</span></div>' +
      '<h3 class="tip-title">See where your footprint comes from, and how to cut it</h3>' +
      '<div class="price mb-0"><span class="price-num">£2</span><span class="muted"> / year</span></div>' + perksList() +
      '<div class="max-sm">' + joinAction() + "</div></div>" +
      '<div class="btn-row"><a class="btn btn-outline" href="#/">' + icon("refresh") + " Change my answers</a></div>" +
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
    const parts = path.split("/").filter(Boolean);
    let html;
    const member = !!(currentUser && membership && membership.access);
    if (!authChecked || !survey || (currentUser && !membership)) html = spinner;
    else if (ui.recovery) html = renderLogin();
    else if (path === "/") html = renderSurvey();
    else if (path === "/how-we-calculate") html = renderMethod();
    else if (path === "/results") html = member ? renderResults() : renderResultsPreview();
    else if (parts[0] === "explainer" && parts[1]) html = member ? renderExplainer(parts[1]) : renderLocked();
    else if (path === "/check-in") html = member ? renderCheckIn() : renderLocked();
    else if (path === "/habits") html = member ? renderHabits() : renderLocked();
    else if (path === "/account") html = member ? renderAccount() : renderLocked();
    else html = '<div class="container"><div class="empty-card"><h2 class="fw-600 mb-1">Page not found</h2><a class="btn btn-green mt-4" href="#/">Go to the survey</a></div></div>';
    setNav(parts[0] === "explainer" ? "" : path);
    const accountLink = document.querySelector('#nav a[data-route="/account"]');
    if (accountLink) accountLink.textContent = currentUser ? "Account" : "Sign in";
    app.innerHTML = html;
  }

  function onRouteChange() {
    closeModal();
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
        saveSnapshot(footprint(survey).totalYearly);
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
    "toggle-auth-mode": () => {
      ui.authMode = ui.authMode === "signup" ? "signin" : "signup";
      ui.authErr = "";
      ui.authMsg = "";
      render();
    },
    forgot: async () => {
      const email = document.getElementById("auth-email").value.trim();
      ui.authErr = "";
      ui.authMsg = "";
      if (!email) {
        ui.authErr = "Enter your email above first.";
        return render();
      }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl() });
      if (error) ui.authErr = error.message;
      else ui.authMsg = "Check your email for a link to reset your password.";
      render();
    },
    "sign-out": async () => {
      if (sb) await sb.auth.signOut();
      currentUser = null;
      membership = null;
      ui.userName = "";
      ui.authMode = "signin";
      // The next person to use this device shouldn't see these answers.
      lsRemove(KEY_SURVEY);
      survey = normaliseSurvey(null);
      ui.step = 0;
      location.hash = "#/";
      render();
    },
    "start-signup": () => {
      ui.authMode = "signup";
      ui.authErr = "";
      ui.authMsg = "";
      location.hash = "#/account";
      render();
    },
    "start-signin": () => {
      ui.authMode = "signin";
      ui.authErr = "";
      ui.authMsg = "";
      location.hash = "#/account";
      render();
    },
    "recheck-membership": async () => {
      membership = null;
      render();
      await checkMembership();
      if (membership && membership.access) survey = await loadSurvey();
      render();
    },
    "clear-habits": () => {
      CATEGORIES.forEach((c) => lsRemove(KEY_HABITS + c));
      render();
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
    } else if (t.dataset.goal) {
      updateGoal(t.dataset.goal, { deadline: t.value });
      render();
    }
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.id === "auth-form") {
      e.preventDefault();
      submitAuth();
    } else if (e.target.id === "recovery-form") {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: document.getElementById("new-password").value });
      if (error) {
        ui.authErr = error.message;
      } else {
        ui.recovery = false;
        ui.authErr = "";
        await checkMembership();
        survey = await loadSurvey();
      }
      render();
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
    const fromEmail = /access_token|error_description|type=recovery/.test(location.hash + location.search);
    if (/type=recovery/.test(location.hash + location.search)) ui.recovery = true;
    // Stripe sends people back to ?checkout=success after paying.
    const fromCheckout = /checkout=success/.test(location.search);
    render();
    await refreshUser();
    if (fromEmail || fromCheckout) history.replaceState(null, "", location.pathname + (fromCheckout ? "#/results" : "#/"));
    if (currentUser) {
      ui.userName = await displayName(currentUser);
      await checkMembership();
    }
    // Members get their saved answers; everyone else uses this device's.
    survey = await loadSurvey();
    render();
    if (currentUser && !membership.access && fromCheckout) waitForPayment();
    if (sb) {
      sb.auth.onAuthStateChange((event) => {
        if (event === "PASSWORD_RECOVERY") {
          ui.recovery = true;
          render();
        }
      });
    }
  }

  start();
})();
