const OFFSCREEN_URL = "offscreen.html";

// ── Per-tab pending-login registry ───────────────────────────────────────────
// Keyed by tabId so the "Logged in automatically" toast only fires in the tab
// that actually submitted the login form — not in every other tab that happens
// to finish loading a page within the same 30-second window.
const pendingLoginTabs = new Map(); // tabId → { username, ts }

// ── Silent token-fetch tab registry ─────────────────────────────────────────
// Maps silentTabId → { sourceTabId, timer } so we can:
//   • route loginCommandReady back to the right console tab
//   • cancel the timeout when the flow completes
//   • timeout-close the tab and show a failure toast if it never responds
const silentTabSource = new Map();

const SILENT_TAB_TIMEOUT_MS = 20000; // 20 s — covers slow clusters + full auth flow

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
  // Opens a minimised popup window at the OAuth token-request URL with
  // ?oc-pilot-silent=1.  content.js runs there: clicks "Display Token", reads
  // the command from the display page, and sends loginCommandReady back instead
  // of writing to clipboard (background tabs don't have user activation for
  // clipboard writes).  Using a minimised popup window instead of a plain
  // background tab keeps the silent session completely out of the user's tab
  // strip.  A 20-second timeout ensures we always show a toast even if the
  // flow fails.
  if (msg && msg.type === "copyLoginCommand" && msg.tokenRequestUrl) {
    const sourceTabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
    console.log("[oc-pilot:bg] copyLoginCommand received — url:", msg.tokenRequestUrl, "| sourceTabId:", sourceTabId);

    chrome.windows.create(
      { url: msg.tokenRequestUrl, state: "minimized", type: "popup", focused: false, width: 800, height: 600 },
      (win) => {
        const tab = win && win.tabs && win.tabs[0];
        if (!win || !tab || tab.id == null) {
          console.warn("[oc-pilot:bg] failed to create silent window for:", msg.tokenRequestUrl);
          if (sourceTabId != null) {
            chrome.tabs.sendMessage(sourceTabId, {
              type: "ocPilotToast",
              text: "Could not open token-fetch window",
              style: "error",
            }).catch(() => {});
          }
          return;
        }

        const silentTabId = tab.id;
        const silentWinId = win.id;
        console.log("[oc-pilot:bg] silent window created — winId:", silentWinId, "tabId:", silentTabId);

        // Timeout: if content.js never sends loginCommandReady (e.g. the tab
        // got stuck on a login page or a selector failed), close it and tell
        // the user so the button doesn't spin forever.
        const timer = setTimeout(() => {
          if (!silentTabSource.has(silentTabId)) return; // already handled
          console.warn("[oc-pilot:bg] silent window timed out — tabId:", silentTabId);
          const e = silentTabSource.get(silentTabId);
          silentTabSource.delete(silentTabId);
          (e && e.silentWinId != null
            ? chrome.windows.remove(e.silentWinId)
            : chrome.tabs.remove(silentTabId)
          ).catch(() => {});
          if (sourceTabId != null) {
            chrome.tabs.sendMessage(sourceTabId, {
              type: "ocPilotToast",
              text: "Token fetch timed out — check that your OC Pilot credentials are configured for this cluster",
              style: "error",
            }).catch(() => {});
          }
        }, SILENT_TAB_TIMEOUT_MS);

        silentTabSource.set(silentTabId, { sourceTabId, timer, silentWinId });
      }
    );

    sendResponse({ ok: true });
    return false;
  }

  // ── Silent tab: content.js could not extract the command (fast-fail) ────────
  // Sent immediately when content.js detects it cannot succeed (no credentials
  // stored, LDAP redirect with no creds, token button not found, etc.) so we
  // don't make the user wait for the 20 s timeout.
  if (msg && msg.type === "loginCommandFailed") {
    const silentTabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
    const entry = silentTabId != null ? silentTabSource.get(silentTabId) : null;

    if (entry) {
      clearTimeout(entry.timer);
      silentTabSource.delete(silentTabId);
    }
    (entry && entry.silentWinId != null
      ? chrome.windows.remove(entry.silentWinId)
      : silentTabId != null ? chrome.tabs.remove(silentTabId) : Promise.resolve()
    ).catch(() => {});

    const sourceTabId = entry ? entry.sourceTabId : null;
    if (sourceTabId != null) {
      chrome.tabs.sendMessage(sourceTabId, {
        type: "ocPilotToast",
        text: "Could not fetch login command — make sure your OC Pilot credentials are configured for this cluster",
        style: "error",
      }).catch(() => {});
    }

    sendResponse({ ok: true });
    return false;
  }

  // ── Silent tab: content.js extracted the oc login command ──────────────────
  if (msg && msg.type === "loginCommandReady" && typeof msg.text === "string") {
    const silentTabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
    const entry = silentTabId != null ? silentTabSource.get(silentTabId) : null;
    console.log("[oc-pilot:bg] loginCommandReady — silentTabId:", silentTabId, "| entry found:", !!entry, "| cmd length:", msg.text.length);

    if (entry) {
      clearTimeout(entry.timer);
      silentTabSource.delete(silentTabId);
    }
    (entry && entry.silentWinId != null
      ? chrome.windows.remove(entry.silentWinId)
      : silentTabId != null ? chrome.tabs.remove(silentTabId) : Promise.resolve()
    ).catch(() => {});

    const sourceTabId = entry ? entry.sourceTabId : null;
    copyViaOffscreen(msg.text)
      .then((ok) => {
        console.log("[oc-pilot:bg] copyViaOffscreen result:", ok, "| sourceTabId:", sourceTabId);
        if (sourceTabId != null) {
          chrome.tabs.sendMessage(sourceTabId, {
            type: "ocPilotToast",
            text: ok ? "Login command copied to clipboard" : "Could not write to clipboard",
            style: ok ? "success" : "error",
          }).catch((err) => console.warn("[oc-pilot:bg] sendMessage to source tab failed:", err));
        }
      })
      .catch((err) => {
        console.warn("[oc-pilot:bg] copyViaOffscreen threw:", err);
        if (sourceTabId != null) {
          chrome.tabs.sendMessage(sourceTabId, {
            type: "ocPilotToast",
            text: "Could not write to clipboard",
            style: "error",
          }).catch(() => {});
        }
      });

    sendResponse({ ok: true });
    return false;
  }

  return false;
});

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

const _consoleInjectedTabs = new Set();

// In-memory set of on-premise hostnames, loaded from storage at startup.
const _knownConsoleHosts = new Set();
chrome.storage.local.get("ocPilotConsoleHosts", (data) => {
  ((data || {}).ocPilotConsoleHosts || []).forEach(h => _knownConsoleHosts.add(h));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (_consoleInjectedTabs.has(tabId)) return;

  let url;
  try { url = new URL(tab.url || ""); } catch { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  // Standard cloud/CRC hostname OR a user-registered on-premise hostname.
  const isKnownConsole =
    url.hostname.startsWith("console-openshift-console") ||
    _knownConsoleHosts.has(url.hostname);
  if (!isKnownConsole) return;

  _consoleInjectedTabs.add(tabId);
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-console.js"],
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  _consoleInjectedTabs.delete(tabId);
  pendingLoginTabs.delete(tabId);
  // If a silent token-fetch tab is closed externally (e.g. user closes it
  // manually) before it sends loginCommandReady, clean up its registry entry
  // so silentTabSource doesn't leak. The 20-second timeout will still fire
  // and show an error toast (timer is stored in the entry, which is now gone,
  // so the timer guard `if (!silentTabSource.has(silentTabId)) return;` catches it).
  silentTabSource.delete(tabId);
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
