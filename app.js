const STORAGE_KEY = "playerwatch.accounts.v1";
const REFRESH_INTERVALS = [15, 30, 60, 300];
const accountList = document.querySelector("#accountList");
const emptyState = document.querySelector("#emptyState");
const modalBackdrop = document.querySelector("#modalBackdrop");
const addForm = document.querySelector("#addForm");
const usernameInput = document.querySelector("#usernameInput");
const modalMessage = document.querySelector("#modalMessage");
const submitButton = document.querySelector("#submitButton");
const filterButton = document.querySelector("#filterButton");
const SETTINGS_KEY = "playerwatch.settings.v1";
const THEMES = ["aurora", "halloween", "midnight", "ocean", "sakura", "sunset", "forest", "cyberpunk", "arctic", "ember"];
const settingsBackdrop = document.querySelector("#settingsBackdrop");
let settings = loadSettings();
let accounts = loadAccounts();
let filter = "all";
let refreshBusy = false;
let toastTimer;
let refreshTimer;
let stateReady = false;
let stateSaveTimer;
let stateSaveQueue = Promise.resolve();

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return normalizeSettings(stored);
  } catch (error) {
    console.warn("Could not read dashboard preferences:", error);
    return normalizeSettings({});
  }
}

function normalizeSettings(stored = {}) {
  return {
    theme: THEMES.includes(stored.theme) ? stored.theme : "aurora",
    view: stored.view === "grid" ? "grid" : "list",
    autoRefresh: stored.autoRefresh !== false,
    refreshInterval: REFRESH_INTERVALS.includes(Number(stored.refreshInterval)) ? Number(stored.refreshInterval) : 60,
    showUserIds: stored.showUserIds !== false,
    compactRows: stored.compactRows === true,
    reduceMotion: stored.reduceMotion === true,
    webhookEnabled: stored.webhookEnabled === true,
    webhookUrl: typeof stored.webhookUrl === "string" ? stored.webhookUrl : "",
    webhookMention: typeof stored.webhookMention === "string" ? stored.webhookMention : "",
  };
}

function saveSettings() {
  scheduleStateSave();
}

function applySettings() {
  document.body.dataset.theme = settings.theme;
  document.body.classList.toggle("hide-user-ids", !settings.showUserIds);
  document.documentElement.classList.toggle("reduce-motion", settings.reduceMotion);
  accountList.classList.toggle("grid-view", settings.view === "grid");
  accountList.classList.toggle("compact-view", settings.compactRows);
  document.querySelector(".roster-section").classList.toggle("grid-mode", settings.view === "grid");
  document.querySelectorAll(".view-toggle-button").forEach(button => {
    const active = button.dataset.view === settings.view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll(".theme-option").forEach(button => {
    const active = button.dataset.theme === settings.theme;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelector("#autoRefreshToggle").checked = settings.autoRefresh;
  document.querySelector("#refreshIntervalSelect").value = String(settings.refreshInterval);
  document.querySelector("#refreshIntervalSelect").disabled = !settings.autoRefresh;
  document.querySelector("#showIdsToggle").checked = settings.showUserIds;
  document.querySelector("#compactToggle").checked = settings.compactRows;
  document.querySelector("#reduceMotionToggle").checked = settings.reduceMotion;
  document.querySelector("#webhookEnabledToggle").checked = settings.webhookEnabled;
  document.querySelector("#webhookUrlInput").value = settings.webhookUrl;
  document.querySelector("#webhookMentionInput").value = settings.webhookMention;
  document.querySelector("#testWebhookButton").disabled = !settings.webhookUrl.trim();
  document.querySelector("#favoriteCount").textContent = accounts.filter(account => account.favorite === true).length;
  const refreshStatus = settings.autoRefresh
    ? `Refreshes every ${settings.refreshInterval >= 60 ? `${settings.refreshInterval / 60} minute${settings.refreshInterval > 60 ? "s" : ""}` : `${settings.refreshInterval} seconds`} while this page is open`
    : "Automatic status + offline-alert checks paused · use ↻ manually";
  document.querySelector("#refreshStatusText").textContent = refreshStatus;
  document.querySelector("#refreshStatusDot").classList.toggle("paused", !settings.autoRefresh);
}

function configureRefreshSchedule() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  if (settings.autoRefresh) {
    refreshTimer = setInterval(() => refreshAccounts(), settings.refreshInterval * 1000);
  }
}

function loadAccounts() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter(item => item && /^\d+$/.test(String(item.id))) : [];
  } catch (error) {
    console.warn("Could not read the saved watchlist:", error);
    return [];
  }
}

function saveAccounts() {
  scheduleStateSave();
}

function scheduleStateSave() {
  if (!stateReady) return;
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    persistStateNow().catch(error => {
      console.error("Could not persist dashboard data:", error);
      showToast(error.message);
    });
  }, 250);
}

