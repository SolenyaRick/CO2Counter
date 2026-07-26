(function () {
  "use strict";

  const OLD_STORAGE_KEY = "co2-tracker-week-v1";
  const PROFILE_KEY = "co2-tracker-profile-v1";
  const HISTORY_KEY = "co2-tracker-history-v1";
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

  const PORTION_KG = { small: 0.1, medium: 0.15, large: 0.25 };
  const PORTION_LABELS = { small: "Small (~100g)", medium: "Medium (~150g)", large: "Large (~250g+)" };

  const FOOD_DAY_FACTORS = { veggie: 1.5, vegan: 0.9 };
  // The rest of a meat day's food (breakfast, sides, etc.) is valued the same as a
  // vegetarian day, since it isn't any more carbon-efficient — the meat is added on top.
  const MEAT_SIDES_BASELINE = FOOD_DAY_FACTORS.veggie;

  const DEFAULT_PROFILE = { name: "", commuteDistanceKm: 8, weeklyGoalKg: 20 };

  function blankWeek() {
    return {
      commute: Object.fromEntries(DAYS.map((d) => [d.key, "none"])),
      diet: Object.fromEntries(DAYS.map((d) => [d.key, { type: "" }])),
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

  // ---------- Persistence ----------
  function loadProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      return raw ? { ...DEFAULT_PROFILE, ...JSON.parse(raw) } : { ...DEFAULT_PROFILE };
    } catch (e) {
      return { ...DEFAULT_PROFILE };
    }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function migrateOldData(profile, history) {
    const raw = localStorage.getItem(OLD_STORAGE_KEY);
    if (!raw) return;
    try {
      const old = JSON.parse(raw);
      if (typeof old.commuteDistanceKm === "number") profile.commuteDistanceKm = old.commuteDistanceKm;
      if (old.commute || old.diet) {
        history[CURRENT_WEEK_KEY] = {
          commute: { ...blankWeek().commute, ...(old.commute || {}) },
          diet: { ...blankWeek().diet, ...(old.diet || {}) },
        };
      }
    } catch (e) {
      // ignore corrupt legacy data
    }
    localStorage.removeItem(OLD_STORAGE_KEY);
    saveProfile(profile);
    saveHistory(history);
  }

  function saveProfile(p) { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }
  function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }

  let profile = loadProfile();
  let history = loadHistory();
  migrateOldData(profile, history);

  function getWeek(weekKey) {
    if (!history[weekKey]) history[weekKey] = blankWeek();
    return history[weekKey];
  }

  function hasAnyEntries(weekData) {
    if (!weekData) return false;
    const commuted = Object.values(weekData.commute).some((m) => m && m !== "none");
    const ate = Object.values(weekData.diet).some((e) => e && e.type);
    return commuted || ate;
  }

  let pendingMeatDayKey = null;

  // ---------- Footprint math ----------
  function commuteFootprint(weekData, dayKey) {
    const mode = weekData.commute[dayKey];
    const factor = TRANSPORT_FACTORS[mode] ?? 0;
    return factor * (profile.commuteDistanceKm || 0) * 2;
  }

  function foodFootprint(weekData, dayKey) {
    const entry = weekData.diet[dayKey];
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

  // How much extra a meat choice adds on top of an equivalent veggie day —
  // exactly the meat portion's own footprint, since the baseline for the
  // rest of the day is valued the same either way.
  function meatExtra(entry) {
    const meatFactor = MEAT_FACTORS[entry.meat] ?? MEAT_FACTORS.other;
    const portionKg = PORTION_KG[entry.portion] ?? PORTION_KG.medium;
    return meatFactor * portionKg;
  }

  function veggieSavings(weekData) {
    let total = 0;
    const byType = {};
    DAYS.forEach((day) => {
      const entry = weekData.diet[day.key];
      if (entry && entry.type === "meat") {
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
      const c = commuteFootprint(weekData, day.key);
      const f = foodFootprint(weekData, day.key);
      commute += c;
      food += f;
      daily.push(c + f);
    });
    return { commute, food, total: commute + food, daily };
  }

  function fmt(n) { return n.toFixed(1); }

  // ---------- Tab routing ----------
  const TABS = ["week", "weeks", "leaderboard", "account"];

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
    if (tab === "leaderboard") renderLeaderboard();
    if (tab === "account") renderAccountPage();
    if (tab === "week") renderWeekPage();
  }

  // ---------- Page 1: This Week ----------
  function buildCommuteTable() {
    const weekData = getWeek(CURRENT_WEEK_KEY);
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
      select.value = weekData.commute[day.key];
      select.addEventListener("change", () => {
        weekData.commute[day.key] = select.value;
        saveHistory(history);
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
    const weekData = getWeek(CURRENT_WEEK_KEY);
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
      select.value = weekData.diet[day.key]?.type || "";

      const detail = document.createElement("span");
      detail.className = "meat-detail";

      const editLink = document.createElement("button");
      editLink.type = "button";
      editLink.className = "meat-edit-link";
      editLink.textContent = "edit";
      editLink.style.display = "none";
      editLink.addEventListener("click", () => openMeatModal(day.key));

      function refreshMeatUI() {
        const entry = weekData.diet[day.key];
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
          const existing = weekData.diet[day.key];
          weekData.diet[day.key] = {
            type: "meat",
            meat: existing?.meat || "chicken",
            portion: existing?.portion || "medium",
          };
          saveHistory(history);
          refreshMeatUI();
          renderFootprints();
          openMeatModal(day.key);
        } else {
          weekData.diet[day.key] = { type: value };
          saveHistory(history);
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
    });
  }

  function openMeatModal(dayKey) {
    const weekData = getWeek(CURRENT_WEEK_KEY);
    pendingMeatDayKey = dayKey;
    const entry = weekData.diet[dayKey];
    document.getElementById("meat-type").value = entry?.meat || "chicken";
    document.getElementById("meat-portion").value = entry?.portion || "medium";
    document.getElementById("meat-modal-backdrop").classList.add("open");
  }

  function closeMeatModal() {
    document.getElementById("meat-modal-backdrop").classList.remove("open");
    pendingMeatDayKey = null;
  }

  function renderFootprints() {
    const weekData = getWeek(CURRENT_WEEK_KEY);
    const totals = weekTotals(weekData);

    DAYS.forEach((day, i) => {
      const c = commuteFootprint(weekData, day.key);
      const f = foodFootprint(weekData, day.key);
      const cCell = document.querySelector(`[data-commute-footprint="${day.key}"]`);
      if (cCell) cCell.textContent = c > 0 ? `${fmt(c)} kg` : "–";
      const fCell = document.querySelector(`[data-food-footprint="${day.key}"]`);
      if (fCell) fCell.textContent = f > 0 ? `${fmt(f)} kg` : "–";
    });

    document.getElementById("total-commute").textContent = fmt(totals.commute);
    document.getElementById("total-food").textContent = fmt(totals.food);
    document.getElementById("total-week").textContent = fmt(totals.total);
    document.getElementById("week-range-heading").textContent = `This week (${weekLabel(CURRENT_WEEK_KEY)})`;

    renderSavingsBox(weekData);
    renderChart(totals.daily);
  }

  function renderSavingsBox(weekData) {
    const savings = veggieSavings(weekData);
    const valueEl = document.getElementById("savings-value");
    const labelEl = document.getElementById("savings-label");
    const breakdownEl = document.getElementById("savings-breakdown");
    breakdownEl.innerHTML = "";

    if (savings.total <= 0) {
      valueEl.textContent = "0.0";
      labelEl.textContent = "kg CO2e · No meat logged this week";
      return;
    }

    valueEl.textContent = fmt(savings.total);
    labelEl.textContent = "kg CO2e · Would save if meat days were veggie";

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

  function renderWeekPage() {
    buildCommuteTable();
    buildDietTable();
    renderFootprints();
  }

  // ---------- Page 2: Weeks grid ----------
  function currentGoal() { return profile.weeklyGoalKg || DEFAULT_PROFILE.weeklyGoalKg; }

  function statusClass(total, started) {
    if (!started) return "status-empty";
    const goal = currentGoal();
    if (total <= goal) return "status-good";
    if (total <= goal * 1.3) return "status-warn";
    return "status-high";
  }

  function renderWeeksGrid() {
    const grid = document.getElementById("weeks-grid");
    grid.innerHTML = "";
    const goal = currentGoal();
    for (let i = 0; i < WEEKS_GRID_COUNT; i++) {
      const key = shiftedWeekKey(CURRENT_WEEK_KEY, -i);
      const weekData = history[key];
      const started = hasAnyEntries(weekData);
      const totals = started ? weekTotals(weekData) : null;

      const box = document.createElement("button");
      box.type = "button";
      box.className = `week-box ${statusClass(totals?.total ?? 0, started)}`;
      if (key === CURRENT_WEEK_KEY) box.classList.add("is-current");

      if (key === CURRENT_WEEK_KEY) {
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
        diffEl.title = over
          ? `${fmt(diff)} kg over your ${fmt(goal)} kg goal`
          : `${fmt(Math.abs(diff))} kg under your ${fmt(goal)} kg goal`;
        bottomRow.appendChild(diffEl);
      }

      box.appendChild(bottomRow);

      box.addEventListener("click", () => openWeekDetail(key));
      grid.appendChild(box);
    }
  }

  function openWeekDetail(key) {
    const weekData = history[key];
    const started = hasAnyEntries(weekData);
    document.getElementById("week-detail-title").textContent = weekLabel(key);
    const body = document.getElementById("week-detail-body");

    if (!started) {
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
        const dayTotal = commuteFootprint(weekData, day.key) + foodFootprint(weekData, day.key);
        return `<tr><td>${day.full}</td><td>${commuteLabel}</td><td>${dietText}</td><td>${fmt(dayTotal)} kg</td></tr>`;
      }).join("");

      body.innerHTML = `
        <table class="week-detail-table">
          <thead><tr><th>Day</th><th>Commute</th><th>Diet</th><th>CO2e</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p><strong>Total: ${fmt(totals.total)} kg CO2e</strong> (${fmt(totals.commute)} kg commute, ${fmt(totals.food)} kg food)</p>
      `;
    }

    document.getElementById("week-detail-backdrop").classList.add("open");
  }

  function closeWeekDetail() {
    document.getElementById("week-detail-backdrop").classList.remove("open");
  }

  // ---------- Page 3: Leaderboard ----------
  function renderLeaderboard() {
    const list = document.getElementById("leaderboard-list");
    list.innerHTML = "";

    const entries = Object.keys(history)
      .filter((key) => hasAnyEntries(history[key]))
      .map((key) => ({ key, totals: weekTotals(history[key]) }))
      .sort((a, b) => a.totals.total - b.totals.total);

    if (entries.length === 0) {
      list.innerHTML = '<p class="empty-note">Log a week on the This Week page to see it ranked here.</p>';
      return;
    }

    const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
    entries.forEach((entry, i) => {
      const li = document.createElement("li");
      li.className = "leaderboard-row" + (entry.key === CURRENT_WEEK_KEY ? " is-current" : "");

      const rank = document.createElement("span");
      rank.className = "leaderboard-rank";
      rank.textContent = medals[i] || `#${i + 1}`;

      const info = document.createElement("span");
      info.className = "leaderboard-info";
      const weekLabelEl = document.createElement("div");
      weekLabelEl.className = "leaderboard-week-label";
      weekLabelEl.textContent = weekLabel(entry.key);
      const sub = document.createElement("div");
      sub.className = "leaderboard-sub";
      sub.textContent = entry.key === CURRENT_WEEK_KEY ? "This week" : `${fmt(entry.totals.commute)} kg commute · ${fmt(entry.totals.food)} kg food`;
      info.appendChild(weekLabelEl);
      info.appendChild(sub);

      const total = document.createElement("span");
      total.className = "leaderboard-total";
      total.textContent = `${fmt(entry.totals.total)} kg`;

      li.appendChild(rank);
      li.appendChild(info);
      li.appendChild(total);
      list.appendChild(li);
    });
  }

  // ---------- Page 4: Account ----------
  function renderAccountPage() {
    document.getElementById("profile-name").value = profile.name || "";
    document.getElementById("profile-distance").value = profile.commuteDistanceKm;
    document.getElementById("profile-goal").value = profile.weeklyGoalKg;
  }

  function exportData() {
    const payload = { profile, history };
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

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.profile || !parsed.history) throw new Error("Missing profile/history");
        if (!confirm("Import will replace your current data. Continue?")) return;
        profile = { ...DEFAULT_PROFILE, ...parsed.profile };
        history = parsed.history;
        saveProfile(profile);
        saveHistory(history);
        showTab(currentTab());
        renderAccountPage();
      } catch (e) {
        alert("That file doesn't look like a valid CO2 Tracker export.");
      }
    };
    reader.readAsText(file);
  }

  // ---------- Init ----------
  function init() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => { location.hash = btn.dataset.tab; });
    });
    window.addEventListener("hashchange", () => showTab(currentTab()));

    document.getElementById("meat-save").addEventListener("click", () => {
      if (!pendingMeatDayKey) return;
      const weekData = getWeek(CURRENT_WEEK_KEY);
      const meat = document.getElementById("meat-type").value;
      const portion = document.getElementById("meat-portion").value;
      weekData.diet[pendingMeatDayKey] = { type: "meat", meat, portion };
      saveHistory(history);
      closeMeatModal();
      buildDietTable();
      renderFootprints();
    });
    document.getElementById("meat-cancel").addEventListener("click", closeMeatModal);
    document.getElementById("meat-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "meat-modal-backdrop") closeMeatModal();
    });

    document.getElementById("week-detail-close").addEventListener("click", closeWeekDetail);
    document.getElementById("week-detail-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "week-detail-backdrop") closeWeekDetail();
    });

    document.getElementById("reset-week").addEventListener("click", () => {
      if (!confirm("Reset all entries for this week?")) return;
      history[CURRENT_WEEK_KEY] = blankWeek();
      saveHistory(history);
      renderWeekPage();
    });

    document.getElementById("profile-name").addEventListener("input", (e) => {
      profile.name = e.target.value;
      saveProfile(profile);
    });
    document.getElementById("profile-distance").addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      profile.commuteDistanceKm = Number.isFinite(val) && val >= 0 ? val : 0;
      saveProfile(profile);
      renderFootprints();
    });
    document.getElementById("profile-goal").addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      profile.weeklyGoalKg = Number.isFinite(val) && val >= 0 ? val : 0;
      saveProfile(profile);
    });

    document.getElementById("export-data").addEventListener("click", exportData);
    document.getElementById("import-data").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importData(file);
      e.target.value = "";
    });
    document.getElementById("reset-all-data").addEventListener("click", () => {
      if (!confirm("This deletes ALL saved weeks and profile settings in this browser. Continue?")) return;
      profile = { ...DEFAULT_PROFILE };
      history = {};
      saveProfile(profile);
      saveHistory(history);
      showTab(currentTab());
      renderAccountPage();
    });

    showTab(currentTab());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
