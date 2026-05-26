# OC Pilot — Changelog

> **Note on file paths in historical entries.** As of 2026-05-25 the repo was
> reorganized: `src/` → `extension/`, `server/` → `telemetry-server/`, build
> scripts (`pack.ps1`, `pack-crx.js`, `install.ps1`, `make-icons.ps1`) moved
> into `scripts/`. Historical entries below still reference the OLD paths
> because they describe the state of the repo at the time of each release.
> No code was changed in the rename — only file/folder moves.

## [0.27.2] — 2026-05-25

### Telemetry: send raw username alongside the existing hash

Internal-only enhancement so the telemetry server can later join against
Active Directory (department, team, location, etc.) and produce richer
dashboards than the salted hash allows. The extension is organisation-
approved for this deployment and usernames are public org data within
the network.

**Wire format additions** (everything else unchanged):

- `username` — raw OpenShift username, lowercased. `null` when the user
  hasn't configured credentials in the popup. Sent **alongside** the
  existing `userHash`; the hash is **not** removed (kept for continuity
  with historical aggregations).
- `passwords are still never sent`. The change is scoped strictly to the
  username field. The "What is never collected" callout in
  [`docs/telemetry.md`](./docs/telemetry.md#2-what-is-never-collected) is
  updated accordingly.

**Server changes:**

- `telemetry-server/app.py` — `TelemetryEvent.username: str | None` added
  (max 128 chars); inserted as `username` column on each MongoDB document;
  logged in the `telemetry_received` structured log line.
- No new indexes (we'll add one when the AD-enrichment dashboard is built).
- No dashboard changes (will land in a follow-up release).

Backwards-compatible:

- Older extension versions that don't send the field continue to work —
  the server stores `null` for them.
- Existing MongoDB rows have no `username` column; new rows have either
  the raw value or `null`. Queries that don't reference the field are
  unaffected.

---

## [0.27.1] — 2026-05-25

### Bug fix: telemetry `machineId` collided across similar hardware

v0.27.0 derived `machineId` from a SHA-256 hash of `navigator.platform |
hardwareConcurrency | deviceMemory | languages`. That made the value
deterministic across reinstalls on the same hardware — but also produced
the **same** value for any two machines whose hardware specs happened to
match. On a real install this caused 7 unique users to be counted as only
5 unique machines, because two pairs of engineers were on identical
corporate laptops.

v0.27.1 drops the fingerprint entirely:

- `machineId` is now a **random UUID** generated once and stored in
  `chrome.storage.sync["ocPilotMachineId"]`. Chrome sync replicates the
  value across uninstall + reinstall on the same Chrome profile — same
  persistence guarantee as before for sync-on users, with no possibility
  of cross-machine collision.
- Sync-off users lose the "stable across reinstall" property (they get a
  new random UUID per install, same as `installId`). That's strictly
  better than silent collisions across distinct machines.
- **Auto-migration:** on the next telemetry send after upgrading, any
  legacy 64-char hex `machineId` (either in `tel.machineId` or in
  `chrome.storage.sync["ocPilotMachineId"]`) is recognised by shape and
  replaced with a fresh random UUID. The local mirror is persisted
  immediately so the popup diagnostics reflect the new value.

Server-side, the same `machineId` column receives the new UUID format —
no schema change. Existing dashboard counts will show a one-time blip as
the upgraded installs all "appear" as new machines, but counts converge
within an hour as every install posts at least once.

---

## [0.27.0] — 2026-05-22

### New feature: SPA-style navigation for extension-injected anchors

Clicks on the extension's injected buttons (Terminal / Logs / Events on pod
rows, Owner link on pod detail, Route ↔ Deployment cross-links, the
favourites pinned-section row anchors) and the imperative redirect that
fires after a Force Delete now transition via React Router's pushState path
instead of triggering a full document reload. The page no longer flickers,
in-memory state (open dropdowns, side panels, scroll positions in other
tables) is preserved, and the transition is visibly snappier.

How it works:

- `routerNavigate(path)` lives in `src/content-console.js` (isolated world).
  It validates the path, short-circuits on duplicate same-URL navigations,
  and dispatches an `oc-pilot:navigate` CustomEvent on `document`.
- `src/content-console-rv.js` (MAIN world) listens for the event, calls
  `window.history.pushState(null, '', path)`, fires a synthetic
  `PopStateEvent('popstate')` so the console's React Router treats it as a
  normal SPA transition, and resets scroll on both `window` and the most
  common inner PatternFly page-main containers
  (`#content-scrollable`, `.pf-v5-c-page__main`, `.pf-c-page__main`,
  `.co-m-page__body`) to match the scroll-reset behavior of a real
  navigation.
- Window events don't cross the isolated ↔ MAIN world boundary, so the
  isolated-world `routerNavigate` also calls `onNavigate()` itself to
  re-run the extension's injectors for the destination route. Without
  this, the old route's injected buttons would linger until the
  MutationObserver caught up.
- A single delegated capture-phase click handler intercepts any
  extension-injected anchor marked with `data-oc-pilot-spa-link="1"`.
  Modifier-key clicks (Cmd/Ctrl/Shift/Alt/middle/right) are deliberately
  not hijacked so "open in new tab" continues to work natively.

Toggle in Settings → Console features → All resource pages → SPA-style
navigation. Default ON. Disable if a corner of the console misbehaves
under SPA transitions and the old behavior is needed temporarily.

**Related bug fix shipped with this release:** on a pod detail page where
the owner-link button gets appended **inside** the title `<h1>`, clicking
the button used to bubble up to the click-to-copy handler attached to
the same `<h1>` — copying the pod's name and showing the "✓ copied"
toast even though the user only wanted to navigate. Fixed in
`tryInjectClickToCopy` by bailing out when the click originated on an
`<a>`, `<button>`, or `[role="button"]` inside the title.

New Playwright tests 48–51 cover the SPA navigation feature (no
full reload, injector re-run, scroll reset, modifier-key bypass). Test
52 covers the click-to-copy regression. All on the live 4.16 console.

---

## [0.26.6] — 2026-05-22

### Telemetry: stable machineId + per-install installId

The single `machineId` field in the telemetry payload was a random UUID
seeded at install time. Uninstalling and reinstalling the extension reset
the UUID, making the same user/machine appear as two distinct machines in
the dashboards. There are now two identifiers:

- **`machineId`** — Stable per-machine. Survives uninstall/reinstall.
  Hybrid resolution: primary value lives in `chrome.storage.sync` (persists
  across reinstalls on the same Chrome profile); falls back to a
  deterministic SHA-256 fingerprint hash of stable navigator properties
  (`platform`, `hardwareConcurrency`, `deviceMemory`, `languages`) when
  sync is unavailable. `navigator.userAgent` and timezone are deliberately
  excluded so the value doesn't churn on every Chrome major update.
- **`installId`** — Per-install UUID. Resets on every install/reinstall.
  Equal to the value that used to live in `machineId`; the old value
  migrates to `installId` automatically on the next telemetry send.

Both IDs are now shown in the popup's Developer settings (truncated to
8 chars, full value on hover).

