# OC Pilot — Test Plan

This is the canonical index of every automated test case in the suite.
It is the authoritative source of truth for what is tested and where.

**Maintenance rule** — before merging any change to `src/`, the matching
row(s) in this table MUST be updated and the corresponding spec file
extended. CI runs `npm test`; if a row is missing or stale the change
is rejected at review time.

Tests live in `tests/*.spec.ts`. The framework is `@playwright/test`.
See `CLAUDE.md` at the repository root for run instructions.

---

## Pod action buttons — `pod-actions.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 1 | podTerminal/Logs/Events | All three flags ON, on `/k8s/ns/openshift-console/deployments/downloads` | Wait for pod rows to render | Each pod row contains a `.oc-pilot-pod-actions` group with three `<a>`: Terminal, Logs, Events |
| 2 | podTerminal | flag ON, deployment detail loaded | Read `href` of the Terminal `<a>` | href ends with `/terminal` |
| 3 | podLogs | flag ON, deployment detail loaded | Read `href` of the Logs `<a>` | href ends with `/logs` |
| 4 | podEvents | flag ON, deployment detail loaded | Read `href` of the Events `<a>` | href ends with `/events` |
| 5 | podTerminal | flag OFF | Navigate to deployment detail | Zero `<a>` with text "Terminal" inside any `.oc-pilot-pod-actions` |
| 6 | podLogs | flag OFF | Navigate to deployment detail | Zero `<a>` with text "Logs" inside any `.oc-pilot-pod-actions` |
| 7 | All three pod actions | All OFF | Navigate to deployment detail | Zero `.oc-pilot-pod-actions` elements rendered |

## Pod image-version badge — `pod-image-tag.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 8 | podImageTag | flag ON, deployment detail loaded | Wait for badge | At least one `.oc-pilot-image-tag` is visible with non-empty text |
| 9 | podImageTag | flag ON, badge visible | Read `title` attribute | title is a non-empty image reference |
| 10 | podImageTag | flag OFF, podTerminal/Logs/Events ON | Wait 3 s after rows render | Zero `.oc-pilot-image-tag` elements |

## Feature toggle — `feature-toggle.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 11 | favourites | flag OFF, favourites map populated | Navigate to deployments list | `#oc-pilot-pinned-table-wrapper` is absent |
| 12 | favourites | flag ON, favourites map populated | Navigate to deployments list | `#oc-pilot-pinned-table-wrapper` is present |
| 13 | clickToCopy | flag OFF, on Deployment detail | Navigate to detail page | Resource name has no `data-oc-pilot-copy="1"` attribute |
| 14 | (toggling at runtime) | All flags ON, page rendered | Service-worker sets podTerminal=false | Within 5 s Terminal buttons disappear (storage onChanged listener) |

## Favourites — list page basics — `favourites-list.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 15 | favourites add | empty favourites map, on deployments list | Click "downloads" row's star | Pinned section appears with "downloads"; storage updated |
| 16 | favourites remove | "downloads" favourited | Click main-row star again | Pinned section disappears; storage no longer contains "downloads" |
| 17 | favourites pre-fill | "downloads" already in storage | Navigate to deployments list | Star on first paint is filled; pinned section already shows "downloads" |
| 18 | favourites empty | empty map | Navigate to deployments list | `#oc-pilot-pinned-table-wrapper` not present |
| 19 | favourites last-removal | exactly one favourite | Click its star | Pinned section element is fully removed (not left as empty container) |

