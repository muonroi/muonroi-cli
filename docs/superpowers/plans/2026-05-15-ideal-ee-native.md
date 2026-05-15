# /ideal × Experience Engine Native Integration — Plan

> **For agentic workers:** REQUIRED SUB-SKILL — Use `superpowers:subagent-driven-development` to execute task-by-task. All steps use `- [ ]` checkbox syntax.

## Why

`/ideal` currently runs **side-by-side** with EE rather than **through** it. Three high-leverage opportunities, each implemented as an independent phase that lands a measurable improvement on its own.

| Phase | Replaces | Lands | Risk |
|---|---|---|---|
| **P1 — T0-native cross-run memory** | `cross-run-memory.ts` 2KB digest jammed into prompts | Per-run `/api/extract` → EE `evolve()` → PIL Layer 3 injects only relevant T0 lines | Low — both endpoints already wired (`src/ee/client.ts:398`, `layer3-ee-injection.ts`) |
| **P2 — PIL complexity routing** | Council debate fires on every `/ideal` regardless of scope | Heuristic `complexity: low\|medium\|high` in Layer 1 → low bypasses debate, single Sprint hot-path | Medium — must not regress real product-grade tasks |
| **P3 — Verify-failure → judge-worker T1** | `ContinueFeedback` retry until CB-2 chops the run | After ≥3 same-signature failures, push to EE `/api/posttool` → T1 Behavioral warning surfaces next run | Medium — risk of T3 raw queue spam if signature matching is loose |

P1 is foundational (proves the EE write-path under /ideal load), P3 reuses the same write-path. P2 is orthogonal — can ship in any order.

## Architecture context (read before starting)

- **EE 4-Tier**: T3 Raw → T2 Contextual → T1 Behavioral → T0 Principles. `evolve()` promotes upward; `/api/extract` ingests at T3.
- **PIL Layer 3** (`src/pil/layer3-ee-injection.ts`) is the **read-path** that scores T0/T1 hits and injects them into the system prompt at score floor 0.55.
- **EE client** (`src/ee/client.ts`) — already supports `extract`, `posttool`, `routeModel`. Offline queue (`src/ee/offline-queue.ts`) buffers failed writes.
- **Layer 1 intent** (`src/pil/layer1-intent.ts`) — heuristic-first, brain-fallback. New metadata fields go in `IntentTrace` (`src/pil/types.ts`).
- **Sprint runner** (`src/product-loop/sprint-runner.ts`) — wraps Verify step; failures become `ContinueFeedback` → next sprint input. CB-2 (`circuit-breakers.ts`) kills the run after N consecutive failures.

---

## Phase 1 — T0-native cross-run memory

### Goal

Replace `buildPriorContext()`'s static 2KB digest with EE-driven semantic injection. The digest stops growing with each run; PIL Layer 3 surfaces only the T0 lines relevant to the **current** idea.

### Design

Three integration points:

1. **Write-path** — On `phase = "done"` (or on user `/abort`), extract the run transcript to EE:
   ```ts
   await ee.extract({
     transcript: composeRunTranscript(state),
     projectPath: cwd,
     meta: { source: "cli-exit", scope: `ideal:${runId}` }
   });
   ```
   `composeRunTranscript` concatenates `manifest.md`, `roadmap.md`, `delegations.md`, `gray-areas.md` from the run dir — these are the artifacts containing decisions worth remembering.

2. **Read-path** — `runIdealCommand` no longer calls `buildPriorContext` for prompt injection. Instead, the **existing** PIL Layer 3 already runs on every LLM call and pulls T0/T1 from Qdrant via `/api/search`. Nothing new on the read side — we just trust the pipeline.

3. **Audit trail** — `state.md` still shows what got injected, but reads from `pil.layerTimings.layer3` instead of regenerating the digest. Replace the `## Prior Decisions Context` section with `## EE Injections (Layer 3)` listing principle IDs and scores from the most recent PIL trace.

### Tasks

- [ ] **1.1** — Add `composeRunTranscript(flowDir, runId): Promise<string>` to `src/product-loop/cross-run-memory.ts`. Concatenate manifest + roadmap + delegations + gray-areas in that order, trimmed to 32KB. Test with a fixture run dir.
- [ ] **1.2** — Add `extractRunToEE(flowDir, runId, cwd): Promise<void>` calling `getEEClient().extract()`. Failure is non-fatal — log and continue. Test with a mock client (success + 503 + timeout paths).
- [ ] **1.3** — Wire `extractRunToEE` into `loop-driver.ts` at the `done-gate.success` transition AND at `loop-driver` cleanup when user aborts mid-run. Add integration test with mocked EE.
- [ ] **1.4** — Delete `buildPriorContext` callers in `loop-driver.ts` and `discovery-recommender.ts`. Keep the function exported (used by `discovery-persistence.ts:resumeArtifactWriteIfNeeded` for resume digests — different concern, do not touch).
- [ ] **1.5** — Replace `## Prior Decisions Context` rendering in `state.md` writer with `## EE Injections (Layer 3)` pulling from the latest PIL trace. Test snapshot.
- [ ] **1.6** — Add telemetry: emit `ideal.ee_extract` interaction_log event with `{ ok, mistakes, stored, durationMs }`. Verify via local DB query after running `/ideal` once.
- [ ] **1.7** — Update `docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md` "Cross-Run Memory" section to describe T0 path. Note that filesystem manifest store is now an audit log, not a prompt source.

