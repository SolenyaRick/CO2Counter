// ============================================================================
// emission-factors.js
// ----------------------------------------------------------------------------
// Every physical "kg CO2e per unit" number the app's calculations run on,
// in one plain, directly-editable file - same idea as supabase/schema.sql
// being the single source of truth for the database schema. Edit the
// numbers below and reload the app; nothing else needs to change.
//
// This file must be loaded via a <script> tag BEFORE app.js (see
// index.html). It deliberately does NOT wrap itself in a function or
// module - the `const` declarations below become part of the page's
// shared top-level scope, which is how app.js's own code (wrapped in its
// own IIFE) can still see and use them.
//
// What's NOT in this file: UI labels/icons, day-of-week/month arrays,
// Supabase config, and anything that's a *model of average behaviour*
// (e.g. "the UK average person's commute is 10km") rather than a
// physical per-unit factor - those stay in app.js since they're
// judgement calls about what a "representative" person looks like, not
// hard emissions numbers. The derived UK/world/1.5C benchmark figures
// also stay in app.js, since they're computed FROM the factors below
// rather than being factors themselves.
// ============================================================================

// ---------- Transport (kg CO2e per passenger-km) ----------

// Rough average emission factors, kg CO2e per passenger-km.
const TRANSPORT_FACTORS = { none: 0, walk: 0, cycle: 0, train: 0.041, car: 0.171 };

// Optional per-car-type factors (This Year page, "Driving"), rough
// DEFRA-style kg CO2e/km - diesel is close to TRANSPORT_FACTORS.car (the
// blended average used when this isn't answered), hybrid and electric
// notably lower. Electric uses average UK grid intensity to charge it,
// not tailpipe emissions (there are none). Applies to both commute days
// where "Car" is picked and non-commute driving - not to the UK-average
// reference figures, which stay a fixed population-wide benchmark
// regardless of what car the current user personally drives.
const CAR_FUEL_FACTORS = { diesel: 0.171, hybrid: 0.111, electric: 0.058 };

// ---------- Food (kg CO2e per kg of product, or per day) ----------

// Rough average emission factors, kg CO2e per kg of product. Beef ~36 and
// chicken ~6 per commonly cited figures (beef is roughly 4-6x chicken).
const MEAT_FACTORS = { chicken: 6, fish: 5, pork: 7, beef: 36, lamb: 25, other: 10 };

const PORTION_KG = { small: 0.1, medium: 0.15, large: 0.25 };

// Rosi et al. 2017 (seven-day diets, ~150 people, Italy): ovo-lacto-vegetarian
// 2.6, vegan 2.3 kg CO2e per person per day.
const FOOD_DAY_FACTORS = { veggie: 2.6, vegan: 2.3 };

// The rest of a meat day's food (breakfast, sides, etc.) is valued the same as a
// vegetarian day, since it isn't any more carbon-efficient — the meat is added on top.
const MEAT_SIDES_BASELINE = FOOD_DAY_FACTORS.veggie;

// Eating out vs. cooking at home, for dinner only. Rough multiplier on
// just the dinner slice of a day's food footprint, reflecting a
// restaurant/takeaway's extra energy use, larger portions, and food
// waste on top of the same ingredients cooked at home. On a meat day,
// "dinner" is exactly the meat portion (see foodFootprint in app.js)
// since that's already modeled as the day's one meat meal; on a
// veggie/vegan day, where there's no such split, half the flat day
// figure is treated as a stand-in for dinner.
const EATING_OUT_MULTIPLIER = 1.5;
const VEGGIE_DINNER_SHARE = 0.5;

// Wasted food still carries the emissions it took to produce. Modeled as
// "you have to buy/produce 1/(1-waste%) times what you actually eat", using
// the midpoint of each bracket as a representative waste percentage.
const FOOD_WASTE_MULTIPLIERS = { low: 1.02, some: 1.07, high: 1.25, severe: 1.67 };

// ---------- Alcohol (kg CO2e per drink) ----------
// Whole-week figures. Rough averages covering production, packaging, and
// transport.

const BEER_KG_PER_DRINK = 0.5; // per pint/can
const WINE_KG_PER_GLASS = 0.3; // per ~175ml glass
const SPIRITS_KG_PER_SHOT_AT_40PCT = 0.15; // per 25ml shot at 40% ABV, scales with ABV

// ---------- Yearly-estimate factors (Stats page) ----------
// Kept separate from the per-day/per-drink factors above since they're
// coarser, once-a-year-ish figures.

const SHORT_HAUL_FLIGHT_KG = 250; // per short-haul European return flight
const LONG_HAUL_FLIGHT_KG = 1600; // per long-haul international return flight
const GRID_ELECTRICITY_KG_PER_KWH = 0.2; // rough average grid electricity factor
const CLOTHING_ITEM_KG = 10; // rough blended average per clothing item

// Optional Stats-page extras. Each is left OUT of every total unless the
// user actively answers that question (see DEFAULT_PROFILE in app.js) -
// never coerced to 0 - so someone who skips a question isn't silently
// scored as if that category doesn't apply to them.
const GAS_HEATING_KG_PER_KWH = 0.18; // rough blended gas/oil heating factor
const CAR_MANUFACTURING_AMORTIZED_KG_PER_YEAR = 700; // rough embodied build footprint, amortized over an ~14yr average car lifetime
const DOG_KG_PER_YEAR = 770; // rough average dog footprint/yr (mostly diet-driven)
const CAT_KG_PER_YEAR = 310; // rough average cat footprint/yr
const WATER_KG_PER_M3 = 0.32; // rough DEFRA-style combined supply + treatment factor

// Kg CO2e financed per £1 held with each bank per year, derived from
// MotherTree's bank carbon emissions league table (tCO2 financed per
// £10,000 held, reflecting each bank's fossil-fuel financing intensity -
// https://www.mymothertree.com/bank-league-table). tCO2/£10k * 0.1 = kg/£.
const BANK_KG_PER_POUND_PER_YEAR = {
  barclays: 0.2376,
  hsbc: 0.2170,
  firstDirect: 0.2170,
  chase: 0.1897,
  santander: 0.1742,
  natwest: 0.1295,
  rbs: 0.1295,
  monzo: 0.1088,
  lloyds: 0.0704,
  halifax: 0.0704,
  metroBank: 0.0694,
  starling: 0.0610,
  virginMoney: 0.0517,
  nationwide: 0.0432,
  cooperative: 0.0328,
  triodos: 0.0317,
};

// ---------- Reference (for comparisons) ----------

const TREE_KG_PER_YEAR = 22; // rough CO2 absorbed by one mature tree per year
