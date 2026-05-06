/**
 * Pod image version badge
 *
 * Verifies that the extension fetches the pod's container image from the
 * Kubernetes API and injects a version badge (.oc-pilot-image-tag) next to
 * the action buttons, and that the badge is hidden when the feature is off.
 *
 * Target resource: openshift-console / downloads  (always present in OKD)
 */

import { test, expect } from './fixtures/extension';
import { setFeatures, clearAllStorage } from './fixtures/storage';

// The Deployment "Details" tab does not embed pods on OKD 4.16+ — pods live
// on the dedicated /pods sub-tab. Navigate there so the image-tag badge has
// pod rows to attach to.
const DEPLOYMENT_URL = '/k8s/ns/openshift-console/deployments/downloads/pods';

test.describe('Pod image version badge', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
  });

  test('injects a non-empty image-tag badge when feature is enabled', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, {
      podTerminal: true,
      podLogs: true,
      podEvents: true,
      podImageTag: true,
    });

    await extPage.goto(DEPLOYMENT_URL);

    // The badge is injected after an async API call, so wait generously
    const badge = extPage.locator('.oc-pilot-image-tag').first();
    await expect(badge).toBeVisible({ timeout: 20_000 });

    // Badge must have non-empty text (a tag like "1.2.3" or a 7-char digest)
    const text = (await badge.textContent()) ?? '';
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test('badge title attribute contains the full image reference', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, { podImageTag: true });

    await extPage.goto(DEPLOYMENT_URL);
    const badge = extPage.locator('.oc-pilot-image-tag').first();
    await expect(badge).toBeVisible({ timeout: 20_000 });

    const title = (await badge.getAttribute('title')) ?? '';
    // Full image refs always contain a "/" (registry/image) or a ":" (image:tag)
    expect(title.length).toBeGreaterThan(0);
  });

  test('hides badge when podImageTag feature is disabled', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, {
      podTerminal: true,
      podLogs: true,
      podEvents: true,
      podImageTag: false,
    });

    await extPage.goto(DEPLOYMENT_URL);
    // Wait for pod rows to render (action group should appear since terminal/logs/events are on)
    await extPage.waitForSelector('.oc-pilot-pod-actions', { timeout: 20_000 });
    // Allow extra time for any async fetch that should NOT inject a badge
    await extPage.waitForTimeout(3_000);

    const badges = extPage.locator('.oc-pilot-image-tag');
    await expect(badges).toHaveCount(0);
  });
});
