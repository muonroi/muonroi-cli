# Catalog policy

`catalog.json` is the **local fallback** the CLI uses when the control-plane
endpoint `https://cp.muonroi.com/api/v1/models` is unreachable. The CP catalog
is the source of truth in production. Keep this file conservative: only ship
entries the splash UI is actively maintained for.

Pricing snapshot date: **2026-05-21** (verified against
`https://www.siliconflow.com/models`). Re-verify quarterly or after any SF
pricing announcement; commit a bump to `version` and `updated_at` when prices
drift > 10%.

## Active providers

| Provider | Why it ships | Tool-call support |
|---|---|---|
| `deepseek` | Native API; cheapest premium reasoning tier ($0.55/$2.19) | Yes (v4-flash, v4-pro) |
| `siliconflow` | Aggregates DeepSeek + Qwen + GLM + others. Cheapest fast/balanced + widest tool-capable selection. | Yes (per SF function-calling whitelist) |

## Curated tier × purpose map (active providers)

| Slot | Model | Provider | Pricing ($/M in/out) | Notes |
|---|---|---|---|---|
| **fast** | `Qwen/Qwen3-8B` | siliconflow | 0.06 / 0.06 | Cheapest tool-capable. Mechanical tool-execution default. |
| fast (DS) | `deepseek-ai/DeepSeek-V4-Flash` | siliconflow | 0.14 / 0.28 | Reasoning-capable fast; use when CoT helps. |
| fast (native) | `deepseek-v4-flash` | deepseek | 0.27 / 1.1 | Native fallback when SF rate-limited. |
| **balanced** | `Qwen/Qwen3-30B-A3B-Instruct-2507` | siliconflow | 0.09 / 0.30 | MoE default for general turns. |
| balanced (code) | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | siliconflow | 0.07 / 0.28 | Coding-tuned. Router override pending. |
| balanced (reasoning) | `deepseek-ai/DeepSeek-V3.2` | siliconflow | 0.27 / 0.42 | Cheap CoT when needed. |
| balanced (vision) | `z-ai/GLM-4.6V` | siliconflow | 0.30 / 0.90 | Only vision model with confirmed function-calling. |
| **premium** | `deepseek-v4-pro` | deepseek | 0.55 / 2.19 | Native premium — cheaper than SF-hosted. |
| premium (SF) | `deepseek-ai/DeepSeek-V4-Pro` | siliconflow | 1.74 / 3.48 | Use only when native key unavailable. |
| premium (alt) | `deepseek-ai/DeepSeek-R1` | siliconflow | 0.50 / 2.18 | Cheaper R1 fallback to V4-Pro. |

`getModelByTier(tier, "siliconflow")` stops at the first same-provider match,
so order within a tier in `catalog.json` matters. Preferred default for each
tier sits first.

## Removed providers (kept in code, dropped from catalog)

The CLI **code** still supports `anthropic`, `openai`, `google`, `xai`, and
`ollama` — adapters live under `src/providers/strategies/`, capability classes
in `src/providers/capabilities.ts`, and the keychain accepts their keys via
`muonroi-cli keys set <provider>`. They were removed from this catalog because:

1. The splash UI hides them, so users would never reach them via tier-routing.
2. Tier-routing fallback (`getModelByTier`) was leaking cross-provider when the
   default provider had no model for a tier — see
   `src/router/decide.ts:354-381`. Removing the catalog entries closes that
   leak more aggressively than the runtime guard alone.
3. Pricing/quality vs DeepSeek + SF's curated Qwen line is not competitive at
   this snapshot.

Programmatic use of removed providers still works:
- Pass `--model <id>` with an explicit model ID at startup.
- Or push entries via the CP catalog endpoint at runtime.

## Why SF-via-aggregator instead of a single model

SF hosts ~50+ models across categories. The optimization principle:

- **Modality-first routing**: vision → GLM-4.6V; coding → Qwen3-Coder;
  reasoning → V4-Pro / R1; mechanical text → Qwen3-8B.
- **Tier within modality**: each modality has its own fast/balanced/premium
  ladder so cost matches task difficulty.