## Favourites — regressions — `favourites-list-regression.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 20 | star ≠ row navigation (0.23.6/7) | empty favourites, deployments list | Click star on "downloads" row | URL stays on `/deployments` (does NOT change to `/deployments/downloads`); star toggles filled |
| 21 | filter clear refresh (0.23.8) | "downloads" favourited, on deployments list | Type "zzznoSuchName" in filter, then Ctrl+A + Backspace to clear | Within 3 s pinned shows "downloads" again |
| 22 | GVK URL form (0.23.5) | "downloads" in storage under canonical kind | Navigate to `…/apps~v1~Deployment` GVK URL | Pinned section shows "downloads" |
| 23 | virtualizer phantom-blank regression (test.fixme — known open issue) | empty favourites, on `/k8s/all-namespaces/deployments` (30+ rows → ReactVirtualized) | Scroll the page down 600px, then star 4 deployments in succession | All 4 favourites appear in pinned section AND the gap between pinned section bottom and first main-table row is < 80px. **Currently expected to fail**: WindowScroller's cached `_positionFromTop` goes stale when the pinned wrapper grows above the virtualizer; the virtualizer's `<table>` then overlays main-row stars (clicks intercepted) and empty space grows. Resize-event dispatch is not enough to fix it. |
| 24 | un-star from pinned | "downloads" favourited | Click star inside the pinned-section row | Pinned section disappears; main-row SVG fill is null/none; storage cleared |
| 25 | SPA navigation persistence | "downloads" favourited, on deployments list | Navigate to configmaps then back | Pinned section still contains "downloads" |
| 26 | cross-context storage sync | empty favourites, deployments list open | Service worker writes a favourite directly | Within 5 s pinned appears with "downloads" link |
| 27 | pinned-row click navigation | "downloads" favourited, pinned visible | Click resource-name link in pinned row | URL becomes `…/deployments/downloads` |
| 28 | kind isolation | favourites set for both deployments and configmaps | Navigate to deployments list, then configmaps list | Each list shows ONLY its own kind in pinned; no cross-kind leakage |
| 41 | pinned sort order | two favourites stored in reverse-alpha order (`zzz-test` before `downloads`) | Navigate to deployments list | Pinned section renders `downloads` first, `zzz-test` second (alphabetical) |

## Favourites — detail page — `favourites-detail.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 29 | detail-page star toggle | "downloads" not favourited | Navigate to detail page → click `.oc-pilot-detail-star` | Storage now contains "downloads"; star title contains "Remove" |
| 30 | detail-page star pre-fill | "downloads" favourited in storage | Navigate to detail page | Star title attribute matches /remove/i |
| 31 | detail ↔ list sync | not favourited | Star on detail page → navigate back to list | Pinned section appears with "downloads" |
| 32 | star alignment (0.25.1) | on a resource detail page | Measure bounding boxes of icon/name/star | All three vertical centres within 4 px of each other |

## Cluster colour — `cluster-colour.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 33 | apply colour | no colour for current host | Service worker sets `ocPilotClusterColours[host] = "#b71c1c"` → reload | `.pf-v5-c-masthead` computed `background-color` is `rgb(183, 28, 28)` |
| 34 | clear colour | colour set | Set colour to "" → reload | masthead background ≠ `rgb(183, 28, 28)` |
| 35 | colour persists across navigation | colour set | Navigate via SPA to a different page | masthead background still `rgb(183, 28, 28)` |

## Click-to-copy — `click-to-copy.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 36 | copy resource name | flag ON, on `/deployments/downloads` | Click element with `data-oc-pilot-copy="1"` | `navigator.clipboard.readText()` returns `"downloads"` |
| 37 | flag off — no copy handler | flag OFF, on detail page | Navigate to detail | Zero elements with `data-oc-pilot-copy="1"` |

## Force delete — `force-delete.spec.ts`

| # | Feature | Starting state | Action | Expected result |
|---|---------|----------------|--------|-----------------|
| 38 | inject force-delete on pod row | flag ON, on `/pods` | Wait for rows | Each `.oc-pilot-pod-actions` group contains a `.oc-pilot-force-delete-btn` |
| 39 | inject force-delete on pod detail | flag ON, on a pod detail page | Wait for header to render | `#oc-pilot-force-delete-btn` is present |
| 40 | flag OFF | flag OFF, on `/pods` | Wait 2 s after rows render | Zero `.oc-pilot-force-delete-btn` and no `#oc-pilot-force-delete-btn` |

---

## Out of scope

The following features are exercised manually only — they require resources
that cannot be reliably provisioned in a test environment:

- **Auto-login** — depends on cluster-external token endpoints
- **Copy login command** — depends on the OAuth token request flow
- **Owner link** (pod → Deployment/DC/StatefulSet button) — depends on
  knowing a specific orphaned pod that will not move; can be added later
  if needed
- **Cross-links** (Route ↔ Deployment) — depends on a known Route+Deployment
  pair; can be added once we pick a stable pair such as `console`
