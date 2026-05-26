const OFFSCREEN_URL = "offscreen.html";

// ── Per-tab pending-login registry ───────────────────────────────────────────
// Keyed by tabId so the "Logged in automatically" toast only fires in the tab
// that actually submitted the login form — not in every other tab that happens
// to finish loading a page within the same 30-second window.
const pendingLoginTabs = new Map(); // tabId → { username, ts }

// ── Telemetry ───────────────────────────────────────────────────────────────
//
// Every running extension POSTs an anonymous usage-stats heartbeat to a
// self-hosted FastAPI server every hour (and immediately on install / update).
// What's collected: machine UUID, hashed OAuth username, version, and a flat
// {eventName: count} map. What's NEVER collected: cluster URLs, resource names,
// the actual username, or IPs.
//
// `t.config` lives in the extension/ folder and is read at runtime via
// fetch(chrome.runtime.getURL('t.config')). It is .gitignored and is
// deleted from the staging directory by scripts/build-crx.ps1 before the
// CRX is zipped, so it is never bundled. For unpacked installs (Load
// unpacked → extension/) the file is read directly each time the SW starts.
// Per-install overrides via the Diagnostics section in tab-mode settings
// (openshiftAutoLogin.telemetry.serverUrl / serverToken) take precedence
// over t.config values.
//
// All telemetry code is wrapped in try/catch so failures only show up in
// console.warn — they MUST NEVER break the extension's normal features.

const TELEMETRY_PERIOD_HOURS  = 1;
const TELEMETRY_ALARM_NAME    = "oc-pilot-telemetry";
const TELEMETRY_LOG           = "[oc-pilot:telemetry]";

// Loaded once at SW startup from t.config in the extension folder.
// Resolves to { url, token } on success, or null when the file is absent
// or missing the required fields. All telemetry senders await this.
const _telemetryConfigPromise = (async () => {
  try {
    const resp = await fetch(chrome.runtime.getURL("t.config"));
    if (!resp.ok) return null;
    const cfg = await resp.json();
    const url   = cfg && String(cfg.url   || "").trim();
    const token = cfg && String(cfg.token || "").trim();
    if (url && token) return { url, token };
    return null;
  } catch (_) {
    return null;
  }
})();

// One-shot startup log when t.config is absent or incomplete.
// The SW console clears between SW lifetimes so this fires once per wake-up.
_telemetryConfigPromise.then((cfg) => {
  if (!cfg) {
    console.log(
      TELEMETRY_LOG,
      "disabled — t.config not found in extension folder or missing url/token. " +
      "Place t.config in the extension/ folder to enable, or configure " +
      "URL+token via the popup's tab-mode Diagnostics section."
    );
  }
});

/**
 * Atomically increment counters[event] in chrome.storage.local.
 * Used both by the telemetry/bump message handler AND directly by other
 * background.js handlers (copylogin.completed / failed).
 *
 * Silent on any error — telemetry is best-effort and must never throw.
 */
function bumpCounter(event) {
  if (typeof event !== "string" || !event) return;
  try {
    chrome.storage.local.get("openshiftAutoLogin", (data) => {
      try {
        if (chrome.runtime.lastError) return;
        const cfg = (data && data.openshiftAutoLogin) || {};
        const tel = cfg.telemetry || {};
        const counters = (tel.counters && typeof tel.counters === "object")
          ? { ...tel.counters }
          : {};
        counters[event] = (counters[event] | 0) + 1;
        const merged = {
          ...cfg,
          telemetry: { ...tel, counters },
        };
        chrome.storage.local.set({ openshiftAutoLogin: merged }, () => {
          if (chrome.runtime.lastError) {
            console.warn(TELEMETRY_LOG, "bump set failed:", chrome.runtime.lastError);
          }
        });
      } catch (err) {
        console.warn(TELEMETRY_LOG, "bump callback threw:", err);
      }
    });
  } catch (err) {
    console.warn(TELEMETRY_LOG, "bump outer threw:", err);
  }
}

/** SHA-256("oc-pilot:" + username.toLowerCase()) → lowercase hex. */
async function hashUsername(username) {
  if (!username) return null;
  try {
    const input = "oc-pilot:" + String(username).toLowerCase();
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i].toString(16);
      hex += b.length === 1 ? "0" + b : b;
    }
    return hex;
  } catch (err) {
    console.warn(TELEMETRY_LOG, "hashUsername failed:", err);
    return null;
  }
}

/**
 * 64-char lowercase hex looks like the v0.27.0 deterministic-fingerprint format
 * (SHA-256 over a few navigator properties). Those values collide across
 * similar corporate laptops — a real install reported 5 unique machines for
 * 7 unique users — so any value matching this shape must be regenerated.
 */
function _isLegacyFingerprintMachineId(v) {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}

