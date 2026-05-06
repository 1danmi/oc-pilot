const STORAGE_KEY = "openshiftAutoLogin";

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
    clickToCopy:  true,
    favourites:   true,
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
      $("feat-podActions").checked   = cfg.features.podActions   !== false;
      $("feat-forceDelete").checked  = cfg.features.forceDelete  !== false;
      $("feat-crossLinks").checked   = cfg.features.crossLinks   !== false;
      $("feat-loginToast").checked   = cfg.features.loginToast   !== false;
      $("feat-copyLoginCmd").checked = cfg.features.copyLoginCmd !== false;
      $("feat-clickToCopy").checked  = cfg.features.clickToCopy  !== false;
      $("feat-favourites").checked   = cfg.features.favourites   !== false;
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
        podActions:   $("feat-podActions").checked,
        forceDelete:  $("feat-forceDelete").checked,
        crossLinks:   $("feat-crossLinks").checked,
        loginToast:   $("feat-loginToast").checked,
        copyLoginCmd: $("feat-copyLoginCmd").checked,
        clickToCopy:  $("feat-clickToCopy").checked,
        favourites:   $("feat-favourites").checked,
      } : (existing.features || defaults.features),
    };
    chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
      updateStatus(cfg);
      flash("Saved successfully", "show-ok");
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
function saveFeatures() {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const existing = data[STORAGE_KEY] || {};
    const cfg = {
      ...existing,
      features: {
        ownerLink:    $("feat-ownerLink").checked,
        podActions:   $("feat-podActions").checked,
        forceDelete:  $("feat-forceDelete").checked,
        crossLinks:   $("feat-crossLinks").checked,
        loginToast:   $("feat-loginToast").checked,
        copyLoginCmd: $("feat-copyLoginCmd").checked,
        clickToCopy:  $("feat-clickToCopy").checked,
        favourites:   $("feat-favourites").checked,
      },
    };
    chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
      flash("Feature saved", "show-ok");
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Activate wide dark layout when opened as a full tab.
  if (IS_TAB) document.body.classList.add("tab-mode");

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

  // Console-feature toggles auto-save on change (tab mode only).
  if (IS_TAB) {
    ["feat-ownerLink", "feat-podActions", "feat-forceDelete",
     "feat-crossLinks", "feat-loginToast", "feat-copyLoginCmd",
     "feat-clickToCopy", "feat-favourites"].forEach((id) => {
      $(id).addEventListener("change", saveFeatures);
    });
  }

  // Draft persistence: every keystroke in the add-override form writes to
  // session storage; when the popup opens we restore if the active tab is
  // still on the same cluster, otherwise discard the draft.
  wireDraftPersistence();
  restoreDraftIfAny();

  // Cluster colour picker — show only in popup mode on a console tab.
  getCurrentHost().then((host) => { if (host) initClusterColourPicker(host); });
});
