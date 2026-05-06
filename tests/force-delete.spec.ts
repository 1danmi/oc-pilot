/**
 * Force-delete button presence
 *
 * The extension injects a "Force delete" button into pod list rows and a
 * standalone button (id=#oc-pilot-force-delete-btn) on pod detail pages
 * when forceDelete=true. These tests only verify presence — we do NOT
 * exercise the actual deletion flow because it's destructive.
 */

import { test, expect } from './fixtures/extension';
import { setFeatures, clearAllStorage } from './fixtures/storage';

const PODS_URL = '/k8s/ns/openshift-console/pods';

async function firstPodHref(page: import('@playwright/test').Page) {
  const link = page
    .locator('tr:not(#oc-pilot-pinned-table-wrapper tr) a[href*="/pods/"]')
    .first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  return link.getAttribute('href');
}

test.describe('Force-delete', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
  });

  test('flag ON: list rows have a .oc-pilot-force-delete-btn', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, {
      forceDelete: true,
      podTerminal: true,
      podLogs: true,
      podEvents: true,
    });

    await extPage.goto(PODS_URL);
    await expect(
      extPage.locator('.oc-pilot-pod-actions').first()
    ).toBeVisible({ timeout: 30_000 });

    // Each pod-action group should include a force-delete button
    const groupsCount = await extPage.locator('.oc-pilot-pod-actions').count();
    const fdCount = await extPage.locator('.oc-pilot-force-delete-btn').count();
    expect(fdCount).toBeGreaterThanOrEqual(groupsCount);
  });

  test('flag ON: pod detail page has #oc-pilot-force-delete-btn', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, { forceDelete: true });

    // We need a real pod's detail URL. Navigate to the pod list first so the
    // table renders, then read the first pod's href.
    await extPage.goto(PODS_URL);
    const href = await firstPodHref(extPage);
    expect(href).toBeTruthy();

    await extPage.goto(href!);

    await expect(
      extPage.locator('#oc-pilot-force-delete-btn')
    ).toBeVisible({ timeout: 20_000 });
  });

  test('flag OFF: no force-delete button anywhere', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, {
      forceDelete: false,
      podTerminal: true,
      podLogs: true,
      podEvents: true,
    });

    await extPage.goto(PODS_URL);
    // Wait for pod-action groups to render so we know injection has happened
    await extPage.waitForSelector('.oc-pilot-pod-actions', { timeout: 30_000 });
    await extPage.waitForTimeout(2_000);

    await expect(
      extPage.locator('.oc-pilot-force-delete-btn')
    ).toHaveCount(0);
    await expect(
      extPage.locator('#oc-pilot-force-delete-btn')
    ).toHaveCount(0);
  });
});
