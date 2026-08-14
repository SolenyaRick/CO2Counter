(function () {
  "use strict";

  const SUPABASE_URL = "https://fbgfylfnbtxzbwgilktt.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiZ2Z5bGZuYnR4emJ3Z2lsa3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwOTg1MjUsImV4cCI6MjEwMDY3NDUyNX0.S-c144dilgUwf8saEjuIQMAp4q-B86R2TRkLV6l9Ym0";

  // Only used to decide whether to show the Account page's research-data
  // export button - the real access control is server-side (see
  // research_export_profiles()/research_export_weeks() in schema.sql, which
  // check the signed-in user's email themselves and return nothing to
  // anyone else). Showing/hiding the button here is just UX, not security.
  const OWNER_EMAIL = "jack.s.brown@outlook.com";

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

  const MONTH_SHORT_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const DAY_MS = 24 * 60 * 60 * 1000;

  // Every physical kg-CO2e-per-unit factor used below (transport, food,
  // alcohol, flights, home energy, etc.) now lives in emission-factors.js,
  // loaded via a <script> tag before this file - edit the numbers there,
  // not here.

  const TRANSPORT_LABELS = { none: "Didn't travel", walk: "Walk", cycle: "Cycle", train: "Train", tube: "Tube", car: "Car" };

  function carFactorFor(p) {
    return (p.carFuelType && CAR_FUEL_FACTORS[p.carFuelType]) || TRANSPORT_FACTORS.car;
  }

  const MEAT_LABELS = { chicken: "Chicken / poultry", fish: "Fish / seafood", pork: "Pork", beef: "Beef", lamb: "Lamb", other: "Other" };
  // Emoji of the cooked cut/product rather than a live animal - reads as
  // "less lifelike" than an animal-face emoji (or the hand-drawn animal
  // silhouettes this replaced, which turned out too similar to tell apart
  // at button size) while staying easy to visually distinguish at a glance.
  const MEAT_ICONS = { chicken: "🍗", pork: "🥓", beef: "🥩", fish: "🐟", lamb: "🍖" };
  // Order the meat picker buttons appear in; "other" has no icon button (kept
  // only so older saved entries with that value still compute correctly).
  const MEAT_ICON_ORDER = ["chicken", "pork", "beef", "fish", "lamb"];

  const PORTION_LABELS = { small: "Small (~100g)", medium: "Medium (~150g)", large: "Large (~250g+)" };
  const PORTION_SHORT_LABELS = { small: "S", medium: "M", large: "L" };

  const ALCOHOL_FILL_MAX = 8; // length of the beer/wine "fill up" icon rows

  const BEER_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<rect x="4.5" y="5.5" width="13" height="3" rx="1.5"/>'
    + '<rect x="5" y="8" width="12" height="13" rx="1.5"/>'
    + '<path fill-rule="evenodd" d="M20 10.8a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 1 1 0-6.8Zm0 1.7a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 1 0 0-3.4Z"/>'
    + '</svg>';
  const WINE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M6.5 4 C6.5 9 8 12.5 12 13 C16 12.5 17.5 9 17.5 4 Z"/>'
    + '<rect x="11.3" y="13" width="1.4" height="6"/>'
    + '<rect x="8.5" y="19" width="7" height="1.6" rx="0.8"/>'
    + '</svg>';

  function alcoholFootprint(weekData) {
    const a = weekData.alcohol || {};
    const beer = (a.beer || 0) * BEER_KG_PER_DRINK;
    const wine = (a.wine || 0) * WINE_KG_PER_GLASS;
    const abv = a.spiritsAbv || 40;
    const spirits = (a.spiritsShots || 0) * SPIRITS_KG_PER_SHOT_AT_40PCT * (abv / 40);
    return beer + wine + spirits;
  }

  // ---------- UK average reference (Home page "vs UK average" comparisons) ----------
  // Built bottom-up from representative average UK inputs for exactly the
  // categories this app tracks, run through the same formulas as your own
  // totals - a fair like-for-like comparison, rather than a generic "average
  // UK footprint" statistic that also covers things this app doesn't model
  // at all (see the note on the Stats page for what's missing).
  const UK_AVERAGE_ASSUMPTIONS = {
    commuteOneWayKm: 10, // rough average UK one-way commute, assumed by car (the majority mode)
    // Standard UK working week - this used to be missing entirely, which
    // meant the UK-average commute figure only ever counted ONE round trip
    // for the whole week (not five), landing at ~0.18 tonnes CO2e/yr versus
    // commonly cited UK figures of "nearly 1 tonne/yr" for a car commuter -
    // multiplying by a representative 5-day week brings this to ~0.89
    // tonnes/yr, a much closer match.
    commuteDaysPerWeek: 5,
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
    numDogs: 0.2, // rough UK dogs-per-person (~13M dogs / ~67M population)
    numCats: 0.15, // rough UK cats-per-person (~11M cats / ~67M population)
    annualWaterM3: 122, // rough UK household water use/yr (~140 L/person/day * 2.4 people)
    // Representative "big five" high-street bank factor (Barclays, HSBC,
    // Lloyds, NatWest, Santander - together holding most UK current
    // accounts), and a rough illustrative combined current + savings
    // balance. Both are much softer estimates than the others above - there's
    // no single clean source for "the average person's bank balance".
    bankKgPerPoundPerYear: (0.2376 + 0.2170 + 0.0704 + 0.1295 + 0.1742) / 5,
    bankBalance: 5000,
  };

  // includeOptional: { gasHeating, carOwnership, pets, water, banks }
  // booleans - pass whichever optional categories the person being compared
  // against has actually answered, so both sides of the comparison cover
  // the same ground. nonCommuteCar isn't gated the same way any more -
  // like commute/food/alcohol, it's always-tracked (via Additional
  // Journeys), not a skippable profile question. Returns a per-category
  // breakdown (not just a total) so each domain on the Stats page can show
  // its own "vs UK average" delta.
  function computeUkAverageBreakdown(includeOptional = {}) {
    const a = UK_AVERAGE_ASSUMPTIONS;
    const wasteMult = FOOD_WASTE_MULTIPLIERS[a.foodWaste];

    const commuteWeekly = TRANSPORT_FACTORS.car * a.commuteOneWayKm * 2 * a.commuteDaysPerWeek;
    const commute = commuteWeekly * 52;
    const nonCommuteCar = a.weeklyNonCommuteCarKm * TRANSPORT_FACTORS.car * 52;

    const meatWeekly = a.weeklyMeatDays.reduce((sum, day) => {
      const meatFactor = MEAT_FACTORS[day.meat] ?? MEAT_FACTORS.other;
      const portionKg = PORTION_KG[day.portion] ?? PORTION_KG.medium;
      return sum + (meatFactor * portionKg + MEAT_SIDES_BASELINE) * wasteMult;
    }, 0);
    const veggieWeekly = a.weeklyVeggieDays * FOOD_DAY_FACTORS.veggie * wasteMult;
    const foodWeekly = meatWeekly + veggieWeekly;
    const food = foodWeekly * 52;

    const flying = a.shortHaulFlights * SHORT_HAUL_FLIGHT_KG + a.longHaulFlights * LONG_HAUL_FLIGHT_KG;
    const homeEnergy = (a.householdKwhPerYear * GRID_ELECTRICITY_KG_PER_KWH) / a.householdPeople;
    const goods = a.clothesPerMonth * 12 * CLOTHING_ITEM_KG;

    const gasHeating = includeOptional.gasHeating ? (a.annualGasKwh * GAS_HEATING_KG_PER_KWH) / a.householdPeople : null;
    const carOwnership = includeOptional.carOwnership ? CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR : null;
    const pets = includeOptional.pets ? (a.numDogs * DOG_KG_PER_YEAR + a.numCats * CAT_KG_PER_YEAR) / a.householdPeople : null;
    const water = includeOptional.water ? (a.annualWaterM3 * WATER_KG_PER_M3) / a.householdPeople : null;
    const banks = includeOptional.banks ? a.bankKgPerPoundPerYear * a.bankBalance : null;

    const total = commute + food + nonCommuteCar + flying + homeEnergy + goods
      + (gasHeating || 0) + (carOwnership || 0) + (pets || 0) + (water || 0) + (banks || 0);
    return { commute, food, flying, homeEnergy, goods, gasHeating, nonCommuteCar, carOwnership, pets, water, banks, total, commuteWeekly, foodWeekly };
  }

  // Weekly UK-average reference for the This Week page's "Compared to an
  // average week" card - just commute + food, since those are the only
  // categories that make up a *weekly* total in this app (flights/home
  // energy/goods are yearly Stats-page figures, not part of a given week).
  const UK_AVERAGE_WEEKLY_KG = (() => {
    const uk = computeUkAverageBreakdown({});
    return uk.commuteWeekly + uk.foodWeekly;
  })();

  // The Hot or Cool Institute's "1.5-Degree Lifestyles" research (2021) sets
  // a 2,500 kg CO2e/yr per-capita consumption-footprint target for 2030 as
  // roughly a fair-share pathway to keep warming under 1.5C (dropping
  // further for 2040/2050). That covers a person's WHOLE lifestyle
  // (mobility, energy, food, shopping, leisure) - so it's compared against
  // the Stats page's fuller yearly total (which covers 5-8 categories), not
  // the This Week page's commute+food-only weekly figure, which would make
  // this target look artificially easy to beat for no real reason other
  // than mismatched scope. This used to cite MyEmission (a carbon-tracking
  // app)'s 6.3 kg/day figure instead - switched to Hot or Cool's own
  // headline number since this app already draws on the same study below
  // for the food/commute reduction percentages, so the whole 1.5C section
  // now cites one consistent source rather than two.
  const PARIS_1_5C_YEARLY_KG = 2500;

  // A single commonly-cited global per-capita footprint figure (roughly
  // 4.7 tonnes CO2e/yr), for the Home page's "World average" comparison
  // chip. Deliberately NOT built bottom-up the rigorous way the UK average
  // above is (there's no single global travel/diet survey to build it
  // from - see WORLD_AVERAGE_WEEKLY_KG below, "the roughest figure in the
  // app") - this is a single illustrative reference number, same spirit as
  // the "8-10 tonnes CO2e/yr" UK figure cited in the app's copy without a
  // bottom-up model behind it either.
  const WORLD_AVERAGE_YEARLY_KG = 4700;

  // A food+commute-only slice of the 1.5C target, for the weekly goal
  // preset (which only tracks those two categories, plus alcohol). There's
  // no official published category-level split of the 2,500 kg/yr target
  // above, so this isn't Hot or Cool's own number - it's our own estimate,
  // applying published 2030 reduction requirements for developed countries
  // (the same research: nutrition footprints need to fall ~47%, mobility
  // ~72%, by 2030) to our own UK-average commute/food baseline above.
  const PARIS_1_5C_FOOD_COMMUTE_WEEKLY_KG = (() => {
    const uk = computeUkAverageBreakdown({});
    return uk.foodWeekly * (1 - 0.47) + uk.commuteWeekly * (1 - 0.72);
  })();

  // A lightweight bottom-up "world average" week (commute + food only,
  // same shape as UK_AVERAGE_ASSUMPTIONS), for the "Match world average
  // week" goal preset. Much rougher than the UK figures above - there's no
  // single global survey of commute distances or diets the way the UK has
  // national travel/diet surveys, so this blends a lower car-commute
  // distance and less meat than the UK figures, reflecting that most of
  // the world's population drives less and eats less meat on average than
  // the UK does. Treat this one as more illustrative than the others.
  const WORLD_AVERAGE_WEEKLY_KG = (() => {
    const wasteMult = FOOD_WASTE_MULTIPLIERS.some;
    // ~4km one-way car-equivalent, reusing the UK figure's 5-day working
    // week rather than guessing a separate global commuting-frequency
    // number - the "world drives less" assumption is already captured via
    // the shorter distance, not via commuting fewer days.
    const commuteWeekly = TRANSPORT_FACTORS.car * 4 * 2 * UK_AVERAGE_ASSUMPTIONS.commuteDaysPerWeek;
    const meatDays = [
      { meat: "chicken", portion: "medium" },
      { meat: "chicken", portion: "medium" },
      { meat: "fish", portion: "medium" },
    ];
    const meatWeekly = meatDays.reduce((sum, day) => {
      const meatFactor = MEAT_FACTORS[day.meat] ?? MEAT_FACTORS.other;
      const portionKg = PORTION_KG[day.portion] ?? PORTION_KG.medium;
      return sum + (meatFactor * portionKg + MEAT_SIDES_BASELINE) * wasteMult;
    }, 0);
    const veggieWeekly = 4 * FOOD_DAY_FACTORS.veggie * wasteMult; // 4 veggie days
    return commuteWeekly + meatWeekly + veggieWeekly;
  })();

  const DEFAULT_PROFILE = {
    name: "",
    commuteDistanceKm: 8,
    // Matches the "Match UK average week" preset - a brand-new,
    // unmodified profile starts out neither ahead of nor behind the UK
    // average, rather than a flat number that can go stale relative to
    // the underlying emission factors. (This used to be a hardcoded 20,
    // which looked fine when FOOD_DAY_FACTORS.veggie was 1.5, but after
    // that moved to 2.6 - see the Rosi et al. update - an all-veggie
    // week's food alone came to ~93% of that old default before any
    // commute was even added, making a fully plant-based diet look like
    // it was barely beating a stale goal instead of clearly beating a
    // live one. Existing accounts keep whatever weekly_goal_kg is already
    // saved for them - only brand-new profiles pick this up.)
    weeklyGoalKg: Math.round(UK_AVERAGE_WEEKLY_KG * 10) / 10,
    foodWaste: "low",
    shortHaulFlights: 0,
    longHaulFlights: 0,
    householdPeople: 1,
    householdKwhPerMonth: 0,
    clothesPerMonth: 0,
    // Optional extras: null means "not answered", and stays out of every
    // total (never coerced to 0) until the person actually answers.
    annualGasKwh: null,
    ownsCar: null,
    numDogs: null,
    numCats: null,
    annualWaterM3: null,
    bankName: null,
    bankBalance: null,
    // Off by default - nothing is shared until the user actively opts in.
    // See research_profiles / research_weeks in schema.sql for exactly
    // what this exposes (everything on this page except banking) and to
    // whom (the app owner only, via the Supabase SQL Editor - never
    // readable through the app itself).
    researchOptIn: false,
    // Optional: a fully-confirmed week_key to compare This Week's card
    // against instead of the UK average - null means "use the UK average"
    // (the default for everyone until they pick one on the Account page).
    baselineWeekKey: null,
    // Optional: "diesel" | "hybrid" | "electric" - null means use the
    // blended-average car factor (TRANSPORT_FACTORS.car) everywhere.
    carFuelType: null,
    // Optional: e.g. "UCL"/"Imperial"/"KCL" - null means "prefer not to say"
    // (the select's "None" option). Used for the Home page's uni-average
    // comparison chip once enough people from the same university opt in.
    university: null,
  };

  function blankWeek() {
    return {
      commute: Object.fromEntries(DAYS.map((d) => [d.key, "none"])),
      diet: Object.fromEntries(DAYS.map((d) => [d.key, { type: "" }])),
      confirmedCommute: Object.fromEntries(DAYS.map((d) => [d.key, false])),
      confirmedDiet: Object.fromEntries(DAYS.map((d) => [d.key, false])),
      alcohol: { beer: 0, wine: 0, spiritsShots: 0, spiritsAbv: 40 },
      // One-off trips beyond the regular day-by-day commute above - each
      // { day, mode, km }. Not gated by a confirm flow (same as alcohol):
      // adding one counts it immediately.
      extraJourneys: [],
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

  // Which DAYS entry a given date falls on, regardless of which week it's
  // in - unlike todayDayKey() above (always "today", always the current
  // week), this works for any date, e.g. "yesterday" when that's actually
  // in last week's data (viewing on a Monday).
  function dayKeyFor(date) {
    return DAYS[(date.getDay() + 6) % 7].key; // JS Sun=0...Sat=6 -> Mon=0...Sun=6
  }

  // Whether a given date's commute/diet have been confirmed, wherever that
  // date's week lives in weeksCache (this week or last week).
  function dayConfirmStatus(date) {
    const weekData = weeksCache[weekKeyFor(date)];
    const dayKey = dayKeyFor(date);
    return {
      commuteDone: !!weekData?.confirmedCommute?.[dayKey],
      dietDone: !!weekData?.confirmedDiet?.[dayKey],
    };
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

  // A stricter bar than hasAnyConfirmed: every day has BOTH commute and diet
  // confirmed, i.e. the whole week was actually logged, not just a day or
  // two. Used for "confirmed week" figures that average across weeks (Stats
  // page, Leaderboard's all-time average) so a week where only Monday got
  // confirmed doesn't drag the average down as if it were a real full week.
  // Deliberately NOT used for the Weeks grid's in-progress coloring or the
  // live "This week" leaderboard, which both need to work on a week that's
  // still only partially through.
  function isFullyConfirmed(weekData) {
    if (!weekData) return false;
    return DAYS.every((day) => weekData.confirmedCommute?.[day.key] && weekData.confirmedDiet?.[day.key]);
  }

  // ---------- Footprint math ----------
  function commuteFootprint(weekData, dayKey) {
    const mode = weekData.commute[dayKey];
    const factor = mode === "car" ? carFactorFor(profile) : (TRANSPORT_FACTORS[mode] ?? 0);
    return factor * (profile.commuteDistanceKm || 0) * 2;
  }

  // A one-off "additional journey" (This Week page, under Alcohol) - unlike
  // the daily commute above, the km entered is the journey's own real
  // distance, not doubled, since a one-off trip isn't necessarily a round
  // trip the way a commute is.
  function journeyFootprint(mode, km) {
    const factor = mode === "car" ? carFactorFor(profile) : (TRANSPORT_FACTORS[mode] ?? 0);
    return factor * (km || 0);
  }

  function extraJourneysFootprintForDay(weekData, dayKey) {
    return (weekData.extraJourneys || [])
      .filter((j) => j.day === dayKey)
      .reduce((sum, j) => sum + journeyFootprint(j.mode, j.km), 0);
  }

  // Just the Car-mode slice of the above - this is what "Non-commute
  // driving" on the Home page means now (see weekTotals() below): logging a
  // one-off trip as Car is treated as genuine extra driving outside your
  // regular commute, same rationale as the "assumes Car is the trip you'd
  // otherwise have made" congrats-popup logic above.
  function extraCarJourneysFootprintForDay(weekData, dayKey) {
    return (weekData.extraJourneys || [])
      .filter((j) => j.day === dayKey && j.mode === "car")
      .reduce((sum, j) => sum + journeyFootprint(j.mode, j.km), 0);
  }

  function wasteMultiplier() {
    return FOOD_WASTE_MULTIPLIERS[profile.foodWaste] ?? 1;
  }

  function foodFootprint(weekData, dayKey) {
    const entry = weekData.diet[dayKey];
    if (!entry || !entry.type) return 0;
    const eatOutMult = entry.eatOut ? EATING_OUT_MULTIPLIER : 1;
    let base;
    if (entry.type === "vegan" || entry.type === "veggie") {
      const dayTotal = entry.type === "vegan" ? FOOD_DAY_FACTORS.vegan : FOOD_DAY_FACTORS.veggie;
      const dinner = dayTotal * VEGGIE_DINNER_SHARE;
      const restOfDay = dayTotal - dinner;
      base = restOfDay + dinner * eatOutMult;
    } else if (entry.type === "meat") {
      const meatFactor = MEAT_FACTORS[entry.meat] ?? MEAT_FACTORS.other;
      const portionKg = PORTION_KG[entry.portion] ?? PORTION_KG.medium;
      base = MEAT_SIDES_BASELINE + meatFactor * portionKg * eatOutMult;
    } else {
      return 0;
    }
    return base * wasteMultiplier();
  }

  // How much extra a meat choice adds on top of an equivalent veggie day —
  // the meat portion's own footprint (scaled up the same way by eating out,
  // since a meat dinner out costs proportionally more than a veggie one
  // out too), on top of a rest-of-day baseline valued the same either way.
  function meatExtra(entry) {
    const meatFactor = MEAT_FACTORS[entry.meat] ?? MEAT_FACTORS.other;
    const portionKg = PORTION_KG[entry.portion] ?? PORTION_KG.medium;
    const eatOutMult = entry.eatOut ? EATING_OUT_MULTIPLIER : 1;
    return meatFactor * portionKg * eatOutMult * wasteMultiplier();
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

  // commute stays the combined figure (regular commute + every extra
  // journey, any mode) - This Week's own totals, the leaderboard, and goal
  // colors all keep using this exactly as before. commuteOnly/nonCommuteCar
  // split that same data into non-car-extra vs car-extra, purely so the
  // Home page can show "Commute" and "Non-commute driving" as two
  // non-overlapping tiles/bar segments that still add up to this same
  // combined commute figure.
  function weekTotals(weekData) {
    let commute = 0;
    let commuteOnly = 0;
    let nonCommuteCar = 0;
    let food = 0;
    const daily = [];
    DAYS.forEach((day) => {
      const regular = countedCommuteFootprint(weekData, day.key);
      const carExtra = extraCarJourneysFootprintForDay(weekData, day.key);
      const allExtra = extraJourneysFootprintForDay(weekData, day.key);
      const c = regular + allExtra;
      commute += c;
      commuteOnly += regular + (allExtra - carExtra);
      nonCommuteCar += carExtra;
      const f = countedFoodFootprint(weekData, day.key);
      food += f;
      daily.push(c + f);
    });
    const alcohol = alcoholFootprint(weekData);
    return { commute, commuteOnly, nonCommuteCar, food, alcohol, total: commute + food + alcohol, daily };
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
        ownsCar: data.owns_car ?? null,
        numDogs: data.num_dogs ?? null,
        numCats: data.num_cats ?? null,
        annualWaterM3: data.annual_water_m3 ?? null,
        bankName: data.bank_name ?? null,
        bankBalance: data.bank_balance ?? null,
        researchOptIn: data.research_opt_in ?? false,
        baselineWeekKey: data.baseline_week_key ?? null,
        carFuelType: data.car_fuel_type ?? null,
        university: data.university ?? null,
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
      owns_car: profile.ownsCar,
      num_dogs: profile.numDogs,
      num_cats: profile.numCats,
      annual_water_m3: profile.annualWaterM3,
      bank_name: profile.bankName,
      bank_balance: profile.bankBalance,
      research_opt_in: profile.researchOptIn,
      baseline_week_key: profile.baselineWeekKey,
      car_fuel_type: profile.carFuelType,
      university: profile.university,
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
        // Fall back to all-zero for rows saved before this column existed.
        alcohol: { ...blank.alcohol, ...(row.alcohol || {}) },
        // Fall back to empty for rows saved before this column existed.
        extraJourneys: row.extra_journeys || [],
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
        alcohol: weekData.alcohol,
        extra_journeys: weekData.extraJourneys,
        total_kg: totals.total,
        commute_food_kg: totals.commute + totals.food,
        commute_kg: totals.commute,
        food_kg: totals.food,
        alcohol_kg: totals.alcohol,
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
        .select(
          "id, display_name, short_haul_flights_per_year, long_haul_flights_per_year, " +
          "household_kwh_per_month, household_people, clothes_per_month, " +
          "annual_gas_kwh, owns_car, car_fuel_type, num_dogs, num_cats, annual_water_m3, " +
          "bank_name, bank_balance"
        )
        .in("id", otherIds);
      (profs || []).forEach((p) => {
        namesById[p.id] = p.display_name || "(no name set)";
        friendExtrasById[p.id] = {
          shortHaulFlights: p.short_haul_flights_per_year ?? 0,
          longHaulFlights: p.long_haul_flights_per_year ?? 0,
          householdKwhPerMonth: p.household_kwh_per_month ?? 0,
          householdPeople: p.household_people ?? 1,
          clothesPerMonth: p.clothes_per_month ?? 0,
          annualGasKwh: p.annual_gas_kwh ?? null,
          ownsCar: p.owns_car ?? null,
          carFuelType: p.car_fuel_type ?? null,
          numDogs: p.num_dogs ?? null,
          numCats: p.num_cats ?? null,
          annualWaterM3: p.annual_water_m3 ?? null,
          bankName: p.bank_name ?? null,
          bankBalance: p.bank_balance ?? null,
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
  const TABS = ["stats", "week", "weeks", "leaderboard", "account"];

  function currentTab() {
    const fromHash = (location.hash || "").replace("#", "");
    return TABS.includes(fromHash) ? fromHash : "stats";
  }

  function showTab(tab) {
    TABS.forEach((t) => {
      document.getElementById(`view-${t}`).hidden = t !== tab;
    });
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    if (tab === "weeks") renderYearlyInputs();
    if (tab === "leaderboard") { renderLeaderboard(); renderWeeklyAverageLeaderboard(); renderAppWideAverage(); }
    if (tab === "stats") renderStatsPage();
    if (tab === "account") renderAccountPage();
    if (tab === "week") { renderWeekPage(); renderWeeksGrid(); }
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
    if (!entry || !entry.type) return "";
    const parts = [];
    if (entry.type === "meat") parts.push(`${MEAT_LABELS[entry.meat] ?? "Meat"} – ${PORTION_LABELS[entry.portion] ?? ""}`);
    if (entry.eatOut) parts.push("Eating out (dinner)");
    return parts.join(" · ");
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
        btn.textContent = meat ? (MEAT_ICONS[meat] || "?") : label;
        btn.title = title;
        btn.setAttribute("aria-label", title);
        const isActive = entry?.type === type && (!meat || entry.meat === meat);
        btn.classList.toggle("active", isActive);
        btn.addEventListener("click", () => {
          const eatOut = entry?.eatOut || false;
          if (type === "meat") {
            setDietEntry(weekData, day.key, { type: "meat", meat, portion: entry?.meat === meat ? entry.portion : "medium", eatOut }, confirmBtn);
          } else {
            setDietEntry(weekData, day.key, { type, eatOut }, confirmBtn);
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
      }

      if (entry?.type) {
        const eatRow = document.createElement("div");
        eatRow.className = "eat-row";
        eatRow.setAttribute("role", "group");
        eatRow.setAttribute("aria-label", `Eating in or out for dinner, ${day.full}`);
        [
          { value: false, label: "In" },
          { value: true, label: "Out" },
        ].forEach(({ value, label }) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "eat-opt";
          btn.textContent = label;
          btn.title = value ? "Eating out for dinner" : "Eating in for dinner";
          btn.classList.toggle("active", Boolean(entry.eatOut) === value);
          btn.addEventListener("click", () => {
            setDietEntry(weekData, day.key, { ...entry, eatOut: value }, confirmBtn);
          });
          eatRow.appendChild(btn);
        });
        cell.appendChild(eatRow);

        const summaryText = dietSummaryText(entry);
        if (summaryText) {
          const summary = document.createElement("span");
          summary.className = "diet-summary";
          summary.textContent = summaryText;
          cell.appendChild(summary);
        }
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
    document.getElementById("total-alcohol").textContent = fmt(totals.alcohol);
    document.getElementById("total-week").textContent = fmt(totals.total);
    document.getElementById("week-range-heading").firstChild.textContent =
      `${weekPickerHeading(selectedWeekKey)} (${weekLabel(selectedWeekKey)}) `;

    document.querySelectorAll("#week-picker .week-picker-btn").forEach((btn) => {
      const isCurrent = btn.dataset.week === "current";
      btn.classList.toggle("active", isCurrent ? selectedWeekKey === CURRENT_WEEK_KEY : selectedWeekKey === LAST_WEEK_KEY);
    });

    renderAlcoholSection(weekData);
    renderJourneyList(weekData);
    renderComparisonCard(weekData, totals);
    renderAverageWeekCard(selectedWeekKey, totals);
  }

  // A fully-confirmed week the person has picked on the Account page to
  // compare against instead of the UK average - null if they haven't set
  // one, or if the week they picked is no longer in weeksCache (e.g. after
  // a data reset). Recomputed live from stored commute/diet choices, same
  // as any other week's total, so it stays in sync with the current
  // emission-factor constants rather than being a frozen snapshot.
  function getBaselineWeekData() {
    if (!profile.baselineWeekKey) return null;
    return weeksCache[profile.baselineWeekKey] || null;
  }

  // "Compared to an average week" card: a savings-framed comparison against
  // either a UK-average week (commute + food, same bottom-up figures as the
  // Stats page) or, if set, the person's own chosen baseline week -
  // prorated to how far through the week it is either way, so it's
  // meaningful Wednesday, not just Sunday, and doesn't require logging
  // every category to be useful (unlike a full manual carbon calculator).
  function renderAverageWeekCard(weekKey, totals) {
    const baselineWeekData = getBaselineWeekData();
    const usingBaseline = !!baselineWeekData;
    // Baseline mode compares full week totals (commute + food + alcohol) -
    // unlike the UK average, which is commute + food only because there's
    // no real "UK average alcohol" figure to compare against, a personal
    // baseline week has real alcohol data on both sides, so there's no
    // reason to leave it out.
    const fullReferenceKg = usingBaseline ? weekTotals(baselineWeekData).total : UK_AVERAGE_WEEKLY_KG;
    const referenceKg = prorateForCurrentWeek(weekKey, fullReferenceKg);

    document.getElementById("avg-week-title").textContent = usingBaseline ? "Compared to your baseline week" : "Compared to an average week";
    document.getElementById("avg-week-desc-lead").textContent = usingBaseline
      ? `Your baseline week (${weekLabel(profile.baselineWeekKey)})`
      : "An average UK week (commute + food only, the same bottom-up figures used on the Stats page)";
    document.getElementById("avg-week-value").textContent = fmt(fullReferenceKg);

    const saved = referenceKg - totals.total;
    const valueEl = document.getElementById("avg-week-savings-value");
    const labelEl = document.getElementById("avg-week-savings-label");
    const boxEl = document.getElementById("avg-week-savings-box");

    valueEl.textContent = fmt(Math.abs(saved));
    boxEl.classList.toggle("avg-week-good", saved >= 0);
    boxEl.classList.toggle("avg-week-bad", saved < 0);

    const soFar = weekKey === CURRENT_WEEK_KEY ? " so far" : "";
    const referenceLabel = usingBaseline ? "your baseline week" : "an average week";
    labelEl.textContent = saved >= 0
      ? `kg CO2e saved vs ${referenceLabel}${soFar}`
      : `kg CO2e over ${referenceLabel}${soFar}`;
  }

  function setAlcoholField(weekData, applyFn) {
    applyFn(weekData.alcohol);
    persistWeek(selectedWeekKey);
    renderFootprints();
  }

  function buildFillRow(containerId, count, iconSvg, unitLabel, onSet) {
    const row = document.getElementById(containerId);
    row.innerHTML = "";
    for (let i = 1; i <= ALCOHOL_FILL_MAX; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "alcohol-fill-opt" + (i <= count ? " active" : "");
      btn.innerHTML = iconSvg;
      btn.title = `${i} ${unitLabel}${i === 1 ? "" : "s"}`;
      btn.setAttribute("aria-label", btn.title);
      btn.addEventListener("click", () => {
        // Clicking the icon that's already the current count clears it back
        // to 0 (a quick way to undo), otherwise it sets the count to that icon's position.
        onSet(i === count ? 0 : i);
      });
      row.appendChild(btn);
    }
  }

  function renderAlcoholSection(weekData) {
    const a = weekData.alcohol || { beer: 0, wine: 0, spiritsShots: 0, spiritsAbv: 40 };

    buildFillRow("alcohol-beer-fill", a.beer || 0, BEER_ICON_SVG, "beer", (count) => {
      setAlcoholField(weekData, (alc) => { alc.beer = count; });
    });
    buildFillRow("alcohol-wine-fill", a.wine || 0, WINE_ICON_SVG, "glass", (count) => {
      setAlcoholField(weekData, (alc) => { alc.wine = count; });
    });

    document.getElementById("alcohol-beer-count").textContent =
      `${a.beer || 0} beer${a.beer === 1 ? "" : "s"} · ${fmt((a.beer || 0) * BEER_KG_PER_DRINK)} kg`;
    document.getElementById("alcohol-wine-count").textContent =
      `${a.wine || 0} glass${a.wine === 1 ? "" : "es"} · ${fmt((a.wine || 0) * WINE_KG_PER_GLASS)} kg`;

    document.getElementById("alcohol-spirits-abv").value = a.spiritsAbv ?? 40;
    document.getElementById("alcohol-spirits-shots").value = a.spiritsShots ?? 0;
    const spiritsKg = (a.spiritsShots || 0) * SPIRITS_KG_PER_SHOT_AT_40PCT * ((a.spiritsAbv || 40) / 40);
    document.getElementById("alcohol-spirits-total").textContent = `${fmt(spiritsKg)} kg CO2e`;
  }

  const JOURNEY_MODE_LABELS = { cycle: "Cycle", tube: "Tube", train: "Train", car: "Car" };

  function renderJourneyList(weekData) {
    const list = document.getElementById("journey-list");
    if (!list) return;
    list.innerHTML = "";
    (weekData.extraJourneys || []).forEach((j, i) => {
      const day = DAYS.find((d) => d.key === j.day);
      const kg = journeyFootprint(j.mode, j.km);

      const li = document.createElement("li");
      li.className = "journey-item";
      const text = document.createElement("span");
      text.className = "journey-item-text";
      text.textContent = `${day ? day.full : j.day} · ${JOURNEY_MODE_LABELS[j.mode] || j.mode} · ${fmt(j.km)} km · ${fmt(kg)} kg CO2e`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "journey-remove-btn";
      removeBtn.setAttribute("aria-label", `Remove ${day ? day.full : j.day} journey`);
      removeBtn.textContent = "×";
      removeBtn.dataset.index = i;

      li.appendChild(text);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
  }

  let selectedJourneyMode = null;

  function addJourney() {
    const kmInput = document.getElementById("journey-km");
    const daySelect = document.getElementById("journey-day");
    const km = parseFloat(kmInput.value);
    if (!selectedJourneyMode || !(km > 0)) return;
    const mode = selectedJourneyMode;

    const weekData = getWeek(selectedWeekKey);
    weekData.extraJourneys = weekData.extraJourneys || [];
    weekData.extraJourneys.push({ day: daySelect.value, mode, km });

    persistWeek(selectedWeekKey);
    renderFootprints();

    kmInput.value = "";
    document.querySelectorAll(".journey-mode-btn").forEach((btn) => btn.classList.remove("active"));
    selectedJourneyMode = null;

    // Car is treated as the default/"what you'd have done anyway" mode, so
    // only a non-car choice has anything to celebrate - and only if it's
    // actually lower than car would have been (always true for the four
    // options offered here, but guarded in case that ever changes).
    if (mode !== "car") {
      const savedKg = journeyFootprint("car", km) - journeyFootprint(mode, km);
      if (savedKg > 0) {
        document.getElementById("journey-congrats-value").textContent = fmt(savedKg);
        document.getElementById("journey-congrats-backdrop").classList.add("open");
      }
    }
  }

  function removeJourney(index) {
    const weekData = getWeek(selectedWeekKey);
    (weekData.extraJourneys || []).splice(index, 1);
    persistWeek(selectedWeekKey);
    renderFootprints();
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
  // from a goal to 0 in a straight line across the tracked span, and a solid
  // line tracks the actual remaining budget (goal minus CO2e confirmed so
  // far). Falling below the dashed line means CO2e is being used faster than
  // the goal allows for how far through the span it is; staying above it
  // means on pace or ahead. The actual line only draws up to the current
  // point - it doesn't project forward. Shared by the This Week page's
  // weekly chart and the Stats page's yearly one below, parameterized on
  // `goal`/`predicted`/`actualPoints`/`xLabels` so both stay pixel-for-pixel
  // consistent and any future tweak to one applies to both automatically.
  // actualStartJ lets the actual line begin partway along the x-axis instead
  // of always at j=0 - used by the yearly chart so the stretch before
  // tracking began is left blank (no line, no green) rather than plotted as
  // a flat "remaining = goal" run that would misleadingly look on-track.
  function renderBudgetChart(containerId, { goal, predicted, actualPoints, xLabels, actualStartJ = 0, goalLabelSuffix = "kg goal", ariaPrefix = "Budget pace" }) {
    const chart = document.getElementById(containerId);
    if (!chart) return;
    chart.innerHTML = "";

    const totalUnits = predicted.length - 1;

    // Match the viewBox to the chart's actual rendered pixel width so 1 SVG
    // unit = 1 real pixel in both axes - otherwise a fixed viewBox stretched
    // to fit varying card widths distorts strokes, dots, and text
    // horizontally (preserveAspectRatio="none" scales x/y independently).
    // Falls back to 340 if the chart is currently hidden (width 0), e.g.
    // when a change on another tab re-renders it in the background; it's
    // recomputed correctly next time this tab is actually shown.
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

    const xAt = (j) => PAD_X + (j / totalUnits) * plotW;
    const yAt = (v) => PAD_TOP + (1 - (v - yMin) / yRange) * plotH;
    const pathFor = (values, startJ = 0) => values.map((v, k) => `${k === 0 ? "M" : "L"}${xAt(startJ + k).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

    const predictedPath = pathFor(predicted);
    const actualPath = pathFor(actualPoints, actualStartJ);
    const lastJ = actualStartJ + actualPoints.length - 1;
    const finalActual = actualPoints[actualPoints.length - 1];
    const onTrack = finalActual >= predicted[lastJ];
    const zeroY = yAt(0).toFixed(1);
    const areaPath = `${actualPath} L${xAt(lastJ).toFixed(1)},${zeroY} L${xAt(actualStartJ).toFixed(1)},${zeroY} Z`;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    svg.setAttribute("class", `budget-chart-svg ${onTrack ? "on-track" : "over-track"}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${ariaPrefix}: ${onTrack ? "on track" : "over pace"}, ${fmt(Math.abs(finalActual))} kg CO2e ${finalActual >= 0 ? "remaining" : "over"}`);

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
      zeroLine.setAttribute("x1", xAt(0)); zeroLine.setAttribute("x2", xAt(totalUnits));
      zeroLine.setAttribute("y1", zeroY); zeroLine.setAttribute("y2", zeroY);
      zeroLine.setAttribute("class", "budget-zero-line");
      svg.appendChild(zeroLine);
    }

    if (actualStartJ > 0) {
      const startLine = document.createElementNS(svgNS, "line");
      startLine.setAttribute("x1", xAt(actualStartJ)); startLine.setAttribute("x2", xAt(actualStartJ));
      startLine.setAttribute("y1", PAD_TOP); startLine.setAttribute("y2", H - PAD_BOTTOM);
      startLine.setAttribute("class", "budget-zero-line");
      svg.appendChild(startLine);
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
    goalLabel.textContent = `${fmt(goal)} ${goalLabelSuffix}`;
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

    xLabels.forEach(({ j, text, isCurrent }) => {
      const label = document.createElementNS(svgNS, "text");
      label.textContent = text;
      label.setAttribute("x", xAt(j).toFixed(1));
      label.setAttribute("y", H - 6);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "budget-day-label" + (isCurrent ? " is-today" : ""));
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

  // The Monday of whichever week you first confirmed at least one day (commute
  // or diet) - used below so the month/year views' actual line doesn't start
  // drawing from the beginning of that span for someone who only started
  // using the app partway through it. Falls back to the current week for a
  // brand-new account with nothing confirmed yet.
  function firstTrackedWeekKey() {
    const trackedKeys = Object.keys(weeksCache).filter((key) => {
      const w = weeksCache[key];
      return DAYS.some((day) => w.confirmedCommute?.[day.key] || w.confirmedDiet?.[day.key]);
    });
    if (trackedKeys.length === 0) return CURRENT_WEEK_KEY;
    // Week keys are "YYYY-MM-DD" Mondays, so lexical sort is chronological.
    return trackedKeys.sort()[0];
  }

  // Builds a day-by-day kg CO2e array (commute + food, gated by that day's
  // own confirm status, plus that day's own additional journeys and each
  // week's alcohol spread evenly across its 7 days - same technique as
  // before) for every day in [start, today]. Shared by all three Home page
  // budget-pace views below, just with a different `start`/span for each.
  function computeRangeDailyKg(start, today) {
    const todayOffset = Math.round((today - start) / DAY_MS);
    const dailyKg = new Array(Math.max(0, todayOffset) + 1).fill(0);
    Object.keys(weeksCache).forEach((weekKey) => {
      const weekData = weeksCache[weekKey];
      const monday = new Date(`${weekKey}T00:00:00`);
      const alcoholKg = alcoholFootprint(weekData);
      DAYS.forEach((day, i) => {
        const dayDate = new Date(monday);
        dayDate.setDate(dayDate.getDate() + i);
        if (dayDate < start || dayDate > today) return;
        const offset = Math.round((dayDate - start) / DAY_MS);
        if (offset < 0 || offset >= dailyKg.length) return;
        dailyKg[offset] += countedCommuteFootprint(weekData, day.key) + extraJourneysFootprintForDay(weekData, day.key) + countedFoodFootprint(weekData, day.key) + alcoholKg / 7;
      });
    });
    return { dailyKg, todayOffset };
  }

  // Same [start, today] range and same counted/confirmed-only data as
  // computeRangeDailyKg() above, but split into commute/food/alcohol/
  // nonCommuteCar instead of summed into one daily total - feeds the domain
  // bar chart, so its segments always add up to exactly the total the pace
  // chart above it is plotting. nonCommuteCar is just the Car-mode slice of
  // logged Additional Journeys (see extraCarJourneysFootprintForDay) -
  // pulled out of commute so the two show as separate, non-overlapping
  // segments/tiles.
  function computeRangeDomainKg(start, today) {
    let commute = 0, food = 0, alcohol = 0, nonCommuteCar = 0;
    Object.keys(weeksCache).forEach((weekKey) => {
      const weekData = weeksCache[weekKey];
      const monday = new Date(`${weekKey}T00:00:00`);
      const alcoholPerDay = alcoholFootprint(weekData) / 7;
      DAYS.forEach((day, i) => {
        const dayDate = new Date(monday);
        dayDate.setDate(dayDate.getDate() + i);
        if (dayDate < start || dayDate > today) return;
        const carExtra = extraCarJourneysFootprintForDay(weekData, day.key);
        commute += countedCommuteFootprint(weekData, day.key) + extraJourneysFootprintForDay(weekData, day.key) - carExtra;
        nonCommuteCar += carExtra;
        food += countedFoodFootprint(weekData, day.key);
        alcohol += alcoholPerDay;
      });
    });
    return { commute, food, alcohol, nonCommuteCar };
  }

  // Lifetime "Total CO2 saved" hero at the top of the Home page: your real
  // confirmed commute + food + alcohol emissions since the week you first
  // confirmed a day, vs. a weekly reference rate scaled by days elapsed -
  // the same flat linear-rate convention the budget pace chart's own
  // dashed target line uses, just anchored to a savings reference instead
  // of your goal. Two swipeable slides, Instagram-carousel style: the UK
  // average (always available), and your own baseline week if you've set
  // one on the Account page (same "your own week instead of the UK
  // average" choice already offered on This Week's "Compared to" card -
  // see renderAverageWeekCard()). Illustrative only: days you haven't
  // logged count as zero on your side, same known approximation as the
  // pace chart above it.
  // Swipe/scroll -> active dot sync for any Instagram-style carousel (see
  // .carousel/.carousel-slide/.carousel-dots in style.css) - pure native
  // scroll-snap drives the actual swiping; this just reflects scroll
  // position back into the dots underneath. Shared by every carousel on
  // the Home page (savings totaliser, "Your year, estimated" groups, and
  // the compare chips).
  function wireCarousel(carouselId, dotsId) {
    const carousel = document.getElementById(carouselId);
    const dots = document.querySelectorAll(`#${dotsId} .carousel-dot`);
    if (!carousel) return;
    let ticking = false;
    carousel.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const index = Math.round(carousel.scrollLeft / Math.max(1, carousel.clientWidth));
        dots.forEach((dot, i) => dot.classList.toggle("active", i === index));
        ticking = false;
      });
    });
  }

  function renderSavingsSlide(heroId, valueId, labelId, hasTrackedData, noDataMessage, referenceWeeklyKg, totalDays, actualTotal, referenceLabel) {
    const hero = document.getElementById(heroId);
    const valueEl = document.getElementById(valueId);
    const labelEl = document.getElementById(labelId);
    if (!hero || !valueEl || !labelEl) return;
    hero.classList.remove("over-average", "no-data");

    if (!hasTrackedData) {
      hero.classList.add("no-data");
      valueEl.textContent = "–";
      labelEl.textContent = noDataMessage;
      return;
    }

    const referenceTotal = referenceWeeklyKg * (totalDays / 7);
    const savedKg = referenceTotal - actualTotal;

    if (savedKg < 0) {
      hero.classList.add("over-average");
      valueEl.textContent = Math.round(Math.abs(savedKg)).toLocaleString();
      labelEl.textContent = `kg CO2e more than ${referenceLabel} since you started tracking`;
    } else {
      valueEl.textContent = Math.round(savedKg).toLocaleString();
      labelEl.textContent = `kg CO2e saved vs ${referenceLabel} since you started tracking`;
    }
  }

  function renderSavingsTotaliser() {
    const hasTrackedData = Object.values(weeksCache).some(hasAnyConfirmed);
    let actualTotal = 0;
    let totalDays = 1;
    if (hasTrackedData) {
      const start = new Date(`${firstTrackedWeekKey()}T00:00:00`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      totalDays = Math.max(1, Math.round((today - start) / DAY_MS) + 1);
      actualTotal = computeRangeDailyKg(start, today).dailyKg.reduce((sum, kg) => sum + kg, 0);
    }

    renderSavingsSlide(
      "home-savings-hero", "home-savings-value", "home-savings-label",
      hasTrackedData, "Confirm a day to start tracking how much you're saving vs the UK average.",
      UK_AVERAGE_WEEKLY_KG, totalDays, actualTotal, "the UK average"
    );

    const baselineWeekData = getBaselineWeekData();
    const baselineHero = document.getElementById("home-savings-baseline-hero");
    const baselineValueEl = document.getElementById("home-savings-baseline-value");
    const baselineLabelEl = document.getElementById("home-savings-baseline-label");
    if (!baselineWeekData) {
      if (baselineHero && baselineValueEl && baselineLabelEl) {
        baselineHero.classList.remove("over-average");
        baselineHero.classList.add("no-data");
        baselineValueEl.textContent = "–";
        baselineLabelEl.textContent = "Set a baseline week on the Account page to compare here.";
      }
      return;
    }
    renderSavingsSlide(
      "home-savings-baseline-hero", "home-savings-baseline-value", "home-savings-baseline-label",
      hasTrackedData, "Confirm a day to start tracking how much you're saving vs your baseline week.",
      weekTotals(baselineWeekData).total, totalDays, actualTotal, "your baseline week"
    );
  }

  // The three Home page views' bounds: what day they start counting from,
  // how many days they span, and the goal for that span - scaled off the
  // weekly goal so the implied daily rate is the same across all three
  // (month = weekly goal x days-in-month/7, year = weekly goal x52).
  // `applyTrackingStart` marks month/year as needing the "start on the
  // target line" treatment below - not applied to the week view, since a
  // week is short enough that whatever wasn't logged simply isn't counted,
  // same as this chart has always behaved.
  function periodBounds(period) {
    const now = new Date();
    const weeklyGoal = Math.max(0.0001, currentGoal());
    if (period === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      return { start, totalDays, goal: weeklyGoal * (totalDays / 7), applyTrackingStart: true };
    }
    if (period === "year") {
      const start = new Date(now.getFullYear(), 0, 1);
      const y = now.getFullYear();
      const isLeapYear = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      return { start, totalDays: isLeapYear ? 366 : 365, goal: weeklyGoal * 52, applyTrackingStart: true };
    }
    return { start: weekStart(now), totalDays: 7, goal: weeklyGoal, applyTrackingStart: false };
  }

  // x-axis tick labels per period: day-of-week letters for a week (same as
  // before), day-of-month numbers roughly weekly for a month, and month
  // abbreviations for a year - each highlighting whichever tick sits
  // closest to today.
  function periodXLabels(period, start, totalDays, todayOffset) {
    if (period === "week") {
      return DAYS.map((day, i) => ({ j: i + 1, text: day.short, isCurrent: i === todayOffset }));
    }
    if (period === "year") {
      const currentMonth = new Date().getMonth();
      const labels = [];
      for (let m = 0; m < 12; m++) {
        const monthStart = new Date(start.getFullYear(), m, 1);
        const j = Math.round((monthStart - start) / DAY_MS);
        labels.push({ j, text: MONTH_SHORT_LABELS[m], isCurrent: m === currentMonth });
      }
      return labels;
    }
    const labels = [];
    for (let j = 0; j < totalDays; j += 7) {
      const d = new Date(start);
      d.setDate(d.getDate() + j);
      labels.push({ j, text: String(d.getDate()), isCurrent: false });
    }
    let nearestIdx = 0;
    labels.forEach((label, i) => {
      if (Math.abs(label.j - todayOffset) < Math.abs(labels[nearestIdx].j - todayOffset)) nearestIdx = i;
    });
    labels[nearestIdx].isCurrent = true;
    return labels;
  }

  const DOMAIN_LABELS = {
    food: "Food",
    commute: "Commute",
    nonCommuteCar: "Non-commute driving",
    alcohol: "Alcohol",
    homeEnergy: "Home energy",
    gasHeating: "Gas/oil heating",
    water: "Water",
    pets: "Pets",
    flying: "Flying",
    banks: "Banking",
    goods: "Buying goods",
    carOwnership: "Car manufacturing",
  };
  // Same order as the "Your year, estimated" tiles: day-tracked domains
  // first, then the Home group, then the Other group.
  const DOMAIN_ORDER = ["food", "commute", "nonCommuteCar", "alcohol", "homeEnergy", "gasHeating", "water", "pets", "flying", "banks", "goods", "carOwnership"];

  // Stacked bar showing what the period's total is made up of, domain by
  // domain. Commute/food/alcohol are real tracked totals for [start, today]
  // (same scope as the pace chart above it); the rest (flights, home
  // energy, and the other yearly-estimate categories) have no day-by-day
  // data to draw from, so - same approach as the all-time weekly-average
  // leaderboard - they're each a weekly-equivalent share (yearly ÷ 52),
  // scaled up to match whichever timeframe is selected (×1 for a week,
  // ×totalDays/7 for a month, ×52 for a year).
  function renderDomainBarChart(period, start, today, totalDays) {
    const heading = document.getElementById("home-domain-heading");
    if (heading) heading.textContent = `${PERIOD_LABELS[period]}'s emissions by domain`;

    const bar = document.getElementById("home-domain-bar");
    const legend = document.getElementById("home-domain-legend");
    if (!bar || !legend) return;
    bar.innerHTML = "";
    legend.innerHTML = "";

    const { commute, food, alcohol, nonCommuteCar } = computeRangeDomainKg(start, today);
    const extras = weeklyExtrasBreakdownFor(profile);
    // Matches periodBounds()'s own goal-scaling exactly (month: totalDays/7,
    // year: a flat x52, not totalDays/7 - 365/7 is 52.14, which would
    // inflate every extras figure ~0.3% above the "Your year, estimated"
    // tiles' exact yearly numbers for no good reason).
    const periodScale = period === "year" ? 52 : period === "month" ? totalDays / 7 : 1;

    const values = {
      food, commute, alcohol, nonCommuteCar,
      homeEnergy: extras.homeEnergy * periodScale,
      gasHeating: extras.gasHeating * periodScale,
      water: extras.water * periodScale,
      pets: extras.pets * periodScale,
      flying: extras.flying * periodScale,
      banks: extras.banks * periodScale,
      goods: extras.goods * periodScale,
      carOwnership: extras.carOwnership * periodScale,
    };
    const total = DOMAIN_ORDER.reduce((sum, key) => sum + (values[key] || 0), 0);

    if (total <= 0) {
      const empty = document.createElement("div");
      empty.className = "domain-bar-empty";
      bar.appendChild(empty);
      const li = document.createElement("li");
      li.className = "domain-legend-empty";
      li.textContent = "No emissions to show for this period yet.";
      legend.appendChild(li);
      return;
    }

    DOMAIN_ORDER.forEach((key) => {
      const value = values[key];
      if (!value || value <= 0) return;
      const pct = (value / total) * 100;

      const seg = document.createElement("div");
      seg.className = `domain-bar-segment domain-${key}`;
      seg.style.width = `${pct}%`;
      seg.title = `${DOMAIN_LABELS[key]}: ${fmt(value)} kg CO2e (${Math.round(pct)}%)`;
      bar.appendChild(seg);

      const li = document.createElement("li");
      li.className = "domain-legend-item";
      const swatch = document.createElement("span");
      swatch.className = `domain-legend-swatch domain-${key}`;
      const text = document.createElement("span");
      text.textContent = `${DOMAIN_LABELS[key]} — ${fmt(value)} kg (${Math.round(pct)}%)`;
      li.appendChild(swatch);
      li.appendChild(text);
      legend.appendChild(li);
    });

    const totalLi = document.createElement("li");
    totalLi.className = "domain-legend-total";
    totalLi.textContent = `Total: ${fmt(total)} kg CO2e`;
    legend.appendChild(totalLi);
  }

  const PERIOD_LABELS = { week: "This week", month: "This month", year: "This year" };
  const PERIOD_GOAL_SUFFIX = { week: "kg goal", month: "kg/mo goal", year: "kg/yr goal" };

  // The Home page's single budget-pace chart - a dashed target line burning
  // from the goal to 0 across whichever period is selected, plotted against
  // a solid actual line built day by day from real confirmed
  // commute/food/alcohol data. Replaces what used to be two separate charts
  // (This Week page's weekly one, Stats page's yearly one) with one, toggled
  // by the picker above it.
  let homeChartPeriod = "week";
  function renderPeriodChart(period = homeChartPeriod) {
    homeChartPeriod = period;
    document.querySelectorAll(".home-period-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.period === period);
    });

    const { start, totalDays, goal, applyTrackingStart } = periodBounds(period);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { dailyKg, todayOffset } = computeRangeDailyKg(start, today);

    const predicted = [];
    for (let j = 0; j <= totalDays; j++) predicted.push(goal * (1 - j / totalDays));

    // Untracked days at the start of a month/year (before tracking began)
    // have no data, so there's no way to know what they actually emitted -
    // rather than crediting them as zero-emission (which would make the
    // actual line jump out artificially ahead of pace), they're assumed to
    // have used exactly their fair share of the goal at the target rate.
    // "Remaining budget" at the tracking-start point is therefore the
    // target line's own value there, with real confirmed emissions
    // subtracted from that point onward - so the actual line begins exactly
    // on the dashed target line and only diverges based on what's actually
    // been tracked since.
    let trackingStartOffset = 0;
    if (applyTrackingStart) {
      const trackedStart = new Date(`${firstTrackedWeekKey()}T00:00:00`);
      trackingStartOffset = Math.min(todayOffset, Math.max(0, Math.round((trackedStart - start) / DAY_MS)));
    }
    const budgetAtStart = predicted[trackingStartOffset];

    const cumulative = [0];
    dailyKg.forEach((d, i) => cumulative.push(cumulative[i] + d));
    const remaining = cumulative.map((c) => budgetAtStart - c);
    const actualPoints = remaining.slice(trackingStartOffset, todayOffset + 2);

    const xLabels = periodXLabels(period, start, totalDays, todayOffset);

    renderBudgetChart("home-chart", {
      goal,
      predicted,
      actualPoints,
      actualStartJ: trackingStartOffset,
      xLabels,
      goalLabelSuffix: PERIOD_GOAL_SUFFIX[period],
      ariaPrefix: `${PERIOD_LABELS[period]} budget pace`,
    });

    renderDomainBarChart(period, start, today, totalDays);
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

  // Same day-of-week proration as goalForWeek(), but against a reference
  // figure (the UK average, or a personal baseline week) rather than your
  // personal goal - so "saved vs..." is meaningful mid-week rather than
  // trivially true on a Monday. Past/completed weeks compare against the
  // reference's full value, same as goalForWeek().
  function prorateForCurrentWeek(weekKey, fullKg) {
    if (weekKey !== CURRENT_WEEK_KEY) return fullKg;
    return fullKg * (todayIndexInWeek() / 7);
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
      } else if (isFullyConfirmed(weekData)) {
        const badge = document.createElement("span");
        badge.className = "week-box-badge week-box-badge-full";
        badge.textContent = "✓ FULL";
        badge.title = "Every day this week has both commute and food confirmed";
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

  // Info (ⓘ) popups on a handful of "Your year, estimated" tiles - content
  // lives in tile-info.js (TILE_INFO), a plain, directly-editable file so
  // it can be filled in/edited without touching this file.
  function openTileInfo(key) {
    const entry = TILE_INFO[key];
    if (!entry) return;
    document.getElementById("tile-info-title").textContent = entry.title;
    document.getElementById("tile-info-body").innerHTML = entry.body;
    document.getElementById("tile-info-backdrop").classList.add("open");
  }

  function closeTileInfo() {
    document.getElementById("tile-info-backdrop").classList.remove("open");
  }

  // ---------- Page 3: Leaderboard ----------
  // Flights, home electricity, buying goods, and (if answered) the four
  // optional extras are all yearly figures (Stats page inputs), not
  // weekly - amortized to a weekly-equivalent here (yearly ÷ 52) so the
  // all-time weekly average matches the Stats page's yearly total ÷ 52,
  // not just commute and food. Mirrors the composition of yearlyTotal in
  // renderStatsPage(), just per-week instead of per-year. Kept as a
  // per-domain breakdown (rather than a single summed number) so the Home
  // page's domain bar chart can show each one as its own segment;
  // weeklyExtrasFor() below just sums it for callers that only want the
  // total.
  function weeklyExtrasBreakdownFor(inputs) {
    const flying = ((inputs.shortHaulFlights || 0) * SHORT_HAUL_FLIGHT_KG + (inputs.longHaulFlights || 0) * LONG_HAUL_FLIGHT_KG) / 52;
    const yearlyHomeEnergyTotal = (inputs.householdKwhPerMonth || 0) * 12 * GRID_ELECTRICITY_KG_PER_KWH;
    const homeEnergy = (yearlyHomeEnergyTotal / Math.max(1, inputs.householdPeople || 1)) / 52;
    const goods = ((inputs.clothesPerMonth || 0) * 12 * CLOTHING_ITEM_KG) / 52;

    let gasHeating = 0, carOwnership = 0, pets = 0, water = 0, banks = 0;
    if (inputs.annualGasKwh !== null && inputs.annualGasKwh !== undefined) {
      gasHeating = ((inputs.annualGasKwh * GAS_HEATING_KG_PER_KWH) / Math.max(1, inputs.householdPeople || 1)) / 52;
    }
    if (inputs.ownsCar) {
      carOwnership = CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR / 52;
    }
    if ((inputs.numDogs !== null && inputs.numDogs !== undefined) || (inputs.numCats !== null && inputs.numCats !== undefined)) {
      pets = (((inputs.numDogs || 0) * DOG_KG_PER_YEAR + (inputs.numCats || 0) * CAT_KG_PER_YEAR) / Math.max(1, inputs.householdPeople || 1)) / 52;
    }
    if (inputs.annualWaterM3 !== null && inputs.annualWaterM3 !== undefined) {
      water = ((inputs.annualWaterM3 * WATER_KG_PER_M3) / Math.max(1, inputs.householdPeople || 1)) / 52;
    }
    if (inputs.bankName && inputs.bankBalance !== null && inputs.bankBalance !== undefined) {
      const factor = BANK_KG_PER_POUND_PER_YEAR[inputs.bankName];
      if (factor !== undefined) banks = (factor * inputs.bankBalance) / 52;
    }

    return { flying, homeEnergy, goods, gasHeating, carOwnership, pets, water, banks };
  }

  function weeklyExtrasFor(inputs) {
    const b = weeklyExtrasBreakdownFor(inputs);
    return b.flying + b.homeEnergy + b.goods + b.gasHeating + b.carOwnership + b.pets + b.water + b.banks;
  }

  // kgSuffix/detailText are optional - only "This week" (renderLeaderboard)
  // passes them, for the daily-average figure + a small grey "X kg total ·
  // D/E days" note next to it. Every other caller (renderWeeklyAverageLeaderboard)
  // gets the same "kg" total it always has, unchanged.
  function renderLeaderboardRow(list, rank, label, sub, kg, isSelf, kgSuffix = "kg", detailText = null) {
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

    const totalWrap = document.createElement("span");
    totalWrap.className = "leaderboard-total-wrap";
    const total = document.createElement("span");
    total.className = "leaderboard-total";
    total.textContent = `${fmt(kg)} ${kgSuffix}`;
    totalWrap.appendChild(total);
    if (detailText) {
      const note = document.createElement("span");
      note.className = "leaderboard-sub-note";
      note.textContent = detailText;
      totalWrap.appendChild(note);
    }

    li.appendChild(rankEl);
    li.appendChild(info);
    li.appendChild(totalWrap);
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

    // Ranked (by the RPC) on average daily kg, not raw total - someone
    // who's simply behind on logging so far this week shouldn't look
    // "better" than someone current on every day just because they've
    // logged less. daysElapsed is always today's position in THIS week
    // (Mon=1...Sun=7), since this card only ever shows the current week.
    const daysElapsed = todayIndexInWeek();
    const withAvg = data.map((entry) => ({
      ...entry,
      avgDaily: entry.total_kg / Math.max(1, entry.days_confirmed),
    }));

    if (withAvg.length > 1) {
      const winner = withAvg[0];
      const winnerName = winner.is_self ? "You" : winner.display_name || "A friend";
      winnerEl.textContent = `\u{1F3C6} ${winnerName} ${winner.is_self ? "are" : "is"} winning this week with ${fmt(winner.avgDaily)} kg CO2e/day average.`;
      winnerEl.hidden = false;
    }

    const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
    withAvg.forEach((entry, i) => {
      renderLeaderboardRow(
        list,
        medals[i] || `#${i + 1}`,
        entry.is_self ? "You" : entry.display_name || "Friend",
        weekLabel(CURRENT_WEEK_KEY),
        entry.avgDaily,
        entry.is_self,
        "kg/day",
        `${fmt(entry.total_kg)} kg total · ${entry.days_confirmed}/${daysElapsed} days`
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
    if (!error && data && data[0]) {
      document.getElementById("app-average-commute-food-value").textContent = fmt(data[0].avg_commute_food_alcohol_kg || 0);
      document.getElementById("app-average-total-value").textContent = fmt(data[0].avg_total_kg || 0);
      document.getElementById("app-average-count").textContent = data[0].user_count || 0;
      document.getElementById("app-average-count-2").textContent = data[0].user_count || 0;
    }

    // Total accounts ever created, not just people with a confirmed week
    // (that's what app-average-count above is) - a separate RPC since it
    // reads auth.users, which the averages query above doesn't touch.
    const signups = await sbClient.rpc("total_signups");
    if (!signups.error && typeof signups.data === "number") {
      document.getElementById("app-total-signups").textContent = signups.data;
    }
  }

  // ---------- Page 4: Account ----------
  function renderAccountPage() {
    document.getElementById("profile-name").value = profile.name || "";
    document.getElementById("profile-distance").value = profile.commuteDistanceKm;
    document.getElementById("profile-goal").value = profile.weeklyGoalKg;
    document.getElementById("profile-food-waste").value = profile.foodWaste;
    document.getElementById("profile-university").value = profile.university || "None";
    document.getElementById("research-opt-in").checked = !!profile.researchOptIn;
    document.getElementById("account-email").textContent = currentUser?.email || "";
    document.getElementById("owner-research-export").hidden =
      (currentUser?.email || "").toLowerCase() !== OWNER_EMAIL.toLowerCase();
    populateBaselineWeekSelect();
    renderFriendsUI();
  }

  // Rebuilds the baseline-week dropdown from whichever of the person's own
  // weeks are currently fully confirmed (matching what renderAverageWeekCard
  // is willing to use as a baseline) - run every time the Account page
  // renders, since which weeks qualify can change as more get confirmed.
  function populateBaselineWeekSelect() {
    const select = document.getElementById("baseline-week");
    const fullyConfirmedKeys = Object.keys(weeksCache)
      .filter((key) => isFullyConfirmed(weeksCache[key]))
      .sort((a, b) => (a < b ? 1 : -1)); // newest first

    select.innerHTML = "";
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "UK average (default)";
    select.appendChild(noneOption);

    fullyConfirmedKeys.forEach((key) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = weekLabel(key);
      select.appendChild(option);
    });

    // Falls back to "UK average" if the saved baseline week no longer
    // qualifies (e.g. it's been un-confirmed or the data was reset) -
    // renderAverageWeekCard() falls back the same way, so the dropdown and
    // the actual comparison never disagree about what's in effect.
    select.value = profile.baselineWeekKey && fullyConfirmedKeys.includes(profile.baselineWeekKey)
      ? profile.baselineWeekKey
      : "";
  }

  // ---------- Page: Stats (yearly estimate) ----------
  // All-time average across every fully-confirmed week - feeds the "Your
  // week" card, which is describing a typical confirmed week, not
  // projecting a year, so it isn't windowed to any particular lookback.
  function averageConfirmedWeekly(kind) {
    const weeks = Object.values(weeksCache).filter(isFullyConfirmed);
    if (weeks.length === 0) return 0;
    const sum = weeks.reduce((acc, weekData) => acc + weekTotals(weekData)[kind], 0);
    return sum / weeks.length;
  }

  // Same average, but over fully-confirmed weeks from at most the last 52
  // weeks (a rolling window, not all-time) - feeds only the "Your year,
  // estimated" food/commute/alcohol figures below, so someone who's been
  // tracking for two years gets a yearly PROJECTION based on how they've
  // actually been living lately, not diluted by habits from a year ago
  // that may no longer apply. The "Your week" card above deliberately does
  // NOT use this - it's describing a typical week, not projecting a year.
  function recentAverageConfirmedWeekly(kind) {
    const cutoff = weekStart(new Date());
    cutoff.setDate(cutoff.getDate() - 52 * 7);
    const cutoffKey = dateKey(cutoff);
    const weeks = Object.keys(weeksCache)
      .filter((key) => key >= cutoffKey && isFullyConfirmed(weeksCache[key]))
      .map((key) => weeksCache[key]);
    if (weeks.length === 0) return 0;
    const sum = weeks.reduce((acc, weekData) => acc + weekTotals(weekData)[kind], 0);
    return sum / weeks.length;
  }

  // null/blank -> "" (so the input shows empty, not "0"); a real 0 still shows as 0.
  function optionalInputValue(v) { return v === null || v === undefined ? "" : v; }

  // Populates the "This Year" tab's input fields. Kept separate from
  // renderStatsPage() (the results-only Stats page) since the two now
  // live on different tabs.
  function renderYearlyInputs() {
    document.getElementById("owns-car").value = profile.ownsCar === true ? "yes" : profile.ownsCar === false ? "no" : "";
    document.getElementById("car-fuel-type").value = profile.carFuelType || "";
    document.getElementById("flights-short-haul").value = profile.shortHaulFlights;
    document.getElementById("flights-long-haul").value = profile.longHaulFlights;
    document.getElementById("household-people").value = profile.householdPeople;
    document.getElementById("household-kwh").value = profile.householdKwhPerMonth;
    document.getElementById("gas-heating-kwh").value = optionalInputValue(profile.annualGasKwh);
    document.getElementById("annual-water-m3").value = optionalInputValue(profile.annualWaterM3);
    document.getElementById("num-dogs").value = optionalInputValue(profile.numDogs);
    document.getElementById("num-cats").value = optionalInputValue(profile.numCats);
    document.getElementById("bank-name").value = profile.bankName || "";
    document.getElementById("bank-balance").value = optionalInputValue(profile.bankBalance);
    document.getElementById("clothes-per-month").value = profile.clothesPerMonth;
  }

  function renderStatsPage() {
    // "Your week" card: typical confirmed week, all-time.
    const avgFood = averageConfirmedWeekly("food");
    const avgCommute = averageConfirmedWeekly("commute");
    const avgAlcohol = averageConfirmedWeekly("alcohol");
    // "Your year, estimated": projected from the last 52 weeks only.
    const yearlyFood = recentAverageConfirmedWeekly("food") * 52;
    const yearlyCommute = recentAverageConfirmedWeekly("commuteOnly") * 52;
    const yearlyNonCommuteCar = recentAverageConfirmedWeekly("nonCommuteCar") * 52;
    const yearlyAlcohol = recentAverageConfirmedWeekly("alcohol") * 52;

    const yearlyFlying = profile.shortHaulFlights * SHORT_HAUL_FLIGHT_KG + profile.longHaulFlights * LONG_HAUL_FLIGHT_KG;

    const householdYearlyKwh = profile.householdKwhPerMonth * 12;
    const householdYearlyEnergy = householdYearlyKwh * GRID_ELECTRICITY_KG_PER_KWH;
    const yearlyHomeEnergy = householdYearlyEnergy / Math.max(1, profile.householdPeople || 1);

    const yearlyGoods = profile.clothesPerMonth * 12 * CLOTHING_ITEM_KG;

    let yearlyTotal = yearlyFood + yearlyCommute + yearlyNonCommuteCar + yearlyAlcohol + yearlyFlying + yearlyHomeEnergy + yearlyGoods;

    // Optional extras: only added (and only shown) when actually answered -
    // a blank/unanswered one is left out of the total entirely, not treated
    // as 0, so skipping a question never quietly lowers your estimate.
    // Non-commute driving isn't part of this any more - it's tracked (via
    // Additional Journeys), not a skippable question, so it's already
    // folded into yearlyTotal above alongside food/commute/alcohol.
    const includeOptional = {
      gasHeating: profile.annualGasKwh !== null && profile.annualGasKwh !== undefined,
      carOwnership: profile.ownsCar !== null && profile.ownsCar !== undefined,
      pets: (profile.numDogs !== null && profile.numDogs !== undefined) || (profile.numCats !== null && profile.numCats !== undefined),
      water: profile.annualWaterM3 !== null && profile.annualWaterM3 !== undefined,
      banks: !!profile.bankName && profile.bankBalance !== null && profile.bankBalance !== undefined,
    };
    const yearlyGasHeating = includeOptional.gasHeating ? (profile.annualGasKwh * GAS_HEATING_KG_PER_KWH) / Math.max(1, profile.householdPeople || 1) : null;
    const yearlyCarOwnership = includeOptional.carOwnership ? (profile.ownsCar ? CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR : 0) : null;
    const yearlyPets = includeOptional.pets
      ? ((profile.numDogs || 0) * DOG_KG_PER_YEAR + (profile.numCats || 0) * CAT_KG_PER_YEAR) / Math.max(1, profile.householdPeople || 1)
      : null;
    const yearlyWater = includeOptional.water ? (profile.annualWaterM3 * WATER_KG_PER_M3) / Math.max(1, profile.householdPeople || 1) : null;
    const yearlyBanks = includeOptional.banks ? (BANK_KG_PER_POUND_PER_YEAR[profile.bankName] || 0) * profile.bankBalance : null;
    if (yearlyGasHeating !== null) yearlyTotal += yearlyGasHeating;
    if (yearlyCarOwnership !== null) yearlyTotal += yearlyCarOwnership;
    if (yearlyPets !== null) yearlyTotal += yearlyPets;
    if (yearlyWater !== null) yearlyTotal += yearlyWater;
    if (yearlyBanks !== null) yearlyTotal += yearlyBanks;

    document.getElementById("yearly-avg-food").textContent = fmt(avgFood);
    document.getElementById("yearly-avg-commute").textContent = fmt(avgCommute);
    document.getElementById("yearly-avg-alcohol").textContent = fmt(avgAlcohol);
    document.getElementById("yearly-food").textContent = Math.round(yearlyFood).toLocaleString();
    document.getElementById("yearly-commute").textContent = Math.round(yearlyCommute).toLocaleString();
    document.getElementById("yearly-alcohol").textContent = Math.round(yearlyAlcohol).toLocaleString();
    document.getElementById("yearly-flying").textContent = Math.round(yearlyFlying).toLocaleString();
    document.getElementById("yearly-home-energy").textContent = Math.round(yearlyHomeEnergy).toLocaleString();
    document.getElementById("yearly-goods").textContent = Math.round(yearlyGoods).toLocaleString();
    document.getElementById("yearly-gas-heating").textContent = yearlyGasHeating === null ? "–" : Math.round(yearlyGasHeating).toLocaleString();
    document.getElementById("yearly-noncommute-car").textContent = Math.round(yearlyNonCommuteCar).toLocaleString();
    document.getElementById("yearly-car-ownership").textContent = yearlyCarOwnership === null ? "–" : Math.round(yearlyCarOwnership).toLocaleString();
    document.getElementById("yearly-pets").textContent = yearlyPets === null ? "–" : Math.round(yearlyPets).toLocaleString();
    document.getElementById("yearly-water").textContent = yearlyWater === null ? "–" : Math.round(yearlyWater).toLocaleString();
    document.getElementById("yearly-banking").textContent = yearlyBanks === null ? "–" : Math.round(yearlyBanks).toLocaleString();
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
    setComparisonDiff("yearly-pets-diff", yearlyPets, uk.pets, "kg");
    setComparisonDiff("yearly-water-diff", yearlyWater, uk.water, "kg");
    setComparisonDiff("yearly-banking-diff", yearlyBanks, uk.banks, "kg");

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
    renderYearCompareChips(yearlyTotal, uk.total);
    renderSavingsTotaliser();
    renderPeriodChart();
    renderHomeTodoList();
  }

  // Instagram-carousel version of a single "Compared to: X" slide - reuses
  // the same .year-hero look (and over/no-data modifier classes) as the
  // savings totaliser above it, just swapped in per comparison target
  // instead of per data source.
  function setCompareChip(valueId, labelId, heroId, yourValue, benchmarkValue, label) {
    const valueEl = document.getElementById(valueId);
    const labelEl = document.getElementById(labelId);
    const heroEl = document.getElementById(heroId);
    if (!valueEl || !labelEl || !heroEl) return;
    heroEl.classList.remove("over-average", "no-data");
    if (yourValue === null || yourValue === undefined || benchmarkValue === null || benchmarkValue === undefined) {
      heroEl.classList.add("no-data");
      valueEl.textContent = "–";
      labelEl.textContent = label;
      return;
    }
    const diff = yourValue - benchmarkValue;
    const over = diff > 0;
    if (over) heroEl.classList.add("over-average");
    valueEl.textContent = `${over ? "▲" : "▼"} ${Math.round(Math.abs(diff)).toLocaleString()} kg`;
    labelEl.textContent = `vs ${label}`;
  }

  // Swipeable "Compared to:" carousel right under the yearly hero total -
  // one slide per benchmark, dots below (same pattern as the savings
  // totaliser above it). 1.5C target and UK average reuse figures already
  // computed for the cards below; World average is the single illustrative
  // constant above (WORLD_AVERAGE_YEARLY_KG); Uni average is the only one
  // needing a network round trip, so it renders as a neutral "loading"
  // slide first and fills in once university_weekly_average() resolves (or
  // explains why it can't yet).
  function renderYearCompareChips(yearlyTotal, ukAverageYearlyKg) {
    setCompareChip("compare-chip-15c", "compare-chip-15c-label", "compare-hero-15c", yearlyTotal, PARIS_1_5C_YEARLY_KG, "1.5°C target");
    setCompareChip("compare-chip-uk", "compare-chip-uk-label", "compare-hero-uk", yearlyTotal, ukAverageYearlyKg, "UK average");
    setCompareChip("compare-chip-world", "compare-chip-world-label", "compare-hero-world", yearlyTotal, WORLD_AVERAGE_YEARLY_KG, "World average");
    renderUniCompareChip(yearlyTotal);
  }

  const UNIVERSITY_MIN_PEOPLE = 3;

  async function renderUniCompareChip(yearlyTotal) {
    const valueEl = document.getElementById("compare-chip-uni");
    const labelEl = document.getElementById("compare-chip-uni-label");
    const heroEl = document.getElementById("compare-hero-uni");
    if (!valueEl || !labelEl || !heroEl) return;
    heroEl.classList.remove("over-average");
    heroEl.classList.add("no-data");
    if (!profile.university) {
      valueEl.textContent = "–";
      labelEl.textContent = "Set your university on Account to compare";
      return;
    }
    valueEl.textContent = "…";
    labelEl.textContent = `Loading ${profile.university} average…`;
    const { data, error } = await sbClient.rpc("university_weekly_average", { target_university: profile.university });
    const row = data && data[0];
    // Requires a handful of people from the same university before showing
    // a real number - comparing against an "average" built from only one
    // or two other people gets close to just showing their own data back
    // to them, which isn't the point of an anonymous aggregate.
    if (error || !row || (row.user_count || 0) < UNIVERSITY_MIN_PEOPLE) {
      valueEl.textContent = "–";
      labelEl.textContent = `Not enough people from ${profile.university} yet`;
      return;
    }
    setCompareChip("compare-chip-uni", "compare-chip-uni-label", "compare-hero-uni", yearlyTotal, row.avg_total_kg * 52, `${profile.university} average`);
  }

  // A lightweight nudge, not a data-completeness tracker: yesterday/today's
  // commute and meal are done once that day's actually confirmed (works
  // whether "yesterday" falls in this week's or last week's data). Electricity
  // and flights don't have an "unanswered" state to check the way the This
  // Year page's true optional fields do (num_dogs, bank_name, etc. are
  // nullable; these two default to a real 0) - so "done" here just means
  // non-zero, on the assumption that most people's genuine answer isn't
  // exactly zero. Someone with truly 0 flights this year will never see
  // this one tick off, which is an acceptable tradeoff for a to-do nudge.
  // Each item drops off the list entirely once it's done, rather than
  // sitting there checked off - once everything's done, the list itself
  // is replaced with a single "All done" message.
  function renderHomeTodoList() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStatus = dayConfirmStatus(today);
    const yesterdayStatus = dayConfirmStatus(yesterday);

    const items = [
      ["todo-yesterday-commute", yesterdayStatus.commuteDone],
      ["todo-yesterday-meal", yesterdayStatus.dietDone],
      ["todo-today-commute", todayStatus.commuteDone],
      ["todo-today-meal", todayStatus.dietDone],
      ["todo-electricity", !!profile.householdKwhPerMonth],
      ["todo-flights", !!(profile.shortHaulFlights || profile.longHaulFlights)],
    ];

    let allDone = true;
    items.forEach(([id, done]) => {
      const el = document.getElementById(id);
      if (el) el.hidden = !!done;
      if (!done) allDone = false;
    });

    const hint = document.getElementById("home-todo-hint");
    const list = document.getElementById("home-todo-list");
    const doneMessage = document.getElementById("home-todo-all-done");
    if (hint) hint.hidden = allDone;
    if (list) list.hidden = allDone;
    if (doneMessage) doneMessage.hidden = !allDone;
  }

  function renderYearComparison(yearlyTotal, ukAverageYearlyKg) {
    const yourCarKm = yearlyTotal / TRANSPORT_FACTORS.car;
    const ukCarKm = ukAverageYearlyKg / TRANSPORT_FACTORS.car;
    const yourTrees = yearlyTotal / TREE_KG_PER_YEAR;
    const ukTrees = ukAverageYearlyKg / TREE_KG_PER_YEAR;

    document.getElementById("compare-car-km").textContent = Math.round(yourCarKm).toLocaleString();
    document.getElementById("compare-trees").textContent = Math.round(yourTrees).toLocaleString();

    setComparisonDiff("compare-car-km-diff", yourCarKm, ukCarKm, "km");
    setComparisonDiff("compare-trees-diff", yourTrees, ukTrees, "trees");
  }

  // Two-line layout: a bold, colored delta on top and a small muted "vs
  // X" caption underneath, so every tile reads the same way at a glance
  // instead of one long inline sentence. The caption stays visible even
  // for a still-unanswered optional tile (with a muted "–" in place of a
  // real delta) so the grid doesn't have some tiles with a caption line
  // and others without one.
  function setComparisonDiff(elementId, yourValue, ukValue, unit, compareLabel = "UK average") {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = "";

    const valueSpan = document.createElement("span");
    valueSpan.className = "diff-value";
    const captionSpan = document.createElement("span");
    captionSpan.className = "diff-caption";
    captionSpan.textContent = `vs ${compareLabel}`;

    // Optional categories pass null on both sides when unanswered - nothing
    // to compare yet, so show a muted placeholder rather than "0 vs UK
    // average" (which would misleadingly look like a real answer of 0).
    if (yourValue === null || yourValue === undefined || ukValue === null || ukValue === undefined) {
      el.className = "week-diff";
      valueSpan.textContent = "–";
      el.appendChild(valueSpan);
      el.appendChild(captionSpan);
      return;
    }
    const diff = yourValue - ukValue;
    const over = diff > 0;
    el.className = `week-diff ${over ? "week-diff-over" : "week-diff-under"}`;
    valueSpan.textContent = `${over ? "▲" : "▼"} ${Math.round(Math.abs(diff)).toLocaleString()} ${unit}`;
    el.appendChild(valueSpan);
    el.appendChild(captionSpan);
  }

  function exportData() {
    const payload = { profile, weeks: weeksCache };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, "co2-tracker-data.json");
  }

  // Owner-only: fetches every opted-in user's research data (see
  // research_export_profiles()/research_export_weeks() in schema.sql).
  // Both RPCs return an empty array for anyone but the app owner - the
  // buttons that call this are also only shown to that account, but the
  // real enforcement is server-side either way. Returns null on error
  // (already alerted), otherwise { profiles, weeks }.
  async function fetchResearchData() {
    const [profilesRes, weeksRes] = await Promise.all([
      sbClient.rpc("research_export_profiles"),
      sbClient.rpc("research_export_weeks"),
    ]);
    if (profilesRes.error || weeksRes.error) {
      console.error("Failed to load research data", profilesRes.error, weeksRes.error);
      alert("Could not load research data — see console for details.");
      return null;
    }
    return { profiles: profilesRes.data || [], weeks: weeksRes.data || [] };
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function exportResearchData() {
    const data = await fetchResearchData();
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    downloadBlob(blob, "co2-tracker-research-data.json");
  }

  // Loads vendor/xlsx.js (SheetJS, ~250KB) on first use rather than on
  // every page load - it's only ever needed by the one account that can
  // see the button that calls this, so there's no reason to make every
  // visitor download it up front.
  let xlsxLibPromise = null;
  function loadXlsxLib() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxLibPromise) {
      xlsxLibPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "vendor/xlsx.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load vendor/xlsx.js"));
        document.head.appendChild(script);
      });
    }
    return xlsxLibPromise;
  }

  // jsonb columns (commute/diet/confirmed_commute/confirmed_diet/alcohol)
  // come back as parsed objects from the RPC - stringify them so each cell
  // in the Weeks sheet is readable text rather than "[object Object]".
  function flattenWeekRowForXlsx(row) {
    const flat = { ...row };
    ["commute", "diet", "confirmed_commute", "confirmed_diet", "alcohol"].forEach((key) => {
      if (flat[key] && typeof flat[key] === "object") flat[key] = JSON.stringify(flat[key]);
    });
    return flat;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  // Appends an "Average" and "Std Dev (sample)" row for every numeric
  // column, after a blank spacer row, so a sheet's summary stats sit right
  // under its data rather than needing a separate tab. Sample standard
  // deviation (n-1) since opted-in users are a sample, not the whole
  // population. Non-numeric columns (text, booleans, jsonb-as-string) are
  // left blank in both summary rows rather than guessed at.
  function withSummaryStats(rows) {
    if (rows.length === 0) return rows;
    const keys = Object.keys(rows[0]);
    const spacer = {};
    const avgRow = {};
    const sdRow = {};
    keys.forEach((k) => { spacer[k] = ""; avgRow[k] = ""; sdRow[k] = ""; });
    avgRow[keys[0]] = "Average";
    sdRow[keys[0]] = "Std Dev (sample)";
    keys.forEach((k) => {
      const values = rows.map((r) => r[k]).filter((v) => typeof v === "number" && Number.isFinite(v));
      if (values.length === 0) return;
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      avgRow[k] = round2(mean);
      if (values.length > 1) {
        const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
        sdRow[k] = round2(Math.sqrt(variance));
      }
    });
    return [...rows, spacer, avgRow, sdRow];
  }

  // Diet-day kg CO2e using the same baseline formula as foodFootprint(),
  // but WITHOUT a per-user food-waste or eating-out multiplier - neither
  // is available in this anonymized rollup (food_waste_bracket lives on
  // research_profiles, which has no shared key with research_weeks), so
  // this is the plain meal/portion figure on its own.
  function baselineMealKg(entry) {
    if (!entry || !entry.type) return null;
    if (entry.type === "vegan") return FOOD_DAY_FACTORS.vegan;
    if (entry.type === "veggie") return FOOD_DAY_FACTORS.veggie;
    if (entry.type === "meat") {
      const meatFactor = MEAT_FACTORS[entry.meat] ?? MEAT_FACTORS.other;
      const portionKg = PORTION_KG[entry.portion] ?? PORTION_KG.medium;
      return MEAT_SIDES_BASELINE + meatFactor * portionKg;
    }
    return null;
  }

  function mealTypeLabel(entry) {
    if (entry.type === "meat") return MEAT_LABELS[entry.meat] ?? MEAT_LABELS.other;
    if (entry.type === "veggie") return "Veggie";
    if (entry.type === "vegan") return "Vegan";
    return entry.type;
  }

  // Same rule as isFullyConfirmed() (Stats/Leaderboard "confirmed week"
  // averages), just against the snake_case row shape research_weeks
  // returns instead of the app's own camelCase weekData - every day, both
  // commute and diet, confirmed. A week where only a couple of days got
  // confirmed shouldn't count toward "how many of each per week" any more
  // than it counts toward any other average in this app.
  function isWeekRowFullyConfirmed(row) {
    const confirmedCommute = row.confirmed_commute || {};
    const confirmedDiet = row.confirmed_diet || {};
    return DAYS.every((day) => confirmedCommute[day.key] && confirmedDiet[day.key]);
  }

  // Collates every day of every FULLY confirmed opted-in week in the
  // export - "however many weeks back" there are - into "how many of
  // each per week, on average" plus the kg CO2e that represents. Partial
  // weeks are excluded entirely (see isWeekRowFullyConfirmed above), not
  // just their unconfirmed days, so a week logged for one day doesn't
  // pull the "per week" average down as if it were a full week. weekCount
  // is the number of fully confirmed weeks this is collated from, used as
  // the per-week denominator for both breakdowns.
  function summarizeMealsAndCommute(weeksRaw) {
    const fullWeeks = weeksRaw.filter(isWeekRowFullyConfirmed);
    const weekCount = fullWeeks.length;
    const meals = new Map(); // label -> { days, kg }
    const commutes = new Map(); // label -> { days, kg }

    fullWeeks.forEach((w) => {
      const diet = w.diet || {};
      const confirmedDiet = w.confirmed_diet || {};
      Object.keys(confirmedDiet).forEach((day) => {
        if (!confirmedDiet[day]) return;
        const entry = diet[day];
        const kg = baselineMealKg(entry);
        if (kg === null) return;
        const label = mealTypeLabel(entry);
        const bucket = meals.get(label) || { days: 0, kg: 0 };
        bucket.days += 1;
        bucket.kg += kg;
        meals.set(label, bucket);
      });

      const commute = w.commute || {};
      const confirmedCommute = w.confirmed_commute || {};
      const distanceKm = w.commute_distance_km;
      Object.keys(confirmedCommute).forEach((day) => {
        if (!confirmedCommute[day]) return;
        const mode = commute[day];
        if (!mode || mode === "none") return;
        const factor = TRANSPORT_FACTORS[mode];
        if (factor === undefined || typeof distanceKm !== "number") return;
        const kg = factor * distanceKm * 2;
        const label = TRANSPORT_LABELS[mode] ?? mode;
        const bucket = commutes.get(label) || { days: 0, kg: 0 };
        bucket.days += 1;
        bucket.kg += kg;
        commutes.set(label, bucket);
      });
    });

    function toRows(map, labelHeader) {
      return [...map.entries()]
        .map(([label, { days, kg }]) => ({
          [labelHeader]: label,
          "Confirmed days (all opted-in weeks)": days,
          "Avg per week": weekCount ? round2(days / weekCount) : 0,
          "Avg kg CO2e per week": weekCount ? round2(kg / weekCount) : 0,
        }))
        .sort((a, b) => b["Avg per week"] - a["Avg per week"]);
    }

    return {
      weekCount,
      mealRows: toRows(meals, "Meal type"),
      commuteRows: toRows(commutes, "Commute mode"),
    };
  }

  async function exportResearchDataXlsx() {
    const data = await fetchResearchData();
    if (!data) return;
    try {
      await loadXlsxLib();
    } catch (err) {
      console.error(err);
      alert("Could not load the Excel export library — see console for details.");
      return;
    }
    const wb = window.XLSX.utils.book_new();
    const profilesSheet = window.XLSX.utils.json_to_sheet(withSummaryStats(data.profiles));
    window.XLSX.utils.book_append_sheet(wb, profilesSheet, "Profiles");
    const weeksSheet = window.XLSX.utils.json_to_sheet(withSummaryStats(data.weeks.map(flattenWeekRowForXlsx)));
    window.XLSX.utils.book_append_sheet(wb, weeksSheet, "Weeks");

    const { weekCount, mealRows, commuteRows } = summarizeMealsAndCommute(data.weeks);
    const mealsSheet = window.XLSX.utils.json_to_sheet(
      mealRows.length ? mealRows : [{ "Meal type": `No fully confirmed weeks (${weekCount} found)` }]
    );
    window.XLSX.utils.book_append_sheet(wb, mealsSheet, "Meal Breakdown");
    const commuteSheet = window.XLSX.utils.json_to_sheet(
      commuteRows.length ? commuteRows : [{ "Commute mode": `No fully confirmed weeks (${weekCount} found)` }]
    );
    window.XLSX.utils.book_append_sheet(wb, commuteSheet, "Commute Breakdown");

    window.XLSX.writeFile(wb, "co2-tracker-research-data.xlsx");
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

  // Permanently deletes the signed-in account itself, not just its data -
  // see delete_own_account() in schema.sql, which only ever deletes the
  // CALLER's own auth.users row (cascades clean up profiles/weeks/
  // friendships automatically). Different from resetAllData() above,
  // which keeps the login working.
  async function deleteOwnAccount() {
    if (!confirm(
      "This PERMANENTLY deletes your account - your login, profile, every week " +
      "you've logged, and your friend connections. This cannot be undone and " +
      "there is no way to recover it afterward. Continue?"
    )) return;
    const { error } = await sbClient.rpc("delete_own_account");
    if (error) {
      console.error("Failed to delete account", error);
      alert("Could not delete your account — see console for details. Nothing was deleted.");
      return;
    }
    await sbClient.auth.signOut();
    window.location.reload();
  }

  // ---------- Auth ----------
  let authMode = "signin";

  // Needed ONLY for currentAppUrl() below, when running inside the native
  // app - see README.md's "iOS app (Capacitor)" section for the rest of
  // what's needed to make this domain actually serve the app and resolve
  // Universal Links (DNS, GitHub Pages custom domain verification, the
  // apple-app-site-association file, and the Associated Domains
  // capability in Xcode - none of that is done just by setting this).
  const PRODUCTION_URL = "https://co2counter.co.uk/";

  // Where Supabase should send the user back to after clicking a signup
  // confirmation or password-reset email link. On the web this is
  // computed from wherever the app actually is (not hardcoded), so it
  // works on GitHub Pages, a custom domain, or localhost alike - as long
  // as that URL is also added to the Supabase project's Authentication >
  // URL Configuration > Redirect URLs allowlist (Supabase ignores
  // redirects not on that list). Inside the native app, window.location
  // is Capacitor's internal capacitor://localhost, not a real address an
  // email link can point at - use PRODUCTION_URL there instead.
  function currentAppUrl() {
    const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    if (isNative && PRODUCTION_URL) return PRODUCTION_URL;
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

  // Handles a password-reset link opened via iOS Universal Links (see
  // ios/App/App/App.entitlements and the apple-app-site-association setup
  // documented in README.md - requires a real hosting domain, not yet
  // wired up). In the web app, Supabase's client notices the recovery
  // token in window.location automatically; inside the native app the
  // WKWebView never navigates to the https:// link at all (the OS hands
  // Capacitor the URL directly instead), so that automatic detection
  // never fires - this manually extracts the same token(s) from whatever
  // URL the OS handed us and establishes the session itself. Handles both
  // shapes Supabase can send (see urlIndicatesPasswordRecovery() above).
  // Setting expectingPasswordRecovery here (synchronously, before the
  // async session calls below resolve) is what makes routeSession() show
  // the reset-password screen instead of a normal sign-in once the
  // session comes through, exactly like the web flow.
  async function handleDeepLink(url) {
    if (!url || !/type=recovery/.test(url)) return;
    expectingPasswordRecovery = true;

    const hashIndex = url.indexOf("#");
    const queryIndex = url.indexOf("?");
    const hash = hashIndex >= 0 ? url.slice(hashIndex + 1) : "";
    const query = queryIndex >= 0 ? url.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined) : "";
    const hashParams = new URLSearchParams(hash);
    const queryParams = new URLSearchParams(query);

    if (queryParams.get("code")) {
      const { error } = await sbClient.auth.exchangeCodeForSession(queryParams.get("code"));
      if (error) console.error("Failed to exchange recovery code from deep link", error);
    } else if (hashParams.get("access_token")) {
      const { error } = await sbClient.auth.setSession({
        access_token: hashParams.get("access_token"),
        refresh_token: hashParams.get("refresh_token"),
      });
      if (error) console.error("Failed to set recovery session from deep link", error);
    }
  }

  // Registers the above only when actually running inside the native app
  // (window.Capacitor is undefined in a normal browser, including the
  // plain web version of this same app) - getLaunchUrl() covers the case
  // where the link cold-started the app, before any listener could have
  // been registered yet; addListener covers the app already being open.
  function registerDeepLinkHandling() {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;
    const CapApp = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!CapApp) return;
    CapApp.addListener("appUrlOpen", ({ url }) => handleDeepLink(url));
    CapApp.getLaunchUrl().then((result) => { if (result && result.url) handleDeepLink(result.url); });
  }

  function updateAuthModeUI() {
    document.getElementById("auth-submit").textContent = authMode === "signin" ? "Sign in" : "Create account";
    document.getElementById("auth-toggle-mode").textContent =
      authMode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in";
    document.getElementById("auth-error").hidden = true;
    document.getElementById("auth-status").hidden = true;
  }

  // Supabase auth errors normally have a real, readable .message - but some
  // failure modes (a malformed/unexpected response from the Auth API, a
  // network-level failure the client couldn't fully parse) leave message as
  // something unhelpful like the literal text "{}". Fall back to whatever
  // other fields the error carries (status/code - Supabase's AuthError
  // includes these even when message is useless) so there's still something
  // actionable on screen, and always log the raw error for anyone who can
  // check the browser console.
  function describeAuthError(error) {
    console.error("Auth error:", error);
    const parts = [];
    if (error.message && error.message !== "{}") parts.push(error.message);
    if (error.status) parts.push(`(status ${error.status})`);
    if (error.code) parts.push(`[${error.code}]`);
    if (parts.length === 0) {
      parts.push("Something went wrong talking to the server. Check your internet connection and try again - if it keeps happening, open the browser console (or ask whoever manages this site) for the real error.");
    }
    return parts.join(" ");
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
          errorEl.textContent = describeAuthError(error);
          errorEl.hidden = false;
        }
      } else {
        const { data, error } = await sbClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: currentAppUrl() },
        });
        if (error) {
          errorEl.textContent = describeAuthError(error);
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
      errorEl.textContent = describeAuthError(error);
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
        errorEl.textContent = describeAuthError(error);
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

    document.getElementById("tile-info-close").addEventListener("click", closeTileInfo);
    document.getElementById("tile-info-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "tile-info-backdrop") closeTileInfo();
    });
    document.querySelectorAll(".tile-info-btn").forEach((btn) => {
      btn.addEventListener("click", () => openTileInfo(btn.dataset.info));
    });

    wireCarousel("home-savings-carousel", "home-savings-dots");
    wireCarousel("home-year-groups-carousel", "home-year-groups-dots");
    wireCarousel("home-compare-carousel", "home-compare-dots");

    document.querySelectorAll(".journey-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedJourneyMode = btn.dataset.mode;
        document.querySelectorAll(".journey-mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
      });
    });
    document.getElementById("journey-add-btn").addEventListener("click", addJourney);
    document.getElementById("journey-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".journey-remove-btn");
      if (btn) removeJourney(parseInt(btn.dataset.index, 10));
    });
    document.getElementById("journey-congrats-close").addEventListener("click", () => {
      document.getElementById("journey-congrats-backdrop").classList.remove("open");
    });
    document.getElementById("journey-congrats-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "journey-congrats-backdrop") {
        document.getElementById("journey-congrats-backdrop").classList.remove("open");
      }
    });

    document.getElementById("reset-week").addEventListener("click", resetWeek);

    document.querySelectorAll("#week-picker .week-picker-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedWeekKey = btn.dataset.week === "current" ? CURRENT_WEEK_KEY : LAST_WEEK_KEY;
        renderWeekPage();
      });
    });

    document.querySelectorAll(".home-period-btn").forEach((btn) => {
      btn.addEventListener("click", () => renderPeriodChart(btn.dataset.period));
    });

    document.querySelectorAll(".todo-item").forEach((item) => {
      const navigate = () => { location.hash = item.dataset.nav; };
      item.addEventListener("click", navigate);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(); }
      });
    });

    const uniHero = document.getElementById("compare-hero-uni");
    if (uniHero) {
      const navigateToAccount = () => { location.hash = uniHero.dataset.nav; };
      uniHero.addEventListener("click", navigateToAccount);
      uniHero.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigateToAccount(); }
      });
    }

    document.getElementById("alcohol-spirits-abv").addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      const weekData = getWeek(selectedWeekKey);
      setAlcoholField(weekData, (alc) => { alc.spiritsAbv = Number.isFinite(val) && val >= 0 ? val : 0; });
    });
    document.getElementById("alcohol-spirits-shots").addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      const weekData = getWeek(selectedWeekKey);
      setAlcoholField(weekData, (alc) => { alc.spiritsShots = Number.isFinite(val) && val >= 0 ? val : 0; });
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
    function setGoalPreset(kg) {
      profile.weeklyGoalKg = Math.round(kg * 10) / 10;
      document.getElementById("profile-goal").value = profile.weeklyGoalKg;
      persistProfile();
    }
    document.getElementById("goal-preset-uk").addEventListener("click", () => setGoalPreset(UK_AVERAGE_WEEKLY_KG));
    document.getElementById("goal-preset-15c-fc").addEventListener("click", () => setGoalPreset(PARIS_1_5C_FOOD_COMMUTE_WEEKLY_KG));
    document.getElementById("goal-preset-world").addEventListener("click", () => setGoalPreset(WORLD_AVERAGE_WEEKLY_KG));
    document.getElementById("profile-food-waste").addEventListener("change", (e) => {
      profile.foodWaste = e.target.value;
      persistProfile();
      renderFootprints();
    });
    document.getElementById("profile-university").addEventListener("change", (e) => {
      profile.university = e.target.value === "None" ? null : e.target.value;
      persistProfile();
      renderStatsPage();
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
    bindOptionalNumberField("num-dogs", (v) => { profile.numDogs = v; });
    bindOptionalNumberField("num-cats", (v) => { profile.numCats = v; });
    bindOptionalNumberField("annual-water-m3", (v) => { profile.annualWaterM3 = v; });
    bindOptionalNumberField("bank-balance", (v) => { profile.bankBalance = v; });

    document.getElementById("bank-name").addEventListener("change", (e) => {
      profile.bankName = e.target.value || null;
      persistProfile();
      renderStatsPage();
    });

    document.getElementById("owns-car").addEventListener("change", (e) => {
      profile.ownsCar = e.target.value === "yes" ? true : e.target.value === "no" ? false : null;
      persistProfile();
      renderStatsPage();
    });

    document.getElementById("car-fuel-type").addEventListener("change", (e) => {
      profile.carFuelType = e.target.value || null;
      persistProfile();
      renderFootprints();
      renderStatsPage();
    });

    document.getElementById("research-opt-in").addEventListener("change", (e) => {
      profile.researchOptIn = e.target.checked;
      persistProfile();
    });

    document.getElementById("baseline-week").addEventListener("change", (e) => {
      profile.baselineWeekKey = e.target.value || null;
      persistProfile();
      renderFootprints();
    });

    document.getElementById("add-friend-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("friend-email");
      addFriendByEmail(input.value);
      input.value = "";
    });

    document.getElementById("export-data").addEventListener("click", exportData);
    document.getElementById("export-research-data").addEventListener("click", exportResearchData);
    document.getElementById("export-research-data-xlsx").addEventListener("click", exportResearchDataXlsx);
    document.getElementById("import-data").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importData(file);
      e.target.value = "";
    });
    document.getElementById("reset-all-data").addEventListener("click", resetAllData);
    document.getElementById("delete-account-btn").addEventListener("click", deleteOwnAccount);

    updateAuthModeUI();

    registerDeepLinkHandling();
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
