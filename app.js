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
  let profile = { ...DEFAULT_PROFILE };
  let weeksCache = {}; // week_key -> { commute, diet, confirmedCommute, confirmedDiet, total_kg? }
  let friendships = []; // [{ id, status, otherId, otherName, iAmRequester }]
  let pendingMeatDayKey = null;
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

  // ---------- Supabase: profile ----------
  async function ensureProfile() {
    const { data } = await sbClient.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
    if (data) {
      profile = {
        name: data.display_name || "",
        commuteDistanceKm: data.commute_distance_km ?? DEFAULT_PROFILE.commuteDistanceKm,
        weeklyGoalKg: data.weekly_goal_kg ?? DEFAULT_PROFILE.weeklyGoalKg,
      };
    } else {
      profile = { ...DEFAULT_PROFILE };
      await sbClient.from("profiles").insert({
        id: currentUser.id,
        display_name: profile.name,
        commute_distance_km: profile.commuteDistanceKm,
        weekly_goal_kg: profile.weeklyGoalKg,
      });
    }
  }

  async function persistProfile() {
    if (!currentUser) return;
    await sbClient.from("profiles").upsert({
      id: currentUser.id,
      display_name: profile.name,
      commute_distance_km: profile.commuteDistanceKm,
      weekly_goal_kg: profile.weeklyGoalKg,
    });
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
    if (otherIds.length > 0) {
      const { data: profs } = await sbClient.from("profiles").select("id, display_name").in("id", otherIds);
      (profs || []).forEach((p) => {
        namesById[p.id] = p.display_name || "(no name set)";
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
  }

  async function removeFriendship(id) {
    await sbClient.from("friendships").delete().eq("id", id);
    await loadFriends();
    renderFriendsUI();
    renderLeaderboard();
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

  function buildDietTable() {
    const weekData = getWeek(selectedWeekKey);
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

      const confirmBtn = createConfirmButton(weekData, "diet", day.key);

      select.addEventListener("change", () => {
        const value = select.value;
        weekData.confirmedDiet[day.key] = false;
        confirmBtn.classList.remove("confirmed", "pop");
        if (value === "meat") {
          const existing = weekData.diet[day.key];
          weekData.diet[day.key] = {
            type: "meat",
            meat: existing?.meat || "chicken",
            portion: existing?.portion || "medium",
          };
          persistWeek(selectedWeekKey);
          refreshMeatUI();
          renderFootprints();
          openMeatModal(day.key);
        } else {
          weekData.diet[day.key] = { type: value };
          persistWeek(selectedWeekKey);
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

      const confirmTd = document.createElement("td");
      confirmTd.className = "day-confirm-cell";
      confirmTd.appendChild(confirmBtn);
      tr.appendChild(confirmTd);

      tbody.appendChild(tr);
    });
  }

  function openMeatModal(dayKey) {
    const weekData = getWeek(selectedWeekKey);
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
    renderChart(totals.daily);
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
      const weekData = weeksCache[key];
      const started = hasAnyConfirmed(weekData);
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
  async function renderLeaderboard() {
    const list = document.getElementById("leaderboard-list");
    if (!currentUser) return;

    const { data, error } = await sbClient.rpc("friend_leaderboard", { target_week_key: CURRENT_WEEK_KEY });
    list.innerHTML = "";

    if (error) {
      list.innerHTML = '<p class="empty-note">Could not load the leaderboard right now.</p>';
      return;
    }
    if (!data || data.length === 0) {
      list.innerHTML = '<p class="empty-note">Log this week, then add friends from the Account page to compare.</p>';
      return;
    }

    const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
    data.forEach((entry, i) => {
      const li = document.createElement("li");
      li.className = "leaderboard-row" + (entry.is_self ? " is-current" : "");

      const rank = document.createElement("span");
      rank.className = "leaderboard-rank";
      rank.textContent = medals[i] || `#${i + 1}`;

      const info = document.createElement("span");
      info.className = "leaderboard-info";
      const nameEl = document.createElement("div");
      nameEl.className = "leaderboard-week-label";
      nameEl.textContent = entry.is_self ? "You" : entry.display_name || "Friend";
      const sub = document.createElement("div");
      sub.className = "leaderboard-sub";
      sub.textContent = weekLabel(CURRENT_WEEK_KEY);
      info.appendChild(nameEl);
      info.appendChild(sub);

      const total = document.createElement("span");
      total.className = "leaderboard-total";
      total.textContent = `${fmt(entry.total_kg)} kg`;

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
    document.getElementById("account-email").textContent = currentUser?.email || "";
    renderFriendsUI();
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
        const { data, error } = await sbClient.auth.signUp({ email, password });
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
    const { error } = await sbClient.auth.resetPasswordForEmail(email);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      return;
    }
    statusEl.textContent = "Password reset email sent.";
    statusEl.hidden = false;
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

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => { location.hash = btn.dataset.tab; });
    });
    window.addEventListener("hashchange", () => showTab(currentTab()));

    document.getElementById("sign-out-btn").addEventListener("click", () => sbClient.auth.signOut());

    document.getElementById("meat-save").addEventListener("click", () => {
      if (!pendingMeatDayKey) return;
      const weekData = getWeek(selectedWeekKey);
      const meat = document.getElementById("meat-type").value;
      const portion = document.getElementById("meat-portion").value;
      weekData.diet[pendingMeatDayKey] = { type: "meat", meat, portion };
      weekData.confirmedDiet[pendingMeatDayKey] = false;
      persistWeek(selectedWeekKey);
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

    sbClient.auth.getSession().then(({ data }) => {
      handleSession(data.session);
      sbClient.auth.onAuthStateChange((_event, session) => { handleSession(session); });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