/**
 * machine_id resolver. Random UUID per (Chrome profile, machine_id slot).
 * Stored in chrome.storage.sync so it survives uninstall + reinstall on the
 * same Chrome profile (the original goal). No fingerprinting — the previous
 * implementation hashed navigator.platform / hardwareConcurrency / deviceMemory
 * / languages, which deterministically produced the same value for any pair
 * of identical machines and inflated user_count / machine_count in the
 * dashboard. We accept that sync-off installs lose stability across reinstall
 * (random UUID per install) because that's strictly better than silent
 * collisions across distinct machines.
 *
 * Also auto-migrates: if the synced value looks like a legacy 64-char hex
 * fingerprint, it is discarded and replaced with a fresh UUID.
 */
async function _getOrCreateMachineId() {
  let synced = null;
  try {
    synced = await new Promise((r) => {
      try { chrome.storage.sync.get("ocPilotMachineId", (d) => r((d || {}).ocPilotMachineId || null)); }
      catch (_) { r(null); }
    });
  } catch (_) {}

  if (synced && !_isLegacyFingerprintMachineId(synced)) return synced;

  // Either no synced value yet, or it was a legacy fingerprint hash — regenerate.
  const id = (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
             (Date.now() + "-" + Math.random().toString(36).slice(2));
  try {
    await new Promise((r) => {
      try { chrome.storage.sync.set({ ocPilotMachineId: id }, () => r()); }
      catch (_) { r(); }
    });
  } catch (_) {}
  return id;
}

/** Promise wrapper around chrome.storage.local.{get,set}. */
function _storageGet(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (data) => resolve(data || {}));
    } catch (_) { resolve({}); }
  });
}
function _storageSet(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch (_) { resolve(); }
  });
}

/**
 * Snapshot current counters, POST them, and on success subtract the snapshot
 * from the live counters (NOT a reset — bumps that happened mid-flight are
 * preserved for the next send).
 *
 * Options:
 *   isInstall:       boolean — set on the one-time install POST
 *   isUpdate:        boolean — set on the one-time update POST
 *   previousVersion: string  — only meaningful when isUpdate is true
 *
 * Returns { ok, eventCount, periodEnd, error? } so the telemetry/sendNow
 * message handler can surface success/failure to the popup.
 */
