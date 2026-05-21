const STORAGE_KEY = "openshiftAutoLogin";

// Fire-and-forget telemetry bump. Silent on any failure — telemetry must never
// break the settings UI.
function bumpEvent(name) {
  try { chrome.runtime.sendMessage({ type: "telemetry/bump", event: name }); } catch (_) {}
}

// Ephemeral "unsaved" draft of the add-override form. Lives in
// chrome.storage.session so it survives popup-close/reopen within the same
// browser session but NOT a browser restart. Keyed implicitly by the host
// stored inside the draft itself — if the active tab is on a different host
// when the popup re-opens, we discard the draft (user moved clusters).
const DRAFT_KEY = "overrideAddDraft";

const $ = (id) => document.getElementById(id);

const EYE_OPEN = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
const EYE_CLOSED = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`;

const defaults = {
  username: "",
  password: "",
  providerName: "ldap-provider",
  autoSubmit: true,
  autoCopyToken: true,
  overrides: {},
  features: {
    ownerLink:    true,
    podActions:   true,
    forceDelete:  true,
    crossLinks:   true,
    loginToast:   true,
    copyLoginCmd: true,
    copyLoginTimeoutSec: 45,
    clickToCopy:  true,
    favourites:   true,
    persistSort:  true,
  },
};

// ── Tab-mode detection ────────────────────────────────────────────────────────
// When the user opens settings via "open in tab", we append ?mode=tab to the
// URL. In tab mode the body gets the .tab-mode class which triggers the wide
// dark layout and reveals the features section.
const IS_TAB = new URLSearchParams(location.search).get("mode") === "tab";

// ── Load / Save ──────────────────────────────────────────────────────────────

function load() {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const cfg = { ...defaults, ...(data[STORAGE_KEY] || {}) };
    cfg.overrides = cfg.overrides || {};
    cfg.features  = { ...defaults.features, ...(cfg.features || {}) };
    $("username").value = cfg.username;
    $("password").value = cfg.password;
    $("autoSubmit").checked   = cfg.autoSubmit;
    $("autoCopyToken").checked = cfg.autoCopyToken;
    // Feature toggles (only present in tab mode DOM)
    if (IS_TAB) {
      $("feat-ownerLink").checked    = cfg.features.ownerLink    !== false;
      $("feat-podTerminal").checked  = cfg.features.podTerminal  !== false;
      $("feat-podLogs").checked      = cfg.features.podLogs      !== false;
      $("feat-podEvents").checked    = cfg.features.podEvents    !== false;
      $("feat-podImageTag").checked  = cfg.features.podImageTag  !== false;
      $("feat-forceDelete").checked  = cfg.features.forceDelete  !== false;
      $("feat-crossLinks").checked   = cfg.features.crossLinks   !== false;
      $("feat-loginToast").checked   = cfg.features.loginToast   !== false;
      $("feat-copyLoginCmd").checked = cfg.features.copyLoginCmd !== false;
      const _tov = cfg.features.copyLoginTimeoutSec;
      $("feat-copyLoginTimeoutSec").value = (typeof _tov === 'number' && _tov > 0) ? _tov : 45;
      $("feat-clickToCopy").checked  = cfg.features.clickToCopy  !== false;
      $("feat-favourites").checked   = cfg.features.favourites   !== false;
      $("feat-persistSort").checked  = cfg.features.persistSort  !== false;
    }
    updateStatus(cfg);
    renderOverrides(cfg.overrides);
  });
}

function updateStatus(cfg) {
  const dot  = $("statusDot");
  const text = $("statusText");
  const sub  = $("headerSub");

  if (cfg.username && cfg.password) {
    dot.className    = "status-dot on";
    text.textContent = "On";
    sub.textContent  = `Active · ${cfg.username}`;
  } else {
    dot.className    = "status-dot off";
    text.textContent = "Off";
    sub.textContent  = "Not configured";
  }
}

function save() {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const existing = data[STORAGE_KEY] || {};
    const cfg = {
      ...existing,
      username:     $("username").value.trim(),
      password:     $("password").value,
      autoSubmit:   $("autoSubmit").checked,
      autoCopyToken: $("autoCopyToken").checked,
      providerName: existing.providerName || defaults.providerName,
      overrides:    existing.overrides || {},
      features: IS_TAB ? {
        ownerLink:    $("feat-ownerLink").checked,
        podTerminal:  $("feat-podTerminal").checked,
        podLogs:      $("feat-podLogs").checked,
        podEvents:    $("feat-podEvents").checked,
        podImageTag:  $("feat-podImageTag").checked,
        forceDelete:  $("feat-forceDelete").checked,
        crossLinks:   $("feat-crossLinks").checked,
        loginToast:   $("feat-loginToast").checked,
        copyLoginCmd: $("feat-copyLoginCmd").checked,
        clickToCopy:  $("feat-clickToCopy").checked,
        favourites:   $("feat-favourites").checked,
        persistSort:  $("feat-persistSort").checked,
      } : (existing.features || defaults.features),
    };
    chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
      updateStatus(cfg);
      flash("Saved successfully", "show-ok");
      bumpEvent("settings.credentialsSaved");
    });
  });
}

function clear() {
  chrome.storage.local.remove(STORAGE_KEY, () => {
    $("username").value = "";
    $("password").value = "";
    $("autoSubmit").checked = defaults.autoSubmit;
    $("autoCopyToken").checked = defaults.autoCopyToken;
    updateStatus(defaults);
    renderOverrides({});
    flash("Credentials cleared", "show-clear");
  });
}

let flashTimer;
function flash(msg, cls) {
  const el = $("feedback");
  clearTimeout(flashTimer);
  el.textContent = msg;
  el.className = `feedback ${cls}`;
  flashTimer = setTimeout(() => { el.className = "feedback"; }, 2500);
}

// ── Password toggles ─────────────────────────────────────────────────────────

function togglePw() {
  const input = $("password");
  const icon  = $("eyeIcon");
  if (input.type === "password") { input.type = "text"; icon.innerHTML = EYE_CLOSED; }
  else                           { input.type = "password"; icon.innerHTML = EYE_OPEN; }
}

function toggleOverridePw() {
  const input = $("overridePass");
  const icon  = $("overrideEyeIcon");
  if (input.type === "password") { input.type = "text"; icon.innerHTML = EYE_CLOSED; }
  else                           { input.type = "password"; icon.innerHTML = EYE_OPEN; }
}

// ── Overrides ────────────────────────────────────────────────────────────────

function renderOverrides(overrides) {
  const list = $("overrideList");
  const hosts = Object.keys(overrides || {});
  if (!hosts.length) {
    list.innerHTML = `<div class="empty-overrides">No cluster overrides configured</div>`;
    return;
  }

  list.innerHTML = "";
  hosts.forEach((host) => {
    const user = overrides[host].username || "";
    const pass = overrides[host].password || "";
    const entry = document.createElement("div");
    entry.className = "override-entry";

    entry.innerHTML = `
      <div class="override-display">
        <div class="override-entry-info">
          <div class="override-host" title="${escHtml(host)}">${escHtml(host)}</div>
          <div class="override-user">${escHtml(user || "(no username)")}</div>
        </div>
        <div class="override-entry-actions">
          <button class="btn-edit-override" title="Edit override">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn-del-override" title="Remove override">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="override-edit-form">
        <label class="field-label">Username</label>
        <input type="text" class="edit-user" value="${escHtml(user)}" autocomplete="off" spellcheck="false" />
        <label class="field-label">Password</label>
        <div class="pw-wrap">
          <input type="password" class="edit-pass" autocomplete="off" />
          <button class="eye-btn" type="button" title="Show / hide password">
            <svg class="edit-eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${EYE_OPEN}
            </svg>
          </button>
        </div>
        <div class="form-actions">
          <button class="btn-confirm btn-save-edit" type="button">Save</button>
          <button class="btn-cancel-form btn-cancel-edit" type="button">Cancel</button>
        </div>
      </div>`;

    // Set password value directly (avoids HTML-escaping issues with special chars)
    entry.querySelector(".edit-pass").value = pass;

    entry.querySelector(".btn-edit-override").addEventListener("click", () => {
      entry.classList.add("editing");
      entry.querySelector(".edit-user").focus();
    });
    entry.querySelector(".btn-del-override").addEventListener("click", () => deleteOverride(host));
    entry.querySelector(".btn-cancel-edit").addEventListener("click", () => {
      entry.classList.remove("editing");
    });
    entry.querySelector(".eye-btn").addEventListener("click", () => {
      const input = entry.querySelector(".edit-pass");
      const icon  = entry.querySelector(".edit-eye-icon");
      if (input.type === "password") { input.type = "text"; icon.innerHTML = EYE_CLOSED; }
      else                           { input.type = "password"; icon.innerHTML = EYE_OPEN; }
    });
    entry.querySelector(".btn-save-edit").addEventListener("click", () => {
      const newUser = entry.querySelector(".edit-user").value.trim();
      const newPass = entry.querySelector(".edit-pass").value;
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        const cfg = data[STORAGE_KEY] || {};
        const overrides = { ...(cfg.overrides || {}) };
        overrides[host] = { username: newUser, password: newPass };
        cfg.overrides = overrides;
        chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
          renderOverrides(overrides);
          flash("Override saved", "show-ok");
        });
      });
    });

    list.appendChild(entry);
  });
}

function showAddForm() {
  $("addForm").classList.add("visible");
  $("showAddForm").style.display = "none";
  $("overrideHost").value = "";
  $("overrideUser").value = "";
  $("overridePass").value = "";

  // Pre-fill hostname from the active tab if it looks like an OpenShift host
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    try {
      const url = new URL(tabs[0].url || "");
      if (url.hostname && url.protocol.startsWith("http")) {
        $("overrideHost").value = url.hostname;
      }
    } catch (_) {}
  });
  $("overrideUser").focus();
}

function hideAddForm() {
  $("addForm").classList.remove("visible");
  $("showAddForm").style.display = "";
  // Any explicit exit from the form (Cancel, or a successful Save) means the
  // draft is no longer wanted.
  clearDraft();
}

// ── Draft persistence for the add-override form ──────────────────────────────

function getCurrentHost() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return resolve("");
      try {
        const url = new URL(tabs[0].url || "");
        if (url.protocol.startsWith("http") && url.hostname) return resolve(url.hostname);
      } catch (_) {}
      resolve("");
    });
  });
}

// ── Cluster colour picker ─────────────────────────────────────────────────────

function initClusterColourPicker(host) {
  const section = document.getElementById('cluster-colour-section');
  if (!host || !section) return;
  // Only show in popup mode (not the full-tab settings page).
  if (IS_TAB) return;
  section.style.display = '';
  const hostEl = document.getElementById('cluster-colour-host');
  if (hostEl) { hostEl.textContent = host; hostEl.title = host; }
  chrome.storage.local.get('ocPilotClusterColours', (data) => {
    const map = ((data || {}).ocPilotClusterColours) || {};
    renderSwatches(map[host] || '', host);
  });
}

function renderSwatches(selectedColour, host) {
  document.querySelectorAll('.colour-swatch').forEach((btn) => {
    const colour = btn.dataset.colour;
    if (colour) btn.style.backgroundColor = colour;
    btn.classList.toggle('selected', colour === selectedColour);
    btn.onclick = () => saveClusterColour(host, colour);
  });
}

function saveClusterColour(host, colour) {
  chrome.storage.local.get('ocPilotClusterColours', (data) => {
    const map = ((data || {}).ocPilotClusterColours) || {};
    if (colour) {
      map[host] = colour;
    } else {
      delete map[host];
    }
    chrome.storage.local.set({ ocPilotClusterColours: map }, () => {
      document.querySelectorAll('.colour-swatch').forEach((b) =>
        b.classList.toggle('selected', b.dataset.colour === colour));
      bumpEvent(colour ? "settings.colour.set" : "settings.colour.cleared");
    });
  });
}

function getDraft() {
  return new Promise((resolve) => {
    if (!chrome.storage.session) return resolve(null);
    chrome.storage.session.get(DRAFT_KEY, (data) => resolve(data[DRAFT_KEY] || null));
  });
}

function setDraft(draft) {
  if (!chrome.storage.session) return;
  chrome.storage.session.set({ [DRAFT_KEY]: draft });
}

function clearDraft() {
  if (!chrome.storage.session) return;
  chrome.storage.session.remove(DRAFT_KEY);
}

function saveDraftFromInputs() {
  // Only matters while the add form is visible.
  if (!$("addForm").classList.contains("visible")) return;
  const host = $("overrideHost").value.trim();
  const user = $("overrideUser").value;
  const pass = $("overridePass").value;
  if (!host && !user && !pass) { clearDraft(); return; }
  setDraft({ host, username: user, password: pass });
}

async function restoreDraftIfAny() {
  const draft = await getDraft();
  if (!draft || !draft.host) return;
  const currentHost = await getCurrentHost();

  // Different cluster → the draft is stale. Drop it.
  // Can't determine current host (chrome://, about:blank, etc.) → keep the
  // draft; the user can still want to see what they typed.
  if (currentHost && currentHost !== draft.host) {
    clearDraft();
    return;
  }

  // Same cluster (or unknown) → re-open the add form with the saved values.
  $("addForm").classList.add("visible");
  $("showAddForm").style.display = "none";
  $("overrideHost").value = draft.host || "";
  $("overrideUser").value = draft.username || "";
  $("overridePass").value = draft.password || "";
  // Focus the first empty field so the user can keep typing where they left off.
  if (!draft.username) $("overrideUser").focus();
  else if (!draft.password) $("overridePass").focus();
}

function wireDraftPersistence() {
  ["overrideHost", "overrideUser", "overridePass"].forEach((id) => {
    $(id).addEventListener("input", saveDraftFromInputs);
  });
}

function addOverride() {
  const host = $("overrideHost").value.trim();
  const user = $("overrideUser").value.trim();
  const pass = $("overridePass").value;
  if (!host) { $("overrideHost").focus(); return; }
  if (!user && !pass) { $("overrideUser").focus(); return; }

  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const cfg = data[STORAGE_KEY] || {};
    const overrides = { ...(cfg.overrides || {}) };
    overrides[host] = { username: user, password: pass };
    cfg.overrides = overrides;
    chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
      hideAddForm();
      renderOverrides(overrides);
      flash("Override added", "show-ok");
      bumpEvent("settings.override.added");
    });
  });
}

function deleteOverride(host) {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const cfg = data[STORAGE_KEY] || {};
    const overrides = { ...(cfg.overrides || {}) };
    delete overrides[host];
    cfg.overrides = overrides;
    chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
      renderOverrides(overrides);
      flash("Override removed", "show-clear");
      bumpEvent("settings.override.removed");
    });
  });
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ── Auto-save for Console features (tab mode only) ───────────────────────────
// Reads the current state of all feat-* checkboxes and merges it into storage
// without touching the login credentials. Shows a small toast on success.
// `changedFlag` (optional) is the name of the flag the user just toggled —
// used to emit a precise telemetry event like settings.featureToggled.<name>.on.
function saveFeatures(changedFlag) {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const existing = data[STORAGE_KEY] || {};
    const features = {
      ownerLink:    $("feat-ownerLink").checked,
      podTerminal:  $("feat-podTerminal").checked,
      podLogs:      $("feat-podLogs").checked,
      podEvents:    $("feat-podEvents").checked,
      podImageTag:  $("feat-podImageTag").checked,
      forceDelete:  $("feat-forceDelete").checked,
      crossLinks:   $("feat-crossLinks").checked,
      loginToast:   $("feat-loginToast").checked,
      copyLoginCmd: $("feat-copyLoginCmd").checked,
      copyLoginTimeoutSec: parseInt($("feat-copyLoginTimeoutSec").value, 10) || 45,
      clickToCopy:  $("feat-clickToCopy").checked,
      favourites:   $("feat-favourites").checked,
      persistSort:  $("feat-persistSort").checked,
    };
    const cfg = { ...existing, features };
    chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
      flash("Feature saved", "show-ok");
      if (changedFlag && Object.prototype.hasOwnProperty.call(features, changedFlag)) {
        const onOff = features[changedFlag] ? "on" : "off";
        bumpEvent("settings.featureToggled." + changedFlag + "." + onOff);
      }
    });
  });
}

// ── Diagnostics (tab mode only) ──────────────────────────────────────────────
//
// Lets the developer:
//   • see the current machine UUID, counter sum, last successful send time,
//     and which telemetry endpoint is actually in use.
//   • override the telemetry server URL / bearer token per install — handy
//     when redirecting traffic to a test instance without re-packing the CRX.
//   • flush the in-storage counters NOW by triggering a synchronous send
//     in background.js (the "Send telemetry now" button).
//
// No event is bumped for the manual-send button itself — that would inflate
// counts and isn't user behaviour we care to track.

function formatRelative(unixSec) {
  if (!unixSec) return "never";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSec));
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function diagStatus(msg, kind) {
  // kind: '' (neutral) | 'ok' | 'err' | 'pending'
  const el = $("diag-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "diag-status" + (kind ? " diag-status-" + kind : "");
}

function refreshDiagnostics() {
  if (!IS_TAB) return;
  if (!$("diag-machine-id")) return;
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const cfg = (data || {})[STORAGE_KEY] || {};
    const tel = cfg.telemetry || {};
    const counters = tel.counters || {};
    const sum = Object.values(counters).reduce((s, v) => s + ((v | 0) || 0), 0);
    const machineId = tel.machineId || "(not seeded yet)";
    $("diag-machine-id").textContent = machineId.length > 8 ? machineId.slice(0, 8) + "…" : machineId;
    $("diag-machine-id").title = machineId;
    $("diag-counter-sum").textContent = String(sum);
    $("diag-last-send").textContent = formatRelative(tel.lastSendAt);
    // Fetch URL, interval and next-fire time from background.
    try {
      chrome.runtime.sendMessage({ type: "telemetry/getConfig" }, (cfg) => {
        if (chrome.runtime.lastError || !cfg) return;
        if ($("diag-endpoint")) {
          const url = cfg.url || "(unknown)";
          $("diag-endpoint").textContent = url;
          $("diag-endpoint").title = url;
        }
        // Interval — only pre-fill the input if the user isn't actively editing it.
        const intervalInput = $("diag-interval");
        if (intervalInput && document.activeElement !== intervalInput) {
          intervalInput.value = cfg.intervalMinutes || "";
          intervalInput.placeholder = String(cfg.intervalMinutes || 60);
        }
        // Next scheduled send time.
        if ($("diag-next-fire")) {
          $("diag-next-fire").textContent = cfg.nextFire
            ? new Date(cfg.nextFire).toLocaleTimeString()
            : "—";
        }
      });
    } catch (_) {}
  });
}


function sendTelemetryNow() {
  const btn = $("diag-send-now");
  if (!btn) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Sending…";
  diagStatus("Sending…", "pending");

  try {
    chrome.runtime.sendMessage({ type: "telemetry/sendNow" }, (res) => {
      const lastErr = chrome.runtime.lastError;
      btn.disabled = false;
      btn.textContent = originalText;
      if (lastErr) {
        diagStatus("Failed: " + lastErr.message, "err");
      } else if (res && res.ok) {
        diagStatus(
          `Sent ${res.eventCount || 0} event${res.eventCount === 1 ? "" : "s"} at ${new Date().toLocaleTimeString()}`,
          "ok"
        );
        refreshDiagnostics();
      } else {
        diagStatus("Failed: " + ((res && res.error) || "see console"), "err");
      }
      setTimeout(() => diagStatus("", ""), 5000);
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalText;
    diagStatus("Failed: " + String(err && err.message || err), "err");
  }
}

function applyTelemetryInterval() {
  const input = $("diag-interval");
  if (!input) return;
  const minutes = parseInt(input.value, 10);
  if (!minutes || minutes < 1) {
    diagStatus("Enter a number ≥ 1", "err");
    setTimeout(() => diagStatus("", ""), 3000);
    return;
  }
  const btn = $("diag-apply-interval");
  if (btn) btn.disabled = true;
  diagStatus("Applying…", "pending");
  try {
    chrome.runtime.sendMessage({ type: "telemetry/setInterval", minutes }, (res) => {
      if (btn) btn.disabled = false;
      if (chrome.runtime.lastError || !res) {
        diagStatus("Failed: " + (chrome.runtime.lastError?.message || "no response"), "err");
      } else if (res.ok) {
        diagStatus(`Interval set to ${res.intervalMinutes} min — next send at ${res.nextFire ? new Date(res.nextFire).toLocaleTimeString() : "?"}`, "ok");
        refreshDiagnostics();
      } else {
        diagStatus("Failed: " + (res.error || "unknown"), "err");
      }
      setTimeout(() => diagStatus("", ""), 5000);
    });
  } catch (err) {
    if (btn) btn.disabled = false;
    diagStatus("Failed: " + String(err && err.message || err), "err");
  }
}

function initDiagnostics() {
  if (!IS_TAB) return;

  // ── Easter-egg: 5 clicks on the header icon within 3 s reveals dev section ─
  let devTapCount = 0;
  let devTapTimer = null;
  const devTrigger = $("dev-trigger");
  if (!devTrigger) return;

  devTrigger.style.cursor = "default";
  devTrigger.addEventListener("click", () => {
    // Brief flash on each tap so the developer gets tactile feedback
    devTrigger.classList.remove("dev-tap");
    void devTrigger.offsetWidth;           // reflow to restart animation
    devTrigger.classList.add("dev-tap");

    devTapCount++;
    clearTimeout(devTapTimer);

    if (devTapCount >= 5) {
      devTapCount = 0;
      document.body.classList.add("dev-mode");
      refreshDiagnostics();
      if ($("diag-send-now"))       $("diag-send-now").addEventListener("click", sendTelemetryNow);
      if ($("diag-apply-interval")) $("diag-apply-interval").addEventListener("click", applyTelemetryInterval);
      setInterval(refreshDiagnostics, 2000);

      // Toast notification
      const toast = $("dev-toast");
      if (toast) {
        toast.classList.remove("hide");
        toast.classList.add("show");
        setTimeout(() => {
          toast.classList.remove("show");
          toast.classList.add("hide");
          setTimeout(() => toast.classList.remove("hide"), 400);
        }, 2500);
      }
    } else {
      // Reset count if no further click within 3 s
      devTapTimer = setTimeout(() => { devTapCount = 0; }, 3000);
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Activate wide dark layout when opened as a full tab.
  if (IS_TAB) document.body.classList.add("tab-mode");

  // Telemetry: which mode are we in? Bump immediately so even an instantly-
  // closed popup is counted.
  bumpEvent(IS_TAB ? "settings.tabOpened" : "popup.opened");

  load();
  $("save").addEventListener("click", save);
  $("clear").addEventListener("click", clear);
  $("togglePw").addEventListener("click", togglePw);
  $("toggleOverridePw").addEventListener("click", toggleOverridePw);
  $("showAddForm").addEventListener("click", showAddForm);
  $("cancelAdd").addEventListener("click", hideAddForm);
  $("confirmAdd").addEventListener("click", addOverride);
  $("openInTab").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=tab") });
  });

  // Console-feature toggles auto-save on change (tab mode only). Pass the
  // checkbox id stripped of the `feat-` prefix so saveFeatures can emit a
  // precise telemetry event like settings.featureToggled.podTerminal.on.
  if (IS_TAB) {
    ["feat-ownerLink", "feat-podTerminal", "feat-podLogs", "feat-podEvents", "feat-podImageTag", "feat-forceDelete",
     "feat-crossLinks", "feat-loginToast", "feat-copyLoginCmd",
     "feat-clickToCopy", "feat-favourites", "feat-persistSort"].forEach((id) => {
      const flagName = id.replace(/^feat-/, "");
      $(id).addEventListener("change", () => saveFeatures(flagName));
    });
    $("feat-copyLoginTimeoutSec").addEventListener("change", () => saveFeatures());
  }

  // Draft persistence: every keystroke in the add-override form writes to
  // session storage; when the popup opens we restore if the active tab is
  // still on the same cluster, otherwise discard the draft.
  wireDraftPersistence();
  restoreDraftIfAny();

  // Cluster colour picker — show only in popup mode on a console tab.
  getCurrentHost().then((host) => { if (host) initClusterColourPicker(host); });

  // Diagnostics — tab mode only.
  initDiagnostics();
});