function persistStateNow() {
  clearTimeout(stateSaveTimer);
  const snapshot = JSON.stringify({ accounts, settings });
  const operation = stateSaveQueue.then(() => api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: snapshot,
  }));
  stateSaveQueue = operation.catch(error => {
    console.error("Could not save dashboard data to the project data folder:", error);
    showToast(error.message);
  });
  return operation;
}

async function initializeState() {
  try {
    const saved = await api("/api/state");
    if (saved.initialized) {
      accounts = Array.isArray(saved.accounts)
        ? saved.accounts.filter(account => account && /^\d+$/.test(String(account.id)))
        : [];
      settings = normalizeSettings(saved.settings);
    } else {
      await api("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts, settings }),
      });
    }
    stateReady = true;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    applySettings();
    render();
    configureRefreshSchedule();
    if (accounts.length) refreshAccounts();
  } catch (error) {
    stateReady = true;
    console.error("Could not load or initialize the project data file:", error);
    showToast(`Project data file unavailable: ${error.message}`);
    applySettings();
    render();
  }
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function statusFor(account) {
  if (account.presenceError) return { key: "unknown", label: "Unavailable", detail: account.presenceError };
  const type = account.presence?.type;
  if (type === 2 || type === 3) {
    return { key: "ingame", label: "In-game", detail: account.presence.gameName || (type === 3 ? "In Studio" : "Playing a game") };
  }
  if (type === 1) return { key: "online", label: "Online", detail: "On the Roblox website" };
  if (type === 0) return { key: "offline", label: "Offline", detail: account.presence.lastOnline ? `Last online ${relativeTime(account.presence.lastOnline)}` : "Not currently online" };
  return { key: "unknown", label: "Unavailable", detail: account.presence ? "Roblox did not return presence" : "Waiting for presence data" };
}

function relativeTime(timestamp) {
  const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (!Number.isFinite(elapsed)) return "recently";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value || 0);
}

function render() {
  const query = document.querySelector("#searchInput").value.trim().toLowerCase();
  const visible = accounts.filter(account => {
    const matchesQuery = `${account.name} ${account.displayName} ${account.id}`.toLowerCase().includes(query);
    const matchesFilter = filter === "online"
      ? ["online", "ingame"].includes(statusFor(account).key)
      : filter === "favorites" ? account.favorite === true : true;
    return matchesQuery && matchesFilter;
  });
  document.querySelector("#totalStat").textContent = String(accounts.length).padStart(2, "0");
  document.querySelector("#navCount").textContent = accounts.length;
  document.querySelector("#rosterCount").textContent = accounts.length;
  document.querySelector("#favoriteCount").textContent = accounts.filter(account => account.favorite === true).length;
  document.querySelector("#ingameStat").textContent = String(accounts.filter(a => statusFor(a).key === "ingame").length).padStart(2, "0");
  document.querySelector("#onlineStat").textContent = String(accounts.filter(a => statusFor(a).key === "online").length).padStart(2, "0");
  const availableRap = accounts.filter(a => a.inventory?.available).reduce((sum, a) => sum + (a.inventory.rap || 0), 0);
  const completeRap = accounts.length > 0 && accounts.every(a => a.inventory?.available);
  document.querySelector("#rapStat").textContent = completeRap ? `R$ ${formatNumber(availableRap)}` : "—";
  emptyState.hidden = accounts.length > 0;
  accountList.classList.toggle("grid-view", settings.view === "grid");
  accountList.innerHTML = visible.map((account, index) => rowTemplate(account, index)).join("");
  if (accounts.length > 0 && visible.length === 0) {
    accountList.innerHTML = `<div class="loading-row">${filter === "favorites" ? "No favorite accounts yet. Star an account to add it to your offline alert watchlist." : "No accounts match your search."}</div>`;
  }
}

