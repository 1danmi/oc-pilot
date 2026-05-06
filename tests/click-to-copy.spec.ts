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
});
