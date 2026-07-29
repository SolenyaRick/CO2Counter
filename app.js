(function () {
  "use strict";

  const SUPABASE_URL = "https://fbgfylfnbtxzbwgilktt.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiZ2Z5bGZuYnR4emJ3Z2lsa3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwOTg1MjUsImV4cCI6MjEwMDY3NDUyNX0.S-c144dilgUwf8saEjuIQMAp4q-B86R2TRkLV6l9Ym0";

  // If vendor/supabase.js failed to load for any reason, don't let that crash
  // the whole script — surface it on the login screen instead.
  let sbClient = null;
  function initSupabaseClient() {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return true;
    }
    return false;
  }

  const WEEKS_GRID_COUNT = 15;

  const DAYS = [
    { key: "mon", short: "M", full: "Monday" },
    { key: "tue", short: "T", full: "Tuesday" },
    { key: "wed", short: "W", full: "Wednesday" },
    { key: "thu", short: "T", full: "Thursday" },
    { key: "fri", short: "F", full: "Friday" },
    { key: "sat", short: "S", full: "Saturday" },
    { key: "sun", short: "S", full: "Sunday" },
  ];

  // Rough average emission factors, kg CO2e per passenger-km.
  const TRANSPORT_FACTORS = { none: 0, walk: 0, cycle: 0, train: 0.041, car: 0.171 };
  const TRANSPORT_LABELS = { none: "Didn't travel", walk: "Walk", cycle: "Cycle", train: "Train", car: "Car" };

  // Rough average emission factors, kg CO2e per kg of product.
  const MEAT_FACTORS = { chicken: 6, fish: 5, pork: 7, beef: 27, lamb: 25, other: 10 };
  const MEAT_LABELS = { chicken: "Chicken / poultry", fish: "Fish / seafood", pork: "Pork", beef: "Beef", lamb: "Lamb", other: "Other" };
  const MEAT_ICONS = { chicken: "🐔", fish: "🐟", pork: "🐷", beef: "🐄", lamb: "🐑" };
  // Order the meat picker buttons appear in; "other" has no icon button (kept
  // only so older saved entries with that value still compute correctly).
  const MEAT_ICON_ORDER = ["chicken", "pork", "beef", "fish", "lamb"];

  const PORTION_KG = { small: 0.1, medium: 0.15, large: 0.25 };
  const PORTION_LABELS = { small: "Small (~100g)", medium: "Medium (~150g)", large: "Large (~250g+)" };
  const PORTION_SHORT_LABELS = { small: "S", medium: "M", large: "L" };

  const FOOD_DAY_FACTORS = { veggie: 1.5, vegan: 0.9 };
  // The rest of a meat day's food (breakfast, sides, etc.) is valued the same as a
  // vegetarian day, since it isn't any more carbon-efficient — the meat is added on top.
  const MEAT_SIDES_BASELINE = FOOD_DAY_FACTORS.veggie;

  // Wasted food still carries the emissions it took to produce. Modeled as
  // "you have to buy/produce 1/(1-waste%) times what you actually eat", using
  // the midpoint of each bracket as a representative waste percentage.
  const FOOD_WASTE_MULTIPLIERS = { low: 1.02, some: 1.07, high: 1.25, severe: 1.67 };

  // Rough yearly-estimate factors (Stats page), kept separate from the
  // per-day factors above since they're coarser, once-a-year-ish figures.
  const SHORT_HAUL_FLIGHT_KG = 250; // per short-haul European return flight
  const LONG_HAUL_FLIGHT_KG = 1600; // per long-haul international return flight
  const GRID_ELECTRICITY_KG_PER_KWH = 0.2; // rough average grid electricity factor
  const CLOTHING_ITEM_KG = 10; // rough blended average per clothing item

  // Optional Stats-page extras (see DEFAULT_PROFILE). Each is null unless the
  // user actively answers it, and is left OUT of every total when null -
  // never coerced to 0 - so someone who skips a question isn't silently
  // scored as if that category doesn't apply to them.
  const GAS_HEATING_KG_PER_KWH = 0.18; // rough blended gas/oil heating factor
  const CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR = 700; // rough embodied build footprint, amortized over an ~14yr average car lifetime

  const KM_PER_MILE = 1.60934;
  const TREE_KG_PER_YEAR = 22; // rough CO2 absorbed by one mature tree per year

  // ---------- UK average reference ("How your year compares" card) ----------
  // Built bottom-up from representative average UK inputs for exactly the
  // categories this app tracks, run through the same formulas as your own
  // totals - a fair like-for-like comparison, rather than a generic "average
  // UK footprint" statistic that also covers things this app doesn't model
  // at all (see the note on the Stats page for what's missing).
  const UK_AVERAGE_ASSUMPTIONS = {
    commuteOneWayKm: 10, // rough average UK one-way commute, assumed by car (the majority mode)
    // A representative average week's meat: mostly poultry (the most-eaten
    // meat in the UK), with one day each of the next few most common types.
    weeklyMeatDays: [
      { meat: "chicken", portion: "medium" },
      { meat: "chicken", portion: "medium" },
      { meat: "beef", portion: "medium" },
      { meat: "pork", portion: "medium" },
      { meat: "fish", portion: "medium" },
    ],
    weeklyVeggieDays: 2,
    foodWaste: "some", // 3-10%, a representative middle assumption
    shortHaulFlights: 1,
    longHaulFlights: 0.2,
    householdKwhPerYear: 2900, // rough average UK household electricity use
    householdPeople: 2.4, // rough average UK household size
    clothesPerMonth: 3,
    // Representative values for the optional extras below - only folded into
    // the UK reference figure when the current user has answered that same
    // question themselves (see includeOptional in computeUkAverageBreakdown),
    // so the comparison never mixes "your 5 tracked categories" against "the
    // UK's 8 tracked categories".
    annualGasKwh: 12000, // rough typical UK gas-heated household usage/yr
    weeklyNonCommuteCarKm: 50, // rough extra (non-commute) driving per week
  };

  // includeOptional: { gasHeating, nonCommuteCar, carOwnership } booleans -
  // pass whichever optional categories the person being compared against has
  // actually answered, so both sides of the comparison cover the same ground.
  // Returns a per-category breakdown (not just a total) so each domain on
  // the Stats page can show its own "vs UK average" delta.
  function computeUkAverageBreakdown(includeOptional = {}) {
    const a = UK_AVERAGE_ASSUMPTIONS;
    const wasteMult = FOOD_WASTE_MULTIPLIERS[a.foodWaste];

    const commute = TRANSPORT_FACTORS.car * a.commuteOneWayKm * 2 * 52;

    const meatWeekly = a.weeklyMeatDays.reduce((sum, day) => {
      const meatFactor = MEAT_FACTORS[day.meat] ?? MEAT_FACTORS.other;
      const portionKg = PORTION_KG[day.portion] ?? PORTION_KG.medium;
      return sum + (meatFactor * portionKg + MEAT_SIDES_BASELINE) * wasteMult;
    }, 0);
    const veggieWeekly = a.weeklyVeggieDays * FOOD_DAY_FACTORS.veggie * wasteMult;
    const food = (meatWeekly + veggieWeekly) * 52;

    const flying = a.shortHaulFlights * SHORT_HAUL_FLIGHT_KG + a.longHaulFlights * LONG_HAUL_FLIGHT_KG;
    const homeEnergy = (a.householdKwhPerYear * GRID_ELECTRICITY_KG_PER_KWH) / a.householdPeople;
    const goods = a.clothesPerMonth * 12 * CLOTHING_ITEM_KG;

    const gasHeating = includeOptional.gasHeating ? (a.annualGasKwh * GAS_HEATING_KG_PER_KWH) / a.householdPeople : null;
    const nonCommuteCar = includeOptional.nonCommuteCar ? a.weeklyNonCommuteCarKm * TRANSPORT_FACTORS.car * 52 : null;
    const carOwnership = includeOptional.carOwnership ? CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR : null;

    const total = commute + food + flying + homeEnergy + goods + (gasHeating || 0) + (nonCommuteCar || 0) + (carOwnership || 0);
    return { commute, food, flying, homeEnergy, goods, gasHeating, nonCommuteCar, carOwnership, total };
  }

  const DEFAULT_PROFILE = {
    name: "",
    commuteDistanceKm: 8,
    weeklyGoalKg: 20,
    foodWaste: "low",
    shortHaulFlights: 0,
    longHaulFlights: 0,
    householdPeople: 1,
    householdKwhPerMonth: 0,
    clothesPerMonth: 0,
    // Optional extras: null means "not answered", and stays out of every
    // total (never coerced to 0) until the person actually answers.
    annualGasKwh: null,
    weeklyNonCommuteCarKm: null,
    ownsCar: null,
  };

  function blankWeek() {
    return {
      commute: Object.fromEntries(DAYS.map((d) => [d.key, "none"])),
      diet: Object.fromEntries(DAYS.map((d) => [d.key, { type: "" }])),
      confirmedCommute: Object.fromEntries(DAYS.map((d) => [d.key, false])),
      confirmedDiet: Object.fromEntries(DAYS.map((d) => [d.key, false])),
    };
  }

  // ---------- Date / week-key helpers ----------
  // A week is keyed by its Monday's date, e.g. "2026-07-20".
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

  function weekStart(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    const day = (copy.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
    copy.setDate(copy.getDate() - day);
    return copy;
  }

  function weekKeyFor(d) { return dateKey(weekStart(d)); }

  // Monday = 1 ... Sunday = 7.
  function todayIndexInWeek() {
    const today = new Date();
    // floor, not round: any time during Wednesday (00:00-23:59) is 2.x full
    // days after Monday 00:00, and must stay day-index 3 (Wed) all day, not
    // round up to 4 (Thu) once past midday.
    const days = Math.floor((today - weekStart(today)) / (24 * 60 * 60 * 1000));
    return days + 1;
  }

  function todayDayKey() {
    return DAYS[todayIndexInWeek() - 1].key;
  }

  function weekLabel(weekKey) {
    const monday = new Date(`${weekKey}T00:00:00`);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const opts = { day: "numeric", month: "short" };
    const start = monday.toLocaleDateString("en-GB", opts);
    const sameYear = monday.getFullYear() === new Date().getFullYear();
    const end = sunday.toLocaleDateString("en-GB", sameYear ? opts : { ...opts, year: "numeric" });
    return `${start} – ${end}`;
  }

  function shiftedWeekKey(weekKey, deltaWeeks) {
    const monday = new Date(`${weekKey}T00:00:00`);
    monday.setDate(monday.getDate() + deltaWeeks * 7);
    return dateKey(monday);
  }

  const CURRENT_WEEK_KEY = weekKeyFor(new Date());
  const LAST_WEEK_KEY = shiftedWeekKey(CURRENT_WEEK_KEY, -1);

  // ---------- Signed-in state ----------
  let currentUser = null;
  let loadedUserId = null;
  let expectingPasswordRecovery = false;
  let profile = { ...DEFAULT_PROFILE };
  let weeksCache = {}; // week_key -> { commute, diet, confirmedCommute, confirmedDiet, total_kg? }
  let friendships = []; // [{ id, status, otherId, otherName, iAmRequester }]
  let friendExtrasById = {}; // otherId -> { shortHaulFlights, longHaulFlights, householdKwhPerMonth, householdPeople }
  // Which week the This Week page is currently showing/editing.
  let selectedWeekKey = CURRENT_WEEK_KEY;

  function getWeek(weekKey) {
    if (!weeksCache[weekKey]) weeksCache[weekKey] = blankWeek();
    return weeksCache[weekKey];
  }

  // Any picks made at all, confirmed or still a draft.
  function hasAnyEntries(weekData) {
    if (!weekData) return false;
    const commuted = Object.values(weekData.commute).some((m) => m && m !== "none");
    const ate = Object.values(weekData.diet).some((e) => e && e.type);
    return commuted || ate;
  }

  // At least one day actually confirmed - this is what "counts" everywhere
  // (Weeks grid totals, leaderboard eligibility), as opposed to hasAnyEntries
  // above, which is also true for a week that's all unconfirmed drafts.
  function hasAnyConfirmed(weekData) {
    if (!weekData) return false;
    const commuted = Object.values(weekData.confirmedCommute || {}).some(Boolean);
    const ate = Object.values(weekData.confirmedDiet || {}).some(Boolean);
    return commuted || ate;
  }

  // ---------- Footprint math ----------
  function commuteFootprint(weekData, dayKey) {
    const mode = weekData.commute[dayKey];
    const factor = TRANSPORT_FACTORS[mode] ?? 0;
    return factor * (profile.commuteDistanceKm || 0) * 2;
  }

  function wasteMultiplier() {
    return FOOD_WASTE_MULTIPLIERS[profile.foodWaste] ?? 1;
  }

  function foodFootprint(weekData, dayKey) {
    const entry = weekData.diet[dayKey];
    if (!entry || !entry.type) return 0;
    let base;
    if (entry.type === "vegan") base = FOOD_DAY_FACTORS.vegan;
    else if (entry.type === "veggie") base = FOOD_DAY_FACTORS.veggie;
    else if (entry.type === "meat") {
      const meatFactor = MEAT_FACTORS[entry.meat] ?? MEAT_FACTORS.other;
      const portionKg = PORTION_KG[entry.portion] ?? PORTION_KG.medium;
      base = meatFactor * portionKg + MEAT_SIDES_BASELINE;
    } else {
      return 0;
    }
    return base * wasteMultiplier();
  }

  // How much extra a meat choice adds on top of an equivalent veggie day —
  // exactly the meat portion's own footprint, since the baseline for the
  // rest of the day is valued the same either way.
  function meatExtra(entry) {
    const meatFactor = MEAT_FACTORS[entry.meat] ?? MEAT_FACTORS.other;
    const portionKg = PORTION_KG[entry.portion] ?? PORTION_KG.medium;
    return meatFactor * portionKg * wasteMultiplier();
  }

  // Confirmed days count toward totals/chart/leaderboard; picked-but-unconfirmed
  // days are saved as drafts (so nothing is lost) but contribute 0 until confirmed.
  function countedCommuteFootprint(weekData, dayKey) {
    return weekData.confirmedCommute?.[dayKey] ? commuteFootprint(weekData, dayKey) : 0;
  }

  function countedFoodFootprint(weekData, dayKey) {
    return weekData.confirmedDiet?.[dayKey] ? foodFootprint(weekData, dayKey) : 0;
  }

  function veggieSavings(weekData) {
    let total = 0;
    const byType = {};
    DAYS.forEach((day) => {
      const entry = weekData.diet[day.key];
      if (entry && entry.type === "meat" && weekData.confirmedDiet?.[day.key]) {
        const extra = meatExtra(entry);
        total += extra;
        byType[entry.meat] = (byType[entry.meat] || 0) + extra;
      }
    });
    return { total, byType };
  }

  function weekTotals(weekData) {
    let commute = 0;
    let food = 0;
    const daily = [];
    DAYS.forEach((day) => {
      const c = countedCommuteFootprint(weekData, day.key);
      const f = countedFoodFootprint(weekData, day.key);
      commute += c;
      food += f;
      daily.push(c + f);
    });
    return { commute, food, total: commute + food, daily };
  }

  function fmt(n) { return n.toFixed(1); }

  // Standard normal CDF via the Abramowitz & Stegun 7.1.26 approximation -
  // used to turn a yearly total into a rough UK percentile (see below).
  function normalCdf(z) {
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  }

  // Rough illustrative percentile: models UK personal footprints as
  // log-normal around a UK average (used as the median, computed for the
  // same set of optional categories as yourYearlyKg - see
  // computeUkAverageBreakdown), with an assumed spread - not based on real
  // ONS/population distribution data.
  function ukPercentileBetterThan(yourYearlyKg, ukAverageYearlyKg) {
    if (!yourYearlyKg || yourYearlyKg <= 0) return null;
    const sigma = 0.5;
    const z = (Math.log(yourYearlyKg) - Math.log(ukAverageYearlyKg)) / sigma;
    return (1 - normalCdf(z)) * 100;
  }

  // ---------- Supabase: profile ----------
  async function ensureProfile() {
    const { data } = await sbClient.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
    if (data) {
      profile = {
        name: data.display_name || "",
        commuteDistanceKm: data.commute_distance_km ?? DEFAULT_PROFILE.commuteDistanceKm,
        weeklyGoalKg: data.weekly_goal_kg ?? DEFAULT_PROFILE.weeklyGoalKg,
        foodWaste: data.food_waste_bracket ?? DEFAULT_PROFILE.foodWaste,
        shortHaulFlights: data.short_haul_flights_per_year ?? DEFAULT_PROFILE.shortHaulFlights,
        longHaulFlights: data.long_haul_flights_per_year ?? DEFAULT_PROFILE.longHaulFlights,
        householdPeople: data.household_people ?? DEFAULT_PROFILE.householdPeople,
        householdKwhPerMonth: data.household_kwh_per_month ?? DEFAULT_PROFILE.householdKwhPerMonth,
        clothesPerMonth: data.clothes_per_month ?? DEFAULT_PROFILE.clothesPerMonth,
        annualGasKwh: data.annual_gas_kwh ?? null,
        weeklyNonCommuteCarKm: data.weekly_noncommute_car_km ?? null,
        ownsCar: data.owns_car ?? null,
      };
    } else {
      profile = { ...DEFAULT_PROFILE };
      await persistProfile(); // upsert acts as the initial insert here too
    }
  }

  function profileToRow() {
    return {
      id: currentUser.id,
      display_name: profile.name,
      commute_distance_km: profile.commuteDistanceKm,
      weekly_goal_kg: profile.weeklyGoalKg,
      food_waste_bracket: profile.foodWaste,
      short_haul_flights_per_year: profile.shortHaulFlights,
      long_haul_flights_per_year: profile.longHaulFlights,
      household_people: profile.householdPeople,
      household_kwh_per_month: profile.householdKwhPerMonth,
      clothes_per_month: profile.clothesPerMonth,
      annual_gas_kwh: profile.annualGasKwh,
      weekly_noncommute_car_km: profile.weeklyNonCommuteCarKm,
      owns_car: profile.ownsCar,
    };
  }

  let profileSaveErrorShown = false;

  async function persistProfile() {
    if (!currentUser) return;
    const { error } = await sbClient.from("profiles").upsert(profileToRow());
    const statusEl = document.getElementById("profile-sync-status");
    if (error) {
      console.error("Failed to save profile", error);
      if (statusEl) {
        statusEl.textContent = "Save failed — see console";
        statusEl.className = "sync-status sync-error";
      }
      // Alert once per session rather than on every keystroke, but make sure
      // a real save failure (e.g. an out-of-date database schema) is never
      // silent - this used to fail quietly and lose changes.
      if (!profileSaveErrorShown) {
        profileSaveErrorShown = true;
        alert(
          "Couldn't save your profile/settings changes: " + error.message +
          "\n\nThis usually means the Supabase database schema needs updating " +
          "(re-run the latest supabase/schema.sql). Your change is NOT saved."
        );
      }
    } else if (statusEl) {
      statusEl.textContent = "Saved";
      statusEl.className = "sync-status";
      setTimeout(() => {
        if (statusEl.textContent === "Saved") statusEl.textContent = "";
      }, 1500);
    }
  }

  // ---------- Supabase: weeks ----------
  async function loadAllWeeks() {
    weeksCache = {};
    const { data } = await sbClient.from("weeks").select("*").eq("user_id", currentUser.id);
    (data || []).forEach((row) => {
      const blank = blankWeek();
      weeksCache[row.week_key] = {
        commute: row.commute,
        diet: row.diet,
        // Fall back to all-false for rows saved before these columns existed.
        confirmedCommute: { ...blank.confirmedCommute, ...(row.confirmed_commute || {}) },
        confirmedDiet: { ...blank.confirmedDiet, ...(row.confirmed_diet || {}) },
        total_kg: row.total_kg,
      };
    });
  }

  function showSyncStatus(state) {
    const el = document.getElementById("sync-status");
    if (!el) return;
    if (state === "saving") {
      el.textContent = "Saving…";
      el.className = "sync-status";
    } else if (state === "saved") {
      el.textContent = "Saved";
      el.className = "sync-status";
      setTimeout(() => {
        if (el.textContent === "Saved") el.textContent = "";
      }, 1500);
    } else {
      el.textContent = "Sync failed — check your connection";
      el.className = "sync-status sync-error";
    }
  }

  let weekSaveErrorShown = false;

  async function persistWeek(weekKey) {
    if (!currentUser) return;
    const weekData = getWeek(weekKey);
    const totals = weekTotals(weekData);
    showSyncStatus("saving");
    const { error } = await sbClient.from("weeks").upsert(
      {
        user_id: currentUser.id,
        week_key: weekKey,
        commute: weekData.commute,
        diet: weekData.diet,
        confirmed_commute: weekData.confirmedCommute,
        confirmed_diet: weekData.confirmedDiet,
        total_kg: totals.total,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,week_key" }
    );
    showSyncStatus(error ? "error" : "saved");
    if (error) {
      console.error("Failed to save week", error);
      if (!weekSaveErrorShown) {
        weekSaveErrorShown = true;
        alert(
          "Couldn't save this week's changes: " + error.message +
          "\n\nThis usually means the Supabase database schema needs updating " +
          "(re-run the latest supabase/schema.sql). Your change is NOT saved."
        );
      }
    }
  }

  // ---------- Supabase: friends ----------
  async function loadFriends() {
    if (!currentUser) return;
    const me = currentUser.id;
    const { data: rows, error } = await sbClient
      .from("friendships")
      .select("*")
      .or(`requester_id.eq.${me},addressee_id.eq.${me}`);

    if (error || !rows) {
      friendships = [];
      return;
    }

    const otherIds = [...new Set(rows.map((r) => (r.requester_id === me ? r.addressee_id : r.requester_id)))];
    let namesById = {};
    friendExtrasById = {};
    if (otherIds.length > 0) {
      const { data: profs } = await sbClient
        .from("profiles")
        .select("id, display_name, short_haul_flights_per_year, long_haul_flights_per_year, household_kwh_per_month, household_people")
        .in("id", otherIds);
      (profs || []).forEach((p) => {
        namesById[p.id] = p.display_name || "(no name set)";
        friendExtrasById[p.id] = {
          shortHaulFlights: p.short_haul_flights_per_year ?? 0,
          longHaulFlights: p.long_haul_flights_per_year ?? 0,
          householdKwhPerMonth: p.household_kwh_per_month ?? 0,
          householdPeople: p.household_people ?? 1,
        };
      });
    }

    friendships = rows.map((r) => {
      const otherId = r.requester_id === me ? r.addressee_id : r.requester_id;
      return {
        id: r.id,
        status: r.status,
        otherId,
        otherName: namesById[otherId] || "(pending profile)",
        iAmRequester: r.requester_id === me,
      };
    });
  }

  function fillFriendList(elementId, items, actionsFor) {
    const el = document.getElementById(elementId);
    el.innerHTML = "";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "friend-row";
      const name = document.createElement("span");
      name.textContent = item.otherName;
      li.appendChild(name);

      const actions = document.createElement("span");
      actions.className = "friend-actions";
      actionsFor(item).forEach(({ label, className, onClick }) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = className;
        btn.textContent = label;
        btn.addEventListener("click", onClick);
        actions.appendChild(btn);
      });
      li.appendChild(actions);
      el.appendChild(li);
    });
  }

  function renderFriendsUI() {
    const incoming = friendships.filter((f) => f.status === "pending" && !f.iAmRequester);
    const outgoing = friendships.filter((f) => f.status === "pending" && f.iAmRequester);
    const accepted = friendships.filter((f) => f.status === "accepted");

    fillFriendList("incoming-requests", incoming, (f) => [
      { label: "Accept", className: "btn-primary", onClick: () => respondToFriendRequest(f.id, true) },
      { label: "Decline", className: "btn-secondary", onClick: () => respondToFriendRequest(f.id, false) },
    ]);
    fillFriendList("outgoing-requests", outgoing, (f) => [
      { label: "Cancel", className: "btn-secondary", onClick: () => removeFriendship(f.id) },
    ]);
    fillFriendList("friends-list", accepted, (f) => [
      { label: "Remove", className: "btn-secondary", onClick: () => removeFriendship(f.id) },
    ]);
  }

  async function respondToFriendRequest(id, accept) {
    if (accept) {
      await sbClient.from("friendships").update({ status: "accepted" }).eq("id", id);
    } else {
      await sbClient.from("friendships").delete().eq("id", id);
    }
    await loadFriends();
    renderFriendsUI();
    renderLeaderboard();
    renderWeeklyAverageLeaderboard();
  }

  async function removeFriendship(id) {
    await sbClient.from("friendships").delete().eq("id", id);
    await loadFriends();
    renderFriendsUI();
    renderLeaderboard();
    renderWeeklyAverageLeaderboard();
  }

  async function addFriendByEmail(email) {
    const errorEl = document.getElementById("friend-error");
    errorEl.hidden = true;
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) return;

    const { data: foundId, error } = await sbClient.rpc("find_user_by_email", { lookup_email: cleanEmail });
    if (error) {
      errorEl.textContent = "Something went wrong looking that up.";
      errorEl.hidden = false;
      return;
    }
    if (!foundId) {
      errorEl.textContent = "No account found with that email.";
      errorEl.hidden = false;
      return;
    }
    if (foundId === currentUser.id) {
      errorEl.textContent = "That's your own account.";
      errorEl.hidden = false;
      return;
    }

    const existing = friendships.find((f) => f.otherId === foundId);
    if (existing?.status === "accepted") {
      errorEl.textContent = "Already friends.";
      errorEl.hidden = false;
      return;
    }
    if (existing?.status === "pending" && existing.iAmRequester) {
      errorEl.textContent = "Request already sent.";
      errorEl.hidden = false;
      return;
    }
    if (existing?.status === "pending" && !existing.iAmRequester) {
      await respondToFriendRequest(existing.id, true);
      return;
    }

    const { error: insertError } = await sbClient
      .from("friendships")
      .insert({ requester_id: currentUser.id, addressee_id: foundId, status: "pending" });
    if (insertError) {
      errorEl.textContent = "Could not send request.";
      errorEl.hidden = false;
      return;
    }
    await loadFriends();
    renderFriendsUI();
  }

  // ---------- Tab routing ----------
  const TABS = ["week", "weeks", "leaderboard", "stats", "account"];

  function currentTab() {
    const fromHash = (location.hash || "").replace("#", "");
    return TABS.includes(fromHash) ? fromHash : "week";
  }

  function showTab(tab) {
    TABS.forEach((t) => {
      document.getElementById(`view-${t}`).hidden = t !== tab;
    });
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    if (tab === "weeks") renderWeeksGrid();
    if (tab === "leaderboard") { renderLeaderboard(); renderWeeklyAverageLeaderboard(); renderAppWideAverage(); }
    if (tab === "stats") renderStatsPage();
    if (tab === "account") renderAccountPage();
    if (tab === "week") renderWeekPage();
  }

  // ---------- Page 1: This Week ----------
  function createConfirmButton(weekData, kind, dayKey) {
    const confirmedMap = kind === "commute" ? weekData.confirmedCommute : weekData.confirmedDiet;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-confirm-btn" + (confirmedMap[dayKey] ? " confirmed" : "");
    btn.textContent = "✓";
    btn.setAttribute("aria-label", `Confirm ${dayKey} entry`);
    btn.addEventListener("click", () => {
      confirmedMap[dayKey] = true;
      btn.classList.remove("pop");
      void btn.offsetWidth; // restart the animation if clicked again
      btn.classList.add("confirmed", "pop");
      persistWeek(selectedWeekKey);
      renderFootprints();
    });
    return btn;
  }

  function buildCommuteTable() {
    const weekData = getWeek(selectedWeekKey);
    const tbody = document.querySelector("#commute-table tbody");
    tbody.innerHTML = "";
    const todayKey = selectedWeekKey === CURRENT_WEEK_KEY ? todayDayKey() : null;
    DAYS.forEach((day) => {
      const tr = document.createElement("tr");
      if (day.key === todayKey) tr.classList.add("is-today");

      const dayTd = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "day-badge";
      badge.title = day.key === todayKey ? `${day.full} (today)` : day.full;
      badge.textContent = day.short;
      dayTd.appendChild(badge);
      tr.appendChild(dayTd);

      const modeTd = document.createElement("td");
      const select = document.createElement("select");
      select.className = "mode-select";
      select.setAttribute("aria-label", `Commute mode for ${day.full}`);
      Object.keys(TRANSPORT_LABELS).forEach((mode) => {
        const opt = document.createElement("option");
        opt.value = mode;
        opt.textContent = TRANSPORT_LABELS[mode];
        select.appendChild(opt);
      });
      select.value = weekData.commute[day.key];
      const confirmBtn = createConfirmButton(weekData, "commute", day.key);
      select.addEventListener("change", () => {
        weekData.commute[day.key] = select.value;
        weekData.confirmedCommute[day.key] = false;
        confirmBtn.classList.remove("confirmed", "pop");
        persistWeek(selectedWeekKey);
        renderFootprints();
      });
      modeTd.appendChild(select);
      tr.appendChild(modeTd);

      const footTd = document.createElement("td");
      footTd.className = "row-footprint";
      footTd.dataset.commuteFootprint = day.key;
      tr.appendChild(footTd);

      const confirmTd = document.createElement("td");
      confirmTd.className = "day-confirm-cell";
      confirmTd.appendChild(confirmBtn);
      tr.appendChild(confirmTd);

      tbody.appendChild(tr);
    });
  }

  function dietSummaryText(entry) {
    if (!entry || entry.type !== "meat") return "";
    return `${MEAT_LABELS[entry.meat] ?? "Meat"} – ${PORTION_LABELS[entry.portion] ?? ""}`;
  }

  function setDietEntry(weekData, dayKey, entry, confirmBtn) {
    weekData.diet[dayKey] = entry;
    weekData.confirmedDiet[dayKey] = false;
    confirmBtn.classList.remove("confirmed", "pop");
    persistWeek(selectedWeekKey);
    buildDietTable();
    renderFootprints();
  }

  function buildDietTable() {
    const weekData = getWeek(selectedWeekKey);
    const container = document.getElementById("diet-table");
    container.innerHTML = "";
    const todayKey = selectedWeekKey === CURRENT_WEEK_KEY ? todayDayKey() : null;
    DAYS.forEach((day) => {
      const row = document.createElement("div");
      row.className = "diet-day-row";
      if (day.key === todayKey) row.classList.add("is-today");

      const head = document.createElement("div");
      head.className = "diet-day-head";

      const badge = document.createElement("span");
      badge.className = "day-badge";
      badge.title = day.key === todayKey ? `${day.full} (today)` : day.full;
      badge.textContent = day.short;
      head.appendChild(badge);

      const cell = document.createElement("div");
      cell.className = "diet-cell";
      const entry = weekData.diet[day.key];

      const confirmBtn = createConfirmButton(weekData, "diet", day.key);

      const typeRow = document.createElement("div");
      typeRow.className = "diet-type-row";
      typeRow.setAttribute("role", "group");
      typeRow.setAttribute("aria-label", `Diet for ${day.full}`);

      function makeOption(type, meat, label, title) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "diet-opt" + (meat ? " meat-opt" : "");
        btn.textContent = label;
        btn.title = title;
        btn.setAttribute("aria-label", title);
        const isActive = entry?.type === type && (!meat || entry.meat === meat);
        btn.classList.toggle("active", isActive);
        btn.addEventListener("click", () => {
          if (type === "meat") {
            setDietEntry(weekData, day.key, { type: "meat", meat, portion: entry?.meat === meat ? entry.portion : "medium" }, confirmBtn);
          } else {
            setDietEntry(weekData, day.key, { type }, confirmBtn);
          }
        });
        return btn;
      }

      typeRow.appendChild(makeOption("vegan", null, "Ve", "Vegan"));
      typeRow.appendChild(makeOption("veggie", null, "Vg", "Veggie"));
      MEAT_ICON_ORDER.forEach((meat) => {
        typeRow.appendChild(makeOption("meat", meat, MEAT_ICONS[meat], MEAT_LABELS[meat]));
      });
      cell.appendChild(typeRow);

      if (entry?.type === "meat") {
        const portionRow = document.createElement("div");
        portionRow.className = "portion-row";
        portionRow.setAttribute("role", "group");
        portionRow.setAttribute("aria-label", `Portion size for ${day.full}`);
        ["small", "medium", "large"].forEach((portion) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "portion-opt";
          btn.textContent = PORTION_SHORT_LABELS[portion];
          btn.title = PORTION_LABELS[portion];
          btn.setAttribute("aria-label", PORTION_LABELS[portion]);
          btn.classList.toggle("active", entry.portion === portion);
          btn.addEventListener("click", () => {
            setDietEntry(weekData, day.key, { ...entry, portion }, confirmBtn);
          });
          portionRow.appendChild(btn);
        });
        cell.appendChild(portionRow);

        const summary = document.createElement("span");
        summary.className = "diet-summary";
        summary.textContent = dietSummaryText(entry);
        cell.appendChild(summary);
      }

      const footprint = document.createElement("span");
      footprint.className = "row-footprint";
      footprint.dataset.foodFootprint = day.key;
      head.appendChild(footprint);
      head.appendChild(confirmBtn);

      row.appendChild(head);
      row.appendChild(cell);
      container.appendChild(row);
    });
  }

  function weekPickerHeading(weekKey) {
    if (weekKey === CURRENT_WEEK_KEY) return "This week";
    if (weekKey === LAST_WEEK_KEY) return "Last week";
    return weekLabel(weekKey);
  }

  function renderFootprints() {
    const weekData = getWeek(selectedWeekKey);
    const totals = weekTotals(weekData);

    DAYS.forEach((day) => {
      // Preview values always show what a day WOULD contribute; only confirmed
      // days actually count toward the totals below (see weekTotals()).
      const c = commuteFootprint(weekData, day.key);
      const f = foodFootprint(weekData, day.key);
      const cCell = document.querySelector(`[data-commute-footprint="${day.key}"]`);
      if (cCell) {
        cCell.textContent = c > 0 ? `${fmt(c)} kg` : "–";
        cCell.classList.toggle("counted", Boolean(weekData.confirmedCommute[day.key]));
      }
      const fCell = document.querySelector(`[data-food-footprint="${day.key}"]`);
      if (fCell) {
        fCell.textContent = f > 0 ? `${fmt(f)} kg` : "–";
        fCell.classList.toggle("counted", Boolean(weekData.confirmedDiet[day.key]));
      }
    });

    document.getElementById("total-commute").textContent = fmt(totals.commute);
    document.getElementById("total-food").textContent = fmt(totals.food);
    document.getElementById("total-week").textContent = fmt(totals.total);
    document.getElementById("week-range-heading").firstChild.textContent =
      `${weekPickerHeading(selectedWeekKey)} (${weekLabel(selectedWeekKey)}) `;

    document.querySelectorAll(".week-picker-btn").forEach((btn) => {
      const isCurrent = btn.dataset.week === "current";
      btn.classList.toggle("active", isCurrent ? selectedWeekKey === CURRENT_WEEK_KEY : selectedWeekKey === LAST_WEEK_KEY);
    });

    renderComparisonCard(weekData, totals);
    renderChart(totals.daily, selectedWeekKey);
  }

  function renderComparisonCard(weekData, totals) {
    const carKm = totals.total / TRANSPORT_FACTORS.car;
    document.getElementById("car-km-value").textContent = Math.round(carKm).toLocaleString();

    const savings = veggieSavings(weekData);
    const valueEl = document.getElementById("savings-value");
    const labelEl = document.getElementById("savings-label");
    const breakdownEl = document.getElementById("savings-breakdown");
    breakdownEl.innerHTML = "";

    if (savings.total <= 0) {
      valueEl.textContent = "0.0";
      labelEl.textContent = "kg CO2e · no confirmed meat days";
      return;
    }

    valueEl.textContent = fmt(savings.total);
    labelEl.textContent = "kg CO2e · would save if meat days were veggie";

    Object.entries(savings.byType)
      .sort((a, b) => b[1] - a[1])
      .forEach(([meat, kg]) => {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = MEAT_LABELS[meat] ?? "Meat";
        const value = document.createElement("span");
        value.textContent = `${fmt(kg)} kg`;
        li.appendChild(label);
        li.appendChild(value);
        breakdownEl.appendChild(li);
      });
  }

  // Monzo Trends-style "budget pace" chart: a dashed target line burns down
  // from the weekly goal to 0 in a straight line across Mon-Sun, and a solid
  // line tracks your actual remaining budget (goal minus CO2e confirmed so
  // far). Falling below the dashed line means you're using CO2e faster than
  // the goal allows for how far through the week it is; staying above it
  // means you're on pace or ahead. For the current week, the actual line
  // only draws up to today - it doesn't project forward.
  function renderChart(dailyTotals, weekKey) {
    const chart = document.getElementById("daily-chart");
    chart.innerHTML = "";

    const goal = Math.max(0.0001, currentGoal());
    const cumulative = [0];
    dailyTotals.forEach((d, i) => cumulative.push(cumulative[i] + d));
    const remaining = cumulative.map((c) => goal - c);

    const predicted = [];
    for (let j = 0; j <= 7; j++) predicted.push(goal * (1 - j / 7));

    const isCurrentWeek = weekKey === CURRENT_WEEK_KEY;
    const pointCount = isCurrentWeek ? Math.min(todayIndexInWeek(), 7) : 7;
    const actualPoints = remaining.slice(0, pointCount + 1);

    // Match the viewBox to the chart's actual rendered pixel width so 1 SVG
    // unit = 1 real pixel in both axes - otherwise a fixed viewBox stretched
    // to fit varying card widths distorts strokes, dots, and text
    // horizontally (preserveAspectRatio="none" scales x/y independently).
    // Falls back to 340 if the chart is currently hidden (width 0), e.g.
    // when a change on another tab re-renders it in the background; it's
    // recomputed correctly next time the week tab is actually shown.
    // Height scales with width (instead of a fixed 160px) so the chart
    // doesn't go flat and thin on wide screens - clamped so it doesn't get
    // absurdly tall either.
    const W = chart.getBoundingClientRect().width || 340;
    const H = Math.max(140, Math.min(230, W / 2.3));
    const PAD_TOP = 14, PAD_BOTTOM = 26, PAD_X = 6;
    const plotW = W - PAD_X * 2;
    const plotH = H - PAD_TOP - PAD_BOTTOM;

    const allValues = predicted.concat(actualPoints);
    const yMax = Math.max(goal, ...allValues);
    const yMin = Math.min(0, ...allValues);
    const yRange = Math.max(0.0001, yMax - yMin);

    const xAt = (j) => PAD_X + (j / 7) * plotW;
    const yAt = (v) => PAD_TOP + (1 - (v - yMin) / yRange) * plotH;
    const pathFor = (values) => values.map((v, j) => `${j === 0 ? "M" : "L"}${xAt(j).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

    const predictedPath = pathFor(predicted);
    const actualPath = pathFor(actualPoints);
    const lastJ = actualPoints.length - 1;
    const finalActual = actualPoints[lastJ];
    const onTrack = finalActual >= predicted[lastJ];
    const zeroY = yAt(0).toFixed(1);
    const areaPath = `${actualPath} L${xAt(lastJ).toFixed(1)},${zeroY} L${xAt(0).toFixed(1)},${zeroY} Z`;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    svg.setAttribute("class", `budget-chart-svg ${onTrack ? "on-track" : "over-track"}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Budget pace: ${onTrack ? "on track" : "over pace"}, ${fmt(Math.abs(finalActual))} kg CO2e ${finalActual >= 0 ? "remaining" : "over"}`);

    const defs = document.createElementNS(svgNS, "defs");
    const gradient = document.createElementNS(svgNS, "linearGradient");
    gradient.setAttribute("id", "budget-area-fill");
    gradient.setAttribute("x1", "0"); gradient.setAttribute("y1", "0");
    gradient.setAttribute("x2", "0"); gradient.setAttribute("y2", "1");
    const stop1 = document.createElementNS(svgNS, "stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("class", "budget-fill-stop-start");
    const stop2 = document.createElementNS(svgNS, "stop");
    stop2.setAttribute("offset", "100%");
    stop2.setAttribute("class", "budget-fill-stop-end");
    gradient.appendChild(stop1);
    gradient.appendChild(stop2);
    defs.appendChild(gradient);
    svg.appendChild(defs);

    if (yMin < 0) {
      const zeroLine = document.createElementNS(svgNS, "line");
      zeroLine.setAttribute("x1", xAt(0)); zeroLine.setAttribute("x2", xAt(7));
      zeroLine.setAttribute("y1", zeroY); zeroLine.setAttribute("y2", zeroY);
      zeroLine.setAttribute("class", "budget-zero-line");
      svg.appendChild(zeroLine);
    }

    const area = document.createElementNS(svgNS, "path");
    area.setAttribute("d", areaPath);
    area.setAttribute("class", "budget-area");
    svg.appendChild(area);

    const predictedLine = document.createElementNS(svgNS, "path");
    predictedLine.setAttribute("d", predictedPath);
    predictedLine.setAttribute("class", "budget-predicted-line");
    svg.appendChild(predictedLine);

    const actualLine = document.createElementNS(svgNS, "path");
    actualLine.setAttribute("d", actualPath);
    actualLine.setAttribute("class", "budget-actual-line");
    svg.appendChild(actualLine);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", xAt(lastJ));
    dot.setAttribute("cy", yAt(finalActual));
    dot.setAttribute("r", 3.2);
    dot.setAttribute("class", "budget-actual-dot");
    svg.appendChild(dot);

    const goalLabel = document.createElementNS(svgNS, "text");
    goalLabel.textContent = `${fmt(goal)} kg goal`;
    goalLabel.setAttribute("x", xAt(0));
    goalLabel.setAttribute("y", Math.max(9, yAt(goal) - 5));
    goalLabel.setAttribute("class", "budget-axis-label");
    svg.appendChild(goalLabel);

    if (yMin < 0) {
      const zeroLabel = document.createElementNS(svgNS, "text");
      zeroLabel.textContent = "0";
      zeroLabel.setAttribute("x", xAt(0));
      zeroLabel.setAttribute("y", Number(zeroY) - 3);
      zeroLabel.setAttribute("class", "budget-axis-label");
      svg.appendChild(zeroLabel);
    }

    // Each day's tick sits at the boundary point representing "as of the end
    // of that day" (j = i + 1) - the same x each day's line vertex and, for
    // today, the actual-value dot are drawn at - so the label lines up
    // directly under its data point instead of under the middle of a column.
    DAYS.forEach((day, i) => {
      const isToday = isCurrentWeek && i + 1 === todayIndexInWeek();
      const label = document.createElementNS(svgNS, "text");
      label.textContent = day.short;
      label.setAttribute("x", xAt(i + 1).toFixed(1));
      label.setAttribute("y", H - 6);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "budget-day-label" + (isToday ? " is-today" : ""));
      svg.appendChild(label);
    });

    chart.appendChild(svg);

    const legend = document.createElement("div");
    legend.className = "budget-chart-legend";
    legend.innerHTML = `
      <span class="legend-item"><span class="legend-swatch legend-swatch-target"></span>Target pace</span>
      <span class="legend-item"><span class="legend-swatch legend-swatch-actual ${onTrack ? "on-track" : "over-track"}"></span>${onTrack ? "On pace" : "Over pace"} &middot; ${fmt(Math.abs(finalActual))} kg ${finalActual >= 0 ? "left" : "over goal"}</span>
    `;
    chart.appendChild(legend);
  }

  function renderWeekPage() {
    buildCommuteTable();
    buildDietTable();
    renderFootprints();
  }

  // ---------- Page 2: Weeks grid ----------
  function currentGoal() { return profile.weeklyGoalKg || DEFAULT_PROFILE.weeklyGoalKg; }

  // The week that's still in progress hasn't had a chance to earn a full
  // week's worth of CO2e yet, so comparing it against the full weekly goal
  // would make "under goal" trivially true on day 1. Prorate the goal for
  // the current week only, based on how much of the week has elapsed so
  // far (Monday = 1/7, ... Sunday = 7/7); past/completed weeks still use
  // the full goal.
  function goalForWeek(weekKey) {
    const fullGoal = currentGoal();
    if (weekKey !== CURRENT_WEEK_KEY) return fullGoal;
    return fullGoal * (todayIndexInWeek() / 7);
  }

  function statusClass(total, started, goal) {
    if (!started) return "status-empty";
    if (total <= goal) return "status-good";
    if (total <= goal * 1.3) return "status-warn";
    return "status-high";
  }

  function renderWeeksGrid() {
    const grid = document.getElementById("weeks-grid");
    grid.innerHTML = "";
    for (let i = 0; i < WEEKS_GRID_COUNT; i++) {
      const key = shiftedWeekKey(CURRENT_WEEK_KEY, -i);
      const weekData = weeksCache[key];
      const started = hasAnyConfirmed(weekData);
      const totals = started ? weekTotals(weekData) : null;
      const goal = goalForWeek(key);
      const isInProgress = key === CURRENT_WEEK_KEY;

      const box = document.createElement("button");
      box.type = "button";
      box.className = `week-box ${statusClass(totals?.total ?? 0, started, goal)}`;
      if (isInProgress) box.classList.add("is-current");

      if (isInProgress) {
        const badge = document.createElement("span");
        badge.className = "week-box-badge";
        badge.textContent = "NOW";
        box.appendChild(badge);
      }

      const label = document.createElement("span");
      label.className = "week-box-label";
      label.textContent = weekLabel(key);
      box.appendChild(label);

      const bottomRow = document.createElement("span");
      bottomRow.className = "week-box-bottom";

      const total = document.createElement("span");
      total.className = "week-box-total";
      total.textContent = started ? `${fmt(totals.total)} kg` : "No data";
      bottomRow.appendChild(total);

      if (started) {
        const diff = totals.total - goal;
        const over = diff > 0;
        const diffEl = document.createElement("span");
        diffEl.className = `week-diff ${over ? "week-diff-over" : "week-diff-under"}`;
        diffEl.textContent = `${over ? "▲" : "▼"} ${fmt(Math.abs(diff))}`;
        const goalDescription = isInProgress
          ? `your ${fmt(goal)} kg goal so far (day ${todayIndexInWeek()} of 7, prorated from ${fmt(currentGoal())} kg)`
          : `your ${fmt(goal)} kg goal`;
        diffEl.title = over
          ? `${fmt(diff)} kg over ${goalDescription}`
          : `${fmt(Math.abs(diff))} kg under ${goalDescription}`;
        bottomRow.appendChild(diffEl);
      }

      box.appendChild(bottomRow);

      box.addEventListener("click", () => openWeekDetail(key));
      grid.appendChild(box);
    }
  }

  function openWeekDetail(key) {
    const weekData = weeksCache[key];
    document.getElementById("week-detail-title").textContent = weekLabel(key);
    const body = document.getElementById("week-detail-body");

    if (!hasAnyEntries(weekData)) {
      body.innerHTML = '<p class="empty-note">No entries logged for this week.</p>';
    } else {
      const totals = weekTotals(weekData);
      const rows = DAYS.map((day) => {
        const commuteLabel = TRANSPORT_LABELS[weekData.commute[day.key]] || "–";
        const dietEntry = weekData.diet[day.key];
        let dietText = "–";
        if (dietEntry?.type === "meat") dietText = dietSummaryText(dietEntry);
        else if (dietEntry?.type === "veggie") dietText = "Veggie";
        else if (dietEntry?.type === "vegan") dietText = "Vegan";
        const confirmed = weekData.confirmedCommute[day.key] || weekData.confirmedDiet[day.key];
        const dayTotal = countedCommuteFootprint(weekData, day.key) + countedFoodFootprint(weekData, day.key);
        const status = confirmed ? "✓" : "<span class=\"empty-note\">draft</span>";
        return `<tr><td>${day.full}</td><td>${commuteLabel}</td><td>${dietText}</td><td>${fmt(dayTotal)} kg</td><td>${status}</td></tr>`;
      }).join("");

      body.innerHTML = `
        <table class="week-detail-table">
          <thead><tr><th>Day</th><th>Commute</th><th>Diet</th><th>CO2e</th><th>Confirmed</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p><strong>Total: ${fmt(totals.total)} kg CO2e</strong> (${fmt(totals.commute)} kg commute, ${fmt(totals.food)} kg food) &mdash; confirmed days only</p>
      `;
    }

    document.getElementById("week-detail-backdrop").classList.add("open");
  }

  function closeWeekDetail() {
    document.getElementById("week-detail-backdrop").classList.remove("open");
  }

  // ---------- Page 3: Leaderboard ----------
  // Flights and home electricity are yearly figures (Stats page inputs),
  // not weekly - amortized to a weekly-equivalent here so the all-time
  // weekly average isn't just commute and food. Same math as renderStatsPage(),
  // just per-week instead of per-year (divided by 52 instead of multiplied).
  function weeklyExtrasFor(inputs) {
    const yearlyFlying = (inputs.shortHaulFlights || 0) * SHORT_HAUL_FLIGHT_KG + (inputs.longHaulFlights || 0) * LONG_HAUL_FLIGHT_KG;
    const yearlyHomeEnergyTotal = (inputs.householdKwhPerMonth || 0) * 12 * GRID_ELECTRICITY_KG_PER_KWH;
    const yearlyHomeEnergy = yearlyHomeEnergyTotal / Math.max(1, inputs.householdPeople || 1);
    return (yearlyFlying + yearlyHomeEnergy) / 52;
  }

  function renderLeaderboardRow(list, rank, label, sub, kg, isSelf) {
    const li = document.createElement("li");
    li.className = "leaderboard-row" + (isSelf ? " is-current" : "");

    const rankEl = document.createElement("span");
    rankEl.className = "leaderboard-rank";
    rankEl.textContent = rank;

    const info = document.createElement("span");
    info.className = "leaderboard-info";
    const nameEl = document.createElement("div");
    nameEl.className = "leaderboard-week-label";
    nameEl.textContent = label;
    const subEl = document.createElement("div");
    subEl.className = "leaderboard-sub";
    subEl.textContent = sub;
    info.appendChild(nameEl);
    info.appendChild(subEl);

    const total = document.createElement("span");
    total.className = "leaderboard-total";
    total.textContent = `${fmt(kg)} kg`;

    li.appendChild(rankEl);
    li.appendChild(info);
    li.appendChild(total);
    list.appendChild(li);
  }

  async function renderLeaderboard() {
    const list = document.getElementById("leaderboard-list");
    const winnerEl = document.getElementById("leaderboard-winner");
    if (!currentUser) return;

    const { data, error } = await sbClient.rpc("friend_leaderboard", { target_week_key: CURRENT_WEEK_KEY });
    list.innerHTML = "";
    winnerEl.hidden = true;

    if (error) {
      list.innerHTML = '<p class="empty-note">Could not load the leaderboard right now.</p>';
      return;
    }
    if (!data || data.length === 0) {
      list.innerHTML = '<p class="empty-note">Log this week, then add friends from the Account page to compare.</p>';
      return;
    }

    if (data.length > 1) {
      const winner = data[0];
      const winnerName = winner.is_self ? "You" : winner.display_name || "A friend";
      winnerEl.textContent = `\u{1F3C6} ${winnerName} ${winner.is_self ? "are" : "is"} winning this week with ${fmt(winner.total_kg)} kg CO2e.`;
      winnerEl.hidden = false;
    }

    const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
    data.forEach((entry, i) => {
      renderLeaderboardRow(
        list,
        medals[i] || `#${i + 1}`,
        entry.is_self ? "You" : entry.display_name || "Friend",
        weekLabel(CURRENT_WEEK_KEY),
        entry.total_kg,
        entry.is_self
      );
    });
  }

  async function renderWeeklyAverageLeaderboard() {
    const list = document.getElementById("leaderboard-average-list");
    if (!currentUser) return;

    const { data, error } = await sbClient.rpc("friend_weekly_average");
    list.innerHTML = "";

    if (error) {
      list.innerHTML = '<p class="empty-note">Could not load this right now.</p>';
      return;
    }
    if (!data || data.length === 0) {
      list.innerHTML = '<p class="empty-note">Confirm a week, then add friends from the Account page to compare.</p>';
      return;
    }

    const withExtras = data.map((entry) => {
      const extras = entry.is_self ? profile : friendExtrasById[entry.user_id];
      const weeklyExtras = extras ? weeklyExtrasFor(extras) : 0;
      return { ...entry, avgWithExtras: (entry.avg_weekly_kg || 0) + weeklyExtras };
    });
    withExtras.sort((a, b) => a.avgWithExtras - b.avgWithExtras);

    const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
    withExtras.forEach((entry, i) => {
      const weeksLabel = `${entry.weeks_confirmed} confirmed week${entry.weeks_confirmed === 1 ? "" : "s"}`;
      renderLeaderboardRow(
        list,
        medals[i] || `#${i + 1}`,
        entry.is_self ? "You" : entry.display_name || "Friend",
        weeksLabel,
        entry.avgWithExtras,
        entry.is_self
      );
    });
  }

  // Anonymous aggregate across every account, not just friends - see
  // app_wide_weekly_average() in schema.sql for why this is safe to show
  // without a friendship relationship (it's a single aggregate row, never
  // per-user data).
  async function renderAppWideAverage() {
    if (!currentUser) return;
    const { data, error } = await sbClient.rpc("app_wide_weekly_average");
    if (error || !data || !data[0]) return;
    document.getElementById("app-average-value").textContent = fmt(data[0].avg_weekly_kg || 0);
    document.getElementById("app-average-count").textContent = data[0].user_count || 0;
  }

  // ---------- Page 4: Account ----------
  function renderAccountPage() {
    document.getElementById("profile-name").value = profile.name || "";
    document.getElementById("profile-distance").value = profile.commuteDistanceKm;
    document.getElementById("profile-goal").value = profile.weeklyGoalKg;
    document.getElementById("profile-food-waste").value = profile.foodWaste;
    document.getElementById("account-email").textContent = currentUser?.email || "";
    renderFriendsUI();
  }

  // ---------- Page: Stats (yearly estimate) ----------
  function averageConfirmedWeekly(kind) {
    const weeks = Object.values(weeksCache).filter(hasAnyConfirmed);
    if (weeks.length === 0) return 0;
    const sum = weeks.reduce((acc, weekData) => acc + weekTotals(weekData)[kind], 0);
    return sum / weeks.length;
  }

  // null/blank -> "" (so the input shows empty, not "0"); a real 0 still shows as 0.
  function optionalInputValue(v) { return v === null || v === undefined ? "" : v; }

  function renderStatsPage() {
    document.getElementById("flights-short-haul").value = profile.shortHaulFlights;
    document.getElementById("flights-long-haul").value = profile.longHaulFlights;
    document.getElementById("household-people").value = profile.householdPeople;
    document.getElementById("household-kwh").value = profile.householdKwhPerMonth;
    document.getElementById("clothes-per-month").value = profile.clothesPerMonth;
    document.getElementById("gas-heating-kwh").value = optionalInputValue(profile.annualGasKwh);
    document.getElementById("noncommute-car-km").value = optionalInputValue(profile.weeklyNonCommuteCarKm);
    document.getElementById("owns-car").value = profile.ownsCar === true ? "yes" : profile.ownsCar === false ? "no" : "";

    const avgFood = averageConfirmedWeekly("food");
    const avgCommute = averageConfirmedWeekly("commute");
    const yearlyFood = avgFood * 52;
    const yearlyCommute = avgCommute * 52;

    const yearlyFlying = profile.shortHaulFlights * SHORT_HAUL_FLIGHT_KG + profile.longHaulFlights * LONG_HAUL_FLIGHT_KG;

    const householdYearlyKwh = profile.householdKwhPerMonth * 12;
    const householdYearlyEnergy = householdYearlyKwh * GRID_ELECTRICITY_KG_PER_KWH;
    const yearlyHomeEnergy = householdYearlyEnergy / Math.max(1, profile.householdPeople || 1);

    const yearlyGoods = profile.clothesPerMonth * 12 * CLOTHING_ITEM_KG;

    let yearlyTotal = yearlyFood + yearlyCommute + yearlyFlying + yearlyHomeEnergy + yearlyGoods;

    // Optional extras: only added (and only shown) when actually answered -
    // a blank/unanswered one is left out of the total entirely, not treated
    // as 0, so skipping a question never quietly lowers your estimate.
    const includeOptional = {
      gasHeating: profile.annualGasKwh !== null && profile.annualGasKwh !== undefined,
      nonCommuteCar: profile.weeklyNonCommuteCarKm !== null && profile.weeklyNonCommuteCarKm !== undefined,
      carOwnership: profile.ownsCar !== null && profile.ownsCar !== undefined,
    };
    const yearlyGasHeating = includeOptional.gasHeating ? (profile.annualGasKwh * GAS_HEATING_KG_PER_KWH) / Math.max(1, profile.householdPeople || 1) : null;
    const yearlyNonCommuteCar = includeOptional.nonCommuteCar ? profile.weeklyNonCommuteCarKm * TRANSPORT_FACTORS.car * 52 : null;
    const yearlyCarOwnership = includeOptional.carOwnership ? (profile.ownsCar ? CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR : 0) : null;
    if (yearlyGasHeating !== null) yearlyTotal += yearlyGasHeating;
    if (yearlyNonCommuteCar !== null) yearlyTotal += yearlyNonCommuteCar;
    if (yearlyCarOwnership !== null) yearlyTotal += yearlyCarOwnership;

    document.getElementById("yearly-avg-food").textContent = fmt(avgFood);
    document.getElementById("yearly-avg-commute").textContent = fmt(avgCommute);
    document.getElementById("yearly-food").textContent = Math.round(yearlyFood).toLocaleString();
    document.getElementById("yearly-commute").textContent = Math.round(yearlyCommute).toLocaleString();
    document.getElementById("yearly-flying").textContent = Math.round(yearlyFlying).toLocaleString();
    document.getElementById("yearly-home-energy").textContent = Math.round(yearlyHomeEnergy).toLocaleString();
    document.getElementById("yearly-goods").textContent = Math.round(yearlyGoods).toLocaleString();
    document.getElementById("yearly-gas-heating").textContent = yearlyGasHeating === null ? "–" : Math.round(yearlyGasHeating).toLocaleString();
    document.getElementById("yearly-noncommute-car").textContent = yearlyNonCommuteCar === null ? "–" : Math.round(yearlyNonCommuteCar).toLocaleString();
    document.getElementById("yearly-car-ownership").textContent = yearlyCarOwnership === null ? "–" : Math.round(yearlyCarOwnership).toLocaleString();
    document.getElementById("yearly-total").textContent = Math.round(yearlyTotal).toLocaleString();

    const uk = computeUkAverageBreakdown(includeOptional);

    // Per-domain "vs UK average" delta under each tile - skipped for the
    // three optional categories when unanswered (nothing to compare yet).
    setComparisonDiff("yearly-food-diff", yearlyFood, uk.food, "kg");
    setComparisonDiff("yearly-commute-diff", yearlyCommute, uk.commute, "kg");
    setComparisonDiff("yearly-flying-diff", yearlyFlying, uk.flying, "kg");
    setComparisonDiff("yearly-home-energy-diff", yearlyHomeEnergy, uk.homeEnergy, "kg");
    setComparisonDiff("yearly-goods-diff", yearlyGoods, uk.goods, "kg");
    setComparisonDiff("yearly-gas-heating-diff", yearlyGasHeating, uk.gasHeating, "kg");
    setComparisonDiff("yearly-noncommute-car-diff", yearlyNonCommuteCar, uk.nonCommuteCar, "kg");
    setComparisonDiff("yearly-car-ownership-diff", yearlyCarOwnership, uk.carOwnership, "kg");

    const percentileEl = document.getElementById("yearly-percentile");
    const betterThanPct = ukPercentileBetterThan(yearlyTotal, uk.total);
    if (betterThanPct === null) {
      percentileEl.textContent = "";
    } else if (betterThanPct >= 50) {
      // Phrase as "lower than X%" only when X is a reassuringly big majority -
      // "lower than 5%" reads backwards (it actually means a high emitter).
      percentileEl.textContent = `~lower than ${Math.round(betterThanPct)}% of people in the UK`;
    } else {
      percentileEl.textContent = `~higher than ${Math.round(100 - betterThanPct)}% of people in the UK`;
    }

    renderYearComparison(yearlyTotal, uk.total);
  }

  function renderYearComparison(yearlyTotal, ukAverageYearlyKg) {
    const carKgPerMile = TRANSPORT_FACTORS.car * KM_PER_MILE;
    const yourCarMiles = yearlyTotal / carKgPerMile;
    const ukCarMiles = ukAverageYearlyKg / carKgPerMile;
    const yourTrees = yearlyTotal / TREE_KG_PER_YEAR;
    const ukTrees = ukAverageYearlyKg / TREE_KG_PER_YEAR;

    document.getElementById("uk-average-value").textContent = Math.round(ukAverageYearlyKg).toLocaleString();
    document.getElementById("compare-car-miles").textContent = Math.round(yourCarMiles).toLocaleString();
    document.getElementById("compare-trees").textContent = Math.round(yourTrees).toLocaleString();

    setComparisonDiff("compare-car-miles-diff", yourCarMiles, ukCarMiles, "miles");
    setComparisonDiff("compare-trees-diff", yourTrees, ukTrees, "trees");
  }

  function setComparisonDiff(elementId, yourValue, ukValue, unit) {
    const el = document.getElementById(elementId);
    if (!el) return;
    // Optional categories pass null on both sides when unanswered - nothing
    // to compare yet, so leave the delta blank rather than showing "0 vs
    // UK average" (which would misleadingly look like a real answer of 0).
    if (yourValue === null || yourValue === undefined || ukValue === null || ukValue === undefined) {
      el.textContent = "";
      el.className = "week-diff";
      return;
    }
    const diff = yourValue - ukValue;
    const over = diff > 0;
    el.className = `week-diff ${over ? "week-diff-over" : "week-diff-under"}`;
    el.textContent = `${over ? "▲" : "▼"} ${Math.round(Math.abs(diff)).toLocaleString()} ${unit} vs UK average`;
  }

  function exportData() {
    const payload = { profile, weeks: weeksCache };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "co2-tracker-data.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importData(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      alert("That file doesn't look like valid JSON.");
      return;
    }
    const importedWeeks = parsed.weeks || parsed.history;
    if (!parsed.profile || !importedWeeks) {
      alert("That file doesn't look like a valid CO2 Tracker export.");
      return;
    }
    if (!confirm("Import will replace your current profile and weeks. Continue?")) return;

    profile = { ...DEFAULT_PROFILE, ...parsed.profile };
    await persistProfile();

    for (const [weekKey, weekData] of Object.entries(importedWeeks)) {
      const totals = weekTotals(weekData);
      await sbClient.from("weeks").upsert(
        {
          user_id: currentUser.id,
          week_key: weekKey,
          commute: weekData.commute,
          diet: weekData.diet,
          total_kg: totals.total,
        },
        { onConflict: "user_id,week_key" }
      );
    }

    await loadAllWeeks();
    showTab(currentTab());
  }

  async function resetWeek() {
    if (!confirm(`Reset all entries for ${weekPickerHeading(selectedWeekKey).toLowerCase()}?`)) return;
    weeksCache[selectedWeekKey] = blankWeek();
    if (currentUser) {
      await sbClient.from("weeks").delete().eq("user_id", currentUser.id).eq("week_key", selectedWeekKey);
    }
    renderWeekPage();
  }

  async function resetAllData() {
    if (!confirm("This deletes ALL your saved weeks and resets your profile. This cannot be undone. Continue?")) return;
    await sbClient.from("weeks").delete().eq("user_id", currentUser.id);
    profile = { ...DEFAULT_PROFILE };
    await persistProfile();
    await loadAllWeeks();
    showTab(currentTab());
  }

  // ---------- Auth ----------
  let authMode = "signin";

  // Where Supabase should send the user back to after clicking a signup
  // confirmation or password-reset email link. Computed from wherever the
  // app actually is (not hardcoded), so this works on GitHub Pages, a
  // custom domain, or localhost alike - as long as that URL is also added
  // to the Supabase project's Authentication > URL Configuration >
  // Redirect URLs allowlist (Supabase ignores redirects not on that list).
  function currentAppUrl() {
    return window.location.origin + window.location.pathname;
  }

  // Supabase's recovery link can land back here in more than one shape
  // depending on flow (implicit "#access_token=...&type=recovery" hash, or
  // PKCE "?code=...&type=recovery" query) - checking the URL directly for
  // "type=recovery" is more robust than relying on any one specific
  // supabase-js auth event firing, since that can vary by flow/version.
  function urlIndicatesPasswordRecovery() {
    return /type=recovery/.test(window.location.hash) || /type=recovery/.test(window.location.search);
  }

  function clearAuthParamsFromUrl() {
    history.replaceState(null, "", window.location.pathname);
  }

  function updateAuthModeUI() {
    document.getElementById("auth-submit").textContent = authMode === "signin" ? "Sign in" : "Create account";
    document.getElementById("auth-toggle-mode").textContent =
      authMode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in";
    document.getElementById("auth-error").hidden = true;
    document.getElementById("auth-status").hidden = true;
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const errorEl = document.getElementById("auth-error");
    const statusEl = document.getElementById("auth-status");
    errorEl.hidden = true;
    statusEl.hidden = true;
    const submitBtn = document.getElementById("auth-submit");
    submitBtn.disabled = true;

    try {
      if (authMode === "signin") {
        const { error } = await sbClient.auth.signInWithPassword({ email, password });
        if (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        }
      } else {
        const { data, error } = await sbClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: currentAppUrl() },
        });
        if (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        } else if (!data.session) {
          statusEl.textContent = "Check your email to confirm your account, then sign in.";
          statusEl.hidden = false;
          authMode = "signin";
          updateAuthModeUI();
        }
      }
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function handleForgotPassword() {
    const email = document.getElementById("auth-email").value.trim();
    const errorEl = document.getElementById("auth-error");
    const statusEl = document.getElementById("auth-status");
    errorEl.hidden = true;
    if (!email) {
      errorEl.textContent = "Enter your email above first.";
      errorEl.hidden = false;
      return;
    }
    const { error } = await sbClient.auth.resetPasswordForEmail(email, { redirectTo: currentAppUrl() });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      return;
    }
    statusEl.textContent = "Password reset email sent.";
    statusEl.hidden = false;
  }

  async function handleResetPasswordSubmit(e) {
    e.preventDefault();
    const newPassword = document.getElementById("reset-password-input").value;
    const errorEl = document.getElementById("reset-password-error");
    const statusEl = document.getElementById("reset-password-status");
    errorEl.hidden = true;
    statusEl.hidden = true;
    const submitBtn = document.getElementById("reset-password-submit");
    submitBtn.disabled = true;

    try {
      const { error } = await sbClient.auth.updateUser({ password: newPassword });
      if (error) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
        return;
      }
      statusEl.textContent = "Password updated — signing you in…";
      statusEl.hidden = false;
      expectingPasswordRecovery = false;
      document.getElementById("reset-password-screen").hidden = true;
      const { data } = await sbClient.auth.getSession();
      await handleSession(data.session);
    } finally {
      submitBtn.disabled = false;
    }
  }

  function showResetPasswordScreen() {
    // A recovery session may have already run through handleSession() (e.g.
    // if getSession() at init picked it up before this listener was even
    // subscribed), setting loadedUserId. Clear it so the real sign-in after
    // the password is actually changed isn't skipped as a no-op duplicate.
    loadedUserId = null;
    document.getElementById("auth-screen").hidden = true;
    document.getElementById("app-root").hidden = true;
    document.getElementById("reset-password-screen").hidden = false;
  }

  function resetAuthForm() {
    document.getElementById("auth-form").reset();
    authMode = "signin";
    updateAuthModeUI();
  }

  async function onSignedIn(user) {
    currentUser = user;
    selectedWeekKey = CURRENT_WEEK_KEY;
    document.getElementById("auth-screen").hidden = true;
    document.getElementById("app-root").hidden = false;
    // Each of these can fail independently on a flaky connection — don't let
    // one failure strand the user on a half-initialized, unusable screen.
    try {
      await ensureProfile();
    } catch (e) {
      console.error("Failed to load profile", e);
    }
    try {
      await loadAllWeeks();
    } catch (e) {
      console.error("Failed to load weeks", e);
    }
    try {
      await loadFriends();
    } catch (e) {
      console.error("Failed to load friends", e);
    }
    showTab(currentTab());
  }

  function onSignedOut() {
    currentUser = null;
    profile = { ...DEFAULT_PROFILE };
    weeksCache = {};
    friendships = [];
    document.getElementById("app-root").hidden = true;
    document.getElementById("auth-screen").hidden = false;
    resetAuthForm();
  }

  async function handleSession(session) {
    if (session && session.user) {
      if (loadedUserId === session.user.id) return;
      loadedUserId = session.user.id;
      await onSignedIn(session.user);
    } else {
      loadedUserId = null;
      onSignedOut();
    }
  }

  // ---------- Init ----------
  function init() {
    if (!initSupabaseClient()) {
      const errorEl = document.getElementById("auth-error");
      errorEl.textContent = "Could not reach the login service. Check your connection and reload the page.";
      errorEl.hidden = false;
      document.getElementById("auth-submit").disabled = true;
      return;
    }

    document.getElementById("auth-form").addEventListener("submit", handleAuthSubmit);
    document.getElementById("auth-toggle-mode").addEventListener("click", () => {
      authMode = authMode === "signin" ? "signup" : "signin";
      updateAuthModeUI();
    });
    document.getElementById("auth-forgot").addEventListener("click", handleForgotPassword);
    document.getElementById("reset-password-form").addEventListener("submit", handleResetPasswordSubmit);

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => { location.hash = btn.dataset.tab; });
    });
    window.addEventListener("hashchange", () => showTab(currentTab()));

    document.getElementById("sign-out-btn").addEventListener("click", () => sbClient.auth.signOut());

    document.getElementById("week-detail-close").addEventListener("click", closeWeekDetail);
    document.getElementById("week-detail-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "week-detail-backdrop") closeWeekDetail();
    });

    document.getElementById("reset-week").addEventListener("click", resetWeek);

    document.querySelectorAll(".week-picker-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedWeekKey = btn.dataset.week === "current" ? CURRENT_WEEK_KEY : LAST_WEEK_KEY;
        renderWeekPage();
      });
    });

    document.getElementById("profile-name").addEventListener("input", (e) => {
      profile.name = e.target.value;
      persistProfile();
    });
    document.getElementById("profile-distance").addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      profile.commuteDistanceKm = Number.isFinite(val) && val >= 0 ? val : 0;
      persistProfile();
      renderFootprints();
    });
    document.getElementById("profile-goal").addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      profile.weeklyGoalKg = Number.isFinite(val) && val >= 0 ? val : 0;
      persistProfile();
    });
    document.getElementById("profile-food-waste").addEventListener("change", (e) => {
      profile.foodWaste = e.target.value;
      persistProfile();
      renderFootprints();
    });

    function bindNumberField(id, applyToProfile, { min = 0, rerenderStats = true } = {}) {
      document.getElementById(id).addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        applyToProfile(Number.isFinite(val) && val >= min ? val : min);
        persistProfile();
        if (rerenderStats) renderStatsPage();
      });
    }
    bindNumberField("flights-short-haul", (v) => { profile.shortHaulFlights = v; });
    bindNumberField("flights-long-haul", (v) => { profile.longHaulFlights = v; });
    bindNumberField("household-people", (v) => { profile.householdPeople = v; }, { min: 1 });
    bindNumberField("household-kwh", (v) => { profile.householdKwhPerMonth = v; });
    bindNumberField("clothes-per-month", (v) => { profile.clothesPerMonth = v; });

    // Optional extras: unlike bindNumberField above, a blank input maps to
    // null (excluded from every total) rather than being coerced to 0.
    function bindOptionalNumberField(id, applyToProfile) {
      document.getElementById(id).addEventListener("input", (e) => {
        const raw = e.target.value;
        const val = parseFloat(raw);
        applyToProfile(raw.trim() === "" || !Number.isFinite(val) || val < 0 ? null : val);
        persistProfile();
        renderStatsPage();
      });
    }
    bindOptionalNumberField("gas-heating-kwh", (v) => { profile.annualGasKwh = v; });
    bindOptionalNumberField("noncommute-car-km", (v) => { profile.weeklyNonCommuteCarKm = v; });

    document.getElementById("owns-car").addEventListener("change", (e) => {
      profile.ownsCar = e.target.value === "yes" ? true : e.target.value === "no" ? false : null;
      persistProfile();
      renderStatsPage();
    });

    document.getElementById("add-friend-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("friend-email");
      addFriendByEmail(input.value);
      input.value = "";
    });

    document.getElementById("export-data").addEventListener("click", exportData);
    document.getElementById("import-data").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importData(file);
      e.target.value = "";
    });
    document.getElementById("reset-all-data").addEventListener("click", resetAllData);

    updateAuthModeUI();

    expectingPasswordRecovery = urlIndicatesPasswordRecovery();

    function routeSession(event, session) {
      // Supabase signs the user into a temporary session when they land
      // back here from a password-reset email link. Don't let that fall
      // through to a normal sign-in - force setting a new password first.
      // Checked two ways since the exact event name isn't reliable across
      // Supabase's different redirect flows: the URL itself is the one
      // thing that's always present regardless of flow/event naming.
      if (event === "PASSWORD_RECOVERY" || (expectingPasswordRecovery && session)) {
        clearAuthParamsFromUrl();
        showResetPasswordScreen();
        return;
      }
      handleSession(session);
    }

    sbClient.auth.getSession().then(({ data }) => {
      routeSession(null, data.session);
      sbClient.auth.onAuthStateChange((event, session) => { routeSession(event, session); });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
