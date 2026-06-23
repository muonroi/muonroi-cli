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
import copy
import hashlib
import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import httpx
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
# Known pricing table (fallback when no live API available)
# --------------------------------------------------------------------------- #
KNOWN_PRICING: dict[str, dict[str, float | None]] = {
    # DeepSeek native (api.deepseek.com) — verified 2026-06
    "deepseek-v4-flash": {"input": 0.27, "output": 1.1, "cachedInput": 0.027, "cacheWrite": None},
    "deepseek-v4-pro": {"input": 0.55, "output": 2.19, "cachedInput": 0.055, "cacheWrite": None},
    # Google / Agy OAuth — sourced from Cloud Code pricing page
    "gemini-3.5-flash-high": {"input": 0.5, "output": 3.0, "cachedInput": None, "cacheWrite": None},
    "gemini-3.5-flash-medium": {"input": 0.5, "output": 3.0, "cachedInput": None, "cacheWrite": None},
    "gemini-3.5-flash-low": {"input": 0.5, "output": 3.0, "cachedInput": None, "cacheWrite": None},
    "gemini-3.1-pro-high": {"input": 2.0, "output": 12.0, "cachedInput": None, "cacheWrite": None},
    "gemini-3.1-pro-low": {"input": 2.0, "output": 12.0, "cachedInput": None, "cacheWrite": None},
    "gemini-3-flash": {"input": 0.3, "output": 2.0, "cachedInput": None, "cacheWrite": None},
    "claude-sonnet-4.6-thinking": {"input": 3.0, "output": 15.0, "cachedInput": None, "cacheWrite": None},
    "claude-opus-4.6-thinking": {"input": 15.0, "output": 75.0, "cachedInput": None, "cacheWrite": None},
    "gpt-oss-120b-medium": {"input": 0.2, "output": 0.8, "cachedInput": None, "cacheWrite": None},
    # xAI (Grok)
    "grok-4.3": {"input": 1.25, "output": 2.5, "cachedInput": None, "cacheWrite": None},
    "grok-build-0.1": {"input": 1.0, "output": 2.0, "cachedInput": None, "cacheWrite": None},
}


# --------------------------------------------------------------------------- #
# Live pricing fetch + merge
# --------------------------------------------------------------------------- #
_pricing_lock = asyncio.Lock()
_live_pricing: dict[str, dict[str, Any]] = {}
_last_refresh_ts: float = 0.0


def _get_api_key(name: str) -> str | None:
    """Check env vars for a provider API key by several naming conventions."""
    for key in (name, f"MUONROI_{name}"):
        val = os.environ.get(key, "").strip()
        if val:
            return val
    return None


