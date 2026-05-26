# OC Pilot

A Chrome extension that streamlines the OpenShift web console: auto-login,
clipboard-copy `oc login` token, force-delete pods, quick-jump buttons to
pod Terminal/Logs/Events, favourites with a pinned-section, persistent
column sort, SPA-style navigation, and more.

Optional self-hosted telemetry server collects anonymous usage counters
(no PII, no resource names, no cluster URLs) so you can see which features
are actually being used.

---

## Repo layout

```
oc-pilot/
├── extension/         Chrome extension — manifest, background SW, content
│                      scripts, popup, icons. No JS deps; pure browser code.
│
├── telemetry-server/  Optional FastAPI + MongoDB telemetry receiver, with a
│                      built-in React dashboard. Deploy via Docker or OCP.
│
├── tests/             Playwright E2E suite. Self-contained — own package.json
│                      and node_modules; run `npm test` from inside this folder.
│
├── scripts/           Build / install / icon utilities (PowerShell + Node).
│
├── build/             Generated CRX and deploy tarballs (gitignored).
│
├── docs/              Design docs (telemetry payload schema, etc.).
│
├── CHANGELOG.md       Per-release notes.
├── CLAUDE.md          Developer guide (build / test / changelog policy).
└── update.xml         Chrome auto-update manifest.
```

Each top-level folder owns its own dependencies — there is no shared
`node_modules/` at the project root. That's the principle: if it's
test-only, it lives in `tests/`; if it's server-only, it lives in
`telemetry-server/`.

---

## Quick start

### Use the extension

If you just want to install it in your browser, build the CRX and sideload it:

```powershell
.\scripts\build-crx.ps1               # → build\oc-pilot-<version>.crx
.\scripts\install-policy.ps1          # registers it via Chrome enterprise policy
```

For manual "Load unpacked" + feature reference, see [`extension/README.md`](./extension/README.md).

### Run the tests

```powershell
cd tests
npm install                           # one-time
npx playwright install chromium       # one-time
copy .env.example .env                # then set KUBEADMIN_PASSWORD
npm test                              # full suite
```

The suite targets a real OKD 4.16 console at `http://localhost:9000`
(override with `CONSOLE_URL` in `tests/.env`). It uses the live cluster
to exercise injected DOM, force-delete, favourites, SPA navigation, etc.

The test plan (feature × action × expected) is documented in
[`tests/TEST-PLAN.md`](./tests/TEST-PLAN.md).

### Deploy the telemetry server (optional)

```bash
cd telemetry-server
cp config.example.yaml config.yaml    # then paste real secrets
docker compose up -d
```

Full guide including OpenShift deployment, secret generation,
MongoDB tuning and Filebeat shipping: [`telemetry-server/README.md`](./telemetry-server/README.md).

Payload schema and event catalog: [`docs/telemetry.md`](./docs/telemetry.md).

### Build a pre-packaged deploy bundle

The build script `.\scripts\build-crx.ps1` produces a CRX. To package the
telemetry server as a single, ready-to-deploy `.tar.gz` (image + compose +
config template + migration script + docs), see the deploy procedure in
[`telemetry-server/README.md`](./telemetry-server/README.md).

---

## Scripts overview (`scripts/`)

| Script | Purpose |
|---|---|
| `build-crx.ps1` | Stage `extension/`, strip `t.config`, zip, sign with `oc-pilot.pem`, write `build/oc-pilot-<version>.crx`. |
| `crx-signer.js` | Node helper invoked by `build-crx.ps1`. Implements CRX3 packaging — RSA-sign and prepend the protobuf header. Not normally run standalone. |
| `install-policy.ps1` | Register the freshly built CRX via Chrome's `ExtensionInstallForcelist` policy (HKCU — no admin needed). Chrome picks it up on next launch. `-Uninstall` removes the policy. |
| `generate-icons.ps1` | Regenerate `extension/icons/icon-{16,48,128}.png` (red rounded-square logo) — only needed if you change the artwork. |

The signing key `oc-pilot.pem` lives one level above the repo root so it
is never accidentally committed.

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for the mandatory test-requirement rule
(every change to `extension/` ships with a Playwright test) and the
changelog format.

## License

Internal tooling — no public license. Treat as proprietary unless
explicitly told otherwise.
