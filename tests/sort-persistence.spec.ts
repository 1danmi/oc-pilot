/**
 * Persistent column sort — tests 44–47
 *
 * Verifies that the extension remembers which column the user sorted a
 * resource list by and restores that selection after page refresh or SPA
 * navigation.
 *
 * Prerequisites (same as the main suite):
 *   - OKD 4.16 console at http://localhost:9000 (override with CONSOLE_URL)
 *   - Namespace "openshift-console" containing at least one Pod
 *   - kubeadmin password in tests/.env
 */

import { test, expect } from './fixtures/extension';
import {
  setFeatures,
  getSortPrefs,
  setSortPrefs,
  clearAllStorage,
} from './fixtures/storage';

const NS      = 'openshift-console';
const LIST_URL = `/k8s/ns/${NS}/pods`;
const ALT_URL  = `/k8s/ns/${NS}/deployments`;

/** Selector for the column header <th> whose button text matches `label`. */
function sortHeaderLocator(page: import('@playwright/test').Page, label: string) {
  // Find a th[aria-sort] whose button text contains the label (after stripping icons).
  // We use a loose :has() + filter() approach via getByRole since Playwright
  // doesn't support :has(button:text(…)) across all engine versions.
  return page.locator(
    `th[aria-sort]:not(#oc-pilot-pinned-table-wrapper th) button, ` +
    `[role="columnheader"][aria-sort]:not(#oc-pilot-pinned-table-wrapper [role="columnheader"]) button`
  ).filter({ hasText: label }).first();
}

/** Return the `aria-sort` attribute of the parent th of a button. */
async function getSortDir(
  page: import('@playwright/test').Page,
  label: string
): Promise<string | null> {
  return page.evaluate((label) => {
    const buttons = Array.from(
      document.querySelectorAll(
        'th[aria-sort]:not(#oc-pilot-pinned-table-wrapper th) button,' +
        '[role="columnheader"][aria-sort]:not(#oc-pilot-pinned-table-wrapper [role="columnheader"]) button'
      )
    );
    const btn = buttons.find((b) => {
      const clone = (b as HTMLElement).cloneNode(true) as HTMLElement;
      clone.querySelectorAll('svg, .pf-v5-c-table__sort-indicator, .pf-c-table__sort-indicator')
        .forEach((el) => el.remove());
      return clone.textContent?.trim() === label;
    });
    if (!btn) return null;
    const th = btn.closest('[aria-sort]');
    return th ? th.getAttribute('aria-sort') : null;
  }, label);
}

/** Wait up to `timeout` ms for a column to reach the given aria-sort value. */
async function waitForSort(
  page: import('@playwright/test').Page,
  label: string,
  direction: string,
  timeout = 3000
) {
  await expect.poll(() => getSortDir(page, label), { timeout }).toBe(direction);
}

test.describe('Persistent column sort', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
    await setFeatures(context, { persistSort: true });
  });

  // ── Test 44: clicking a column saves ascending preference ─────────────────
  test('#44 clicking a column header saves asc preference', async ({ extPage }) => {
    await extPage.goto(LIST_URL);
    await extPage.waitForSelector('th[aria-sort]', { timeout: 20_000 });

    // Click "Name" column first to ensure we start in a known state, then click
    // a different column ("Created") to trigger the save.
    const createdBtn = sortHeaderLocator(extPage, 'Created');
    await createdBtn.waitFor({ timeout: 10_000 });
    await createdBtn.click();

    // Wait for React to apply the ascending sort
    await waitForSort(extPage, 'Created', 'ascending');

    // Wait for the extension's 150 ms debounce + storage write to complete
    await expect.poll(
      async () => (await getSortPrefs(extPage.context()))['pods'],
      { timeout: 2000 }
    ).toEqual({ column: 'Created', direction: 'asc' });
  });

  // ── Test 45: clicking the same column again saves descending preference ───
  test('#45 clicking the same column again saves desc preference', async ({ extPage }) => {
    await extPage.goto(LIST_URL);
    await extPage.waitForSelector('th[aria-sort]', { timeout: 20_000 });

    const createdBtn = sortHeaderLocator(extPage, 'Created');
    await createdBtn.waitFor({ timeout: 10_000 });

    // First click → ascending
    await createdBtn.click();
    await waitForSort(extPage, 'Created', 'ascending');

    // Second click → descending
    await createdBtn.click();
    await waitForSort(extPage, 'Created', 'descending');

    // Wait for the extension's 150 ms debounce + storage write to complete
    await expect.poll(
      async () => (await getSortPrefs(extPage.context()))['pods'],
      { timeout: 2000 }
    ).toEqual({ column: 'Created', direction: 'desc' });
  });

  // ── Test 46: sort is restored after page refresh ──────────────────────────
  test('#46 sort preference is restored after page refresh', async ({ extPage }) => {
    // Pre-seed the storage so we don't depend on tests 44/45 running first.
    await setSortPrefs(extPage.context(), {
      pods: { column: 'Created', direction: 'desc' },
    });

    await extPage.goto(LIST_URL);
    await extPage.waitForSelector('th[aria-sort]', { timeout: 20_000 });

    // Sort should be restored within 2 s
    await waitForSort(extPage, 'Created', 'descending', 3000);
  });

  // ── Test 47: sort is restored after SPA navigation away and back ──────────
  test('#47 sort preference is restored after SPA navigation', async ({ extPage }) => {
    await setSortPrefs(extPage.context(), {
      pods: { column: 'Created', direction: 'desc' },
    });

    await extPage.goto(LIST_URL);
    await extPage.waitForSelector('th[aria-sort]', { timeout: 20_000 });
    await waitForSort(extPage, 'Created', 'descending', 3000);

    // Navigate away (configmaps list)
    await extPage.goto(ALT_URL);
    await extPage.waitForSelector('th[aria-sort]', { timeout: 20_000 });

    // Navigate back
    await extPage.goto(LIST_URL);
    await extPage.waitForSelector('th[aria-sort]', { timeout: 20_000 });

    // Preference must be re-applied
    await waitForSort(extPage, 'Created', 'descending', 3000);
  });
});
