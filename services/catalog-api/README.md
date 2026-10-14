# Muonroi Model Catalog API

A tiny FastAPI service that serves the **single source-of-truth** model catalog
(`src/models/catalog.json`) over HTTP so that both consumers stay in sync:

- **muonroi-cli** — `src/models/catalog-client.ts` fetches `GET /api/v1/models`
  (with a 24h local cache + bundled static fallback).
- **experience-engine** — the offline seed (`scripts/seed-catalog.js`) fetches
  the catalog at install/update and writes `modelTiers` into
  `~/.experience/config.json`, replacing hardcoded model ladders.

The catalog file is **not duplicated** here — the Docker image copies the
canonical `src/models/catalog.json` from the repo at build time.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `{status, version, updated_at, model_count}`; 503 if catalog missing |
| `GET` | `/api/v1/models` | `{version, updated_at, description, models[]}`; `ETag` + `Cache-Control: max-age=3600` |
| `GET` | `/api/v1/models?provider=openai` | filter by provider id |
| `GET` | `/api/v1/models?tier=fast` | filter by tier (`fast`\|`balanced`\|`premium`) |

The response shape mirrors what `catalog-client.ts` already parses, so the CLI
needs only a URL change (`MUONROI_CATALOG_URL` or the `catalog.muonroi.com`
default).

## Auth (anti-spam)

Set `CATALOG_API_KEY` on the service to require a shared key on
`/api/v1/models` (sent as `X-API-Key: <key>` or `Authorization: Bearer
<key>`, constant-time compared). `/health` stays open for probes. When the
env var is unset, the endpoint is open (local dev / fresh box).

Consumers send the key from their own env:

- CLI: `MUONROI_CATALOG_API_KEY` (see `getCatalogHeaders()` in
  `src/models/catalog-client.ts`) — a 401 just falls back to the bundled
  static catalog.
- EE seed: `MUONROI_CATALOG_API_KEY` (see `scripts/seed-catalog.js`).

The key is a runtime secret — inject via `docker run -e CATALOG_API_KEY=…`
or the VPS `.env`; never commit it.

## Run locally

```bash
cd services/catalog-api
python -m venv .venv && . .venv/Scripts/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8083
# -> http://localhost:8083/api/v1/models
```

By default the service resolves `../../src/models/catalog.json`. Override with
`CATALOG_JSON_PATH=/abs/path/catalog.json`.

## Test

```bash
pip install -r requirements.txt pytest httpx
pytest services/catalog-api/ -q
```

## Deploy

The image reads the canonical catalog; its schema preserves modalities and
per-request `long_context_pricing` metadata. OpenAI/Anthropic pricing comes
from the verified catalog rows, without a duplicate provider price table.

The live deployment inspected on 2026-10-08 uses `/opt/muonroi/docker-compose.yml`
plus `docker-compose.override.yml`, service `catalog`, image port8083 published
at `127.0.0.1:8086`, reverse-proxied at `catalog.muonroi.com`. Verify container
labels and Compose configuration before deploying; older deployment docs and
local compose files use a different port.

Build from the repository root with `services/catalog-api/Dockerfile`, then
recreate only `catalog` with `docker compose up -d --no-deps --no-build catalog`.
Keep the previous image for rollback. Verify `/health` and the authenticated
public `/api/v1/models` response after deployment. Avoid running a whole-stack
update script for a catalog-only change.
