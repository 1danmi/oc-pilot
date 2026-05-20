/**
 * Favourites — regression tests
 *
 * Each scenario here corresponds to a real bug that shipped at least once
 * (see CHANGELOG entries 0.23.5 through 0.23.8 and the recurring complaints
 * about virtualized table interactions). These are the highest-priority
 * tests in the suite — break one of these and a user notices immediately.
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

function mainRowStar(page: import('@playwright/test').Page, name: string) {
  return page
    .locator(
      `tr:has(a[href$="/${name}"]):not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap, ` +
        `[role="row"]:has(a[href$="/${name}"]):not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap`
    )
    .first();
}

function pinnedRowStar(page: import('@playwright/test').Page, name: string) {
  return page
    .locator(
      `#oc-pilot-pinned-table-wrapper tr:has(a[href$="/${name}"]) .oc-pilot-star-wrap, ` +
        `#oc-pilot-pinned-table-wrapper [role="row"]:has(a[href$="/${name}"]) .oc-pilot-star-wrap`
    )
    .first();
}

test.describe('Favourites — regression scenarios', () => {
  test.beforeEach(async ({ context }) => {
    await clearAllStorage(context);
    await setFeatures(context, { favourites: true });
  });

  // ── Regression: 0.23.6 / 0.23.7 ─────────────────────────────────────────
  test('clicking the star does NOT navigate to the row', async ({ extPage }) => {
    await extPage.goto(LIST_URL);
    await extPage.waitForSelector(`a[href$="/${RESOURCE}"]`, { timeout: 20_000 });

    const startUrl = extPage.url();
    const star = mainRowStar(extPage, RESOURCE);
    await star.scrollIntoViewIfNeeded();
    await star.click();

    // Give the SPA a moment to attempt a navigation if it is going to
    await extPage.waitForTimeout(1_000);
    expect(extPage.url()).toBe(startUrl);

    // Star did toggle
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 3_000 });
  });

  // ── Regression: 0.23.8 (filter input + pinned section sync) ──────────────
  test('typing in filter then clearing it refreshes the pinned section', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });
    await extPage.goto(LIST_URL);
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });

    // The filter input is OKD's standard "Filter by name" textbox.
    const filterInput = extPage
      .locator('input[placeholder*="name" i], input[placeholder*="Filter" i]')
      .first();
    await filterInput.fill('zzznoSuchName');

    // Now clear the filter by selecting all and pressing backspace
    await filterInput.click();
    await filterInput.press('Control+A');
    await filterInput.press('Backspace');

    // Within ~1.5 s the pinned section should re-show "downloads"
    await expect(async () => {
      const visible = await extPage
        .locator(`#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`)
        .count();
      expect(visible).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });
  });

  // ── Regression: 0.23.5 (GVK URL form) ───────────────────────────────────
  test('GVK URL form (apps~v1~Deployment) recognizes existing favourites', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(`/k8s/ns/${NS}/apps~v1~Deployment`);

    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`
      )
    ).toBeVisible();
  });

  // ── Virtualized table reuse ─────────────────────────────────────────────
  // Reproduces the regression seen in the wild: open the all-namespaces
  // deployments list, scroll down past the visible rows, then star several
  // deployments one after another. ReactVirtualized's WindowScroller caches
  // its _positionFromTop. When our pinned section grows above the virtualizer,
  // WindowScroller must re-measure AND resync state.scrollTop — otherwise it
  // keeps rendering rows at stale offsets and a phantom blank area grows above
  // the table. Fix history: 0.25.8 introduced the MAIN-world content script
  // (world: "MAIN") that calls updatePosition() and __handleWindowScrollEvent();
  // 0.25.9 added the pinnedHeight guard (skip updatePosition when unchanged,
  // preventing per-scroll-frame interference); 0.25.10 added the scrollTop > 0
  // guard (__handleWindowScrollEvent skipped when not scrolled to avoid the
  // isScrolling side-effect making stars unclickable).
  test('scroll-down → star multiple → no phantom blank space above the table', async ({
    extPage,
  }) => {
    await extPage.goto('/k8s/all-namespaces/deployments');
    await extPage.waitForSelector(
      'tr a[href*="/deployments/"], [role="row"] a[href*="/deployments/"]',
      { timeout: 30_000 }
    );
    await expect(extPage.locator('.oc-pilot-star-wrap').first()).toBeVisible({
      timeout: 20_000,
    });

    // Scroll down FIRST — the regression only manifests when the page is
    // scrolled (so the virtualizer has a non-zero _scrollTop / _positionFromTop
    // cached) at the moment new pinned rows appear above it.
    await extPage.evaluate(() => window.scrollBy(0, 600));
    await extPage.waitForTimeout(500);

    // Capture page-scroll position before any starring; after starring,
    // the page may scroll-adjust slightly but should not develop a huge gap.
    const scrollYBefore = await extPage.evaluate(() => window.scrollY);

    // IMPORTANT: capture the data-star-path of 4 currently-visible main-row
    // stars BEFORE any clicking. nth(i) re-evaluates each iteration; after
    // we star the first row, the locator's first match could still resolve
    // to the same now-favourited row and the next click would un-star it.
    // By capturing paths upfront and addressing each star by exact path, we
    // guarantee we star four DIFFERENT rows.
    const starredHrefs = await extPage.evaluate(() => {
      const wraps = document.querySelectorAll(
        'tr:not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap[data-star-path], ' +
          '[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap[data-star-path]'
      );
      return Array.from(wraps)
        .slice(0, 4)
        .map((w) => (w as HTMLElement).getAttribute('data-star-path')!)
        .filter(Boolean);
    });
    expect(starredHrefs.length).toBe(4);

    // Click each by its exact path. The negative wrapper selector ensures we
    // click the MAIN-row star, not the pinned-wrapper duplicate that appears
    // after starring.
    for (const path of starredHrefs) {
      const star = extPage
        .locator(
          `tr:not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap[data-star-path="${path}"], ` +
            `[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap[data-star-path="${path}"]`
        )
        .first();
      await star.scrollIntoViewIfNeeded();
      await star.click();
      await extPage.waitForTimeout(300);
    }

    // Wait for the section to settle.
    const wrapper = extPage.locator('#oc-pilot-pinned-table-wrapper');
    await expect(wrapper).toBeVisible({ timeout: 5_000 });

    // All four starred rows present in the pinned section.
    for (const href of starredHrefs) {
      await expect(
        extPage.locator(
          `#oc-pilot-pinned-table-wrapper a[href$="${href}"]`
        )
      ).toBeVisible();
    }

    // Measure pinned section height and the gap between its bottom edge and
    // the top of the first non-pinned row. If WindowScroller's _positionFromTop
    // is stale, that gap balloons (the phantom blank-space regression).
    const layout = await extPage.evaluate(() => {
      const w = document.getElementById('oc-pilot-pinned-table-wrapper');
      const firstMainRow = document.querySelector(
        'tr:not(#oc-pilot-pinned-table-wrapper tr):has(.oc-pilot-star-wrap), ' +
          '[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]):has(.oc-pilot-star-wrap)'
      ) as HTMLElement | null;
      if (!w || !firstMainRow) return null;
      const wRect = w.getBoundingClientRect();
      const rRect = firstMainRow.getBoundingClientRect();
      return {
        pinnedHeight: wRect.height,
        gap: rRect.top - wRect.bottom,
      };
    });

    expect(layout).not.toBeNull();
    // Pinned section has real content (4 rows of ~50px each ≈ 200px+).
    expect(layout!.pinnedHeight).toBeGreaterThan(100);
    // Gap between pinned section bottom and first main-table row should be
    // small (under 80px — accounts for table header, padding, slight margins).
    // The regression makes this 200–500+ px because the virtualizer leaves
    // a stale-offset blank above its first rendered row.
    expect(layout!.gap).toBeLessThan(80);

    // Sanity: page didn't violently scroll-jump as a side-effect.
    const scrollYAfter = await extPage.evaluate(() => window.scrollY);
    expect(Math.abs(scrollYAfter - scrollYBefore)).toBeLessThan(800);
  });

  // ── Un-star from pinned section also clears main row ────────────────────
  test('un-starring from pinned row clears main-row star and storage', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(LIST_URL);
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });

    await pinnedRowStar(extPage, RESOURCE).click();

    // Pinned section gone (was the only fav)
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toHaveCount(0, { timeout: 5_000 });

    // Main-row star is empty
    const star = mainRowStar(extPage, RESOURCE);
    const fill = await star.locator('svg').getAttribute('fill');
    expect(fill === null || fill === 'none').toBeTruthy();

    // Storage cleared
    const favs = await getFavourites(context);
    expect(favs[KIND_KEY] || []).not.toContain(RESOURCE);
  });

  // ── SPA navigation persistence ──────────────────────────────────────────
  test('pinned section persists across SPA navigation', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(LIST_URL);
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });

    // Navigate via SPA — go to ConfigMaps then back to Deployments
    await extPage.goto(`/k8s/ns/${NS}/configmaps`);
    await extPage.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await extPage.goto(LIST_URL);

    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`
      )
    ).toBeVisible({ timeout: 20_000 });
  });

  // ── Cross-context storage sync ──────────────────────────────────────────
  test('storage change made by service worker is reflected on the open page', async ({
    extPage,
    context,
  }) => {
    await extPage.goto(LIST_URL);
    await extPage.waitForSelector(`a[href$="/${RESOURCE}"]`, { timeout: 20_000 });
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toHaveCount(0);

    // Simulate a change made from another tab — write directly via SW
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    // Pinned section should appear within ~2 s thanks to onChanged listener
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`
      )
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── Pinned-row click navigates ──────────────────────────────────────────
  test('clicking the resource link inside pinned row navigates to detail page', async ({
    extPage,
    context,
  }) => {
    await setFavourites(context, { [KIND_KEY]: [RESOURCE] });

    await extPage.goto(LIST_URL);
    const link = extPage
      .locator(`#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`)
      .first();
    await expect(link).toBeVisible({ timeout: 20_000 });

    await link.click();

    await extPage.waitForURL(new RegExp(`/deployments/${RESOURCE}$`), {
      timeout: 10_000,
    });
  });

  // ── Kind isolation ──────────────────────────────────────────────────────
  test('favourites are isolated per kind — configmaps do not leak into deployments list', async ({
    extPage,
    context,
  }) => {
    // Pods are excluded from FAVOURITE_KINDS (ephemeral names), so use
    // configmaps — another stable, named resource in FAVOURITE_KINDS.
    // Pick the first configmap name from the configmaps list dynamically.
    await extPage.goto(`/k8s/ns/${NS}/configmaps`);
    await extPage.waitForSelector('a[href*="/configmaps/"]', { timeout: 30_000 });
    const cmHref = await extPage
      .locator(
        'tr:not(#oc-pilot-pinned-table-wrapper tr) a[href*="/configmaps/"], ' +
        '[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) a[href*="/configmaps/"]'
      )
      .first()
      .getAttribute('href');
    const cmName = cmHref?.split('/').pop() || '';
    expect(cmName.length).toBeGreaterThan(0);

    await setFavourites(context, {
      [`${NS}/deployments`]: [RESOURCE],
      [`${NS}/configmaps`]: [cmName],
    });

    // Deployments list — should only show "downloads" in pinned, NOT the configmap
    await extPage.goto(LIST_URL);
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/${RESOURCE}"]`
      )
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/configmaps/${cmName}"]`
      )
    ).toHaveCount(0);

    // Configmaps list — should only show the configmap, NOT "downloads"
    await extPage.goto(`/k8s/ns/${NS}/configmaps`);
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/configmaps/${cmName}"]`
      )
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      extPage.locator(
        `#oc-pilot-pinned-table-wrapper a[href$="/deployments/${RESOURCE}"]`
      )
    ).toHaveCount(0);
  });

  // ── Pinned section sort order ────────────────────────────────────────────
  test('pinned section entries are sorted alphabetically by name', async ({
    extPage,
    context,
  }) => {
    // Store in reverse-alpha order so insertion order would show 'zzz-test'
    // first — the extension must sort allFavEntries before rendering.
    // 'zzz-test' has no live row so it gets a synthetic placeholder row, which
    // still receives a co-resource-item__resource-name anchor.
    await setFavourites(context, {
      [KIND_KEY]: ['zzz-test', RESOURCE],
    });

    await extPage.goto(LIST_URL);
    await expect(
      extPage.locator('#oc-pilot-pinned-table-wrapper')
    ).toBeVisible({ timeout: 20_000 });

    // Read the primary name-link text in DOM order (one per row).
    const names = await extPage
      .locator('#oc-pilot-pinned-table-wrapper a.co-resource-item__resource-name')
      .allTextContents();

    expect(names.length).toBe(2);
    // Alphabetical: 'downloads' < 'zzz-test'
    expect(names[0]).toBe(RESOURCE);
    expect(names[1]).toBe('zzz-test');
  });

  // ── Regression: 0.25.9 (blank space while scrolling with a pinned section) ──
  // The isolated-world MutationObserver watches document.documentElement with
  // subtree:true, so every ReactVirtualized row re-render during a normal scroll
  // fires MutationObserver → scheduleInject → injectPinnedSection →
  // _scheduleRvResize → oc-pilot:rv-sync. In 0.25.8 the MAIN-world handler
  // always called updatePosition() on that event, re-measuring _positionFromTop
  // mid-scroll. Our setter then called __handleWindowScrollEvent() via
  // setTimeout(0), but by that point the scroll had advanced — state.scrollTop
  // became stale and a phantom blank space appeared just from scrolling, even
  // without starring anything new. Fixed by passing pinnedHeight in the event
  // detail and skipping updatePosition() when the height is unchanged.
  test('scroll with already-starred items → no phantom blank space', async ({
    extPage,
  }) => {
    await extPage.goto('/k8s/all-namespaces/deployments');
    await extPage.waitForSelector(
      'tr a[href*="/deployments/"], [role="row"] a[href*="/deployments/"]',
      { timeout: 30_000 }
    );
    await expect(extPage.locator('.oc-pilot-star-wrap').first()).toBeVisible({
      timeout: 20_000,
    });

    // Star 2 deployments BEFORE scrolling — pinned section is in place above
    // the virtualizer when we subsequently scroll. Capture paths upfront so the
    // second click cannot accidentally un-star the same row.
    const starPaths = await extPage.evaluate(() => {
      const wraps = document.querySelectorAll(
        'tr:not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap[data-star-path], ' +
          '[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap[data-star-path]'
      );
      return Array.from(wraps)
        .slice(0, 2)
        .map((w) => (w as HTMLElement).getAttribute('data-star-path')!)
        .filter(Boolean);
    });
    expect(starPaths.length).toBe(2);

    for (const path of starPaths) {
      const star = extPage
        .locator(
          `tr:not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap[data-star-path="${path}"], ` +
            `[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap[data-star-path="${path}"]`
        )
        .first();
      await star.click();
      await extPage.waitForTimeout(300);
    }

    await expect(extPage.locator('#oc-pilot-pinned-table-wrapper')).toBeVisible({
      timeout: 5_000,
    });

    // Now scroll — this is the trigger. Each row re-render during scroll fires
    // the MutationObserver chain. With the bug, updatePosition() runs on every
    // frame and corrupts state.scrollTop → blank space. With the fix, the event
    // carries pinnedHeight and is a no-op when it hasn't changed.
    await extPage.evaluate(() => window.scrollBy(0, 600));
    await extPage.waitForTimeout(600); // Let scroll settle and all rAFs fire.

    const layout = await extPage.evaluate(() => {
      const w = document.getElementById('oc-pilot-pinned-table-wrapper');
      const firstMainRow = document.querySelector(
        'tr:not(#oc-pilot-pinned-table-wrapper tr):has(.oc-pilot-star-wrap), ' +
          '[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]):has(.oc-pilot-star-wrap)'
      ) as HTMLElement | null;
      if (!w || !firstMainRow) return null;
      const wRect = w.getBoundingClientRect();
      const rRect = firstMainRow.getBoundingClientRect();
      return { pinnedHeight: wRect.height, gap: rRect.top - wRect.bottom };
    });

    expect(layout).not.toBeNull();
    expect(layout!.pinnedHeight).toBeGreaterThan(50);
    // The regression produces gaps of 200–500 px. A correct render should show
    // only table-header / padding between the pinned section and first main row.
    expect(layout!.gap).toBeLessThan(80);
  });

  // ── Regression: 0.25.10 (stars unclickable after un-starring without scroll) ─
  // After an un-star, injectPinnedSection → _scheduleRvResize → oc-pilot:rv-sync
  // → updatePosition() changed _positionFromTop → our Object.defineProperty setter
  // called __handleWindowScrollEvent() via setTimeout(0). That function sets
  // ReactVirtualized's isScrolling: true, which triggers a React re-render and a
  // ~150 ms DOM-update window during which clicks on main-list star buttons were
  // silently dropped. Fixed by guarding both the setter and refreshScrollState()
  // with scrollTop > 0 — when not scrolled, __handleWindowScrollEvent() is never
  // called, isScrolling stays false, and clicks always land.
  test('un-starring without scrolling → subsequent main-list star click is received', async ({
    extPage,
  }) => {
    await extPage.goto('/k8s/all-namespaces/deployments');
    await extPage.waitForSelector(
      'tr a[href*="/deployments/"], [role="row"] a[href*="/deployments/"]',
      { timeout: 30_000 }
    );
    await expect(extPage.locator('.oc-pilot-star-wrap').first()).toBeVisible({
      timeout: 20_000,
    });

    // Capture 3 star paths upfront:
    //   [0] and [1] → starred to build the pinned section
    //   [0]         → un-starred from the pinned section (triggers the bug window)
    //   [2]         → starred immediately after, to verify the click lands
    const starPaths = await extPage.evaluate(() => {
      const wraps = document.querySelectorAll(
        'tr:not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap[data-star-path], ' +
          '[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap[data-star-path]'
      );
      return Array.from(wraps)
        .slice(0, 3)
        .map((w) => (w as HTMLElement).getAttribute('data-star-path')!)
        .filter(Boolean);
    });
    expect(starPaths.length).toBe(3);

    // Star [0] and [1] without scrolling.
    for (const path of starPaths.slice(0, 2)) {
      const star = extPage
        .locator(
          `tr:not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap[data-star-path="${path}"], ` +
            `[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap[data-star-path="${path}"]`
        )
        .first();
      await star.click();
      await extPage.waitForTimeout(300);
    }

    await expect(extPage.locator('#oc-pilot-pinned-table-wrapper')).toBeVisible({
      timeout: 5_000,
    });

    // Un-star [0] from the PINNED section (not scrolled). This triggers the
    // _scheduleRvResize → rAF (~16 ms) → updatePosition() → _positionFromTop
    // setter → setTimeout(0) → (bug) __handleWindowScrollEvent() opening a
    // ~150 ms window where main-list star clicks are swallowed.
    const firstPinnedStar = extPage
      .locator(
        `#oc-pilot-pinned-table-wrapper .oc-pilot-star-wrap[data-star-path="${starPaths[0]}"]`
      )
      .first();
    await expect(firstPinnedStar).toBeVisible();
    await firstPinnedStar.click();

    // 30 ms: enough for the rAF + setTimeout(0) to have fired (the bug window
    // is now open), but well within the ~150 ms isScrolling debounce.
    // With the fix the scrollTop > 0 guard prevents __handleWindowScrollEvent()
    // from being called at all, so the window never opens.
    await extPage.waitForTimeout(30);

    // Click [2]'s star in the MAIN list while inside the bug window.
    // If pointer-events or the React re-render swallows the click, [2] will not
    // appear in the pinned section and the expect below times out.
    const thirdStar = extPage
      .locator(
        `tr:not(#oc-pilot-pinned-table-wrapper tr) .oc-pilot-star-wrap[data-star-path="${starPaths[2]}"], ` +
          `[role="row"]:not(#oc-pilot-pinned-table-wrapper [role="row"]) .oc-pilot-star-wrap[data-star-path="${starPaths[2]}"]`
      )
      .first();
    await thirdStar.scrollIntoViewIfNeeded();
    await thirdStar.click();

    // The click must have landed — [2] should now be pinned.
    await expect(
      extPage.locator(`#oc-pilot-pinned-table-wrapper a[href$="${starPaths[2]}"]`)
    ).toBeVisible({ timeout: 3_000 });
  });
});
