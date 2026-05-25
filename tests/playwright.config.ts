import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  globalSetup: './fixtures/auth.setup.ts',
  testDir: '.',
  // Keep ephemeral test artefacts (traces, screenshots, .last-run.json)
  // colocated with the tests instead of polluting the project root.
  outputDir: './results',
  // Each test gets its own launchPersistentContext (fresh tmpDir), so tests
  // are fully isolated — no shared chrome.storage.local, no shared cookies.
  // The OKD cluster is read-only from the tests' perspective.
  // NOTE: headless:false (required for extensions) spawns visible Chrome
  // windows. Keep workers low to avoid overloading the local OKD console.
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.CONSOLE_URL || 'http://localhost:9000',
    // Note: storageState is NOT set here because all specs use the extension
    // fixture (launchPersistentContext), which applies auth cookies manually.
    // Setting storageState here would only affect regular browser.newContext().
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'oc-pilot' },
  ],
});
