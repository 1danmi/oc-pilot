/**
 * SPA-style navigation — tests 48–51
 *
 * Verifies that the extension's injected anchors (and the imperative
 * force-delete redirect) navigate via React Router's pushState path instead
 * of triggering a full document reload — and that re-injection / scroll
 * reset / modifier-key handling all work as expected.
 *
 * Prerequisites (same as the main suite):
 *   - OKD 4.16 console at http://localhost:9000 (override with CONSOLE_URL)
 *   - Namespace "openshift-console" with at least one Pod
 *   - Namespace "openshift-network-diagnostics" with enough pods that the
 *     pods list page is taller than the viewport (always true on default
 *     OpenShift installs — one network-check pod per node + history).
 *     This is the "scrollable + present-on-all-clusters" namespace; we
 *     deliberately avoid openshift-monitoring because CRC strips it out.
 *   - kubeadmin password in tests/.env
 */

import { test, expect } from './fixtures/extension';
import { setFeatures, clearAllStorage } from './fixtures/storage';

const CONSOLE_NS = 'openshift-console';
const SCROLL_NS = 'openshift-network-diagnostics';
const CONSOLE_PODS = `/k8s/ns/${CONSOLE_NS}/pods`;
const SCROLL_PODS = `/k8s/ns/${SCROLL_NS}/pods`;

const MARKER_KEY = '__ocPilotSpaMarker';

/** Wait for the extension's injected pod-action button row to appear. */
async function waitForPodActions(page: import('@playwright/test').Page) {
  await page.waitForSelector('.oc-pilot-pod-actions', { timeout: 20_000 });
}

