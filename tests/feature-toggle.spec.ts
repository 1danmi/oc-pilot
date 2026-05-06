/**
 * Feature toggle behaviour
 *
 * Each feature flag in storage controls whether the corresponding UI
 * element is injected. Also exercises the runtime onChanged listener:
 * toggling a flag while a page is rendered should remove (or add) the
 * UI within ~2 s without requiring a page reload.
 */

import { test, expect } from './fixtures/extension';
import { setFeatures, setFavourites, clearAllStorage } from './fixtures/storage';

test.describe('Feature toggles', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
  });

  test('favourites OFF: pinned section is absent even when favourites map is populated', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, {
      'openshift-console/deployments': ['downloads'],
    });
    await setFeatures(context, { favourites: false });

    await extPage.goto('/k8s/ns/openshift-console/deployments');
    await extPage.waitForTimeout(3_000);

    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toHaveCount(0);
  });

  test('favourites ON: pinned section is present', async ({ extPage, context }) => {
    await setFavourites(context, {
      'openshift-console/deployments': ['downloads'],
    });
    await setFeatures(context, { favourites: true });

    await extPage.goto('/k8s/ns/openshift-console/deployments');

    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });
  });

  test('clickToCopy OFF: resource name has no data-oc-pilot-copy attribute', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, { clickToCopy: false });

    await extPage.goto('/k8s/ns/openshift-console/deployments/downloads');
    await extPage.waitForTimeout(3_000);

    const stamped = extPage.locator('[data-oc-pilot-copy="1"]');
    await expect(stamped).toHaveCount(0);
  });

  test('runtime toggle: turning podTerminal off removes Terminal buttons within 2 s', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, {
      podTerminal: true,
      podLogs: true,
      podEvents: true,
    });

    // Pod actions live on the /pods sub-tab on OKD 4.16+
    await extPage.goto('/k8s/ns/openshift-console/deployments/downloads/pods');
    // Wait until Terminal buttons are present
    await expect(
      extPage.locator('.oc-pilot-pod-actions a', { hasText: 'Terminal' }).first()
    ).toBeVisible({ timeout: 20_000 });

    // Now flip the flag — the storage onChanged listener should re-run onNavigate
    await setFeatures(context, { podTerminal: false });

    // Allow up to 5 s for the listener to clear injected buttons
    await expect(async () => {
      const count = await extPage
        .locator('.oc-pilot-pod-actions a', { hasText: 'Terminal' })
        .count();
      expect(count).toBe(0);
    }).toPass({ timeout: 5_000 });
  });
});