async function sendTelemetry(opts) {
  opts = opts || {};
  try {
    const data = await _storageGet("openshiftAutoLogin");
    const cfg = (data && data.openshiftAutoLogin) || {};
    const tel = cfg.telemetry || {};

    // Two identifiers: installId (per-install UUID, was previously stored as
    // machineId) and machineId (stable per-machine random UUID kept in
    // chrome.storage.sync). Migrations handled here:
    //   - pre-0.26.6 installs only had tel.machineId (per-install UUID) and no
    //     installId field; the old value becomes the installId.
    //   - 0.27.0 installs have tel.machineId set to a 64-char hex fingerprint
    //     hash that collides across similar hardware (different users on
    //     identical corporate laptops resolved to the same machineId). Detect
    //     the legacy format and replace with a fresh random UUID via
    //     _getOrCreateMachineId(), which also re-keys chrome.storage.sync.
    let installId = tel.installId || tel.machineId;
    let machineId;
    const legacyFingerprint = _isLegacyFingerprintMachineId(tel.machineId);
    if (tel.installId && tel.machineId && !legacyFingerprint) {
      // Both new fields present and machineId is not the legacy hex hash.
      machineId = tel.machineId;
    } else {
      machineId = await _getOrCreateMachineId();
      // Persist the migrated identifiers immediately so the next send (and
      // the popup diagnostics) see the new value.
      try {
        await _storageSet({
          openshiftAutoLogin: {
            ...cfg,
            telemetry: { ...tel, installId, machineId },
          },
        });
      } catch (_) {}
    }
    if (!installId) {
      console.warn(TELEMETRY_LOG, "no installId — bailing");
      return { ok: false, error: "no installId in storage" };
    }

    const snapshot = (tel.counters && typeof tel.counters === "object") ? { ...tel.counters } : {};
    const eventCount = Object.values(snapshot).reduce((s, v) => s + (v | 0), 0);
    const periodEnd = Math.floor(Date.now() / 1000);
    const periodStart = tel.periodStart || tel.installSentAt || periodEnd;

    const userHash = await hashUsername(cfg.username);
    // Internal-only deployment: the organisation has approved sending the raw
    // username alongside the hash so the server can later join against Active
    // Directory (department, team, etc.) for richer dashboards. Lowercased to
    // match hashUsername()'s input. Null when the user hasn't configured
    // credentials yet — same convention as userHash.
    const username = cfg.username ? String(cfg.username).toLowerCase() : null;

    // Prefer per-install override; fall back to the runtime-loaded t.config.
    let url   = (tel.serverUrl   && String(tel.serverUrl).trim())   || null;
    let token = (tel.serverToken && String(tel.serverToken).trim()) || null;
    if (!url || !token) {
      const defaultCfg = await _telemetryConfigPromise;
      if (!defaultCfg) {
        return { ok: false, error: "telemetry not configured" };
      }
      url   = url   || defaultCfg.url;
      token = token || defaultCfg.token;
    }

    const body = {
      machineId,           // stable per-machine
      installId,           // per-install
      userHash,            // SHA-256("oc-pilot:" + username) — kept for legacy aggregations
      username,            // raw username for AD enrichment (org-approved internal use)
      version: chrome.runtime.getManifest().version,
      periodStart,
      periodEnd,
      counters: snapshot,
      isInstall: !!opts.isInstall,
      isUpdate:  !!opts.isUpdate,
      previousVersion: opts.previousVersion || null,
    };

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.warn(TELEMETRY_LOG, "fetch threw:", err);
      return { ok: false, error: String(err && err.message || err) };
    }

    if (!resp.ok) {
      let bodyText = "";
      try { bodyText = (await resp.text()).slice(0, 200); } catch (_) {}
      console.warn(TELEMETRY_LOG, "non-2xx:", resp.status, bodyText);
      return { ok: false, error: "HTTP " + resp.status + (bodyText ? ": " + bodyText : "") };
    }

    // Success — subtract the snapshot from live counters (preserves bumps
    // that happened during the in-flight request).
    try {
      const after = await _storageGet("openshiftAutoLogin");
      const aftercfg = (after && after.openshiftAutoLogin) || {};
      const aftertel = aftercfg.telemetry || {};
      const live = (aftertel.counters && typeof aftertel.counters === "object")
        ? { ...aftertel.counters }
        : {};
      for (const k of Object.keys(snapshot)) {
        const remaining = (live[k] | 0) - (snapshot[k] | 0);
        if (remaining > 0) live[k] = remaining;
        else delete live[k];
      }
      await _storageSet({
        openshiftAutoLogin: {
          ...aftercfg,
          telemetry: {
            ...aftertel,
            counters: live,
            periodStart: periodEnd,
            lastSendAt: periodEnd,
            installSentAt: opts.isInstall ? periodEnd : (aftertel.installSentAt || 0),
          },
        },
      });
    } catch (err) {
      console.warn(TELEMETRY_LOG, "post-send storage update failed:", err);
      // Don't return failure — the server already accepted the data; we just
      // failed to update local bookkeeping. Worst case, counters are sent twice.
    }

    return { ok: true, eventCount, periodEnd };
  } catch (err) {
    console.warn(TELEMETRY_LOG, "sendTelemetry threw:", err);
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** Read the stored interval (minutes), falling back to the build-time default. */
async function _getTelemetryIntervalMinutes() {
  try {
    const data = await _storageGet("openshiftAutoLogin");
    const tel = ((data || {}).openshiftAutoLogin || {}).telemetry || {};
    return (tel.intervalMinutes && tel.intervalMinutes >= 1)
      ? tel.intervalMinutes
      : TELEMETRY_PERIOD_HOURS * 60;
  } catch (_) {
    return TELEMETRY_PERIOD_HOURS * 60;
  }
}

/** Ensure the telemetry alarm exists with the currently configured interval (idempotent). */
async function ensureTelemetryAlarm() {
  try {
    const minutes = await _getTelemetryIntervalMinutes();
    // Clear first so the period is always up-to-date even if the alarm already exists.
    await chrome.alarms.clear(TELEMETRY_ALARM_NAME);
    chrome.alarms.create(TELEMETRY_ALARM_NAME, { periodInMinutes: minutes });
  } catch (err) {
    console.warn(TELEMETRY_LOG, "ensureTelemetryAlarm failed:", err);
  }
}

// ── Lifecycle hooks: onInstalled, onStartup, onAlarm ───────────────────────

try {
  chrome.runtime.onInstalled.addListener((details) => {
    (async () => {
      try {
        const data = await _storageGet("openshiftAutoLogin");
        const cfg = (data && data.openshiftAutoLogin) || {};
        const tel = cfg.telemetry || {};

        // Two identifiers:
        //   installId — per-install UUID. Was previously stored under the
        //               name `machineId`; migrate any legacy value into here.
        //   machineId — stable per-machine, sync+fingerprint hybrid. Survives
        //               uninstall + reinstall on the same Chrome profile (sync
        //               path) or the same hardware (fingerprint fallback).
        let installId = tel.installId || tel.machineId;
        if (!installId) {
          installId = (crypto.randomUUID && crypto.randomUUID()) ||
                      (Date.now() + "-" + Math.random().toString(36).slice(2));
        }
        const machineId = await _getOrCreateMachineId();

        await _storageSet({
          openshiftAutoLogin: {
            ...cfg,
            telemetry: {
              ...tel,
              installId,
              machineId,
              counters: tel.counters || {},
              periodStart: tel.periodStart || Math.floor(Date.now() / 1000),
              lastSendAt: tel.lastSendAt || 0,
              installSentAt: tel.installSentAt || 0,
            },
          },
        });

        if (details && details.reason === "install") {
          bumpCounter("lifecycle.installed");
          await sendTelemetry({ isInstall: true });
        } else if (details && details.reason === "update") {
          bumpCounter("lifecycle.updated");
          await sendTelemetry({
            isUpdate: true,
            previousVersion: details.previousVersion || null,
          });
        }
        ensureTelemetryAlarm();
      } catch (err) {
        console.warn(TELEMETRY_LOG, "onInstalled handler threw:", err);
      }
    })();
  });
} catch (err) {
  console.warn(TELEMETRY_LOG, "onInstalled registration threw:", err);
}

try {
  chrome.runtime.onStartup.addListener(() => {
    try {
      bumpCounter("lifecycle.startup");
      ensureTelemetryAlarm();
    } catch (err) {
      console.warn(TELEMETRY_LOG, "onStartup threw:", err);
    }
  });
} catch (err) {
  console.warn(TELEMETRY_LOG, "onStartup registration threw:", err);
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== TELEMETRY_ALARM_NAME) return;
    sendTelemetry({}).catch((err) => {
      console.warn(TELEMETRY_LOG, "alarm sendTelemetry threw:", err);
    });
  });
} catch (err) {
  console.warn(TELEMETRY_LOG, "alarm registration threw:", err);
}

