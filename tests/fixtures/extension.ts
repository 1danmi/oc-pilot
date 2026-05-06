/**
 * Playwright fixture that launches a persistent browser context with the
 * OC Pilot extension loaded.
 *
 * Three fixtures are provided:
 *   context      — BrowserContext with the extension active
 *   extensionId  — The extension's ID (extracted from its service worker URL)
 *   extPage      — A new Page inside that context, ready to navigate
 *
 * Auth cookies from .auth-state.json (written by globalSetup) are applied to
 * the context before each test, so navigation to the OKD console is
 * automatically authenticated.
 */

import { test as base, chromium, BrowserContext, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

type ExtFixtures = {
  context: BrowserContext;
  extensionId: string;
  extPage: Page;
};

export const test = base.extend<ExtFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    // Use a fresh temp profile dir for each test so there is no bleed between
    // tests via persisted extension storage (each test sets its own state).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pilot-test-'));
    // Load the extension straight from src/ — the same files pack.ps1 zips
    // into the production CRX. Avoids the failure mode where a hand-maintained
    // dist/ silently drifts behind src/ and tests exercise stale code.
    const extPath = path.resolve(__dirname, '../../src');

    const ctx = await chromium.launchPersistentContext(tmpDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        // Suppress the "Chrome is being controlled by automated software" banner
        '--disable-infobars',
      ],
    });

    // Apply kubeadmin session cookies so the console is already authenticated.
    const authStatePath = path.resolve(__dirname, '../../.auth-state.json');
    try {
      const authState = JSON.parse(fs.readFileSync(authStatePath, 'utf-8'));
      if (authState.cookies?.length) {
        await ctx.addCookies(authState.cookies);
      }
    } catch (err) {
      console.warn('[extension fixture] Could not apply auth cookies:', err);
    }

    await use(ctx);

    await ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    // The background service worker URL is chrome-extension://<id>/background.js
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    const id = new URL(sw.url()).hostname;
    await use(id);
  },

  extPage: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    // page is closed when context closes — no need to close explicitly
  },
});

export { expect } from '@playwright/test';