Wire format: both fields are camelCase in the POST body, matching every
other field. The MongoDB columns continue to be snake_case (`machine_id`,
`install_id`) — the camelCase → snake_case translation happens once, in
the server's `doc = {...}` insertion.

No new permissions required — `chrome.storage.sync` is covered by the
existing `storage` permission.

---

## [0.26.5] — 2026-05-20

### Bug fix: cluster credential overrides ignored

Two code paths looked up per-cluster credential overrides using the wrong
hostname key, so the fallback main credentials were always used instead.

- **Copy Login (background.js):** Was deriving the console hostname from the
  OAuth hostname via a regex transform (`oauth-openshift.` →
  `console-openshift-console.`). This fails for any cluster with a custom
  console route that doesn't follow that naming pattern. Fixed by passing
  `consoleHostname` directly from the content script (which knows the real
  console hostname via `location.hostname`) and using that for the override
  lookup. The regex fallback is kept for backward compatibility.
- **Auto-login (content.js):** Was looking up overrides by `location.hostname`
  while running on the OAuth/login page (e.g., `oauth-openshift.apps.*`), but
  overrides are stored under the console hostname
  (e.g., `console-openshift-console.apps.*`). Fixed by also trying the
  console-hostname equivalent before falling back to main credentials.

---

## [0.26.4] — 2026-05-20

### Silent page console

All 55 `console.log` calls in `content-console.js` are now routed through
`console.debug`, which Chrome DevTools hides by default (enable the "Verbose"
level to see them). `console.warn` and `console.error` are unchanged.
The page console is now clean for users.

---

## [0.26.3] — 2026-05-20

### Copy Login — 3 retries with user notification

When the initial token fetch fails with a transient error (e.g. right after
auto-login), the extension now retries up to 3 times, waiting 5 seconds between
each attempt. A blue "Retrying… (N of 3)" toast is shown before each retry while
the button stays in "Fetching…". If all retries are exhausted the error is surfaced
as before.

---

## [0.26.2] — 2026-05-20

### Bug fixes: post-login reliability

- **Copy Login — first-click failure after auto-login:** The background SW now
  automatically retries once (after 1 s) if the first `openshift-challenging-client`
  attempt returns an unexpected response right after a fresh login. Transient to the
  user — the button stays in "Fetching…" during the retry.