### Success criteria

- 10th `/ideal` run on the same workspace has system-prompt size unchanged vs run #1 (no digest growth).
- `bunx vitest run src/product-loop/cross-run-memory.test.ts` 100% green.
- Manual smoke: run /ideal twice on the same idea, verify second run's PIL Layer 3 trace shows ≥1 T0 hit referencing the first run's decision.

### Risks & mitigations

- **EE down at extract time** → offline-queue absorbs the write, replays on next session. Already battle-tested for `/api/feedback`.
- **Transcript too noisy for T3** → start with 32KB ceiling. If `evolve()` rejection rate >50% (visible via `ee.stats`), tighten `composeRunTranscript` to manifest + gray-areas only.
- **PIL Layer 3 score floor 0.55 misses relevant hits** → first-mile telemetry: log scores of top 5 hits below floor. Tune floor downward only if real misses appear.

---

## Phase 2 — PIL Layer 1 complexity routing

### Goal

`/ideal "fix typo in README"` skips the entire Council debate + Scoping phase, runs 1 sprint, ships. `/ideal "build a multi-tenant SaaS billing platform"` still gets the full council. Decision made cheaply at PIL Layer 1, **no extra LLM call** on the hot path.

### Design

Heuristic complexity scoring at Layer 1, riding the existing pass1/pass2/pass3 ladder:

| Signal | Weight |
|---|---|
| Message length (chars) | 0–3 |
| File/path references count | 0–2 |
| Keywords: `fix typo\|rename\|delete\|format\|lint` | -3 (force low) |
| Keywords: `architecture\|migrate\|refactor\|design\|platform\|multi-tenant` | +3 (force high) |
| Has explicit `--max-sprints N` flag with `N==1` | -2 |
| Council recommendation already cached in T0 (PIL Layer 3 hit) | -1 |

Total score → low (≤2) / medium (3–5) / high (≥6).

**Bypass logic in `loop-driver.ts`**:
```ts
if (pil.complexity === "low" && !flags.forceCouncil) {
  return runHotPath(idea);   // skip debate + scoping, single sprint, plain leader model
}
```

`runHotPath` is a new lean execution path: prompt-parser → 1 sprint → done-gate. Reuses existing sprint runner.

### Tasks

- [ ] **2.1** — Add `complexity: "low" | "medium" | "high"` to `IntentTrace` in `src/pil/types.ts`. Add `complexityScore: number` for telemetry.
- [ ] **2.2** — Implement `scoreComplexity(rawText, taskType, t0HitCount): { complexity, score }` in `src/pil/layer1-intent.ts` per heuristic table above. Pure function, no async.
- [ ] **2.3** — Wire `scoreComplexity` after Pass 2 task-detection in `layer1-intent.ts`. Pass `t0HitCount` from Layer 3 ee-injection trace if available, else 0.
- [ ] **2.4** — Unit tests: 8 cases covering each signal in isolation + 3 integration cases (typo fix → low, refactor multi-file → high, ambiguous → medium).
- [ ] **2.5** — Add `runHotPath(idea, llm, capUsd): Promise<void>` to `src/product-loop/loop-driver.ts`. Stages: parsePromptForContext → 1 sprint (full implement+verify) → done-gate. No discovery, no debate.
- [ ] **2.6** — Branch in `runIdealCommand`: read `pilTrace.complexity`, if `low` and not `--force-council`, call `runHotPath`. Else fall through to current flow.
- [ ] **2.7** — Add `--force-council` flag (boolean) for opt-out. Document in `ideal.ts` slash help.
- [ ] **2.8** — Integration test: 2 specs — "low fixture → hot-path, no council artifacts written"; "high fixture → council debate runs, all artifacts present".
- [ ] **2.9** — Telemetry: log `ideal.path` interaction_log event with `{ complexity, score, path: "hot" | "full" }`. Bake into Layer 1 trace.
- [ ] **2.10** — Update `docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md` with the routing decision table.

### Success criteria

- Typo-fix idea: total runtime < 30s, cost < $0.01.
- Multi-tenant SaaS idea: still completes full council debate (no regression on `tests/integration/integration.test.ts:ideal full flow`).
- 0 brain calls added on hot path (verify via PIL trace `layerTimings.layer1 == regex-only`).
- `--force-council` overrides correctly (1 test).

### Risks & mitigations

- **Misclassification: complex idea routed to hot-path** → user gets a 1-sprint shallow result. Mitigation: hot-path's done-gate is the **same** gate; if criteria not met it still fails and surfaces `Why halted` for the user to retry with `--force-council`.
- **Heuristic drift over time** → score weights are exported constants; tune via telemetry after 4 weeks of data.
- **Bypass causes T0 to never receive complex-idea principles** → P1 still extracts on the hot-path's done-gate. No loss of cross-run memory.

