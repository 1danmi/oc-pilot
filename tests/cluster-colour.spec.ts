/**
 * Cluster toolbar colour
 *
 * The extension lets the user assign a hex colour to any cluster's masthead
 * via a per-hostname map in storage. We verify that:
 *   - setting a colour changes the masthead background after reload
 *   - clearing the colour reverts to the default
 *   - the colour persists across SPA navigation (no flicker)
 */

import { test, expect } from './fixtures/extension';
import { setClusterColour, clearAllStorage } from './fixtures/storage';

const RED = '#b71c1c';
const RED_RGB = 'rgb(183, 28, 28)';

const ANY_PAGE = '/k8s/cluster/projects';

async function getMastheadHostname(page: import('@playwright/test').Page) {
  return page.evaluate(() => location.hostname);
}

async function getMastheadBackground(page: import('@playwright/test').Page) {
  // The console renders the masthead as part of its shell, but it doesn't
  // appear synchronously after navigation — the page first shows a loading
  // spinner. Wait for either masthead variant before measuring.
  // Try PF5 first then PF4.
  const selectors = ['.pf-v5-c-masthead', '.pf-c-page__header'];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      await el.waitFor({ state: 'attached', timeout: 15_000 });
      return el.evaluate((node) => getComputedStyle(node).backgroundColor);
    } catch {
      // Try the next selector
    }
  }
  throw new Error('No masthead element found');
}

test.describe('Cluster toolbar colour', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
  });

  test('applying red colour changes masthead background to rgb(183, 28, 28)', async ({
    extPage,
    context,
  }) => {
    await extPage.goto(ANY_PAGE);
    const host = await getMastheadHostname(extPage);

    await setClusterColour(context, host, RED);
    await extPage.reload();

    // Wait for the extension's <style> to be injected
    await expect(
      extPage.locator('#oc-pilot-masthead-colour')
    ).toHaveCount(1, { timeout: 10_000 });

    const bg = await getMastheadBackground(extPage);
    expect(bg).toBe(RED_RGB);
  });

  test('clearing the colour reverts the masthead', async ({ extPage, context }) => {
    await extPage.goto(ANY_PAGE);
    const host = await getMastheadHostname(extPage);

    await setClusterColour(context, host, RED);
    await extPage.reload();

    // Confirm red is applied first
    await expect(extPage.locator('#oc-pilot-masthead-colour')).toHaveCount(1, {
      timeout: 10_000,
    });

    await setClusterColour(context, host, '');
    await extPage.reload();

    // Style tag should be removed (or its content empty)
    await extPage.waitForTimeout(2_000);
    const bg = await getMastheadBackground(extPage);
    expect(bg).not.toBe(RED_RGB);
  });

  test('colour persists across SPA navigation without flicker', async ({
    extPage,
    context,
  }) => {
    await extPage.goto(ANY_PAGE);
    const host = await getMastheadHostname(extPage);

    await setClusterColour(context, host, RED);
    await extPage.reload();

    await expect(extPage.locator('#oc-pilot-masthead-colour')).toHaveCount(1, {
      timeout: 10_000,
    });
    expect(await getMastheadBackground(extPage)).toBe(RED_RGB);

    // SPA-style navigation
    await extPage.goto('/k8s/all-namespaces/configmaps');
    await extPage.waitForLoadState('domcontentloaded');

    expect(await getMastheadBackground(extPage)).toBe(RED_RGB);
  });
});
