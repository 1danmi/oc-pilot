/**
 * Pod action buttons — Terminal / Logs / Events
 *
 * Tests that the extension injects action buttons into pod list rows on a
 * Deployment detail page, that button hrefs are correct, and that disabling
 * individual feature flags hides the corresponding buttons.
 *
 * Target resource: openshift-console / downloads  (always present in OKD)
 */

import { test, expect } from './fixtures/extension';
import { setFeatures, clearAllStorage } from './fixtures/storage';

// The Deployment "Details" tab does not embed pods on OKD 4.16+ — pods live
// on the dedicated /pods sub-tab. Navigate there directly so the extension's
// pod-row injectors have rows to attach to.
const DEPLOYMENT_URL =
  '/k8s/ns/openshift-console/deployments/downloads/pods';

// Wait for pod action groups to appear (the extension injects them asynchronously
// after the React table renders).
async function waitForPodActions(page: import('@playwright/test').Page) {
  await page.waitForSelector('.oc-pilot-pod-actions', { timeout: 20_000 });
}

test.describe('Pod action buttons', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
    // Enable all three pod-action features
    await setFeatures(context, {
      podTerminal: true,
      podLogs: true,
      podEvents: true,
      podImageTag: false, // tested separately
    });
  });

  test('injects Terminal, Logs, Events buttons into pod rows', async ({ extPage }) => {
    await extPage.goto(DEPLOYMENT_URL);
    await waitForPodActions(extPage);

    // Each pod action group should contain all three buttons
    const group = extPage.locator('.oc-pilot-pod-actions').first();

    await expect(group.locator('a', { hasText: 'Terminal' })).toBeVisible();
    await expect(group.locator('a', { hasText: 'Logs' })).toBeVisible();
    await expect(group.locator('a', { hasText: 'Events' })).toBeVisible();
  });

  test('Terminal button href ends with /terminal', async ({ extPage }) => {
    await extPage.goto(DEPLOYMENT_URL);
    await waitForPodActions(extPage);

    const terminalBtn = extPage
      .locator('.oc-pilot-pod-actions a', { hasText: 'Terminal' })
      .first();
    const href = await terminalBtn.getAttribute('href');
    expect(href).toMatch(/\/terminal$/);
  });

  test('Logs button href ends with /logs', async ({ extPage }) => {
    await extPage.goto(DEPLOYMENT_URL);
    await waitForPodActions(extPage);

    const logsBtn = extPage
      .locator('.oc-pilot-pod-actions a', { hasText: 'Logs' })
      .first();
    const href = await logsBtn.getAttribute('href');
    expect(href).toMatch(/\/logs$/);
  });

  test('Events button href ends with /events', async ({ extPage }) => {
    await extPage.goto(DEPLOYMENT_URL);
    await waitForPodActions(extPage);

    const eventsBtn = extPage
      .locator('.oc-pilot-pod-actions a', { hasText: 'Events' })
      .first();
    const href = await eventsBtn.getAttribute('href');
    expect(href).toMatch(/\/events$/);
  });

  test('disabling podTerminal hides Terminal button', async ({ extPage, context }) => {
    await setFeatures(context, { podTerminal: false });
    await extPage.goto(DEPLOYMENT_URL);

    // Give the extension time to inject (or not inject) the buttons
    await extPage.waitForTimeout(3_000);

    // Either no pod-action groups exist, or none of them contain "Terminal"
    const terminalBtns = extPage.locator('.oc-pilot-pod-actions a', {
      hasText: 'Terminal',
    });
    await expect(terminalBtns).toHaveCount(0);
  });

  test('disabling podLogs hides Logs button', async ({ extPage, context }) => {
    await setFeatures(context, { podLogs: false });
    await extPage.goto(DEPLOYMENT_URL);
    await extPage.waitForTimeout(3_000);

    const logsBtns = extPage.locator('.oc-pilot-pod-actions a', { hasText: 'Logs' });
    await expect(logsBtns).toHaveCount(0);
  });

  test('disabling all three hides the action group entirely', async ({
    extPage,
    context,
  }) => {
    await setFeatures(context, {
      podTerminal: false,
      podLogs: false,
      podEvents: false,
    });
    await extPage.goto(DEPLOYMENT_URL);
    await extPage.waitForTimeout(3_000);

    const groups = extPage.locator('.oc-pilot-pod-actions');
    await expect(groups).toHaveCount(0);
  });
});
