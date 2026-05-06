# OC Pilot — Developer Guide

## Test Requirement (mandatory)

**Every new feature or bug fix MUST include a Playwright test.**

Process for any change to `src/`:

1. Update `tests/TEST-PLAN.md` — add a row (feature × starting state × action ×
   expected result) for the new behaviour, or extend an existing row.
2. Implement or extend the corresponding `tests/*.spec.ts` file.
3. Run `npm test` from the `oc-pilot/` directory and confirm it is green
   before bumping the version or building a CRX.

Reviews reject changes that touch `src/` without a corresponding test plan
update. This rule exists because the changelog (0.23.5–0.23.8 in particular)
shows that the favourites feature alone has shipped four regressions in
a single feature area; tests are the only way to keep that from recurring.

## Running tests

```powershell
cd oc-pilot
npm install                         # one-time
npx playwright install chromium     # one-time
# Create tests/.env with KUBEADMIN_PASSWORD=<password>
npm test                            # full suite
npm run test:headed                 # watch the browser as it runs
npm run test:ui                     # Playwright UI mode (interactive)
```

The suite targets the real OKD 4.16 console at `http://localhost:9000`.
Override with `CONSOLE_URL` in `tests/.env` if needed. Tests assume:

- A `kubeadmin` user with a working password
- Namespace `openshift-console` containing Deployment `downloads`
- Namespace `openshift-monitoring` containing 30+ pods (for virtualized
  table regression coverage)

## Authentication features (out of scope)

Auto-login and the copy-login-command flow are NOT covered by automated
tests. Both require cluster-external OAuth token endpoints that cannot
be reliably provisioned in a test environment. They must be exercised
manually before each release; document the manual steps in the PR
description if you change them.

## Build

```powershell
.\pack.ps1            # builds dist/ and build/oc-pilot-x.y.z.crx
```

The CRX always lands in `build/`. Do not produce CRX files by zipping
`dist/` and renaming — that yields a ZIP, not a signed CRX3.

## Changelog

Update `CHANGELOG.md` for every release. Follow the existing format
(version, date, sections for bug fixes / new features, with a short
explanation of root cause for fixes).
