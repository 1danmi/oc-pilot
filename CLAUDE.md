# OC Pilot — Developer Guide

## Repo layout

```
extension/         Chrome extension source (manifest.json, content scripts, popup, icons)
telemetry-server/  Self-hosted FastAPI server + React dashboard (optional, opt-in telemetry)
tests/             Playwright E2E suite (specs, fixtures, TEST-PLAN.md, .env)
scripts/           Build / install / icon-generation utilities
build/             Generated CRX and deploy tarballs (gitignored)
docs/              Design docs (telemetry schema, etc.)
```

Each top-level folder is self-contained: `tests/` has its own `package.json`
and `node_modules/`, `telemetry-server/` has its own Python `requirements.txt`
and the dashboard sub-folder has its own React `node_modules/`. The extension
itself has no JS dependencies.

## Test Requirement (mandatory)

**Every new feature or bug fix MUST include a Playwright test.**

Process for any change to `extension/`:

1. Update `tests/TEST-PLAN.md` — add a row (feature × starting state × action ×
   expected result) for the new behaviour, or extend an existing row.
2. Implement or extend the corresponding `tests/*.spec.ts` file.
3. Run `npm test` from `tests/` and confirm it is green before bumping
   the version or building a CRX.

Reviews reject changes that touch `extension/` without a corresponding test plan
update. This rule exists because the changelog (0.23.5–0.23.8 in particular)
shows that the favourites feature alone has shipped four regressions in
a single feature area; tests are the only way to keep that from recurring.

## Running tests

```powershell
cd oc-pilot/tests
npm install                         # one-time
npx playwright install chromium     # one-time
# Create .env with KUBEADMIN_PASSWORD=<password>  (see .env.example)
npm test                            # full suite
npm run test:headed                 # watch the browser as it runs
npm run test:ui                     # Playwright UI mode (interactive)
```

The suite targets the real OKD 4.16 console at `http://localhost:9000`.
Override with `CONSOLE_URL` in `tests/.env` if needed. Tests assume:

- A `kubeadmin` user with a working password
- Namespace `openshift-console` containing Deployment `downloads`
- Namespace `openshift-network-diagnostics` with enough pods that the list
  page is taller than the viewport (for SPA-navigation scroll-reset coverage)

## Authentication features (out of scope)

Auto-login and the copy-login-command flow are NOT covered by automated
tests. Both require cluster-external OAuth token endpoints that cannot
be reliably provisioned in a test environment. They must be exercised
manually before each release; document the manual steps in the PR
description if you change them.

## Build

```powershell
.\scripts\build-crx.ps1
```

Reads the version from `extension/manifest.json`, stages `extension/` in a
temp dir (deleting `t.config` so secrets are never bundled), zips, signs with
the `oc-pilot.pem` key, and writes `build/oc-pilot-<version>.crx`.

The CRX always lands in `build/`. Do not produce CRX files by zipping
`extension/` and renaming — that yields a ZIP, not a signed CRX3.

To install / upgrade the built CRX into the local Chrome via enterprise
policy: `.\scripts\install-policy.ps1`. To regenerate the icon PNGs:
`.\scripts\generate-icons.ps1`.

## Telemetry server

Optional, self-hosted. See `telemetry-server/README.md` and
`docs/telemetry.md` for the payload schema, MongoDB layout, and dashboard.

## Changelog

Update `CHANGELOG.md` for every release. Follow the existing format
(version, date, sections for bug fixes / new features, with a short
explanation of root cause for fixes).
