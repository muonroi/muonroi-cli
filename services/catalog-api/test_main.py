"""Tests for the catalog API. Run: pytest services/catalog-api/ -q"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main as catalog_main


@pytest.fixture(autouse=True)
def _reset_cache():
    catalog_main.load_catalog.cache_clear()
    yield
    catalog_main.load_catalog.cache_clear()


@pytest.fixture
def client(monkeypatch, tmp_path: Path) -> TestClient:
    catalog = {
        "version": "9.9",
        "updated_at": "2026-06-06",
        "description": "test catalog",
        "models": [
            {
                "id": "alpha-fast",
                "name": "Alpha Fast",
                "provider": "acme",
                "tier": "fast",
                "context_window": 128000,
                "max_output_tokens": 8000,
                "input_price_per_million": 0.1,
                "output_price_per_million": 0.2,
                "reasoning": False,
                "description": "fast one",
            },
            {
                "id": "beta-premium",
                "name": "Beta Premium",
                "provider": "acme",
                "tier": "premium",
                "context_window": 200000,
                "max_output_tokens": 16000,
                "input_price_per_million": 1.0,
                "output_price_per_million": 2.0,
                "reasoning": True,
                "thinking_type": "enabled",
                "supports_effort": True,
                "default_reasoning_effort": "low",
                "description": "premium one",
                "aliases": ["beta"],
            },
            {
                "id": "gamma-fast",
                "name": "Gamma Fast",
                "provider": "globex",
                "tier": "fast",
                "context_window": 64000,
                "max_output_tokens": 4000,
                "input_price_per_million": 0.05,
                "output_price_per_million": 0.1,
                "reasoning": False,
                "description": "other provider",
            },
        ],
    }
    p = tmp_path / "catalog.json"
    p.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setenv("CATALOG_JSON_PATH", str(p))
    return TestClient(catalog_main.app)


def test_health_ok(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"] == "9.9"
    assert body["model_count"] == 3


def test_list_models_full(client: TestClient):
    r = client.get("/api/v1/models")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == "9.9"
    assert body["updated_at"] == "2026-06-06"
    assert len(body["models"]) == 3
    assert r.headers.get("ETag")
    assert "max-age" in r.headers.get("Cache-Control", "")
    # optional fields preserved
    beta = next(m for m in body["models"] if m["id"] == "beta-premium")
    assert beta["aliases"] == ["beta"]
    assert beta["supports_effort"] is True


def test_filter_by_provider(client: TestClient):
    r = client.get("/api/v1/models", params={"provider": "acme"})
    assert r.status_code == 200
    ids = {m["id"] for m in r.json()["models"]}
    assert ids == {"alpha-fast", "beta-premium"}


def test_filter_by_tier(client: TestClient):
    r = client.get("/api/v1/models", params={"tier": "fast"})
    ids = {m["id"] for m in r.json()["models"]}
    assert ids == {"alpha-fast", "gamma-fast"}


def test_filter_by_provider_and_tier(client: TestClient):
    r = client.get("/api/v1/models", params={"provider": "acme", "tier": "fast"})
    ids = {m["id"] for m in r.json()["models"]}
    assert ids == {"alpha-fast"}


def test_missing_catalog_returns_503(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("CATALOG_JSON_PATH", str(tmp_path / "does-not-exist.json"))
    catalog_main.load_catalog.cache_clear()
    c = TestClient(catalog_main.app, raise_server_exceptions=False)
    r = c.get("/api/v1/models")
    assert r.status_code == 503


def test_malformed_catalog_rejected(monkeypatch, tmp_path: Path):
    bad = tmp_path / "bad.json"
    # missing required fields (provider, tier, prices ...)
    bad.write_text(json.dumps({"version": "1", "updated_at": "x", "models": [{"id": "x"}]}), encoding="utf-8")
    monkeypatch.setenv("CATALOG_JSON_PATH", str(bad))
    catalog_main.load_catalog.cache_clear()
    c = TestClient(catalog_main.app, raise_server_exceptions=False)
    r = c.get("/api/v1/models")
    assert r.status_code == 500


def test_no_auth_required_when_key_unset(client: TestClient, monkeypatch):
    monkeypatch.delenv("CATALOG_API_KEY", raising=False)
    r = client.get("/api/v1/models")
    assert r.status_code == 200


def test_auth_rejects_missing_key(client: TestClient, monkeypatch):
    monkeypatch.setenv("CATALOG_API_KEY", "s3cret")
    r = client.get("/api/v1/models")
    assert r.status_code == 401


def test_auth_rejects_wrong_key(client: TestClient, monkeypatch):
    monkeypatch.setenv("CATALOG_API_KEY", "s3cret")
    r = client.get("/api/v1/models", headers={"X-API-Key": "nope"})
    assert r.status_code == 401


def test_auth_accepts_x_api_key(client: TestClient, monkeypatch):
    monkeypatch.setenv("CATALOG_API_KEY", "s3cret")
    r = client.get("/api/v1/models", headers={"X-API-Key": "s3cret"})
    assert r.status_code == 200
    assert len(r.json()["models"]) == 3


def test_auth_accepts_bearer(client: TestClient, monkeypatch):
    monkeypatch.setenv("CATALOG_API_KEY", "s3cret")
    r = client.get("/api/v1/models", headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200


def test_health_open_even_with_key(client: TestClient, monkeypatch):
    monkeypatch.setenv("CATALOG_API_KEY", "s3cret")
    r = client.get("/health")
    assert r.status_code == 200  # health must not require the key


def test_real_catalog_validates():
    """The actual shipped catalog.json must satisfy the pydantic schema."""
    real = Path(__file__).resolve().parents[2] / "src" / "models" / "catalog.json"
    catalog_main.load_catalog.cache_clear()
    cat = catalog_main.load_catalog(str(real))
    assert len(cat.models) > 0
    assert cat.version


def test_real_catalog_zai_flash_excluded_from_tier_routing(monkeypatch):
    """glm-4.7-flash must carry tier_routing=false so CLI compaction skips the free pool."""
    real = Path(__file__).resolve().parents[2] / "src" / "models" / "catalog.json"
    monkeypatch.setenv("CATALOG_JSON_PATH", str(real))
    catalog_main.load_catalog.cache_clear()
    cat = catalog_main.load_catalog(str(real))
    flash = next(m for m in cat.models if m.id == "glm-4.7-flash")
    assert flash.tier_routing is False
    g47 = next(m for m in cat.models if m.id == "glm-4.7")
    assert g47.tier == "balanced"
    assert g47.routing_tiers == ["fast"]
