# OC Pilot telemetry server

Self-hosted FastAPI service that collects anonymous usage statistics from every
running OC Pilot Chrome extension and renders an aggregated dashboard. See the
top-level repo's plan file for the full design.

## What it does

- Accepts `POST /v1/telemetry` from extensions every hour (and on install /
  update). Each POST is stored as ONE document in MongoDB — the collection is
  an append-only event log.
- Aggregates on demand via `GET /v1/stats` and `GET /v1/stats/timeseries`.
- Serves a React dashboard at `/` (basic auth).
- Logs every received POST as one JSON line via `python-json-logger` into a
  rotating file — Filebeat-ready for shipping to Elasticsearch later.

## Layout

| Path | Purpose |
|---|---|
| `app.py` | FastAPI app — routes, Mongo client, auth, logger setup |
| `config.example.yaml` | Template. Copy to `config.yaml`, fill in secrets. |
| `requirements.txt` | Python deps |
| `Dockerfile` | Multi-stage build (node stage 1 builds dashboard, python stage 2 runs the server) |
| `docker-compose.yml` | One-VM deploy: server + mongo + log bind-mount |
| `openshift/deployment.yaml` | OpenShift Deployment + Service + Route + PVC |
| `dashboard/` | Vite + React + TS + Recharts source. Built into `dashboard/dist/` by the Dockerfile. |

## Configuration

The server reads its config from a YAML file. The path is `OC_PILOT_TELEMETRY_CONFIG`
(default `/etc/oc-pilot-telemetry/config.yaml`). The file is **required** — the
server fails to start if it's missing, invalid, or still contains placeholder
secrets (the literal string `REPLACE-ME`).

See [`config.example.yaml`](./config.example.yaml) for the full schema. The
keys that matter:

| Key | Meaning |
|---|---|
| `auth.telemetry_token` | Shared bearer token. Extensions present this on POST. Same value must be set as `DEFAULT_TELEMETRY_TOKEN` in `src/background.js`. |
| `auth.stats_username` / `auth.stats_password` | HTTP basic auth for `/v1/stats`, `/v1/stats/timeseries`, and `/` (dashboard). |
| `mongodb.uri` | Full Mongo connection string. PyMongo's `AsyncMongoClient` understands replica sets, SRV, TLS, auth, etc. |
| `mongodb.database` / `mongodb.collection` | Names. Default `oc_pilot_telemetry` / `events`. |
| `logging.json_file.path` | Where the rotating JSON log lives. Bind-mount this for Filebeat. |
| `logging.json_file.max_bytes` / `backup_count` | Rotation thresholds. Defaults: 100 MB × 10 = 1 GB max retained. |

## Deploying

### Option A — Docker on a VM (recommended for first-time setup)

```bash
cd server
cp config.example.yaml config.yaml
# edit config.yaml: paste your generated telemetry_token + stats_password
docker compose up -d --build

# verify
curl -s http://localhost:8080/healthz                              # → {"ok":true}
curl -s -u admin:<stats_password> http://localhost:8080/v1/stats   # → empty stats
# open http://localhost:8080/  in a browser → log in → empty dashboard
```

Logs land in `./logs/events.log` on the host (rotated).
Mongo data persists in the named volume `oc-pilot-telemetry-mongo`.

Put nginx/caddy in front of port 8080 for TLS termination if you're exposing
this beyond `localhost`. Or use the OpenShift route which terminates TLS for
you.

### Option B — OpenShift

```bash
oc new-project oc-pilot-telemetry

# 1. Build & push the image somewhere the cluster can pull from.
#    Easiest: oc new-build / oc start-build, or push from your laptop:
docker build -t image-registry.openshift-image-registry.svc:5000/oc-pilot-telemetry/server:latest .

# 2. Create the config secret from your filled-in config.yaml.
oc create secret generic oc-pilot-telemetry-config \
    --from-file=config.yaml=./config.yaml

# 3. (optional) Create the separate Mongo URI secret if you want rotation.
# oc create secret generic oc-pilot-telemetry-mongo \
#     --from-literal=uri='mongodb://user:pass@mongo:27017/'

# 4. Apply the manifests.
oc apply -f openshift/deployment.yaml

# 5. Get the public URL.
oc get route oc-pilot-telemetry -o jsonpath='{.spec.host}'
```

The `Route` does TLS edge termination automatically. Point
`DEFAULT_TELEMETRY_URL` in `src/background.js` at
`https://<route-host>/v1/telemetry`.

## Generating secrets

```bash
# 32-char hex bearer token
openssl rand -hex 32

# 16-char hex password
openssl rand -hex 16
```