function rowTemplate(account, index) {
  const status = statusFor(account);
  const inventory = account.inventory;
  const inventoryText = inventory?.available
    ? `R$ ${formatNumber(inventory.rap)} RAP${inventory.estimated ? "+" : ""}`
    : inventory?.error ? "Unavailable" : "Loading...";
  const inventorySubtext = inventory?.available
    ? `${formatNumber(inventory.collectibles)} collectibles${inventory.estimated ? " · partial scan" : ""}`
    : inventory?.error ? "Inventory may be private" : "Fetching public inventory";
  const avatar = account.avatarUrl
    ? `<img src="${escapeHtml(account.avatarUrl)}" alt="" loading="lazy">`
    : `<span class="avatar-fallback">${escapeHtml((account.displayName || account.name || "?")[0])}</span>`;
  const onlineLabel = status.key === "ingame" ? "IN GAME" : status.key === "online" ? "ONLINE" : status.key === "offline" ? "OFFLINE" : "UNKNOWN";
  return `<article class="account-row" style="animation-delay:${Math.min(index * 35, 250)}ms">
    <div class="player"><div class="avatar-ring status-${status.key}">${avatar}</div><div class="player-name"><strong>${escapeHtml(account.displayName || account.name)}</strong><span>@${escapeHtml(account.name)} <span class="user-id">· ${escapeHtml(account.id)}</span></span></div><button class="favorite-toggle${account.favorite ? " is-favorite" : ""}" data-action="favorite" data-id="${escapeHtml(account.id)}" aria-pressed="${account.favorite === true}" aria-label="${account.favorite ? "Remove from" : "Add to"} offline alert watchlist" title="${account.favorite ? "Remove from offline alert watchlist" : "Add to offline alert watchlist"}">${account.favorite ? "★" : "☆"}</button></div>
    <div class="account-status"><span class="status-pill ${status.key}">${onlineLabel === "IN GAME" ? "In-game" : onlineLabel[0] + onlineLabel.slice(1).toLowerCase()}</span><div class="status-detail">${escapeHtml(status.detail)}</div></div>
    <div class="joined">${formatDate(account.created)}<span>JOINED ROBLOX</span></div>
    <div class="collectibles"><strong>${inventoryText}</strong><span>${inventorySubtext}</span></div>
    <button class="view-account" data-action="details" data-id="${escapeHtml(account.id)}" aria-label="View account details for ${escapeHtml(account.displayName || account.name)}" title="View account details"><span>View</span><span aria-hidden="true">↗</span></button>
    <div class="row-more-wrap"><button class="row-more" aria-label="Account options" data-menu="${escapeHtml(account.id)}">···</button><div class="row-menu" data-menu-content="${escapeHtml(account.id)}"><button class="remove" data-action="remove" data-id="${escapeHtml(account.id)}">Remove account</button></div></div>
  </article>`;
}

