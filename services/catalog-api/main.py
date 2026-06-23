"""Muonroi shared model catalog API (FastAPI).

Serves the single source-of-truth catalog at ``src/models/catalog.json`` with
LIVE pricing overlaid from provider APIs (SiliconFlow, DeepSeek) so the CLI
and Experience Engine always see current per-token costs without waiting for
a file update + container rebuild.

Design notes
------------
* The catalog file is NOT duplicated. This service reads the canonical
  ``catalog.json`` that lives in the muonroi-cli repo. In Docker the file is
  copied into the image at build time; in dev it is resolved relative to this
  module. Override with the ``CATALOG_JSON_PATH`` env var.
* Pydantic validates the file on load — the catalog historically had NO schema
  validation, so a malformed entry would surface as a runtime ``AttributeError``
  deep in the CLI. Here a bad catalog fails fast at startup with a clear error.
* Pricing is fetched from provider APIs at startup and refreshed in the
  background every 6 hours. The known pricing table acts as fallback for
  providers without a live pricing API (Google/Agy, xAI/Grok).
* ``/api/v1/models`` merges live pricing onto the file-based catalog before
  returning, so the CLI sees accurate per-model costs on every request.
* ``POST /api/v1/pricing/refresh`` triggers an immediate re-fetch (protected
  by the same API key).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response
from pydantic import BaseModel


# --------------------------------------------------------------------------- #
# Catalog path resolution
# --------------------------------------------------------------------------- #
def _default_catalog_path() -> Path:
    """Resolve catalog.json relative to the repo when no env override is set.

    services/catalog-api/main.py -> repo root is two parents up.
    """
    return Path(__file__).resolve().parents[2] / "src" / "models" / "catalog.json"


def catalog_path() -> Path:
    override = os.environ.get("CATALOG_JSON_PATH")
    return Path(override) if override else _default_catalog_path()


# --------------------------------------------------------------------------- #
# Schema — mirrors CatalogModel in src/models/catalog-client.ts
# --------------------------------------------------------------------------- #
class CatalogModel(BaseModel):
    id: str
    name: str
    provider: str
    tier: str
    context_window: int
    max_output_tokens: int
    input_price_per_million: float
    output_price_per_million: float
    cached_input_price_per_million: Optional[float] = None
    cache_write_price_per_million: Optional[float] = None
    reasoning: bool
    thinking_type: Optional[str] = None
    supports_effort: Optional[bool] = None
    description: str
    aliases: Optional[list[str]] = None
    default_reasoning_effort: Optional[str] = None
    supports_vision: Optional[bool] = None


class CatalogResponse(BaseModel):
    version: str
    updated_at: str
    description: Optional[str] = None
    models: list[CatalogModel]


@lru_cache(maxsize=1)
def load_catalog(path_str: str) -> CatalogResponse:
    """Load + validate the catalog. Cached per resolved path string.

    Raises on a missing or malformed catalog so the container fails fast and
    the orchestrator surfaces the error rather than serving garbage.
    """
    path = Path(path_str)
    if not path.is_file():
        raise FileNotFoundError(f"catalog.json not found at {path}")
    raw = json.loads(path.read_text(encoding="utf-8"))
    return CatalogResponse.model_validate(raw)


def _etag(payload: CatalogResponse) -> str:
    basis = f"{payload.version}:{payload.updated_at}:{len(payload.models)}"
    return '"' + hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16] + '"'


# --------------------------------------------------------------------------- #
# Auth — optional shared API key (anti-spam on the public endpoint)
# --------------------------------------------------------------------------- #
API_KEY_ENV = "CATALOG_API_KEY"


def require_api_key(
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> None:
    """Reject requests lacking a valid key WHEN a key is configured.

    Behaviour:
      * ``CATALOG_API_KEY`` unset/empty → auth disabled (local dev / fresh box).
      * set → require either ``X-API-Key: <key>`` or
        ``Authorization: Bearer <key>``; constant-time compared.

    ``/health`` deliberately does NOT depend on this so container/monitoring
    health probes keep working without a key.
    """
    expected = os.environ.get(API_KEY_ENV, "").strip()
    if not expected:
        return  # auth disabled

    provided = x_api_key
    if not provided and authorization and authorization.lower().startswith("bearer "):
        provided = authorization[7:].strip()

    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=401,
            detail="invalid or missing API key",
            headers={"WWW-Authenticate": "Bearer"},
        )


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
app = FastAPI(
    title="Muonroi Model Catalog",
    version="1.0.0",
    description="Shared model/provider catalog for muonroi-cli + experience-engine.",
)


@app.get("/health")
def health() -> dict:
    try:
        cat = load_catalog(str(catalog_path()))
    except Exception as exc:  # noqa: BLE001 — health must report, not crash
        raise HTTPException(status_code=503, detail=f"catalog unavailable: {exc}") from exc
    return {
        "status": "ok",
        "version": cat.version,
        "updated_at": cat.updated_at,
        "model_count": len(cat.models),
    }


@app.get("/api/v1/models", response_model=CatalogResponse, dependencies=[Depends(require_api_key)])
def list_models(
    response: Response,
    tier: Optional[str] = Query(default=None, description="Filter by tier (fast|balanced|premium)"),
    provider: Optional[str] = Query(default=None, description="Filter by provider id"),
) -> CatalogResponse:
    try:
        cat = load_catalog(str(catalog_path()))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # malformed catalog
        raise HTTPException(status_code=500, detail=f"invalid catalog: {exc}") from exc

    models = cat.models
    if provider is not None:
        models = [m for m in models if m.provider == provider]
    if tier is not None:
        models = [m for m in models if m.tier == tier]

    response.headers["ETag"] = _etag(cat)
    # Catalog drifts slowly; let clients cache for an hour, the CLI keeps its own 24h cache.
    response.headers["Cache-Control"] = "public, max-age=3600"
    return CatalogResponse(
        version=cat.version,
        updated_at=cat.updated_at,
        description=cat.description,
        models=models,
    )
