# Catalog policy

`catalog.json` is the **local fallback** the CLI uses when the control-plane
endpoint `https://cp.muonroi.com/api/v1/models` is unreachable. The CP catalog
is the source of truth in production. Keep this file conservative: only ship
entries the splash UI is actively maintained for.

Pricing snapshot date: **2026-05-21**. Re-verify quarterly or after any provider
pricing announcement; commit a bump to `version` and `updated_at` when prices
drift > 10%.

## Active providers

Catalog model entries currently ship for:

| Provider | Why it ships | Tool-call support |
|---|---|---|
| `deepseek` | Native API; cheap premium reasoning tier ($0.55/$2.19) | Yes (v4-flash, v4-pro) |
| `xai` | Grok models via OpenAI-compatible API + OAuth subscription | Yes |
| `zai` | GLM family (coding + vision) via the Z.ai coding endpoint | Yes |
| `opencode-go` | OpenCode Go aggregator | Yes |
| `openai` | Static fallback pricing only (not tier-routed by default) | Yes |

## Removed providers (kept in code, dropped from catalog)

The CLI **code** still supports `anthropic`, `openai`, and `ollama` — adapters
live under `src/providers/strategies/`, capability classes in
`src/providers/capabilities.ts`, and the keychain accepts their keys via
`muonroi-cli keys set <provider>`. They were removed from this catalog because:

1. The splash UI hides them, so users would never reach them via tier-routing.
2. Tier-routing fallback (`getModelByTier`) was leaking cross-provider when the
   default provider had no model for a tier — see
   `src/router/decide.ts`. Removing the catalog entries closes that leak more
   aggressively than the runtime guard alone.

Programmatic use of removed providers still works:
- Pass `--model <id>` with an explicit model ID at startup.
- Or push entries via the CP catalog endpoint at runtime.

> Note: the `google` (Gemini/Agy) and `siliconflow` providers were fully
> removed from the codebase — they are no longer valid `ProviderId` values and
> cannot be reintroduced without re-adding the adapters, strategies, and
> capability classes.

## Tier ordering

`getModelByTier(tier, provider)` stops at the first same-provider match, so
order within a tier in `catalog.json` matters. The preferred default for each
tier sits first.

## How to reintroduce a removed provider

1. Add provider id back to `SPLASH_PROVIDERS` in `src/ui/app.tsx`.
2. Add at least one model entry per tier (`fast`/`balanced`/`premium`) to
   `catalog.json` with `"provider": "<id>"`.
3. Verify provider strategy in `src/providers/strategies/<id>.strategy.ts` and
   `src/providers/adapter.test.ts` still cover the id.
4. Update this README.

## How to add a new model

1. Confirm tool-call support if the model will be used in agentic loops. If it
   does not support tool calls, do NOT mark any tier — surface only via
   explicit `--model <id>`.
2. Look up live pricing from the provider's official pricing page.
3. Add the entry with `"provider": "<id>"`. Place it in tier-order: the first
   same-provider match in `getModelByTier` wins.
4. Bump `version` + `updated_at` at the top of `catalog.json`.

## Verification before merge

- `bunx vitest run src/models/__tests__/registry.test.ts` — catalog parses.
- `bunx vitest run src/providers/__tests__/capabilities-cosmetic.test.ts` — capability lookups still resolve.
- Manual TUI smoke: splash shows the active providers, defaulting to one works,
  `/models` modal opens.