function setModal(open) {
  modalBackdrop.classList.toggle("open", open);
  modalBackdrop.setAttribute("aria-hidden", String(!open));
  document.body.style.overflow = open ? "hidden" : "";
  if (open) setTimeout(() => usernameInput.focus(), 80);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

async function fetchAccount(input) {
  let user;
  if (/^\d+$/.test(input)) {
    user = await api(`/api/users/${encodeURIComponent(input)}`);
  } else {
    const found = await api(`/api/lookup?username=${encodeURIComponent(input)}`);
    user = await api(`/api/users/${encodeURIComponent(found.id)}`);
  }
  return user;
}

async function addAccounts(input) {
  const entries = [...new Map(input.split(/[,\r\n]+/).map(entry => entry.trim()).filter(Boolean)
    .map(entry => [entry.toLowerCase(), entry])).values()];
  if (!entries.length) throw new Error("Enter at least one username or user ID.");
  if (entries.length > 25) throw new Error("Add up to 25 accounts per batch.");
  const results = new Array(entries.length);
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index];
      try {
        results[index] = { user: await fetchAccount(entry) };
      } catch (error) {
        results[index] = { error: error.message };
      } finally {
        completed++;
        submitButton.textContent = `Adding… ${completed}/${entries.length}`;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(entries.length, 3) }, () => worker()));
  const added = [];
  const knownIds = new Set(accounts.map(account => String(account.id)));
  const failures = [];
  results.forEach((result, index) => {
    if (result?.error) {
      failures.push(`${entries[index]}: ${result.error}`);
    } else if (result?.user) {
      const id = String(result.user.id);
      if (knownIds.has(id)) {
        failures.push(`${entries[index]}: Already on the watchlist.`);
      } else {
        knownIds.add(id);
        added.push({ ...result.user, favorite: false, presence: null, inventory: null });
      }
    }
  });
  if (added.length) {
    accounts.unshift(...added);
    saveAccounts();
    applySettings();
    render();
    refreshAccounts(true);
  }
  if (failures.length) {
    modalMessage.className = "modal-message";
    modalMessage.textContent = `${added.length ? `Added ${added.length}. ` : ""}Could not add: ${failures.join(" · ")}`;
    return;
  }
  setModal(false);
  usernameInput.value = "";
  modalMessage.textContent = "";
  showToast(`${added.length} account${added.length === 1 ? "" : "s"} added to your watchlist.`);
}

async function refreshAccounts(showBusy = false) {
  if (refreshBusy || accounts.length === 0) return;
  refreshBusy = true;
  const refreshButton = document.querySelector("#refreshButton");
  refreshButton.classList.add("spinning");
  document.querySelector("#updatedAt").textContent = "Checking Roblox...";
  try {
    const ids = accounts.map(account => Number(account.id));
    try {
      const presences = {};
      for (let start = 0; start < ids.length; start += 100) {
        Object.assign(presences, await api("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userIds: ids.slice(start, start + 100) }),
        }));
      }
      for (const account of accounts) {
        account.presence = presences[String(account.id)] || null;
        delete account.presenceError;
      }
    } catch (error) {
      for (const account of accounts) account.presenceError = error.message;
      console.warn("Presence refresh failed:", error);
      if (showBusy) showToast(error.message);
    }
    render();
    await Promise.all(accounts.filter(account => !account.inventory).map(async account => {
      try {
        account.inventory = await api("/api/inventory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: account.id }),
        });
      } catch (error) {
        account.inventory = { available: false, error: error.message };
      }
    }));
    saveAccounts();
    render();
    document.querySelector("#updatedAt").textContent = `Updated ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date())}`;
  } catch (error) {
    document.querySelector("#updatedAt").textContent = "Could not refresh";
    console.error("Account refresh failed:", error);
  } finally {
    refreshBusy = false;
    refreshButton.classList.remove("spinning");
  }
}

function removeAccount(id) {
  const account = accounts.find(item => String(item.id) === String(id));
  if (!account) return;
  accounts = accounts.filter(item => String(item.id) !== String(id));
  saveAccounts();
  render();
  showToast(`${account.displayName || account.name} removed.`);
}

function toggleFavorite(id) {
  const account = accounts.find(item => String(item.id) === String(id));
  if (!account) return;
  account.favorite = account.favorite !== true;
  saveAccounts();
  applySettings();
  render();
  showToast(account.favorite
    ? `${account.displayName || account.name} added to offline alert watchlist.`
    : `${account.displayName || account.name} removed from offline alert watchlist.`);
}

