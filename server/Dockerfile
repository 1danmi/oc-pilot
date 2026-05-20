# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   Stage 1 (node:20-alpine) builds the React dashboard via Vite.
#   Stage 2 (python:3.12-slim) installs the FastAPI app and copies the built
#   dashboard from stage 1. Keeps the runtime image slim by not shipping
#   node, npm, or any dashboard source.

# ─── Stage 1: build the dashboard ──────────────────────────────────────────
FROM node:20-alpine AS dashboard-build
WORKDIR /build

# Install deps separately so they cache when only source changes.
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install --no-audit --no-fund

# Then copy source and build.
COPY dashboard/ ./
RUN npm run build
# → /build/dist contains the static dashboard.


# ─── Stage 2: Python runtime ───────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# Don't write .pyc files; flush stdout/stderr immediately for `docker logs`.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OC_PILOT_TELEMETRY_CONFIG=/etc/oc-pilot-telemetry/config.yaml \
    DASHBOARD_DIR=/app/dashboard

WORKDIR /app

# Python deps — copy requirements first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code.
COPY app.py ./

# Dashboard from stage 1.
COPY --from=dashboard-build /build/dist/ /app/dashboard/

# Pre-create the mount points so a bind-mount-less run still has somewhere
# to write logs (the bind mount overrides this at runtime).
RUN mkdir -p /etc/oc-pilot-telemetry /var/log/oc-pilot-telemetry

EXPOSE 8080

# Health check uses /healthz (which does its own mongo ping).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request, sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).status == 200 else 1)" || exit 1

# --no-access-log silences uvicorn's per-request access lines so the only
# stderr output is our own structured JSON from app.py. Don't pass
# --log-config (uvicorn rejects /dev/null as an empty file).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
