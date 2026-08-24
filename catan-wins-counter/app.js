const STORAGE_KEY = "catan-wins-counter.players";

/** @type {{id: string, name: string, wins: number}[]} */
let players = loadPlayers();

const listEl = document.getElementById("player-list");
const emptyStateEl = document.getElementById("empty-state");
const formEl = document.getElementById("add-player-form");
const nameInputEl = document.getElementById("player-name-input");
const resetBtn = document.getElementById("reset-btn");

function loadPlayers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePlayers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
}

function render() {
  const sorted = [...players].sort((a, b) => b.wins - a.wins);

  listEl.innerHTML = "";
  sorted.forEach((player, index) => {
    const li = document.createElement("li");
    li.className = "player-card";

    const rank = document.createElement("span");
    rank.className = "player-card__rank";
    rank.textContent = index === 0 && player.wins > 0 ? "🥇" : `${index + 1}`;
    li.appendChild(rank);

    const info = document.createElement("div");
    info.className = "player-card__info";
    info.innerHTML = `
      <div class="player-card__name"></div>
      <div class="player-card__wins"><strong></strong> ${player.wins === 1 ? "win" : "wins"}</div>
    `;
    info.querySelector(".player-card__name").textContent = player.name;
    info.querySelector(".player-card__wins strong").textContent = player.wins;
    li.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "player-card__actions";

    const minusBtn = document.createElement("button");
    minusBtn.className = "icon-btn";
    minusBtn.type = "button";
    minusBtn.textContent = "−";
    minusBtn.setAttribute("aria-label", `Remove a win from ${player.name}`);
    minusBtn.disabled = player.wins <= 0;
    minusBtn.addEventListener("click", () => changeWins(player.id, -1));
    actions.appendChild(minusBtn);

    const plusBtn = document.createElement("button");
    plusBtn.className = "icon-btn icon-btn--win";
    plusBtn.type = "button";
    plusBtn.textContent = "+1 Win";
    plusBtn.setAttribute("aria-label", `Add a win to ${player.name}`);
    plusBtn.addEventListener("click", () => changeWins(player.id, 1));
    actions.appendChild(plusBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn icon-btn--danger";
    deleteBtn.type = "button";
    deleteBtn.textContent = "✕";
    deleteBtn.setAttribute("aria-label", `Remove ${player.name}`);
    deleteBtn.addEventListener("click", () => removePlayer(player.id));
    actions.appendChild(deleteBtn);

    li.appendChild(actions);
    listEl.appendChild(li);
  });

  emptyStateEl.classList.toggle("empty-state--visible", players.length === 0);
}

function addPlayer(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  players.push({ id: crypto.randomUUID(), name: trimmed, wins: 0 });
  savePlayers();
  render();
}

function changeWins(id, delta) {
  const player = players.find((p) => p.id === id);
  if (!player) return;
  player.wins = Math.max(0, player.wins + delta);
  savePlayers();
  render();
}

function removePlayer(id) {
  players = players.filter((p) => p.id !== id);
  savePlayers();
  render();
}

function resetAllWins() {
  if (players.length === 0) return;
  if (!confirm("Reset every player's win count to 0?")) return;
  players.forEach((p) => (p.wins = 0));
  savePlayers();
  render();
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  addPlayer(nameInputEl.value);
  nameInputEl.value = "";
  nameInputEl.focus();
});

resetBtn.addEventListener("click", resetAllWins);

render();
