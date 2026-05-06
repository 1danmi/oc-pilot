/**
 * Helpers for reading and writing OC Pilot chrome.storage.local data from
 * inside Playwright tests.
 *
 * The extension's content scripts run in an isolated world, so the page world
 * (page.evaluate) does NOT have access to chrome.* APIs.  Instead we call
 * evaluate() on the background service worker, which runs in the extension
 * world and has full chrome.storage.local access.
 *
 * All helpers throw if no service worker is found, so tests fail loudly when
 * the extension hasn't loaded yet.
 */

import { BrowserContext } from '@playwright/test';

const STORAGE_KEY = 'openshiftAutoLogin';
const FAVOURITES_KEY = 'ocPilotFavourites';
const COLOURS_KEY = 'ocPilotClusterColours';

/** Resolve the extension's background service worker (throws if not found). */
function getSW(context: BrowserContext) {
  const sws = context.serviceWorkers();
  if (!sws.length) {
    throw new Error(
      'Extension service worker not found. Is the extension loaded from src/?'
    );
  }
  return sws[0];
}

/**
 * Merge feature flag overrides into the extension's feature storage.
 * Keys not specified in `overrides` are left untouched.
 *
 * Example:
 *   await setFeatures(context, { podTerminal: false, podImageTag: true });
 */
export async function setFeatures(
  context: BrowserContext,
  overrides: Record<string, boolean>
) {
  const sw = getSW(context);
  await sw.evaluate(
    ({ key, overrides }) => {
      return new Promise<void>((resolve) => {
        chrome.storage.local.get(key, (data: Record<string, unknown>) => {
          const existing = (data[key] as Record<string, unknown>) || {};
          const existingFeatures = (existing['features'] as Record<string, boolean>) || {};
          const merged = {
            ...existing,
            features: { ...existingFeatures, ...overrides },
          };
          chrome.storage.local.set({ [key]: merged }, () => resolve());
        });
      });
    },
    { key: STORAGE_KEY, overrides }
  );
}

/**
 * Read the current feature flags from storage.
 * Returns the raw features object (empty object if nothing stored yet).
 */
export async function getFeatures(context: BrowserContext): Promise<Record<string, boolean>> {
  const sw = getSW(context);
  return sw.evaluate((key) => {
    return new Promise<Record<string, boolean>>((resolve) => {
      chrome.storage.local.get(key, (data: Record<string, unknown>) => {
        const existing = (data[key] as Record<string, unknown>) || {};
        resolve((existing['features'] as Record<string, boolean>) || {});
      });
    });
  }, STORAGE_KEY);
}

/**
 * The extension stores favourites in a 4-level structure:
 *   { [hostname]: { [namespace]: { [kind]: string[] } } }
 * (see src/content-console.js, around the "Resource Favourites" section).
 *
 * Tests reference favourites with a flat "<ns>/<kind>" key for ergonomics, so
 * we translate at the fixture boundary. The hostname is taken from
 * CONSOLE_URL (defaulting to localhost) so the same shape the extension
 * itself reads/writes is what lands in chrome.storage.local.
 */
function consoleHostname(): string {
  const url = process.env.CONSOLE_URL || 'http://localhost:9000';
  return new URL(url).hostname;
}

type FlatFavs = Record<string, string[]>; // "<ns>/<kind>" → names
type NestedFavs = Record<string, Record<string, Record<string, string[]>>>;

function flatToNested(host: string, flat: FlatFavs): NestedFavs {
  const nested: NestedFavs = {};
  for (const [k, names] of Object.entries(flat)) {
    if (!names || names.length === 0) continue;
    const slash = k.indexOf('/');
    if (slash === -1) {
      throw new Error(`setFavourites: key "${k}" must be "<namespace>/<kind>"`);
    }
    const ns = k.slice(0, slash);
    const kind = k.slice(slash + 1);
    if (!nested[host]) nested[host] = {};
    if (!nested[host][ns]) nested[host][ns] = {};
    nested[host][ns][kind] = [...names];
  }
  return nested;
}

