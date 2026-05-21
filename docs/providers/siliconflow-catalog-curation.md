# SiliconFlow catalog curation

Target: control-plane catalog repo (consumed by `src/models/catalog-client.ts`).
Status: proposal — not yet merged.

## Goal

The splash modal exposes only `deepseek` + `siliconflow` providers. When the
user enables both with SiliconFlow as default, the router picks a model by
tier (`fast` / `balanced` / `premium`) via `getModelByTier(tier, "siliconflow")`.

Today the catalog ships **only 2 SiliconFlow entries** (DeepSeek-V4-Flash and
DeepSeek-V4-Pro). That means:

- `getModelByTier("balanced", "siliconflow")` returns `undefined` → the router
  falls through to `defaultModel` (reasoning model handles balanced work,
  paying reasoning tokens for tasks that don't need them).
- No `coding`, `vision`, or fast tool-use options curated per task.

SiliconFlow hosts dozens of models. Pick the strongest per task at the best
price; treat this file as the source of truth for the catalog PR.

## Hard constraints

1. **Only models with documented tool-call support** — per
   `https://docs.siliconflow.com/en/userguide/guides/function-calling.md`
   (verified 2026-05-21):
   - `deepseek-ai/DeepSeek-R1`, `DeepSeek-V3`
   - `Qwen/Qwen2.5-{7B,14B,32B,72B}-Instruct`
   - `THUDM/GLM-Z1-32B-0414`, `GLM-4-32B-0414`, `GLM-4-9B-0414`
   - R1-Distill-Qwen variants (1.5B / 14B / 32B)
2. **`reasoning: true` only when needed** — paying for `reasoning_tokens` on
   throwaway tool-execution turns wastes the per-call output budget.
3. **Same-provider preference holds** — every catalog entry must declare
   `"provider": "siliconflow"` so `getModelByTier(..., "siliconflow")`
   stops at the same-provider match (see `src/models/registry.ts:67-73`).

## Proposed entries

> Pricing is illustrative — verify against the live `/v1/models` endpoint
> before merge. The fields below match the existing catalog schema
> (`src/models/catalog.json`).

### Fast tier — cheap, tool-capable, no reasoning

```json
{
  "id": "Qwen/Qwen2.5-7B-Instruct",
  "name": "Qwen 2.5 7B (SiliconFlow)",
  "provider": "siliconflow",
  "tier": "fast",
  "context_window": 32768,
  "max_output_tokens": 8192,
  "reasoning": false,
  "supports_vision": false,
  "description": "Cheapest tool-capable SF model — use for mechanical tool execution and short replies."
}
```

### Balanced tier — strong general + reliable tool-call JSON

```json
{
  "id": "Qwen/Qwen2.5-72B-Instruct",
  "name": "Qwen 2.5 72B (SiliconFlow)",
  "provider": "siliconflow",
  "tier": "balanced",
  "context_window": 32768,
  "max_output_tokens": 8192,
  "reasoning": false,
  "supports_vision": false,
  "description": "Default balanced pick. Handles most coding + general turns without reasoning overhead."
}
```

Alternative if Qwen 72B is rate-limited: `THUDM/GLM-4-32B-0414` (smaller,
similar tool-call reliability per SiliconFlow's own benchmarks).

### Coding tier — code-specific overrides

```json
{
  "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
  "name": "Qwen 2.5 Coder 32B (SiliconFlow)",
  "provider": "siliconflow",
  "tier": "balanced",
  "context_window": 32768,
  "max_output_tokens": 8192,
  "reasoning": false,
  "supports_vision": false,
  "description": "Coding-tuned Qwen — prefer over Qwen2.5-72B for code-generation phases when token budget matters."
}
```

Router hook needed: if `pil.taskType` is a coding role and provider is
SiliconFlow, prefer Qwen Coder over the generic balanced pick. See
follow-up section.

### Premium tier — reasoning, highest quality

DeepSeek-V4-Pro (already in catalog) covers this slot. If we want a
non-DeepSeek premium option for diversification:

```json
{
  "id": "deepseek-ai/DeepSeek-R1",
  "name": "DeepSeek R1 (SiliconFlow)",
  "provider": "siliconflow",
  "tier": "premium",
  "context_window": 65536,
  "max_output_tokens": 16384,
  "reasoning": true,
  "supports_vision": false,
  "description": "Original DeepSeek R1 — kept for benchmark parity; V4-Pro is usually the better cost/quality trade."
}
```

### Vision tier — when images are involved

```json
{
  "id": "Qwen/Qwen2-VL-72B-Instruct",
  "name": "Qwen 2 VL 72B (SiliconFlow)",
  "provider": "siliconflow",
  "tier": "balanced",
  "context_window": 32768,
  "max_output_tokens": 4096,
  "reasoning": false,
  "supports_vision": true,
  "description": "Vision-language model for image inputs. Verify tool-call support before promoting to default."
}
```

⚠️ Tool-call status for Qwen2-VL is NOT confirmed in SiliconFlow's
function-calling doc — verify with a probe before relying on it for
agentic turns.

## CLI-side follow-ups (separate PR, after catalog lands)

1. **Tier-routing override for coding tasks** — when
   `pil.taskType === "coding"` and provider is SiliconFlow, prefer
   `Qwen/Qwen2.5-Coder-32B-Instruct` over the generic balanced model.
   Hook point: `src/router/decide.ts` Step 0 PIL branch.
2. **Vision-aware routing** — when the user attaches an image, route to
   `Qwen/Qwen2-VL-72B-Instruct`. Hook point: `pickModelForTask` in
   `src/orchestrator/orchestrator.ts:1369`.
3. **Image-URL TTL warning** — SiliconFlow returns image-gen URLs valid
   for 1 hour and video URLs for 10 minutes. If we ever add image-gen
   commands, download immediately or surface the TTL to the user.

## Verification checklist before merging the catalog PR

- [ ] `getModelByTier("fast", "siliconflow")` returns the curated fast model.
- [ ] `getModelByTier("balanced", "siliconflow")` returns the curated balanced model.
- [ ] `getModelByTier("premium", "siliconflow")` returns DeepSeek-V4-Pro (current behavior preserved).
- [ ] `pickCouncilTaskModel` in `src/council/leader.ts` stays same-provider after the new entries land.
- [ ] No new entry has `provider !== "siliconflow"`.
- [ ] Tool-call probe (small `streamText` with one tool) succeeds against each new model id.
