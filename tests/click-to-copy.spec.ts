/**
 * Click-to-copy on resource detail pages
 *
 * Clicking the resource name <h1> on a detail page should copy the resource
 * name to the clipboard. We grant clipboard read permission to the test
 * context so we can verify by reading the clipboard back.
 */

import { test, expect } from './fixtures/extension';
import { setFeatures, clearAllStorage } from './fixtures/storage';

const RESOURCE = 'downloads';
const DETAIL_URL = `/k8s/ns/openshift-console/deployments/${RESOURCE}`;

test.describe('Click-to-copy', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
    // Grant clipboard permissions so navigator.clipboard.readText works
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('clicking the resource name copies it to the clipboard', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, { clickToCopy: true });

    await extPage.goto(DETAIL_URL);

    // The extension stamps data-oc-pilot-copy="1" on the title element
    // when click-to-copy is wired up. Wait for that.
    const target = extPage.locator('[data-oc-pilot-copy="1"]').first();
    await expect(target).toBeVisible({ timeout: 20_000 });

    await target.click();

    // Read clipboard via page context
    const copied = await extPage.evaluate(() =>
      navigator.clipboard.readText()
    );
    expect(copied).toBe(RESOURCE);
  });

  test('flag OFF: resource name has no copy attribute', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, { clickToCopy: false });

    await extPage.goto(DETAIL_URL);
    // Wait for the page to fully render
    await extPage.waitForLoadState('domcontentloaded');
    await extPage.waitForTimeout(3_000);

    await expect(
      extPage.locator('[data-oc-pilot-copy="1"]')
    ).toHaveCount(0);
  });

  // Regression: clicking the injected owner-link button (which the extension
  // appends *inside* the title <h1> on pod detail pages) used to bubble up to
  // the click-to-copy handler and copy the pod name. Fixed by bailing out on
  // any anchor/button click target inside the title element.
  test('clicking the injected owner-link inside the title does NOT trigger copy', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, {
      clickToCopy: true,
      ownerLink: true,
      spaNavigation: true,
    });

    // Find any pod owned by openshift-console/downloads.
    await extPage.goto('/k8s/ns/openshift-console/deployments/downloads/pods');
    const podLink = extPage
      .locator('tr:not(#oc-pilot-pinned-table-wrapper tr) a[href*="/pods/"]')
      .first();
    await expect(podLink).toBeVisible({ timeout: 30_000 });
    const podHref = await podLink.getAttribute('href');
    if (!podHref) throw new Error('Could not find a pod link');

    await extPage.goto(podHref);

    // Wait for the click-to-copy listener to attach to the heading AND for
    // the extension's owner-link button to be injected. Both must be present
    // for the bug scenario to even be possible.
    await expect(extPage.locator('[data-oc-pilot-copy="1"]')).toBeVisible({ timeout: 20_000 });
    await expect(extPage.locator('#oc-pilot-owner-btn')).toBeVisible({ timeout: 20_000 });

    // Plant a sentinel in the clipboard so we can detect any overwrite.
    const SENTINEL = '__oc-pilot-clipboard-sentinel__';
    await extPage.evaluate(async (v) => {
      await navigator.clipboard.writeText(v);
    }, SENTINEL);

    // Click the owner-link. SPA navigation should take us to the deployment
    // page; the click-to-copy handler must NOT fire.
    await extPage.locator('#oc-pilot-owner-btn').click();
    await extPage.waitForURL(/\/deployments\/downloads(\?|\/|$)/, { timeout: 10_000 });

    // Clipboard must still hold the sentinel. If the click-to-copy listener
    // had fired, it would have overwritten this with the pod's name.
    const clipboard = await extPage.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(SENTINEL);
  });
});
