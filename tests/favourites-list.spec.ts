/**
 * Favourites — list page basics
 *
 * Add/remove via the row star, pre-fill state, and pinned-section visibility.
 * Regression-heavy scenarios live in favourites-list-regression.spec.ts.
 */

import { test, expect } from './fixtures/extension';
import {
  setFeatures,
  setFavourites,
  getFavourites,
  clearAllStorage,
} from './fixtures/storage';

const NS = 'openshift-console';
const KIND_KEY = `${NS}/deployments`;
const RESOURCE = 'downloads';
const LIST_URL = `/k8s/ns/${NS}/deployments`;

// Locator for the star inside a specific row in the MAIN table (not pinned)
function mainRowStar(page: import('@playwright/test').Page, name: string) {
  // Star wraps live in rows that contain a link to the resource detail page.
  // Exclude the pinned wrapper to ensure we click the main-table star.
  return page
    .locator(
      `tr:has(a[href$="/${name}"]):not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap, ` +
        `[role="row"]:has(a[href$="/${name}"]):not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap`
    )
    .first();
}

test.describe('Favourites — list page basics', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
    await setFeatures(context, { favourites: true });
  });

  test('starring a resource adds it to the pinned section and storage', async ({
    extPage,
    context,
  }) => {
    await extPage.goto(LIST_URL);
    await extPage.waitForSelector(`a[href$="/${RESOURCE}"]`, { timeout: 20_000 });

    const star = mainRowStar(extPage, RESOURCE);
    await star.scrollIntoViewIfNeeded();
    await star.click();

    // Pinned section appears with the resource
    const pinned = extPage.locator('#oc-pilot-pinned-table-wrapper');
    await expect(pinned).toBeVisible({ timeout: 5_000 });
    await expect(
      pinned.locator(`a[href$="/${RESOURCE}"]`)
    ).toBeVisible();

    // Storage updated
    const favs = await getFavourites(context);
    expect(favs[KIND_KEY]).toContain(RESOURCE);
  });

  test('un-starring (from main row) removes from pinned section and storage', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(LIST_URL);
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });

    const star = mainRowStar(extPage, RESOURCE);
    await star.scrollIntoViewIfNeeded();
    await star.click();

    // Pinned section disappears (last fav removed)
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toHaveCount(0, { timeout: 5_000 });

    const favs = await getFavourites(context);
    expect(favs[KIND_KEY] || []).not.toContain(RESOURCE);
  });

  test('star is pre-filled when favourites already in storage', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(LIST_URL);

    // Pinned section appears on first paint
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`
      )
    ).toBeVisible();

    // Main row star carries the active class (or is amber)
    const star = mainRowStar(extPage, RESOURCE);
    await expect(star).toBeVisible();
    // Filled stars use a fill colour different from the empty state — assert
    // the inner SVG path is non-empty (filled stars set fill="currentColor"
    // and use color: amber). We check the SVG fill attribute.
    const fill = await star.locator('svg').getAttribute('fill');
    expect(fill).toBeTruthy();
  });

  test('empty favourites map = no pinned section', async ({ extPage }) => {
    await extPage.goto(LIST_URL);
    await extPage.waitForSelector(`a[href$="/${RESOURCE}"]`, { timeout: 20_000 });
    await extPage.waitForTimeout(2_000);

    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toHaveCount(0);
  });

  test('removing the last favourite fully removes the pinned section element', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(LIST_URL);
    const pinned = extPage.locator('#oc-pilot-pinned-table-wrapper');
    await expect(pinned).toBeVisible({ timeout: 20_000 });

    const star = mainRowStar(extPage, RESOURCE);
    await star.scrollIntoViewIfNeeded();
    await star.click();

    // The wrapper element itself should be removed from the DOM, not just emptied
    await expect(pinned).toHaveCount(0, { timeout: 5_000 });
  });
});
