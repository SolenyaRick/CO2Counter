// Survey options, emission factors and reduction guidance for CO2 Counter
// (Prototype 2). Ported verbatim from the Base44 prototype so the numbers
// and wording match it exactly. Loaded before app.js as a plain script.
(function () {
  "use strict";

  // Default answers for a fresh survey.
  const DEFAULT_SURVEY = {
  "meals": {
    "diet": "",
    "eatOut": 0,
    "foodWaste": "low"
  },
  "commute": {
    "distance": 10
  },
  "extraTravel": [],
  "longTrips": [],
  "flights": [],
  "energy": {
    "electricityKwh": 200,
    "gasKwh": 800,
    "greenTariff": false,
    "household": 2
  },
  "water": {
    "liters": 4000
  },
  "pets": {
    "dogs": 0,
    "cats": 0
  },
  "banking": {
    "amount": 5000,
    "bank": "",
    "pensionPot": 0,
    "pensionProvider": ""
  }
};

  const DAYS = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun"
];
  const WEEKS_PER_YEAR = 4.33 * 12; // matches the Base44 monthly figures x12
  // A typical UK resident's answers to this survey, so the "UK average"
  // comparison runs through the same factors and covers only what the
  // survey measures (no shopping, services, coffee, alcohol...). Banking
  // and pensions are left out of the comparison: there's no reliable
  // per-person UK figure for savings by bank or pension provider.
  //  - Home energy: Ofgem typical consumption (2,500 kWh electricity,
  //    9,500 kWh gas a year, 2026 revision), 2.4 people per household
  //    (ONS mid-2024: 69.3m people / 28.6m households).
  //  - Water: 140 L per person per day (Consumer Council for Water, 2023).
  //  - Commuting: 1,007 miles per person per year (DfT National Travel
  //    Survey 2024), about 3/4 by car (NTS: 76% of all miles are by car),
  //    modelled as a 3.1 km trip each weekday, four days by car, one by
  //    train.
  //  - Flights: 80.9m of the 91.5m visits abroad by UK residents in 2024
  //    were by air (ONS Travel trends 2024, Table 4, as corrected Sept
  //    2026), for 69.3m people: about 1.17 return flights each, modelled
  //    as London-Barcelona and back in economy.
  //  - Pets: 15.5m dogs and 13.1m cats (UK Pet Food 2026) for 69.3m people.
  //  - Food: Defra Family Food 2023/24, household purchases per person per
  //    week: chicken & poultry 230 g, pork incl. bacon, ham & sausages
  //    137 g, fish 120 g, beef 84 g, lamb 23 g. At the survey's 150 g
  //    portion that's the main-meal days below, with the rest of the week
  //    vegetarian. Eating out once a week and "some" food waste are
  //    assumptions.
  const UK_PROFILE = {
    electricityKwh: 2500, // Ofgem typical household, a year
    gasKwh: 9500,
    household: 2.4, // people per household (ONS)
    waterLitres: 140, // per person per day (CCW)
    flightsPerPerson: 80.9 / 69.3, // return flights a year (ONS)
    dogsPerPerson: 15.5 / 69.3, // UK Pet Food
    catsPerPerson: 13.1 / 69.3,
    commuteKm: 3.1, // one way, per weekday (DfT NTS)
    chickenG: 230, // Defra Family Food, g per person per week
    porkG: 137,
    fishG: 120,
    beefG: 84,
    lambG: 23,
  };
  const UK_TYPICAL_SURVEY = {};
  // Rebuilt whenever the profile or the meat portion changes (Inputs page).
  function buildUkTypical(portionKg) {
    const p = UK_PROFILE;
    const g = portionKg * 1000;
    const meatG = p.chickenG + p.porkG + p.fishG + p.beefG + p.lambG;
    Object.assign(UK_TYPICAL_SURVEY, {
      meals: {
        diet: "meat_eater",
        eatOut: 1,
        foodWaste: "some",
        weekMix: { chicken: p.chickenG / g, pork: p.porkG / g, fish: p.fishG / g, beef: p.beefG / g, lamb: p.lambG / g, veggie: 7 - meatG / g },
      },
      commute: { distance: p.commuteKm, Mon: "car_petrol", Tue: "car_petrol", Wed: "car_petrol", Thu: "car_petrol", Fri: "train" },
      flights: [{ from: "LHR", to: "BCN", cabin: "economy", returnTrip: true, trips: p.flightsPerPerson }],
      energy: { electricityKwh: p.electricityKwh / 12, gasKwh: p.gasKwh / 12, greenTariff: false, household: p.household },
      water: { liters: p.waterLitres * 30.4 * p.household },
      pets: { dogs: p.dogsPerPerson * p.household, cats: p.catsPerPerson * p.household },
      banking: { amount: 0, bank: "", pensionPot: 0, pensionProvider: "" },
    });
  }
  // Shopping isn't in the survey yet, so results add a typical UK figure as
  // an assumption: household spending on clothing and footwear, household
  // goods (furniture, textiles, appliances, tableware, tools, upkeep),
  // electronics and phones, and hobbies and leisure (recreational durables,
  // services, books). Defra UK carbon footprint 2023 (published June 2026),
  // Summary_product, kt CO2e, divided by the ONS mid-2023 UK population of
  // 68.265m. About 1.0 t per person.
  const ASSUMED_SHOPPING = {
    clothesKg: ((10470.9967 + 1550.4092) / 68265) * 1000,
    householdKg: ((13374.895 + 5167.8897 + 7839.8949 + 3337.4428 + 1140.439 + 1628.0991) / 68265) * 1000,
    electronicsKg: ((7602.0874 + 1960.2707) / 68265) * 1000,
    hobbiesKg: ((4426.82 + 7503.65 + 2117.1873) / 68265) * 1000,
  };
  ASSUMED_SHOPPING.totalKg = ASSUMED_SHOPPING.clothesKg + ASSUMED_SHOPPING.householdKg + ASSUMED_SHOPPING.electronicsKg + ASSUMED_SHOPPING.hobbiesKg;

  // Shared footprint: each UK resident's share of emissions from public
  // services (central and local government: NHS, schools, councils,
  // defence) and from capital investment (infrastructure, buildings,
  // business equipment). Defra, UK carbon footprint 2023 (published June
  // 2026), Summary_final_demand, kt CO2e, divided by the ONS mid-2023 UK
  // population of 68.265m. The same for everyone; not part of the survey.
  const SHARED_FOOTPRINT = {
    publicServicesKg: ((53028.3 + 26235.1) / 68265) * 1000,
    infrastructureKg: (84258.5 / 68265) * 1000,
  };
  SHARED_FOOTPRINT.totalKg = SHARED_FOOTPRINT.publicServicesKg + SHARED_FOOTPRINT.infrastructureKg;

  // Categories used in the UK comparison (everything except banking).
  const UK_COMPARISON_KEYS = ["meals", "commute", "flights", "energy", "water", "pets"];
  const BUDGET_YEARLY = 2500; // 1.5°C budget, kg CO2e / year
  const ELECTRICITY_FACTOR = 0.22687; // kg / kWh, standard grid
  const GREEN_ELECTRICITY_FACTOR = 0.04;
  const GAS_FACTOR = 0.21317;
  const WATER_FACTOR = 0.36218; // kg / 1000 L
  const DOG_YEARLY = 770;
  const CAT_YEARLY = 310;
  const EAT_OUT_MULTIPLIER = 1.78;
  const PORTION = 0.15; // kg of meat in a main meal
  buildUkTypical(PORTION);
  // Meat, kg CO2e per kg of product: Poore & Nemecek (2018), Science
  // 360:987, global means (via Our World in Data): beef herd, lamb & mutton,
  // pig meat, poultry meat. The same dataset underlies Scarborough et al.
  // (2023), Nature Food, on UK diets.
  const MEAT_PER_KG = {
    chicken: 9.87,
    pork: 12.31,
    beef: 99.48,
    lamb: 39.72,
  };
  // Every day in the survey is a whole day of food. Vegan, vegetarian and
  // fish days are measured daily footprints (Choręziak & Rzymski 2025,
  // Nutrients 17:1377). A meat day is the vegetarian day plus a 150 g
  // portion of that meat.
  const VEGGIE_DAY = 2.45;
  const meatDay = (key) => Math.round((VEGGIE_DAY + PORTION * MEAT_PER_KG[key]) * 100) / 100;

  const DIETS = [
  {
    "key": "vegan",
    "label": "Vegan",
    "emoji": "🥗",
    "desc": "Plant-based only",
    "mealKey": "vegan"
  },
  {
    "key": "veggie",
    "label": "Vegetarian",
    "emoji": "🧀",
    "desc": "No meat or fish",
    "mealKey": "veggie"
  },
  {
    "key": "pescatarian",
    "label": "Pescatarian",
    "emoji": "🐟",
    "desc": "Fish, no meat",
    "mealKey": "fish"
  },
  {
    "key": "meat_eater",
    "label": "Meat eater",
    "emoji": "🥩",
    "desc": "Pick day by day",
    "mealKey": null
  }
];
  const MEAL_OPTIONS = [
  {
    "key": "vegan",
    "label": "Vegan",
    "emoji": "🥗",
    "factor": 1.38, // Choręziak & Rzymski 2025, vegan group's mean day
    "color": "#10b981"
  },
  {
    "key": "veggie",
    "label": "Vegetarian",
    "emoji": "🧀",
    "factor": VEGGIE_DAY,
    "color": "#84cc16"
  },
  {
    // A whole fish-eater day, like the vegan and vegetarian days above:
    // 2.72 kg CO2e per day (Choręziak & Rzymski 2025, Nutrients 17:1377).
    // It isn't a per-kg figure, so it isn't multiplied by a portion.
    "key": "fish",
    "label": "Fish",
    "emoji": "🐟",
    "factor": 2.72,
    "color": "#06b6d4"
  },
  {
    "key": "chicken",
    "label": "Chicken",
    "emoji": "🍗",
    "factor": meatDay("chicken"),
    "color": "#f59e0b"
  },
  {
    "key": "pork",
    "label": "Pork",
    "emoji": "🥓",
    "factor": meatDay("pork"),
    "color": "#f97316"
  },
  {
    "key": "beef",
    "label": "Beef",
    "emoji": "🥩",
    "factor": meatDay("beef"),
    "color": "#ef4444"
  },
  {
    "key": "lamb",
    "label": "Lamb",
    "emoji": "🍖",
    "factor": meatDay("lamb"),
    "color": "#b91c1c"
  }
];
  const EAT_OUT_OPTIONS = [
  {
    "value": 0,
    "label": "Never"
  },
  {
    "value": 1,
    "label": "1× / week"
  },
  {
    "value": 2,
    "label": "2× / week"
  },
  {
    "value": 3,
    "label": "3× / week"
  },
  {
    "value": 4,
    "label": "4+ × / week"
  }
];
  const FOOD_WASTE = [
  {
    "key": "low",
    "label": "Low (0–3%)",
    "emoji": "🟢",
    "multiplier": 1.02
  },
  {
    "key": "some",
    "label": "Some (3–10%)",
    "emoji": "🟡",
    "multiplier": 1.065
  },
  {
    "key": "high",
    "label": "High (10–25%)",
    "emoji": "🟠",
    "multiplier": 1.175
  },
  {
    "key": "severe",
    "label": "Severe (25%+)",
    "emoji": "🔴",
    "multiplier": 1.4
  }
];
  const COMMUTE_MODES = [
  {
    "key": "wfh",
    "label": "Work from home",
    "emoji": "🏠",
    "factor": 0
  },
  {
    "key": "walk_bike",
    "label": "Walk / Bike",
    "emoji": "🚲",
    "factor": 0
  },
  {
    "key": "train",
    "label": "Train",
    "emoji": "🚆",
    "factor": 0.03989
  },
  {
    // DESNZ 2026 London Underground: 0.01549 + 0.00728 (well-to-tank)
    // kg CO2e per passenger km. National rail above is 0.03092 + 0.00897.
    "key": "tube",
    "label": "Tube",
    "emoji": "🚇",
    "factor": 0.02277
  },
  {
    "key": "bus",
    "label": "Bus",
    "emoji": "🚌",
    "factor": 0.128
  },
  {
    "key": "ev",
    // DESNZ 2026 battery electric average car: 0.02951 (electricity
    // incl. T&D) + 0.01049 (well-to-tank) kg CO2e/km.
    "label": "Electric car",
    "emoji": "⚡",
    "factor": 0.04
  },
  {
    "key": "car_petrol",
    "label": "Car (petrol)",
    "emoji": "🚗",
    "factor": 0.20751
  },
  {
    "key": "car_diesel",
    "label": "Car (diesel)",
    "emoji": "🚙",
    "factor": 0.21411
  },
  {
    "key": "motorcycle",
    "label": "Motorcycle",
    "emoji": "🏍️",
    "factor": 0.118
  }
];
  // Modes for travel outside the daily commute (extra weekly travel and
  // long journeys): the motorised commute modes plus coach and
  // international rail. DESNZ 2026, kg CO2e per passenger km, including
  // well-to-tank.
  const TRAVEL_MODES = COMMUTE_MODES.filter((m) => m.factor > 0).concat([
    { key: "coach", label: "Coach", emoji: "🚌", factor: 0.03948 + 0.00656 },
    { key: "intl_rail", label: "International train", emoji: "🚆", factor: 0.01135 + 0.00117 },
  ]);

  // Flight factors: DESNZ 2026 conversion factors (unchanged from 2025), kg CO2e per passenger km,
  // with radiative forcing, plus well-to-tank (fuel production). Short-haul
  // has no premium or first class in DESNZ, so those use economy and
  // business. Domestic UK flights use DESNZ's average passenger figure.
  const CABINS = [
    { key: "economy", label: "Economy", emoji: "💺", short: 0.12576 + 0.02249, long: 0.11704 + 0.02461 },
    { key: "premium", label: "Premium economy", emoji: "🥂", short: 0.12576 + 0.02249, long: 0.18726 + 0.03937 },
    { key: "business", label: "Business", emoji: "🛋️", short: 0.18863 + 0.03373, long: 0.3394 + 0.07137 },
    { key: "first", label: "First class", emoji: "👑", short: 0.18863 + 0.03373, long: 0.46814 + 0.09844 },
  ];
  const FLIGHT_DOMESTIC_FACTOR = 0.22928 + 0.0335;
  // DESNZ: short-haul is up to 3,700 km; distances get an 8% uplift for
  // indirect routing and holding.
  const FLIGHT_LONG_HAUL_KM = 3700;
  const FLIGHT_DISTANCE_UPLIFT = 1.08;
  const AIRPORTS = [
  {
    "code": "LHR",
    "city": "London Heathrow",
    "country": "UK",
    "lat": 51.47,
    "lon": -0.4543
  },
  {
    "code": "LGW",
    "city": "London Gatwick",
    "country": "UK",
    "lat": 51.1481,
    "lon": -0.1903
  },
  {
    "code": "MAN",
    "city": "Manchester",
    "country": "UK",
    "lat": 53.3537,
    "lon": -2.275
  },
  {
    "code": "EDI",
    "city": "Edinburgh",
    "country": "UK",
    "lat": 55.95,
    "lon": -3.3725
  },
  {
    "code": "DUB",
    "city": "Dublin",
    "country": "Ireland",
    "lat": 53.4213,
    "lon": -6.2701
  },
  {
    "code": "CDG",
    "city": "Paris CDG",
    "country": "France",
    "lat": 49.0097,
    "lon": 2.5479
  },
  {
    "code": "AMS",
    "city": "Amsterdam",
    "country": "Netherlands",
    "lat": 52.3105,
    "lon": 4.7683
  },
  {
    "code": "FRA",
    "city": "Frankfurt",
    "country": "Germany",
    "lat": 50.0379,
    "lon": 8.5622
  },
  {
    "code": "MUC",
    "city": "Munich",
    "country": "Germany",
    "lat": 48.3538,
    "lon": 11.7861
  },
  {
    "code": "BCN",
    "city": "Barcelona",
    "country": "Spain",
    "lat": 41.2974,
    "lon": 2.0833
  },
  {
    "code": "MAD",
    "city": "Madrid",
    "country": "Spain",
    "lat": 40.4983,
    "lon": -3.5676
  },
  {
    "code": "LIS",
    "city": "Lisbon",
    "country": "Portugal",
    "lat": 38.7742,
    "lon": -9.1342
  },
  {
    "code": "FCO",
    "city": "Rome",
    "country": "Italy",
    "lat": 41.8003,
    "lon": 12.2389
  },
  {
    "code": "MXP",
    "city": "Milan",
    "country": "Italy",
    "lat": 45.6306,
    "lon": 8.7281
  },
  {
    "code": "ZRH",
    "city": "Zurich",
    "country": "Switzerland",
    "lat": 47.4647,
    "lon": 8.5492
  },
  {
    "code": "VIE",
    "city": "Vienna",
    "country": "Austria",
    "lat": 48.1103,
    "lon": 16.5697
  },
  {
    "code": "CPH",
    "city": "Copenhagen",
    "country": "Denmark",
    "lat": 55.6181,
    "lon": 12.6561
  },
  {
    "code": "ARN",
    "city": "Stockholm",
    "country": "Sweden",
    "lat": 59.6519,
    "lon": 17.9186
  },
  {
    "code": "OSL",
    "city": "Oslo",
    "country": "Norway",
    "lat": 60.1939,
    "lon": 11.1004
  },
  {
    "code": "HEL",
    "city": "Helsinki",
    "country": "Finland",
    "lat": 60.3172,
    "lon": 24.9633
  },
  {
    "code": "WAW",
    "city": "Warsaw",
    "country": "Poland",
    "lat": 52.1657,
    "lon": 20.9671
  },
  {
    "code": "ATH",
    "city": "Athens",
    "country": "Greece",
    "lat": 37.9364,
    "lon": 23.9445
  },
  {
    "code": "IST",
    "city": "Istanbul",
    "country": "Turkey",
    "lat": 41.2753,
    "lon": 28.7519
  },
  {
    "code": "JFK",
    "city": "New York JFK",
    "country": "USA",
    "lat": 40.6413,
    "lon": -73.7781
  },
  {
    "code": "LAX",
    "city": "Los Angeles",
    "country": "USA",
    "lat": 33.9416,
    "lon": -118.4085
  },
  {
    "code": "SFO",
    "city": "San Francisco",
    "country": "USA",
    "lat": 37.6213,
    "lon": -122.379
  },
  {
    "code": "ORD",
    "city": "Chicago",
    "country": "USA",
    "lat": 41.9742,
    "lon": -87.9073
  },
  {
    "code": "MIA",
    "city": "Miami",
    "country": "USA",
    "lat": 25.7959,
    "lon": -80.2871
  },
  {
    "code": "BOS",
    "city": "Boston",
    "country": "USA",
    "lat": 42.3656,
    "lon": -71.0096
  },
  {
    "code": "SEA",
    "city": "Seattle",
    "country": "USA",
    "lat": 47.4502,
    "lon": -122.3088
  },
  {
    "code": "IAD",
    "city": "Washington",
    "country": "USA",
    "lat": 38.9531,
    "lon": -77.4565
  },
  {
    "code": "ATL",
    "city": "Atlanta",
    "country": "USA",
    "lat": 33.6407,
    "lon": -84.4277
  },
  {
    "code": "DFW",
    "city": "Dallas",
    "country": "USA",
    "lat": 32.8998,
    "lon": -97.0403
  },
  {
    "code": "YYZ",
    "city": "Toronto",
    "country": "Canada",
    "lat": 43.6777,
    "lon": -79.6248
  },
  {
    "code": "YVR",
    "city": "Vancouver",
    "country": "Canada",
    "lat": 49.1939,
    "lon": -123.1844
  },
  {
    "code": "MEX",
    "city": "Mexico City",
    "country": "Mexico",
    "lat": 19.4361,
    "lon": -99.0719
  },
  {
    "code": "DXB",
    "city": "Dubai",
    "country": "UAE",
    "lat": 25.2532,
    "lon": 55.3657
  },
  {
    "code": "DOH",
    "city": "Doha",
    "country": "Qatar",
    "lat": 25.2731,
    "lon": 51.608
  },
  {
    "code": "DEL",
    "city": "Delhi",
    "country": "India",
    "lat": 28.5562,
    "lon": 77.1
  },
  {
    "code": "BOM",
    "city": "Mumbai",
    "country": "India",
    "lat": 19.0896,
    "lon": 72.8656
  },
  {
    "code": "SIN",
    "city": "Singapore",
    "country": "Singapore",
    "lat": 1.3644,
    "lon": 103.9915
  },
  {
    "code": "BKK",
    "city": "Bangkok",
    "country": "Thailand",
    "lat": 13.69,
    "lon": 100.7501
  },
  {
    "code": "HKG",
    "city": "Hong Kong",
    "country": "Hong Kong",
    "lat": 22.308,
    "lon": 113.9185
  },
  {
    "code": "PEK",
    "city": "Beijing",
    "country": "China",
    "lat": 40.0799,
    "lon": 116.6031
  },
  {
    "code": "PVG",
    "city": "Shanghai",
    "country": "China",
    "lat": 31.1443,
    "lon": 121.8083
  },
  {
    "code": "ICN",
    "city": "Seoul",
    "country": "South Korea",
    "lat": 37.4602,
    "lon": 126.4407
  },
  {
    "code": "NRT",
    "city": "Tokyo",
    "country": "Japan",
    "lat": 35.772,
    "lon": 140.3929
  },
  {
    "code": "KIX",
    "city": "Osaka",
    "country": "Japan",
    "lat": 34.4347,
    "lon": 135.2329
  },
  {
    "code": "KUL",
    "city": "Kuala Lumpur",
    "country": "Malaysia",
    "lat": 2.7456,
    "lon": 101.7099
  },
  {
    "code": "CGK",
    "city": "Jakarta",
    "country": "Indonesia",
    "lat": -6.1256,
    "lon": 106.6558
  },
  {
    "code": "MNL",
    "city": "Manila",
    "country": "Philippines",
    "lat": 14.5086,
    "lon": 121.0194
  },
  {
    "code": "SYD",
    "city": "Sydney",
    "country": "Australia",
    "lat": -33.9399,
    "lon": 151.1753
  },
  {
    "code": "MEL",
    "city": "Melbourne",
    "country": "Australia",
    "lat": -37.669,
    "lon": 144.841
  },
  {
    "code": "AKL",
    "city": "Auckland",
    "country": "New Zealand",
    "lat": -37.0082,
    "lon": 174.785
  },
  {
    "code": "JNB",
    "city": "Johannesburg",
    "country": "South Africa",
    "lat": -26.1392,
    "lon": 28.246
  },
  {
    "code": "CAI",
    "city": "Cairo",
    "country": "Egypt",
    "lat": 30.1219,
    "lon": 31.4056
  },
  {
    "code": "NBO",
    "city": "Nairobi",
    "country": "Kenya",
    "lat": -1.3192,
    "lon": 36.9278
  },
  {
    "code": "LOS",
    "city": "Lagos",
    "country": "Nigeria",
    "lat": 6.5774,
    "lon": 3.3211
  },
  {
    "code": "GRU",
    "city": "São Paulo",
    "country": "Brazil",
    "lat": -23.4356,
    "lon": -46.4731
  },
  {
    "code": "EZE",
    "city": "Buenos Aires",
    "country": "Argentina",
    "lat": -34.8222,
    "lon": -58.5358
  },
  {
    "code": "BOG",
    "city": "Bogotá",
    "country": "Colombia",
    "lat": 4.7016,
    "lon": -74.1469
  },
  {
    "code": "SCL",
    "city": "Santiago",
    "country": "Chile",
    "lat": -33.393,
    "lon": -70.7858
  }
];
  // Financed emissions per £ held with each bank (kg CO2e per £ per year),
  // from MotherTree's 2021 analysis of UK banks.
  const BANKS = [
  {
    "key": "triodos",
    "label": "Triodos",
    "factor": 0.0317,
    "green": true
  },
  {
    "key": "co_op",
    "label": "The Co-operative Bank",
    "factor": 0.0328,
    "green": true
  },
  {
    "key": "nationwide",
    "label": "Nationwide",
    "factor": 0.0432,
    "green": false
  },
  {
    "key": "virgin_money",
    "label": "Virgin Money",
    "factor": 0.0517,
    "green": false
  },
  {
    "key": "starling",
    "label": "Starling",
    "factor": 0.061,
    "green": false
  },
  {
    "key": "metro_bank",
    "label": "Metro Bank",
    "factor": 0.0694,
    "green": false
  },
  {
    "key": "lloyds",
    "label": "Lloyds",
    "factor": 0.0704,
    "green": false
  },
  {
    "key": "halifax",
    "label": "Halifax",
    "factor": 0.0704,
    "green": false
  },
  {
    "key": "monzo",
    "label": "Monzo",
    "factor": 0.1088,
    "green": false
  },
  {
    "key": "natwest",
    "label": "NatWest",
    "factor": 0.1295,
    "green": false
  },
  {
    "key": "rbs",
    "label": "RBS",
    "factor": 0.1295,
    "green": false
  },
  {
    "key": "santander",
    "label": "Santander",
    "factor": 0.1742,
    "green": false
  },
  {
    "key": "chase",
    "label": "Chase",
    "factor": 0.1897,
    "green": false
  },
  {
    "key": "hsbc",
    "label": "HSBC",
    "factor": 0.217,
    "green": false
  },
  {
    "key": "first_direct",
    "label": "First Direct",
    "factor": 0.217,
    "green": false
  },
  {
    "key": "barclays",
    "label": "Barclays",
    "factor": 0.2376,
    "green": false
  }
];

  // Workplace pension providers' default-fund carbon footprint: Scope 1+2
  // tonnes CO2e per £1m invested, from each scheme's own climate (TCFD)
  // report. Most figures cover listed equities and bonds only. "other" is
  // the average across 20 major UK workplace schemes. Add a provider only
  // with a figure from its latest report, and update these each year.
  const PENSION_PROVIDERS = [
    { key: "aegon", label: "Aegon", tPerMillion: 38.7, source: "Aegon Master Trust climate disclosure 2024-25 (BlackRock LifePath Flexi default, Dec 2024)" },
    { key: "aon", label: "Aon", tPerMillion: 26.1, source: "Aon MasterTrust TCFD report 2025 (Managed Core Retirement Pathway, equities and corporate bonds, Dec 2024)" },
    { key: "aviva", label: "Aviva", tPerMillion: 65, source: "Aviva Master Trust TCFD report 2025 (My Future Focus Growth, Sep 2024)" },
    { key: "fidelity", label: "Fidelity", tPerMillion: 29.3, source: "Fidelity Master Trust TCFD report 2025 (FutureWise target date funds, Dec 2024)" },
    { key: "lg", label: "Legal & General", tPerMillion: 61.7, source: "L&G Mastertrust Sustainability Report 2025 (Target Date Funds growth phase, incl. government bonds, Mar 2025)" },
    { key: "nest", label: "Nest", tPerMillion: 32.7, source: "Nest TCFD report 2024/25 (default strategy, Mar 2025)" },
    { key: "now", label: "NOW: Pensions", tPerMillion: 52.0, source: "NOW: Pensions TCFD report 2024, as reported by NOW: Pensions" },
    { key: "peoples", label: "The People's Pension", tPerMillion: 31.3, source: "The People's Pension TCFD report 2024 (Global Investments fund; a 53% cut of 35.3 t leaves ~31.3 t)" },
    { key: "royal_london", label: "Royal London", tPerMillion: 56.3, source: "Royal London TCFD product report Dec 2025 (Balanced Lifestyle Strategy, 42.0 t per US$1m at ~$1.34 to £1)" },
    { key: "smart", label: "Smart Pension", tPerMillion: 75.4, source: "Smart Pension Master Trust TCFD report 2025 (main default growth fund, Jun 2025)" },
    { key: "standard_life", label: "Standard Life", tPerMillion: 34.2, source: "Standard Life DC Master Trust TCFD report 2026 (listed equity & credit, 2025)" },
    { key: "tpt", label: "TPT Retirement Solutions", tPerMillion: 28.5, source: "TPT TCFD report 2025 (DC listed equity & corporate bonds, Sep 2025)" },
    { key: "uss", label: "USS (universities)", tPerMillion: 44.2, source: "USS TCFD report 2025 (non-sovereign assets, Dec 2024)" },
    { key: "other", label: "Other / not sure", tPerMillion: 61.1, source: "Corporate Adviser ESG in DC Pensions Report 2024 (average of 20 master trusts and GPPs)" },
  ];
  // A climate-focused pension fund, used to size the "switch fund" saving:
  // Nest Ethical Fund, Scope 1+2 (Nest TCFD report 2024/25).
  // Our rating from MotherTree's figures (kg CO2e per £ held per year).
  const BANK_RATING_BANDS = [
    { max: 0.045, key: "vgood", label: "Very good" },
    { max: 0.075, key: "good", label: "Good" },
    { max: 0.15, key: "bad", label: "Bad" },
    { max: Infinity, key: "vbad", label: "Very bad" },
  ];
  // Which? and Reclaim Finance, "Which? puts major high-street banks in
  // 'red' warning category" (5 October 2023): fossil-fuel policies of 13
  // current account providers. green = Which? Eco Provider. Monzo wasn't
  // assessed.
  const WHICH_BANK_RATINGS = {
    triodos: "green", co_op: "green", nationwide: "green",
    virgin_money: "amber", starling: "amber", metro_bank: "amber",
    lloyds: "red", halifax: "red", natwest: "red", rbs: "red", santander: "red",
    chase: "red", hsbc: "red", first_direct: "red", barclays: "red",
  };
  // Make My Money Matter, Climate Action Report 2025 (February 2025):
  // the 12 largest UK workplace pension providers scored out of 10 on
  // climate commitments, targets, fossil fuels, deforestation and more.
  // Bands: 7.5+ Good, 5.0-7.4 Adequate, 2.5-4.9 Inadequate, under 2.5 Poor.
  const PENSION_CLIMATE_RANKING = [
    { key: "nest", label: "Nest", rank: "1st", score: 5.8 },
    { key: "aviva", label: "Aviva", rank: "=2nd", score: 5.5 },
    { key: "now", label: "NOW: Pensions", rank: "=2nd", score: 5.5 },
    { key: "smart", label: "Smart Pension", rank: "4th", score: 5.4 },
    { key: "lg", label: "Legal & General", rank: "5th", score: 4.8 },
    { key: "", label: "Scottish Widows", rank: "6th", score: 4.7 },
    { key: "aegon", label: "Aegon", rank: "7th", score: 4.6 },
    { key: "", label: "Cushon", rank: "8th", score: 3.9 },
    { key: "peoples", label: "The People's Pension", rank: "9th", score: 3.7 },
    { key: "fidelity", label: "Fidelity", rank: "10th", score: 3.6 },
    { key: "standard_life", label: "Standard Life", rank: "11th", score: 3.5 },
    { key: "royal_london", label: "Royal London", rank: "12th", score: 3.3 },
  ];
  const CASS_URL = "https://www.currentaccountswitch.co.uk/";

  // Hand-picked services shown on each category's guide page. "hideForDiets"
  // skips the card for people whose diet it wouldn't help. Give an item a
  // "ref" URL (an affiliate or referral link) and it's used instead of "url",
  // the tile gets an "Affiliate" tag and the disclosure line changes to say
  // so. "affiliate" notes a programme we've applied to but has no link yet.
  const USEFUL_LINKS = {
    meals: {
      eyebrow: "Make it easy",
      title: "Plant-forward food, delivered",
      hideForDiets: ["vegan", "veggie"],
      items: [
        { label: "Riverford", affiliate: "pending: Awin", url: "https://www.riverford.co.uk/", tone: "leaf", tags: ["Organic", "UK farms"], note: "Seasonal veg and recipe boxes, straight from the farm." },
        { label: "Abel & Cole", affiliate: "pending: Awin", url: "https://www.abelandcole.co.uk/", tone: "amber", tags: ["Organic", "Recipe boxes"], note: "Fruit, veg and plant-based recipe kits to your door." },
        { label: "Oddbox", affiliate: "pending: Impact", url: "https://www.oddbox.co.uk/", tone: "plum", tags: ["Cuts waste", "Good value"], note: "Wonky and surplus fruit and veg rescued from the bin." },
        { label: "Fork Ranger", url: "https://www.forkranger.com/", tone: "sky", tags: ["Free app", "Veggie recipes"], note: "Quick vegetarian recipes with a ready-made shopping list." },
      ],
    },
    commute: {
      eyebrow: "Leave the car",
      title: "Plan it by train",
      items: [
        { label: "Trainline", affiliate: "pending: Partnerize", url: "https://www.thetrainline.com/", tone: "leaf", tags: ["Times & tickets", "Railcards"], note: "Find trains, split tickets and season tickets for your commute." },
      ],
    },
    flights: {
      eyebrow: "Swap the plane",
      title: "Go by train instead",
      items: [
        { label: "Eurostar", affiliate: "pending: Partnerize", url: "https://www.eurostar.com/uk-en", tone: "amber", tags: ["City centre to centre"], note: "London to Paris, Brussels and Amsterdam in a few hours." },
        { label: "Trainline", affiliate: "pending: Partnerize", url: "https://www.thetrainline.com/", tone: "leaf", tags: ["UK & Europe"], note: "Book trains across the UK and Europe in one place." },
        { label: "The Man in Seat 61", url: "https://www.seat61.com/", tone: "sky", tags: ["Free guides"], note: "Step-by-step guides to reaching almost anywhere by rail." },
      ],
    },
    energy: {
      eyebrow: "Two-minute switch",
      title: "Power your home with renewables",
      items: [
        { label: "Good Energy", url: "https://www.goodenergy.co.uk/", tone: "leaf", tags: ["100% renewable", "UK generators"], note: "Electricity bought direct from UK wind, solar and hydro." },
        { label: "Ecotricity", affiliate: "pending: Webgains", url: "https://www.ecotricity.co.uk/", tone: "sky", tags: ["Green gas", "Not-for-dividend"], note: "Profits go into building new renewables." },
        { label: "Octopus Energy", url: "https://octopus.energy/", tone: "plum", tags: ["Smart tariffs", "EV & heat pumps"], note: "Renewable tariffs plus cheap off-peak power." },
      ],
    },
    banking: {
      eyebrow: "Seven-day switch",
      title: "Move to a greener bank",
      items: [
        { label: "Triodos", url: "https://www.triodos.co.uk/current-accounts/current-account", tone: "leaf", tags: ["Top rated", "Ethical lending"], note: "Only lends to social and environmental projects." },
        { label: "The Co-operative Bank", url: "https://www.co-operativebank.co.uk/products/bank-accounts/switch-to-us/", tone: "sky", tags: ["Which? Eco Provider"], note: "Ethical policy rules out fossil-fuel finance." },
        { label: "Nationwide", url: "https://www.nationwide.co.uk/current-accounts/switch/", tone: "amber", tags: ["Which? Eco Provider", "Member-owned"], note: "Building society that lends mainly for UK homes." },
      ],
    },
  };


  const GREEN_PENSION_T_PER_MILLION = 21;

  // Per-category "why / how to reduce" content and suggested habits.
  const EXPLAINERS = {
  "meals": {
    "title": "Meals & Diet",
    "fact": "A single beef portion can emit more than a week of plant-based meals.",
    "icon": "🍽️",
    "why": "What you eat is usually the single biggest lever in your personal footprint. Food production — especially animal agriculture — drives a large share of global emissions, plus land and water use. The good news: small, repeated swaps beat rare drastic changes.",
    "sections": [
      {
        "heading": "Cut red meat first",
        "body": "Beef and lamb are outliers — a single beef portion can emit more than a week of plant-based meals. If you eat red meat, replacing 2–3 of those meals a week with chicken, fish, or a plant-based option is the highest-impact change you can make."
      },
      {
        "heading": "Rethink dairy if you're vegetarian",
        "body": "Once red meat is gone, cheese and dairy become the dominant food emission. Hard cheeses (cheddar, parmesan, mozzarella) are the worst offenders. Try oat or soy milk, nutritional yeast for cheesy flavour, and reserve cheese for meals where it really matters."
      },
      {
        "heading": "Eat more plants, not necessarily 100%",
        "body": "You don't have to go fully vegan to see gains. Two or three plant-based days a week already captures most of the benefit. Build a short list of go-to plant-based recipes you actually enjoy so the swap sticks."
      },
      {
        "heading": "Tackle food waste",
        "body": "Roughly a third of food is wasted, and wasted food means wasted emissions. Meal-plan, shop with a list, store food properly, and use leftovers. Cutting your waste by even 10% noticeably lowers your footprint."
      }
    ],
    "habits": [
      {
        "id": "meatless_mon",
        "label": "Meatless Monday",
        "tip": "One fully plant-based day each week to start."
      },
      {
        "id": "beef_cap",
        "label": "Cap beef to 1×/week",
        "tip": "Limit red-meat days rather than cutting cold turkey."
      },
      {
        "id": "plant_recipes",
        "label": "Learn 3 plant-based recipes",
        "tip": "Having go-tos makes the swap effortless."
      },
      {
        "id": "oat_milk",
        "label": "Switch to plant milk",
        "tip": "Oat milk has {{oat_cut}} less impact than dairy."
      },
      {
        "id": "meal_plan",
        "label": "Meal-plan weekly",
        "tip": "Cuts impulse buys and food waste together."
      },
      {
        "id": "leftover_night",
        "label": "Weekly leftover night",
        "tip": "Use up what's in the fridge once a week."
      }
    ]
  },
  "commute": {
    "title": "Commute & Travel",
    "fact": "An electric car emits {{ev_share}} as much per kilometre as a petrol one on today's grid.",
    "icon": "🚗",
    "why": "How you get around day-to-day adds up fast. A petrol car commute is one of the largest personal emission sources, and it repeats 200+ times a year — so even small shifts compound into big savings.",
    "sections": [
      {
        "heading": "Drive less, not never",
        "body": "The biggest wins come from replacing car trips, not eliminating driving entirely. One or two work-from-home days, or swapping the car for transit or cycling on short trips, can cut your commute footprint by 20–40%.",
        "dynamicKey": "commuteSwap"
      },
      {
        "heading": "Pick the right alternative",
        "body": "Cycling and walking are zero-emission and add health benefits. Trains and buses spread emissions across many passengers — a full bus emits far less per person than a single-occupancy car. For trips under 5km, these are usually viable."
      },
      {
        "dynamicKey": "ifDriving",
        "heading": "If you must drive",
        "body": "Combine errands into one trip, keep tyres inflated, and avoid idling. When it's time to replace your car, an electric vehicle emits {{ev_share}} as much per km on the current grid — and far less on a green tariff."
      },
      {
        "heading": "Rethink the trip itself",
        "body": "Can the meeting be a video call? Can two nearby errands merge into one journey? The cleanest kilometre is the one you never drive."
      }
    ],
    "habits": [
      {
        "id": "wfh_day",
        "label": "1 WFH day/week",
        "tip": "Removes a full commute day from your footprint."
      },
      {
        "id": "cycle_short",
        "label": "Cycle trips under 3km",
        "tip": "Replace short car hops with a bike."
      },
      {
        "id": "transit_day",
        "label": "Transit 2×/week",
        "tip": "Take the bus or train on chosen days."
      },
      {
        "id": "errand_batch",
        "label": "Batch errands",
        "tip": "Group trips to avoid repeated journeys."
      },
      {
        "id": "no_idle",
        "label": "No idling",
        "tip": "Turn off the engine when stopped."
      },
      {
        "id": "ev_next",
        "label": "Plan EV for next car",
        "tip": "Research models and charging options early."
      }
    ]
  },
  "flights": {
    "title": "Flights",
    "fact": "A London–New York return in economy is about {{ny_t}} t CO₂e, roughly {{ny_share}} of a yearly 1.5°C budget.",
    "icon": "✈️",
    "why": "Flying is often the largest single chunk of a personal footprint. One long-haul return flight can emit more than an entire year of driving. Because flights are occasional but huge, they can quietly dominate your annual total.",
    "sections": [
      {
        "heading": "Fly less, and shorter",
        "body": "Every flight has a major impact. A London–New York return in economy is about {{ny_t}} tonnes CO₂e — roughly {{ny_share}} of one person's yearly 1.5°C budget. London–Paris and back by plane is about {{paris_plane}} kg; by Eurostar, about {{paris_train}} kg.",
        "dynamicKey": "flightTiers"
      },
      {
        "heading": "Take the train where you can",
        "body": "For routes under ~{{swap_km}} km, high-speed rail can be faster door-to-door once you factor in airport time, and emits a fraction as much. Many city pairs in Europe are well-served by rail.",
        "dynamicKey": "trainComparison"
      },
      {
        "heading": "Fly economy, direct, daytime",
        "body": "Economy seats spread the plane's emissions across more people. Business and first-class can double or triple your share. Direct flights avoid the extra emissions of multiple takeoffs, and daytime flights reduce contrail warming.",
        "dynamicKey": "cabinComparison"
      },
      {
        "heading": "Be cautious with offsets",
        "body": "Carbon offsets can help but aren't a free pass — many are low-quality. If you offset, choose verified schemes, and treat it as a last resort after reducing flights."
      }
    ],
    "habits": [
      {
        "id": "flight_budget",
        "label": "Set an annual flight cap",
        "tip": "e.g. max 1 short-haul flight/year."
      },
      {
        "id": "train_short",
        "label": "Train under {{swap_km}} km",
        "tip": "Default to rail for shorter routes."
      },
      {
        "id": "economy_only",
        "label": "Always fly economy",
        "tip": "Spreads emissions across more passengers."
      },
      {
        "id": "direct_flights",
        "label": "Prefer direct routes",
        "tip": "Avoid extra takeoff emissions."
      },
      {
        "id": "combine_trips",
        "label": "Combine multi-stop trips",
        "tip": "One longer trip beats several short ones."
      },
      {
        "id": "virtual_meeting",
        "label": "Virtual before flying",
        "tip": "Ask if a video call replaces the trip."
      }
    ]
  },
  "energy": {
    "title": "Home Energy",
    "fact": "A renewable tariff can cut electricity emissions by {{green_cut}}, with no new equipment.",
    "icon": "⚡",
    "why": "Heating and powering your home is a major, recurring emission source. Because it runs every day, efficiency gains compound — and many changes are one-time decisions that keep paying off for years.",
    "sections": [
      {
        "heading": "Switch to a green tariff",
        "body": "This is the single easiest high-impact change. Moving to a renewable electricity tariff can cut your electricity emissions by {{green_cut}} with a few clicks — no behaviour change required. Many green tariffs are price-competitive."
      },
      {
        "heading": "Use less, smartly",
        "body": "Drop heating by 1°C to save ~8% on heating energy. Wash clothes at 30°C, air-dry instead of tumble-drying, switch to LED bulbs, and turn things off fully (not standby). Each is small but they stack."
      },
      {
        "heading": "Insulate and draught-proof",
        "body": "A well-insulated home needs less energy to stay warm. Loft insulation, draught strips on doors and windows, and radiator reflectors are low-cost with fast payback. If you own the home, cavity wall and double-glazing are bigger investments worth planning."
      },
      {
        "heading": "Electrify heating when you can",
        "body": "Gas boilers burn fossil fuels on-site. A heat pump runs on electricity (ideally green) and is far more efficient. When your boiler needs replacing, a heat pump is the long-term answer."
      }
    ],
    "habits": [
      {
        "id": "green_tariff",
        "label": "Switch to a green tariff",
        "tip": "One-time, huge ongoing impact."
      },
      {
        "id": "thermostat_1c",
        "label": "Lower thermostat 1°C",
        "tip": "~8% less heating energy."
      },
      {
        "id": "wash_30",
        "label": "Wash at 30°C",
        "tip": "Cuts laundry energy significantly."
      },
      {
        "id": "air_dry",
        "label": "Air-dry laundry",
        "tip": "Skip the tumble dryer when possible."
      },
      {
        "id": "led_bulbs",
        "label": "Switch to LEDs",
        "tip": "Replace bulbs as they go."
      },
      {
        "id": "standby_off",
        "label": "Kill standby power",
        "tip": "Turn devices fully off at night."
      }
    ]
  },
  "water": {
    "title": "Water",
    "fact": "A dripping tap can waste thousands of litres a year.",
    "icon": "💧",
    "why": "Treating and pumping water — and especially heating it — uses energy. It's a smaller slice of your footprint than food or energy, but the fixes are cheap, immediate, and often save money too.",
    "sections": [
      {
        "heading": "Cut hot water use",
        "body": "Hot water carries the energy cost of heating it. Shorter showers (aim for 4–5 minutes), low-flow showerheads, and washing in cold water all reduce both water and energy at once."
      },
      {
        "heading": "Fix leaks fast",
        "body": "A dripping tap can waste thousands of litres a year. Fixing leaks is cheap and stops a constant, invisible drain."
      },
      {
        "heading": "Be tap-aware",
        "body": "Turn the tap off while brushing teeth or soaping dishes. Only run full loads in dishwashers and washing machines — modern full-load cycles are more efficient than hand-washing."
      },
      {
        "heading": "Collect rainwater",
        "body": "If you have a garden, a water butt collects free rainwater for plants, cutting mains use in summer."
      }
    ],
    "habits": [
      {
        "id": "short_shower",
        "label": "4-minute showers",
        "tip": "Use a shower timer or a song."
      },
      {
        "id": "low_flow",
        "label": "Fit a low-flow showerhead",
        "tip": "One-time install, years of savings."
      },
      {
        "id": "tap_off",
        "label": "Tap off while brushing",
        "tip": "Saves up to 6L per brush."
      },
      {
        "id": "full_loads",
        "label": "Full loads only",
        "tip": "Run appliances only when full."
      },
      {
        "id": "fix_leaks",
        "label": "Fix drips within a week",
        "tip": "Don't let taps linger."
      },
      {
        "id": "rain_butt",
        "label": "Use a water butt",
        "tip": "Free rainwater for the garden."
      }
    ]
  },
  "pets": {
    "title": "Pets",
    "fact": "A medium dog's food can emit as much as a small car over a year.",
    "icon": "🐾",
    "why": "Pet food — especially meat-based diets — can make a surprising contribution. A medium dog's food can emit as much as a small car over a year. You don't need to give up a pet, but diet choices matter.",
    "sections": [
      {
        "heading": "Choose lower-impact pet food",
        "body": "Many premium pet foods use high-value cuts; others use by-products that would otherwise be wasted, which is far lower-impact. Look for brands that use by-product or sustainable proteins, and avoid beef-heavy formulas."
      },
      {
        "heading": "Feed the right amount",
        "body": "Overfeeding wastes food and causes obesity. Follow vet guidance on portion size — it's better for your pet and the planet."
      },
      {
        "heading": "Consider alternative proteins",
        "body": "Some brands now offer insect-based or plant-augmented dog food with a much lower footprint. Discuss suitability with your vet before switching."
      }
    ],
    "habits": [
      {
        "id": "sustainable_food",
        "label": "Switch to a by-product food",
        "tip": "Lower-impact protein, same nutrition."
      },
      {
        "id": "right_portion",
        "label": "Measure portions",
        "tip": "Avoid overfeeding and waste."
      },
      {
        "id": "no_beef_food",
        "label": "Avoid beef-based formulas",
        "tip": "Beef is the highest-impact meat."
      },
      {
        "id": "alt_protein",
        "label": "Try insect/alt protein",
        "tip": "Check with your vet first."
      },
      {
        "id": "buy_bulk",
        "label": "Buy in bulk",
        "tip": "Less packaging, fewer deliveries."
      }
    ]
  },
  "banking": {
    "title": "Banking & Pension",
    "fact": "The free Current Account Switch Service moves your account in 7 working days, with a guarantee.",
    "icon": "🏦",
    "why": "Your savings don't just sit in a vault — banks lend them out, and many finance fossil-fuel projects. This 'financed emission' can be one of your largest hidden contributions. Moving your money is a one-time action with a big ongoing effect.",
    "sections": [
      {
        "heading": "Check your bank's financing",
        "body": "Independent league tables rank UK banks by the emissions your money helps finance. Some high-street banks fund fossil fuels heavily; others (like Triodos and the Co-operative Bank) refuse to. Tap to see where your bank sits.",
        "dynamicKey": "bankLeague"
      },
      {
        "heading": "Switch your main account",
        "body": "The free Current Account Switch Service moves your balance, direct debits and standing orders to a new bank in 7 working days, protected by a guarantee. Tap for the link.",
        "dynamicKey": "switchAccount"
      },
      {
        "heading": "Move savings and pensions too",
        "body": "Savings accounts and especially pensions can be the biggest financed-emission lever. Ask your provider for a fossil-fuel-free or climate-focused fund. Tap to see how your pension provider ranks.",
        "dynamicKey": "savingsPensions"
      }
    ],
    "habits": [
      {
        "id": "check_bank",
        "label": "Look up your bank's rating",
        "tip": "Find its fossil-fuel financing score."
      },
      {
        "id": "switch_current",
        "label": "Switch current account",
        "tip": "Protected switching makes it easy."
      },
      {
        "id": "move_savings",
        "label": "Move savings to a green bank",
        "tip": "Redirect deposits from fossil fuels."
      },
      {
        "id": "pension_fund",
        "label": "Switch pension to ESG fund",
        "tip": "Often your single biggest lever."
      },
      {
        "id": "ask_provider",
        "label": "Ask your bank directly",
        "tip": "Pressure works alongside switching."
      }
    ]
  }
};
  const FLIGHT_TIERS = [
  {
    "tier": 1,
    "label": "Tier 1",
    "criteria": "No flights / year",
    "description": "Zero aviation emissions — the lowest-impact tier."
  },
  {
    "tier": 2,
    "label": "Tier 2",
    "criteria": "1–2 short-haul flights / year",
    "description": "Light flying. Short-haul = under ~{{short_km}} km per leg."
  },
  {
    "tier": 3,
    "label": "Tier 3",
    "criteria": "3–4 short-haul or 1–2 medium-haul flights / year",
    "description": "Moderate flying. Medium-haul = {{short_km}}–{{medium_km}} km."
  },
  {
    "tier": 4,
    "label": "Tier 4",
    "criteria": "≥5 short-haul, ≥3 medium-haul, or >1 long-haul flights / year",
    "description": "Heavy flying. Long-haul = over {{medium_km}} km. A single long-haul return can exceed your entire 1.5°C annual budget."
  }
];
  // Diet-specific replacements for the Meals explainer's sections + habits.
  const DIET_EXPLAINERS = {
  "red_meat_high": {
    "sections": [
      {
        "heading": "Drop a red-meat day or two",
        "body": "You're eating red meat more than twice a week — your single biggest food lever. Cutting to 1–2 red-meat days and filling the gap with chicken, fish or plant-based meals saves hundreds of kilograms a year, and about {{three_beef_days}} kg if three of them are beef days."
      },
      {
        "heading": "Choose chicken over beef",
        "body": "A beef day emits {{beef_vs_chicken}} a chicken day and {{beef_vs_vegan}} a vegan day. When you do keep meat, chicken or fish trims the impact sharply."
      },
      {
        "heading": "Build a few plant-based go-tos",
        "body": "Have 2–3 vegan meals you actually enjoy so the swap sticks rather than feeling like a sacrifice."
      },
      {
        "heading": "Tackle food waste",
        "body": "Roughly a third of food is wasted — wasted emissions. Meal-plan, shop with a list, and use leftovers to cut your footprint further."
      }
    ],
    "habits": [
      {
        "id": "red_meat_cap2",
        "label": "Cap red meat to 2×/week",
        "tip": "Limit red-meat days rather than cutting cold turkey."
      },
      {
        "id": "one_meatless_day",
        "label": "One meatless day/week",
        "tip": "Start with a single fully plant-based day."
      },
      {
        "id": "chicken_over_beef",
        "label": "Choose chicken over beef",
        "tip": "Swap the highest-impact meat first."
      },
      {
        "id": "plant_recipes",
        "label": "Learn 3 plant-based recipes",
        "tip": "Go-tos make the swap effortless."
      },
      {
        "id": "meal_plan",
        "label": "Meal-plan weekly",
        "tip": "Cuts impulse buys and food waste."
      },
      {
        "id": "leftover_night",
        "label": "Weekly leftover night",
        "tip": "Use up what's in the fridge."
      }
    ]
  },
  "red_meat_low": {
    "sections": [
      {
        "heading": "You're nearly there with red meat",
        "body": "Keeping red meat to 1–2 days a week is a strong start. Each extra red-meat day you swap out compounds into meaningful savings."
      },
      {
        "heading": "Replace one more red-meat day",
        "body": "Swapping a second weekly red-meat day for chicken, fish or a plant-based meal is your clearest next step."
      },
      {
        "heading": "Build plant-based go-tos",
        "body": "Two or three plant-based meals you enjoy turn the occasional swap into a habit."
      },
      {
        "heading": "Tackle food waste",
        "body": "Meal-plan, shop with a list, and use leftovers — cutting waste lowers footprint for free."
      }
    ],
    "habits": [
      {
        "id": "red_meat_one",
        "label": "Cap red meat at 1×/week",
        "tip": "Step down from your current 1–2 days."
      },
      {
        "id": "one_meatless_day",
        "label": "One meatless day/week",
        "tip": "Add a fully plant-based day."
      },
      {
        "id": "chicken_over_beef",
        "label": "Choose chicken over beef",
        "tip": "When you eat meat, pick the lower-impact one."
      },
      {
        "id": "plant_recipes",
        "label": "Learn 3 plant-based recipes",
        "tip": "Go-tos make the swap stick."
      },
      {
        "id": "meal_plan",
        "label": "Meal-plan weekly",
        "tip": "Cuts impulse buys and waste."
      },
      {
        "id": "leftover_night",
        "label": "Weekly leftover night",
        "tip": "Use up what's in the fridge."
      }
    ]
  },
  "other_meat": {
    "sections": [
      {
        "heading": "You've already cut red meat — great",
        "body": "Avoiding beef and lamb is the hardest part, and you've done it. Your remaining meat (chicken and fish) is lower-impact than red meat, but plants still beat it."
      },
      {
        "heading": "Add a plant-based day or two",
        "body": "Swapping 1–2 chicken or fish days a week for a vegan meal is your clearest next lever, since these are your highest-impact meals now."
      },
      {
        "heading": "Mind your fish sourcing",
        "body": "Choose sustainably caught, lower-impact fish. Some species and farming methods carry a much heavier footprint than others."
      },
      {
        "heading": "Tackle food waste",
        "body": "Meal-plan, shop with a list, and use leftovers to keep trimming your footprint."
      }
    ],
    "habits": [
      {
        "id": "one_meatless_day",
        "label": "One meatless day/week",
        "tip": "Swap a chicken/fish day for plants."
      },
      {
        "id": "plant_recipes",
        "label": "Learn 3 plant-based recipes",
        "tip": "Go-tos make the swap easy."
      },
      {
        "id": "sustainable_fish",
        "label": "Choose sustainable fish",
        "tip": "Check ratings before buying."
      },
      {
        "id": "oat_milk",
        "label": "Switch to plant milk",
        "tip": "Oat milk has {{oat_cut}} less impact than dairy."
      },
      {
        "id": "meal_plan",
        "label": "Meal-plan weekly",
        "tip": "Cuts impulse buys and waste."
      },
      {
        "id": "leftover_night",
        "label": "Weekly leftover night",
        "tip": "Use up what's in the fridge."
      }
    ]
  },
  "pescatarian": {
    "sections": [
      {
        "heading": "Pescatarian is already low-impact",
        "body": "Fish carries a smaller footprint than meat, which is a solid base. Plants still beat fish, though, so there's room to go further."
      },
      {
        "heading": "Add plant-based days",
        "body": "Swapping one or two fish days a week for a vegan meal is your clearest next step."
      },
      {
        "heading": "Mind your fish sourcing",
        "body": "Choose sustainably caught, lower-impact fish — some species and methods carry a far heavier footprint than others."
      },
      {
        "heading": "Watch dairy & cheese",
        "body": "With meat off the menu, cheese and dairy are now your biggest food-emission driver. Try oat or soy milk and reserve hard cheeses for meals where they matter."
      }
    ],
    "habits": [
      {
        "id": "fish_free_day",
        "label": "One fish-free day/week",
        "tip": "Swap a fish day for plants."
      },
      {
        "id": "plant_recipes",
        "label": "Learn 3 plant-based recipes",
        "tip": "Go-tos make the swap easy."
      },
      {
        "id": "sustainable_fish",
        "label": "Choose sustainable fish",
        "tip": "Check ratings before buying."
      },
      {
        "id": "oat_milk",
        "label": "Switch to plant milk",
        "tip": "{{oat_cut}} less impact than dairy."
      },
      {
        "id": "meal_plan",
        "label": "Meal-plan weekly",
        "tip": "Cuts impulse buys and waste."
      },
      {
        "id": "leftover_night",
        "label": "Weekly leftover night",
        "tip": "Use up what's in the fridge."
      }
    ]
  },
  "veggie": {
    "sections": [
      {
        "heading": "Cheese & dairy are now your biggest lever",
        "body": "With meat and fish off the menu, dairy — especially cheese — dominates your food emissions. This is where your gains are."
      },
      {
        "heading": "Swap dairy for plant milks",
        "body": "Oat and soy milk have {{oat_cut}} less impact than cow's milk. An easy, high-frequency swap."
      },
      {
        "heading": "Use nutritional yeast for cheesy flavour",
        "body": "Hard cheeses like cheddar and parmesan are the worst offenders. Nutritional yeast gives a savoury, cheesy hit at a fraction of the footprint."
      },
      {
        "heading": "Tackle food waste",
        "body": "Meal-plan, shop with a list, and use leftovers to keep trimming your footprint."
      }
    ],
    "habits": [
      {
        "id": "oat_milk",
        "label": "Switch to plant milk",
        "tip": "Oat/soy {{oat_cut}} less impact than dairy."
      },
      {
        "id": "less_cheese",
        "label": "Cut cheese by half",
        "tip": "Reserve it for meals where it matters."
      },
      {
        "id": "nutritional_yeast",
        "label": "Try nutritional yeast",
        "tip": "Cheesy flavour at a fraction of the footprint."
      },
      {
        "id": "plant_recipes",
        "label": "Learn 3 vegan recipes",
        "tip": "Move toward more fully plant-based days."
      },
      {
        "id": "meal_plan",
        "label": "Meal-plan weekly",
        "tip": "Cuts impulse buys and waste."
      },
      {
        "id": "leftover_night",
        "label": "Weekly leftover night",
        "tip": "Use up what's in the fridge."
      }
    ]
  },
  "vegan": {
    "sections": [
      {
        "heading": "Your diet is already the lowest-impact 🌱",
        "body": "A vegan diet has the lowest food footprint of any eating pattern. Your remaining food gains are smaller and come from how you eat, not what."
      },
      {
        "heading": "Focus on food waste",
        "body": "About a third of food is wasted, and wasted food is wasted emissions. Meal-planning and using leftovers is your biggest remaining food lever."
      },
      {
        "heading": "Eat seasonal & local",
        "body": "Choosing in-season, locally grown produce cuts transport and storage emissions — and usually tastes better."
      },
      {
        "heading": "Look beyond food",
        "body": "With your diet sorted, your largest opportunities are likely in other categories — commuting, flights, energy or banking. Check those next."
      }
    ],
    "habits": [
      {
        "id": "meal_plan",
        "label": "Meal-plan weekly",
        "tip": "Your biggest remaining food lever."
      },
      {
        "id": "leftover_night",
        "label": "Weekly leftover night",
        "tip": "Use up what's in the fridge."
      },
      {
        "id": "seasonal_produce",
        "label": "Eat seasonal produce",
        "tip": "Cuts transport and storage emissions."
      },
      {
        "id": "local_first",
        "label": "Shop local where possible",
        "tip": "Shorter supply chains, fresher food."
      },
      {
        "id": "waste_audit",
        "label": "Track food waste a week",
        "tip": "See where your waste really comes from."
      },
      {
        "id": "bulk_pantry",
        "label": "Buy beans & grains in bulk",
        "tip": "Less packaging, fewer deliveries."
      }
    ]
  }
};
  // Habits that are one-off goals (with a deadline) rather than daily ones.
  // Assumptions the app's sums use (all editable on the admin Inputs page).
  const ASSUMPTIONS = {
    HEAT_PUMP_COP: 3, // kWh of heat per kWh of electricity
    LAND_ROUTE_UPLIFT: 1.25, // straight line between two towns -> road or rail distance
    PARIS_FLIGHT_KG: 123, // London–Paris return by plane, per person (Eurostar)
    PARIS_TRAIN_KG: 4, // London–Paris return by Eurostar, per person (Eurostar)
    TREE_KG: 20, // CO2 a mature tree absorbs in a year
    PHONE_KG: 61, // making a smartphone and charging it for a year
    ACTIVE_TRAVEL_MAX_KM: 10, // one way; beyond this, train or bus is the realistic swap
    SHORT_HAUL_KM: 1500, // flight tiers: short-haul is under this
    TRAIN_SWAP_MAX_KM: 700, // flights up to this can realistically go by train
    MEDIUM_HAUL_MAX_KM: 4000, // flight tiers: medium-haul is up to this, long-haul beyond
    WATER_CUT: 0.2, // realistic share of water saved
    WATER_CUT_MAX: 0.4,
    PET_FOOD_CUT: 0.25, // realistic cut from lower-impact pet food
    PET_FOOD_CUT_MAX: 0.5,
    DAIRY_MILK_KG: 3.15, // per litre (Poore & Nemecek 2018)
    OAT_MILK_KG: 0.9,
    UK_TOTAL_KG: (699201.9 / 68265) * 1000, // full UK footprint per person (Defra 2023)
    EXAMPLE_SAVINGS: 5000, // £ in a bank, for the Greener switches example
  };

  // Every figure the admin can change on the Inputs page (#/inputs). "path"
  // points at the value in this file: NAME, NAME.field or LIST[key].field.
  // "asOf" is when the source was published and "every" how many months
  // until a new edition is due, for the update reminders.
  const DESNZ_2026 = "UK Government GHG conversion factors 2026 (DESNZ), incl. well-to-tank";
  const DESNZ_FLIGHTS = "UK Government GHG conversion factors 2026 (DESNZ, same as 2025), business travel air with radiative forcing, plus well-to-tank";
  const DEFRA_FOOTPRINT = "Defra UK carbon footprint 2023 (published June 2026) ÷ ONS mid-2023 UK population (68.265m)";
  const PN2018 = "Poore & Nemecek (2018), Science 360:987, global mean per kg of product (via Our World in Data)";
  const CR2025 = "Choręziak & Rzymski (2025), Nutrients 17:1377: measured daily footprint of the diet group";
  const INPUT_DEFS = [
    { group: "Benchmark", key: "budget", label: "1.5°C budget per person", unit: "kg CO₂e a year", path: "BUDGET_YEARLY", source: "About 2.5 t per person per year by 2030 (Hot or Cool Institute, 1.5-Degree Lifestyles, 2021)" },
    { group: "Food", key: "food_vegan_day", label: "Vegan day", unit: "kg CO₂e a day", path: "MEAL_OPTIONS[vegan].factor", source: CR2025, asOf: "2025-04", every: 36 },
    { group: "Food", key: "food_veggie_day", label: "Vegetarian day", unit: "kg CO₂e a day", path: "MEAL_OPTIONS[veggie].factor", source: CR2025 + ". Meat days are this plus a portion of meat.", asOf: "2025-04", every: 36 },
    { group: "Food", key: "food_fish_day", label: "Fish day", unit: "kg CO₂e a day", path: "MEAL_OPTIONS[fish].factor", source: CR2025 + " (fish-eater group)", asOf: "2025-04", every: 36 },
    { group: "Food", key: "meat_chicken", label: "Chicken (poultry meat)", unit: "kg CO₂e per kg", path: "MEAT_PER_KG.chicken", source: PN2018, asOf: "2018-06", every: 96 },
    { group: "Food", key: "meat_pork", label: "Pork (pig meat)", unit: "kg CO₂e per kg", path: "MEAT_PER_KG.pork", source: PN2018, asOf: "2018-06", every: 96 },
    { group: "Food", key: "meat_beef", label: "Beef (beef herd)", unit: "kg CO₂e per kg", path: "MEAT_PER_KG.beef", source: PN2018, asOf: "2018-06", every: 96 },
    { group: "Food", key: "meat_lamb", label: "Lamb and mutton", unit: "kg CO₂e per kg", path: "MEAT_PER_KG.lamb", source: PN2018, asOf: "2018-06", every: 96 },
    { group: "Food", key: "portion", label: "Meat in a main meal", unit: "kg", path: "PORTION", source: "Survey assumption: a medium 150 g portion" },
    { group: "Food", key: "eat_out", label: "Eating out", unit: "× a home-cooked day", path: "EAT_OUT_MULTIPLIER", source: "RESOLVE working paper 02-10" },
    { group: "Food", key: "waste_low", label: "Food waste: low (0–3%)", unit: "× food", path: "FOOD_WASTE[low].multiplier", source: "Midpoint of the bracket, as 1 ÷ (1 − share wasted)" },
    { group: "Food", key: "waste_some", label: "Food waste: some (3–10%)", unit: "× food", path: "FOOD_WASTE[some].multiplier", source: "Midpoint of the bracket, as 1 ÷ (1 − share wasted)" },
    { group: "Food", key: "waste_high", label: "Food waste: high (10–25%)", unit: "× food", path: "FOOD_WASTE[high].multiplier", source: "Midpoint of the bracket, as 1 ÷ (1 − share wasted)" },
    { group: "Food", key: "waste_severe", label: "Food waste: severe (25%+)", unit: "× food", path: "FOOD_WASTE[severe].multiplier", source: "As 1 ÷ (1 − share wasted)" },
    { group: "Travel", key: "train", label: "Train (national rail)", unit: "kg CO₂e per km", path: "COMMUTE_MODES[train].factor", source: DESNZ_2026, asOf: "2026-06", every: 12 },
    { group: "Travel", key: "tube", label: "Tube (London Underground)", unit: "kg CO₂e per km", path: "COMMUTE_MODES[tube].factor", source: DESNZ_2026, asOf: "2026-06", every: 12 },
    { group: "Travel", key: "bus", label: "Bus", unit: "kg CO₂e per km", path: "COMMUTE_MODES[bus].factor", source: DESNZ_2026 + " (average local bus)", asOf: "2026-06", every: 12 },
    { group: "Travel", key: "ev", label: "Electric car", unit: "kg CO₂e per km", path: "COMMUTE_MODES[ev].factor", source: DESNZ_2026 + " (battery electric, average car)", asOf: "2026-06", every: 12 },
    { group: "Travel", key: "car_petrol", label: "Petrol car", unit: "kg CO₂e per km", path: "COMMUTE_MODES[car_petrol].factor", source: DESNZ_2026 + " (average car). Also used for every “the same as driving” figure.", asOf: "2026-06", every: 12 },
    { group: "Travel", key: "car_diesel", label: "Diesel car", unit: "kg CO₂e per km", path: "COMMUTE_MODES[car_diesel].factor", source: DESNZ_2026 + " (average car)", asOf: "2026-06", every: 12 },
    { group: "Travel", key: "motorcycle", label: "Motorcycle", unit: "kg CO₂e per km", path: "COMMUTE_MODES[motorcycle].factor", source: "No source recorded yet" },
    { group: "Travel", key: "coach", label: "Coach", unit: "kg CO₂e per km", path: "TRAVEL_MODES[coach].factor", source: DESNZ_2026, asOf: "2026-06", every: 12 },
    { group: "Travel", key: "intl_rail", label: "International train", unit: "kg CO₂e per km", path: "TRAVEL_MODES[intl_rail].factor", source: DESNZ_2026 + " (international rail, e.g. Eurostar)", asOf: "2026-06", every: 12 },
    { group: "Travel", key: "land_uplift", label: "Road or rail distance vs straight line", unit: "×", path: "ASSUMPTIONS.LAND_ROUTE_UPLIFT", source: "App assumption: roads and railways wind. Checked against London–Exeter, London–Paris and Manchester–Edinburgh." },
    { group: "Flights", key: "fly_domestic", label: "Domestic UK flight", unit: "kg CO₂e per km", path: "FLIGHT_DOMESTIC_FACTOR", source: DESNZ_FLIGHTS + " (average passenger)", asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_short_economy", label: "Short-haul economy", unit: "kg CO₂e per km", path: "CABINS[economy].short", source: DESNZ_FLIGHTS, asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_short_premium", label: "Short-haul premium economy", unit: "kg CO₂e per km", path: "CABINS[premium].short", source: DESNZ_FLIGHTS + ". DESNZ has no short-haul premium, so this uses economy.", asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_short_business", label: "Short-haul business", unit: "kg CO₂e per km", path: "CABINS[business].short", source: DESNZ_FLIGHTS, asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_short_first", label: "Short-haul first", unit: "kg CO₂e per km", path: "CABINS[first].short", source: DESNZ_FLIGHTS + ". DESNZ has no short-haul first, so this uses business.", asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_long_economy", label: "Long-haul economy", unit: "kg CO₂e per km", path: "CABINS[economy].long", source: DESNZ_FLIGHTS, asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_long_premium", label: "Long-haul premium economy", unit: "kg CO₂e per km", path: "CABINS[premium].long", source: DESNZ_FLIGHTS, asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_long_business", label: "Long-haul business", unit: "kg CO₂e per km", path: "CABINS[business].long", source: DESNZ_FLIGHTS, asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_long_first", label: "Long-haul first", unit: "kg CO₂e per km", path: "CABINS[first].long", source: DESNZ_FLIGHTS, asOf: "2026-06", every: 12 },
    { group: "Flights", key: "fly_long_km", label: "Long-haul starts at", unit: "km", path: "FLIGHT_LONG_HAUL_KM", source: "DESNZ definition: short-haul is up to 3,700 km" },
    { group: "Flights", key: "fly_uplift", label: "Routing uplift on flight distance", unit: "×", path: "FLIGHT_DISTANCE_UPLIFT", source: "DESNZ guidance: add 8% for indirect routes and holding" },
    { group: "Flights", key: "paris_plane", label: "London–Paris return by plane", unit: "kg CO₂e per person", path: "ASSUMPTIONS.PARIS_FLIGHT_KG", source: "Eurostar (independently commissioned figures)" },
    { group: "Flights", key: "paris_train", label: "London–Paris return by Eurostar", unit: "kg CO₂e per person", path: "ASSUMPTIONS.PARIS_TRAIN_KG", source: "Eurostar (independently commissioned figures). The train-vs-plane ratio for other trips comes from these two." },
    { group: "Home", key: "electricity", label: "Grid electricity", unit: "kg CO₂e per kWh", path: "ELECTRICITY_FACTOR", source: "UK Government GHG conversion factors 2025 (DESNZ): generation + transmission & distribution + well-to-tank", asOf: "2025-06", every: 12 },
    { group: "Home", key: "electricity_green", label: "Renewable tariff electricity", unit: "kg CO₂e per kWh", path: "GREEN_ELECTRICITY_FACTOR", source: "No source recorded yet" },
    { group: "Home", key: "gas", label: "Mains gas", unit: "kg CO₂e per kWh", path: "GAS_FACTOR", source: "UK Government GHG conversion factors 2025 (DESNZ), gross CV + well-to-tank", asOf: "2025-06", every: 12 },
    { group: "Home", key: "water", label: "Mains water", unit: "kg CO₂e per 1,000 L", path: "WATER_FACTOR", source: DESNZ_2026 + ": supply + treatment", asOf: "2026-06", every: 12 },
    { group: "Home", key: "heat_pump_cop", label: "Heat pump efficiency (COP)", unit: "kWh heat per kWh", path: "ASSUMPTIONS.HEAT_PUMP_COP", source: "App assumption for the “going all the way” saving" },
    { group: "Pets", key: "dog", label: "Dog", unit: "kg CO₂e a year", path: "DOG_YEARLY", source: "No source recorded yet" },
    { group: "Pets", key: "cat", label: "Cat", unit: "kg CO₂e a year", path: "CAT_YEARLY", source: "No source recorded yet" },
  ];
  BANKS.forEach((b) => INPUT_DEFS.push({ group: "Banks", key: "bank_" + b.key, label: b.label, unit: "kg CO₂e per £ a year", path: "BANKS[" + b.key + "].factor", source: "MotherTree bank carbon emissions league table (2021)", asOf: "2021-06", every: 12 }));
  PENSION_PROVIDERS.forEach((p) => INPUT_DEFS.push({ group: "Pensions", key: "pension_" + p.key, label: p.label, unit: "t CO₂e per £1m", path: "PENSION_PROVIDERS[" + p.key + "].tPerMillion", source: p.source, asOf: "2025-06", every: 12 }));
  INPUT_DEFS.push(
    { group: "Pensions", key: "pension_green", label: "Climate-focused fund (saving benchmark)", unit: "t CO₂e per £1m", path: "GREEN_PENSION_T_PER_MILLION", source: "Nest Ethical Fund, Nest TCFD report 2024/25", asOf: "2025-06", every: 12 },
    { group: "Shared and assumed", key: "shop_clothes", label: "Assumed shopping: clothes and shoes", unit: "kg CO₂e a year", path: "ASSUMED_SHOPPING.clothesKg", source: DEFRA_FOOTPRINT, asOf: "2026-06", every: 12 },
    { group: "Shared and assumed", key: "shop_household", label: "Assumed shopping: household goods", unit: "kg CO₂e a year", path: "ASSUMED_SHOPPING.householdKg", source: DEFRA_FOOTPRINT, asOf: "2026-06", every: 12 },
    { group: "Shared and assumed", key: "shop_electronics", label: "Assumed shopping: electronics and phones", unit: "kg CO₂e a year", path: "ASSUMED_SHOPPING.electronicsKg", source: DEFRA_FOOTPRINT, asOf: "2026-06", every: 12 },
    { group: "Shared and assumed", key: "shop_hobbies", label: "Assumed shopping: hobbies and leisure", unit: "kg CO₂e a year", path: "ASSUMED_SHOPPING.hobbiesKg", source: DEFRA_FOOTPRINT, asOf: "2026-06", every: 12 },
    { group: "Shared and assumed", key: "shared_services", label: "Shared: public services", unit: "kg CO₂e a year", path: "SHARED_FOOTPRINT.publicServicesKg", source: DEFRA_FOOTPRINT, asOf: "2026-06", every: 12 },
    { group: "Shared and assumed", key: "shared_infra", label: "Shared: infrastructure and investment", unit: "kg CO₂e a year", path: "SHARED_FOOTPRINT.infrastructureKg", source: DEFRA_FOOTPRINT, asOf: "2026-06", every: 12 },
    { group: "Benchmark", key: "uk_total", label: "Full UK footprint per person", unit: "kg CO₂e a year", path: "ASSUMPTIONS.UK_TOTAL_KG", source: DEFRA_FOOTPRINT + ": total 699,201.9 kt", asOf: "2026-06", every: 12 },
    { group: "Savings assumptions", key: "active_max_km", label: "Walk or cycle commutes up to", unit: "km one way", path: "ASSUMPTIONS.ACTIVE_TRAVEL_MAX_KM", source: "App assumption: beyond this, the train or bus is the realistic swap" },
    { group: "Savings assumptions", key: "train_swap_km", label: "Train can replace flights up to", unit: "km", path: "ASSUMPTIONS.TRAIN_SWAP_MAX_KM", source: "App assumption: up to about 700 km the train is often as quick door to door. Used for the realistic flights saving and the train comparison." },
    { group: "Savings assumptions", key: "medium_haul_km", label: "Medium-haul flights go up to", unit: "km", path: "ASSUMPTIONS.MEDIUM_HAUL_MAX_KM", source: "App assumption for the flight tiers and the realistic flights saving (beyond this counts as long-haul)" },
    { group: "Savings assumptions", key: "short_haul_km", label: "Short-haul flights are under", unit: "km", path: "ASSUMPTIONS.SHORT_HAUL_KM", source: "App assumption for the flight tiers" },
    { group: "Savings assumptions", key: "water_cut", label: "Water: realistic cut", unit: "share (0–1)", path: "ASSUMPTIONS.WATER_CUT", source: "App assumption: shorter showers and fixing leaks" },
    { group: "Savings assumptions", key: "water_cut_max", label: "Water: going all the way", unit: "share (0–1)", path: "ASSUMPTIONS.WATER_CUT_MAX", source: "App assumption: efficient fittings and short showers" },
    { group: "Savings assumptions", key: "pet_cut", label: "Pets: realistic cut from lower-impact food", unit: "share (0–1)", path: "ASSUMPTIONS.PET_FOOD_CUT", source: "App assumption" },
    { group: "Savings assumptions", key: "pet_cut_max", label: "Pets: going all the way", unit: "share (0–1)", path: "ASSUMPTIONS.PET_FOOD_CUT_MAX", source: "App assumption: by-product or alternative-protein pet food" },
    { group: "UK average (for the comparison)", key: "uk_elec", label: "Household electricity", unit: "kWh a year", path: "UK_PROFILE.electricityKwh", source: "Ofgem typical domestic consumption values (2026 revision)", asOf: "2026-04", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_gas", label: "Household gas", unit: "kWh a year", path: "UK_PROFILE.gasKwh", source: "Ofgem typical domestic consumption values (2026 revision)", asOf: "2026-04", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_household", label: "People per household", unit: "people", path: "UK_PROFILE.household", source: "ONS mid-2024: 69.3m people, 28.6m households", asOf: "2025-06", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_water", label: "Water use", unit: "litres per person a day", path: "UK_PROFILE.waterLitres", source: "Consumer Council for Water (2023)", asOf: "2023-06", every: 24 },
    { group: "UK average (for the comparison)", key: "uk_flights", label: "Return flights", unit: "per person a year", path: "UK_PROFILE.flightsPerPerson", source: "ONS Travel trends 2024: 80.9m visits abroad by air ÷ 69.3m people", asOf: "2025-05", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_dogs", label: "Dogs", unit: "per person", path: "UK_PROFILE.dogsPerPerson", source: "UK Pet Food 2026: 15.5m dogs ÷ 69.3m people", asOf: "2026-03", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_cats", label: "Cats", unit: "per person", path: "UK_PROFILE.catsPerPerson", source: "UK Pet Food 2026: 13.1m cats ÷ 69.3m people", asOf: "2026-03", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_commute", label: "Commute distance", unit: "km one way, per weekday", path: "UK_PROFILE.commuteKm", source: "DfT National Travel Survey 2024: 1,007 commuting miles a person, about 3/4 by car", asOf: "2025-08", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_chicken", label: "Chicken bought", unit: "g per person a week", path: "UK_PROFILE.chickenG", source: "Defra Family Food 2023/24", asOf: "2025-03", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_pork", label: "Pork, bacon, ham and sausages bought", unit: "g per person a week", path: "UK_PROFILE.porkG", source: "Defra Family Food 2023/24", asOf: "2025-03", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_fish", label: "Fish bought", unit: "g per person a week", path: "UK_PROFILE.fishG", source: "Defra Family Food 2023/24", asOf: "2025-03", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_beef", label: "Beef bought", unit: "g per person a week", path: "UK_PROFILE.beefG", source: "Defra Family Food 2023/24", asOf: "2025-03", every: 12 },
    { group: "UK average (for the comparison)", key: "uk_lamb", label: "Lamb bought", unit: "g per person a week", path: "UK_PROFILE.lambG", source: "Defra Family Food 2023/24", asOf: "2025-03", every: 12 },
    { group: "Comparisons", key: "dairy_milk", label: "Dairy milk", unit: "kg CO₂e per litre", path: "ASSUMPTIONS.DAIRY_MILK_KG", source: PN2018, asOf: "2018-06", every: 96 },
    { group: "Comparisons", key: "oat_milk", label: "Oat milk", unit: "kg CO₂e per litre", path: "ASSUMPTIONS.OAT_MILK_KG", source: PN2018, asOf: "2018-06", every: 96 },
    { group: "Comparisons", key: "example_savings", label: "Example savings in a bank (Greener switches page)", unit: "£", path: "ASSUMPTIONS.EXAMPLE_SAVINGS", source: "Illustration only: the bank comparison on Greener switches uses this amount" },
    { group: "Comparisons", key: "tree", label: "A mature tree absorbs", unit: "kg CO₂ a year", path: "ASSUMPTIONS.TREE_KG", source: "No source recorded yet" },
    { group: "Comparisons", key: "phone", label: "Making and charging a smartphone", unit: "kg CO₂e", path: "ASSUMPTIONS.PHONE_KG", source: "No source recorded yet" }
  );
  // When the built-in figures above were last checked.
  const FIGURES_BUILT_IN = "2026-10-22";

  const GOAL_HABIT_IDS = [
  "plant_recipes",
  "ev_next",
  "green_tariff",
  "led_bulbs",
  "low_flow",
  "fix_leaks",
  "rain_butt",
  "sustainable_food",
  "no_beef_food",
  "alt_protein",
  "oat_milk",
  "nutritional_yeast",
  "waste_audit",
  "check_bank",
  "switch_current",
  "move_savings",
  "pension_fund",
  "ask_provider"
];

  window.ECO_DATA = {
    DEFAULT_SURVEY, DAYS, WEEKS_PER_YEAR, UK_TYPICAL_SURVEY, UK_COMPARISON_KEYS, SHARED_FOOTPRINT, ASSUMED_SHOPPING,
    BUDGET_YEARLY, ELECTRICITY_FACTOR, GREEN_ELECTRICITY_FACTOR, GAS_FACTOR,
    WATER_FACTOR, DOG_YEARLY, CAT_YEARLY, EAT_OUT_MULTIPLIER, PORTION,
    MEAT_PER_KG, DIETS, MEAL_OPTIONS, EAT_OUT_OPTIONS, FOOD_WASTE,
    COMMUTE_MODES, TRAVEL_MODES, CABINS, BANK_RATING_BANDS, WHICH_BANK_RATINGS, PENSION_CLIMATE_RANKING, CASS_URL, USEFUL_LINKS, FLIGHT_DOMESTIC_FACTOR, FLIGHT_LONG_HAUL_KM, FLIGHT_DISTANCE_UPLIFT, AIRPORTS, BANKS, PENSION_PROVIDERS,
    GREEN_PENSION_T_PER_MILLION, EXPLAINERS, FLIGHT_TIERS,
    DIET_EXPLAINERS, GOAL_HABIT_IDS, ASSUMPTIONS, INPUT_DEFS, FIGURES_BUILT_IN, UK_PROFILE, buildUkTypical,
  };
})();