// ── Message handlers ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── On-premise console hostname self-registration ──────────────────────────
  // content-console.js sends this on every load so the background knows to
  // inject it on future non-/k8s/ page loads for this host (e.g. /overview).
  if (msg && msg.type === "registerConsoleHost" && typeof msg.hostname === "string") {
    const host = msg.hostname.trim().toLowerCase();
    if (host && !_knownConsoleHosts.has(host)) {
      _knownConsoleHosts.add(host);
      chrome.storage.local.get("ocPilotConsoleHosts", (data) => {
        const existing = new Set((data || {}).ocPilotConsoleHosts || []);
        existing.add(host);
        chrome.storage.local.set({ ocPilotConsoleHosts: [...existing] });
      });
    }
    sendResponse(true);
    return false;
  }

  if (msg && msg.type === "loginPending") {
    // content.js tells us "I just submitted the login form in this tab."
    if (sender.tab && sender.tab.id != null) {
      pendingLoginTabs.set(sender.tab.id, {
        username: msg.username || "",
        ts: Date.now(),
      });
    }
    sendResponse(true);
    return false; // synchronous response, no need to keep channel open
  }

  if (msg && msg.type === "copyToClipboard" && typeof msg.text === "string") {
    copyViaOffscreen(msg.text)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // ── Console header "Copy Login" button ─────────────────────────────────────
  // The user is already authenticated in their browser — their session cookies
  // for oauth-openshift.apps.* are live. We fetch the token pages directly
  // from the background service worker (credentials: 'include' + host_permissions
  // gives us those cookies) instead of opening a visible or background tab.
  //
  // Flow: GET /oauth/token/request → POST form (CSRF token included) →
  //       parse "oc login --token=… --server=…" from the response HTML.
  //       Newer OCP may need a second POST. All happens silently in < 1 second.
  if (msg && msg.type === "copyLoginCommand" && msg.tokenRequestUrl) {
    const sourceTabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
    console.log("[oc-pilot:bg] copyLoginCommand — fetching via background SW | url:", msg.tokenRequestUrl, "| sourceTabId:", sourceTabId);

    _fetchOcLoginCommand(msg.tokenRequestUrl, sourceTabId, msg.consoleHostname || null)
      .then((cmd) => {
        console.log("[oc-pilot:bg] _fetchOcLoginCommand succeeded | cmd length:", cmd.length);
        return copyViaOffscreen(cmd).then((ok) => {
          console.log("[oc-pilot:bg] copyViaOffscreen result:", ok, "| sourceTabId:", sourceTabId);
          if (sourceTabId != null) {
            chrome.tabs.sendMessage(sourceTabId, {
              type: "ocPilotToast",
              text: ok ? "Login command copied to clipboard" : "Could not write to clipboard",
              style: ok ? "success" : "error",
            }).catch((err) => console.warn("[oc-pilot:bg] sendMessage to source tab failed:", err));
          }
          bumpCounter(ok ? "copylogin.completed" : "copylogin.failed");
        });
      })
      .catch((err) => {
        const errStr = String(err && err.message || err);
        console.warn("[oc-pilot:bg] _fetchOcLoginCommand failed:", errStr);

        let userMsg;
        if (errStr === "no-credentials") {
          userMsg = "Configure your username and password in OC Pilot settings, then try again";
        } else if (errStr === "auth-failed") {
          userMsg = "Authentication failed — the stored username or password is incorrect for this cluster";
        } else if (errStr === "throttled") {
          userMsg = "The cluster is rate-limiting auth requests — wait a moment and try again";
        } else if (errStr === "unsupported-provider") {
          userMsg = "Could not authenticate — the identity provider may not support Basic auth, or the cluster is temporarily unavailable. Try again in a moment.";
        } else if (errStr === "unknown-api-server") {
          userMsg = "Could not derive the API server URL — non-standard OpenShift install (expected oauth-openshift.apps.<base>)";
        } else if (/^oauth-/.test(errStr)) {
          userMsg = "OAuth error: " + errStr.replace("oauth-", "");
        } else if (/^http-/.test(errStr)) {
          userMsg = "OAuth server returned " + errStr.replace("http-", "HTTP ") + " — check cluster connectivity";
        } else {
          userMsg = "Failed to fetch login command — " + errStr;
        }

        if (sourceTabId != null) {
          chrome.tabs.sendMessage(sourceTabId, {
            type: "ocPilotToast",
            text: userMsg,
            style: "error",
          }).catch(() => {});
        }
        bumpCounter("copylogin.failed");
      });

    sendResponse({ ok: true });
    return false;
  }

  // ── Telemetry: bump a counter ──────────────────────────────────────────────
  // Sent by content-console.js / content.js / popup.js when the user does
  // something we want to count. Fire-and-forget — silent on any failure.
  if (msg && msg.type === "telemetry/bump" && typeof msg.event === "string") {
    bumpCounter(msg.event);
    sendResponse({ ok: true });
    return false;
  }

  // ── Telemetry: get config (from the popup's Developer settings section) ─────
  if (msg && msg.type === "telemetry/getConfig") {
    (async () => {
      try {
        const intervalMinutes = await _getTelemetryIntervalMinutes();
        const alarm = await chrome.alarms.get(TELEMETRY_ALARM_NAME);
        const defaultCfg = await _telemetryConfigPromise;
        sendResponse({
          url:             (defaultCfg && defaultCfg.url) || "",
          intervalMinutes: intervalMinutes,
          nextFire:        alarm ? alarm.scheduledTime : null,
        });
      } catch (err) {
        sendResponse({
          url:             "",
          intervalMinutes: TELEMETRY_PERIOD_HOURS * 60,
          nextFire:        null,
        });
      }
    })();
    return true;
  }

  // ── Telemetry: set interval (from the popup's Developer settings section) ───
  if (msg && msg.type === "telemetry/setInterval") {
    const minutes = Math.max(1, parseInt(msg.minutes, 10) || (TELEMETRY_PERIOD_HOURS * 60));
    (async () => {
      try {
        const data = await _storageGet("openshiftAutoLogin");
        const cfg = (data || {}).openshiftAutoLogin || {};
        const tel = cfg.telemetry || {};
        await _storageSet({ openshiftAutoLogin: { ...cfg, telemetry: { ...tel, intervalMinutes: minutes } } });
        await chrome.alarms.clear(TELEMETRY_ALARM_NAME);
        chrome.alarms.create(TELEMETRY_ALARM_NAME, { periodInMinutes: minutes });
        const alarm = await chrome.alarms.get(TELEMETRY_ALARM_NAME);
        sendResponse({ ok: true, intervalMinutes: minutes, nextFire: alarm ? alarm.scheduledTime : null });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true;
  }

  // ── Telemetry: send-now (from the popup's Diagnostics button) ──────────────
  // Returns true to keep the message channel open for the async response.
  if (msg && msg.type === "telemetry/sendNow") {
    sendTelemetry({})
      .then((res) => { try { sendResponse(res); } catch (_) {} })
      .catch((err) => {
        try {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        } catch (_) {}
      });
    return true;
  }

  // ── Silent tab diagnostic relay ──────────────────────────────────────────────
  // content.js sends silentTabLog messages from inside the silent popup window
  // so all key Copy Login events are visible here even after the tab closes.
  //
  // To read these logs:
  //   chrome://extensions → OC Pilot → "Inspect views: service worker"
  //   Look for lines starting with [oc-pilot:silent]
  if (msg && msg.type === 'silentTabLog') {
    console.log('[oc-pilot:silent]', msg.label || '', msg.data || '');
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ── Copy Login: direct background fetch ─────────────────────────────────────
//
// Why this approach: the OAuth server's session cookie is SameSite=Lax by
// default, so it's NOT included in cross-site subresource fetches from the
// extension SW (host_permissions:<all_urls> does NOT override SameSite).
// Earlier versions tried fetch('/oauth/token/request', {credentials:'include'})
// and were silently redirected to the login page despite the user being logged
// in via the console.
//
// What works instead: OpenShift exposes a built-in OAuth client named
// `openshift-challenging-client` that supports HTTP Basic auth challenges —
// the same mechanism `oc login --username=... --password=...` uses. We already
// store the user's credentials, so we authenticate directly, no cookies. The
// token comes back in the Location header of a 302, which we capture via
// chrome.webRequest.onBeforeRedirect (the response itself is opaqueredirect —
// body and headers unreadable, but the webRequest event fires regardless).
//
// Compatibility: works with htpasswd / kubeadmin / LDAP / Keystone identity
// providers. Does NOT work with GitHub / GitLab / Google / OIDC — those need
// interactive browser flows; we surface 'unsupported-provider' for those.
//
// Throws string-coded Error so the message handler can map to a clear toast:
//   'no-credentials'       — username or password not configured
//   'auth-failed'          — server rejected credentials (401 or error= in redirect)
//   'unsupported-provider' — server returned non-401, non-302 (likely OIDC/GitHub)
//   'unknown-api-server'   — could not derive api.<base>:6443 from the OAuth URL
//   'http-NNN'             — 5xx or unexpected status

const _CL = "[oc-pilot:bg:copylogin]"; // log prefix — visible in SW console

async function _fetchOcLoginCommand(tokenRequestUrl, notifyTabId, consoleHostname) {
  const oauthOrigin = new URL(tokenRequestUrl).origin;

  // Prefer the console hostname sent directly by content-console.js (always
  // accurate). Fall back to regex-deriving it from the OAuth hostname for
  // backwards compatibility with older cached messages.
  const consoleHost = consoleHostname ||
    new URL(tokenRequestUrl).hostname.replace(/^oauth-openshift\./, "console-openshift-console.");

  const { username, password } = await _getStoredCredentials(consoleHost);
  if (!username || !password) {
    console.warn(_CL, "no stored credentials for", consoleHost);
    throw new Error("no-credentials");
  }

  console.log(_CL, "requesting token via challenging-client for", oauthOrigin);

  const MAX_RETRIES = 3;
  let token;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      token = await _fetchTokenViaChallenge(oauthOrigin, username, password);
      break; // success — exit retry loop
    } catch (err) {
      const isRetryable = err.message === "unsupported-provider";
      if (!isRetryable || attempt === MAX_RETRIES) throw err;

      const retryNum = attempt + 1;
      console.log(_CL, `attempt ${attempt + 1} got unsupported-provider — retry ${retryNum}/${MAX_RETRIES} in 5 s`);

      if (notifyTabId != null) {
        chrome.tabs.sendMessage(notifyTabId, {
          type: "ocPilotToast",
          text: `Retrying… (${retryNum} of ${MAX_RETRIES})`,
          style: "info",
          resetButton: false,
        }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log(_CL, "captured redirect with access_token (length " + token.length + ")");

  const serverUrl = _deriveApiServerUrl(oauthOrigin);
  if (!serverUrl) {
    console.warn(_CL, "could not derive API server from", oauthOrigin);
    throw new Error("unknown-api-server");
  }
  console.log(_CL, "derived API server:", serverUrl);

  return "oc login --token=" + token + " --server=" + serverUrl;
}

/**
 * Read username/password from chrome.storage.local["openshiftAutoLogin"],
 * preferring a per-host override if one exists. Mirrors the pattern from
 * extension/content.js loadConfig() so users get the same credential resolution
 * everywhere in the extension.
 */
async function _getStoredCredentials(consoleHost) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("openshiftAutoLogin", (data) => {
        const cfg = (data && data.openshiftAutoLogin) || {};
        const override = cfg.overrides && cfg.overrides[consoleHost];
        resolve({
          username: (override && override.username) || cfg.username || "",
          password: (override && override.password) || cfg.password || "",
        });
      });
    } catch (_) { resolve({ username: "", password: "" }); }
  });
}

/**
 * Drive the openshift-challenging-client flow:
 *   GET /oauth/authorize?client_id=openshift-challenging-client&response_type=token
 *   Authorization: Basic <base64(user:pass)>
 *   X-CSRF-Token: 1
 *
 * On success the server responds 302 with the access_token in the Location
 * fragment. We don't follow the redirect (its target is typically
 * https://localhost:8443/oauth/token/implicit which is unreachable); instead
 * we observe it via chrome.webRequest.onBeforeRedirect.
 *
 * X-CSRF-Token MUST be set — without it OpenShift returns the HTML login page
 * (interactive browser flow) instead of issuing a Basic challenge.
 */
async function _fetchTokenViaChallenge(oauthOrigin, username, password) {
  const authorizeUrl =
    oauthOrigin +
    "/oauth/authorize?client_id=openshift-challenging-client&response_type=token";

  let capturedRedirect = null;
  const listener = (details) => {
    const url = details && details.redirectUrl;
    if (!url) return;
    if (url.includes("access_token=") || url.includes("error=")) {
      capturedRedirect = url;
    }
  };

  // The listener filter matches the SOURCE URL of the redirect (the authorize
  // endpoint), not the target (which is unreachable localhost:8443/...).
  chrome.webRequest.onBeforeRedirect.addListener(
    listener,
    { urls: [oauthOrigin + "/oauth/authorize*"] }
  );

  let resp = null;
  try {
    resp = await fetch(authorizeUrl, {
      method: "GET",
      headers: {
        "Authorization": "Basic " + btoa(username + ":" + password),
        "X-CSRF-Token": "1",
      },
      redirect: "manual",
    }).catch((err) => {
      // Opaque-redirect handling sometimes surfaces as a TypeError in the SW
      // even though the listener already captured the URL. Swallow and check.
      console.log(_CL, "fetch threw (often benign for opaque redirect):", err && err.message);
      return null;
    });
  } finally {
    chrome.webRequest.onBeforeRedirect.removeListener(listener);
  }

  // Did the listener capture an OAuth error in the redirect?
  if (capturedRedirect) {
    const errMatch = capturedRedirect.match(/[?#&]error=([^&]+)/);
    if (errMatch) {
      const code = decodeURIComponent(errMatch[1]);
      console.warn(_CL, "OAuth error in redirect:", code);
      if (code === "access_denied" || code === "invalid_grant") throw new Error("auth-failed");
      throw new Error("oauth-" + code);
    }
    const tokMatch = capturedRedirect.match(/[#&]access_token=([^&]+)/);
    if (tokMatch) return decodeURIComponent(tokMatch[1]);
    console.warn(_CL, "captured redirect but no access_token:", capturedRedirect.slice(0, 200));
  }

  // No redirect captured — look at the response.
  if (resp) {
    console.log(_CL, "no redirect captured, response status:", resp.status, "type:", resp.type);
    if (resp.status === 401) throw new Error("auth-failed");
    if (resp.status === 429) throw new Error("throttled");
    if (resp.status >= 500)  throw new Error("http-" + resp.status);
    // 200 OK with HTML body almost certainly means the server returned the
    // interactive login form (Basic challenge not supported by this provider).
    throw new Error("unsupported-provider");
  }

  throw new Error("unsupported-provider");
}

/**
 * Derive the Kubernetes API server URL from the OAuth origin for standard
 * OpenShift installs:
 *   https://oauth-openshift.apps.<base>  ->  https://api.<base>:6443
 * Returns null if the OAuth hostname doesn't match the expected pattern.
 */
function _deriveApiServerUrl(oauthOrigin) {
  try {
    const u = new URL(oauthOrigin);
    const m = u.hostname.match(/^oauth-openshift\.apps\.(.+)$/);
    if (!m) return null;
    return "https://api." + m[1] + ":6443";
  } catch (_) { return null; }
}

async function copyViaOffscreen(text) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "offscreen-copy", text }, (resp) => {
      if (chrome.runtime.lastError) { resolve(false); return; }
      resolve(!!(resp && resp.ok));
    });
  });
}

async function ensureOffscreen() {
  if (!chrome.offscreen) return;
  try {
    if (typeof chrome.offscreen.hasDocument === "function") {
      if (await chrome.offscreen.hasDocument()) return;
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["CLIPBOARD"],
      justification: "Copy oc login command to the system clipboard.",
    });
  } catch (err) {
    if (!/already/i.test(String(err && err.message))) throw err;
  }
}

// ── Console helper: inject content-console.js on first visit ────────────────
// The console is a React SPA. Manifest content_scripts only fire on full page
// loads that match a pattern. If the user starts on the console home page
// (e.g. /overview or /) and navigates to a pod page via client-side routing,
// our content script never loads and pushState is never patched.
//
// Fix: the background injects content-console.js the first time any tab loads
// a page on a known console hostname. The script sets up the pushState patch
// immediately, covering all subsequent SPA navigations. A DOM data-attribute
// prevents double-execution if the manifest script also fires on the same load.
//
// Known hostnames:
//   • console-openshift-console.* — standard CRC / cloud OpenShift installs
//   • Any hostname self-registered via "registerConsoleHost" — on-premise
//     clusters with custom routes. The content script sends this message the
//     first time it loads on a /k8s/ page; subsequent visits (including
//     non-/k8s/ start pages) are then covered by background injection.

// In-memory set of on-premise hostnames, loaded from storage at startup.
const _knownConsoleHosts = new Set();
chrome.storage.local.get("ocPilotConsoleHosts", (data) => {
  ((data || {}).ocPilotConsoleHosts || []).forEach(h => _knownConsoleHosts.add(h));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  let url;
  try { url = new URL(tab.url || ""); } catch { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  // Standard cloud/CRC hostname OR a user-registered on-premise hostname.
  const isKnownConsole =
    url.hostname.startsWith("console-openshift-console") ||
    _knownConsoleHosts.has(url.hostname);
  if (!isKnownConsole) return;

  // Inject on every full page load (not SPA navigations — those don't trigger
  // tabs.onUpdated). content-console.js has a DOM data-attribute guard that
  // prevents double-execution if the manifest script already ran on the same
  // page load. Without this, a post-OAuth-login full reload on a non-/k8s/ URL
  // would skip injection because the old per-tab Set entry blocked it.
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["dist/content-console.js"],
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingLoginTabs.delete(tabId);
});

// ── Post-login notification ──────────────────────────────────────────────────
// Only shows the toast in the specific tab that submitted the login form.
// Previously the flag was in chrome.storage.local (global), which caused the
// toast to appear in whichever unrelated tab happened to finish loading first.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  // Only act if this exact tab has a pending login.
  const entry = pendingLoginTabs.get(tabId);
  if (!entry) return;
  if (Date.now() - entry.ts > 30000) { pendingLoginTabs.delete(tabId); return; }

  let url;
  try { url = new URL(tab.url || ""); } catch { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  const p = url.pathname;
  // Still on an OAuth / login / auth-callback page — wait for the real destination.
  if (
    p.includes("/oauth/") ||
    /^\/login(\/|$)/.test(p) ||
    /^\/auth\//.test(p)
  ) return;

  // We've landed on the post-login page — consume the entry and show the toast
  // (unless the user has disabled it in settings).
  pendingLoginTabs.delete(tabId);

  chrome.storage.local.get("openshiftAutoLogin", (data) => {
    const features = ((data || {}).openshiftAutoLogin || {}).features || {};
    if (features.loginToast === false) return;

    chrome.scripting
      .executeScript({
        target: { tabId },
        func: injectLoginToast,
        args: [entry.username || ""],
      })
      .catch(() => {});
  });
});

// Injected into the page — must be self-contained (no closure over outer vars).
function injectLoginToast(username) {
  if (document.getElementById("__oc-login-toast__")) return;

  const host = document.createElement("div");
  host.id = "__oc-login-toast__";
  host.setAttribute("style", [
    "all:initial",
    "position:fixed",
    "bottom:18px",
    "right:18px",
    "z-index:2147483647",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
  ].join(";"));

  const shadow = host.attachShadow({ mode: "closed" });

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const subLine = username
    ? `as <strong>${esc(username)}</strong> &middot; OpenShift`
    : "OC Pilot";

  shadow.innerHTML = `
    <style>
      .wrap {
        position: relative;
        border-radius: 14px;
        overflow: hidden;
        box-shadow:
          0 12px 40px rgba(0,0,0,0.4),
          0 0 0 1px rgba(255,255,255,0.08);
        animation: slide-in 0.35s cubic-bezier(0.34,1.56,0.64,1) both;
        min-width: 300px;
        max-width: 380px;
      }
      .body {
        background: #0f1117;
        padding: 16px 16px 16px 16px;
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .icon-box {
        width: 42px;
        height: 42px;
        background: #ee0000;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        box-shadow: 0 3px 12px rgba(238,0,0,0.45);
      }
      .text { flex: 1; min-width: 0; }
      .title {
        color: #fff;
        font-size: 14.5px;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .sub {
        color: #6b7280;
        font-size: 12.5px;
        margin-top: 3px;
      }
      .sub strong { color: #9ca3af; font-weight: 500; }
      .check-circle {
        width: 32px;
        height: 32px;
        background: rgba(34,197,94,0.15);
        border: 1.5px solid rgba(34,197,94,0.4);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        animation: pop-in 0.3s 0.15s cubic-bezier(0.34,1.56,0.64,1) both;
      }
      .close-btn {
        width: 26px;
        height: 26px;
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #6b7280;
        flex-shrink: 0;
        padding: 0;
        transition: background 0.15s, color 0.15s;
      }
      .close-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }
      .progress-bar {
        height: 3px;
        background: linear-gradient(to right, #ee0000, #ff4444);
        animation: shrink 5s linear forwards;
        transform-origin: left;
      }
      @keyframes slide-in {
        from { opacity:0; transform:translateX(calc(100% + 18px)); }
        to   { opacity:1; transform:translateX(0); }
      }
      @keyframes pop-in {
        from { opacity:0; transform:scale(0.5); }
        to   { opacity:1; transform:scale(1); }
      }
      @keyframes shrink {
        from { transform:scaleX(1); }
        to   { transform:scaleX(0); }
      }
    </style>
    <div class="wrap">
      <div class="body">
        <div class="icon-box">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
               stroke="#fff" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div class="text">
          <div class="title">Logged in automatically</div>
          <div class="sub">${subLine}</div>
        </div>
        <div class="check-circle">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
               stroke="#22c55e" stroke-width="3"
               stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <button class="close-btn" aria-label="Dismiss">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="progress-bar"></div>
    </div>
  `;

  document.documentElement.appendChild(host);
  const timer = setTimeout(() => host.remove(), 5200);
  shadow.querySelector(".close-btn").addEventListener("click", () => {
    clearTimeout(timer);
    host.remove();
  });
}
