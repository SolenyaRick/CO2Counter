(function () {
  "use strict";

  const STORAGE_KEY = "co2-tracker-week-v1";

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
  const TRANSPORT_FACTORS = {
    none: 0,
    walk: 0,
    cycle: 0,
    train: 0.041,
    car: 0.171,
  };

  const TRANSPORT_LABELS = {
    none: "Didn't travel",
    walk: "Walk",
    cycle: "Cycle",
    train: "Train",
    car: "Car",
  };

  // Rough average emission factors, kg CO2e per kg of product.
  const MEAT_FACTORS = {
    chicken: 6,
    fish: 5,
    pork: 7,
    beef: 27,
    lamb: 25,
    other: 10,
  };

  const MEAT_LABELS = {
    chicken: "Chicken / poultry",
    fish: "Fish / seafood",
    pork: "Pork",
    beef: "Beef",
    lamb: "Lamb",
    other: "Other",
  };

  const PORTION_KG = { small: 0.1, medium: 0.15, large: 0.25 };
  const PORTION_LABELS = { small: "Small (~100g)", medium: "Medium (~150g)", large: "Large (~250g+)" };

  // Rough baseline for the rest of a day's food beyond the flagged meat/main.
  const MEAT_SIDES_BASELINE = 0.5;
  const FOOD_DAY_FACTORS = { veggie: 1.5, vegan: 0.9 };

  const DEFAULT_STATE = {
    commuteDistanceKm: 8,
    commute: Object.fromEntries(DAYS.map((d) => [d.key, "none"])),
    diet: Object.fromEntries(DAYS.map((d) => [d.key, { type: "" }])),
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_STATE);
      const parsed = JSON.parse(raw);
      return {
        commuteDistanceKm: typeof parsed.commuteDistanceKm === "number" ? parsed.commuteDistanceKm : DEFAULT_STATE.commuteDistanceKm,
        commute: { ...DEFAULT_STATE.commute, ...(parsed.commute || {}) },
        diet: { ...structuredClone(DEFAULT_STATE.diet), ...(parsed.diet || {}) },
      };
    } catch (e) {
      return structuredClone(DEFAULT_STATE);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = loadState();
  let pendingMeatDayKey = null;

  function commuteFootprint(dayKey) {
    const mode = state.commute[dayKey];
    const factor = TRANSPORT_FACTORS[mode] ?? 0;
    const roundTripKm = (state.commuteDistanceKm || 0) * 2;
    return factor * roundTripKm;
  }

  function foodFootprint(dayKey) {
    const entry = state.diet[dayKey];
    if (!entry || !entry.type) return 0;
    if (entry.type === "vegan") return FOOD_DAY_FACTORS.vegan;
    if (entry.type === "veggie") return FOOD_DAY_FACTORS.veggie;
    if (entry.type === "meat") {
      const meatFactor = MEAT_FACTORS[entry.meat] ?? MEAT_FACTORS.other;
      const portionKg = PORTION_KG[entry.portion] ?? PORTION_KG.medium;
      return meatFactor * portionKg + MEAT_SIDES_BASELINE;
    }
    return 0;
  }

  function fmt(n) {
    return n.toFixed(1);
  }

  function buildCommuteTable() {
    const tbody = document.querySelector("#commute-table tbody");
    tbody.innerHTML = "";
    DAYS.forEach((day) => {
      const tr = document.createElement("tr");

      const dayTd = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "day-badge";
      badge.title = day.full;
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
      select.value = state.commute[day.key];
      select.addEventListener("change", () => {
        state.commute[day.key] = select.value;
        saveState();
        renderFootprints();
      });
      modeTd.appendChild(select);
      tr.appendChild(modeTd);

      const footTd = document.createElement("td");
      footTd.className = "row-footprint";
      footTd.dataset.commuteFootprint = day.key;
      tr.appendChild(footTd);

      tbody.appendChild(tr);
    });
  }

  function dietSummaryText(entry) {
    if (!entry || entry.type !== "meat") return "";
    return `${MEAT_LABELS[entry.meat] ?? "Meat"} – ${PORTION_LABELS[entry.portion] ?? ""}`;
  }

  function buildDietTable() {
    const tbody = document.querySelector("#diet-table tbody");
    tbody.innerHTML = "";
    DAYS.forEach((day) => {
      const tr = document.createElement("tr");

      const dayTd = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "day-badge";
      badge.title = day.full;
      badge.textContent = day.short;
      dayTd.appendChild(badge);
      tr.appendChild(dayTd);

      const dietTd = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "diet-cell";

      const select = document.createElement("select");
      select.className = "diet-select";
      select.setAttribute("aria-label", `Diet for ${day.full}`);
      [
        { value: "", label: "Select..." },
        { value: "meat", label: "Meat" },
        { value: "veggie", label: "Veggie" },
        { value: "vegan", label: "Vegan" },
      ].forEach(({ value, label }) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
      });
      select.value = state.diet[day.key]?.type || "";

      const detail = document.createElement("span");
      detail.className = "meat-detail";

      const editLink = document.createElement("button");
      editLink.type = "button";
      editLink.className = "meat-edit-link";
      editLink.textContent = "edit";
      editLink.style.display = "none";
      editLink.addEventListener("click", () => openMeatModal(day.key));

      function refreshMeatUI() {
        const entry = state.diet[day.key];
        if (entry && entry.type === "meat") {
          detail.textContent = dietSummaryText(entry);
          editLink.style.display = "inline";
        } else {
          detail.textContent = "";
          editLink.style.display = "none";
        }
      }
      refreshMeatUI();

      select.addEventListener("change", () => {
        const value = select.value;
        if (value === "meat") {
          const existing = state.diet[day.key];
          state.diet[day.key] = {
            type: "meat",
            meat: existing?.meat || "chicken",
            portion: existing?.portion || "medium",
          };
          saveState();
          refreshMeatUI();
          renderFootprints();
          openMeatModal(day.key);
        } else {
          state.diet[day.key] = { type: value };
          saveState();
          refreshMeatUI();
          renderFootprints();
        }
      });

      cell.appendChild(select);
      cell.appendChild(detail);
      cell.appendChild(editLink);
      dietTd.appendChild(cell);
      tr.appendChild(dietTd);

      const footTd = document.createElement("td");
      footTd.className = "row-footprint";
      footTd.dataset.foodFootprint = day.key;
      tr.appendChild(footTd);

      tbody.appendChild(tr);

      day._refreshMeatUI = refreshMeatUI;
    });
  }

  function openMeatModal(dayKey) {
    pendingMeatDayKey = dayKey;
    const entry = state.diet[dayKey];
    document.getElementById("meat-type").value = entry?.meat || "chicken";
    document.getElementById("meat-portion").value = entry?.portion || "medium";
    document.getElementById("meat-modal-backdrop").classList.add("open");
  }

  function closeMeatModal() {
    document.getElementById("meat-modal-backdrop").classList.remove("open");
    pendingMeatDayKey = null;
  }

  function renderFootprints() {
    let totalCommute = 0;
    let totalFood = 0;
    const dailyTotals = [];

    DAYS.forEach((day) => {
      const c = commuteFootprint(day.key);
      const f = foodFootprint(day.key);
      totalCommute += c;
      totalFood += f;
      dailyTotals.push(c + f);

      const cCell = document.querySelector(`[data-commute-footprint="${day.key}"]`);
      if (cCell) cCell.textContent = c > 0 ? `${fmt(c)} kg` : "–";

      const fCell = document.querySelector(`[data-food-footprint="${day.key}"]`);
      if (fCell) fCell.textContent = f > 0 ? `${fmt(f)} kg` : "–";
    });

    document.getElementById("total-commute").textContent = fmt(totalCommute);
    document.getElementById("total-food").textContent = fmt(totalFood);
    document.getElementById("total-week").textContent = fmt(totalCommute + totalFood);

    renderChart(dailyTotals);
  }

  function renderChart(dailyTotals) {
    const chart = document.getElementById("daily-chart");
    chart.innerHTML = "";
    const max = Math.max(1, ...dailyTotals);
    DAYS.forEach((day, i) => {
      const wrap = document.createElement("div");
      wrap.className = "chart-bar-wrap";

      const bar = document.createElement("div");
      bar.className = "chart-bar";
      const heightPct = Math.max(2, (dailyTotals[i] / max) * 100);
      bar.style.height = `${heightPct}%`;
      bar.title = `${day.full}: ${fmt(dailyTotals[i])} kg CO2e`;

      const label = document.createElement("div");
      label.className = "chart-label";
      label.textContent = day.short;

      wrap.appendChild(bar);
      wrap.appendChild(label);
      chart.appendChild(wrap);
    });
  }

  function init() {
    const distanceInput = document.getElementById("commute-distance");
    distanceInput.value = state.commuteDistanceKm;
    distanceInput.addEventListener("input", () => {
      const val = parseFloat(distanceInput.value);
      state.commuteDistanceKm = Number.isFinite(val) && val >= 0 ? val : 0;
      saveState();
      renderFootprints();
    });

    buildCommuteTable();
    buildDietTable();
    renderFootprints();

    document.getElementById("meat-save").addEventListener("click", () => {
      if (!pendingMeatDayKey) return;
      const meat = document.getElementById("meat-type").value;
      const portion = document.getElementById("meat-portion").value;
      state.diet[pendingMeatDayKey] = { type: "meat", meat, portion };
      saveState();
      closeMeatModal();
      buildDietTable();
      renderFootprints();
    });

    document.getElementById("meat-cancel").addEventListener("click", () => {
      closeMeatModal();
    });

    document.getElementById("meat-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "meat-modal-backdrop") closeMeatModal();
    });

    document.getElementById("reset-week").addEventListener("click", () => {
      if (!confirm("Reset all entries for this week?")) return;
      state = structuredClone(DEFAULT_STATE);
      saveState();
      distanceInput.value = state.commuteDistanceKm;
      buildCommuteTable();
      buildDietTable();
      renderFootprints();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
