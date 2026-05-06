# OC Pilot — Changelog

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