- **Tool-call whitelist gate**: SF lists tool-capable models explicitly
  (`https://docs.siliconflow.com/en/userguide/guides/function-calling.md`).
  Any model not on that whitelist must never be picked when `tools.length > 0`.
- **SAMR (step-router) is the leverage**: phase 1 reasoning on V4-Pro
  ($0.55/$2.19) → phase 2 execution on Qwen3-8B ($0.06/$0.06) = ~20× cost
  reduction per turn. Currently OFF by default — enable via
  `stepRouter.enabled=true` + `MUONROI_STEP_ROUTER_ACK=1`.

## Out of catalog scope

These exist on SF but aren't chat-completion models — they need their own
registry / flow rather than catalog entries:

| Category | Best pick | Pricing |
|---|---|---|
| Embedding | `Qwen/Qwen3-Embedding-0.6B` | $0.01/M tokens |
| Rerank | `Qwen/Qwen3-Reranker-0.6B` | $0.01/M tokens |
| TTS | `FunAudioLLM/CosyVoice2-0.5B` | $7.15/M UTF-8 bytes |
| Image gen | `tongyi-mai/Z-Image-Turbo` | $0.005/image |
| Video gen | `Wan-AI/Wan2.2-T2V-A14B` | $0.29/video |

Async modality (image/video) returns URLs that expire (image 1h, video 10min)
— if/when we add `/image` or `/video` slash commands they must download
immediately. See `docs/providers/siliconflow-catalog-curation.md` for the
async-flow design.

## How to reintroduce a removed provider

1. Add provider id back to `SPLASH_PROVIDERS` in `src/ui/app.tsx`.
2. Add at least one model entry per tier (`fast`/`balanced`/`premium`) to
   `catalog.json` with `"provider": "<id>"`.
3. Verify provider strategy in `src/providers/strategies/<id>.strategy.ts` and
   `src/providers/adapter.test.ts` still cover the id.
4. Update this README + `docs/providers/siliconflow-catalog-curation.md`.

## How to add a new SiliconFlow model

1. Confirm tool-call support from
   `https://docs.siliconflow.com/en/userguide/guides/function-calling.md` if
   the model will be used in agentic loops. If not on whitelist, do NOT mark
   any tier — surface only via explicit `--model <id>`.
2. Look up live pricing at `https://www.siliconflow.com/models`. Treat the SF
   `/v1/models` endpoint as authoritative.
3. Add the entry with `"provider": "siliconflow"`. Place it in tier-order: the
   first same-provider match in `getModelByTier` wins.
4. Bump `version` + `updated_at` at the top of `catalog.json`.

## Verification before merge

- `bunx vitest run src/models/__tests__/registry.test.ts` — catalog parses.
- `bunx vitest run src/providers/__tests__/capabilities-cosmetic.test.ts` — capability lookups still resolve.
- `bunx vitest run src/router/__tests__/step-router.test.ts` — tier-routing picks a model for every tier on both deepseek + siliconflow.
- Manual TUI smoke: splash shows only deepseek + siliconflow, defaulting to either works, `/models` modal opens.

## Known follow-ups

- Router vision-override: when turn has image input, prefer `z-ai/GLM-4.6V`
  over the generic balanced model. Hook point: `pickModelForTask` in
  `src/orchestrator/orchestrator.ts:1369`.
- Router coding-override: when `pil.taskType === "coding"` and provider is SF,
  prefer `Qwen/Qwen3-Coder-30B-A3B-Instruct`. Hook point:
  `src/router/decide.ts` Step 0 PIL branch.
- Tool-call safety gate: before any model selection, if `tools.length > 0`,
  drop any candidate not on SF's function-calling whitelist.
- SAMR default-on: when default provider is SF + Qwen3-8B is in catalog,
  enable step-router so phase 1 reasoning routes to premium and phase 2
  execution to Qwen3-8B.
- `muonroi-cli models refresh --provider siliconflow` probe command that hits
  `GET /v1/models` with the user's key and refreshes the local catalog.
- Embedding / rerank / TTS / image / video registries (separate flows, not
  chat catalog).