function nestedToFlat(host: string, nested: NestedFavs): FlatFavs {
  const flat: FlatFavs = {};
  const byNs = nested[host] || {};
  for (const [ns, byKind] of Object.entries(byNs)) {
    for (const [kind, names] of Object.entries(byKind)) {
      flat[`${ns}/${kind}`] = [...names];
    }
  }
  return flat;
}

/**
 * Overwrite the favourites map for the current hostname.
 * Pass an empty object {} to clear all favourites for this host.
 *
 * Caller-facing shape: { "<namespace>/<kind>": ["name1", "name2"] }
 * Storage shape (auto-translated): { [hostname]: { [ns]: { [kind]: [names] } } }
 */
export async function setFavourites(
  context: BrowserContext,
  favs: FlatFavs
) {
  const sw = getSW(context);
  const host = consoleHostname();
  const nested = flatToNested(host, favs);
  await sw.evaluate(
    ({ key, host, nested }) => {
      return new Promise<void>((resolve) => {
        // Replace this host's entry so test setups are deterministic, while
        // leaving any other-host entries alone.
        chrome.storage.local.get(key, (data: Record<string, unknown>) => {
          const existing = (data[key] as Record<string, unknown>) || {};
          const merged: Record<string, unknown> = { ...existing };
          if (nested[host]) {
            merged[host] = nested[host];
          } else {
            delete merged[host];
          }
          chrome.storage.local.set({ [key]: merged }, () => resolve());
        });
      });
    },
    { key: FAVOURITES_KEY, host, nested }
  );
}

/**
 * Read the current favourites for this hostname, flattened to "<ns>/<kind>" keys.
 * Tests assert against this flattened shape via constants like
 *   const KIND_KEY = `${NS}/deployments`
 */
export async function getFavourites(
  context: BrowserContext
): Promise<FlatFavs> {
  const sw = getSW(context);
  const host = consoleHostname();
  const nested = await sw.evaluate(
    ({ key }): Promise<NestedFavs> => {
      return new Promise<NestedFavs>((resolve) => {
        chrome.storage.local.get(key, (data: Record<string, unknown>) => {
          resolve((data[key] as NestedFavs) || {});
        });
      });
    },
    { key: FAVOURITES_KEY }
  );
  return nestedToFlat(host, nested);
}

/**
 * Set a cluster colour for a given hostname.
 * Pass an empty string for `colour` to remove the entry (revert to default).
 */
export async function setClusterColour(
  context: BrowserContext,
  hostname: string,
  colour: string
) {
  const sw = getSW(context);
  await sw.evaluate(
    ({ key, hostname, colour }) => {
      return new Promise<void>((resolve) => {
        chrome.storage.local.get(key, (data: Record<string, unknown>) => {
          const map = { ...((data[key] as Record<string, string>) || {}) };
          if (colour) {
            map[hostname] = colour;
          } else {
            delete map[hostname];
          }
          chrome.storage.local.set({ [key]: map }, () => resolve());
        });
      });
    },
    { key: COLOURS_KEY, hostname, colour }
  );
}

/**
 * Read the current cluster colour for a hostname (null = default).
 */
export async function getClusterColour(
  context: BrowserContext,
  hostname: string
): Promise<string | null> {
  const sw = getSW(context);
  return sw.evaluate(
    ({ key, hostname }) => {
      return new Promise<string | null>((resolve) => {
        chrome.storage.local.get(key, (data: Record<string, unknown>) => {
          const map = (data[key] as Record<string, string>) || {};
          resolve(map[hostname] || null);
        });
      });
    },
    { key: COLOURS_KEY, hostname }
  );
}

/**
 * Wipe all OC Pilot storage keys — useful in beforeEach to start from a
 * known clean state.
 */
export async function clearAllStorage(context: BrowserContext) {
  const sw = getSW(context);
  await sw.evaluate(({ keys }) => {
    return new Promise<void>((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }, { keys: [STORAGE_KEY, FAVOURITES_KEY, COLOURS_KEY] });
}
