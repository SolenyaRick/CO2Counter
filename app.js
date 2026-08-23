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

  // The includeOptional shape computeUkAverageBreakdown() expects, derived
  // from a profile's own answers - "answered" (not null/undefined) rather
  // than "truthy", so a deliberate 0 (e.g. 0 dogs and 0 cats) still counts
  // as answered rather than falling back to "not compared". Shared by the
  // Stats page's per-category UK-average rings and the "Match UK average"
  // goal preset button, so both compare against exactly the same ground
  // the person themselves has opted into.
  function includeOptionalForProfile(p) {
    return {
      gasHeating: p.annualGasKwh !== null && p.annualGasKwh !== undefined,
      carOwnership: p.ownsCar !== null && p.ownsCar !== undefined,
      pets: (p.numDogs !== null && p.numDogs !== undefined) || (p.numCats !== null && p.numCats !== undefined),
      water: p.annualWaterM3 !== null && p.annualWaterM3 !== undefined,
      banks: !!p.bankName && p.bankBalance !== null && p.bankBalance !== undefined,
    };
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
  // chip and (divided by 52) the "Match world average" goal preset.
  // Deliberately NOT built bottom-up the rigorous way the UK average
  // above is (there's no single global travel/diet survey to build it
  // from) - this is a single illustrative reference number, same spirit
  // as the "8-10 tonnes CO2e/yr" UK figure cited in the app's copy
  // without a bottom-up model behind it either.
  const WORLD_AVERAGE_YEARLY_KG = 4700;

  // Full-lifestyle UK-average weekly-equivalent: every category the Budget
  // pace chart can plot that isn't behind an optional yes/no question
  // (commute, food, non-commute driving, flights, home energy, buying
  // goods - see computeUkAverageBreakdown()'s own includeOptional param
  // for the rest). Used for the default goal a brand-new profile starts
  // with (nothing optional answered yet, so `{}` is the right comparison)
  // and as the base for the "Match UK average" preset button, which
  // widens this further to also include whichever optional extras the
  // clicking profile has personally answered (see includeOptionalForProfile()).
  // Distinct from UK_AVERAGE_WEEKLY_KG above, which stays commute+food-only
  // on purpose for the This Week page's own average-week comparison.
  const UK_AVERAGE_FULL_WEEKLY_KG = computeUkAverageBreakdown({}).total / 52;

  const DEFAULT_PROFILE = {
    name: "",
    commuteDistanceKm: 8,
    // Matches the "Match UK average" preset's own starting point (see
    // UK_AVERAGE_FULL_WEEKLY_KG) - a brand-new, unmodified profile starts
    // out neither ahead of nor behind the UK average across every domain
    // the Budget pace chart plots, rather than a flat number that can go
    // stale relative to the underlying emission factors. (This used to be
    // a hardcoded 20, which looked fine when FOOD_DAY_FACTORS.veggie was
    // 1.5, but after that moved to 2.6 - see the Rosi et al. update - an
    // all-veggie week's food alone came to ~93% of that old default before
    // any commute was even added, making a fully plant-based diet look
    // like it was barely beating a stale goal instead of clearly beating a
    // live one. Existing accounts keep whatever weekly_goal_kg is already
    // saved for them - only brand-new profiles pick this up.)
    weeklyGoalKg: Math.round(UK_AVERAGE_FULL_WEEKLY_KG * 10) / 10,
    foodWaste: "low",
    // Itemized flight log - see computeFlyingYearlyKg(). flyingYearlyKg is
    // a derived cache of the total, written alongside so the SQL-side
    // app_wide_weekly_average()/university_weekly_average() functions
    // don't need to re-implement the continent/class lookup themselves.
    flights: [],
    flyingYearlyKg: 0,
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
    // Electricity bill (This Year page) - household_kwh_per_month above is
    // derived from these three via computeElectricityMonthlyKwh() rather
    // than typed in directly. null means no bill submitted yet.
    electricityBillFrom: null,
    electricityBillTo: null,
    electricityBillKwh: null,
    // Off by default - nothing is shared until the user actively opts in.
    // See research_profiles / research_weeks in schema.sql for exactly
    // what this exposes (everything on this page except banking) and to
    // whom (the app owner only, via the Supabase SQL Editor - never
    // readable through the app itself).
    researchOptIn: false,
    // Optional: a typical week from before you started tracking, to
    // compare This Week's card against instead of the UK average - null
    // means "use the UK average" (the default for everyone until they set
    // one on the Account page's Baseline week screen). Same shape as a
    // real tracked week (see blankWeek()): {commute, diet,
    // confirmedCommute, confirmedDiet, alcohol, extraJourneys}, built
    // either by hand-editing the real day-by-day commute/diet tables
    // (see the Baseline week screen's "Custom week" tab) or by copying
    // one of your own past tracked weeks as a starting point ("Copy a
    // week" tab) - confirmedCommute/confirmedDiet are always all-true
    // here, since a hypothetical typical week has no "hasn't happened
    // yet" day to withhold, unlike a real one.
    baselineWeek: null,
    // Optional: "diesel" | "hybrid" | "electric" - null means use the
    // blended-average car factor (TRANSPORT_FACTORS.car) everywhere.
    carFuelType: null,
    // Optional: e.g. "UCL"/"Imperial"/"KCL" - null means "prefer not to say"
    // (the select's "None" option). Used for the Home page's uni-average
    // comparison chip once enough people from the same university opt in.
    university: null,
    // Optional: one of COUNTRY_LIST - null means "prefer not to say", same
    // pattern as university above. Used for the Leaderboard's "All
    // Members" country filter and (once answered) a country-average
    // comparison chip.
    country: null,
    // Off by default, same "nothing shared until actively turned on"
    // stance as researchOptIn - turning this on makes displayName and this
    // week's total visible to any signed-in user via the Leaderboard's
    // "All Members" view (public_leaderboard() in supabase/schema.sql),
    // filterable by university/country. Friends-only visibility (the
    // default Leaderboard view) is unaffected either way.
    leaderboardOptIn: false,
    // Leaderboard page "Habits" card - { habitId: { startDate, targetDays } },
    // one entry per habit with an active challenge (see startHabitChallenge()/
    // cancelHabitChallenge()). Streak counts themselves are never stored
    // here, only recomputed from the diet/flights data they're derived from.
    habitChallenges: {},
    // null | "eating" | "commuting" | "flying" | "banking" - which habit
    // the person opted to focus on via the Habits card's survey. Null
    // shows the "Would you like to change your habits?" prompt instead of
    // any tile, so the feature stays fully opt-in rather than always
    // pushing two streak tiles at everyone regardless of interest.
    chosenHabit: null,
    // Optional profile photo (Account page) - a small square JPEG data URL,
    // resized/compressed client-side on upload (see
    // handleAvatarFileSelected()) so it stays well within the schema's
    // length cap. null shows the initial-letter placeholder instead of an
    // <img>. Deliberately not Supabase Storage: this app has no other use
    // for a storage bucket, so one more text column on the row already
    // synced by persistProfile() is simpler than standing up a second
    // upload path with its own bucket/policies.
    avatarDataUrl: null,
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
  let friendExtrasById = {}; // otherId -> { flyingYearlyKg, householdKwhPerMonth, householdPeople }
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

  // Confirmed days count toward totals/chart/leaderboard; picked-but-unconfirmed
  // days are saved as drafts (so nothing is lost) but contribute 0 until confirmed.
  function countedCommuteFootprint(weekData, dayKey) {
    return weekData.confirmedCommute?.[dayKey] ? commuteFootprint(weekData, dayKey) : 0;
  }

  function countedFoodFootprint(weekData, dayKey) {
    return weekData.confirmedDiet?.[dayKey] ? foodFootprint(weekData, dayKey) : 0;
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
        flights: data.flights ?? [],
        flyingYearlyKg: data.flying_yearly_kg ?? 0,
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
        electricityBillFrom: data.electricity_bill_from ?? null,
        electricityBillTo: data.electricity_bill_to ?? null,
        electricityBillKwh: data.electricity_bill_kwh ?? null,
        researchOptIn: data.research_opt_in ?? false,
        baselineWeek: data.baseline_week ?? null,
        carFuelType: data.car_fuel_type ?? null,
        university: data.university ?? null,
        country: data.country ?? null,
        leaderboardOptIn: data.leaderboard_opt_in ?? false,
        habitChallenges: data.habit_challenges ?? {},
        chosenHabit: data.chosen_habit ?? null,
        avatarDataUrl: data.avatar_data_url ?? null,
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
      flights: profile.flights,
      flying_yearly_kg: profile.flyingYearlyKg,
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
      electricity_bill_from: profile.electricityBillFrom,
      electricity_bill_to: profile.electricityBillTo,
      electricity_bill_kwh: profile.electricityBillKwh,
      research_opt_in: profile.researchOptIn,
      baseline_week: profile.baselineWeek,
      car_fuel_type: profile.carFuelType,
      university: profile.university,
      country: profile.country,
      leaderboard_opt_in: profile.leaderboardOptIn,
      habit_challenges: profile.habitChallenges,
      chosen_habit: profile.chosenHabit,
      avatar_data_url: profile.avatarDataUrl,
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
          "id, display_name, flying_yearly_kg, " +
          "household_kwh_per_month, household_people, clothes_per_month, " +
          "annual_gas_kwh, owns_car, car_fuel_type, num_dogs, num_cats, annual_water_m3, " +
          "bank_name, bank_balance"
        )
        .in("id", otherIds);
      (profs || []).forEach((p) => {
        namesById[p.id] = p.display_name || "(no name set)";
        friendExtrasById[p.id] = {
          flyingYearlyKg: p.flying_yearly_kg ?? 0,
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
    if (tab === "weeks") {
      renderYearlyInputs();
      if (pendingYearDetail) {
        const id = pendingYearDetail;
        pendingYearDetail = null;
        showYearDetail(id);
      } else {
        showYearList();
      }
    }
    // renderLeagues() is temporarily unwired (Leagues card pulled from the
    // Leaderboard page for now) - the function/RPC call itself is untouched
    // so this is a one-line change to bring back.
    if (tab === "leaderboard") { renderLeaderboard(); renderWeeklyAverageLeaderboard(); renderAppWideAverage(); renderHabitsCard(); }
    if (tab === "stats") renderStatsPage();
    if (tab === "account") renderAccountPage();
    if (tab === "week") renderWeekPage();
  }

  // ---------- Page 1: This Week ----------
  // The default onChange for both tables below - This Week's own
  // persist-and-refresh. Callers editing a *different* week's data (the
  // Baseline week screen) pass their own opts.onChange instead.
  function defaultWeekTableOnChange() {
    persistWeek(selectedWeekKey);
    renderFootprints();
  }

  function createConfirmButton(weekData, kind, dayKey, onChange) {
    onChange = onChange || defaultWeekTableOnChange;
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
      onChange();
    });
    return btn;
  }

  // Builds the day-by-day commute table - This Week's own, by default
  // (called with no args, exactly as before), or any other week-shaped
  // data via opts (used by the Baseline week screen's "Custom week" tab
  // to reuse this exact same form instead of a separate abbreviated one).
  function buildCommuteTable(weekData, opts) {
    weekData = weekData || getWeek(selectedWeekKey);
    opts = opts || {};
    const showConfirm = opts.showConfirm !== false;
    const showFootprint = opts.showFootprint !== false;
    const onChange = opts.onChange || defaultWeekTableOnChange;
    const tbody = document.querySelector(opts.tbodySelector || "#commute-table tbody");
    tbody.innerHTML = "";
    const todayKey = "todayKey" in opts ? opts.todayKey : (selectedWeekKey === CURRENT_WEEK_KEY ? todayDayKey() : null);
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
      const confirmBtn = showConfirm ? createConfirmButton(weekData, "commute", day.key, onChange) : null;
      select.addEventListener("change", () => {
        weekData.commute[day.key] = select.value;
        if (showConfirm) {
          weekData.confirmedCommute[day.key] = false;
          confirmBtn.classList.remove("confirmed", "pop");
        }
        onChange();
      });
      modeTd.appendChild(select);
      tr.appendChild(modeTd);

      if (showFootprint) {
        const footTd = document.createElement("td");
        footTd.className = "row-footprint";
        footTd.dataset.commuteFootprint = day.key;
        tr.appendChild(footTd);
      }

      if (showConfirm) {
        const confirmTd = document.createElement("td");
        confirmTd.className = "day-confirm-cell";
        confirmTd.appendChild(confirmBtn);
        tr.appendChild(confirmTd);
      }

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

  function setDietEntry(weekData, dayKey, entry, confirmBtn, opts) {
    opts = opts || {};
    const showConfirm = opts.showConfirm !== false;
    const onChange = opts.onChange || defaultWeekTableOnChange;
    const rebuild = opts.rebuild || (() => buildDietTable(weekData, opts));
    weekData.diet[dayKey] = entry;
    if (showConfirm) {
      weekData.confirmedDiet[dayKey] = false;
      confirmBtn.classList.remove("confirmed", "pop");
    }
    onChange();
    rebuild();
  }

  // Builds the day-by-day diet table - same "This Week's own by default,
  // any other week-shaped data via opts" reuse as buildCommuteTable()
  // above.
  function buildDietTable(weekData, opts) {
    weekData = weekData || getWeek(selectedWeekKey);
    opts = opts || {};
    const showConfirm = opts.showConfirm !== false;
    const showFootprint = opts.showFootprint !== false;
    const onChange = opts.onChange || defaultWeekTableOnChange;
    const rebuild = () => buildDietTable(weekData, opts);
    const container = document.querySelector(opts.containerSelector || "#diet-table");
    container.innerHTML = "";
    const todayKey = "todayKey" in opts ? opts.todayKey : (selectedWeekKey === CURRENT_WEEK_KEY ? todayDayKey() : null);
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

      const confirmBtn = showConfirm ? createConfirmButton(weekData, "diet", day.key, onChange) : null;
      const entryOpts = { showConfirm, onChange, rebuild };

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
            setDietEntry(weekData, day.key, { type: "meat", meat, portion: entry?.meat === meat ? entry.portion : "medium", eatOut }, confirmBtn, entryOpts);
          } else {
            setDietEntry(weekData, day.key, { type, eatOut }, confirmBtn, entryOpts);
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
            setDietEntry(weekData, day.key, { ...entry, portion }, confirmBtn, entryOpts);
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
            setDietEntry(weekData, day.key, { ...entry, eatOut: value }, confirmBtn, entryOpts);
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

      if (showFootprint) {
        const footprint = document.createElement("span");
        footprint.className = "row-footprint";
        footprint.dataset.foodFootprint = day.key;
        head.appendChild(footprint);
      }
      if (showConfirm) head.appendChild(confirmBtn);

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
    renderAverageWeekCard(selectedWeekKey, totals);
  }

  // profile.baselineWeek is already in exactly the shape weekTotals() and
  // the real week-editing widgets expect (see DEFAULT_PROFILE's comment
  // and the Baseline week screen's setup below) - no synthesis needed, so
  // this comparison runs through the exact same weekTotals() math as a
  // real tracked week rather than a second, possibly-drifting formula.
  // Null if nothing's been set yet (falls back to the UK average).
  function getBaselineWeekData() {
    return profile.baselineWeek;
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

  // "Budget pace" chart: a dashed target line and a stacked area both rise,
  // in the underlying data, from 0 to the goal across the tracked span -
  // but the chart draws top-to-bottom inverted (see yAt() below), so on
  // screen they slope the same top-left-to-bottom-right way the old
  // single-line "remaining budget" version used to, rather than bottom-
  // left-to-top-right. The stacked area is split into one colored band per
  // domain (commute/food/alcohol, in that order top-to-bottom on screen)
  // using the exact same colors as "This week's emissions by domain"
  // (--commute-color/--accent/--alcohol-color) so the two cards read as
  // one consistent picture. Dropping below the dashed line (i.e. further
  // down the screen) means CO2e is being used faster than the goal allows
  // for how far through the span it is; staying above it means on pace or
  // ahead. The stacked area only draws up to the current point - it
  // doesn't project forward. Shared by the This Week page's weekly chart
  // and the Stats page's yearly one below, parameterized on
  // `goal`/`predicted`/`series`/`xLabels` so both stay pixel-for-pixel
  // consistent and any future tweak to one applies to both automatically.
  // actualStartJ lets the stacked area begin partway along the x-axis
  // instead of always at j=0 - used by the yearly chart so the stretch
  // before tracking began is left blank (no bands) rather than plotted as
  // a fabricated "0 emissions" run that would misleadingly look on-track.
  // `series` is an array of `{ key, values }`, each `values` the STACKED
  // (cumulative-inclusive) top edge for that band, aligned to
  // `actualStartJ` (same length, same indexing) - bands stack in array
  // order, band i's bottom edge is band i-1's top edge, or `stackBaseline`
  // (a flat line, defaulting to 0) for the first band.
  function renderBudgetChart(containerId, { goal, predicted, series, xLabels, actualStartJ = 0, stackBaseline = 0, goalLabelSuffix = "kg goal", ariaPrefix = "Budget pace", minSvgHeight = 0 }) {
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
    // absurdly tall either; minSvgHeight (see renderPeriodChart()'s
    // second pass) can push it past that clamp so the whole slide grows to
    // match the carousel's other slide instead of leaving blank space.
    const W = chart.getBoundingClientRect().width || 340;
    const H = Math.max(140, Math.min(230, W / 2.3), minSvgHeight);
    const PAD_TOP = 14, PAD_BOTTOM = 26, PAD_X = 6;
    const plotW = W - PAD_X * 2;
    const plotH = H - PAD_TOP - PAD_BOTTOM;

    const topSeries = series[series.length - 1].values;
    const finalTotal = topSeries[topSeries.length - 1];
    const lastJ = actualStartJ + topSeries.length - 1;

    const yMax = Math.max(goal, finalTotal, 0.0001);
    const yMin = 0;
    const yRange = Math.max(0.0001, yMax - yMin);

    const xAt = (j) => PAD_X + (j / totalUnits) * plotW;
    // Inverted from the "usual" chart convention (higher value = higher on
    // screen) on purpose: 0 used sits near the top, the goal sits near the
    // bottom, so the chart still reads top-left-to-bottom-right the same
    // way the old declining "remaining budget" version did, even though
    // what's actually being plotted now is rising cumulative consumption.
    const yAt = (v) => PAD_TOP + ((v - yMin) / yRange) * plotH;
    const pathFor = (values, startJ = 0) => values.map((v, k) => `${k === 0 ? "M" : "L"}${xAt(startJ + k).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

    const predictedPath = pathFor(predicted);
    const onTrack = finalTotal <= predicted[lastJ];

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    svg.setAttribute("class", `budget-chart-svg ${onTrack ? "on-track" : "over-track"}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${ariaPrefix}: ${onTrack ? "on track" : "over pace"}, ${fmt(Math.abs(predicted[lastJ] - finalTotal))} kg CO2e ${finalTotal <= predicted[lastJ] ? "remaining" : "over"}`);

    if (actualStartJ > 0) {
      const startLine = document.createElementNS(svgNS, "line");
      startLine.setAttribute("x1", xAt(actualStartJ)); startLine.setAttribute("x2", xAt(actualStartJ));
      startLine.setAttribute("y1", PAD_TOP); startLine.setAttribute("y2", H - PAD_BOTTOM);
      startLine.setAttribute("class", "budget-zero-line");
      svg.appendChild(startLine);
    }

    // Stacked bands, in array order - each one's fill boundary runs along
    // its own cumulative values left-to-right, then back along the
    // previous band's values (or `stackBaseline`, for the first band)
    // right-to-left. With yAt() inverted (see above), array order reads
    // top-to-bottom on screen: the first band sits just under the 0 line,
    // each later one further down toward the goal.
    let bottomValues = new Array(topSeries.length).fill(stackBaseline);
    series.forEach(({ key, values }) => {
      const topPath = pathFor(values, actualStartJ);
      const bottomPath = bottomValues.slice().reverse()
        .map((v, k) => `L${xAt(actualStartJ + (bottomValues.length - 1 - k)).toFixed(1)},${yAt(v).toFixed(1)}`)
        .join(" ");
      const band = document.createElementNS(svgNS, "path");
      band.setAttribute("d", `${topPath} ${bottomPath} Z`);
      band.setAttribute("class", `budget-band budget-band-${key}`);
      svg.appendChild(band);
      bottomValues = values;
    });

    const predictedLine = document.createElementNS(svgNS, "path");
    predictedLine.setAttribute("d", predictedPath);
    predictedLine.setAttribute("class", "budget-predicted-line");
    svg.appendChild(predictedLine);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", xAt(lastJ));
    dot.setAttribute("cy", yAt(finalTotal));
    dot.setAttribute("r", 3.2);
    dot.setAttribute("class", "budget-actual-dot");
    svg.appendChild(dot);

    const goalLabel = document.createElementNS(svgNS, "text");
    goalLabel.textContent = `${fmt(goal)} ${goalLabelSuffix}`;
    goalLabel.setAttribute("x", xAt(0));
    goalLabel.setAttribute("y", Math.min(H - PAD_BOTTOM - 3, Math.max(9, yAt(goal) - 5)));
    goalLabel.setAttribute("class", "budget-axis-label");
    svg.appendChild(goalLabel);

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

    const remainingNow = predicted[lastJ] - finalTotal;
    // Domain key, built generically from `series` rather than hardcoded -
    // reuses the exact same .domain-<key> background colors as "This
    // week's emissions by domain", just as small square swatches instead
    // of that card's full-width bar segments, so the two always match
    // automatically if the set of tracked domains ever changes.
    const keyItems = series.map(({ key }) => `<span class="legend-item"><span class="legend-swatch legend-swatch-domain domain-${key}"></span>${DOMAIN_LABELS[key] ?? key}</span>`).join("");
    const legend = document.createElement("div");
    legend.className = "budget-chart-legend";
    legend.innerHTML = `
      <span class="legend-item"><span class="legend-swatch legend-swatch-target"></span>Target pace</span>
      <span class="legend-item"><span class="legend-swatch legend-swatch-actual ${onTrack ? "on-track" : "over-track"}"></span>${onTrack ? "On pace" : "Over pace"} &middot; ${fmt(Math.abs(remainingNow))} kg ${remainingNow >= 0 ? "left" : "over goal"}</span>
      ${keyItems}
    `;
    chart.appendChild(legend);
    return H;
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

  // Same [start, today] range and per-day granularity as computeRangeDailyKg()
  // above, but kept split into commute/food/alcohol day-by-day instead of
  // summed into one daily total - feeds the Budget pace chart's stacked
  // domain bands (see renderPeriodChart()/renderBudgetChart()), so each
  // band's day-to-day shape is exactly the same underlying data as the
  // single combined line used to be, just not pre-summed.
  function computeRangeDailyKgByDomain(start, today) {
    const todayOffset = Math.round((today - start) / DAY_MS);
    const len = Math.max(0, todayOffset) + 1;
    const commute = new Array(len).fill(0);
    const food = new Array(len).fill(0);
    const alcohol = new Array(len).fill(0);
    Object.keys(weeksCache).forEach((weekKey) => {
      const weekData = weeksCache[weekKey];
      const monday = new Date(`${weekKey}T00:00:00`);
      const alcoholKg = alcoholFootprint(weekData);
      DAYS.forEach((day, i) => {
        const dayDate = new Date(monday);
        dayDate.setDate(dayDate.getDate() + i);
        if (dayDate < start || dayDate > today) return;
        const offset = Math.round((dayDate - start) / DAY_MS);
        if (offset < 0 || offset >= len) return;
        commute[offset] += countedCommuteFootprint(weekData, day.key) + extraJourneysFootprintForDay(weekData, day.key);
        food[offset] += countedFoodFootprint(weekData, day.key);
        alcohol[offset] += alcoholKg / 7;
      });
    });
    return { commute, food, alcohol, todayOffset };
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
        syncCarouselHeight(carouselId);
        ticking = false;
      });
    });
  }

  // A slide's own scrollHeight/offsetHeight can't be trusted for measuring
  // its true content height: .carousel-slide is a flex item under
  // .carousel's default align-items:stretch, so its box (and therefore
  // scrollHeight, which is defined as never less than the element's own
  // box height) reads back whatever height the row currently happens to
  // be stretched to, not what the slide's own content actually needs. A
  // plain, non-flex-item CHILD's height is governed purely by its own
  // content regardless of how tall its parent slide got stretched, so
  // measuring top-to-bottom across the slide's children gives its true,
  // un-stretched content height instead.
  function measureSlideContentHeight(slideEl) {
    const children = Array.from(slideEl?.children || []);
    if (!children.length) return 0;
    const rects = children.map((c) => c.getBoundingClientRect());
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return bottom - top;
  }

  // A native scroll-snap carousel lays every slide out in one flex row, so
  // by default the row (and every slide in it, via flex's stretch-to-tallest
  // behavior) sizes itself to whichever slide has the most content - e.g.
  // the budget-pace line chart slide ending up with a tall blank gap under
  // it just because the domain treemap slide next to it happens to be
  // taller. This instead sets the carousel's own height to match only the
  // *currently visible* slide's actual content height (`.carousel-slide`'s
  // own `overflow: hidden` in style.css lets a taller sibling's excess get
  // clipped rather than forcing the row - and thus every slide - taller).
  // Called on every swipe (from wireCarousel's scroll handler above) and
  // whenever a carousel's slide content is re-rendered, since either can
  // change which slide is tallest. (The budget carousel additionally
  // equalizes its two slides' *content* heights up front - see
  // renderPeriodChart() - so in practice this rarely has anything to
  // reconcile there; it still matters for every other carousel, and as a
  // fallback if that equalizing ever falls short.)
  function syncCarouselHeight(carouselId) {
    const carousel = document.getElementById(carouselId);
    if (!carousel) return;
    const slides = carousel.querySelectorAll(".carousel-slide");
    if (!slides.length) return;
    const index = Math.min(slides.length - 1, Math.round(carousel.scrollLeft / Math.max(1, carousel.clientWidth)));
    const height = measureSlideContentHeight(slides[index]);
    if (height > 0) carousel.style.height = `${Math.ceil(height)}px`;
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

  // Same SVG line icon as each category's tile badge on "Your year,
  // estimated" (see index.html's .tile-icon svgs) - shown in the legend
  // row so a category is always identifiable by more than just its swatch
  // color, since the categorical palette can't guarantee every pair of the
  // 12 domains is distinguishable once "Rank by size" can put any two next
  // to each other (see the palette comment in style.css). Stored as raw
  // <path>/<circle>/... markup (not a full <svg>) so it can be dropped
  // straight into an svg element's innerHTML per legend row.
  const DOMAIN_ICON_SVG = {
    food: '<path d="M7 2v6a2 2 0 0 0 4 0V2"/><path d="M9 2v20"/><path d="M17 2c-1.7 0-3 2.2-3 5s1.3 5 3 5v10"/>',
    commute: '<path d="M5 11l1.5-4h11L19 11"/><rect x="3" y="11" width="18" height="6" rx="2"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
    nonCommuteCar: '<path d="M4 11l1-4h4l2-3h4l2 3h2l2 4"/><rect x="2" y="11" width="20" height="6" rx="2"/><circle cx="7" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/>',
    alcohol: '<path d="M8 2h8l-1 7a3 3 0 0 1-6 0z"/><path d="M12 12v7"/><path d="M9 22h6"/>',
    homeEnergy: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
    gasHeating: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7.5 7.5 0 1 1-15 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    water: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
    pets: '<circle cx="6" cy="9" r="2"/><circle cx="10" cy="5" r="2"/><circle cx="14" cy="5" r="2"/><circle cx="18" cy="9" r="2"/><ellipse cx="12" cy="16" rx="4.5" ry="3.5"/>',
    flying: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-1 .1-1.3.5l-.4.5c-.4.5-.2 1.2.3 1.5L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.5 1 .7 1.5.3l.5-.4c.4-.3.6-.8.5-1.3z"/>',
    banks: '<path d="M2 10l10-6 10 6"/><path d="M4 10v11M20 10v11M8 21v-7M12 21v-7M16 21v-7"/><path d="M3 21h18"/>',
    goods: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    carOwnership: '<path d="M3 21V10l5 3V10l5 3V7l6 4v10z"/><path d="M3 21h18"/>',
  };

  // Squarified treemap (Bruls/Huizing/van Wijk): lays out rectangles whose
  // AREA (not just width) is proportional to value, always keeping each
  // box as close to square as it can - the standard treemap algorithm,
  // and the shape used by the domain-by-domain breakdown below instead of
  // a single-row stacked bar, so a dozen very differently-sized domains
  // all stay individually readable rather than the smallest ones
  // collapsing into slivers. `items` must already be sorted descending by
  // value for the algorithm to produce good (near-square) boxes.
  function squarifyTreemap(items, x, y, width, height) {
    const totalValue = items.reduce((sum, d) => sum + d.value, 0);
    if (totalValue <= 0 || width <= 0 || height <= 0) return [];
    const scale = (width * height) / totalValue;
    const scaled = items.map((d) => ({ ...d, area: d.value * scale }));

    function worstAspect(row, side) {
      const sum = row.reduce((s, d) => s + d.area, 0);
      if (sum <= 0) return Infinity;
      const maxArea = Math.max(...row.map((d) => d.area));
      const minArea = Math.min(...row.map((d) => d.area));
      return Math.max((side * side * maxArea) / (sum * sum), (sum * sum) / (side * side * minArea));
    }

    const rects = [];
    let remaining = scaled;
    let cx = x, cy = y, cw = width, ch = height;

    while (remaining.length) {
      const side = Math.min(cw, ch);
      let row = [remaining[0]];
      let best = worstAspect(row, side);
      for (let i = 1; i < remaining.length; i++) {
        const testRow = row.concat(remaining[i]);
        const testWorst = worstAspect(testRow, side);
        if (testWorst > best) break;
        row = testRow;
        best = testWorst;
      }
      const rowArea = row.reduce((s, d) => s + d.area, 0);
      const rowLength = rowArea / side;

      if (cw >= ch) {
        let ry = cy;
        row.forEach((d) => {
          const rh = d.area / rowLength;
          rects.push({ key: d.key, value: d.value, x: cx, y: ry, width: rowLength, height: rh });
          ry += rh;
        });
        cx += rowLength;
        cw -= rowLength;
      } else {
        let rx = cx;
        row.forEach((d) => {
          const rw = d.area / rowLength;
          rects.push({ key: d.key, value: d.value, x: rx, y: cy, width: rw, height: rowLength });
          rx += rw;
        });
        cy += rowLength;
        ch -= rowLength;
      }
      remaining = remaining.slice(row.length);
    }
    return rects;
  }

  // Domain-by-domain breakdown, drawn as a treemap rather than the old
  // single-row stacked bar - each domain's box area (not just its width)
  // is proportional to its share, with the name and kg value labeled
  // directly inside the box wherever it's big enough to hold them, so the
  // chart itself carries the numbers instead of a separate itemized list
  // underneath. Commute/food/alcohol are real tracked totals for
  // [start, today] (same scope as the pace chart above it); the rest
  // (flights, home energy, and the other yearly-estimate categories) have
  // no day-by-day data to draw from, so - same approach as the all-time
  // weekly-average leaderboard - they're each a weekly-equivalent share
  // (yearly ÷ 52), scaled up to match whichever timeframe is selected
  // (×1 for a week, ×totalDays/7 for a month, ×52 for a year). Always
  // ranked biggest-first (squarified treemaps need that for good
  // aspect ratios), so unlike the old bar there's no separate "Rank by
  // size" toggle any more - and no "Show full breakdown" toggle either,
  // since every box already shows its own value up front rather than
  // hiding it behind a tap.
  function renderDomainTreemap(period, start, today, totalDays) {
    const heading = document.getElementById("home-domain-heading");
    if (heading) heading.textContent = `${PERIOD_LABELS[period]}'s emissions by domain`;

    const treemapEl = document.getElementById("home-domain-treemap");
    const keyEl = document.getElementById("home-domain-key");
    if (!treemapEl || !keyEl) return;
    treemapEl.innerHTML = "";
    keyEl.innerHTML = "";

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
      treemapEl.style.height = "";
      treemapEl.innerHTML = '<div class="domain-treemap-empty">No emissions to show for this period yet.</div>';
      return;
    }

    const present = DOMAIN_ORDER
      .map((key) => ({ key, value: values[key] || 0 }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);

    const width = treemapEl.getBoundingClientRect().width || 320;
    const height = Math.round(width * 0.62);
    treemapEl.style.height = `${height}px`;

    const GAP = 2;
    squarifyTreemap(present, 0, 0, width, height).forEach(({ key, value, x, y, width: w, height: h }) => {
      const pct = (value / total) * 100;
      const box = document.createElement("div");
      box.className = `domain-treemap-box domain-${key}`;
      box.style.left = `${x + GAP / 2}px`;
      box.style.top = `${y + GAP / 2}px`;
      box.style.width = `${Math.max(0, w - GAP)}px`;
      box.style.height = `${Math.max(0, h - GAP)}px`;
      box.title = `${DOMAIN_LABELS[key]}: ${fmt(value)} kg CO2e (${Math.round(pct)}%)`;
      // A box too small to hold the name+value text falls back to just its
      // category icon, centered - the name and value themselves are
      // already in the key row below either way, so the box's own job at
      // that size is just staying identifiable at a glance (plus its title
      // tooltip). Every box gets at least the icon, however small - the
      // box's own overflow:hidden clips it gracefully rather than leaving
      // a bare, unidentifiable colored patch.
      if (w >= 46 && h >= 30) {
        box.innerHTML = `
          <span class="domain-treemap-label">${DOMAIN_LABELS[key]}</span>
          <span class="domain-treemap-value">${fmt(value)} kg</span>
        `;
      } else {
        box.classList.add("domain-treemap-box-icon-only");
        const iconSize = Math.max(10, Math.min(20, Math.min(w, h) * 0.6));
        box.innerHTML = `<svg class="domain-treemap-icon" style="width:${iconSize}px;height:${iconSize}px" viewBox="0 0 24 24" aria-hidden="true">${DOMAIN_ICON_SVG[key]}</svg>`;
      }
      treemapEl.appendChild(box);
    });

    present.forEach(({ key }) => {
      const li = document.createElement("li");
      li.className = "domain-key-item";
      const swatch = document.createElement("span");
      swatch.className = `domain-key-swatch domain-${key}`;
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "domain-key-icon");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = DOMAIN_ICON_SVG[key];
      const text = document.createElement("span");
      text.textContent = DOMAIN_LABELS[key];
      li.appendChild(swatch);
      li.appendChild(icon);
      li.appendChild(text);
      keyEl.appendChild(li);
    });

    const totalLi = document.createElement("li");
    totalLi.className = "domain-key-total";
    totalLi.textContent = `Total: ${fmt(total)} kg CO2e`;
    keyEl.appendChild(totalLi);
  }

  const PERIOD_LABELS = { week: "This week", month: "This month", year: "This year" };
  const PERIOD_GOAL_SUFFIX = { week: "kg goal", month: "kg/mo goal", year: "kg/yr goal" };

  // The Home page's single budget-pace chart - a dashed target line and a
  // stacked actual area, both rising from 0 to the goal across whichever
  // period is selected. The stack covers every tracked domain, not just
  // commute/food/alcohol: those three are built day by day from real
  // confirmed data, and everything else (flights, home energy, buying
  // goods, and the optional extras) is spread evenly from its own yearly
  // profile estimate - see the extras handling below. Replaces what used
  // to be two separate charts (This Week page's weekly one, Stats page's
  // yearly one) with one, toggled by the picker above it.
  let homeChartPeriod = "week";
  function renderPeriodChart(period = homeChartPeriod) {
    homeChartPeriod = period;
    document.querySelectorAll(".home-period-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.period === period);
    });

    const { start, totalDays, goal, applyTrackingStart } = periodBounds(period);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { commute: commuteDaily, food: foodDaily, alcohol: alcoholDaily, todayOffset } = computeRangeDailyKgByDomain(start, today);

    const predicted = [];
    for (let j = 0; j <= totalDays; j++) predicted.push(goal * (j / totalDays));

    // Untracked days at the start of a month/year (before tracking began)
    // have no data, so there's no way to know what they actually emitted -
    // rather than crediting them as zero-emission (which would make the
    // stacked bands jump out artificially ahead of pace), they're assumed
    // to have used exactly their fair share of the goal at the target
    // rate. The stack's bottom edge at the tracking-start point is
    // therefore the target line's own value there (budgetAtStart, used as
    // stackBaseline below) - so the bands begin exactly on the dashed
    // target line and only diverge based on what's actually been tracked
    // since, with each domain's own share stacked on top of that shared
    // starting point rather than from 0.
    let trackingStartOffset = 0;
    if (applyTrackingStart) {
      const trackedStart = new Date(`${firstTrackedWeekKey()}T00:00:00`);
      trackingStartOffset = Math.min(todayOffset, Math.max(0, Math.round((trackedStart - start) / DAY_MS)));
    }
    const budgetAtStart = predicted[trackingStartOffset];

    function cumulativeSinceStart(dailyArr) {
      const out = [0];
      for (let k = trackingStartOffset; k <= todayOffset; k++) out.push(out[out.length - 1] + (dailyArr[k] || 0));
      return out;
    }
    const cumCommute = cumulativeSinceStart(commuteDaily);
    const cumFood = cumulativeSinceStart(foodDaily);
    const cumAlcohol = cumulativeSinceStart(alcoholDaily);

    // Flights, home energy, buying goods, and the optional extras (gas
    // heating/car ownership/pets/water/banking) don't have day-by-day logs
    // the way commute/food/alcohol do - they're yearly profile estimates
    // (see weeklyExtrasBreakdownFor()), so each is spread evenly across
    // every day at its own flat weekly-equivalent/7 rate, the same "assume
    // the steady rate" treatment already used above for days before
    // tracking began. Domains the person has never answered (or that come
    // to 0) are left out of both the stack and the legend entirely, same
    // as renderDomainTreemap() already does.
    const extras = weeklyExtrasBreakdownFor(profile);
    const EXTRA_DOMAIN_KEYS = ["homeEnergy", "gasHeating", "water", "pets", "flying", "banks", "goods", "carOwnership"];
    const extraCumulatives = EXTRA_DOMAIN_KEYS
      .map((key) => ({ key, cumulative: cumulativeSinceStart(new Array(totalDays + 1).fill((extras[key] || 0) / 7)) }))
      .filter(({ cumulative }) => cumulative[cumulative.length - 1] > 0);

    // Each band's values are the STACKED (cumulative-inclusive) top edge,
    // ready for renderBudgetChart() to plot directly - band order here is
    // also the visual bottom-to-top stacking order. The day-logged domains
    // (commute/food/alcohol) sit closest to the start line; the flat-rate
    // extras above stack on top of those.
    const series = [
      { key: "commute", values: cumCommute.map((v) => budgetAtStart + v) },
      { key: "food", values: cumFood.map((v, k) => budgetAtStart + cumCommute[k] + v) },
      { key: "alcohol", values: cumAlcohol.map((v, k) => budgetAtStart + cumCommute[k] + cumFood[k] + v) },
    ];
    let runningTotal = cumAlcohol.map((v, k) => cumCommute[k] + cumFood[k] + v);
    extraCumulatives.forEach(({ key, cumulative }) => {
      series.push({ key, values: cumulative.map((v, k) => budgetAtStart + runningTotal[k] + v) });
      runningTotal = runningTotal.map((base, k) => base + cumulative[k]);
    });

    const xLabels = periodXLabels(period, start, totalDays, todayOffset);

    const budgetChartArgs = {
      goal,
      predicted,
      series,
      actualStartJ: trackingStartOffset,
      stackBaseline: budgetAtStart,
      xLabels,
      goalLabelSuffix: PERIOD_GOAL_SUFFIX[period],
      ariaPrefix: `${PERIOD_LABELS[period]} budget pace`,
    };
    const chartSvgHeight = renderBudgetChart("home-chart", budgetChartArgs);
    renderDomainTreemap(period, start, today, totalDays);

    // The two Budget-pace carousel slides should read as one consistent
    // box, not the line chart looking cramped next to a visibly taller
    // treemap - so if the treemap slide (heading + boxes + color key)
    // comes out taller than the chart slide (chart + legend), re-render
    // the chart with its SVG grown by exactly that difference, rather
    // than just padding the gap with blank space (which is what letting
    // the carousel itself stretch the shorter slide would do). Legend
    // height is unaffected by SVG height, so this one extra pass lands
    // on an exact match.
    const budgetSlide = document.querySelector("#home-budget-carousel .carousel-slide:first-child");
    const treemapSlide = document.querySelector("#home-budget-carousel .carousel-slide:last-child");
    if (budgetSlide && treemapSlide) {
      const chartSlideHeight = measureSlideContentHeight(budgetSlide);
      const treemapSlideHeight = measureSlideContentHeight(treemapSlide);
      const shortfall = treemapSlideHeight - chartSlideHeight;
      if (shortfall > 1) {
        renderBudgetChart("home-chart", { ...budgetChartArgs, minSvgHeight: chartSvgHeight + shortfall });
      }
    }
    syncCarouselHeight("home-budget-carousel");
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

  // "Do you want to save the planet?" CTA on the Habits card's Banking
  // nudge - a fuller breakdown than the one-line saving shown on the tile
  // itself, plus a plain-English explainer of how switching actually works
  // in the UK (free, automatic, ~7 working days), so the nudge leads
  // somewhere concrete rather than just stating a number.
  function bankSwitchContentHtml() {
    const factor = BANK_KG_PER_POUND_PER_YEAR[profile.bankName] || 0;
    const balance = profile.bankBalance || 0;
    const currentYearlyKg = factor * balance;
    const alternatives = Object.entries(BANK_KG_PER_POUND_PER_YEAR)
      .filter(([id]) => id !== profile.bankName)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3);
    const rows = alternatives.map(([id, f]) => {
      const savings = Math.max(0, currentYearlyKg - f * balance);
      return `<tr><td>${BANK_LABELS[id]}</td><td>${Math.round(savings).toLocaleString()} kg/yr saved</td></tr>`;
    }).join("");
    return `
      <p>You currently hold &pound;${balance.toLocaleString()} with <strong>${BANK_LABELS[profile.bankName]}</strong>, financing about <strong>${Math.round(currentYearlyKg).toLocaleString()} kg CO2e</strong> a year through what the bank invests deposits in.</p>
      <table class="week-detail-table">
        <thead><tr><th>Switch to</th><th>Estimated saving</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p>Some high-street banks finance many times more fossil-fuel extraction than others, purely based on where they invest deposits — your own spending doesn't change at all.</p>
      <h4>How switching works</h4>
      <ul>
        <li>Open an account with the new bank first — most let you do this online in a few minutes.</li>
        <li>Ask them to move your account using the UK's Current Account Switch Service — it's free.</li>
        <li>Direct debits, standing orders, and your salary/payments transfer automatically, usually within about 7 working days.</li>
        <li>Your old account closes automatically once the switch completes — nothing else for you to cancel.</li>
      </ul>
    `;
  }

  function openBankSwitchModal() {
    document.getElementById("bank-switch-body").innerHTML = bankSwitchContentHtml();
    document.getElementById("bank-switch-backdrop").classList.add("open");
  }

  function closeBankSwitchModal() {
    document.getElementById("bank-switch-backdrop").classList.remove("open");
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
    const flying = (inputs.flyingYearlyKg || 0) / 52;
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

    const { data, error } = leaderboardScope === "all"
      ? await sbClient.rpc("public_leaderboard", {
          target_week_key: CURRENT_WEEK_KEY,
          filter_university: parseLeaderboardGroupFilter(leaderboardGroupFilter).university,
          filter_country: parseLeaderboardGroupFilter(leaderboardGroupFilter).country,
        })
      : await sbClient.rpc("friend_leaderboard", { target_week_key: CURRENT_WEEK_KEY });
    list.innerHTML = "";
    winnerEl.hidden = true;

    if (error) {
      list.innerHTML = '<p class="empty-note">Could not load the leaderboard right now.</p>';
      return;
    }
    if (!data || data.length === 0) {
      list.innerHTML = leaderboardScope === "all"
        ? '<p class="empty-note">No results - try a different filter, or nobody in this group has opted in yet.</p>'
        : '<p class="empty-note">Log this week, then add friends from the Account page to compare.</p>';
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

  // Membership-only "leagues": self + accepted friends who qualify this
  // week (Vegan/Veggie/Commute/Goal) or have an ongoing streak
  // (Flight-free) - see friend_leagues() in schema.sql, which computes
  // every flag server-side and never sends the underlying diet/commute/
  // flights/goal data itself to the client. Not ranked totals like the
  // leaderboards above, just "who's in" - Vegan/Veggie/Commute/Goal reset
  // with the week; Flight-free only lists people with at least one logged
  // (dated) flight ever, so "never answered" doesn't masquerade as "flying
  // zero". Goal league membership is "on track for your own weekly goal
  // right now" - everyone effectively has a goal (weekly_goal_kg defaults
  // to 20 kg rather than being unset), so there's no separate "have they
  // set one" gate; the meaningful bar is having logged at least one day
  // this week and being at or under pace, same is_on_track_for_goal flag
  // the server computes.
  const WEEKLY_LEAGUES = [
    { emoji: "🌱", label: "Vegan league", flag: "isVeganWeek" },
    { emoji: "🥕", label: "Veggie league", flag: "isVeggieWeek" },
    { emoji: "🚲", label: "Commute league", flag: "isCarFreeWeek" },
    { emoji: "🎯", label: "Goal league", flag: "isOnTrackForGoal" },
  ];

  function buildLeagueBlock(emoji, label, members) {
    const block = document.createElement("div");
    block.className = "league-block";
    const heading = document.createElement("h3");
    heading.className = "league-heading";
    const emojiSpan = document.createElement("span");
    emojiSpan.setAttribute("aria-hidden", "true");
    emojiSpan.textContent = emoji;
    heading.appendChild(emojiSpan);
    heading.appendChild(document.createTextNode(` ${label}`));
    block.appendChild(heading);

    if (members.length === 0) {
      const empty = document.createElement("p");
      empty.className = "league-empty";
      empty.textContent = "Nobody yet.";
      block.appendChild(empty);
      return block;
    }
    const ul = document.createElement("ul");
    ul.className = "league-members";
    members.forEach(({ name, isSelf, detail }) => {
      const li = document.createElement("li");
      if (isSelf) li.classList.add("is-self");
      li.textContent = detail ? `${name} — ${detail}` : name;
      ul.appendChild(li);
    });
    block.appendChild(ul);
    return block;
  }

  async function renderLeagues() {
    const grid = document.getElementById("leagues-grid");
    if (!grid || !currentUser) return;

    // day_index (1=Monday..7=Sunday) is computed client-side and passed
    // in, same as target_week_key - the server has no reliable notion of
    // the caller's local day, so is_on_track_for_goal's proration has to
    // be driven from here (see the SQL function's comment).
    const { data, error } = await sbClient.rpc("friend_leagues", { target_week_key: CURRENT_WEEK_KEY, day_index: todayIndexInWeek() });
    grid.innerHTML = "";
    if (error || !data) {
      grid.innerHTML = '<p class="empty-note">Could not load leagues right now.</p>';
      return;
    }

    const rows = data.map((r) => ({
      name: r.is_self ? "You" : (r.display_name || "Friend"),
      isSelf: r.is_self,
      isVeganWeek: r.is_vegan_week,
      isVeggieWeek: r.is_veggie_week,
      isCarFreeWeek: r.is_car_free_week,
      isOnTrackForGoal: r.is_on_track_for_goal,
      flightFreeDays: r.flight_free_days,
    }));
    // You first, then friends alphabetically - there's no other ranking
    // signal for a plain membership league.
    const byNameSelfFirst = (a, b) => (a.isSelf !== b.isSelf ? (a.isSelf ? -1 : 1) : a.name.localeCompare(b.name));

    WEEKLY_LEAGUES.forEach((league) => {
      const members = rows.filter((r) => r[league.flag]).sort(byNameSelfFirst)
        .map((r) => ({ name: r.name, isSelf: r.isSelf }));
      grid.appendChild(buildLeagueBlock(league.emoji, league.label, members));
    });

    const flightMembers = rows
      .filter((r) => r.flightFreeDays !== null && r.flightFreeDays !== undefined)
      .sort((a, b) => b.flightFreeDays - a.flightFreeDays)
      .map((r) => ({ name: r.name, isSelf: r.isSelf, detail: `${r.flightFreeDays}d` }));
    grid.appendChild(buildLeagueBlock("✈️", "Flight-free league", flightMembers));
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
  // Renders every accordion section's data unconditionally, regardless of
  // which one (if any) is currently expanded - same "keep it all fresh,
  // cheap enough not to bother gating" approach as every other multi-card
  // page in the app. Expand/collapse itself is native <details> (see the
  // "account-accordion" name group in index.html) - no JS needed for that
  // part, and the browser remembers each section's open/closed state for
  // free across tab switches, since showTab() only toggles the whole
  // page's `hidden`, never touches or rebuilds this DOM.
  // Full country list for the Settings "Country" picker and the
  // Leaderboard's "All Members" country filter - must be kept in sync
  // with schema.sql's profiles_country_check constraint (same
  // duplication-by-necessity as UNIVERSITY_LIST/the university check
  // constraint below: a SQL CHECK constraint and a JS array can't share a
  // single source of truth in a project with no build step).
  const COUNTRY_LIST = [
    "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria",
    "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan",
    "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia",
    "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo (Brazzaville)", "Congo (Kinshasa)",
    "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czechia", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador",
    "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France",
    "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau",
    "Guyana", "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland",
    "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait",
    "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg",
    "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico",
    "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru",
    "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman",
    "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
    "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe",
    "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia",
    "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria",
    "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey",
    "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu",
    "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe",
  ];

  // Mirrors the <option> list already hardcoded onto #profile-university
  // in index.html - kept here too (rather than generating that static
  // list from this array) purely so the Leaderboard's group filter below
  // can build its own University optgroup without a second hardcoded copy
  // of the same 3 names.
  const UNIVERSITY_LIST = ["UCL", "Imperial", "KCL"];

  // Fills a <select> with "Prefer not to say" + every COUNTRY_LIST entry,
  // shared by the Settings country picker and (via includeCountryPrefix)
  // the Leaderboard's "All Members" group filter, so the two country
  // lists themselves never drift apart from each other.
  function populateCountrySelect(selectEl, { includeCountryPrefix = false } = {}) {
    selectEl.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "Prefer not to say";
    selectEl.appendChild(noneOpt);
    COUNTRY_LIST.forEach((country) => {
      const opt = document.createElement("option");
      opt.value = includeCountryPrefix ? `country:${country}` : country;
      opt.textContent = country;
      selectEl.appendChild(opt);
    });
  }

  // Fills the Leaderboard's "All Members" group-filter <select> with
  // "Everyone" plus a University optgroup (UNIVERSITY_LIST as-is) and a
  // Country optgroup (COUNTRY_LIST prefixed "country:", via
  // populateCountrySelect) - the prefix is how parseLeaderboardGroupFilter()
  // tells the two kinds of value apart when calling public_leaderboard().
  function populateLeaderboardGroupFilter(selectEl) {
    selectEl.innerHTML = "";
    const everyoneOpt = document.createElement("option");
    everyoneOpt.value = "";
    everyoneOpt.textContent = "Everyone";
    selectEl.appendChild(everyoneOpt);

    const uniGroup = document.createElement("optgroup");
    uniGroup.label = "University";
    UNIVERSITY_LIST.forEach((uni) => {
      const opt = document.createElement("option");
      opt.value = uni;
      opt.textContent = uni;
      uniGroup.appendChild(opt);
    });
    selectEl.appendChild(uniGroup);

    const countryGroup = document.createElement("optgroup");
    countryGroup.label = "Country";
    const countrySelectShim = document.createElement("select");
    populateCountrySelect(countrySelectShim, { includeCountryPrefix: true });
    Array.from(countrySelectShim.options)
      .filter((opt) => opt.value.startsWith("country:"))
      .forEach((opt) => countryGroup.appendChild(opt));
    selectEl.appendChild(countryGroup);
  }

  // Splits a leaderboardGroupFilter value into the { university, country }
  // args public_leaderboard() expects - "" means neither filter applies.
  function parseLeaderboardGroupFilter(value) {
    if (!value) return { university: null, country: null };
    if (value.startsWith("country:")) return { university: null, country: value.slice("country:".length) };
    return { university: value, country: null };
  }

  function renderAccountPage() {
    document.getElementById("profile-name").value = profile.name || "";
    document.getElementById("profile-distance").value = profile.commuteDistanceKm;
    document.getElementById("profile-goal").value = profile.weeklyGoalKg;
    document.getElementById("profile-food-waste").value = profile.foodWaste;
    document.getElementById("profile-university").value = profile.university || "None";
    document.getElementById("owns-car").value = profile.ownsCar === true ? "yes" : profile.ownsCar === false ? "no" : "";
    document.getElementById("car-fuel-type").value = profile.carFuelType || "";
    document.getElementById("research-opt-in").checked = !!profile.researchOptIn;
    document.getElementById("settings-country").value = profile.country || "";
    document.getElementById("leaderboard-opt-in").checked = !!profile.leaderboardOptIn;
    document.getElementById("account-email").textContent = currentUser?.email || "";
    document.getElementById("owner-research-export").hidden =
      (currentUser?.email || "").toLowerCase() !== OWNER_EMAIL.toLowerCase();
    renderBaselineWeekForm();
    renderFriendsUI();
    renderReminderCard();
    renderWeeksGrid();
    renderProfileAvatar();
  }

  // ---------- Profile photo (Account page) ----------
  // Stored as a small square JPEG data URL (profile.avatarDataUrl) rather
  // than in Supabase Storage - see the DEFAULT_PROFILE comment for why.
  // Resized/cropped client-side on upload so what actually gets stored
  // stays tiny regardless of the source photo's size.
  const AVATAR_SIZE = 200; // px, square
  const AVATAR_MAX_DATA_URL_LENGTH = 300000; // matches the schema's check constraint

  function renderProfileAvatar() {
    const img = document.getElementById("profile-avatar-img");
    const placeholder = document.getElementById("profile-avatar-placeholder");
    const removeBtn = document.getElementById("profile-avatar-remove-btn");
    if (profile.avatarDataUrl) {
      img.src = profile.avatarDataUrl;
      img.hidden = false;
      placeholder.hidden = true;
      removeBtn.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      placeholder.hidden = false;
      placeholder.textContent = (profile.name || "?").trim().charAt(0).toUpperCase() || "?";
      removeBtn.hidden = true;
    }
  }

  function showAvatarError(message) {
    const el = document.getElementById("profile-avatar-error");
    el.textContent = message;
    el.hidden = !message;
  }

  // Crops the source image to a centered square, then draws it down to a
  // fixed small size - so a huge photo straight off a phone camera and a
  // tiny square icon both end up the same predictable size on disk,
  // instead of storing whatever resolution/aspect ratio was uploaded.
  function cropAndResizeImage(imageBitmap, size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const srcSize = Math.min(imageBitmap.width, imageBitmap.height);
    const srcX = (imageBitmap.width - srcSize) / 2;
    const srcY = (imageBitmap.height - srcSize) / 2;
    ctx.drawImage(imageBitmap, srcX, srcY, srcSize, srcSize, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  async function handleAvatarFileSelected(file) {
    showAvatarError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showAvatarError("That file doesn't look like an image.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const dataUrl = cropAndResizeImage(bitmap, AVATAR_SIZE);
      if (dataUrl.length > AVATAR_MAX_DATA_URL_LENGTH) {
        showAvatarError("That image is too large even after resizing - try a different photo.");
        return;
      }
      profile.avatarDataUrl = dataUrl;
      renderProfileAvatar();
      persistProfile();
    } catch (e) {
      console.error("Failed to process avatar image", e);
      showAvatarError("Couldn't read that image - try a different file.");
    }
  }

  function removeAvatar() {
    profile.avatarDataUrl = null;
    showAvatarError("");
    renderProfileAvatar();
    persistProfile();
  }

  // ---------- Baseline week screen (Account > Settings) ----------
  // Which of the 3 tabs is showing - transient UI state, not persisted
  // (reset to match the actual data whenever the screen is freshly
  // entered - see showSettingsDetail()). "copy" is purely an action tab:
  // picking a week there immediately copies it and flips back to
  // "custom", it never stays selected on its own.
  // Leaderboard's "This week" card - transient UI state, not persisted.
  // "friends" mirrors the original friends-only card unchanged; "all"
  // switches to public_leaderboard() (opted-in members only) and enables
  // leaderboardGroupFilter, either "" (everyone opted in), a UNIVERSITY_LIST
  // entry, or "country:<COUNTRY_LIST entry>" (see populateCountrySelect's
  // includeCountryPrefix, reused for this same dropdown).
  let leaderboardScope = "friends";
  let leaderboardGroupFilter = "";

  let baselineViewMode = "custom";
  // The Custom tab's working data - mirrors profile.baselineWeek once
  // anything real exists, otherwise a fresh blank template that merely
  // VIEWING the tab must not persist (see onBaselineChange(), the only
  // place that actually commits it to profile.baselineWeek).
  let baselineDraft = null;

  function getBaselineDraft() {
    if (profile.baselineWeek) { baselineDraft = profile.baselineWeek; return baselineDraft; }
    if (!baselineDraft) baselineDraft = blankWeek();
    return baselineDraft;
  }

  // Fires on any edit within the Custom week tab - commits the draft to
  // profile.baselineWeek on the very first real edit (a bare "viewed the
  // tab but changed nothing" never gets persisted), and keeps every day
  // pre-confirmed: a hypothetical typical week has no "hasn't happened
  // yet" day to withhold the way a real one does, so there's no confirm
  // step in this form at all (see buildCommuteTable()/buildDietTable()'s
  // showConfirm:false below) and every edit counts immediately.
  function onBaselineChange() {
    if (!profile.baselineWeek) profile.baselineWeek = baselineDraft;
    DAYS.forEach((d) => {
      profile.baselineWeek.confirmedCommute[d.key] = true;
      profile.baselineWeek.confirmedDiet[d.key] = true;
    });
    persistProfile();
    renderBaselineTotal();
  }

  function renderBaselineTotal() {
    const el = document.getElementById("baseline-total-value");
    if (!el) return;
    el.textContent = fmt(weekTotals(getBaselineDraft()).total);
  }

  // Copies a real tracked week's data into the baseline as an editable
  // snapshot - deliberately a one-time copy, not a live reference, so
  // later editing that real week on This Week never silently shifts an
  // already-set baseline out from under you.
  function copyWeekToBaseline(weekKey) {
    const src = weeksCache[weekKey];
    if (!src) return;
    const copy = {
      commute: { ...src.commute },
      diet: Object.fromEntries(DAYS.map((d) => [d.key, { ...(src.diet[d.key] || { type: "" }) }])),
      confirmedCommute: Object.fromEntries(DAYS.map((d) => [d.key, true])),
      confirmedDiet: Object.fromEntries(DAYS.map((d) => [d.key, true])),
      alcohol: { ...src.alcohol },
      extraJourneys: [],
    };
    profile.baselineWeek = copy;
    baselineDraft = copy;
    baselineViewMode = "custom";
    persistProfile();
    renderBaselineWeekForm();
  }

  function useUkAverageBaseline() {
    profile.baselineWeek = null;
    baselineDraft = null;
    persistProfile();
    renderBaselineWeekForm();
  }

  function renderBaselineCopyList() {
    const container = document.getElementById("baseline-copy-list");
    const weekKeys = Object.keys(weeksCache).sort().reverse();
    if (weekKeys.length === 0) {
      container.innerHTML = `<p class="assumptions">You haven't tracked any weeks yet.</p>`;
      return;
    }
    container.innerHTML = weekKeys.map((key) => `
      <button type="button" class="year-list-row" data-copy-week="${key}">
        <span class="year-list-label">${weekLabel(key)}</span>
        <span class="year-list-chevron" aria-hidden="true">&#8250;</span>
      </button>
    `).join("");
  }

  function renderBaselineWeekForm() {
    document.querySelectorAll("#baseline-mode-toggle .week-picker-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.baselineMode === baselineViewMode);
    });
    document.getElementById("baseline-mode-custom").hidden = baselineViewMode !== "custom";
    document.getElementById("baseline-mode-copy").hidden = baselineViewMode !== "copy";
    document.getElementById("baseline-mode-ukaverage").hidden = baselineViewMode !== "ukAverage";

    if (baselineViewMode === "custom") {
      const weekData = getBaselineDraft();
      const opts = { showConfirm: false, showFootprint: false, todayKey: null, onChange: onBaselineChange };
      buildCommuteTable(weekData, { ...opts, tbodySelector: "#baseline-commute-table tbody" });
      buildDietTable(weekData, { ...opts, containerSelector: "#baseline-diet-table" });
      document.getElementById("baseline-alcohol-beer").value = weekData.alcohol.beer || 0;
      document.getElementById("baseline-alcohol-wine").value = weekData.alcohol.wine || 0;
      renderBaselineTotal();
    } else if (baselineViewMode === "copy") {
      renderBaselineCopyList();
    }
  }

  // ---------- Page: Stats (yearly estimate) ----------
  // Average across fully-confirmed weeks from at most the last 52 weeks (a
  // rolling window, not all-time) - feeds the "Your year, estimated"
  // food/commute/non-commute-driving/alcohol figures below, so someone
  // who's been tracking for two years gets a yearly PROJECTION based on how
  // they've actually been living lately, not diluted by habits from a year
  // ago that may no longer apply.
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

  // ---------- Flying (This Year page, itemized log) ----------
  const FLIGHT_CONTINENT_LABELS = { europe: "Europe", northAmerica: "N. America", asia: "Asia", africa: "Africa", southAmerica: "S. America", oceania: "Oceania" };
  const FLIGHT_CLASS_LABELS = { economy: "Economy", economyPlus: "Economy Plus", business: "Business", first: "First" };
  // A dated flight older than this doesn't count toward the current "per
  // year" total any more, so a year of past trips doesn't just keep
  // accumulating forever - a flight logged with no date always counts,
  // since there's nothing to compare against (matches the old flat
  // per-year count, which had no date concept at all).
  const FLIGHT_STALE_DAYS = 365;

  function flightFootprint(flight) {
    return (FLIGHT_CONTINENT_KG[flight.continent] || 0) * (FLIGHT_CLASS_MULTIPLIER[flight.class] || 1);
  }

  function isFlightCounted(flight) {
    if (!flight.date) return true;
    const flightDate = new Date(`${flight.date}T00:00:00`);
    return (Date.now() - flightDate.getTime()) / DAY_MS <= FLIGHT_STALE_DAYS;
  }

  function computeFlyingYearlyKg(flights) {
    return (flights || []).filter(isFlightCounted).reduce((sum, f) => sum + flightFootprint(f), 0);
  }

  function renderFlightList() {
    const list = document.getElementById("flight-list");
    if (!list) return;
    list.innerHTML = "";
    (profile.flights || []).forEach((f, i) => {
      const counted = isFlightCounted(f);
      const kg = flightFootprint(f);
      const dateLabel = f.date
        ? new Date(`${f.date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
        : "No date";

      const li = document.createElement("li");
      li.className = counted ? "journey-item" : "journey-item journey-item-excluded";
      const text = document.createElement("span");
      text.className = "journey-item-text";
      text.textContent = `${dateLabel} · ${FLIGHT_CONTINENT_LABELS[f.continent] || f.continent} · ${FLIGHT_CLASS_LABELS[f.class] || f.class} · ${fmt(kg)} kg CO2e`;
      if (!counted) {
        const note = document.createElement("span");
        note.className = "journey-item-excluded-note";
        note.textContent = " (over a year ago – not counted)";
        text.appendChild(note);
      }
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "journey-remove-btn";
      removeBtn.setAttribute("aria-label", `Remove ${dateLabel} flight`);
      removeBtn.textContent = "×";
      removeBtn.dataset.index = i;

      li.appendChild(text);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
  }

  let selectedFlightContinent = null;
  let selectedFlightClass = null;

  function addFlight() {
    if (!selectedFlightContinent || !selectedFlightClass) return;
    const dateInput = document.getElementById("flight-date");
    profile.flights = profile.flights || [];
    profile.flights.push({ date: dateInput.value || null, continent: selectedFlightContinent, class: selectedFlightClass });
    profile.flyingYearlyKg = computeFlyingYearlyKg(profile.flights);
    persistProfile();
    renderFlightList();
    renderStatsPage();

    dateInput.value = "";
    document.querySelectorAll(".flight-continent-btn").forEach((btn) => btn.classList.remove("active"));
    document.querySelectorAll(".flight-class-btn").forEach((btn) => btn.classList.remove("active"));
    selectedFlightContinent = null;
    selectedFlightClass = null;
  }

  function removeFlight(index) {
    (profile.flights || []).splice(index, 1);
    profile.flyingYearlyKg = computeFlyingYearlyKg(profile.flights);
    persistProfile();
    renderFlightList();
    renderStatsPage();
  }

  // ---------- Household energy (This Year page, bill-based) ----------
  const AVG_DAYS_PER_MONTH = 365.25 / 12;
  // How long a submitted bill stays "fresh" before the To-do list nudges
  // for an updated one - a bit over a year, so a whole-year bill (the
  // recommended way to submit one) doesn't immediately read as stale the
  // day after its own end date.
  const ELECTRICITY_BILL_STALE_DAYS = 400;

  function computeElectricityMonthlyKwh(bill) {
    if (!bill || !bill.from || !bill.to || !(bill.kwh > 0)) return null;
    const from = new Date(`${bill.from}T00:00:00`);
    const to = new Date(`${bill.to}T00:00:00`);
    const days = Math.round((to - from) / DAY_MS) + 1;
    if (days <= 0) return null;
    return (bill.kwh / days) * AVG_DAYS_PER_MONTH;
  }

  function electricityBillIsFresh() {
    if (!profile.electricityBillTo) return false;
    const to = new Date(`${profile.electricityBillTo}T00:00:00`);
    return (Date.now() - to.getTime()) / DAY_MS <= ELECTRICITY_BILL_STALE_DAYS;
  }

  function renderElectricityBillSummary() {
    document.getElementById("electricity-bill-from").value = profile.electricityBillFrom || "";
    document.getElementById("electricity-bill-to").value = profile.electricityBillTo || "";
    document.getElementById("electricity-bill-kwh").value = optionalInputValue(profile.electricityBillKwh);

    const summary = document.getElementById("electricity-bill-summary");
    const stale = document.getElementById("electricity-bill-stale");
    if (!summary || !stale) return;
    if (!profile.householdKwhPerMonth || !profile.electricityBillFrom || !profile.electricityBillTo) {
      summary.textContent = "No bill submitted yet.";
      stale.hidden = true;
      return;
    }
    summary.textContent = `≈ ${fmt(profile.householdKwhPerMonth)} kWh/month, based on your bill from ${profile.electricityBillFrom} to ${profile.electricityBillTo}.`;
    stale.hidden = electricityBillIsFresh();
  }

  function saveElectricityBill() {
    const fromInput = document.getElementById("electricity-bill-from");
    const toInput = document.getElementById("electricity-bill-to");
    const kwhInput = document.getElementById("electricity-bill-kwh");
    const from = fromInput.value || null;
    const to = toInput.value || null;
    const kwh = parseFloat(kwhInput.value);
    if (!from || !to || to < from || !(kwh > 0)) return;

    profile.electricityBillFrom = from;
    profile.electricityBillTo = to;
    profile.electricityBillKwh = kwh;
    profile.householdKwhPerMonth = computeElectricityMonthlyKwh({ from, to, kwh }) || 0;

    persistProfile();
    renderElectricityBillSummary();
    renderStatsPage();
  }

  // Populates the "This Year" tab's input fields. Kept separate from
  // renderStatsPage() (the results-only Stats page) since the two now
  // live on different tabs.
  function renderYearlyInputs() {
    renderFlightList();
    document.getElementById("household-people").value = profile.householdPeople;
    renderElectricityBillSummary();
    document.getElementById("gas-heating-kwh").value = optionalInputValue(profile.annualGasKwh);
    document.getElementById("annual-water-m3").value = optionalInputValue(profile.annualWaterM3);
    document.getElementById("num-dogs").value = optionalInputValue(profile.numDogs);
    document.getElementById("num-cats").value = optionalInputValue(profile.numCats);
    document.getElementById("bank-name").value = profile.bankName || "";
    document.getElementById("bank-balance").value = optionalInputValue(profile.bankBalance);
    document.getElementById("clothes-per-month").value = profile.clothesPerMonth;
  }

  // This Year page navigation: a list of categories, each drilling into
  // its own full-screen detail view with a back button - not an accordion,
  // matching the list->detail->back pattern the Account accordion doesn't use.
  const YEAR_DETAIL_IDS = ["flying", "household", "pets", "banking", "goods"];

  function showYearList() {
    document.getElementById("year-list").hidden = false;
    YEAR_DETAIL_IDS.forEach((id) => {
      document.getElementById(`year-detail-${id}`).hidden = true;
    });
  }

  function showYearDetail(id) {
    document.getElementById("year-list").hidden = true;
    YEAR_DETAIL_IDS.forEach((detailId) => {
      document.getElementById(`year-detail-${detailId}`).hidden = detailId !== id;
    });
  }

  // Jumps straight to a This Year detail section (e.g. from the Habits
  // card's Banking nudge) from anywhere in the app. Setting location.hash
  // fires "hashchange" asynchronously, and that handler always calls
  // showTab("weeks"), which resets to showYearList() - so a plain
  // `location.hash = "weeks"; showYearDetail(id);` would have the detail
  // view silently undone a moment later by that reset. pendingYearDetail
  // is consumed inside showTab()'s "weeks" branch to survive that. When
  // already on the weeks tab, no hashchange will fire at all, so it's
  // safe to just call showTab() directly instead.
  let pendingYearDetail = null;

  function goToYearDetail(id) {
    if (currentTab() === "weeks") {
      showTab("weeks");
      showYearDetail(id);
    } else {
      pendingYearDetail = id;
      location.hash = "weeks";
    }
  }

  // Account page's Settings section: the same list->detail->back
  // navigation as This Year above (not the outer Account accordion's
  // native <details> toggles), for the same reason - Vehicle/Daily
  // reminder/Baseline week/Data sharing each carry enough fields to want
  // a full screen rather than expanding in place. Nested one level inside
  // the "Settings" <details>, which stays a native accordion item itself.
  const SETTINGS_DETAIL_IDS = ["vehicle", "reminder", "baseline", "country", "sharing", "disclaimer"];

  function showSettingsList() {
    document.getElementById("settings-list").hidden = false;
    SETTINGS_DETAIL_IDS.forEach((id) => {
      document.getElementById(`settings-detail-${id}`).hidden = true;
    });
  }

  function showSettingsDetail(id) {
    document.getElementById("settings-list").hidden = true;
    SETTINGS_DETAIL_IDS.forEach((detailId) => {
      document.getElementById(`settings-detail-${detailId}`).hidden = detailId !== id;
    });
    // Reset to whichever tab reflects the actual data, rather than
    // leaving it on "copy" (an action tab, never meant to stick) or on
    // "custom" from a previous visit if the baseline's since been cleared.
    if (id === "baseline") {
      baselineViewMode = profile.baselineWeek ? "custom" : "ukAverage";
      renderBaselineWeekForm();
    }
  }

  // ---------- Habits (Leaderboard page "Habits" card) ----------
  // Fully opt-in: nothing shows until the person picks a domain from a
  // survey (see renderHabitsCard() below), ranked by which domain is
  // actually biggest for them (computeHabitDomainSizes()). Only "Flying"
  // keeps the old streak model (survey -> straight to the tile, no extra
  // step); Eating and Commuting instead set a weekly day-target (meat
  // days/car days allowed per week) and show progress against it -
  // recomputed from the diet/commute data every render, so it can never
  // drift out of sync with what's actually logged. Banking has no tile at
  // all, just a savings nudge, since there's no streak/target concept for it.
  const HABIT_META = {
    meatFree: { emoji: "🥦", label: "Meat-free days" },
    carFree: { emoji: "🚲", label: "Car-free commuting" },
    noFlights: { emoji: "✈️", label: "Flight-free" },
  };
  // Real streak/habit apps mark round numbers as small wins - the exact
  // thresholds matter less than having *some* to celebrate. Kept short
  // (a year is the last one) since nothing above that is likely to ever
  // be hit in practice, and an unreachable milestone is just dead code.
  const STREAK_MILESTONES = [7, 30, 100, 365];

  // Display names for BANK_KG_PER_POUND_PER_YEAR's keys (emission-factors.js) -
  // mirrors the #bank-name <select> option labels in index.html.
  const BANK_LABELS = {
    barclays: "Barclays", hsbc: "HSBC", firstDirect: "First Direct", chase: "Chase",
    santander: "Santander", natwest: "NatWest", rbs: "RBS (Royal Bank of Scotland)",
    monzo: "Monzo", lloyds: "Lloyds", halifax: "Halifax", metroBank: "Metro Bank",
    starling: "Starling", virginMoney: "Virgin Money", nationwide: "Nationwide",
    cooperative: "The Co-operative Bank", triodos: "Triodos",
  };

  // How many of this week's confirmed diet days were meat days - the basis
  // for the "meat days used / weekly target" progress bar. Resets itself
  // every Monday for free, just by reading CURRENT_WEEK_KEY rather than
  // any stored counter.
  function mealsThisWeekMeatCount() {
    const weekData = weeksCache[CURRENT_WEEK_KEY];
    if (!weekData) return 0;
    return DAYS.reduce((n, day) => (
      weekData.confirmedDiet?.[day.key] && weekData.diet?.[day.key]?.type === "meat" ? n + 1 : n
    ), 0);
  }

  // Same idea for car commute days this week.
  function carDaysThisWeekCount() {
    const weekData = weeksCache[CURRENT_WEEK_KEY];
    if (!weekData) return 0;
    return DAYS.reduce((n, day) => (
      weekData.confirmedCommute?.[day.key] && weekData.commute?.[day.key] === "car" ? n + 1 : n
    ), 0);
  }

  // Average meat days/week and the most-eaten meat type over the last ~12
  // confirmed weeks - purely to personalize the Eating survey's insight
  // copy ("you eat meat about N days a week"), reusing data already logged
  // rather than asking the person to self-report it. Null when there's not
  // enough history yet, so the copy can fall back to something generic.
  function avgMeatDaysPerWeekRecent() {
    const cutoff = weekStart(new Date());
    cutoff.setDate(cutoff.getDate() - 12 * 7);
    const cutoffKey = dateKey(cutoff);
    const weeks = Object.keys(weeksCache)
      .filter((key) => key >= cutoffKey && isFullyConfirmed(weeksCache[key]))
      .map((key) => weeksCache[key]);
    if (weeks.length === 0) return null;
    const totalMeatDays = weeks.reduce((sum, wd) => sum + DAYS.filter((d) => wd.diet?.[d.key]?.type === "meat").length, 0);
    return totalMeatDays / weeks.length;
  }

  function mostCommonMeatType() {
    const counts = {};
    Object.values(weeksCache).forEach((wd) => {
      DAYS.forEach((d) => {
        const entry = wd.diet?.[d.key];
        if (wd.confirmedDiet?.[d.key] && entry?.type === "meat" && entry.meat) {
          counts[entry.meat] = (counts[entry.meat] || 0) + 1;
        }
      });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : null;
  }

  // Same "recent average" idea as avgMeatDaysPerWeekRecent(), for car days.
  function avgCarDaysPerWeekRecent() {
    const cutoff = weekStart(new Date());
    cutoff.setDate(cutoff.getDate() - 12 * 7);
    const cutoffKey = dateKey(cutoff);
    const weeks = Object.keys(weeksCache)
      .filter((key) => key >= cutoffKey && isFullyConfirmed(weeksCache[key]))
      .map((key) => weeksCache[key]);
    if (weeks.length === 0) return null;
    const totalCarDays = weeks.reduce((sum, wd) => sum + DAYS.filter((d) => wd.commute?.[d.key] === "car").length, 0);
    return totalCarDays / weeks.length;
  }

  // Yearly-equivalent size of each of the 4 survey domains, for ranking the
  // survey options ("Biggest impact" badge) - reuses the exact same
  // figures the Home page's "Your year, estimated" already shows, so it's
  // not a second formula that could drift out of sync.
  function computeHabitDomainSizes() {
    return {
      eating: recentAverageConfirmedWeekly("food") * 52,
      commuting: recentAverageConfirmedWeekly("commuteOnly") * 52,
      flying: computeFlyingYearlyKg(profile.flights),
      banking: profile.bankName && profile.bankBalance !== null && profile.bankBalance !== undefined
        ? (BANK_KG_PER_POUND_PER_YEAR[profile.bankName] || 0) * profile.bankBalance
        : 0,
    };
  }

  // Days since your last logged (dated) flight - or, if you've never
  // logged one, since the start of an active "no flights" challenge, so
  // starting one always gives a real streak to watch even with no flight
  // history at all. Deliberately NOT "whichever anchor is more recent":
  // flight history always wins when it exists, so starting a challenge
  // never resets an already-in-progress streak back to day 0 just because
  // "today" is more recent than your last flight. Returns null (shown as
  // a muted "–", same as any other not-yet-established figure in the
  // app) only when there's truly nothing to anchor to either way.
  function flightFreeStreakDays() {
    const dated = (profile.flights || [])
      .filter((f) => f.date)
      .map((f) => new Date(`${f.date}T00:00:00`).getTime());
    if (dated.length > 0) {
      return Math.max(0, Math.floor((Date.now() - Math.max(...dated)) / DAY_MS));
    }
    const challenge = (profile.habitChallenges || {}).noFlights;
    if (!challenge) return null;
    const challengeStart = new Date(`${challenge.startDate}T00:00:00`).getTime();
    return Math.max(0, Math.floor((Date.now() - challengeStart) / DAY_MS));
  }

  function startHabitChallenge(habitId, targetDays) {
    profile.habitChallenges = profile.habitChallenges || {};
    profile.habitChallenges[habitId] = { startDate: dateKey(new Date()), targetDays };
    persistProfile();
    renderHabitsCard();
  }

  function cancelHabitChallenge(habitId) {
    profile.habitChallenges = profile.habitChallenges || {};
    delete profile.habitChallenges[habitId];
    persistProfile();
    renderHabitsCard();
  }

  // Sets/replaces the weekly day-target for meatFree/carFree (the tailored
  // Eating/Commuting sub-flows) - a different shape from the streak-length
  // challenges above ({targetPerWeek} vs {targetDays}), since these are
  // capped-per-week goals, not consecutive-day ones. Re-picking a target
  // (from renderHabitsCard()'s tier picker) just overwrites it; there's
  // nothing to "give up" the way a streak challenge has, since the target
  // resets itself every week for free by reading the current week's data.
  function setWeeklyTarget(habitId, targetPerWeek) {
    profile.habitChallenges = profile.habitChallenges || {};
    profile.habitChallenges[habitId] = { startDate: dateKey(new Date()), targetPerWeek };
  }

  // Celebrates a streak crossing a round-number milestone exactly once per
  // device (localStorage, same "not meaningful enough to sync across
  // devices" reasoning as the onboarding banner's dismissal flag) -
  // checked on every render rather than only right after logging, so
  // e.g. reaching day 7 by simply not having flown is still noticed the
  // next time the Home page renders, not only on a specific user action.
  function checkStreakMilestone(habitId, streakDays) {
    if (streakDays === null || streakDays === undefined) return;
    const milestone = STREAK_MILESTONES.find((m) => m === streakDays);
    if (!milestone) return;
    const seenKey = `co2tracker_streak_seen_${habitId}_${milestone}`;
    try {
      if (localStorage.getItem(seenKey) === "1") return;
      localStorage.setItem(seenKey, "1");
    } catch (e) {
      return; // Private browsing / storage disabled - skip rather than re-show every render.
    }
    showStreakCongrats(habitId, milestone);
  }

  function showStreakCongrats(habitId, streakDays) {
    const habit = HABIT_META[habitId];
    document.getElementById("habit-streak-congrats-value").textContent = streakDays.toLocaleString();
    document.getElementById("habit-streak-congrats-label").textContent = `day streak · ${habit.label}`;
    document.getElementById("habit-streak-congrats-backdrop").classList.add("open");
  }

  // In-memory only (not persisted, not synced) - purely "is the survey/tier
  // picker open right now", reset every time the Leaderboard tab is
  // (re-)entered, same as any other transient UI state in this app.
  let habitSurveyOpen = false;
  let habitSurveyStep = null; // null | "eating" | "commuting" - which tier picker (if any) is showing

  const HABIT_SURVEY_OPTIONS = [
    { key: "eating", emoji: "🍽️", label: "Eating" },
    { key: "commuting", emoji: "🚗", label: "Commuting" },
    { key: "flying", emoji: "✈️", label: "Flying" },
    { key: "banking", emoji: "🏦", label: "Banking" },
  ];

  function openHabitSurvey() {
    habitSurveyOpen = true;
    habitSurveyStep = null;
    renderHabitsCard();
  }

  function reopenHabitSurvey() {
    profile.chosenHabit = null;
    habitSurveyOpen = true;
    habitSurveyStep = null;
    persistProfile();
    renderHabitsCard();
  }

  // Eating/Commuting need one more question (a weekly target) before
  // they're "chosen" - Flying and Banking finalize immediately instead.
  function openHabitTierPicker(domain) {
    habitSurveyStep = domain;
    renderHabitsCard();
  }

  function chooseHabitDomain(key) {
    profile.chosenHabit = key;
    habitSurveyOpen = false;
    habitSurveyStep = null;
    persistProfile();
    renderHabitsCard();
  }

  const TIER_HABIT_ID = { eating: "meatFree", commuting: "carFree" };

  function chooseWeeklyTarget(domain, targetPerWeek) {
    setWeeklyTarget(TIER_HABIT_ID[domain], targetPerWeek);
    profile.chosenHabit = domain;
    habitSurveyOpen = false;
    habitSurveyStep = null;
    persistProfile();
    renderHabitsCard();
  }

  // Builds the small progress-bar block shared by the meatFree/carFree
  // weekly-target tiles - "N of target used this week", switching to an
  // over-target caption once the count exceeds it. A target of 0 (the
  // car-free tier) is handled as its own wording rather than "0 of 0".
  function weeklyTargetProgressHtml(used, target, dayNoun) {
    const pct = target > 0 ? Math.min(100, (used / target) * 100) : (used > 0 ? 100 : 0);
    const over = used > target;
    let caption;
    if (target === 0) {
      caption = used === 0 ? `${dayNoun}-free so far this week! 🎉` : `${used} ${dayNoun} day${used === 1 ? "" : "s"} so far — target was ${dayNoun}-free`;
    } else if (over) {
      caption = `${used} ${dayNoun} days so far — over your ${target}-day target`;
    } else {
      caption = `${used} of ${target} ${dayNoun} days used this week`;
    }
    return `
      <div class="habit-challenge">
        <div class="habit-challenge-bar-track">
          <div class="habit-challenge-bar-fill${over ? " over-target" : ""}" style="width:${pct}%"></div>
        </div>
        <p class="habit-challenge-caption">${caption}</p>
      </div>
    `;
  }

  function renderHabitsCard() {
    const grid = document.getElementById("habits-grid");
    if (!grid) return;

    // Self-heal: a chosenHabit of "eating"/"commuting" with no matching
    // weekly-target challenge (e.g. old data from before this shape
    // existed) falls back to the tier picker instead of rendering a
    // broken tile.
    if (profile.chosenHabit === "eating" && profile.habitChallenges?.meatFree?.targetPerWeek === undefined) {
      profile.chosenHabit = null;
      habitSurveyOpen = true;
      habitSurveyStep = "eating";
    }
    if (profile.chosenHabit === "commuting" && profile.habitChallenges?.carFree?.targetPerWeek === undefined) {
      profile.chosenHabit = null;
      habitSurveyOpen = true;
      habitSurveyStep = "commuting";
    }

    const leaderboardVisible = document.getElementById("view-leaderboard")?.hidden === false;

    if (!profile.chosenHabit && !habitSurveyOpen) {
      grid.innerHTML = `<button type="button" class="habit-prompt-btn" id="habit-prompt-btn">Would you like to change your habits?</button>`;
      return;
    }

    if (!profile.chosenHabit && habitSurveyOpen) {
      if (habitSurveyStep === "eating") {
        const avg = avgMeatDaysPerWeekRecent();
        const common = mostCommonMeatType();
        const insight = avg === null
          ? "Pick a weekly target for how many days you eat meat:"
          : `Based on your recent weeks, you eat meat about ${Math.round(avg * 10) / 10} day${avg === 1 ? "" : "s"} a week${common ? `, mostly ${(MEAT_LABELS[common] ?? "meat").toLowerCase()}` : ""}. Pick a weekly target:`;
        grid.innerHTML = `
          <div class="habit-survey">
            <button type="button" class="link-btn habit-survey-back-btn">&#8592; Back</button>
            <p class="habit-survey-question">${insight}</p>
            <div class="habit-tier-options">
              ${[5, 4, 3, 2].map((n) => `<button type="button" class="habit-tier-btn" data-domain="eating" data-target="${n}">Max ${n} days/week</button>`).join("")}
            </div>
          </div>
        `;
        return;
      }
      if (habitSurveyStep === "commuting") {
        const avg = avgCarDaysPerWeekRecent();
        const insight = avg === null
          ? "Pick a weekly target for how many days you drive:"
          : `Based on your recent weeks, you drive about ${Math.round(avg * 10) / 10} day${avg === 1 ? "" : "s"} a week. Pick a weekly target:`;
        grid.innerHTML = `
          <div class="habit-survey">
            <button type="button" class="link-btn habit-survey-back-btn">&#8592; Back</button>
            <p class="habit-survey-question">${insight}</p>
            <div class="habit-tier-options">
              ${[0, 1, 2, 3, 4].map((n) => `<button type="button" class="habit-tier-btn" data-domain="commuting" data-target="${n}">${n === 0 ? "Car-free week" : `Max ${n} day${n === 1 ? "" : "s"} of car`}</button>`).join("")}
            </div>
          </div>
        `;
        return;
      }
      const sizes = computeHabitDomainSizes();
      const options = HABIT_SURVEY_OPTIONS.slice().sort((a, b) => sizes[b.key] - sizes[a.key]);
      const biggestKey = sizes[options[0]?.key] > 0 ? options[0].key : null;
      grid.innerHTML = `
        <div class="habit-survey">
          <p class="habit-survey-question">What habit would you like to change?</p>
          <div class="habit-survey-options">
            ${options.map((opt) => `
              <button type="button" class="habit-survey-option" data-habit-choice="${opt.key}">
                <span class="habit-survey-emoji" aria-hidden="true">${opt.emoji}</span>
                <span class="habit-survey-label">${opt.label}</span>
                ${opt.key === biggestKey ? '<span class="habit-survey-badge">Biggest impact</span>' : ""}
              </button>
            `).join("")}
          </div>
        </div>
      `;
      return;
    }

    if (profile.chosenHabit === "banking") {
      const hasBankData = profile.bankName && profile.bankBalance !== null && profile.bankBalance !== undefined;
      let bodyHtml;
      if (!hasBankData) {
        bodyHtml = `
          <p class="habit-nudge-text">Add your bank details to see how much switching could save the planet.</p>
          <button type="button" class="btn-secondary btn-small" id="habit-banking-fill-btn">Add your bank</button>
        `;
      } else {
        const factor = BANK_KG_PER_POUND_PER_YEAR[profile.bankName] || 0;
        const currentYearlyKg = factor * profile.bankBalance;
        const [bestId, bestFactor] = Object.entries(BANK_KG_PER_POUND_PER_YEAR)
          .filter(([id]) => id !== profile.bankName)
          .sort((a, b) => a[1] - b[1])[0];
        const savingsKg = Math.max(0, currentYearlyKg - bestFactor * profile.bankBalance);
        bodyHtml = savingsKg > 0
          ? `
            <p class="habit-nudge-text">Switching from ${BANK_LABELS[profile.bankName]} to ${BANK_LABELS[bestId]} could save about <strong>${Math.round(savingsKg).toLocaleString()} kg CO2e</strong> a year.</p>
            <button type="button" class="btn-primary btn-small" id="habit-banking-switch-btn">Do you want to save the planet?</button>
          `
          : `<p class="habit-nudge-text">${BANK_LABELS[profile.bankName]} is already one of the greener options on our list — nice.</p>`;
      }
      grid.innerHTML = `
        <div class="habit-tile">
          <div class="habit-tile-head">
            <span class="habit-emoji" aria-hidden="true">🏦</span>
            <span class="habit-label">Banking</span>
          </div>
          ${bodyHtml}
          <button type="button" class="link-btn habit-change-btn">Change habit</button>
        </div>
      `;
      return;
    }

    if (profile.chosenHabit === "eating" || profile.chosenHabit === "commuting") {
      const isEating = profile.chosenHabit === "eating";
      const habitId = isEating ? "meatFree" : "carFree";
      const meta = HABIT_META[habitId];
      const challenge = profile.habitChallenges[habitId];
      const used = isEating ? mealsThisWeekMeatCount() : carDaysThisWeekCount();
      grid.innerHTML = `
        <div class="habit-tile">
          <div class="habit-tile-head">
            <span class="habit-emoji" aria-hidden="true">${meta.emoji}</span>
            <span class="habit-label">${meta.label}</span>
          </div>
          ${weeklyTargetProgressHtml(used, challenge.targetPerWeek, isEating ? "meat" : "car")}
          <button type="button" class="link-btn habit-change-btn">Change habit</button>
        </div>
      `;
      return;
    }

    // profile.chosenHabit === "flying" - the one habit that kept the
    // original streak/challenge model, since the survey didn't ask for
    // anything tailored here.
    const streak = flightFreeStreakDays();
    const challenge = (profile.habitChallenges || {}).noFlights;
    const streakHtml = streak === null
      ? `<span class="stat-value habit-empty-streak">–</span>`
      : `<span class="habit-streak-value">${streak.toLocaleString()}</span><span class="habit-streak-unit">${streak === 1 ? "day" : "days"}</span>`;

    let challengeHtml;
    if (challenge) {
      const daysIn = Math.min(streak ?? 0, challenge.targetDays);
      const pct = Math.min(100, (daysIn / challenge.targetDays) * 100);
      const done = daysIn >= challenge.targetDays;
      challengeHtml = `
        <div class="habit-challenge">
          <div class="habit-challenge-bar-track">
            <div class="habit-challenge-bar-fill" style="width:${pct}%"></div>
          </div>
          <p class="habit-challenge-caption">${done ? "Challenge complete! 🎉" : `Day ${daysIn} of ${challenge.targetDays}-day challenge`}</p>
          <button type="button" class="link-btn habit-cancel-btn" data-habit="noFlights">${done ? "Clear" : "Give up"}</button>
        </div>
      `;
    } else {
      challengeHtml = `
        <div class="habit-challenge">
          <p class="habit-challenge-caption">Start a challenge:</p>
          <div class="habit-challenge-presets">
            <button type="button" class="btn-secondary btn-small habit-start-btn" data-habit="noFlights" data-days="7">7d</button>
            <button type="button" class="btn-secondary btn-small habit-start-btn" data-habit="noFlights" data-days="30">30d</button>
            <button type="button" class="btn-secondary btn-small habit-start-btn" data-habit="noFlights" data-days="90">90d</button>
          </div>
        </div>
      `;
    }

    grid.innerHTML = `
      <div class="habit-tile">
        <div class="habit-tile-head">
          <span class="habit-emoji" aria-hidden="true">✈️</span>
          <span class="habit-label">Flight-free</span>
        </div>
        ${streakHtml}
        ${challengeHtml}
        <button type="button" class="link-btn habit-change-btn">Change habit</button>
      </div>
    `;

    // renderHabitsCard() runs from many mutation points regardless of which
    // tab is currently on screen - only pop the celebration modal when the
    // Leaderboard tab (where the Habits card lives) is actually visible
    // right now, so crossing a milestone from an unrelated action on a
    // different page doesn't ambush you with a full-screen modal.
    if (leaderboardVisible) checkStreakMilestone("noFlights", streak);
  }

  // Apple-Watch-style ring for a single "Your year, estimated" tile:
  // starts as a full green ring (100% of your UK-average "budget" for that
  // domain still unused), and drains anticlockwise from 12 o'clock as your
  // own total eats into it - top-left goes first (75% remaining), then
  // bottom-left (50%), then bottom-right (25%, leaving only the top-right
  // quarter), empty at exactly the UK average ("no budget left"). Past
  // that, it switches to a red ring that fills back up the same
  // anticlockwise way starting from empty (top-left first) to show how far
  // over you are, capped visually at a full red ring for 2x the average or
  // worse. See .ring-progress-green/.ring-progress-red in style.css for
  // the two different CSS transforms this needs - green's "missing" edge
  // and red's "filling" edge sweep the same visual direction, but starting
  // from opposite states (full vs empty), so they need mirrored dashoffset
  // rotations to both read as anticlockwise. Falls back to the plain muted
  // "–" tile (same markup/classes as every other unanswered optional tile)
  // when there's nothing to compare yet, so an unanswered question never
  // gets a misleadingly "full" ring.
  // "Your X, estimated" is period-aware (week/month/year - see
  // yearlyStatsPeriod/renderStatsPage() below): every figure on the card
  // is computed as a TRUE yearly total first, then scaled by one of these
  // factors purely for display. Every comparison on the card (rings,
  // UK percentile, "Compared to:" chips) is ratio-based (value/benchmark),
  // so scaling both sides by the same factor leaves every ratio - and
  // therefore every color/fraction/percentage shown - identical across
  // all three periods; only the raw numbers and their unit labels change.
  const YEARLY_PERIOD_SCALE = { week: 1 / 52, month: 1 / 12, year: 1 };
  const YEARLY_PERIOD_HEADING = { week: "Your week, estimated", month: "Your month, estimated", year: "Your year, estimated" };
  const YEARLY_PERIOD_NOUN = { week: "week", month: "month", year: "year" };
  // long: the "kg CO2e/yr"-style unit used next to the hero total/alcohol
  // tile and in each ring's empty-state label; short: the compact "kg/yr"
  // used inside a ring's center; per: the "per year" phrase in each ring's
  // aria-label sentence.
  const YEARLY_PERIOD_UNITS = {
    week: { long: "kg CO2e/wk", short: "kg/wk", per: "per week" },
    month: { long: "kg CO2e/mo", short: "kg/mo", per: "per month" },
    year: { long: "kg CO2e/yr", short: "kg/yr", per: "per year" },
  };

  // Apple-Watch-style ring for a single "Your year, estimated" tile:
  // starts as a full green ring (100% of your UK-average "budget" for that
  // domain still unused), and drains anticlockwise from 12 o'clock as your
  // own total eats into it - top-left goes first (75% remaining), then
  // bottom-left (50%), then bottom-right (25%, leaving only the top-right
  // quarter), empty at exactly the UK average ("no budget left"). Past
  // that, it switches to a red ring that fills back up the same
  // anticlockwise way starting from empty (top-left first) to show how far
  // over you are, capped visually at a full red ring for 2x the average or
  // worse. See .ring-progress-green/.ring-progress-red in style.css for
  // the two different CSS transforms this needs - green's "missing" edge
  // and red's "filling" edge sweep the same visual direction, but starting
  // from opposite states (full vs empty), so they need mirrored dashoffset
  // rotations to both read as anticlockwise. Falls back to the plain muted
  // "–" tile (same markup/classes as every other unanswered optional tile)
  // when there's nothing to compare yet, so an unanswered question never
  // gets a misleadingly "full" ring. `units` (a YEARLY_PERIOD_UNITS entry)
  // controls the tile's own labels - defaults to the yearly one so any
  // future caller outside the period-aware "Your X, estimated" card still
  // works unchanged.
  const RING_RADIUS = 42;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  function renderRingStat(containerId, value, benchmark, label, units = YEARLY_PERIOD_UNITS.year) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (value === null || value === undefined || benchmark === null || benchmark === undefined || benchmark <= 0) {
      el.className = "ring-container ring-container-empty";
      el.innerHTML = `
        <span class="stat-value">–</span>
        <span class="stat-label">${units.long} &middot; ${label}</span>
        <span class="week-diff"><span class="diff-value">–</span><span class="diff-caption">vs UK average</span></span>
      `;
      return;
    }
    const ratio = value / benchmark;
    const over = ratio > 1;
    const fraction = over ? Math.min(ratio - 1, 1) : 1 - ratio;
    const offset = RING_CIRCUMFERENCE * (1 - fraction);
    el.className = "ring-container";
    el.innerHTML = `
      <div class="ring-wrap">
        <svg viewBox="0 0 100 100" class="ring-svg" role="img" aria-label="${label}: ${fmt(value)} kg CO2e ${units.per}, ${Math.round(ratio * 100)}% of the UK average">
          <circle class="ring-track" cx="50" cy="50" r="${RING_RADIUS}"></circle>
          <circle class="ring-progress ${over ? "ring-progress-red" : "ring-progress-green"}" cx="50" cy="50" r="${RING_RADIUS}"
            stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${offset}"></circle>
        </svg>
        <div class="ring-center">
          <span class="ring-center-value">${Math.round(value).toLocaleString()}</span>
          <span class="ring-center-unit">${units.short}</span>
        </div>
      </div>
      <p class="ring-caption">${label}</p>
      <p class="ring-pct-caption ${over ? "ring-pct-over" : "ring-pct-under"}">${Math.round(ratio * 100)}% of UK avg</p>
    `;
  }

  // "Your X, estimated" card's own timeframe - independent of the Budget
  // pace chart's homeChartPeriod above, since the two cards can reasonably
  // be looked at on different timeframes at once.
  let yearlyStatsPeriod = "year";
  function renderStatsPage(period = yearlyStatsPeriod) {
    yearlyStatsPeriod = period;
    document.querySelectorAll(".yearly-period-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.period === period);
    });
    const scale = YEARLY_PERIOD_SCALE[period];
    const units = YEARLY_PERIOD_UNITS[period];
    // Scales an already-computed TRUE yearly figure for display - null
    // passes through untouched so "unanswered" tiles stay unanswered at
    // every period, not silently become "0".
    const s = (v) => (v === null || v === undefined ? v : v * scale);

    document.getElementById("yearly-heading").textContent = YEARLY_PERIOD_HEADING[period];
    document.getElementById("yearly-hero-unit-label").textContent = `📊 ${units.long} · Estimated total`;
    document.getElementById("yearly-alcohol-unit-label").textContent = `${units.long} · Alcohol`;

    // Every figure below is computed as a TRUE yearly total first (the
    // last 52 weeks' confirmed average, ×52, for the day-tracked domains;
    // already-yearly for the annual-estimate ones) - flyingYearlyKg in
    // particular gets persisted to the profile as-is regardless of which
    // period is showing, since it's real state other features depend on,
    // not a display value. Every figure is then scaled via s() just
    // before rendering - see YEARLY_PERIOD_SCALE's own comment for why
    // that's safe to do this late, after every ratio-based comparison
    // below has already been computed against matching true-yearly values.
    const yearlyFood = recentAverageConfirmedWeekly("food") * 52;
    const yearlyCommute = recentAverageConfirmedWeekly("commuteOnly") * 52;
    const yearlyNonCommuteCar = recentAverageConfirmedWeekly("nonCommuteCar") * 52;
    const yearlyAlcohol = recentAverageConfirmedWeekly("alcohol") * 52;

    const yearlyFlying = computeFlyingYearlyKg(profile.flights);
    profile.flyingYearlyKg = yearlyFlying;

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
    const includeOptional = includeOptionalForProfile(profile);
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

    // Alcohol has no equivalent in the UK-average model to begin with, so
    // it's the one tile that stays a plain number, no ring possible.
    document.getElementById("yearly-alcohol").textContent = Math.round(s(yearlyAlcohol)).toLocaleString();
    document.getElementById("yearly-total").textContent = Math.round(s(yearlyTotal)).toLocaleString();

    const uk = computeUkAverageBreakdown(includeOptional);

    // Every other tile: an Apple-Watch-style ring instead of a plain
    // number - falls back to the usual muted "–" tile on its own whenever
    // value or benchmark is null (see renderRingStat() above).
    renderRingStat("yearly-food", s(yearlyFood), s(uk.food), "Food", units);
    renderRingStat("yearly-commute", s(yearlyCommute), s(uk.commute), "Commute", units);
    renderRingStat("yearly-noncommute-car", s(yearlyNonCommuteCar), s(uk.nonCommuteCar), "Non-commute driving", units);
    renderRingStat("yearly-home-energy", s(yearlyHomeEnergy), s(uk.homeEnergy), "Home energy (your share)", units);
    renderRingStat("yearly-gas-heating", s(yearlyGasHeating), s(uk.gasHeating), "Gas/oil heating", units);
    renderRingStat("yearly-water", s(yearlyWater), s(uk.water), "Water usage", units);
    renderRingStat("yearly-pets", s(yearlyPets), s(uk.pets), "Pets", units);
    renderRingStat("yearly-flying", s(yearlyFlying), s(uk.flying), "Flying", units);
    renderRingStat("yearly-banking", s(yearlyBanks), s(uk.banks), "Banking", units);
    renderRingStat("yearly-goods", s(yearlyGoods), s(uk.goods), "Buying goods", units);
    renderRingStat("yearly-car-ownership", s(yearlyCarOwnership), s(uk.carOwnership), "Car manufacturing", units);

    // Ratio-based (see ukPercentileBetterThan()), so unaffected by scale -
    // computed against the true yearly figures directly, no s() needed.
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

    renderYearComparison(s(yearlyTotal), s(uk.total), period);
    renderYearCompareChips(s(yearlyTotal), s(uk.total), scale);
    renderSavingsTotaliser();
    renderPeriodChart();
    renderHomeTodoList();
    renderOnboardingBanner();
    renderHabitsCard();
    renderHomeSnapshot();
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
  // explains why it can't yet). `yearlyTotal`/`ukAverageYearlyKg` here are
  // already display-scaled (see renderStatsPage()'s s()) - `scale` is
  // passed through just to bring the two fixed yearly constants
  // (PARIS_1_5C_YEARLY_KG/WORLD_AVERAGE_YEARLY_KG) down to the same
  // timeframe before comparing.
  function renderYearCompareChips(yearlyTotal, ukAverageYearlyKg, scale) {
    setCompareChip("compare-chip-15c", "compare-chip-15c-label", "compare-hero-15c", yearlyTotal, PARIS_1_5C_YEARLY_KG * scale, "1.5°C target");
    setCompareChip("compare-chip-uk", "compare-chip-uk-label", "compare-hero-uk", yearlyTotal, ukAverageYearlyKg, "UK average");
    setCompareChip("compare-chip-world", "compare-chip-world-label", "compare-hero-world", yearlyTotal, WORLD_AVERAGE_YEARLY_KG * scale, "World average");
    renderUniCompareChip(yearlyTotal, scale);
  }

  const UNIVERSITY_MIN_PEOPLE = 3;

  async function renderUniCompareChip(yearlyTotal, scale) {
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
    setCompareChip("compare-chip-uni", "compare-chip-uni-label", "compare-hero-uni", yearlyTotal, row.avg_total_kg * 52 * scale, `${profile.university} average`);
  }

  // A lightweight nudge, not a data-completeness tracker: yesterday/today's
  // commute and meal are done once that day's actually confirmed (works
  // whether "yesterday" falls in this week's or last week's data).
  // Electricity is "done" once a bill's been submitted AND it's still
  // fresh (see electricityBillIsFresh()) - a stale bill (see
  // ELECTRICITY_BILL_STALE_DAYS) drops back to "not done" so this nudge
  // doubles as the "if it's been a while, reapply" reminder. Flights is
  // "done" once at least one has ever been logged, regardless of whether
  // older ones have since aged out of the current yearly total (see
  // FLIGHT_STALE_DAYS) - unlike electricity, there's no single "answer"
  // that can go stale here, just an ongoing log.
  // Each item drops off the list entirely once it's done, rather than
  // sitting there checked off - once everything's done, the list itself
  // is replaced with a single "All done" message.
  // Shared by renderHomeTodoList() (which items to show) and
  // renderOnboardingBanner() (whether *nothing* has been logged yet).
  function todoItemsStatus() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStatus = dayConfirmStatus(today);
    const yesterdayStatus = dayConfirmStatus(yesterday);

    return [
      ["todo-yesterday-commute", yesterdayStatus.commuteDone],
      ["todo-yesterday-meal", yesterdayStatus.dietDone],
      ["todo-today-commute", todayStatus.commuteDone],
      ["todo-today-meal", todayStatus.dietDone],
      ["todo-electricity", !!profile.householdKwhPerMonth && electricityBillIsFresh()],
      ["todo-flights", (profile.flights || []).length > 0],
    ];
  }

  function renderHomeTodoList() {
    const items = todoItemsStatus();

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

  const ONBOARDING_DISMISSED_KEY = "co2tracker_onboarding_dismissed";

  // A short "start here" welcome, shown only while every To Do item is
  // still outstanding (i.e. nothing at all has been logged yet) - once a
  // single thing is logged the app already has real content to show, so
  // the normal Home page carries its own weight. Dismissible and
  // remembered per-device via localStorage, independent of account sync
  // (skipping it once shouldn't require a network round-trip, and it's not
  // meaningful data worth syncing across devices).
  // ---------- Home page snapshot card (logo + weekly goal + day-logged row) ----------
  // A compact "at a glance" card at the very top of Home: the old
  // three-circle brand mark (superseded on the header by the current C/O2
  // one, but reused here purely as a decorative icon), a weekly-goal
  // progress bar - hidden entirely until at least one day this week is
  // actually confirmed, so a blank week never shows a misleading "0%
  // used" - and a Mon-Sun row of filled/empty squares for which days have
  // any confirmed commute or diet entry, so a week's shape is visible at
  // a glance without opening This Week.
  function renderHomeSnapshot() {
    const weekData = getWeek(CURRENT_WEEK_KEY);
    const started = hasAnyConfirmed(weekData);
    const goalEl = document.getElementById("home-snapshot-goal");
    if (started) {
      const totals = weekTotals(weekData);
      const goal = goalForWeek(CURRENT_WEEK_KEY);
      const pct = goal > 0 ? Math.round((totals.total / goal) * 100) : 0;
      const status = statusClass(totals.total, started, goal); // "status-good"/"status-warn"/"status-high"
      const fill = document.getElementById("home-snapshot-goal-fill");
      fill.style.width = `${Math.min(100, pct)}%`;
      fill.classList.remove("status-warn", "status-high");
      if (status === "status-warn" || status === "status-high") fill.classList.add(status);
      document.getElementById("home-snapshot-goal-caption").textContent = `${pct}% of your weekly goal used so far`;
      goalEl.hidden = false;
    } else {
      goalEl.hidden = true;
    }

    const todayKey = todayDayKey();
    document.getElementById("home-snapshot-days").innerHTML = DAYS.map((day) => {
      const logged = !!(weekData.confirmedCommute[day.key] || weekData.confirmedDiet[day.key]);
      const isToday = day.key === todayKey;
      return `
        <div class="home-snapshot-day${logged ? " logged" : ""}${isToday ? " is-today" : ""}">
          <span class="home-snapshot-day-square" aria-hidden="true"></span>
          <span class="home-snapshot-day-label">${day.short}</span>
        </div>
      `;
    }).join("");
  }

  function renderOnboardingBanner() {
    const banner = document.getElementById("home-onboarding-banner");
    if (!banner) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    } catch (e) {
      // Private browsing / storage disabled - just don't persist the choice.
    }
    const nothingLoggedYet = todoItemsStatus().every(([, done]) => !done);
    banner.hidden = dismissed || !nothingLoggedYet;
  }

  function dismissOnboardingBanner() {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch (e) {
      // Ignore - worst case the banner reappears next load.
    }
    const banner = document.getElementById("home-onboarding-banner");
    if (banner) banner.hidden = true;
  }

  // Feather-style "globe" glyph (circle + equator + a lens-shaped meridian)
  // reused both full-size in the Earth-laps ring below and tiny/repeated
  // nowhere else - trees get their own filled silhouette instead, since a
  // stroke-only outline disappears at the small repeated size those need.
  const GLOBE_ICON_PATH = '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
  // A simple two-tier fir tree + trunk, filled rather than outlined (a
  // thin stroke reads poorly at the ~16px this renders at, repeated many
  // times over in renderTreeIcons() below).
  const TREE_ICON_PATH = '<path d="M12 2 6.5 10h3L5 16h4.2L6 21h12l-3.2-5H19l-4.5-6h3z"/><rect x="11" y="20" width="2" height="2"/>';

  // "Times around the Earth" visual for the car-km comparison - a small
  // ring (same track+progress-arc technique as renderRingStat()'s domain
  // rings) rather than one globe icon per lap: a whole Earth circumference
  // (40,075 km) dwarfs even a full year's car-km-equivalent for most
  // people, so a repeated-icon count would almost always show zero or one
  // icon and read as broken. A ring instead always shows a proportional
  // sliver of progress no matter how small the fraction, the same way the
  // domain rings above stay legible at any ratio - fill caps visually at
  // one full lap (mirroring those rings' own "cap visually, exact number
  // in text" treatment for over-100% ratios), with the precise lap count
  // always spelled out in the caption underneath regardless of how full
  // the ring itself looks.
  const EARTH_RING_RADIUS = 22;
  const EARTH_RING_CIRCUMFERENCE = 2 * Math.PI * EARTH_RING_RADIUS;
  function renderEarthLapsRing(containerId, captionId, carKm) {
    const el = document.getElementById(containerId);
    const captionEl = document.getElementById(captionId);
    if (!el) return;
    const laps = carKm / EARTH_CIRCUMFERENCE_KM;
    if (!(laps > 0)) {
      el.innerHTML = "";
      if (captionEl) captionEl.textContent = "";
      return;
    }
    const fraction = Math.min(laps, 1);
    const offset = EARTH_RING_CIRCUMFERENCE * (1 - fraction);
    // A whole Earth circumference dwarfs a week's (sometimes even a
    // year's) car-km-equivalent, so this can easily land under 0.05 -
    // fmt()'s usual one decimal place would round that to a meaningless
    // "0.0". Two decimals below that threshold keeps small-but-real
    // fractions visible without cluttering the common case.
    const lapsText = laps < 0.1 ? laps.toFixed(2) : fmt(laps);
    el.innerHTML = `
      <svg viewBox="0 0 56 56" class="earth-ring-svg" role="img" aria-label="${lapsText} times around the Earth">
        <circle class="earth-ring-track" cx="28" cy="28" r="${EARTH_RING_RADIUS}"></circle>
        <circle class="earth-ring-progress" cx="28" cy="28" r="${EARTH_RING_RADIUS}"
          stroke-dasharray="${EARTH_RING_CIRCUMFERENCE}" stroke-dashoffset="${offset}"></circle>
        <svg x="16" y="16" width="24" height="24" viewBox="0 0 24 24" class="earth-ring-globe" aria-hidden="true">${GLOBE_ICON_PATH}</svg>
      </svg>
    `;
    if (captionEl) captionEl.textContent = `≈ ${lapsText}× around the Earth (${EARTH_CIRCUMFERENCE_KM.toLocaleString()} km)`;
  }

  // Tree-equivalent visual for the trees comparison - unlike car laps
  // above, tree counts are naturally large (often dozens to low
  // hundreds), so a repeated-icon row works well here: one tiny tree per
  // whole tree, every one of them always shown (never capped with a "+N
  // more" chip - the whole point is a true visual sense of the count).
  // What changes instead is the icon's own size: it starts at
  // TREE_ICON_MAX for a small count, then shrinks - down to TREE_ICON_MIN
  // - by however much is needed to keep the whole grid within
  // TREE_BOX_HEIGHT once it wraps across TREE_BOX_WIDTH, so ten trees and
  // a thousand trees both read as "the box's worth of trees", just at a
  // different density, rather than the box growing without limit. If even
  // TREE_ICON_MIN can't fit every icon within that height, the box is
  // simply allowed to grow taller - showing the true count always wins
  // over hitting the height target.
  const TREE_ICON_MAX = 16;
  const TREE_ICON_MIN = 3;
  const TREE_ICON_GAP = 2;
  const TREE_BOX_WIDTH = 128; // matches .comparison-visual's max-width
  const TREE_BOX_HEIGHT = 100;
  function renderTreeIcons(containerId, treeCount) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const whole = Math.round(treeCount);
    if (whole <= 0) { el.innerHTML = ""; return; }

    let size = TREE_ICON_MAX;
    for (; size > TREE_ICON_MIN; size--) {
      const perRow = Math.max(1, Math.floor((TREE_BOX_WIDTH + TREE_ICON_GAP) / (size + TREE_ICON_GAP)));
      const rows = Math.ceil(whole / perRow);
      if (rows * (size + TREE_ICON_GAP) <= TREE_BOX_HEIGHT) break;
    }
    el.style.gap = `${TREE_ICON_GAP}px`;

    let html = "";
    for (let i = 0; i < whole; i++) {
      html += `<svg class="comparison-tree-icon" style="width:${size}px;height:${size}px" viewBox="0 0 24 24" aria-hidden="true">${TREE_ICON_PATH}</svg>`;
    }
    el.innerHTML = html;
  }

  function renderYearComparison(yearlyTotal, ukAverageYearlyKg, period) {
    const yourCarKm = yearlyTotal / TRANSPORT_FACTORS.car;
    const ukCarKm = ukAverageYearlyKg / TRANSPORT_FACTORS.car;
    const yourTrees = yearlyTotal / TREE_KG_PER_YEAR;
    const ukTrees = ukAverageYearlyKg / TREE_KG_PER_YEAR;
    const periodNoun = YEARLY_PERIOD_NOUN[period];

    document.getElementById("compare-car-km").textContent = Math.round(yourCarKm).toLocaleString();
    document.getElementById("compare-trees").textContent = Math.round(yourTrees).toLocaleString();
    document.getElementById("compare-car-km-label").textContent = "km driven by an average car";
    document.getElementById("compare-trees-label").textContent = `mature trees' worth of your estimated ${periodNoun}'s CO2 absorption`;

    setComparisonDiff("compare-car-km-diff", yourCarKm, ukCarKm, "km");
    setComparisonDiff("compare-trees-diff", yourTrees, ukTrees, "trees");

    renderEarthLapsRing("compare-car-icons", "compare-car-laps-caption", yourCarKm);
    renderTreeIcons("compare-trees-icons", yourTrees);
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

  // ---------- Daily reminder (native local notification) ----------
  // A single repeating local notification, scheduled entirely on-device
  // via @capacitor/local-notifications - no server component, no push
  // certificates, and it never carries any of the user's data, just a
  // generic nudge. Deliberately device-local rather than synced through
  // Supabase: it's the OS on THIS device that fires it, so a preference
  // synced from another device wouldn't mean anything here anyway - same
  // "not meaningful enough to sync" reasoning as the onboarding banner's
  // dismissal flag and the streak-milestone-seen flags.
  const REMINDER_NOTIFICATION_ID = 1;
  const REMINDER_ENABLED_KEY = "co2tracker_reminder_enabled";
  const REMINDER_TIME_KEY = "co2tracker_reminder_time";
  const REMINDER_DEFAULT_TIME = "19:00";

  function isNativePlatform() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function localNotificationsPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  }

  function getReminderPrefs() {
    let enabled = false;
    let time = REMINDER_DEFAULT_TIME;
    try {
      enabled = localStorage.getItem(REMINDER_ENABLED_KEY) === "1";
      time = localStorage.getItem(REMINDER_TIME_KEY) || REMINDER_DEFAULT_TIME;
    } catch (e) {
      // Private browsing / storage disabled - fall back to "off", same as a first run.
    }
    return { enabled, time };
  }

  function setReminderPrefs(enabled, time) {
    try {
      localStorage.setItem(REMINDER_ENABLED_KEY, enabled ? "1" : "0");
      localStorage.setItem(REMINDER_TIME_KEY, time);
    } catch (e) {
      // Ignore - worst case the toggle doesn't persist across app restarts.
    }
  }

  async function scheduleReminder(time) {
    const plugin = localNotificationsPlugin();
    if (!plugin) return;
    const [hour, minute] = time.split(":").map((n) => parseInt(n, 10));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
    await plugin.schedule({
      notifications: [{
        id: REMINDER_NOTIFICATION_ID,
        title: "CO2 Tracker",
        body: "Don't forget to log today's commute and meals.",
        schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true },
      }],
    });
  }

  async function cancelReminder() {
    const plugin = localNotificationsPlugin();
    if (!plugin) return;
    await plugin.cancel({ notifications: [{ id: REMINDER_NOTIFICATION_ID }] });
  }

  // Re-applies whatever's already saved (if enabled) every time the app is
  // opened and signed in, so an already-granted reminder survives an app
  // update without the user needing to re-toggle it - scheduling with the
  // same fixed id is idempotent (replaces, doesn't duplicate), so calling
  // this on every launch is harmless.
  async function applyReminderFromPrefs() {
    if (!isNativePlatform()) return;
    const { enabled, time } = getReminderPrefs();
    if (enabled) await scheduleReminder(time);
  }

  function renderReminderCard() {
    const enabledInput = document.getElementById("reminder-enabled");
    if (!enabledInput) return;
    const timeInput = document.getElementById("reminder-time");
    const nativeNote = document.getElementById("reminder-native-note");
    const native = isNativePlatform();

    if (nativeNote) nativeNote.hidden = native;
    enabledInput.disabled = !native;
    timeInput.disabled = !native;

    const { enabled, time } = getReminderPrefs();
    enabledInput.checked = enabled;
    timeInput.value = time;
  }

  async function onReminderToggle(e) {
    const enabled = e.target.checked;
    const timeInput = document.getElementById("reminder-time");
    const time = timeInput.value || REMINDER_DEFAULT_TIME;
    const errorEl = document.getElementById("reminder-error");
    if (errorEl) errorEl.hidden = true;

    if (!enabled) {
      setReminderPrefs(false, time);
      await cancelReminder();
      return;
    }

    const plugin = localNotificationsPlugin();
    if (!plugin) { e.target.checked = false; return; }
    let perm;
    try {
      perm = await plugin.requestPermissions();
    } catch (err) {
      perm = { display: "denied" };
    }
    if (perm.display !== "granted") {
      e.target.checked = false;
      if (errorEl) {
        errorEl.textContent = "Notification permission was denied - enable it for CO2 Tracker in iOS Settings to use this.";
        errorEl.hidden = false;
      }
      return;
    }
    setReminderPrefs(true, time);
    await scheduleReminder(time);
  }

  async function onReminderTimeChange(e) {
    const time = e.target.value || REMINDER_DEFAULT_TIME;
    const { enabled } = getReminderPrefs();
    setReminderPrefs(enabled, time);
    if (enabled) await scheduleReminder(time);
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
          // updateAuthModeUI() resets the form for the new mode (button
          // label, toggle text) but also unconditionally re-hides
          // auth-status, since it's normally called on a fresh mode
          // switch with nothing to show yet - call it first, then set the
          // confirmation message after, so it doesn't immediately hide
          // the very message this branch exists to show.
          authMode = "signin";
          updateAuthModeUI();
          statusEl.textContent = "Confirmation email sent - check your inbox to confirm your account, then sign in.";
          statusEl.hidden = false;
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
    applyReminderFromPrefs();
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

    document.querySelectorAll("#main-tabs .tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => { location.hash = btn.dataset.tab; });
    });
    window.addEventListener("hashchange", () => showTab(currentTab()));

    document.getElementById("year-list").addEventListener("click", (e) => {
      const row = e.target.closest(".year-list-row");
      if (row) showYearDetail(row.dataset.detail);
    });
    document.querySelectorAll(".year-detail [data-back]").forEach((btn) => {
      btn.addEventListener("click", showYearList);
    });

    // Settings' own list->detail->back nav - separate data attributes
    // (data-settings-detail/data-settings-back, not data-detail/data-back)
    // so this wiring and This Year's above don't pick up each other's
    // rows/back-buttons, even though both reuse the same .year-list/
    // .year-detail/.year-back-btn classes for styling.
    document.getElementById("settings-list").addEventListener("click", (e) => {
      const row = e.target.closest(".year-list-row");
      if (row) showSettingsDetail(row.dataset.settingsDetail);
    });
    document.querySelectorAll(".year-detail [data-settings-back]").forEach((btn) => {
      btn.addEventListener("click", showSettingsList);
    });
    // Reset to the list every time Settings is (re-)opened, so leaving a
    // detail screen open and later re-expanding Settings doesn't strand
    // you somewhere you didn't just choose to be - same reasoning This
    // Year resets on tab entry.
    document.getElementById("settings-accordion-item").addEventListener("toggle", (e) => {
      if (e.target.open) showSettingsList();
    });

    document.getElementById("sign-out-btn").addEventListener("click", () => sbClient.auth.signOut());

    document.getElementById("week-detail-close").addEventListener("click", closeWeekDetail);
    document.getElementById("week-detail-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "week-detail-backdrop") closeWeekDetail();
    });

    document.getElementById("tile-info-close").addEventListener("click", closeTileInfo);
    document.getElementById("tile-info-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "tile-info-backdrop") closeTileInfo();
    });

    document.getElementById("bank-switch-close").addEventListener("click", closeBankSwitchModal);
    document.getElementById("bank-switch-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "bank-switch-backdrop") closeBankSwitchModal();
    });
    document.querySelectorAll(".tile-info-btn").forEach((btn) => {
      btn.addEventListener("click", () => openTileInfo(btn.dataset.info));
    });

    wireCarousel("home-savings-carousel", "home-savings-dots");
    wireCarousel("home-year-groups-carousel", "home-year-groups-dots");
    wireCarousel("home-compare-carousel", "home-compare-dots");
    wireCarousel("home-budget-carousel", "home-budget-dots");

    populateCountrySelect(document.getElementById("settings-country"));
    populateLeaderboardGroupFilter(document.getElementById("leaderboard-group-filter"));

    document.querySelectorAll(".leaderboard-scope-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (leaderboardScope === btn.dataset.scope) return;
        leaderboardScope = btn.dataset.scope;
        document.querySelectorAll(".leaderboard-scope-btn").forEach((b) => b.classList.toggle("active", b === btn));
        document.getElementById("leaderboard-group-filter-field").hidden = leaderboardScope !== "all";
        document.getElementById("leaderboard-assumptions").textContent = leaderboardScope === "all"
          ? "Everyone who's opted in to the public leaderboard (Settings → Data sharing), ranked by this week's average kg CO2e per confirmed day so far, lowest first. Filter by university or country below."
          : "You and your accepted friends, ranked by this week's average kg CO2e per confirmed day so far, lowest first — not by raw total, so being behind on logging days doesn't make you look artificially better than someone who's kept every day up to date. The total and how many days you've confirmed (out of how many have happened so far this week) are shown next to each person's average. Add friends from the Account page.";
        renderLeaderboard();
      });
    });
    document.getElementById("leaderboard-group-filter").addEventListener("change", (e) => {
      leaderboardGroupFilter = e.target.value;
      renderLeaderboard();
    });

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

    document.querySelectorAll(".yearly-period-btn").forEach((btn) => {
      btn.addEventListener("click", () => renderStatsPage(btn.dataset.period));
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
      renderProfileAvatar(); // keeps the placeholder's initial in sync with the name
    });
    document.getElementById("profile-avatar-change-btn").addEventListener("click", () => {
      document.getElementById("profile-avatar-input").click();
    });
    document.getElementById("profile-avatar-input").addEventListener("change", (e) => {
      handleAvatarFileSelected(e.target.files[0]);
      e.target.value = ""; // allow re-selecting the same file later
    });
    document.getElementById("profile-avatar-remove-btn").addEventListener("click", removeAvatar);
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
    // Full-lifestyle targets, matching every domain the Budget pace chart
    // now plots (see renderPeriodChart()) rather than just commute+food -
    // "Match UK average" additionally widens to include whichever optional
    // extras this profile has personally answered (includeOptionalForProfile()),
    // same ground computeUkAverageBreakdown() already compares Stats page
    // tiles against.
    document.getElementById("goal-preset-uk").addEventListener("click", () => setGoalPreset(computeUkAverageBreakdown(includeOptionalForProfile(profile)).total / 52));
    document.getElementById("goal-preset-15c").addEventListener("click", () => setGoalPreset(PARIS_1_5C_YEARLY_KG / 52));
    document.getElementById("goal-preset-world").addEventListener("click", () => setGoalPreset(WORLD_AVERAGE_YEARLY_KG / 52));
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
    bindNumberField("household-people", (v) => { profile.householdPeople = v; }, { min: 1 });
    bindNumberField("clothes-per-month", (v) => { profile.clothesPerMonth = v; });

    document.querySelectorAll(".flight-continent-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedFlightContinent = btn.dataset.continent;
        document.querySelectorAll(".flight-continent-btn").forEach((b) => b.classList.toggle("active", b === btn));
      });
    });
    document.querySelectorAll(".flight-class-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedFlightClass = btn.dataset.class;
        document.querySelectorAll(".flight-class-btn").forEach((b) => b.classList.toggle("active", b === btn));
      });
    });
    document.getElementById("flight-add-btn").addEventListener("click", addFlight);
    document.getElementById("flight-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".journey-remove-btn");
      if (btn) removeFlight(parseInt(btn.dataset.index, 10));
    });

    document.getElementById("electricity-bill-save").addEventListener("click", saveElectricityBill);

    document.getElementById("habits-grid").addEventListener("click", (e) => {
      const startBtn = e.target.closest(".habit-start-btn");
      if (startBtn) { startHabitChallenge(startBtn.dataset.habit, parseInt(startBtn.dataset.days, 10)); return; }
      const cancelBtn = e.target.closest(".habit-cancel-btn");
      if (cancelBtn) { cancelHabitChallenge(cancelBtn.dataset.habit); return; }
      if (e.target.closest("#habit-prompt-btn")) { openHabitSurvey(); return; }
      const surveyOption = e.target.closest(".habit-survey-option");
      if (surveyOption) {
        const key = surveyOption.dataset.habitChoice;
        if (key === "eating" || key === "commuting") openHabitTierPicker(key);
        else chooseHabitDomain(key);
        return;
      }
      const tierBtn = e.target.closest(".habit-tier-btn");
      if (tierBtn) { chooseWeeklyTarget(tierBtn.dataset.domain, parseInt(tierBtn.dataset.target, 10)); return; }
      if (e.target.closest(".habit-survey-back-btn")) { habitSurveyStep = null; renderHabitsCard(); return; }
      if (e.target.closest(".habit-change-btn")) { reopenHabitSurvey(); return; }
      if (e.target.closest("#habit-banking-fill-btn")) { goToYearDetail("banking"); return; }
      if (e.target.closest("#habit-banking-switch-btn")) openBankSwitchModal();
    });
    document.getElementById("habit-streak-congrats-close").addEventListener("click", () => {
      document.getElementById("habit-streak-congrats-backdrop").classList.remove("open");
    });
    document.getElementById("habit-streak-congrats-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "habit-streak-congrats-backdrop") {
        document.getElementById("habit-streak-congrats-backdrop").classList.remove("open");
      }
    });

    document.getElementById("home-onboarding-dismiss").addEventListener("click", dismissOnboardingBanner);
    document.getElementById("home-onboarding-banner").addEventListener("click", (e) => {
      const navBtn = e.target.closest("[data-nav]");
      if (navBtn) showTab(navBtn.dataset.nav);
    });

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

    document.getElementById("settings-country").addEventListener("change", (e) => {
      profile.country = e.target.value || null;
      persistProfile();
    });

    document.getElementById("leaderboard-opt-in").addEventListener("change", (e) => {
      profile.leaderboardOptIn = e.target.checked;
      persistProfile();
    });

    document.querySelectorAll("#baseline-mode-toggle .week-picker-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        baselineViewMode = btn.dataset.baselineMode;
        renderBaselineWeekForm();
      });
    });
    document.getElementById("baseline-copy-list").addEventListener("click", (e) => {
      const row = e.target.closest("[data-copy-week]");
      if (row) copyWeekToBaseline(row.dataset.copyWeek);
    });
    document.getElementById("baseline-use-uk-average-btn").addEventListener("click", useUkAverageBaseline);
    document.getElementById("baseline-alcohol-beer").addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      getBaselineDraft().alcohol.beer = Number.isFinite(val) && val >= 0 ? val : 0;
      onBaselineChange();
    });
    document.getElementById("baseline-alcohol-wine").addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      getBaselineDraft().alcohol.wine = Number.isFinite(val) && val >= 0 ? val : 0;
      onBaselineChange();
    });

    document.getElementById("reminder-enabled").addEventListener("change", onReminderToggle);
    document.getElementById("reminder-time").addEventListener("change", onReminderTimeChange);

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
    document.getElementById("reset-week-account").addEventListener("click", resetWeek);
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
