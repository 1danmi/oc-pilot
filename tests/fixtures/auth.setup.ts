/**
 * Global setup — runs once before all tests.
 *
 * Logs into the OKD console as kubeadmin (without the extension, to avoid
 * interference) and saves the session cookies to .auth-state.json.  All
 * test fixtures then apply those cookies to the extension's persistent
 * context so tests begin authenticated.
 *
 * Credentials come from tests/.env:
 *   CONSOLE_URL=http://localhost:9000
 *   KUBEADMIN_PASSWORD=<password>
 */

import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';

export default async function globalSetup(_config: FullConfig) {
  const consoleUrl = process.env.CONSOLE_URL || 'http://localhost:9000';
  const password = process.env.KUBEADMIN_PASSWORD;

  if (!password) {
    throw new Error(
      'KUBEADMIN_PASSWORD is not set. Create tests/.env with KUBEADMIN_PASSWORD=<value>.'
    );
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(consoleUrl, { waitUntil: 'domcontentloaded' });

  // The console may behave in one of two ways:
  //   1. OKD 4.21+ / production clusters: render an OAuth login page that
  //      requires kubeadmin credentials. The page may have an identity-provider
  //      picker first, then a username/password form.
  //   2. OKD 4.16 / local CRC dev clusters: no login page at all — the SPA
  //      auto-authenticates and routes straight to the main console.
  // Wait for whichever happens first and branch accordingly.
  const postLoginUrl = /\/k8s\/cluster\/projects|\/k8s\/all-namespaces/;
  const sawAuthedUrl = page
    .waitForURL(postLoginUrl, { timeout: 60_000 })
    .then(() => 'authed' as const)
    .catch(() => null);
  const sawLoginForm = page
    .waitForSelector('input[name="username"]', { timeout: 60_000 })
    .then(() => 'login' as const)
    .catch(() => null);
  const which = await Promise.race([sawAuthedUrl, sawLoginForm]);

  if (!which) {
    throw new Error(
      `Console at ${consoleUrl} did not show a login form or land on a post-login URL within 60s. ` +
        `Final URL: ${page.url()}`
    );
  }

  if (which === 'login') {
    // OKD login page: there may be an identity-provider selection step first.
    // The "htpasswd" / "kube:admin" provider button has no fixed selector, but
    // kubeadmin is always reachable via the htpasswd-provider link if present.
    const idpLink = page.locator('a', { hasText: /kubeadmin|htpasswd/i }).first();
    if (await idpLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await idpLink.click();
    }

    await page.fill('input[name="username"]', 'kubeadmin');
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // Wait until we land on the main console page
    await page.waitForURL(postLoginUrl, { timeout: 20_000 });
  } else {
    console.log('[auth.setup] Console did not require login (auto-authenticated).');
  }

  const authStatePath = path.resolve(__dirname, '../.auth-state.json');
  await page.context().storageState({ path: authStatePath });

  await browser.close();
  console.log('[auth.setup] Saved auth state to', authStatePath);
}
