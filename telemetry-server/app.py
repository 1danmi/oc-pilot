"""
OC Pilot telemetry server.

A small FastAPI service that accepts hourly telemetry POSTs from every running
OC Pilot Chrome extension and stores them as an append-only event log in
MongoDB. It also serves a static React dashboard at `/`, exposes aggregated
stats JSON, and writes a JSON-per-line log file that a future Filebeat can
ship to Elasticsearch.

The full design is in C:\\Users\\danie\\.claude\\plans\\run-the-test-suit-steady-cosmos.md.
The summary that matters for reading this file:

  * Auth: POST /v1/telemetry is gated by a bearer token; everything else
    (dashboard + stats endpoints) is gated by HTTP basic auth.
  * Storage: every POST inserts ONE document. Aggregate by $sum across all
    docs for a given machine_id; never update in place.
  * Logging: every POST emits one structured JSON log line; bad-auth and
    422s also log structured lines so Filebeat -> Elastic can surface them.
  * Failure isolation: if Mongo is down the server still responds 503 to
    POSTs (and the extension retries on its next hourly alarm).
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Annotated, Any

import yaml
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.security import (
    HTTPAuthorizationCredentials,
    HTTPBasic,
    HTTPBasicCredentials,
    HTTPBearer,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, AsyncMongoClient, IndexModel
from pymongo.errors import PyMongoError
from pythonjsonlogger import jsonlogger


# ─── Config loading ─────────────────────────────────────────────────────────

CONFIG_PATH = os.environ.get(
    "OC_PILOT_TELEMETRY_CONFIG", "/etc/oc-pilot-telemetry/config.yaml"
)


def _load_config(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    except FileNotFoundError as e:
        raise SystemExit(
            f"[oc-pilot-telemetry] config file not found at {path}. "
            f"Set OC_PILOT_TELEMETRY_CONFIG or mount the file."
        ) from e
    except yaml.YAMLError as e:
        raise SystemExit(f"[oc-pilot-telemetry] config is not valid YAML: {e}") from e

    # Minimal validation — fail fast on a misconfigured deploy.
    required = [
        ("auth", "telemetry_token"),
        ("auth", "stats_username"),
        ("auth", "stats_password"),
        ("mongodb", "uri"),
        ("mongodb", "database"),
        ("mongodb", "collection"),
        ("logging", "json_file", "path"),
    ]
    for keys in required:
        node: Any = cfg
        for k in keys:
            if not isinstance(node, dict) or k not in node:
                raise SystemExit(
                    f"[oc-pilot-telemetry] missing required config key: "
                    f"{' -> '.join(keys)}"
                )
            node = node[k]

    for placeholder_key in ("telemetry_token", "stats_password"):
        v = cfg["auth"][placeholder_key]
        if not isinstance(v, str) or "REPLACE-ME" in v or len(v) < 8:
            raise SystemExit(
                f"[oc-pilot-telemetry] auth.{placeholder_key} must be set to a "
                f"strong value (got placeholder or too short)."
            )
    return cfg


CFG = _load_config(CONFIG_PATH)


# ─── Logging setup ──────────────────────────────────────────────────────────
#
# Two handlers, both JSON-formatted:
#   1. RotatingFileHandler at logging.json_file.path — what Filebeat will
#      eventually ship to Elasticsearch.
#   2. StreamHandler to stderr — what `docker logs` shows.

LOG_LEVEL = getattr(logging, CFG["logging"].get("level", "INFO").upper(), logging.INFO)

_log_file_cfg = CFG["logging"]["json_file"]
_log_path = Path(_log_file_cfg["path"])
_log_path.parent.mkdir(parents=True, exist_ok=True)

# Note on datefmt: Python's time.strftime doesn't understand %f (microseconds),
# so we use second precision in the formatted timestamp and Filebeat/Elastic
# will assign higher-resolution @timestamp at ingest. ISO 8601 + Z = UTC.
_formatter = jsonlogger.JsonFormatter(
    "%(asctime)s %(levelname)s %(name)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level", "name": "logger"},
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
logging.Formatter.converter = __import__("time").gmtime  # force UTC for asctime
_file_handler = RotatingFileHandler(
    str(_log_path),
    maxBytes=int(_log_file_cfg.get("max_bytes", 100 * 1024 * 1024)),
    backupCount=int(_log_file_cfg.get("backup_count", 10)),
    encoding="utf-8",
)
_file_handler.setFormatter(_formatter)
_stream_handler = logging.StreamHandler()
_stream_handler.setFormatter(_formatter)

logger = logging.getLogger("oc-pilot-telemetry")
logger.setLevel(LOG_LEVEL)
logger.addHandler(_file_handler)
logger.addHandler(_stream_handler)
logger.propagate = False  # don't double-log via the root logger


def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    """Emit one structured log line. Field names follow the dashboard schema."""
    logger.log(level, event, extra={"event": event, **fields})


# ─── MongoDB client + index bootstrap ──────────────────────────────────────

_MONGO = CFG["mongodb"]
_mongo_client: AsyncMongoClient | None = None


def _client() -> AsyncMongoClient:
    if _mongo_client is None:
        raise RuntimeError("MongoDB client not initialised")
    return _mongo_client


def _events_collection():
    return _client()[_MONGO["database"]][_MONGO["collection"]]


async def _ensure_indexes() -> None:
    """Create indexes (idempotent). See plan section 'Indexes' for the why."""
    coll = _events_collection()
    await coll.create_indexes(
        [
            # Plain field indexes.
            IndexModel([("machine_id", ASCENDING)], name="machine_id_1"),
            IndexModel([("install_id", ASCENDING)], name="install_id_1"),
            IndexModel([("received_at", DESCENDING)], name="received_at_-1"),
            IndexModel([("version", ASCENDING)], name="version_1"),
            # Sparse on user_hash — skips docs where it's null (pre-creds).
            IndexModel(
                [("user_hash", ASCENDING)],
                name="user_hash_1",
                sparse=True,
            ),
            # Compound for "most recent N docs per machine".
            IndexModel(
                [("machine_id", ASCENDING), ("received_at", DESCENDING)],
                name="machine_id_1_received_at_-1",
            ),
            # Partial-filter indexes for the install/update boolean fields —
            # tiny because 99% of docs have these as False.
            IndexModel(
                [("is_install", ASCENDING), ("received_at", DESCENDING)],
                name="is_install_partial",
                partialFilterExpression={"is_install": True},
            ),
            IndexModel(
                [("is_update", ASCENDING), ("received_at", DESCENDING)],
                name="is_update_partial",
                partialFilterExpression={"is_update": True},
            ),
        ]
    )


# ─── Lifespan ──────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _mongo_client
    _mongo_client = AsyncMongoClient(
        _MONGO["uri"],
        maxPoolSize=int(_MONGO.get("max_pool_size", 20)),
        appname="oc-pilot-telemetry",
        # Short timeouts: we'd rather fail fast on a sick mongo than hang
        # the FastAPI worker for 30s on every request.
        serverSelectionTimeoutMS=3000,
        connectTimeoutMS=3000,
    )
    # Smoke-test the connection at startup so misconfigured deploys fail
    # immediately, but DON'T raise — let the server stay up and return 503
    # on /v1/telemetry if mongo is briefly unavailable.
    try:
        await _mongo_client.admin.command("ping")
        await _ensure_indexes()
        log_event("startup", mongo_ok=True, db=_MONGO["database"])
    except PyMongoError as e:
        log_event(
            "startup",
            level=logging.ERROR,
            mongo_ok=False,
            error=str(e),
        )
    yield
    if _mongo_client is not None:
        await _mongo_client.close()


app = FastAPI(
    title="OC Pilot Telemetry",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)


# ─── Auth dependencies ─────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)
_basic = HTTPBasic(auto_error=False)


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP. Honours X-Forwarded-For (one hop) so reverse
    proxies (nginx, OpenShift Router) don't all show up as 127.0.0.1."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


async def require_bearer(
    request: Request,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> None:
    expected = CFG["auth"]["telemetry_token"]
    presented = creds.credentials if creds else ""
    # constant-time compare to avoid leaking the token via timing.
    if not creds or not secrets.compare_digest(presented, expected):
        log_event(
            "auth_failed",
            level=logging.WARNING,
            endpoint=str(request.url.path),
            scheme="bearer",
            ip=_client_ip(request),
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bearer"
        )


async def require_basic(
    request: Request,
    creds: Annotated[HTTPBasicCredentials | None, Depends(_basic)],
) -> None:
    u = CFG["auth"]["stats_username"]
    p = CFG["auth"]["stats_password"]
    if (
        creds is None
        or not secrets.compare_digest(creds.username, u)
        or not secrets.compare_digest(creds.password, p)
    ):
        log_event(
            "auth_failed",
            level=logging.WARNING,
            endpoint=str(request.url.path),
            scheme="basic",
            ip=_client_ip(request),
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )


# ─── Request model ─────────────────────────────────────────────────────────


class TelemetryEvent(BaseModel):
    # Wire-format convention: payload field names are camelCase (matching the
    # rest of the body — userHash, periodStart, etc.). They get translated to
    # snake_case DB columns in the `doc = {...}` dict in post_telemetry().
    machineId: str = Field(min_length=1, max_length=64)   # stable per-machine (since v0.27.0)
    installId: str = Field(min_length=1, max_length=64)   # per-install (since v0.27.0)
    userHash: str | None = Field(default=None, max_length=128)
    # Raw username — sent alongside userHash starting in v0.27.2. The hash is
    # kept for legacy aggregations / continuity; the raw value enables joining
    # against Active Directory (department, team, etc.) for richer dashboards.
    # Optional because (a) older extension versions don't send it and (b) the
    # extension sends null when the user hasn't configured credentials yet.
    # This payload field is intentionally permitted in the org's internal-only
    # deployment — usernames are public org data. Never accept passwords here.
    username: str | None = Field(default=None, max_length=128)
    version: str = Field(min_length=1, max_length=32)
    periodStart: int = Field(ge=0)
    periodEnd: int = Field(ge=0)
    counters: dict[str, int] = Field(default_factory=dict)
    isInstall: bool = False
    isUpdate: bool = False
    previousVersion: str | None = Field(default=None, max_length=32)


# Defensive caps so a buggy/hostile client can't blow up the server.
_MAX_COUNTERS = 200
_MAX_COUNTER_NAME_LEN = 128
_MAX_COUNTER_VALUE = 10_000_000


def _validate_counters(counters: dict[str, int]) -> None:
    if len(counters) > _MAX_COUNTERS:
        raise HTTPException(422, f"too many counter keys (max {_MAX_COUNTERS})")
    for k, v in counters.items():
        if not isinstance(k, str) or len(k) == 0 or len(k) > _MAX_COUNTER_NAME_LEN:
            raise HTTPException(422, f"bad counter name: {k!r}")
        if not isinstance(v, int) or v < 0 or v > _MAX_COUNTER_VALUE:
            raise HTTPException(422, f"bad counter value for {k!r}: {v!r}")


# ─── POST /v1/telemetry ────────────────────────────────────────────────────


@app.post(
    "/v1/telemetry",
    status_code=204,
    dependencies=[Depends(require_bearer)],
)
async def post_telemetry(
    event: TelemetryEvent, request: Request
) -> Response:
    try:
        _validate_counters(event.counters)
    except HTTPException as e:
        log_event(
            "validation_failed",
            level=logging.WARNING,
            ip=_client_ip(request),
            reason=str(e.detail),
            machine_id=event.machineId,
            install_id=event.installId,
        )
        raise

    now = datetime.now(timezone.utc)
    doc = {
        "machine_id": event.machineId,
        "install_id": event.installId,
        "user_hash": event.userHash,
        "username": event.username,
        "version": event.version,
        "period_start": event.periodStart,
        "period_end": event.periodEnd,
        "counters": event.counters,
        "is_install": bool(event.isInstall),
        "is_update": bool(event.isUpdate),
        "previous_version": event.previousVersion,
        "received_at": now,
        # client_ip intentionally NOT stored — see privacy section in the plan.
        "client_ip": None,
    }

    try:
        await _events_collection().insert_one(doc)
    except PyMongoError as e:
        log_event(
            "insert_failed",
            level=logging.ERROR,
            error=str(e),
            machine_id=event.machineId,
            install_id=event.installId,
        )
        raise HTTPException(503, "database unavailable")

    counter_sum = sum(event.counters.values())
    ip = _client_ip(request)

    log_event(
        "telemetry_received",
        machine_id=event.machineId,
        install_id=event.installId,
        user_hash=event.userHash,
        username=event.username,
        version=event.version,
        period_start=event.periodStart,
        period_end=event.periodEnd,
        period_seconds=event.periodEnd - event.periodStart,
        is_install=event.isInstall,
        is_update=event.isUpdate,
        previous_version=event.previousVersion,
        counters=event.counters,
        counter_sum=counter_sum,
        ip=ip,
    )

    if event.isInstall:
        log_event(
            "lifecycle_install",
            machine_id=event.machineId,
            install_id=event.installId,
            version=event.version,
            ip=ip,
        )
    if event.isUpdate:
        log_event(
            "lifecycle_update",
            machine_id=event.machineId,
            install_id=event.installId,
            version=event.version,
            previous_version=event.previousVersion,
            ip=ip,
        )

    return Response(status_code=204)


# ─── Stats aggregations ────────────────────────────────────────────────────


async def _aggregate_stats() -> dict[str, Any]:
    """Single round-trip aggregation that fills out everything /v1/stats needs."""
    coll = _events_collection()
    now = datetime.now(timezone.utc)
    cutoff_1h = now - timedelta(hours=1)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)

    # Use $facet so we do every aggregation in one pipeline pass.
    pipeline: list[dict[str, Any]] = [
        {
            "$facet": {
                "totals": [
                    {
                        "$group": {
                            "_id": None,
                            "machines": {"$addToSet": "$machine_id"},
                            "installs_set": {
                                "$addToSet": {
                                    "$cond": [
                                        {"$ifNull": ["$install_id", False]},
                                        "$install_id",
                                        "$$REMOVE",
                                    ]
                                }
                            },
                            "users": {
                                "$addToSet": {
                                    "$cond": [
                                        {"$ifNull": ["$user_hash", False]},
                                        "$user_hash",
                                        "$$REMOVE",
                                    ]
                                }
                            },
                            "installs": {
                                "$sum": {"$cond": ["$is_install", 1, 0]}
                            },
                            "updates": {
                                "$sum": {"$cond": ["$is_update", 1, 0]}
                            },
                            "last_received_at": {"$max": "$received_at"},
                        }
                    }
                ],
                "active_1h": [
                    {"$match": {"received_at": {"$gte": cutoff_1h}}},
                    {"$group": {"_id": None, "machines": {"$addToSet": "$machine_id"}}},
                ],
                "active_24h": [
                    {"$match": {"received_at": {"$gte": cutoff_24h}}},
                    {"$group": {"_id": None, "machines": {"$addToSet": "$machine_id"}}},
                ],
                "active_7d": [
                    {"$match": {"received_at": {"$gte": cutoff_7d}}},
                    {"$group": {"_id": None, "machines": {"$addToSet": "$machine_id"}}},
                ],
                "per_event": [
                    {
                        "$project": {
                            "counters_kv": {"$objectToArray": "$counters"}
                        }
                    },
                    {"$unwind": "$counters_kv"},
                    {
                        "$group": {
                            "_id": "$counters_kv.k",
                            "total": {"$sum": "$counters_kv.v"},
                        }
                    },
                ],
                "versions": [
                    {
                        "$group": {
                            "_id": "$version",
                            "machines": {"$addToSet": "$machine_id"},
                        }
                    }
                ],
            }
        }
    ]

    cursor = await coll.aggregate(pipeline)
    result = await cursor.to_list(length=1)
    if not result:
        return _empty_stats()

    facets = result[0]
    totals = (facets["totals"] or [{}])[0] if facets["totals"] else {}
    unique_machines = len(totals.get("machines", []))
    unique_installs = len(totals.get("installs_set", []))
    unique_users = len(totals.get("users", []))

    def _active(facet_key: str) -> int:
        rows = facets.get(facet_key) or []
        return len(rows[0]["machines"]) if rows else 0

    per_event_total = {row["_id"]: int(row["total"]) for row in facets["per_event"]}
    per_event_avg_per_user = {
        k: round(v / unique_users, 2) if unique_users else 0.0
        for k, v in per_event_total.items()
    }

    version_distribution = {
        row["_id"]: len(row["machines"]) for row in facets["versions"] if row["_id"]
    }

    last_received = totals.get("last_received_at")
    last_ts: int | None = None
    if isinstance(last_received, datetime):
        last_ts = int(last_received.timestamp())

    return {
        "unique_machines": unique_machines,
        "unique_installs": unique_installs,
        "unique_users": unique_users,
        "active_machines_1h": _active("active_1h"),
        "active_machines_24h": _active("active_24h"),
        "active_machines_7d": _active("active_7d"),
        "per_event_total": per_event_total,
        "per_event_avg_per_user": per_event_avg_per_user,
        "version_distribution": version_distribution,
        "installs_total": int(totals.get("installs", 0)),
        "updates_total": int(totals.get("updates", 0)),
        "last_event_received_at": last_ts,
    }


def _empty_stats() -> dict[str, Any]:
    return {
        "unique_machines": 0,
        "unique_installs": 0,
        "unique_users": 0,
        "active_machines_1h": 0,
        "active_machines_24h": 0,
        "active_machines_7d": 0,
        "per_event_total": {},
        "per_event_avg_per_user": {},
        "version_distribution": {},
        "installs_total": 0,
        "updates_total": 0,
        "last_event_received_at": None,
    }


@app.get("/v1/stats", dependencies=[Depends(require_basic)])
async def get_stats(request: Request) -> JSONResponse:
    log_event("stats_viewed", endpoint="/v1/stats", ip=_client_ip(request))
    try:
        stats = await _aggregate_stats()
    except PyMongoError as e:
        log_event("stats_failed", level=logging.ERROR, error=str(e))
        raise HTTPException(503, "database unavailable")
    return JSONResponse(stats)


@app.get("/v1/stats/timeseries", dependencies=[Depends(require_basic)])
async def get_timeseries(request: Request, days: int = 30) -> JSONResponse:
    log_event(
        "stats_viewed",
        endpoint="/v1/stats/timeseries",
        days=days,
        ip=_client_ip(request),
    )
    if days < 1 or days > 365:
        raise HTTPException(422, "days must be between 1 and 365")

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)

    pipeline: list[dict[str, Any]] = [
        {"$match": {"received_at": {"$gte": cutoff}}},
        {
            "$addFields": {
                "day": {
                    "$dateToString": {
                        "format": "%Y-%m-%d",
                        "date": "$received_at",
                        "timezone": "UTC",
                    }
                },
                "counter_sum": {
                    "$sum": {
                        "$map": {
                            "input": {"$objectToArray": "$counters"},
                            "as": "kv",
                            "in": "$$kv.v",
                        }
                    }
                },
            }
        },
        {
            "$group": {
                "_id": "$day",
                "machines": {"$addToSet": "$machine_id"},
                "installs_set": {
                    "$addToSet": {
                        "$cond": [
                            {"$ifNull": ["$install_id", False]},
                            "$install_id",
                            "$$REMOVE",
                        ]
                    }
                },
                "users": {
                    "$addToSet": {
                        "$cond": [
                            {"$ifNull": ["$user_hash", False]},
                            "$user_hash",
                            "$$REMOVE",
                        ]
                    }
                },
                "events_count": {"$sum": "$counter_sum"},
                "install_count": {"$sum": {"$cond": ["$is_install", 1, 0]}},
                "update_count": {"$sum": {"$cond": ["$is_update", 1, 0]}},
            }
        },
        {"$sort": {"_id": 1}},
    ]

    try:
        cursor = await _events_collection().aggregate(pipeline)
        rows = await cursor.to_list(length=days + 1)
    except PyMongoError as e:
        log_event("stats_failed", level=logging.ERROR, error=str(e))
        raise HTTPException(503, "database unavailable")

    series = [
        {
            "date": row["_id"],
            "unique_machines_seen": len(row.get("machines", [])),
            "unique_installs_seen": len(row.get("installs_set", [])),
            "unique_users_seen": len(row.get("users", [])),
            "events_count": int(row.get("events_count", 0)),
            "install_count": int(row.get("install_count", 0)),
            "update_count": int(row.get("update_count", 0)),
        }
        for row in rows
    ]
    return JSONResponse({"days": days, "series": series})


# ─── Health (no auth) ──────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> JSONResponse:
    try:
        await _client().admin.command("ping")
        return JSONResponse({"ok": True})
    except PyMongoError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=503)


# ─── React dashboard (basic auth on every file) ────────────────────────────
#
# The Vite build emits server/dashboard/dist/. The Dockerfile copies that to
# /app/dashboard inside the image. We mount it at "/" behind basic auth so
# even index.html requires authentication.

_DASHBOARD_DIR = Path(os.environ.get("DASHBOARD_DIR", "/app/dashboard"))


class AuthedStaticFiles(StaticFiles):
    """StaticFiles that requires basic auth on every request.

    FastAPI's normal dependency injection doesn't apply to Mount sub-apps,
    so we wrap StaticFiles.__call__ ourselves.
    """

    async def __call__(self, scope, receive, send):  # type: ignore[override]
        if scope.get("type") == "http":
            request = Request(scope, receive=receive)
            # Reuse the same dependency. If it raises HTTPException, FastAPI's
            # default machinery isn't invoked here — handle manually.
            try:
                creds: HTTPBasicCredentials | None = await _basic(request)
                await require_basic(request, creds)
            except HTTPException as e:
                response = JSONResponse(
                    {"detail": e.detail},
                    status_code=e.status_code,
                    headers=e.headers or {},
                )
                await response(scope, receive, send)
                return
        await super().__call__(scope, receive, send)


if _DASHBOARD_DIR.exists():
    app.mount(
        "/",
        AuthedStaticFiles(directory=str(_DASHBOARD_DIR), html=True),
        name="dashboard",
    )
else:
    # Dev convenience: in `npm run dev` mode the dashboard runs on :5173 and
    # proxies /v1/* to here. The mount above is skipped and `/` simply 404s.
    @app.get("/")
    async def _dashboard_missing() -> JSONResponse:
        return JSONResponse(
            {
                "detail": (
                    f"dashboard not built (no files at {_DASHBOARD_DIR}). "
                    f"Run `npm run build` in server/dashboard or use `npm run dev`."
                )
            },
            status_code=503,
        )


# ─── Local entrypoint (production runs uvicorn from the CMD) ───────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=CFG["server"].get("host", "0.0.0.0"),
        port=int(CFG["server"].get("port", 8080)),
        log_config=None,  # we set up our own root logger above
    )
