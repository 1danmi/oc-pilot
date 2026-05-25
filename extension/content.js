(() => {
  const STORAGE_KEY = "openshiftAutoLogin";
  const LOG_PREFIX = "[oc-pilot]";

  // Fire-and-forget telemetry bump (see telemetry-server/ for the receiver). Silent on
  // any failure — a sleeping SW or chrome.runtime hiccup must never break the
  // login automation flow.
  function bumpEvent(name) {
    try { chrome.runtime.sendMessage({ type: "telemetry/bump", event: name }); } catch (_) {}
  }

  // Relay diagnostic events from the silent popup tab to the background service
  // worker console. The silent tab closes the moment loginCommandReady is sent —
  // DevTools cannot be attached in time to see what happened inside it.
  //
  // All relayed messages appear as [oc-pilot:silent] entries in the persistent
  // background SW console:
  //   chrome://extensions → OC Pilot → "Inspect views: service worker"
  //
  // Usage: silentLog("step.name", "key=value | key2=value2")
  function silentLog(label, data) {
    const dataStr = data !== undefined ? String(data) : '';
    console.log(LOG_PREFIX, '[silent]', label, dataStr);
    try {
      chrome.runtime.sendMessage({ type: 'silentTabLog', label, data: dataStr });
    } catch (_) {}
  }

  // Page-level dedupe flag. Resets on every full navigation because the
  // content script is re-injected. Do NOT use sessionStorage here — it
  // persists across navigations in the same tab and would block re-login
  // after logout.
  let pageActed = false;

  if (window.top !== window) return;

  log("loaded on", location.href);

  main().catch((err) => console.warn(LOG_PREFIX, err));

  async function main() {
    const config = await loadConfig();
    const pathname = location.pathname;
    log(
      "pathname:", pathname,
      "| provider:", config.providerName,
      "| has creds:", !!(config.username && config.password)
    );
    silentLog("main.entry",
      "url=" + location.href +
      " | silent=" + isSilentMode() +
      " | hasCreds=" + !!(config.username && config.password) +
      " | readyState=" + document.readyState
    );

    if (pathname.endsWith("/oauth/token/request")) {
      return handleTokenRequest(config);
    }
    if (pathname.endsWith("/oauth/token/display")) {
      // The token is always visible on this page regardless of query params
      // (older code incorrectly re-routed to handleTokenRequest when query
      // params were present — e.g. ?then=/console — which broke the copy flow).
      return handleTokenDisplay(config);
    }
    if (/^\/login\/[^/]+/.test(pathname)) {
      const form = findLoginForm();
      if (!form) { log("login URL but no form found"); return; }
      return handleCredentialsForm(config, form);
    }
    if (
      /^\/oauth\/authorize(\/|$|\?)/.test(pathname + (location.search ? "?" : "")) &&
      !pathname.endsWith("/approve")
    ) {
      const target = findProviderTarget(config);
      if (!target) { log("authorize URL but no provider target"); return; }
      return handleProviderSelect(config, target);
    }
    log("path not matched; idle.");
  }

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        const cfg = data[STORAGE_KEY] || {};
        const overrides = cfg.overrides || {};
        // Overrides are keyed by the console hostname (what the user sees in
        // the browser). content.js may run on the OAuth/login page whose
        // hostname differs (e.g. oauth-openshift.* vs console-openshift-console.*).
        // Try the current hostname first, then its console-hostname equivalent.
        const consoleEquiv = location.hostname.replace(/^oauth-openshift\./, 'console-openshift-console.');
        const hostOverride = overrides[location.hostname] || overrides[consoleEquiv];
        resolve({
          username: (hostOverride ? hostOverride.username : cfg.username) || "",
          password: (hostOverride ? hostOverride.password : cfg.password) || "",
          providerName: cfg.providerName || "ldap-provider",
          autoSubmit: cfg.autoSubmit !== false,
          autoCopyToken: cfg.autoCopyToken !== false,
          isOverride: !!hostOverride,
        });
      });
    });
  }

  // ── Provider select ─────────────────────────────────────────────────────────

  function findProviderTarget(config) {
    const name = (config.providerName || "").trim();
    if (!name) return null;
    const nameLower = name.toLowerCase();
    const nameRe = new RegExp("\\b" + escapeRegex(name) + "\\b", "i");

    const byHref = document.querySelector(
      `a[href*="${cssEscape("/login/" + name)}"]`
    );
    if (byHref) return byHref;

    const candidates = Array.from(
      document.querySelectorAll("a, button, [role=button], li a, li button")
    );
    const byExact = candidates.find(
      (el) => (el.textContent || "").trim().toLowerCase() === nameLower
    );
    if (byExact) return byExact;

    const byWord = candidates.find((el) => nameRe.test(el.textContent || ""));
    if (byWord) return byWord;

    if (/ldap/i.test(name)) {
      const loose = candidates.find((el) => /ldap/i.test(el.textContent || ""));
      if (loose) return loose;
    }
    return null;
  }

  function handleProviderSelect(_config, target) {
    if (pageActed) return;
    pageActed = true;
    log("clicking provider target:", describeEl(target));
    bumpEvent("autologin.providerSelected");
    target.click();
  }

  // ── Credentials form ────────────────────────────────────────────────────────

  function findLoginForm() {
    const forms = Array.from(document.querySelectorAll("form"));
    for (const f of forms) {
      const action = f.getAttribute("action") || "";
      if (f.querySelector('input[type="password"]') && /\/login/.test(action)) return f;
    }
    for (const f of forms) {
      if (
        f.querySelector('input[type="password"]') &&
        f.querySelector('input[type="text"], input:not([type]), input[type="email"]')
      ) return f;
    }
    return null;
  }

  function findUsernameInput(form) {
    return (
      form.querySelector("input#username") ||
      form.querySelector('input[name="username"]') ||
      form.querySelector('input[type="text"]') ||
      form.querySelector("input:not([type])") ||
      form.querySelector('input[type="email"]')
    );
  }

  function findPasswordInput(form) {
    return (
      form.querySelector("input#password") ||
      form.querySelector('input[name="password"]') ||
      form.querySelector('input[type="password"]')
    );
  }

  function hasLoginError() {
    // PatternFly 4/5/6 danger alerts (versioned and unversioned class names)
    // + legacy Bootstrap-style. Visible on the page only when the server
    // rejected the previous credentials.
    const alertSel = [
      ".pf-m-danger",
      ".pf-v5-m-danger",
      ".pf-v6-m-danger",
      ".alert-danger",
      "[class*='login-pf'][class*='danger']",
      "[class*='m-danger']",                 // catches any versioned modifier
      "[class*='alert'][class*='error']",
      "[class*='help-block'][class*='error']",
    ].join(",");
    if (document.querySelector(alertSel)) return true;

    // Text-based fallback — scan visible body text for common error phrases.
    const txt = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
    if (/invalid (login|username|password|credentials)|login failed|authentication failed|could not authenticate|incorrect (password|username)|access denied/.test(txt)) {
      return true;
    }
    return false;
  }

  // Short cooldown stored per-tab. Safety net in case hasLoginError() misses
  // an error variant: if we just submitted, don't auto-submit again for a
  // few seconds — this makes an infinite retry loop impossible.
  const SUBMIT_COOLDOWN_MS = 8000;
  const COOLDOWN_KEY = "oc-pilot-last-submit";

  function markSubmitted() {
    try { sessionStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch (_) {}
  }

  function submittedRecently() {
    try {
      const ts = Number(sessionStorage.getItem(COOLDOWN_KEY) || 0);
      return ts > 0 && (Date.now() - ts) < SUBMIT_COOLDOWN_MS;
    } catch (_) { return false; }
  }

  function clearCooldown() {
    try { sessionStorage.removeItem(COOLDOWN_KEY); } catch (_) {}
  }

  // When credentials (or any config) change in storage, clear the cooldown so
  // a reload right after correcting a typo'd password works immediately —
  // without this, reloading within 8s of a failed attempt silently skips the
  // auto-fill. Fires in every open tab that has the content script loaded.
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes[STORAGE_KEY]) return;
      clearCooldown();
      pageActed = false;
      log("credentials updated in storage — cleared cooldown; reload to retry.");
    });
  } catch (_) { /* chrome.storage.onChanged may be unavailable in weird frames */ }

  async function handleCredentialsForm(config, form) {
    if (!config.username || !config.password) {
      log("no stored credentials; skipping fill.");
      // In silent mode the background is waiting with a 20 s timeout.
      // Fail immediately with a clear error instead of stalling.
      if (isSilentMode()) sendLoginCommandFailed();
      return;
    }
    // If this is a redirect from the silent token-fetch flow (e.g. LDAP network
    // where the OAuth session has expired), mark silent mode in sessionStorage
    // so the token display page can detect it after the form submit redirect.
    if (isSilentMode()) markSilentMode();
    if (hasLoginError()) {
      log("login error detected on page; not retrying to avoid infinite loop.");
      return;
    }
    if (submittedRecently()) {
      log("previous submit was <", SUBMIT_COOLDOWN_MS, "ms ago; skipping to avoid loop.");
      return;
    }
    const userInput = findUsernameInput(form);
    const passInput = findPasswordInput(form);
    if (!userInput || !passInput) {
      log("form found but missing username/password inputs");
      return;
    }
    if (pageActed) return;
    pageActed = true;

    log("filling credentials");
    setInputValue(userInput, config.username);
    setInputValue(passInput, config.password);

    if (config.autoSubmit) {
      // Show "in progress" banner and disable submit button so the user
      // knows why nothing is interactive while the auth request is in flight.
      showLoginInProgress(form);

      // Tell the background which tab is logging in so the "Logged in
      // automatically" toast appears only in this tab, not in every tab that
      // happens to finish loading within the 30-second window.
      await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: 'loginPending', username: config.username },
            () => resolve()
          );
        } catch (_) { resolve(); }
      });

      // Record timestamp BEFORE submit so if the next page load is another
      // credentials form (i.e. wrong creds), the cooldown check blocks the
      // re-submit even if hasLoginError() fails to match the error UI.
      markSubmitted();

      // Use requestSubmit() so form validation / submit events fire normally.
      log("submitting form");
      bumpEvent("autologin.executed");
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    } else {
      log("auto-submit disabled; form filled only");
    }
  }

  function showLoginInProgress(form) {
    const submitBtn = form.querySelector(
      'button[type="submit"], input[type="submit"]'
    );
    if (submitBtn) {
      submitBtn.disabled = true;
      if (submitBtn.tagName === "BUTTON") submitBtn.textContent = "Logging in…";
      else submitBtn.value = "Logging in…";
    }
    showProgressBanner("logging in, please wait…");
  }

  function showProgressBanner(message) {
    const host = document.createElement("div");
    host.setAttribute("style", [
      "all:initial",
      "position:fixed",
      "top:0", "left:0", "right:0",
      "z-index:2147483647",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    ].join(";"));
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .bar {
          background: #0f1117;
          border-bottom: 2px solid #ee0000;
          padding: 9px 16px;
          display: flex;
          align-items: center;
          gap: 10px;
          animation: slide-down 0.2s ease;
        }
        .icon-box {
          width: 24px; height: 24px;
          background: #ee0000;
          border-radius: 5px;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .label { color: #fff; font-size: 12.5px; font-weight: 500; }
        .label span { color: #9ca3af; font-weight: 400; }
        .spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.15);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          margin-left: auto;
        }
        @keyframes slide-down {
          from { opacity:0; transform:translateY(-100%); }
          to   { opacity:1; transform:translateY(0); }
        }
        @keyframes spin { to { transform:rotate(360deg); } }
      </style>
      <div class="bar">
        <div class="icon-box">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
               stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div class="label">
          OC Pilot <span>— ${escapeHtml(message)}</span>
        </div>
        <div class="spinner"></div>
      </div>
    `;
    document.documentElement.appendChild(host);
  }

  // ── Silent-mode detection ────────────────────────────────────────────────────
  // "Silent mode" means this tab was opened in the background by the console
  // header "Copy Login" button. We need to detect it even after OAuth redirects
  // (e.g. to an LDAP login page) which strip the original query parameter.
  //
  // Detection order:
  //   1. Direct query param on the current URL          (?oc-pilot-silent=1)
  //   2. The param embedded in the encoded 'then' value  (?then=...oc-pilot-silent...)
  //   3. SessionStorage flag set on a previous page in this tab (survives navigation)

  function isSilentMode() {
    if (location.search.includes("oc-pilot-silent")) return true;
    try {
      const thenVal = new URLSearchParams(location.search).get("then") || "";
      if (thenVal.includes("oc-pilot-silent")) return true;
    } catch (_) {}
    try { return sessionStorage.getItem("oc-pilot-silent") === "1"; } catch (_) { return false; }
  }

  function markSilentMode() {
    try { sessionStorage.setItem("oc-pilot-silent", "1"); } catch (_) {}
  }

  function sendLoginCommandFailed() {
    silentLog("sendLoginCommandFailed", "url=" + location.href);
    try { chrome.runtime.sendMessage({ type: "loginCommandFailed" }); } catch (_) {}
  }

  // ── Token request page (skip the "Display Token" click) ─────────────────────

  function handleTokenRequest(config) {
    const silent = isSilentMode();
    log("[CopyLogin] handleTokenRequest — silent:", silent, "| autoCopyToken:", config.autoCopyToken, "| has creds:", !!(config.username && config.password));
    silentLog("handleTokenRequest",
      "silent=" + silent +
      " | autoCopyToken=" + config.autoCopyToken +
      " | hasCreds=" + !!(config.username && config.password) +
      " | url=" + location.href
    );
    // In silent mode (background tab opened by the console header "Copy Login"
    // button) we always proceed regardless of the autoCopyToken setting, and we
    // skip the visible progress banner since the tab is inactive.
    // Persist the flag so it survives OAuth redirects (e.g. to an LDAP login page).
    if (silent) markSilentMode();
    if (!config.autoCopyToken && !silent) {
      log("[CopyLogin] autoCopyToken disabled and not silent — skipping");
      silentLog("handleTokenRequest.skip", "autoCopyToken disabled and not silent");
      return;
    }
    if (!silent) showProgressBanner("fetching login token, please wait…");
    tryClickDisplayToken(0);
  }

  function tryClickDisplayToken(attempt) {
    // Strategy 1 — traditional form with explicit submit button/input.
    // Older OCP versions: <form action="/oauth/token/display"><input type="submit"></form>
    const form =
      document.querySelector('form[action*="/oauth/token/display"]') ||
      document.querySelector("form");

    const target =
      // Explicit submit inside a form (all OCP versions up to ~4.13)
      form?.querySelector('input[type="submit"], button[type="submit"]') ||
      // Button with no explicit type inside a form (defaults to submit; OCP 4.14+)
      form?.querySelector('button:not([type="button"]):not([type="reset"])') ||
      // Strategy 2 — anchor link directly to the display page (some OCP builds)
      document.querySelector('a[href*="/oauth/token/display"]') ||
      // Strategy 3 — any button / link whose visible text mentions "Display Token"
      Array.from(document.querySelectorAll('button, input[type="submit"], a')).find(
        (el) => /display\s*token/i.test(el.textContent || el.value || '')
      );

    if (target) {
      if (pageActed) return;
      pageActed = true;
      const targetDesc =
        target.tagName + '[type=' + (target.getAttribute("type") || "none") + '] "' +
        (target.textContent || target.value || "").trim().substring(0, 40) + '"';
      log("[CopyLogin] clicking Display Token (attempt", attempt + 1, ") —", targetDesc);
      silentLog("tryClickDisplayToken.click", "attempt=" + (attempt + 1) + " | " + targetDesc);
      target.click();
      return;
    }

    // The page may render its button asynchronously — retry for up to 3 seconds.
    if (attempt < 15) {
      if (attempt === 0) {
        log("[CopyLogin] Display Token button not found yet — retrying up to 3 s…");
        // Full diagnostic snapshot on the very first miss so we can see exactly
        // what the page looked like before any retries changed state.
        const allForms = Array.from(document.querySelectorAll('form'))
          .map((f) => 'FORM[action=' + (f.getAttribute('action') || '?') + ']')
          .join(' | ');
        const allBtns = Array.from(
          document.querySelectorAll('button, input[type="submit"], a')
        )
          .map((el) =>
            el.tagName + '[type=' + (el.getAttribute('type') || '?') + '] "' +
            (el.textContent || el.value || '').trim().slice(0, 40) + '"'
          )
          .join(' | ');
        silentLog("tryClickDisplayToken.miss0.url", location.href);
        silentLog("tryClickDisplayToken.miss0.readyState", document.readyState);
        silentLog("tryClickDisplayToken.miss0.forms", allForms || "(none)");
        silentLog("tryClickDisplayToken.miss0.buttons", allBtns || "(none)");
        silentLog("tryClickDisplayToken.miss0.body",
          (document.body?.innerText || '').substring(0, 400));
      }
      setTimeout(() => tryClickDisplayToken(attempt + 1), 200);
    } else {
      const bodyPreview = document.body?.innerText?.substring(0, 300) || '';
      log("[CopyLogin] Display Token button not found after retries — body preview:", bodyPreview);
      silentLog("tryClickDisplayToken.gaveUp", bodyPreview);
      // In silent mode the background is holding a 20 s timeout; fail fast so
      // it can close the tab and show a helpful error immediately.
      if (isSilentMode()) sendLoginCommandFailed();
    }
  }

  // ── Token display page ──────────────────────────────────────────────────────

  async function handleTokenDisplay(config) {
    const silent = isSilentMode();
    silentLog("handleTokenDisplay.entry", "silent=" + silent + " | url=" + location.href);

    // Always inject copy buttons on manual visits; skip in silent mode (the tab
    // is invisible and will be closed as soon as we extract the command).
    if (!silent) injectTokenPageCopyButtons();

    // In silent mode we ALWAYS proceed (the user explicitly clicked "Copy Login").
    // In normal mode we respect the autoCopyToken setting.
    if (!silent && !config.autoCopyToken) return;
    if (pageActed) return;

    // ── Newer OCP auth-code flow ────────────────────────────────────────────────
    // OCP 4.14+ uses a two-stage display flow:
    //   1. /oauth/token/request  → click button → /oauth/token/display?code=sha256~X
    //   2. /oauth/token/display?code=…  → shows "Display Token" button
    //   3. Click that button → the actual `oc login` command appears
    //
    // We use a single combined loop (30 × 200 ms = 6 s) that:
    //   a) First checks for the oc login command (already present on old OCP)
    //   b) If not found, tries to find and click the "Display Token" button
    //   c) After clicking the button, waits extra time for the command to appear
    //
    // findDisplayTokenElement() tries every possible selector/strategy so we
    // are not tripped up by OCP changing the button's type attribute.

    function findDisplayTokenElement() {
      // Strategy 1: any input[type=submit] whose value mentions "display token"
      const inputSubmit = Array.from(document.querySelectorAll('input[type="submit"]'))
        .find((el) => /display\s*token/i.test(el.value || ''));
      if (inputSubmit) return inputSubmit;

      // Strategy 2: any button (ANY type) whose text mentions "display token"
      const anyBtn = Array.from(document.querySelectorAll('button'))
        .find((el) => /display\s*token/i.test(el.textContent || ''));
      if (anyBtn) return anyBtn;

      // Strategy 3: anchor with matching text
      const anchor = Array.from(document.querySelectorAll('a'))
        .find((el) => /display\s*token/i.test(el.textContent || ''));
      if (anchor) return anchor;

      // Strategy 4: role="button" with matching text
      const roleBtn = Array.from(document.querySelectorAll('[role="button"]'))
        .find((el) => /display\s*token/i.test(el.textContent || ''));
      if (roleBtn) return roleBtn;

      // Strategy 5: full DOM walk — any element whose trimmed text is exactly
      // "Display Token" (case-insensitive) and is visible
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const text = (node.textContent || '').trim();
        if (/^display\s+token$/i.test(text) && node.offsetParent !== null) return node;
        node = walker.nextNode();
      }

      return null;
    }

    let displayBtnClicked = false;
    let match = null;

    for (let i = 0; i < 30; i++) {
      // Always check for the command first (works on old OCP that shows it immediately)
      const raw = (document.body ? document.body.innerText : "").replace(/[\r\n]+/g, " ");
      match = raw.match(/oc login --token=\S+ --server=\S+/);
      if (match) break;

      // Not found yet — try to click the "Display Token" button if not yet clicked
      if (!displayBtnClicked) {
        const displayBtn = findDisplayTokenElement();
        if (displayBtn) {
          const btnDesc =
            displayBtn.tagName + '[type=' + (displayBtn.type || 'n/a') + '] "' +
            (displayBtn.textContent || '').trim().substring(0, 40) + '"';
          log("[CopyLogin] display page: clicking element —", btnDesc);
          silentLog("handleTokenDisplay.clickDisplayBtn", btnDesc);
          displayBtn.click();
          displayBtnClicked = true;
          // Give the page extra time to render the command after the click
          await new Promise((r) => setTimeout(r, 500));
          continue;
        } else if (i === 9) {
          // After 2 s of not finding the button, log diagnostics
          const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
            .map((el) => `${el.tagName}[type=${el.type || 'n/a'}] "${(el.textContent || el.value || '').trim().substring(0, 30)}"`)
            .join(' | ');
          log("[CopyLogin] display page: 'Display Token' button not found after 2s. Buttons on page:", allBtns || '(none)');
          log("[CopyLogin] body preview:", document.body?.innerText?.substring(0, 200));
          silentLog("handleTokenDisplay.noDisplayBtn2s.buttons", allBtns || '(none)');
          silentLog("handleTokenDisplay.noDisplayBtn2s.body",
            document.body?.innerText?.substring(0, 400) || '');
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    if (!match) {
      const bodyPreview = document.body?.innerText?.substring(0, 300) || '';
      log("[CopyLogin] no oc login command found after retries — body preview:", bodyPreview);
      silentLog("handleTokenDisplay.noCmd", bodyPreview);
      if (silent) sendLoginCommandFailed();
      return;
    }

    pageActed = true;
    const cmd = match[0].replace(/\s+/g, " ").trim();
    log("[CopyLogin] command extracted (first 60 chars):", cmd.substring(0, 60));
    silentLog("handleTokenDisplay.cmdFound", cmd.substring(0, 80));

    // Silent mode: this tab was opened by the background to extract the command.
    // Send it back to the background (which copies it and closes this tab).
    // Clipboard writes are not available in inactive background tabs.
    if (silent) {
      silentLog("handleTokenDisplay.sendingReady", cmd.substring(0, 80));
      log("[CopyLogin] sending loginCommandReady to background");
      try {
        chrome.runtime.sendMessage({ type: "loginCommandReady", text: cmd }, (resp) => {
          if (chrome.runtime.lastError) {
            silentLog("handleTokenDisplay.sendReadyError",
              String(chrome.runtime.lastError.message));
          }
        });
      } catch (err) {
        log("[CopyLogin] loginCommandReady send failed:", err);
        silentLog("handleTokenDisplay.sendReadyThrew", String(err));
      }
      return;
    }

    let copied = false;
    try {
      await navigator.clipboard.writeText(cmd);
      copied = true;
    } catch (_) {
      copied = await requestBackgroundCopy(cmd);
    }
    showToast(copied ? "Login command copied to clipboard" : "Could not copy to clipboard");
  }

  // Inject copy buttons next to the API token, oc login command, and curl command.
  function injectTokenPageCopyButtons() {
    // Give the page a tick to finish any final rendering.
    setTimeout(() => {
      const elements = Array.from(
        document.querySelectorAll("pre, code, .token-value, [class*='token']")
      );
      // Also scan <code> / <pre> inside the body via innerText line search.
      const body = document.body;
      if (!body) return;

      const seen = new WeakSet();

      // Walk every <pre> and <code> and determine what it contains.
      elements.forEach((el) => {
        if (seen.has(el)) return;
        if (el.dataset.ocCopy) return;           // already processed
        if (el.children.length > 3) return;      // skip structural elements

        const raw = (el.textContent || "").trim();
        if (!raw || raw.length < 5) return;

        const isToken   = /^sha256~\S{10,}$/.test(raw) || /^[A-Za-z0-9._-]{20,}$/.test(raw);
        const isOcLogin = /oc login --token=/.test(raw);
        const isCurl    = /curl.*Authorization.*Bearer/.test(raw);

        if (!isToken && !isOcLogin && !isCurl) return;

        seen.add(el);
        el.dataset.ocCopy = "1";

        let label = "Copy";
        if (isOcLogin) label = "Copy command";
        else if (isCurl) label = "Copy curl";

        addCopyButtonAfter(el, raw, label);
      });
    }, 100);
  }

  function addCopyButtonAfter(el, text, label) {
    const btn = document.createElement("button");
    btn.setAttribute("style", [
      "display:inline-flex",
      "align-items:center",
      "gap:5px",
      "margin-left:10px",
      "padding:4px 11px",
      "font-size:11.5px",
      "font-weight:600",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "background:#0f1117",
      "color:#e5e7eb",
      "border:1px solid rgba(255,255,255,0.12)",
      "border-radius:5px",
      "cursor:pointer",
      "vertical-align:middle",
      "letter-spacing:0.02em",
      "transition:background 0.15s",
    ].join(";"));
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      <span>${label}</span>
    `;

    btn.addEventListener("mouseenter", () => { btn.style.background = "#1e2130"; });
    btn.addEventListener("mouseleave", () => {
      if (!btn.dataset.copied) btn.style.background = "#0f1117";
    });

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { await navigator.clipboard.writeText(text); }
      catch (_) { await requestBackgroundCopy(text); }

      btn.dataset.copied = "1";
      btn.style.background = "#14532d";
      btn.style.borderColor = "rgba(34,197,94,0.35)";
      btn.style.color = "#86efac";
      btn.querySelector("span").textContent = "Copied!";

      setTimeout(() => {
        delete btn.dataset.copied;
        btn.style.background = "#0f1117";
        btn.style.borderColor = "rgba(255,255,255,0.12)";
        btn.style.color = "#e5e7eb";
        btn.querySelector("span").textContent = label;
      }, 2500);
    });

    el.insertAdjacentElement("afterend", btn);
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  function requestBackgroundCopy(text) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "copyToClipboard", text }, (resp) => {
          if (chrome.runtime.lastError) { resolve(false); return; }
          resolve(!!(resp && resp.ok));
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function showToast(text) {
    const host = document.createElement("div");
    host.setAttribute("style", [
      "all:initial",
      "position:fixed",
      "top:16px", "right:16px",
      "z-index:2147483647",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    ].join(";"));
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .box {
          background: #14532d;
          border: 1px solid rgba(34,197,94,0.3);
          color: #86efac;
          padding: 10px 14px;
          border-radius: 6px;
          box-shadow: 0 6px 24px rgba(0,0,0,0.25);
          font-size: 13px;
          font-weight: 500;
        }
      </style>
      <div class="box">${escapeHtml(text)}</div>
    `;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 3500);
  }

  function describeEl(el) {
    if (!el) return "(none)";
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const text = (el.textContent || "").trim().slice(0, 40);
    const href = el.getAttribute && el.getAttribute("href");
    return `<${tag}${id}>${href ? ` href="${href}"` : ""} "${text}"`;
  }

  function log(...args) { console.log(LOG_PREFIX, ...args); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
})();
