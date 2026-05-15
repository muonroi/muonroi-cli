# Phase 19: Model Picker UX & Per-Model Disable — Context

## Problem Summary

Three independent problems are being solved together because they share the same data path
(`disabledModels` setting → router → UI):

1. **Router bug** — `resolveExecutionModel()` in `src/router/step-router.ts` returns a
   same-provider candidate without checking if its provider is disabled OR if the specific
   model is disabled. Cross-provider branch already checks `isProviderDisabled`. Symmetry is
   broken.

2. **Slash picker UX** — `ModelPickerModal` in `src/ui/app.tsx` shows a flat list with only
   name + reasoning effort. No tier badges, no capability indicators, no per-model toggle,
   and provider-chip toggling doesn't trigger a `filteredModels` recompute (bug).

3. **Per-model disable** — `disabledProviders: ProviderId[]` exists in settings but there is
   no `disabledModels: string[]` parallel. Users cannot disable specific models (e.g.,
   `gpt-4o-mini`) without disabling the entire OpenAI provider.

## Key Files

| File | Role |
|------|------|
| `src/router/step-router.ts` L162–181 | `resolveExecutionModel()` — has the bug |
| `src/utils/settings.ts` L893–914 | `getDisabledProviders`, `isProviderDisabled`, `setProviderDisabled` — parallel helpers needed |
| `src/ui/app.tsx` L7588–7725 | `ModelPickerModal` component — UX improvements |
| `src/ui/app.tsx` L1182–1195 | `modelList` / `filteredModels` memo — needs `disabledModels` awareness |
| `src/ui/app.tsx` L4442–4456 | Provider chip toggle handler — doesn't invalidate `filteredModels` |
| `src/ui/theme.ts` | Color tokens — use these, no inline hex |
| `src/cli/config/index.ts` | Main config menu — add "Models" entry |
| `src/cli/config/screen-providers.ts` | Pattern to follow for `screen-models.ts` |
| `src/models/registry.ts` | `getModelsForProvider`, `MODELS`, `ModelInfo` |
| `tests/harness/helpers.ts` | `spawnHarness()` — used by E2E specs |

## ModelInfo Fields Relevant to UX

```ts
interface ModelInfo {
  id: string;
  name: string;
  tier?: "fast" | "balanced" | "premium";
  reasoning: boolean;
  supportsVision?: boolean;
  provider?: string;
  // ...
}
```

## Constraints

- Do NOT touch `src/providers/auth/`, OAuth files, `src/cli/keys.ts`
- Do NOT modify `Semantic` component or harness internals
- Use `theme.ts` color tokens — no inline hex strings
- No push, no `--no-verify`
- ANSI escape codes for the CLI config screen come from `src/cli/config/tui.ts` (`A.*`)

## Settings Migration Strategy

`disabledModels` is a new optional field. `getDisabledModels()` returns `[]` when missing.
Existing `user-settings.json` files without this field continue to work unchanged.

## filteredModels Bug Root Cause

`filteredModels` is a plain `const` derived value (not `useMemo`) in `app.tsx` L1188–1194:
```ts
const filteredModels = modelSearchQuery ? modelList.filter(...) : [...modelList];
```
`modelList` itself IS a `useMemo` keyed on `[activeProviders, configuredProviders.length]`.
When `disabledProviders` changes via `toggleProviderEnabled`, the `activeProviders` memo
updates, which updates `modelList`, which causes `filteredModels` to recompute — the memo
chain should already work. However `disabledModels` is NOT currently in `modelList`'s
dependency array. After adding `disabledModels` to state and including it in `modelList`
filtering, the recompute chain will be complete.

## Semantic Wrapping Required

Per CLAUDE.md, new UI elements must be wrapped with `<Semantic>`:
- Modal root: `id="model-picker"` `role="dialog"` `isModal`
- Per-row: `id="model-row-{model.id}"` `role="listitem"` `selected={i === selectedIndex}` `disabled={isModelDisabled(m.id)}`
- Provider chip: `id="provider-chip-{provider}"` `role="button"` `selected={!disabledProviders.includes(p)}`

## Where Semantic Lives

`src/agent-harness/semantic.tsx` is DELETED in this branch (git status shows it in `D`
deleted files). The `Semantic` component was extracted to `packages/agent-harness-react/`.
Import path: check `packages/agent-harness-react/src/` or use whatever path existing
wrappers in `app.tsx` use. **Do not modify the component itself.**
