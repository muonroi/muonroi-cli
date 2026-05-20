# Harness Skips Audit — 2026-05-20

## Executive Summary

The `tests/harness/**` suite currently contains 12 skipped/todo/conditional tests across 8 files. Out of 37 spec files, the skip ratio is 24.3% (well under the 40% lint threshold), and every skipped test is accounted for in `scripts/.harness-skips-allow.json` (10 entries) or via documented `describe.skipIf` env gates (2 entries). The dominant blockers are upstream pipeline issues: the council/loop orchestrator (`src/council/orchestrator.ts`, `src/product-loop/loop-driver.ts`) rejects mock-llm fixture JSON, gating 5 specs across `askcard`, `council-flow`, and `ideal`. Three further specs are blocked on TUI affordances that simply do not exist yet (scrollable listbox with `props.scrollTop`, modal dialog with focus-restore semantics for `/council`). Two specs are environmentally gated (`ideal-e2e-live`, `init-new-ee-design`) — these are correct as written and should remain `skipIf`. One leak spec (`cost-leak-f1-tui`) needs a provider-id override in the mock-llm path. One `ee-timeout` spec needs an env-based EE base-URL override. **Recommended:** keep all skips as-is; file two narrow tickets (mock-llm fixture coverage for council pipeline; UI affordances for scroll/modal) to unblock the largest cluster. No spec should be unskipped today without an upstream fix landing first.

## Counts by Blocker Group

| Blocker Group | Count |
|---|---|
| Council/loop orchestrator rejects mock-llm fixture | 5 |
| TUI affordance not yet exposed (scroll/modal) | 3 |
| Environment-gated (live LLM / live EE server) | 2 |
| Mock-llm provider-id override missing | 1 |
| EE base-URL not env-overridable in spawned TUI | 1 |
| **Total** | **12** |

## Detailed Inventory

| File | Line | Test | Type | Blocker Group | Recommended Action |
|---|---|---|---|---|---|
| `tests/harness/askcard.spec.ts` | 34 | council question modal appears and is observable | `it.skip` | Council orchestrator rejects mock fixture | Keep skipped — linked in allowlist; unblock requires instrumenting `src/council/orchestrator.ts` phase pipeline |
| `tests/harness/askcard.spec.ts` | 53 | can navigate askcard options with arrow keys | `it.skip` | Council orchestrator rejects mock fixture | Keep skipped — same blocker as :34 |
| `tests/harness/council-flow.spec.ts` | 70 | full council flow reaches Phase/Status renders | `it.skip` | Council orchestrator rejects mock fixture (preflight + debate-planner `generateObject`) | Keep skipped — file issue: "expand mock-llm fixture coverage for council preflight/debate-planner" |
| `tests/harness/ideal.spec.ts` | 50 | ideal status card renders after starting a run | `it.skip` | `src/product-loop/loop-driver.ts` phase gating rejects mock JSON | Keep skipped — same upstream cluster |
| `tests/harness/ideal.spec.ts` | 70 | can advance through ideal phases | `it.skip` | Depends on `ideal.spec.ts:50` | Keep skipped — unblocks together with :50 |
| `tests/harness/scroll.spec.ts` | 29 | scrolling list updates `props.scrollTop` | `it.todo` | No scrollable listbox exposes `props.scrollTop` in TUI | Keep `todo` — file issue: wire `<Semantic role="listbox" props={{ scrollTop }}>` in `src/ui/` |
| `tests/harness/scroll.spec.ts` | 34 | scrollable list of 200 items virtualizes correctly | `it.todo` | No fixture mechanism for large UI-node lists | Keep `todo` — awaiting UI-node fixture beyond mock-llm |
| `tests/harness/modal-focus.spec.ts` | 62 | Escape from `/council` modal restores composer focus | `it.todo` | `/council` does not currently open a modal picker | Keep `todo` — file issue: wire `<Semantic role="dialog" isModal>` to a real modal |
| `tests/harness/cost-leak-f1-tui.spec.ts` | 48 | `openai.promptCacheKey` is stable across rounds (TUI path) | `it.skip` | Mock-llm path uses deepseek model id; openai branch not exercised | Keep skipped — file issue: thread provider-id override through `--mock-llm`; in-process equivalent already covered by `cost-leak-f1.spec.ts` |
| `tests/harness/ee-timeout.spec.ts` | 132 | emits `ee-timeout` with source `bb-retrieval` when EE unreachable | `it.skip` | EE base-URL read from `~/.experience/config.json`, not env-overridable in spawned TUI | Keep skipped — unit coverage exists at `src/utils/__tests__/ee-logger.test.ts`; fix requires env-var override path in `src/ee/bb-retrieval.ts` |
| `tests/harness/ideal-e2e-live.spec.ts` | 155 | `/ideal` full flow — live LLM + EE + `dotnet new` | `describe.skipIf(!LIVE)` | Live API + real EE + .NET SDK required | Keep `skipIf` — correctly gated by `LIVE` env, intended for opt-in nightly/manual runs |
| `tests/harness/init-new-ee-design.spec.ts` | 140 | init-new EE-driven design preview | `describe.skipIf(!HAS_EE_DESIGN)` | Mock EE design server fixture availability | Keep `skipIf` — correctly env-gated |

## Audit-Tool Output

```
Total spec files:    37
.skip count:         6
.todo count:         3
Ratio:               24.3% (threshold 40%)
Allowlist entries:   10
Unallowlisted hits:  0
Status:              within thresholds
```

Note: `bun run lint:harness-skips` reports 6 `.skip` + 3 `.todo` = 9 hits; the 3 additional entries in the table above are the two `describe.skipIf` blocks (`ideal-e2e-live`, `init-new-ee-design`) plus the inline `it.skip` at `ee-timeout.spec.ts:132`, which the linter rolls into its 6/3 buckets. Cross-checking with `Grep` of `\b(it|describe)\.(skip|skipIf|todo)\b` confirms 12 total skip/todo/skipIf hits across the suite (excludes a non-call mention in `modal-focus.spec.ts:17` comment).

## Recommended Next Steps

1. **Highest leverage** — open an issue against `src/council/orchestrator.ts` + `src/product-loop/loop-driver.ts` to either expand `mock-llm` fixture coverage or relax phase gating under `--mock-llm`. Unblocks 5 specs at once.
2. **Medium** — open an issue to wire `<Semantic role="listbox" props={{ scrollTop }}>` in scrollable UI surfaces (unblocks 2 `scroll.spec.ts` todos) and a separate one for `/council` modal affordance (unblocks `modal-focus.spec.ts:62`).
3. **Low** — thread a provider-id override through `--mock-llm` (`src/agent-harness/mock-llm.ts`) so `cost-leak-f1-tui.spec.ts` can exercise the openai cache-key path end-to-end.
4. **Low** — add an env-var EE base-URL override path in `src/ee/bb-retrieval.ts` to unblock `ee-timeout.spec.ts:132` (or accept the current unit-test coverage as sufficient and remove the spec).
5. **No action** — leave the two `describe.skipIf` env-gated suites as-is; they are correct.