- **Extension dead after auto-login:** Removed the `_consoleInjectedTabs` per-tab
  deduplication set in `background.js`. It was preventing re-injection when the OAuth
  redirect brought the browser back to a non-`/k8s/` console URL. The DOM
  `data-oc-pilot-console-loaded` attribute in `content-console.js` already handles
  double-execution prevention; the SW-level set was redundant and harmful.
- **ABORT log messages:** `injectPinnedSection: ABORT` lines downgraded from
  `console.error` to `console.log` — they are expected (page not yet rendered) and
  should not appear as errors.

---

## [0.26.1] — 2026-05-20

### Copy Login — configurable timeout + better error messages

The Copy Login button would show "This cluster's identity provider does not support
Basic auth" when the cluster was merely throttling the OAuth request, and the
10-second safety-net was too short for throttled clusters (which can take 30–40 s).

**Changes:**

- Safety-net timeout raised from 10 s to 45 s (default) and is now configurable
  in the settings page under **Copy Login timeout (seconds)** (range 10–300).
- When the safety-net fires, the button resets and a
  "Timeout — wait a moment and try again" toast is shown.
- HTTP 429 responses from the OAuth server now produce a distinct
  "The cluster is rate-limiting auth requests — wait a moment and try again"
  message instead of the generic unsupported-provider error.
- The generic unsupported-provider message is softened to suggest retrying
  rather than declaring Copy Login permanently unsupported.

---

## [0.26.0] — 2026-05-20

### Version bump: persistent column sort ships as 0.26

Promotes the persistent column sort feature (developed in 0.25.19) to the 0.26
release line and adds it to the What's New section in the settings page.

**Bug fixes shipped with this release:**

- Increased sort-restore poll window from 2 s to 15 s so the preference is
  applied even when the pods/deployments table is slow to render.
- Added a re-entrancy lock (`_sortRestoreInProgress`) to `_applySortPreference`
  so that OKD's `replaceState` calls (fired on every sort click) cannot trigger
  a concurrent restore that toggles the column one click too many.
- Sort-save debounce (150 ms) now correctly handles the case where `waitForSort`
  resolves before the debounce fires; storage assertions in tests 44/45 now
  use `expect.poll` rather than a single synchronous read.

---

## [0.25.19] — 2026-05-20

### New feature: Persistent column sort

Resource list pages in the OpenShift console sort by Name on every page load.
This release adds an option to remember the column you chose.

**How it works:**

When you click a column header to sort a list (e.g. Pods by "Created"), the
extension saves your preference in `chrome.storage.local` under
`ocPilotSortPrefs`:

```
{ [hostname]: { [resourceKind]: { column: "Created", direction: "desc" } } }
```