Or in PowerShell:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Min 0 -Max 256) })
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/telemetry` | bearer | Insert one telemetry doc |
| GET | `/v1/stats` | basic | Aggregated all-time + active-window counts |
| GET | `/v1/stats/timeseries?days=N` | basic | Daily bucketed counts, last N days (1–365) |
| GET | `/` | basic | React dashboard (served from built `dashboard/dist/`) |
| GET | `/healthz` | none | Mongo ping; for k8s/Docker health probes |

## Dashboard development

The dashboard lives in `dashboard/`. For iteration without rebuilding the
container:

```bash
cd dashboard
npm install          # one-time
npm run dev          # Vite at http://localhost:5173
```

Vite proxies `/v1/*` to `http://localhost:8080` (configurable in
`vite.config.ts`), so you point the dev server at a real running backend and
iterate on the React code with hot reload.

Production always serves the built `dashboard/dist/` from FastAPI — no node
runs in the production image.

## JSON log format

Each `/v1/telemetry` POST produces one line like:

```json
{
  "timestamp": "2026-05-19T10:00:01.234Z",
  "level": "INFO",
  "logger": "oc-pilot-telemetry",
  "message": "telemetry_received",
  "event": "telemetry_received",
  "machine_id": "uuid",
  "user_hash": "sha256-or-null",
  "version": "0.25.10",
  "period_start": 1700000000,
  "period_end": 1700003600,
  "period_seconds": 3600,
  "is_install": false,
  "is_update": false,
  "previous_version": null,
  "counters": { "click.podTerminal": 5, "click.favourites.add": 3 },
  "counter_sum": 8,
  "ip": "10.0.0.42"
}
```

Other event types you'll see in the same stream:

| `event` | When |
|---|---|
| `startup` | App boot — `mongo_ok` field tells you whether the initial ping succeeded |
| `telemetry_received` | One per accepted POST |
| `lifecycle_install` / `lifecycle_update` | Extra lines on those special POSTs, for easy alerting |
| `auth_failed` | Bad bearer or basic auth — includes IP + endpoint |
| `validation_failed` | 422 body — includes reason |
| `insert_failed` / `stats_failed` | Mongo error — includes error string |
| `stats_viewed` | Dashboard or stats endpoint hit |

## Filebeat (later)

When you're ready to ship to Elastic, drop something like this into the host's
Filebeat config:

```yaml
filebeat.inputs:
  - type: filestream
    id: oc-pilot-telemetry
    paths:
      - /path/to/server/logs/events.log
    parsers:
      - ndjson:
          target: ""        # merge JSON fields into the top of the event
          overwrite_keys: true
          add_error_key: true
    fields:
      service: oc-pilot-telemetry
    fields_under_root: true

output.elasticsearch:
  hosts: ["https://your-elasticsearch:9200"]
  index: "oc-pilot-telemetry-%{+yyyy.MM.dd}"
```

In Kibana you'll get per-counter time-series for free since each counter is
its own top-level field in every log document.

## Operations

### MongoDB tuning

The defaults in `docker-compose.yml` set `--wiredTigerCacheSizeGB 1` for a
small VM. If you have more RAM, bump to ~50 % of available memory minus 1 GB.

For more compression at slight CPU cost, switch the WiredTiger block
compressor to `zstd` in the Mongo config: roughly 30 % smaller on disk.

### Storage growth

≈ 24 docs × machine_count × 365 days per year. At ~500 B raw per doc,
snappy-compressed:

| Machines | Docs/year | On disk/year |
|---:|---:|---:|
| 100 | 880 K | ~200 MB |
| 1 000 | 8.8 M | ~2 GB |
| 10 000 | 88 M | ~20 GB |

Add a TTL index on `received_at` if it ever grows uncomfortably:

```js
db.events.createIndex(
  { received_at: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 * 2 }  // 2 years
)
```

### Health & logs

```bash
# liveness
curl http://localhost:8080/healthz

# tail JSON logs
docker compose logs -f server                 # stderr (same JSON)
tail -F server/logs/events.log                # rotating file

# inspect raw events
docker compose exec mongo mongosh oc_pilot_telemetry \
  --eval 'db.events.find().sort({received_at: -1}).limit(5).pretty()'
```

### Rotating bearer tokens

1. Update `auth.telemetry_token` in `config.yaml`.
2. `docker compose restart server` (or `oc rollout restart deploy/oc-pilot-telemetry`).
3. Push a new extension build with the matching `DEFAULT_TELEMETRY_TOKEN` and
   re-distribute the CRX.
4. Until users update, their POSTs will 401 and show up as `auth_failed` log
   lines.