test.describe('SPA navigation', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
    // Enable the SPA-nav feature and the injectors we rely on.
    await setFeatures(context, {
      spaNavigation: true,
      podTerminal: true,
      podLogs: true,
      podEvents: true,
    });
  });

  // ── Test 48: clicking an injected anchor does not full-reload ─────────────
  test('#48 clicking an injected pod-action anchor performs an SPA transition', async ({ extPage }) => {
    await extPage.goto(CONSOLE_PODS);
    await waitForPodActions(extPage);

    // Plant a marker on `window`. A full reload would wipe it; an SPA
    // transition (pushState + popstate) keeps it.
    await extPage.evaluate((key) => {
      (window as unknown as Record<string, string>)[key] = 'still-here';
    }, MARKER_KEY);

    // Click the first injected "Logs" anchor (its href ends with /logs).
    const logsAnchor = extPage.locator('a[data-oc-pilot-spa-link][href$="/logs"]').first();
    await logsAnchor.waitFor({ timeout: 10_000 });
    await logsAnchor.click();

    // URL should change to .../logs.
    await extPage.waitForURL(/\/pods\/[^/]+\/logs$/, { timeout: 10_000 });

    // Marker must survive — proves no full reload happened.
    const marker = await extPage.evaluate(
      (key) => (window as unknown as Record<string, string | undefined>)[key],
      MARKER_KEY
    );
    expect(marker).toBe('still-here');
  });

  // ── Test 49: onNavigate re-injects buttons on the SPA destination ─────────
  test('#49 injectors re-run on the SPA-navigated destination', async ({ extPage }) => {
    await extPage.goto(CONSOLE_PODS);
    await waitForPodActions(extPage);

    // Plant a marker and fire the SPA-navigate bridge event directly. This
    // simulates what routerNavigate() does internally (the MAIN-world
    // listener pushes state + dispatches popstate).
    await extPage.evaluate(
      ({ key, target }) => {
        (window as unknown as Record<string, string>)[key] = 'still-here';
        document.dispatchEvent(
          new CustomEvent('oc-pilot:navigate', { detail: { pathname: target } })
        );
      },
      { key: MARKER_KEY, target: SCROLL_PODS }
    );

    // URL should swap to the monitoring namespace's pods list.
    await extPage.waitForURL(new RegExp(`/k8s/ns/${SCROLL_NS}/pods(\\?|$)`), {
      timeout: 10_000,
    });

    // No full reload — marker survived.
    const marker = await extPage.evaluate(
      (key) => (window as unknown as Record<string, string | undefined>)[key],
      MARKER_KEY
    );
    expect(marker).toBe('still-here');

    // The destination page must end up with our injected pod-action buttons.
    // (Re-injection happens either via the explicit onNavigate() inside
    // routerNavigate or via the global MutationObserver — both paths must
    // converge within the 20 s timeout.)
    await waitForPodActions(extPage);
    const groups = await extPage.locator('.oc-pilot-pod-actions').count();
    expect(groups).toBeGreaterThan(0);
  });

  // ── Test 50: scroll resets to top after SPA navigation ────────────────────
  // The OpenShift console doesn't necessarily scroll the window — modern
  // PatternFly layouts put `overflow: auto` on an inner page-main container.
  // This test probes for whichever element actually scrolls, scrolls it, then
  // verifies it returns to the top after a SPA navigation.
  test('#50 scroll position resets to top on SPA navigation', async ({ extPage }) => {
    // Start on a namespace whose pods list is taller than the viewport so we
    // have somewhere to scroll back from.
    await extPage.goto(SCROLL_PODS);
    await waitForPodActions(extPage);
    // Allow React to fully render the (possibly virtualized) table.
    await extPage.waitForTimeout(1000);

    type ScrollSnapshot = Record<string, number | null>;
    const SCROLL_SELECTORS = [
      '#content-scrollable',
      '.pf-v5-c-page__main',
      '.pf-c-page__main',
      '.co-m-page__body',
    ] as const;

    const scrollSnapshot = async (): Promise<ScrollSnapshot> =>
      extPage.evaluate((sels) => {
        const out: Record<string, number | null> = {
          window: window.scrollY,
          html: document.documentElement.scrollTop,
          body: document.body.scrollTop,
        };
        for (const s of sels) {
          const el = document.querySelector(s) as HTMLElement | null;
          out[s] = el ? el.scrollTop : null;
        }
        return out;
      }, SCROLL_SELECTORS as unknown as string[]);

    // Force-scroll every candidate scroll container that exists. Whichever
    // one is the real one will end up with scrollTop > 0; the others either
    // stay 0 or ignore the assignment (overflow: visible).
    await extPage.evaluate((sels) => {
      window.scrollTo(0, 400);
      try { document.documentElement.scrollTop = 400; } catch { /* noop */ }
      try { document.body.scrollTop = 400; } catch { /* noop */ }
      for (const s of sels) {
        const el = document.querySelector(s) as HTMLElement | null;
        if (el && typeof el.scrollTop !== 'undefined') el.scrollTop = 400;
      }
    }, SCROLL_SELECTORS as unknown as string[]);

    // Take a snapshot and find which keys actually scrolled.
    await extPage.waitForTimeout(200);
    const before = await scrollSnapshot();
    const scrolledKeys = Object.entries(before)
      .filter(([, v]) => typeof v === 'number' && (v as number) > 50)
      .map(([k]) => k);

    if (scrolledKeys.length === 0) {
      test.skip(true, 'No scrollable container responded on this layout — cannot verify scroll reset');
      return;
    }

    // Trigger SPA nav to a different list URL.
    await extPage.evaluate((target) => {
      document.dispatchEvent(
        new CustomEvent('oc-pilot:navigate', { detail: { pathname: target } })
      );
    }, CONSOLE_PODS);

    await extPage.waitForURL(new RegExp(`/k8s/ns/${CONSOLE_NS}/pods(\\?|$)`), {
      timeout: 10_000,
    });

    // Every element that was scrolled before must now be back at 0 — whether
    // because our MAIN-world handler reset it explicitly or because React
    // Router unmounted/remounted the route component naturally.
    await expect
      .poll(async () => {
        const after = await scrollSnapshot();
        return scrolledKeys.every((k) => after[k] === 0);
      }, { timeout: 5_000 })
      .toBe(true);
  });

  // ── Test 51: modifier-clicks bypass SPA interception (open in new tab) ────
  test('#51 modifier-click opens in a new tab without SPA interception', async ({ extPage, context }) => {
    await extPage.goto(CONSOLE_PODS);
    await waitForPodActions(extPage);

    const originalUrl = extPage.url();

    // Register the new-page listener BEFORE the click so we don't miss it.
    const newPagePromise = context.waitForEvent('page', { timeout: 10_000 });

    // Ctrl+click on the first injected "Terminal" anchor — should open in a
    // new tab as a full navigation, not be hijacked by our SPA handler.
    const terminalAnchor = extPage.locator('a[data-oc-pilot-spa-link][href$="/terminal"]').first();
    await terminalAnchor.waitFor({ timeout: 10_000 });
    await terminalAnchor.click({ modifiers: ['Control'] });

    const newPage = await newPagePromise;
    // The new tab navigated to the pod's terminal URL.
    await newPage.waitForURL(/\/pods\/[^/]+\/terminal$/, { timeout: 10_000 });

    // Original tab's URL is unchanged — we didn't intercept the modifier-click.
    expect(extPage.url()).toBe(originalUrl);

    await newPage.close();
  });
});
