/**
 * Favourites — detail page
 *
 * Tests the .oc-pilot-detail-star button injected next to the resource name
 * heading: toggle behaviour, pre-fill state, list↔detail sync, and the
 * heading alignment regression introduced in 0.25.1.
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
const DETAIL_URL = `/k8s/ns/${NS}/deployments/${RESOURCE}`;
const LIST_URL = `/k8s/ns/${NS}/deployments`;

test.describe('Favourites — detail page', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
    await setFeatures(context, { favourites: true });
  });

  test('clicking detail-page star adds resource to favourites', async ({
    extPage,
    context,
  }) => {
    await extPage.goto(DETAIL_URL);

    const star = extPage.locator('.oc-pilot-detail-star');
    await expect(star).toBeVisible({ timeout: 20_000 });
    await star.click();

    // Storage updated
    await expect(async () => {
      const favs = await getFavourites(context);
      expect(favs[KIND_KEY] || []).toContain(RESOURCE);
    }).toPass({ timeout: 3_000 });

    // Title flipped to "Remove from favourites"
    const title = await star.getAttribute('title');
    expect(title || '').toMatch(/remove/i);
  });

  test('star pre-fills when resource is already favourited', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(DETAIL_URL);
    const star = extPage.locator('.oc-pilot-detail-star');
    await expect(star).toBeVisible({ timeout: 20_000 });

    const title = await star.getAttribute('title');
    expect(title || '').toMatch(/remove/i);
  });

  test('star toggle on detail page is reflected on the list page', async ({
    extPage,
  }) => {
    await extPage.goto(DETAIL_URL);
    const star = extPage.locator('.oc-pilot-detail-star');
    await expect(star).toBeVisible({ timeout: 20_000 });
    await star.click();

    // Navigate back to the list page
    await extPage.goto(LIST_URL);

    // The pinned section should appear
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`
      )
    ).toBeVisible({ timeout: 20_000 });
  });

  // Regression from 0.25.1 — heading container needed align-items:center.
  test('star, kind icon, and resource name are vertically centre-aligned', async ({
    extPage,
  }) => {
    await extPage.goto(DETAIL_URL);
    const star = extPage.locator('.oc-pilot-detail-star');
    await expect(star).toBeVisible({ timeout: 20_000 });

    // Get bounding boxes for star, name <h1> (with class containing co-resource-item),
    // and the kind icon (the <span> with class containing "co-m-resource-icon").
    const starBox = await star.boundingBox();
    const nameBox = await extPage
      .locator('h1, .co-m-pane__name')
      .first()
      .boundingBox();
    const iconBox = await extPage
      .locator('.co-m-resource-icon')
      .first()
      .boundingBox();

    expect(starBox).not.toBeNull();
    expect(nameBox).not.toBeNull();
    expect(iconBox).not.toBeNull();

    const centre = (b: { y: number; height: number }) => b.y + b.height / 2;

    const cStar = centre(starBox!);
    const cName = centre(nameBox!);
    const cIcon = centre(iconBox!);

    // All three centres should be within 4 pixels of each other
    expect(Math.abs(cStar - cName)).toBeLessThanOrEqual(4);
    expect(Math.abs(cStar - cIcon)).toBeLessThanOrEqual(4);
    expect(Math.abs(cName - cIcon)).toBeLessThanOrEqual(4);
  });
});
