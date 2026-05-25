# OpenShift Auto-Login

Chrome extension that auto-selects the LDAP identity provider, fills your
username/password, and copies the `oc login --token=...` command to your
clipboard on OpenShift web consoles. Zero per-cluster configuration.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder (`oc-pilot/`).
4. Click the extension's details, then **Extension options** (or click the
   toolbar icon) and enter your LDAP credentials. Save.

## How it works

The content script is injected on any URL whose path matches `*/login*`,
`*/oauth/authorize*`, or `*/oauth/token/*`. Before doing anything it checks
that the page looks like an OpenShift oauth-server page (specific anchor
structure, form action, or token-command text). If it doesn't, the script
no-ops.

On a matching page a small banner appears top-right: **"Auto-logging in as
`<user>` in 2s"** with a **Cancel** button. Click Cancel to skip auto-action
on this tab for the rest of the session.

## What gets automated

- **Provider-select page** — clicks the `ldap-provider` tile.
- **Credentials form** — fills username + password, submits (unless
  "Auto-submit" is off in options).
- **Copy Login Command** — when you click Copy Login Command in the console's
  user dropdown, the extension clicks "Display Token" on the token-request
  page, then copies the full `oc login --token=... --server=...` line to
  your clipboard. A green toast confirms.

## Options

- **Identity provider name** — defaults to `ldap-provider`. Change if a
  cluster uses a different IDP name (e.g. `ldap`).
- **Auto-submit credentials** — on by default. Turn off if you want the form
  filled but not submitted.
- **Auto-copy `oc login` command** — on by default.

## Troubleshooting

- **Nothing happens on a cluster.** Open DevTools on the failing page and copy
  `document.documentElement.outerHTML`. The selectors may need to be tightened
  for that cluster's OCP version or IDP name.
- **Clipboard copy failed.** Chrome requires user activation for clipboard
  writes. The extension falls back to an offscreen document with
  `execCommand('copy')`; on very old Chrome versions this may be unavailable
  — use Ctrl+C on the highlighted command on the display page.
- **Credentials stored in plain text.** `chrome.storage.local` writes to disk
  without encryption. This is a dev convenience, not a password manager.

## Files

- `manifest.json` — MV3 manifest, permissions, content-script matches.
- `content.js` — page router, the four handlers, cancel banner, toast.
- `options.html` / `options.js` — config UI.
- `background.js` — service worker; opens options on action click, drives the
  offscreen clipboard fallback.
- `offscreen.html` / `offscreen.js` — clipboard-write helper document.