On every subsequent visit to that resource type — whether via hard refresh,
SPA navigation, or browser back — the extension waits for the table to render
and then programmatically clicks the column header to restore the saved sort.
Clicking a column three times cycles back to "no sort" (the console's default),
which clears the saved preference.

**Scoping:** Preferences are stored per *resource kind* across all namespaces
(e.g. all Pods pages on a given cluster use the same sort preference). Per-
namespace scoping can be added later if needed.

**Detection strategy:** The extension uses the `aria-sort` attribute that
PatternFly (v4 and v5) places on `<th>` elements to read and write sort state.
This is stable across OpenShift console versions.

**Feature toggle:** "Persistent column sort" in the popup → Console features
section. On by default.

**Storage key:** `ocPilotSortPrefs` (top-level, separate from
`openshiftAutoLogin` so it survives credential resets).

---

## [0.25.18] — 2026-05-20

### Build: `t.config` moved into extension folder; telemetry now loaded at runtime

Previously `t.config` lived at the repo root and `pack.ps1` injected its
values into `background.js` as build-time substitutions. This only worked
for CRX builds — unpacked installs (Load unpacked → `src/`) loaded
`background.js` directly with placeholder text, so telemetry was always
disabled for unpacked installs.

`t.config` now lives in `src/` (the extension folder). `background.js`
reads it at SW startup using `fetch(chrome.runtime.getURL("t.config"))`.
This works for both unpacked and CRX installs. `pack.ps1` is updated to
delete `t.config` from the staging directory before zipping, so it is
never bundled into the CRX. The build-time placeholder substitution has
been removed entirely.

`src/t.config` is `.gitignore`d. `src/t.config.example` documents the
schema:

```json
{ "url": "http://your-server/v1/telemetry", "token": "your-token" }
```

If the file is absent or incomplete at runtime, the SW logs one line and
telemetry is disabled — same behaviour as before, but now consistent
across both unpacked and CRX installs.

---

## [0.25.17] — 2026-05-20

### Build: telemetry URL+token now injected from gitignored `t.config`

`DEFAULT_TELEMETRY_URL` and `DEFAULT_TELEMETRY_TOKEN` in `src/background.js`
were getting overwritten on every code change because the real values can't
be checked into the repo. They are now build-time placeholders
(`__OC_PILOT_TELEMETRY_URL__` / `__OC_PILOT_TELEMETRY_TOKEN__`) that
`pack.ps1` substitutes from a `t.config` file at the repo root.

`t.config` is `.gitignore`d and is NOT bundled into the CRX — `pack.ps1`
stages `src/` to a temp directory, does the substitution there, then zips
and signs from the staged copy. The working tree is never modified by the
build. A `t.config.example` is checked in to document the schema, and
`pack.ps1` aborts the build if it ever finds a `t.config` accidentally
copied into `src/` (safety guard against bundling secrets).

If the file is missing or its values are empty, the placeholders remain in
the bundled `background.js`. At SW startup the runtime detects this and:
- Writes one log line: `[oc-pilot:telemetry] disabled — no build-time config (t.config missing at pack time). Configure URL+token via the popup's tab-mode Diagnostics section to enable on this machine.`
- Returns early from `sendTelemetry()` — no network attempt
- Returns an empty URL from `telemetry/getConfig` so the popup UI doesn't show placeholder text

Per-install overrides (`openshiftAutoLogin.telemetry.serverUrl` /
`serverToken` set via the popup's tab-mode Diagnostics section) still work
and re-enable telemetry on a single machine even when the build's defaults
are placeholder.

---

## [0.25.16] — 2026-05-20

### Redesign: Copy Login — openshift-challenging-client Basic-auth flow

The previous fetch-based attempt (0.25.14–0.25.15) failed silently on real
clusters because the OAuth server's session cookie is `SameSite=Lax`, and
`host_permissions: ["<all_urls>"]` does NOT override SameSite. Background SW
fetches to `oauth-openshift.apps.*` are "cross-site" relative to the
extension's `chrome-extension://…` origin, so the cookie is stripped — the
GET to `/oauth/token/request` was being redirected to the login page even
though the user is logged in via the console.

**New approach:** OpenShift ships a built-in OAuth client named
`openshift-challenging-client` designed for HTTP Basic auth — the same
mechanism `oc login --username=… --password=…` uses internally. Since OC
Pilot already stores the user's credentials, we can authenticate directly:

```
GET /oauth/authorize?client_id=openshift-challenging-client&response_type=token
  Authorization: Basic <base64(user:pass)>
  X-CSRF-Token: 1
```

The server responds 302 with `Location: <redirect>#access_token=sha256~…`,
which we capture via `chrome.webRequest.onBeforeRedirect` (the response
itself is opaqueredirect — body and headers unreadable, but the webRequest
event still fires before the redirect is materialized). The API server URL
is derived from the OAuth origin: `oauth-openshift.apps.<base>` →
`api.<base>:6443`.

**Manifest:** Added `"webRequest"` permission (observation-only, no header
modification). Chrome will prompt to re-approve the extension on update;
this is required to read the Location header of the OAuth redirect.

**Compatibility:**
- ✓ kubeadmin, htpasswd, LDAP (simple bind), Keystone
- ✗ GitHub, GitLab, Google, OIDC, RequestHeader — these require interactive
  browser flows. The button surfaces a clear "unsupported-provider" toast.

**Error toasts** are now specific:
- `"Configure your username and password in OC Pilot settings…"` (no creds)
- `"Authentication failed — the stored username or password is incorrect…"`
- `"This cluster's identity provider does not support Basic auth…"`
- `"Could not derive the API server URL — non-standard OpenShift install"`

Authentication features remain manual-only per CLAUDE.md (no Playwright tests).

---

## [0.25.14] — 2026-05-20

### Redesign: Copy Login — direct background fetch (no tab opened)

Replaced the tab-based Copy Login flow with a direct `fetch()` from the
background service worker.

**Previous approach (0.25.11–0.25.13):** Background opened a silent/minimized
tab, waited for `content.js` to navigate the OAuth pages and relay the command
back via message passing. This was fragile: `chrome.windows.create` failed
with `state:"minimized"` on most Chrome versions, and `chrome.tabs.create`
triggered "Extension context invalidated" errors in already-open tabs.

**New approach:** The user is already authenticated — their browser holds live
session cookies for `oauth-openshift.apps.*`. The background service worker
calls `fetch(tokenRequestUrl, { credentials: 'include' })`, which Chrome
includes those cookies in (permitted by `host_permissions: ["<all_urls>"]`).
The SW then:
1. GETs `/oauth/token/request` (session cookie included → already authed)
2. Parses the CSRF token from the HTML response
3. POSTs to `/oauth/token/display` with the CSRF token
4. Extracts `oc login --token=… --server=…` from the response HTML
5. (Repeats step 2–4 once for newer OCP 4.14+ two-step display flow)

No tab opened, no content script involvement, completes in < 1 second.

**Also fixed:** "Extension context invalidated" now shows "Extension updated —
please refresh the page" instead of the generic "Failed to start token fetch".

---

## [0.25.13] — 2026-05-20

### Bug fix: Copy Login — "Could not open token-fetch window" on all clusters

`chrome.windows.create({ state: "minimized" })` fails silently on many
Chrome versions and OS combinations: the callback receives either a null
window or a window with an empty `tabs` array, so the extension immediately
showed the error toast.

**Root cause:** Chrome's windows API does not reliably support creating a
window in the minimized state at construction time. The API call appears to
succeed (no thrown exception) but delivers a broken result with no tab info.

**Fix:** Replaced `chrome.windows.create(...)` with
`chrome.tabs.create({ active: false })`. A background (inactive) tab is
universally supported, always delivers a usable `tab.id`, and keeps the
OAuth flow out of the user's focus. The tab is removed as soon as
`loginCommandReady` is received (or on timeout).

Also added `chrome.runtime.lastError` checking and logging in the creation
callback so future failures surface with an actionable error message instead
of a generic toast.

---

## [0.25.12] — 2026-05-20

### Diagnostic: Copy Login flow — full silent-tab logging relay

The Copy Login button has an undiagnosed failure mode. Because the silent
popup window closes before DevTools can be attached, all `console.log` output
from `content.js` inside it was invisible.

**What's new:** A `silentLog(label, data)` helper in `content.js` logs locally
AND relays every event to the background service worker via a `silentTabLog`
message. The background logs them as `[oc-pilot:silent]` entries in its own
persistent console, which survives after the tab closes.

**How to diagnose a broken "Copy Login":**
1. Open `chrome://extensions`, find OC Pilot, click **"Inspect views: service worker"**.
2. Clear the console, then click the Copy Login button in the OC console.
3. Look for the `[oc-pilot:silent]` lines — they tell you exactly which step
   the flow reached and what was on each page.

**Key logged checkpoints (all prefixed `[oc-pilot:silent]`):**
- `main.entry` — content.js loaded; URL, silent-mode detection, hasCreds
- `handleTokenRequest` — entering the /token/request handler
- `tryClickDisplayToken.miss0.*` — full snapshot (URL, readyState, all forms,
  all buttons, body preview) on the first attempt if the button isn't found
- `tryClickDisplayToken.click` — which element was clicked
- `tryClickDisplayToken.gaveUp` — body preview after all 15 retries fail
- `handleTokenDisplay.entry` — entering the /token/display handler
- `handleTokenDisplay.clickDisplayBtn` — clicked the inner Display Token button
- `handleTokenDisplay.noDisplayBtn2s.*` — buttons + body after 2 s without finding it
- `handleTokenDisplay.noCmd` — body preview when no `oc login` command found
- `handleTokenDisplay.cmdFound` — command extracted (first 80 chars)
- `handleTokenDisplay.sendingReady` — about to send loginCommandReady
- `handleTokenDisplay.sendReadyError` / `.sendReadyThrew` — if the send fails
- `sendLoginCommandFailed` — fast-fail path triggered

Also improved: `loginCommandReady` handler in background.js now logs all
current `silentTabSource` keys when the expected entry is missing, making
tab-ID mismatch bugs immediately visible.

No functional change to the Copy Login flow itself.

---

## [0.25.10] — 2026-05-06

### Bug fix: star buttons unclickable after un-starring (without scrolling)

After 0.25.9, clicking a star in the main list immediately after un-starring a
pinned item would randomly fail when the user was NOT scrolled.

**Root cause:** ReactVirtualized sets `pointer-events: none` on the entire
virtualizer grid while its `isScrolling` flag is `true`. Every call to
`__handleWindowScrollEvent()` sets `isScrolling: true` and then debounces
resetting it to `false` after ~150 ms. After an un-star, `updatePosition()` changed
`_positionFromTop`, which fired our setter, which scheduled
`__handleWindowScrollEvent()` via `setTimeout(0)`. During that ~150 ms window
all star-button clicks on the grid were silently swallowed.

**Why it was harmless to skip:** When the page is not scrolled,
`scrollElement.scrollTop = 0`, so `state.scrollTop = max(0, 0 − positionFromTop) = 0`
regardless of `_positionFromTop`. Calling `__handleWindowScrollEvent()` at that
point produces no visible change — it only triggers the unnecessary `isScrolling`
side-effect.

**Fix:** Both the `patchPositionProp` setter and `refreshScrollState()` now check
`scrollElement.scrollTop > 0` before calling `__handleWindowScrollEvent()`. When
not scrolled the function is skipped entirely; when scrolled it still fires and
corrects the phantom blank space.

---

## [0.25.9] — 2026-05-06

### Bug fix: phantom blank space — guard updatePosition() against no-op scroll frames

0.25.8 introduced a regression: `updatePosition()` was called on **every** `oc-pilot:rv-sync`
event, including the many no-op fires that happen during normal scrolling.

**Root cause:** The isolated-world `MutationObserver` watches `document.documentElement`
with `subtree: true` and fires on every ReactVirtualized row re-render during scrolling.
Each firing hits `scheduleInject → injectPinnedSection → _scheduleRvResize`, which
dispatches `oc-pilot:rv-sync`. In 0.25.8 the MAIN-world handler always called
`updatePosition()`, which re-measures `_positionFromTop` from the DOM mid-scroll. Because
`_positionFromTop` changed (layout in flux), our setter scheduled `__handleWindowScrollEvent()`
via `setTimeout(0)`, which ran after the scroll position had moved — computing a stale
`state.scrollTop` that was too high → phantom blank space, even without any starring.

**Fix:**
- `_scheduleRvResize()` in `content-console.js` now reads the current
  `oc-pilot-pinned-table-wrapper` height and passes it as `event.detail.pinnedHeight`.
- The MAIN-world handler in `content-console-rv.js` tracks `_lastPinnedHeight` and
  **skips** `updatePosition()` + `refreshScrollState()` when the height has not changed.
  `patchPositionProp()` (first-time install of the `_positionFromTop` interceptor) is
  still called on every event, since it is idempotent.

This means the expensive re-measure only runs when the pinned section actually grew or
shrank (star clicked / favourite removed), not on every virtualizer render frame.

---

## [0.25.8] — 2026-05-06

### Bug fix: phantom blank space — MAIN-world content script

Three earlier approaches failed due to Chrome's content-script isolation:

- `window.dispatchEvent(resize)` from the isolated world fires on the **isolated
  window**, not the page window — the WindowScroller's `_onResize` never fires.
- `Object.defineProperty` on page-world React instances from the isolated world
  mutates a cross-world proxy; those mutations are invisible from the page world.
- Injecting an inline `<script>` element is blocked by OKD's CSP
  (`script-src` lacks `'unsafe-inline'`; the browser console bypasses CSP,
  which made manual testing misleading).

**Fix:** A second content script (`content-console-rv.js`) declared with
`"world": "MAIN"` in `manifest.json` runs directly in the page's JavaScript
world, where it has unfenced access to React component instances.

The isolated-world `content-console.js` dispatches `document.dispatchEvent(new
CustomEvent('oc-pilot:rv-sync'))` from its `_scheduleRvResize` rAF callback.
The DOM is shared between worlds, so the MAIN-world script receives the event
and performs two actions:

1. **`inst.updatePosition()`** — forces a fresh measurement of `_positionFromTop`
   (ReactVirtualized only calls this on window/scrollElement resize; it never
   fires when our pinned section grows). This corrects the cached virtualizer
   offset immediately after each star click.

2. **`Object.defineProperty` on `_positionFromTop`** — installs a setter that
   calls `__handleWindowScrollEvent()` via `setTimeout(0)` on every future write,
   so any subsequent `updatePosition()` call (from OKD's own resize events) also
   resyncs `state.scrollTop` automatically.

3. **`refreshScrollState`** — calls `__handleWindowScrollEvent()` directly as a
   belt-and-suspenders fallback in case `updatePosition()` found no change.

Verified live: after real browser scroll + star clicks, `state.scrollTop` equals
`DrawerMain.scrollTop − _positionFromTop` with drift ≤ 0 px; no blank space.

---

## [0.25.7] — 2026-05-06

### Bug fix: phantom blank space — correct root cause

0.25.6 identified the correct symptom but used an ineffective mechanism:
`window.dispatchEvent(new Event('resize'))` from a content script dispatches
on the **content script's isolated window**, not the page's window. The page's
`WindowScroller._onResize` listener (registered on the page window) never
fires. Likewise, patching `WindowScroller.prototype.updatePosition` has no
effect because `_onResize` and `_detectElementResize` hold bound references
to the original function, bypassing the prototype.

**Root cause confirmed:** `_positionFromTop` is updated by
`_detectElementResize` (a ResizeObserver the page world registered on the
scroll container). When the pinned section grows, the element resize detector
fires → `updatePosition()` → `_positionFromTop` corrected. But `state.scrollTop`
is only recomputed on the next DrawerMain scroll event. If none fires before
the user is already scrolled, the rendering uses stale values and the blank
gap appears.

**Fix:** Replace the prototype patch with `Object.defineProperty` on the
`_positionFromTop` own-property of the WindowScroller instance. The setter
intercepts every write to `_positionFromTop` — regardless of whether it was
triggered by `_onResize`, `_detectElementResize`, or any other caller — and
schedules `__handleWindowScrollEvent()` via `setTimeout(0)` to resync
`state.scrollTop` outside React's synchronous update cycle. Verified in the
browser: property setter fires on simulated position change, `state.scrollTop`
auto-corrects from 1396.5 → 1192.5 (`scrollTop 2248 − positionFromTop 1055.5`).

---

## [0.25.6] — 2026-05-06

### Bug fix: phantom blank space above virtualizer when starring while scrolled

**Root cause (confirmed):** OKD's console uses a PatternFly `DrawerMain` div
as the scroll container — `window.scrollY` is always 0. ReactVirtualized's
`WindowScroller` is initialised with `scrollElement = DrawerMain`. On each
scroll event it computes `state.scrollTop = DrawerMain.scrollTop − _positionFromTop`.
When the extension inserts or grows the pinned section above the virtualizer,
the virtualizer shifts down and `_positionFromTop` becomes stale. Dispatching
`window resize` (the pre-existing fix) correctly calls `WindowScroller.updatePosition()`
which refreshes `_positionFromTop` — but `state.scrollTop` is **not**
recalculated at that point: it only updates on the next DOM scroll event.
The mismatch between the stale `state.scrollTop` and the correct
`_positionFromTop` caused the virtualizer to render rows starting ~180 px
below where they should, producing the visible blank gap.

**Fix (two-part):**

1. *Immediate correction* — after each `_scheduleRvResize` rAF, `_rvRefreshScrollState()`
   walks the React fiber tree to the `WindowScroller` instance and directly calls
   `__handleWindowScrollEvent()`, recomputing `state.scrollTop` without dispatching
   any synthetic DOM event.

2. *Permanent defence* — `_patchWindowScrollerUpdatePosition()` patches
   `WindowScroller.prototype.updatePosition` once (guarded by `_ocPilotPatched`).
   Every future call to `updatePosition()` — whether triggered by our resize event,
   an OKD UI reflow, or anything else — now also calls `__handleWindowScrollEvent()`
   via `setTimeout(0)` (deferred to stay outside React's synchronous update cycle).
   This prevents recurrence even if OKD fires its own resize events while the user
   is scrolled down.

Verified live: `state.scrollTop` corrected from 1396.5 → 1186.5 via console test;
blank space disappeared immediately after the prototype patch was applied.

### Test coverage: un-fixme the phantom-blank regression test

Test 23 (`scroll-down → star multiple → no phantom blank space`) promoted from
`test.fixme` to a regular test now that the underlying fix is in place.

---

## [0.25.5] — 2026-05-06

### Test coverage: virtualizer phantom-blank regression

Test 23 (`scroll-down → star multiple → no phantom blank space`) now
reproduces the in-the-wild flow (scroll down → star multiple items in
succession on a virtualized list). Marked `test.fixme` for now — the
test reliably reproduces the bug but the underlying fix is non-trivial.

### Known open issue: phantom blank space when starring while scrolled

When the user scrolls a long list (`/k8s/all-namespaces/deployments`,
etc.) down past the visible rows and then stars several deployments,
empty space grows above the table proportional to the number of new
favourites, and main-row stars become unclickable because the
virtualizer's `<table>` visually overlays them. Root cause:
ReactVirtualized's `WindowScroller` caches its `_positionFromTop`; the
dispatched `resize` event isn't enough to make it re-measure when the
window itself hasn't changed dimensions. Synthetic `scroll` events and
programmatic scroll-nudges both caused worse failure modes (pinned
wrapper being removed mid-cycle by a feedback loop with the extension's
own MutationObserver). This needs a different architectural approach —
either directly updating the WindowScroller instance, or repositioning
the pinned wrapper outside the virtualizer's relayout scope.

### Reverted: aggressive layout-event dispatch in 0.25.3

0.25.3 attempted a fix by dispatching both `resize` and `scroll` events.
That broke the pinned section entirely (it stopped rendering at all in
the user's browser). 0.25.4 tried a 1px scroll-nudge instead, with
similar issues. Both reverted in 0.25.5; only the `resize` dispatch
remains, matching pre-0.25.2 behaviour.

---

## [0.25.2] — 2026-05-06

### Bug fix: pinned favourites not sorted across namespaces

In the all-namespaces list view (e.g. `/k8s/all-namespaces/deployments`),
pinned favourites appeared in namespace insertion order instead of
alphabetical order by name. `toggleFavourite` only sorts within a single
namespace, so cross-namespace order was whatever order the user had first
starred something in each namespace. Fixed by sorting `allFavEntries`
alphabetically by name (with namespace as a tiebreaker) before rendering
the pinned tbody.

### Test coverage: virtualized scroll regression

The scroll-and-back regression test (test 23 in TEST-PLAN) was using a
1-row deployments list that did not trigger ReactVirtualized at all. It
now targets `/k8s/all-namespaces/deployments` (30+ rows in any real OKD
install) and additionally asserts that the pinned section's bounding-box
height does not collapse to ~0 or balloon after scrolling — the two
failure modes of the `_positionFromTop` cache regression.

---

## [0.25.1] — 2026-05-06

### Bug fix: detail-page heading alignment

The resource name, kind icon, star button, and associated badges (e.g. Route)
were not vertically centred in the heading row. The OKD heading container uses
`align-items: baseline`, which scatters items of different heights onto different
vertical positions. A one-time injected `<style>` now overrides that to
`align-items: center` for the heading container, putting everything on the same
midline.

---

## [0.25.0] — 2026-05-06

### New feature: pod image version badge

In Deployment and DeploymentConfig pod lists, the image version of each pod is
now shown next to the Terminal / Logs / Events buttons.

- The version is fetched from the pod's `spec.containers[0].image` field via the
  Kubernetes API — no extra permissions required, uses the same proxy as the rest
  of the extension.
- Tag-based images (`image-name:1.2.3`) show the tag (e.g. `1.2.3`).
- Digest-based images (`image@sha256:<hash>`) show the first 7 characters of the
  hash (e.g. `a3f9c12`).
- Images with no tag or digest show no badge.
- The full image reference is shown in a tooltip on hover.
- Makes it immediately visible when pods in the same deployment are running
  different image versions (e.g. during a rolling update or after a failed
  rollout).

---

## [0.24.0] — 2026-05-05

### New feature: Cluster toolbar colour

Assign one of 8 distinct colours to any cluster so browser tabs for different
OpenShift clusters are immediately distinguishable at a glance.

- Colour picker appears in the extension popup whenever you are on an OCP
  console page. It shows the hostname of the current cluster and 9 swatches
  (✕ = default + 8 colours).
- Picking a colour changes the masthead background instantly — no page reload.
- Colour is persisted per hostname in `chrome.storage.local` under the key
  `ocPilotClusterColours`. Each cluster stores its colour independently.
- The ✕ swatch reverts the cluster to the default OCP dark masthead.
- Clearing credentials does **not** affect cluster colours (separate storage key).
- Compatible with PatternFly 5 (OCP 4.12+) and PatternFly 4 (older consoles).

**Colour palette** (all WCAG AA against white text):

| Swatch | Hex | Suggested use |
|--------|-----|---------------|
| Red | `#b71c1c` | Production — danger zone |
| Blue | `#1565c0` | Development |
| Green | `#2e7d32` | Staging / test |
| Purple | `#6a1b9a` | QA |
| Teal | `#00695c` | Integration / feature branch |
| Orange | `#bf360c` | Hotfix / canary |
| Brown | `#4e342e` | Legacy / maintenance |
| Steel | `#37474f` | Secondary production / DR |

---

## [0.23.8] — 2026-05-05

### Bug fix: filter-clear not updating pinned favourites

When clearing a search term one character at a time (backspace), the pinned
favourites section was not updating until an unrelated event fired (mouse click,
key press, etc.).

**Root cause:** `getCurrentFilterText()` had an `input.value !== ''` guard that
caused it to fall through to the URL query string when the input was empty.
React updates the URL asynchronously after clearing the field, so the URL still
carried the previous `?name=` value — pinned section showed stale filtered results.

**Fix:** Always return `input.value` (empty string included) when the filter
input is present in the DOM; only fall back to the URL when there is no input.

---

## [0.23.7] — 2026-05-05

### Bug fix: star clicks doing nothing on resource list pages

Follow-up to 0.23.6. Removed the capture-phase click listener entirely from
favourite-star buttons. Chrome's event model empirically blocks bubble-phase
listeners on the same element when `stopPropagation()` is called in capture at
the target — even though a naive reading of the spec suggests otherwise. A single
bubble-phase listener with `stopPropagation()` is sufficient to prevent row
navigation while letting the toggle handler run.

---

## [0.23.6] — 2026-05-05

### Bug fix: `pointer-events: none` on star SVG

Set `pointer-events: none` on the SVG inside each star button so the button
element (not the SVG) is always the event target. This prevents the capture
listener from firing during the "at target" phase on the SVG, which was blocking
the async toggle handler.

---

## [0.23.5] — 2026-05-05

### Bug fix: GVK URL format mismatch (on-premise OpenShift)

On-premise OpenShift clusters use GVK-encoded path segments in resource list
URLs (e.g. `/k8s/ns/default/apps~v1~Deployment`) instead of the canonical
plural form (`deployments`). Favourites were stored under the canonical key but
looked up under the GVK key, so stars never appeared and clicking them had no
effect.

Added `_GVK_KIND_MAP` with 28 common resource types and a `normalizeResourceKind()`
helper applied in both `parseResourceListUrl` and `parseResourceDetailHref`.

---

## [0.23.4] — prior session

Initial working release of the favourites / pinned section feature.