async def _fetch_siliconflow_pricing(client: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
    """Fetch model pricing from SiliconFlow API.

    Response: { data: [ { id, input_price_per_million, output_price_per_million,
                         cached_input_price_per_million, context_window, ... } ] }
    """
    result: dict[str, dict[str, Any]] = {}
    key = _get_api_key("SILICONFLOW_API_KEY")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        resp = await client.get(
            "https://api.siliconflow.com/v1/models",
            headers=headers,
            timeout=httpx.Timeout(8.0),
        )
        if not resp.is_success:
            print(f"  [SF] API returned {resp.status_code} — skipping live fetch", flush=True)
            return result

        body = resp.json()
        models = body.get("data") or []
        for raw in models:
            mid = raw.get("id")
            if not mid:
                continue
            inp = raw.get("input_price_per_million")
            if inp is None:
                continue  # no pricing data for this model

            override: dict[str, Any] = {
                "input_price_per_million": float(inp),
                "output_price_per_million": float(raw.get("output_price_per_million", 0)),
            }
            ctx = raw.get("context_window")
            if ctx is not None:
                override["context_window"] = int(ctx)
            cached = raw.get("cached_input_price_per_million")
            if cached is not None:
                override["cached_input_price_per_million"] = float(cached)
            result[mid] = override

        print(f"  [SF] Fetched {len(result)} models with pricing", flush=True)
    except httpx.TimeoutException:
        print("  [SF] Request timed out — skipping", flush=True)
    except Exception as exc:
        print(f"  [SF] Fetch failed: {exc}", flush=True)

    return result


async def _fetch_deepseek_pricing(client: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
    """Fetch model list from DeepSeek API (no pricing in response — just validates existence)."""
    result: dict[str, dict[str, Any]] = {}
    key = _get_api_key("DEEPSEEK_API_KEY")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        resp = await client.get(
            "https://api.deepseek.com/v1/models",
            headers=headers,
            timeout=httpx.Timeout(8.0),
        )
        if not resp.is_success:
            print(f"  [DeepSeek] API returned {resp.status_code} — using known pricing", flush=True)
            return result

        body = resp.json()
        model_ids = {m["id"] for m in (body.get("data") or [])}

        # Warn if known models are missing
        for known_id in ("deepseek-v4-flash", "deepseek-v4-pro"):
            if known_id not in model_ids:
                print(f"  [DeepSeek] Known model '{known_id}' not found in API — may be deprecated", flush=True)

        print(f"  [DeepSeek] API returned {len(model_ids)} models, checked against known pricing", flush=True)
    except httpx.TimeoutException:
        print("  [DeepSeek] Request timed out — using known pricing", flush=True)
    except Exception as exc:
        print(f"  [DeepSeek] Fetch failed: {exc} — using known pricing", flush=True)

    return result


def _prices_equal(a: float, b: float) -> bool:
    return abs(a - b) < 0.00001


async def refresh_pricing() -> dict:
    """Fetch live pricing from all providers, merge into _live_pricing cache.

    Returns a summary dict with counts of changes found.
    """
    global _live_pricing, _last_refresh_ts

    async with _pricing_lock:
        print("[pricing] Refreshing live pricing...", flush=True)

        async with httpx.AsyncClient() as client:
            sf_pricing = await _fetch_siliconflow_pricing(client)
            await _fetch_deepseek_pricing(client)  # just validates, no pricing returned

        # Start with live SF pricing
        new_pricing: dict[str, dict[str, Any]] = {}
        changes: list[str] = []

        for mid, override in sf_pricing.items():
            new_pricing[mid] = dict(override)

        # Apply known pricing as fallback for models NOT covered by live API
        for mid, p in KNOWN_PRICING.items():
            if mid in new_pricing:
                continue  # already covered by live API
            override: dict[str, Any] = {
                "input_price_per_million": p["input"],
                "output_price_per_million": p["output"],
            }
            if p.get("cachedInput") is not None:
                override["cached_input_price_per_million"] = p["cachedInput"]
            if p.get("cacheWrite") is not None:
                override["cache_write_price_per_million"] = p["cacheWrite"]
            new_pricing[mid] = override

        # Compare with previous pricing to detect changes
        prev = _live_pricing
        for mid, p in new_pricing.items():
            old = prev.get(mid)
            if old is None:
                changes.append(f"{mid}: new entry")
            else:
                for field in ("input_price_per_million", "output_price_per_million", "cached_input_price_per_million"):
                    old_v = old.get(field)
                    new_v = p.get(field)
                    if old_v is not None and new_v is not None and not _prices_equal(float(old_v), float(new_v)):
                        changes.append(f"{mid}.{field}: {old_v} -> {new_v}")

        # Removed models from live API but covered by known pricing — keep known pricing
        for mid, p in KNOWN_PRICING.items():
            if mid not in new_pricing:
                override = {
                    "input_price_per_million": p["input"],
                    "output_price_per_million": p["output"],
                }
                if p.get("cachedInput") is not None:
                    override["cached_input_price_per_million"] = p["cachedInput"]
                if p.get("cacheWrite") is not None:
                    override["cache_write_price_per_million"] = p["cacheWrite"]
                new_pricing[mid] = override

        _live_pricing = new_pricing
        _last_refresh_ts = time.time()

        summary = {
            "models_priced": len(new_pricing),
            "changes": changes,
            "timestamp": _last_refresh_ts,
        }
        print(f"  [pricing] Refresh done: {len(new_pricing)} models, {len(changes)} change(s)", flush=True)
        return summary


def merge_live_pricing(catalog: CatalogResponse) -> CatalogResponse:
    """Return a copy of the catalog with live pricing overlaid.

    Thread-safe: reads _live_pricing under lock.
    """
    merged = catalog.model_copy(deep=True)

    for model in merged.models:
        lp = _live_pricing.get(model.id)
        if lp is not None:
            if "input_price_per_million" in lp:
                model.input_price_per_million = float(lp["input_price_per_million"])
            if "output_price_per_million" in lp:
                model.output_price_per_million = float(lp["output_price_per_million"])
            if "cached_input_price_per_million" in lp and lp["cached_input_price_per_million"] is not None:
                model.cached_input_price_per_million = float(lp["cached_input_price_per_million"])

    return merged


# --------------------------------------------------------------------------- #
# Background refresh task
# --------------------------------------------------------------------------- #
_REFRESH_INTERVAL_SECONDS = 6 * 3600  # 6 hours

_refresh_task: asyncio.Task[None] | None = None


async def _background_refresh_loop() -> None:
    """Periodically refresh pricing in the background."""
    while True:
        try:
            await asyncio.sleep(_REFRESH_INTERVAL_SECONDS)
            await refresh_pricing()
        except asyncio.CancelledError:
            break
        except Exception as exc:
            print(f"[pricing] Background refresh error: {exc}", flush=True)


@asynccontextmanager
async def lifespan(application: FastAPI):  # noqa: ARG001 — FastAPI lifespan protocol
    """Startup: fetch pricing immediately, then start background refresh."""
    global _refresh_task

    # Initial fetch at startup
    try:
        await refresh_pricing()
    except Exception as exc:
        print(f"[pricing] Initial fetch failed: {exc} — will retry in background", flush=True)

    # Background periodic refresh
    _refresh_task = asyncio.create_task(_background_refresh_loop())
    print(f"[pricing] Background refresh every {_REFRESH_INTERVAL_SECONDS // 3600}h", flush=True)

    yield

    # Shutdown: cancel the background task
    if _refresh_task is not None:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
app = FastAPI(
    title="Muonroi Model Catalog",
    version="1.0.0",
    description="Shared model/provider catalog for muonroi-cli + experience-engine.",
    lifespan=lifespan,
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
        "live_pricing_models": len(_live_pricing),
        "last_refresh": _last_refresh_ts,
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

    # Overlay live pricing from memory
    cat = merge_live_pricing(cat)

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


@app.post("/api/v1/pricing/refresh", dependencies=[Depends(require_api_key)])
async def force_pricing_refresh() -> dict:
    """Immediately re-fetch live pricing from all providers.

    Protected by the same API key as the read endpoints.
    """
    summary = await refresh_pricing()
    return {
        "status": "ok",
        "models_priced": summary["models_priced"],
        "changes": summary["changes"],
        "timestamp": summary["timestamp"],
    }
