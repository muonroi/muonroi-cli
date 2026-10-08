# Catalog policy

`src/models/catalog.json` is the canonical dataset. FastAPI copies it into its
Docker image and serves `https://catalog.muonroi.com/api/v1/models`. The CLI
uses that endpoint, a 24-hour local cache, and this bundled file as fallback.
Override with `MUONROI_CATALOG_URL`; protected catalogs require
`MUONROI_CATALOG_API_KEY`.

OpenAI and Anthropic snapshot: **2026-10-08**, catalog **2.20**. Other providers
retain their existing verification dates. Active providers: `openai`,
`anthropic`, `deepseek`, `zai`, `opencode-go`, `xai`, and `stepfun`.

## Current tier defaults

| Provider | Fast | Balanced | Premium |
|---|---|---|---|
| OpenAI | GPT-6 Luna | GPT-6.1 Sol | GPT-6 Astra |
| Anthropic | Claude Haiku 5.5 | Claude Sonnet 5.5 | Claude Opus 5.5 |

GPT-6 Sol and Claude Fable 5.1 also remain selectable. Existing canonical IDs
and version-specific aliases remain selectable; legacy rows have
`tier_routing: false`. Short Claude aliases follow the current family version.
Tier routing uses the first eligible same-provider row in array order.

## Contracts and pricing

Use official [OpenAI model pages](https://developers.openai.com/api/docs/models)
and [Claude model pages](https://platform.claude.com/docs/en/models/overview).
Verify ID, context/output limits, modalities, tool support, thinking mode,
default effort, and standard USD/MTok input/output/cache rates together.
Reasoning OpenAI tool calls use Responses; adaptive Claude requests use
`thinking.type=adaptive`, with effort when supported.

Prices in new rows are standard API list prices. OAuth/subscription availability
and billing depend on the account; adding a row does not grant access.
`cache_write_price_per_million` records the standard 5-minute write rate.

`long_context_pricing` is optional. Above `input_token_threshold` (strictly
greater), `input_multiplier` scales uncached input, cache reads and cache
writes; `output_multiplier` scales output for the **entire request**. Current
GPT-6 models use 272K/2x input/1.5x output. Haiku 5.5 uses 100K/5x all rates.
Cost projections apply this per request, including cached input in prompt size;
aggregated sprint volume must not trigger a request surcharge.

## Updating and verification

Add verified rows before legacy rows for that provider, keep aliases unique,
and bump `version`/`updated_at`. Declare `modalities` and `native_web_research`
explicitly. Keep FastAPI Pydantic and CLI Zod/runtime mappings aligned.

Run catalog/registry/pricing/provider contract tests, FastAPI tests, build and
typecheck. For picker/routing workflows, run native selfverify. Deploy only
catalog and verify the public endpoint and CLI validation of its response.
Existing CLI caches can take 24 hours to refresh.