function showDetails(id) {
  const account = accounts.find(item => String(item.id) === String(id));
  if (!account) return;
  const presence = statusFor(account);
  const avatar = account.avatarUrl
    ? `<img class="detail-avatar" src="${escapeHtml(account.avatarUrl)}" alt="">`
    : `<div class="detail-avatar avatar-fallback">${escapeHtml((account.displayName || account.name || "?")[0])}</div>`;
  const rap = account.inventory?.available ? `R$ ${formatNumber(account.inventory.rap)}` : "Unavailable";
  document.querySelector("#detailsContent").innerHTML = `
    ${avatar}<div class="section-kicker">ACCOUNT DETAILS</div>
    <h2 id="detailsTitle">${escapeHtml(account.displayName || account.name)}</h2>
    <p class="modal-copy">@${escapeHtml(account.name)} · ${escapeHtml(account.id)}</p>
    <div class="detail-grid">
      <div class="detail-item"><span>STATUS</span><strong>${escapeHtml(presence.label)} · ${escapeHtml(presence.detail)}</strong></div>
      <div class="detail-item"><span>JOINED ROBLOX</span><strong>${formatDate(account.created)}</strong></div>
      <div class="detail-item"><span>COLLECTIBLES</span><strong>${account.inventory?.available ? formatNumber(account.inventory.collectibles) : "Unavailable"}</strong></div>
      <div class="detail-item"><span>COLLECTIBLE RAP ESTIMATE</span><strong>${escapeHtml(rap)}${account.inventory?.estimated ? "+" : ""}</strong></div>
      <div class="detail-item"><span>ACCOUNT MODERATION</span><strong>${account.isBanned ? "Banned" : "Not marked as banned"}</strong></div>
      <div class="detail-item"><span>USER ID</span><strong>${escapeHtml(account.id)}</strong></div>
    </div>
    <div class="detail-description">${escapeHtml(account.description || "No profile description.")}</div>
    <a class="detail-profile" href="https://www.roblox.com/users/${encodeURIComponent(account.id)}/profile" target="_blank" rel="noopener noreferrer">Open Roblox profile ↗</a>`;
  const backdrop = document.querySelector("#detailsBackdrop");
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

document.querySelector("#addOpen").addEventListener("click", () => setModal(true));
document.querySelector("#emptyAdd").addEventListener("click", () => setModal(true));
document.querySelector("#modalClose").addEventListener("click", () => setModal(false));
modalBackdrop.addEventListener("click", event => { if (event.target === modalBackdrop) setModal(false); });
document.querySelector("#settingsOpen").addEventListener("click", () => {
  settingsBackdrop.classList.add("open");
  settingsBackdrop.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
});
document.querySelector("#settingsClose").addEventListener("click", () => {
  settingsBackdrop.classList.remove("open");
  settingsBackdrop.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
});
settingsBackdrop.addEventListener("click", event => {
  if (event.target === settingsBackdrop) {
    settingsBackdrop.classList.remove("open");
    settingsBackdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
});
document.querySelector("#themeGrid").addEventListener("click", event => {
  const option = event.target.closest("[data-theme]");
  if (!option || !THEMES.includes(option.dataset.theme)) return;
  settings.theme = option.dataset.theme;
  applySettings();
  saveSettings();
});
document.querySelector("#autoRefreshToggle").addEventListener("change", event => {
  settings.autoRefresh = event.target.checked;
  applySettings();
  saveSettings();
  configureRefreshSchedule();
});
document.querySelector("#refreshIntervalSelect").addEventListener("change", event => {
  const interval = Number(event.target.value);
  if (!REFRESH_INTERVALS.includes(interval)) return;
  settings.refreshInterval = interval;
  applySettings();
  saveSettings();
  configureRefreshSchedule();
});
document.querySelector("#showIdsToggle").addEventListener("change", event => {
  settings.showUserIds = event.target.checked;
  applySettings();
  saveSettings();
});
document.querySelector("#compactToggle").addEventListener("change", event => {
  settings.compactRows = event.target.checked;
  applySettings();
  saveSettings();
});
document.querySelector("#reduceMotionToggle").addEventListener("change", event => {
  settings.reduceMotion = event.target.checked;
  applySettings();
  saveSettings();
});
document.querySelector("#webhookEnabledToggle").addEventListener("change", event => {
  settings.webhookEnabled = event.target.checked;
  applySettings();
  saveSettings();
});
document.querySelector("#webhookUrlInput").addEventListener("input", event => {
  settings.webhookUrl = event.target.value.trim();
  document.querySelector("#testWebhookButton").disabled = !settings.webhookUrl;
  document.querySelector("#webhookMessage").textContent = "";
  saveSettings();
});
document.querySelector("#webhookMentionInput").addEventListener("input", event => {
  settings.webhookMention = event.target.value.trim();
  document.querySelector("#webhookMessage").textContent = "";
  saveSettings();
});
document.querySelector("#testWebhookButton").addEventListener("click", async event => {
  const button = event.currentTarget;
  const message = document.querySelector("#webhookMessage");
  if (!settings.webhookUrl.trim()) {
    message.textContent = "Enter a Discord webhook URL first.";
    message.className = "webhook-message error";
    return;
  }
  button.disabled = true;
  button.textContent = "Sending test…";
  message.textContent = "";
  try {
    await persistStateNow();
    const result = await api("/api/webhook/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    message.textContent = result.message;
    message.className = "webhook-message success";
  } catch (error) {
    message.textContent = error.message;
    message.className = "webhook-message error";
  } finally {
    button.disabled = !settings.webhookUrl.trim();
    button.innerHTML = 'Send test message <span>↗</span>';
  }
});
document.querySelectorAll(".view-toggle-button").forEach(button => {
  button.addEventListener("click", () => {
    settings.view = button.dataset.view === "grid" ? "grid" : "list";
    applySettings();
    saveSettings();
  });
});
const detailsBackdrop = document.querySelector("#detailsBackdrop");
document.querySelector("#detailsClose").addEventListener("click", () => {
  detailsBackdrop.classList.remove("open");
  detailsBackdrop.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
});
detailsBackdrop.addEventListener("click", event => {
  if (event.target === detailsBackdrop) {
    detailsBackdrop.classList.remove("open");
    detailsBackdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    setModal(false);
    detailsBackdrop.classList.remove("open");
    detailsBackdrop.setAttribute("aria-hidden", "true");
    settingsBackdrop.classList.remove("open");
    settingsBackdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    document.querySelector("#searchInput").focus();
  }
});
addForm.addEventListener("submit", async event => {
  event.preventDefault();
  const value = usernameInput.value.trim();
  if (!value) return;
  submitButton.disabled = true;
  submitButton.textContent = "Adding…";
  modalMessage.className = "modal-message";
  modalMessage.textContent = "";
  try {
    await addAccounts(value);
  } catch (error) {
    modalMessage.textContent = error.message;
    modalMessage.className = "modal-message";
    console.error("Could not add account:", error);
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Add accounts <span>↗</span>';
  }
});
document.querySelector("#searchInput").addEventListener("input", render);
filterButton.addEventListener("click", () => {
  filter = filter === "all" ? "online" : "all";
  filterButton.innerHTML = `<span>☷</span> ${filter === "all" ? "All accounts" : "Online now"} <span class="chevron">⌄</span>`;
  render();
});
document.querySelector("#onlineNav").addEventListener("click", () => {
  filter = "online";
  filterButton.innerHTML = '<span>☷</span> Online now <span class="chevron">⌄</span>';
  document.querySelector("#dashboardNav").classList.remove("active");
  render();
});
document.querySelector("#favoritesNav").addEventListener("click", () => {
  filter = "favorites";
  filterButton.innerHTML = '<span>☷</span> Offline watchlist <span class="chevron">⌄</span>';
  document.querySelector("#dashboardNav").classList.remove("active");
  render();
});
document.querySelector("#dashboardNav").addEventListener("click", () => {
  filter = "all";
  filterButton.innerHTML = '<span>☷</span> All accounts <span class="chevron">⌄</span>';
  document.querySelector("#dashboardNav").classList.add("active");
  render();
});
document.querySelector("#refreshButton").addEventListener("click", () => refreshAccounts(true));
accountList.addEventListener("click", event => {
  const menuButton = event.target.closest("[data-menu]");
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const id = actionButton.dataset.id;
    if (actionButton.dataset.action === "remove") removeAccount(id);
    if (actionButton.dataset.action === "details") showDetails(id);
    if (actionButton.dataset.action === "favorite") toggleFavorite(id);
    return;
  }
  if (menuButton) {
    const id = menuButton.dataset.menu;
    const menu = accountList.querySelector(`[data-menu-content="${CSS.escape(id)}"]`);
    const wasOpen = menu.classList.contains("open");
    accountList.querySelectorAll(".row-menu.open").forEach(item => item.classList.remove("open"));
    if (!wasOpen) menu.classList.add("open");
    return;
  }
  accountList.querySelectorAll(".row-menu.open").forEach(item => item.classList.remove("open"));
});

applySettings();
render();
initializeState();