---

## Phase 3 — Verify-failure → judge-worker T1

### Goal

When Verify fails with the same signature ≥3 times across **any** /ideal runs (not just current), EE auto-promotes a T1 Behavioral warning. Next run's PIL Layer 3 injects "⚠️ Nhớ mock DB khi viết test" before the implement step. AI dodges the trap instead of CB-2 cutting the run.

### Design

Two integration points:

1. **Failure signature extraction** — In `sprint-runner.ts`, when Verify produces a failure, compute:
   ```ts
   signature = sha256(
     normalizedError.first2Frames +    // stack trace top
     verifyCommand +                    // which check failed
     fileTouchedThisSprint              // primary file modified
   )
   ```
   Store signature + count in run-local `state.verifyFailureSignatures: Map<sig, count>`.

2. **Push to EE judge-worker** — When `count >= 3` for any signature, fire:
   ```ts
   await ee.posttool({
     tool: "ideal_verify_fail",
     input: { signature, count, lastError, fileTouched },
     output: { phase: "verify_loop_detected" },
     meta: { source: "ideal-sprint-runner", scope: `ideal:${runId}` }
   });
   ```
   EE's `judge-worker.js` evaluates whether the pattern is generalizable. If yes → T3 raw → `evolve()` promotes to T1.

3. **Read-path** — Already covered by PIL Layer 3. T1 Behavioral entries get injected with higher score weight than T2.

### Tasks

- [ ] **3.1** — Add `computeFailureSignature(error, command, file): string` to `src/product-loop/sprint-runner.ts`. Stable hash. Test that 2 identical errors produce identical sig; different stack heads produce different sigs.
- [ ] **3.2** — Add `state.verifyFailureSignatures: Record<sig, { count, lastSeenAt, lastError, file }>` to flow state. Persist to `state.md`. Test load/save roundtrip.
- [ ] **3.3** — In sprint-runner's verify-fail branch, increment counter for the current signature. If `count >= 3`, call `pushFailureToEE(signature, ...)`. Non-fatal on EE failure (offline-queue handles).
- [ ] **3.4** — Add `pushFailureToEE` wrapper around `getEEClient().posttool`. Includes proper `meta.scope` so EE can group by run.
- [ ] **3.5** — Integration test: simulate 3 identical verify failures with mocked `runVerifyStep` and a recording EE client. Assert `posttool` called exactly once on the 3rd failure (not on 1st/2nd).
- [ ] **3.6** — Telemetry: emit `ideal.verify_pattern_detected` interaction_log event.
- [ ] **3.7** — Tighten CB-2: when a signature has been pushed to EE, give the runner **one extra** retry budget (EE warning might surface in the next attempt's PIL). After that, CB-2 still chops.
- [ ] **3.8** — Update `docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md` with the failure-pattern lifecycle.

### Success criteria

- Mock test confirms ≤2 failures = no EE push; ≥3 = exactly one push.
- Manual smoke: induce a repeating verify failure (e.g., test asserting wrong value), confirm `interaction_logs` shows `ideal.verify_pattern_detected` at iteration 3, confirm EE `/api/stats` shows the new T3 entry shortly after.
- After `evolve()` runs (manual trigger), the principle is queryable via `/api/search` with relevant query.

### Risks & mitigations

- **Loose signature → false coalescing** → include stack-frame-1 (the throwing line) in the hash. Tune by inspecting first N production signatures.
- **T3 spam** → threshold = 3, not 1 or 2. EE judge-worker also rejects junk. If T3 rejection rate >40% (visible via `ee.stats.judgeRejected`), bump threshold to 5.
- **PIL Layer 3 doesn't surface the new T1 fast enough** → T1 promotion via `evolve()` is async. The "one extra retry budget" in 3.7 gives the next run a chance, but the current run still fails. Document this as expected.

---

## Sequencing & dependencies

```
P1 ─┬─────────────────────┐
    │                     ▼
P2  │                  (validates EE write path)
    │                     │
    └─────────────────────┤
                          ▼
                          P3
```

- **P1** before P3 (P3 reuses the EE write-path; better to debug extract first under low-stakes cross-run-memory load than under verify-failure pressure).
- **P2** is independent — can land before, between, or after.
- **Recommended order**: P1 → P2 → P3. Each is ≈2 days. Total: ~6 days of focused work.

## Cross-phase telemetry

After all three land, add a `/ideal stats` slash subcommand that surfaces:
- P1: avg system-prompt size over last 10 runs (should be flat, not growing)
- P2: hot-path vs full-path ratio
- P3: avg verify retries before signature-trip vs after

This is the verification surface for "did EE-native actually move the needle".

## Out of scope

- Done-Gate router via `/api/route-model` — superseded by extending `roleModels` in user-settings to `{verify: {low, medium, high}}`. Tracked separately if needed.
- Migrating `discovery-persistence.ts:resumeArtifactWriteIfNeeded` to EE — that path serves resume, not prompt injection, and the filesystem store is fine.
- Schema/migration for existing flow-state files. New fields default to safe values; old runs stay readable.
