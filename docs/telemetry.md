# OC Pilot — Telemetry

Self-hosted, privacy-first usage analytics for the OC Pilot Chrome extension.
Gives you aggregated counts of who is using the extension and which features
they use — without collecting any PII, cluster URLs, or resource names.

---

## Table of contents

1. [What is collected](#1-what-is-collected)
2. [What is never collected](#2-what-is-never-collected)
3. [Architecture](#3-architecture)
4. [Event catalog](#4-event-catalog)
5. [Data model](#5-data-model)
6. [API reference](#6-api-reference)
7. [Configuration](#7-configuration)
8. [Deployment](#8-deployment)
   - [MongoDB server](#81-mongodb-server)
   - [Telemetry server](#82-telemetry-server)
   - [Extension](#83-extension)
9. [Dashboard](#9-dashboard)
10. [Developer settings](#10-developer-settings)
11. [Structured logs](#11-structured-logs)
12. [Operations](#12-operations)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. What is collected

Every installed extension sends one POST per hour (plus one on install and one
on update) to the telemetry server. The POST body contains:

```jsonc
{
  "machineId":        "uuid-v4",          // stable per-(Chrome profile, machine slot); survives uninstall/reinstall when Chrome sync is on
  "installId":        "uuid-v4",          // per-install; rotates on every (re)install
  "userHash":         "sha256-hex",       // SHA-256("oc-pilot:" + username.toLowerCase()), or null
  "version":          "0.27.1",           // from manifest.json
  "periodStart":      1700000000,         // unix seconds — start of the counting window
  "periodEnd":        1700003600,         // unix seconds — end of the counting window
  "counters":         { "click.podTerminal": 5, "click.favourites.add": 3 },
  "isInstall":        false,
  "isUpdate":         false,
  "previousVersion":  null
}
```

**`machineId`** is a random UUID generated once and stored in
`chrome.storage.sync["ocPilotMachineId"]`. Chrome sync replicates that value
across uninstall + reinstall on the same Chrome profile, so the value
survives a reinstall on any user signed in to Chrome sync. If Chrome sync
is disabled, the UUID is generated fresh per install (same caveat as
`installId` for those users — uniqueness wins over reinstall-stability,
because the previous deterministic-fingerprint approach silently collided
across identical corporate hardware).

> **History.** v0.27.0 used a deterministic SHA-256 of navigator properties
> (`platform`, `hardwareConcurrency`, `deviceMemory`, `languages`). That
> hash collided for users on identical corporate laptops (one real install
> reported 7 unique users on only 5 unique machines because two pairs of
> engineers were sharing a fingerprint). v0.27.1 replaces it with a random
> UUID and auto-migrates any 64-char hex value found in storage on the
> next telemetry send.

**`installId`** is a UUIDv4 generated once on first install and stored in
`chrome.storage.local`. It rotates on every reinstall (because local storage
is wiped). It is used to count distinct installs — the gap between
`unique_machines` and `unique_installs` reflects reinstall churn on the same
hardware.

**`userHash`** is a one-way SHA-256 of `"oc-pilot:" + username.toLowerCase()`.
The salt is fixed and intentional — the same user on two different machines
produces the same hash, so the server can count distinct users without storing
the username. The hash is one-way and no PII is transmitted.

**`counters`** is a flat map of `{eventName: integer}` accumulated since the
last successful send. See [Event catalog](#4-event-catalog) for all event
names.

---

## 2. What is never collected

- Usernames in plaintext
- Passwords or tokens
- Cluster URLs, hostnames, or IP addresses
- Namespace names, resource names, or any Kubernetes resource content
- Browser history or cookies
- The client's IP address (the server receives it but explicitly does **not**
  store it — the document has `client_ip: null`)

---

## 3. Architecture

```
Chrome extension (extension/)
  └── background.js
        ├── chrome.alarms  → fires every N minutes (default 60)
        ├── bumpCounter()  → increments counters in chrome.storage.local
        └── sendTelemetry() → POST /v1/telemetry

Telemetry server (telemetry-server/)
  ├── app.py (FastAPI + PyMongo AsyncClient)
  │     ├── POST /v1/telemetry  → insert doc → JSON log line
  │     ├── GET  /v1/stats      → $group aggregation
  │     ├── GET  /v1/stats/timeseries
  │     ├── GET  /healthz
  │     └── GET  /             → serves built React dashboard
  └── dashboard/ (React 18 + Vite + Recharts)
        ├── StatCard        — top-line numbers
        ├── EventBarChart   — per-event counts grouped by category
        ├── ActivityLineChart — 30-day daily timeseries
        └── VersionPie      — extension version distribution

MongoDB (separate VM recommended)
  └── collection: events  (append-only, one doc per POST)
```

**Stack:** Python 3.12, FastAPI, PyMongo 4.9+ (`AsyncMongoClient`), Uvicorn,
python-json-logger, React 18, TypeScript, Vite, Recharts.

---

## 4. Event catalog

All events are accumulated in `chrome.storage.local` and sent in the next
hourly POST. Names follow the `category.subject[.qualifier]` convention.

### `click.*` — feature engagement (content-console.js)

| Event | Trigger |
|---|---|
| `click.ownerLink` | Click on the injected "→ Deployment / DC / StatefulSet" button on a pod page |
| `click.podTerminal` | Click the Terminal link in a pod row |
| `click.podLogs` | Click the Logs link in a pod row |
| `click.podEvents` | Click the Events link in a pod row |
| `click.forceDelete` | Click Force Delete (list row or pod detail) |
| `click.crossLinks.routeToBackend` | Click the injected "→ Deployment" pill on a Route page |
| `click.crossLinks.deploymentToRoute` | Click the injected "→ Route" pill on a Deployment page |
| `click.crossLinks.deploymentToRouteUrl` | Click a direct `https://<route-host>` link in the Deployment panel |
| `click.clickToCopy` | Click a resource name to copy it |
| `click.copyLoginCmd` | Click the "Copy Login" header button |
| `click.favourites.add` | Click an empty star to favourite a resource |
| `click.favourites.remove` | Click a filled star to un-favourite |

### `inject.*` — passive feature activations

| Event | Trigger |
|---|---|
| `inject.podImageTag` | Extension resolved and rendered an image-version badge for a pod |

### `autologin.*` / `copylogin.*` — OAuth automation (content.js / background.js)

| Event | Trigger |
|---|---|
| `autologin.providerSelected` | Auto-clicked the LDAP provider tile |
| `autologin.executed` | Auto-filled username/password and submitted the form |
| `autologin.bannerCancelled` | User clicked Cancel on the auto-login banner |
| `copylogin.completed` | Full copy-login-command flow succeeded; clipboard got the `oc login` line |
| `copylogin.failed` | Copy-login flow failed (timeout, page mismatch, or clipboard error) |

### `popup.*` / `settings.*` — popup & settings tab (popup.js)

| Event | Trigger |
|---|---|
| `popup.opened` | User clicks the toolbar icon and the popup loads |
| `settings.tabOpened` | User opens the full settings tab |
| `settings.credentialsSaved` | User clicks Save in the credentials form |
| `settings.featureToggled.<name>.on` | A feature flag is turned ON |
| `settings.featureToggled.<name>.off` | A feature flag is turned OFF |
| `settings.override.added` | User adds a per-host credential override |
| `settings.override.removed` | User removes a per-host credential override |
| `settings.colour.set` | User sets a cluster colour |
| `settings.colour.cleared` | User clears a cluster colour |

`<name>` is the literal flag name from the `FEATURES` object
(e.g. `settings.featureToggled.podTerminal.off`).

### `lifecycle.*` — extension state changes (background.js)

| Event | Trigger |
|---|---|
| `lifecycle.installed` | `chrome.runtime.onInstalled` with `reason === "install"` — also triggers an immediate POST |
| `lifecycle.updated` | Same handler, `reason === "update"` — also triggers an immediate POST |
| `lifecycle.startup` | `chrome.runtime.onStartup` fires (browser launch) — counter only |

---

## 5. Data model

### MongoDB document (one per POST, append-only)

```js
{
  _id:              ObjectId,
  machine_id:       "uuid-v4",         // stable per-(Chrome profile, machine slot); v0.27.0 used a 64-char SHA-256 hex hash that v0.27.1 replaces with a random UUID + migrates legacy values
  install_id:       "uuid-v4",         // per-install (v0.26.6+)
  user_hash:        "sha256-hex" | null,
  version:          "0.27.0",
  period_start:     1700000000,        // unix sec
  period_end:       1700003600,        // unix sec
  counters:         { "click.podTerminal": 5, ... },
  is_install:       false,
  is_update:        false,
  previous_version: null | "0.26.5",
  received_at:      ISODate(...),      // server insertion time
  client_ip:        null               // intentionally not stored
}
```

> Note: pre-v0.27.0 rows in MongoDB only have `machine_id` populated (no
> `install_id`). The `unique_installs` aggregations use `$ifNull` / `$cond` to
> skip those rows so historical data isn't counted incorrectly.

The collection is **append-only** — the server never updates or deletes
documents. Every `/v1/stats` call re-aggregates by summing counters across all
documents. This is what makes the 30-day activity timeseries possible.

### Indexes

| Index | Purpose |
|---|---|
| `{ machine_id: 1 }` | All docs for a machine |
| `{ install_id: 1 }` | All docs for a single install (added in v0.27.0) |
| `{ user_hash: 1 }` sparse | Count distinct users (skips null hashes) |
| `{ received_at: -1 }` | Active-window and timeseries queries |
| `{ machine_id: 1, received_at: -1 }` | Most recent docs for a machine |
| `{ version: 1 }` | Version distribution grouping |
| `{ is_install: 1, received_at: -1 }` partial (`is_install: true`) | Install counts |
| `{ is_update: 1, received_at: -1 }` partial (`is_update: true`) | Update counts |

All indexes are created idempotently on startup via `createIndexes()`.

### Storage estimates

Each document is ~500 B raw; WiredTiger snappy compression halves that.

| Machines | Docs/year | Disk/year |
|---:|---:|---:|
| 50 | 440 K | ~110 MB |
| 500 | 4.4 M | ~1.1 GB |
| 5 000 | 44 M | ~11 GB |

Add a TTL index if needed:
```js
db.events.createIndex(
  { received_at: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 * 2 }  // 2 years
)
```

---

## 6. API reference

### `POST /v1/telemetry`

**Auth:** `Authorization: Bearer <telemetry_token>`

Inserts one document and emits one JSON log line. Returns `204 No Content` on
success, `401` on bad/missing bearer, `422` on invalid body.

### `GET /v1/stats`

**Auth:** HTTP basic (`stats_username` / `stats_password`)

Returns aggregated all-time and active-window statistics:

```jsonc
{
  "unique_machines":        42,                                      // stable per-machine (since v0.27.0)
  "unique_installs":        58,                                      // per-install — gap vs. unique_machines = reinstall churn
  "unique_users":           17,
  "active_machines_1h":      9,
  "active_machines_24h":    19,
  "active_machines_7d":     33,
  "per_event_total":        { "click.podTerminal": 1830, ... },
  "per_event_avg_per_user": { "click.podTerminal": 107.6, ... },
  "version_distribution":   { "0.27.0": 30, "0.26.5": 12 },
  "installs_total":         45,
  "updates_total":          128,
  "last_event_received_at": 1700003600
}
```

### `GET /v1/stats/timeseries?days=N`

**Auth:** HTTP basic

Returns daily bucketed counts for the last N days (default 30, max 365):

```jsonc
[
  {
    "date":                   "2026-05-19",
    "unique_machines_seen":   12,                                    // stable machines on this day
    "unique_installs_seen":   14,                                    // installs on this day (machines + reinstalls)
    "unique_users_seen":       8,
    "events_count":          347,
    "install_count":           2,
    "update_count":            5
  },
  ...
]
```

### `GET /healthz`

**Auth:** None. Returns `{"ok": true}` if MongoDB ping succeeds. Use for
Docker/k8s health probes.

### `GET /docs` / `GET /redoc`

**Auth:** None. Swagger UI and ReDoc — interactive API documentation
auto-generated by FastAPI.

### `GET /`

**Auth:** HTTP basic. Serves the React dashboard.

---

## 7. Configuration

The server reads a YAML file. Path defaults to
`/etc/oc-pilot-telemetry/config.yaml`; override with the
`OC_PILOT_TELEMETRY_CONFIG` environment variable.

The server **refuses to start** if the file is missing, unparseable, or
contains any `REPLACE-ME` placeholder.

```yaml
server:
  host: "0.0.0.0"
  port: 8080

auth:
  telemetry_token: "REPLACE-ME-with-32-char-random"  # baked into the extension
  stats_username:  "admin"
  stats_password:  "REPLACE-ME"

mongodb:
  uri:             "mongodb://user:pass@<mongo-host>:27017/?authSource=admin"
  database:        "oc_pilot_telemetry"
  collection:      "events"
  max_pool_size:   20

logging:
  level: "INFO"
  json_file:
    path:         "/var/log/oc-pilot-telemetry/events.log"
    max_bytes:    104857600   # 100 MB per file
    backup_count: 10          # → 1 GB max retained
```

**Generating secrets:**

```bash
# Linux / macOS
openssl rand -hex 32   # telemetry_token
openssl rand -hex 16   # stats_password
```

```powershell
# Windows PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Min 0 -Max 256) })
```

---

## 8. Deployment

The recommended setup uses **two separate VMs** — one for MongoDB and one for
the telemetry server. Both run Docker.

> **Port note:** Chrome blocks several ports as "unsafe" (6665–6669, 6697,
> and others). Do not expose the telemetry server on any of those ports.
> Safe choices: 7070, 8888, 9090.

### 8.1 MongoDB server

The MongoDB VM runs a single `mongo:7` container with authentication enabled.
Data is stored in a named Docker volume.

**Files needed on the MongoDB VM:**

```
docker-compose.yml
.env
```

**`docker-compose.yml`:**

```yaml
services:
  mongo:
    image: mongo:7
    restart: unless-stopped
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: "${MONGO_USER:-ocpilot}"
      MONGO_INITDB_ROOT_PASSWORD: "${MONGO_PASSWORD}"
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

**`.env`:**

```bash
MONGO_PASSWORD=your-strong-password-here
# MONGO_USER=ocpilot   # optional, default is ocpilot
```

**Start:**

```bash
docker load -i mongo.image.tar   # if transferring offline
docker compose up -d
docker compose logs mongo         # look for "Waiting for connections"
```

**Firewall:** open TCP 27017 inbound, restricted to the telemetry server IP only:

```bash
# firewalld example
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<telemetry-ip>/32 port port=27017 protocol=tcp accept'
firewall-cmd --reload
```

---

### 8.2 Telemetry server

**Files needed on the telemetry VM:**

```
docker-compose.yml
config.yaml          ← copy from config.example.yaml and fill in
logs/                ← create this directory
oc-pilot-telemetry.image.tar   ← if transferring offline
```

**`docker-compose.yml`:**

```yaml
services:
  server:
    image: oc-pilot-telemetry:local
    restart: unless-stopped
    ports:
      - "7070:8080"     # or whichever safe port you chose
    volumes:
      - ./config.yaml:/etc/oc-pilot-telemetry/config.yaml:ro
      - ./logs:/var/log/oc-pilot-telemetry
```

**`config.yaml`** (fill in your values):

```yaml
server:
  host: "0.0.0.0"
  port: 8080

auth:
  telemetry_token: "<generated 32-char hex>"
  stats_username:  "admin"
  stats_password:  "<generated password>"

mongodb:
  uri: "mongodb://ocpilot:<mongo-password>@<mongo-vm-ip>:27017/?authSource=admin"
  database: "oc_pilot_telemetry"
  collection: "events"

logging:
  level: "INFO"
  json_file:
    path: "/var/log/oc-pilot-telemetry/events.log"
    max_bytes: 104857600
    backup_count: 10
```

**Start:**

```bash
docker load -i oc-pilot-telemetry.image.tar
mkdir -p logs
docker compose up -d

# verify
curl http://localhost:7070/healthz
# → {"ok":true}

curl -u admin:<stats_password> http://localhost:7070/v1/stats
# → empty stats JSON

# open http://<telemetry-vm-ip>:7070/ in Chrome → log in → dashboard
```

---

### 8.3 Extension

Before packing the CRX, set these three constants at the top of
`extension/background.js`:

```js
const DEFAULT_TELEMETRY_URL          = "http://<telemetry-vm-ip>:7070/v1/telemetry";
const DEFAULT_TELEMETRY_TOKEN        = "<same-token-as-config.yaml auth.telemetry_token>";
const TELEMETRY_PERIOD_HOURS         = 1;   // how often to send (hours)
```

Then bump the version in `extension/manifest.json` and run `.\scripts\build-crx.ps1`.

On first load, the extension fires `lifecycle.installed` and sends an
immediate POST — you should see `unique_machines: 1` in `/v1/stats` within
seconds.

---

## 9. Dashboard

The dashboard is a React SPA served at `/` (same port as the API, basic auth
required). It auto-refreshes every 30 seconds.

### Panels

| Panel | Data source | What it shows |
|---|---|---|
| **Top-line cards** | `/v1/stats` | Unique machines, unique users, active machines (1 h / 24 h / 7 d), total installs, total updates, last event received |
| **Events by type** | `/v1/stats` | One horizontal bar chart per event category (click, settings, popup, autologin, copylogin, inject, lifecycle). Y-axis is the event name (prefix stripped), X-axis is the total count. Hover shows total + per-user average. |
| **30-day activity** | `/v1/stats/timeseries?days=30` | Line chart with three series: unique machines/day, unique users/day, total events/day |
| **Version distribution** | `/v1/stats` | Pie chart of extension versions currently seen |

### Dashboard development (without rebuilding the container)

```bash
cd telemetry-server/dashboard
npm install       # one-time
npm run dev       # Vite at http://localhost:5173, proxies /v1/* to localhost:8080
```

---

## 10. Developer settings

The extension settings tab contains a hidden **Developer settings** section,
accessible only via an easter egg so regular users never see it.

**To unlock:** click the OC Pilot header icon **5 times** within 3 seconds.
A green toast notification "🛠 Developer settings enabled" appears and the
section slides into view.

### What it shows

| Field | Description |
|---|---|
| Machine ID | First 8 chars of the stable per-machine ID (survives uninstall/reinstall) |
| Install ID | First 8 chars of the per-install UUID (rotates on every install) |
| Server address | The effective telemetry endpoint (build-time default) |
| Events since last send | Live count of buffered counters (refreshes every 2 s) |
| Last successful send | Relative time of the last accepted POST |
| Send interval | Configurable minutes between sends (default 60). Changes take effect immediately — the alarm is rescheduled. |
| Next scheduled send | When the next alarm will fire |
| Send telemetry now | Immediately flushes buffered counters to the server. Shows green on success, red with error message on failure. |

This section is the primary tool for verifying end-to-end telemetry without
waiting an hour.

---

## 11. Structured logs

Every `/v1/telemetry` POST produces one JSON log line (written to the rotating
file **and** stderr):

```json
{
  "timestamp":        "2026-05-19T10:00:01.234Z",
  "level":            "INFO",
  "logger":           "oc-pilot-telemetry",
  "event":            "telemetry_received",
  "machine_id":       "sha256-hex",
  "install_id":       "uuid",
  "user_hash":        "sha256-hex or null",
  "version":          "0.27.0",
  "period_start":     1700000000,
  "period_end":       1700003600,
  "period_seconds":   3600,
  "is_install":       false,
  "is_update":        false,
  "previous_version": null,
  "counters":         { "click.podTerminal": 5 },
  "counter_sum":      5,
  "ip":               "10.0.0.42"
}
```

Other event types in the same stream:

| `event` value | When |
|---|---|
| `startup` | App boot (includes `mongo_ok` field) |
| `telemetry_received` | Every accepted POST |
| `lifecycle_install` | Extra line when `is_install: true` |
| `lifecycle_update` | Extra line when `is_update: true` |
| `auth_failed` | Bad bearer or basic auth (includes IP + endpoint) |
| `validation_failed` | Body failed Pydantic validation (includes reason) |
| `insert_failed` | MongoDB write error |
| `stats_failed` | MongoDB aggregation error |
| `stats_viewed` | Dashboard or `/v1/stats` hit |

Logs rotate at 100 MB, keeping 10 files (≈ 1 GB total). Configure
`logging.json_file.max_bytes` and `backup_count` in `config.yaml`.

### Filebeat snippet (for future Elasticsearch shipping)

```yaml
filebeat.inputs:
  - type: filestream
    id: oc-pilot-telemetry
    paths:
      - /path/to/telemetry-server/logs/events.log
    parsers:
      - ndjson:
          target: ""
          overwrite_keys: true
          add_error_key: true
    fields:
      service: oc-pilot-telemetry
    fields_under_root: true

output.elasticsearch:
  hosts: ["https://your-elasticsearch:9200"]
  index: "oc-pilot-telemetry-%{+yyyy.MM.dd}"
```

---

## 12. Operations

### Health check

```bash
curl http://<server>:<port>/healthz
# → {"ok":true}  means the app is up and MongoDB is reachable
```

### Tail live logs

```bash
docker compose logs -f server           # stderr stream
tail -F logs/events.log                 # rotating file
```

### Inspect raw events in MongoDB

```bash
docker compose exec mongo mongosh oc_pilot_telemetry -u ocpilot -p \
  --eval 'db.events.find().sort({received_at:-1}).limit(5).pretty()'
```

### Rotating the bearer token

1. Generate a new token (`openssl rand -hex 32`).
2. Update `auth.telemetry_token` in `config.yaml`.
3. Restart the server: `docker compose restart server`.
4. Update `DEFAULT_TELEMETRY_TOKEN` in `extension/background.js`, bump the version,
   re-pack and redistribute the CRX.
5. Until users update, their POSTs will 401 — visible as `auth_failed` log lines.

### Backup MongoDB

```bash
docker compose exec mongo mongodump \
  --username ocpilot --password <pw> \
  --authenticationDatabase admin \
  --db oc_pilot_telemetry --archive \
  | gzip > oc_pilot_backup_$(date +%F).gz
```

### Upgrading the server image

```bash
# rebuild on your dev machine
cd server && docker build -t oc-pilot-telemetry:local .

# save and transfer if the target has no internet
docker save oc-pilot-telemetry:local -o oc-pilot-telemetry.image.tar

# on the target VM
docker load -i oc-pilot-telemetry.image.tar
docker compose up -d   # pulls the new image, recreates the container
```

---

## 13. Troubleshooting

### `curl localhost:<port>/healthz` returns connection refused

The container is not running or exited immediately after start.

```bash
docker compose ps          # check status
docker compose logs server  # look for startup errors
```

Common cause: `config.yaml` still contains a `REPLACE-ME` placeholder — the
server fails fast on startup.

### Chrome shows `ERR_UNSAFE_PORT`

Chrome refuses to connect to certain ports (including 6665–6669, 6697).
Change the host port in `docker-compose.yml` to a safe one (7070, 8888, 9090)
and restart.

### Dashboard loads but shows no data

1. Check that the extension is loaded (`chrome://extensions`).
2. Open the extension settings tab, unlock Developer settings (5 clicks on
   the header icon), and click **Send telemetry now**.
3. Check the status message — red means the POST failed. Confirm the URL and
   token in `extension/background.js` match the running server.

### Events not appearing after interaction

The storage change listener in `content-console.js` uses a guard to ignore
telemetry-only writes. If you suspect this is broken, open the extension's
service worker DevTools (`chrome://extensions` → Inspect views: service worker)
and run:

```js
chrome.runtime.sendMessage({ type: 'telemetry/sendNow' }).then(console.log)
```

A `{ok: true, eventCount: N}` response with `N > 0` confirms counters are
being incremented correctly.

### Extension features broken when telemetry server is down

They should not be. Telemetry failures are fully silent — they only appear as
`console.warn` lines in the service worker. If a user-facing feature is
affected when the telemetry endpoint is unreachable, that is a bug. Check
that all `bumpEvent()` calls are wrapped in `try/catch` and that
`sendTelemetry()` is not blocking any user-facing code path.
