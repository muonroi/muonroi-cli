# EE Native Observation — P0 Design

**Date:** 2026-05-07
**Scope:** muonroi-cli phase to give Experience Engine richer signal than hooks can provide, without trusting agent self-report.

---

## Why

EE today (across Claude/Gemini/Codex/OpenCode) is hook-bound: it sees `toolName + toolInput + outcome.success`. That is ~5% of what the loop actually contains. The other 95% (intent, plan step, verify result, user reaction, multi-turn arc, prior-warning state) is invisible to hooks.

Two failure modes follow:
1. **Noise reinforcement** — agents are sycophantic, so any "did you follow?" self-report biases positive. EE's 3-layer anti-noise stack (regex skip → quality scoring → brain L3 filter) all infer from outside; none has agent intent.
2. **Memory drift** — without rich outcomes, brain learns from `success: true/false` alone. Per `experience-formation-vnext.md` this is the path back to "memory, not experience".

muonroi-cli owns the orchestrator, PIL, council, verifier, and GSD bridge. It can expose the unfakeable signals hooks cannot.

## Non-goals (P0)

- No agent self-report (no forced ACK, no "was this helpful?" prompts)
- No EE server schema changes (server already accepts extra metadata)
- No replay harness execution (only logging — replay is P1)
- No cross-model judge consensus (P1)
- No GSD phase-outcome endpoint (P1)

## Principle

**Brain only updates on signals the agent cannot fake.** Self-report is debug data, never weights. Native = privileged observation, not privileged control.

## P0 Deliverables

### 1. Mistake detection — user-veto + retry-pattern

`src/ee/mistake-detector.ts` — ring buffer of last 5 tool calls (toolName, toolInput hash, timestamp, success). Two detectors:

- **user-veto:** next user turn after a tool batch matches `/\b(no|wrong|sai|undo|revert|that broke|why did)\b/i` AND `_lastWarningResponse` was non-null OR last tool call had matches. Fires `posttool({ outcome: { success: false, mistakeKind: "user-veto", evidence: { userMessage } } })` for each tool in the batch.
- **retry-pattern:** same toolName + similarity(toolInput, prior) ≥ 0.7 within last 3 turns AND second attempt succeeded. Fires `posttool({ outcome: { success: true, mistakeKind: "retry-pattern", evidence: { firstAttemptArgs, secondAttemptArgs } } })` — signals "warning should have fired earlier".

Hook: orchestrator user-message handler (for veto) + posttool wrapper (for retry).

### 2. Rich outcome payload

Extend `PostToolPayload.outcome` with optional fields the CLI already computes:

```ts
outcome: {
  success: boolean,
  durationMs?: number,         // existing
  error?: string,                // existing
  // new (all optional):
  verifyResult?: "pass" | "fail" | "skip",
  buildResult?: { exitCode: number, durationMs: number },
  typeCheckResult?: "pass" | "fail",
  testResult?: { passed: number, failed: number },
  mistakeKind?: "user-veto" | "retry-pattern",
  evidence?: Record<string, unknown>,
}
```

Plumbed through `src/hooks/index.ts` PostToolUse path. Sources:
- `verifyResult` from `src/verify/` when last command was a verify run
- `buildResult` from Bash tool wrapper (parse exit code from stderr/stdout)
- `typeCheckResult` from `src/lsp/manager.ts` if active
- `testResult` from test runner output parser

Server side: no schema change required — `PostToolPayload` accepts extra fields at runtime, brain prompt template will start including these.

### 3. Intent capture in intercept

`InterceptRequest.context` (new optional field) populated by orchestrator before tool dispatch:

```ts
context: {
  assistantReasoningExcerpt?: string,    // last 200 chars of assistant message before tool call
  priorWarningIdsInSession?: string[],   // dedup signal
  gsdPhase?: string,                      // if running under GSD
  userGoalExcerpt?: string,               // user's prompt at turn start, 200 chars
}
```

Server reads `request.context` in L3 brain filter prompt (no schema break — extra field). Improves L3 precision without touching the brain model.

### 4. Session trajectory logger (write-only)

Append-only JSONL at `~/.experience/sessions/<sessionId>.jsonl`. Event shape:

```ts
{ ts, kind: "intercept" | "posttool" | "user_turn" | "verify" | "warning_surfaced", ... }
```

No reads in P0 — this is data capture for P1 replay harness. Rotation: keep last 30 days, max 100 MB total.

## File-level scope

| File | Change | LOC |
|---|---|---|
| `src/ee/mistake-detector.ts` (new) | ring buffer + 2 detectors | ~150 |
| `src/ee/types.ts` | extend `PostToolPayload.outcome`, add `InterceptRequest.context` | ~30 |
| `src/ee/posttool.ts` | accept rich outcome | ~10 |
| `src/hooks/index.ts` | wire detector + plumb rich outcome | ~80 |
| `src/orchestrator/orchestrator.ts` | capture intent context, fire user-turn handler | ~60 |
| `src/ee/session-trajectory.ts` (new) | JSONL append + rotation | ~80 |
| Tests for above | unit + integration | ~200 |

Total: ~600 LOC including tests. Commits: one per file group, atomic.

## Risks

- **user-veto false positive** — user veto unrelated to last tool. Mitigation: gate on `_lastWarningResponse !== null` OR last tool had matches. Skip generic veto.
- **retry-pattern legitimate retry** — network glitch, transient. Mitigation: only count when 2nd attempt succeeded (i.e., agent changed approach, not just retried identically).
- **Trajectory log disk growth** — 100 MB cap + 30-day rotation. Per-session avg ~50 KB → ~2000 sessions before rotation kicks in.
- **Server backward compat** — extra fields on payloads are ignored by current server, no break. New context only consumed when server upgrades; P0 ships with client-side data ready.

## Acceptance

- All existing EE tests still pass.
- New unit tests for `mistake-detector.ts` + `session-trajectory.ts`.
- Manual smoke: run a session, verify `~/.experience/sessions/<id>.jsonl` has events, verify `posttool` payloads now include `verifyResult` when verify ran.
- No regression in intercept latency (cache + circuit breaker unchanged).

## P1 (designed after P0 ships)

1. Replay harness consuming trajectory JSONL (novel-case proof per spec).
2. Cross-model judge consensus in `judge-worker.js`.
3. `/api/phase-outcome` endpoint for GSD phase boundaries (server change).
4. Negative-space search on user-veto (server query for "should-have-fired" candidates).
