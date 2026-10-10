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
  const UK_TYPICAL_SURVEY = {
    meals: {
      diet: "meat_eater",
      eatOut: 1,
      foodWaste: "some",
      weekMix: { chicken: 230 / 150, pork: 137 / 150, fish: 120 / 150, beef: 84 / 150, lamb: 23 / 150, veggie: 7 - 594 / 150 },
    },
    commute: { distance: 3.1, Mon: "car_petrol", Tue: "car_petrol", Wed: "car_petrol", Thu: "car_petrol", Fri: "train" },
    flights: [{ from: "LHR", to: "BCN", cabin: "economy", returnTrip: true, trips: 80.9 / 69.3 }],
    energy: { electricityKwh: 2500 / 12, gasKwh: 9500 / 12, greenTariff: false, household: 2.4 },
    water: { liters: 140 * 30.4 * 2.4 },
    pets: { dogs: (15.5 / 69.3) * 2.4, cats: (13.1 / 69.3) * 2.4 },
    banking: { amount: 0, bank: "", pensionPot: 0, pensionProvider: "" },
  };
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
  const PORTION = 0.15; // kg per portion
  const MEAT_PER_KG = {
  "chicken": 18.2,
  "fish": 2.72,
  "pork": 24,
  "beef": 155,
  "lamb": 58.4
};

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
    "factor": 1.38,
    "color": "#10b981"
  },
  {
    "key": "veggie",
    "label": "Vegetarian",
    "emoji": "🧀",
    "factor": 2.45,
    "color": "#84cc16"
  },
  {
    "key": "fish",
    "label": "Fish",
    "emoji": "🐟",
    "factor": 0.41,
    "color": "#06b6d4"
  },
  {
    "key": "chicken",
    "label": "Chicken",
    "emoji": "🍗",
    "factor": 2.73,
    "color": "#f59e0b"
  },
  {
    "key": "pork",
    "label": "Pork",
    "emoji": "🥓",
    "factor": 3.6,
    "color": "#f97316"
  },
  {
    "key": "beef",
    "label": "Beef",
    "emoji": "🥩",
    "factor": 23.25,
    "color": "#ef4444"
  },
  {
    "key": "lamb",
    "label": "Lamb",
    "emoji": "🍖",
    "factor": 8.76,
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
    "key": "bus",
    "label": "Bus",
    "emoji": "🚌",
    "factor": 0.128
  },
  {
    "key": "ev",
    // DESNZ 2025 battery electric average car: 0.04047 (electricity
    // incl. T&D) + 0.01049 (well-to-tank) kg CO2e/km.
    "label": "Electric car",
    "emoji": "⚡",
    "factor": 0.05096
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
  // Flight factors: DESNZ 2025 conversion factors, kg CO2e per passenger km,
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
  const GREEN_PENSION_T_PER_MILLION = 21;

  // Per-category "why / how to reduce" content and suggested habits.
  const EXPLAINERS = {
  "meals": {
    "title": "Meals & Diet",
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
        "tip": "Oat milk has ~80% less impact than dairy."
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
    "icon": "🚗",
    "why": "How you get around day-to-day adds up fast. A petrol car commute is one of the largest personal emission sources, and it repeats 200+ times a year — so even small shifts compound into big savings.",
    "sections": [
      {
        "heading": "Drive less, not never",
        "body": "The biggest wins come from replacing car trips, not eliminating driving entirely. One or two work-from-home days, or swapping the car for transit or cycling on short trips, can cut your commute footprint by 20–40%."
      },
      {
        "heading": "Pick the right alternative",
        "body": "Cycling and walking are zero-emission and add health benefits. Trains and buses spread emissions across many passengers — a full bus emits far less per person than a single-occupancy car. For trips under 5km, these are usually viable."
      },
      {
        "heading": "If you must drive",
        "body": "Combine errands into one trip, keep tyres inflated, and avoid idling. When it's time to replace your car, an electric vehicle emits roughly a quarter as much per km on the current grid — and far less on a green tariff."
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
    "icon": "✈️",
    "why": "Flying is often the largest single chunk of a personal footprint. One long-haul return flight can emit more than an entire year of driving. Because flights are occasional but huge, they can quietly dominate your annual total.",
    "sections": [
      {
        "heading": "Fly less, and shorter",
        "body": "Every flight has a major impact. A London–New York return in economy is about 1.7 tonnes CO₂e — roughly two-thirds of one person's yearly 1.5°C budget. London–Paris and back by plane is around 110 kg; by Eurostar, just a few kg.",
        "dynamicKey": "flightTiers"
      },
      {
        "heading": "Take the train where you can",
        "body": "For routes under ~700km, high-speed rail can be faster door-to-door once you factor in airport time, and emits a fraction as much. Many city pairs in Europe are well-served by rail.",
        "dynamicKey": "trainComparison"
      },
      {
        "heading": "Fly economy, direct, daytime",
        "body": "Economy seats spread the plane's emissions across more people. Business and first-class can double or triple your share. Direct flights avoid the extra emissions of multiple takeoffs, and daytime flights reduce contrail warming."
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
        "label": "Train under 700km",
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
    "icon": "⚡",
    "why": "Heating and powering your home is a major, recurring emission source. Because it runs every day, efficiency gains compound — and many changes are one-time decisions that keep paying off for years.",
    "sections": [
      {
        "heading": "Switch to a green tariff",
        "body": "This is the single easiest high-impact change. Moving to a renewable electricity tariff can cut your electricity emissions by over 80% with a few clicks — no behaviour change required. Many green tariffs are price-competitive."
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
    "icon": "🏦",
    "why": "Your savings don't just sit in a vault — banks lend them out, and many finance fossil-fuel projects. This 'financed emission' can be one of your largest hidden contributions. Moving your money is a one-time action with a big ongoing effect.",
    "sections": [
      {
        "heading": "Check your bank's financing",
        "body": "Banks publish their financed emissions or are rated by independent league tables. Some high-street banks fund fossil fuels heavily; others (like Triodos, Co-operative) have explicit no-fossil-fuel policies."
      },
      {
        "heading": "Switch your main account",
        "body": "Current-account switching is now fast and protected by guarantee services. Moving your everyday banking to a greener institution redirects your money away from fossil-fuel lending."
      },
      {
        "heading": "Move savings and pensions too",
        "body": "Savings accounts and especially pensions can be the biggest financed-emission lever. Ask your provider for a fossil-fuel-free or ESG fund option — a single pension switch can be the largest climate action you take."
      },
      {
        "heading": "Ask, don't assume",
        "body": "Green branding can be misleading. Check whether a bank has a credible no-fossil-fuel policy and published, verified financed-emissions figures."
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
    "description": "Light flying. Short-haul = under ~1,500 km per leg."
  },
  {
    "tier": 3,
    "label": "Tier 3",
    "criteria": "3–4 short-haul or 1–2 medium-haul flights / year",
    "description": "Moderate flying. Medium-haul = 1,500–4,000 km."
  },
  {
    "tier": 4,
    "label": "Tier 4",
    "criteria": "≥5 short-haul, ≥3 medium-haul, or >1 long-haul flights / year",
    "description": "Heavy flying. Long-haul = over 4,000 km. A single long-haul return can exceed your entire 1.5°C annual budget."
  }
];
  // Diet-specific replacements for the Meals explainer's sections + habits.
  const DIET_EXPLAINERS = {
  "red_meat_high": {
    "sections": [
      {
        "heading": "Drop a red-meat day or two",
        "body": "You're eating red meat more than twice a week — your single biggest food lever. Cutting to 1–2 red-meat days and filling the gap with chicken, fish or plant-based meals can cut over 1,800 kg CO₂e a year."
      },
      {
        "heading": "Choose chicken over beef",
        "body": "A beef portion emits roughly 8× more than chicken and ~17× more than a vegan meal. When you do keep meat, lean chicken or fish trims the impact sharply."
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
        "tip": "Oat milk has ~80% less impact than dairy."
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
        "tip": "~80% less impact than dairy."
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
        "body": "Oat and soy milk have roughly 80% less impact than cow's milk. An easy, high-frequency swap."
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
        "tip": "Oat/soy ~80% less impact than dairy."
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
    DEFAULT_SURVEY, DAYS, WEEKS_PER_YEAR, UK_TYPICAL_SURVEY, UK_COMPARISON_KEYS,
    BUDGET_YEARLY, ELECTRICITY_FACTOR, GREEN_ELECTRICITY_FACTOR, GAS_FACTOR,
    WATER_FACTOR, DOG_YEARLY, CAT_YEARLY, EAT_OUT_MULTIPLIER, PORTION,
    MEAT_PER_KG, DIETS, MEAL_OPTIONS, EAT_OUT_OPTIONS, FOOD_WASTE,
    COMMUTE_MODES, CABINS, FLIGHT_DOMESTIC_FACTOR, FLIGHT_LONG_HAUL_KM, FLIGHT_DISTANCE_UPLIFT, AIRPORTS, BANKS, PENSION_PROVIDERS,
    GREEN_PENSION_T_PER_MILLION, EXPLAINERS, FLIGHT_TIERS,
    DIET_EXPLAINERS, GOAL_HABIT_IDS,
  };
})();
