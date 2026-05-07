# EE Native Observation — P1 Design

**Date:** 2026-05-07
**Builds on:** [P0 design](./2026-05-07-ee-native-observation-design.md)
**Scope:** Turn the unfakeable signals captured in P0 into a learning loop the brain can use offline, with cross-model adjudication and explicit GSD phase boundaries.

---

## Why

P0 made the brain *observable* — every intercept, posttool, user turn, abort, file-revert, and retry now lands as structured events in either the trajectory JSONL or the `posttool` payload. P1 turns observation into *correction*:

- **Replay** lets us re-run a captured session against a candidate brain config and ask: "would this brain have done better?" — without re-running agents or burning tokens on live tool calls.
- **Cross-model judge consensus** removes the single-judge bias. Today one model labels FOLLOWED/IGNORED/IRRELEVANT. If two cheap models disagree, the verdict is held until a tiebreaker — preventing a single biased judge from poisoning weight updates.
- **`/api/phase-outcome`** gives GSD a way to say "this phase passed verifier" or "this phase was abandoned" without inferring it from tool tails. Phase-level signal is much higher SNR than per-tool signal for principle reinforcement.
- **Negative-space search** is the dual of intercept: given a user-veto event, query the brain for principles that *should have fired* on the offending tool input but didn't. The gaps are the next training targets.

P0 said "brain only updates on signals the agent cannot fake." P1 closes the loop: those signals now drive offline replay, multi-judge consensus, phase-grain reinforcement, and gap-finding.

## Non-goals (P1)

- No RLHF training pipeline. Replay produces *evaluation reports*, not gradient updates.
- No new agent runtime — replay reads JSONL, doesn't drive Claude/Codex/Gemini.
- No UI surface in muonroi-cli for replay results. CLI-only consumer for now.
- No automatic principle deletion from negative-space results. Human review gate stays.

## Principle (carried from P0)

Brain only updates on signals the agent cannot fake. P1 corollary: **judges that disagree do not update the brain.** Consensus is the new gate.

---

## Item 1 — Replay harness

### What

A standalone Node script: `tools/exp-replay-trajectory.js` (lives in experience-engine repo, alongside existing `exp-replay-sessions.js` and `exp-holdout-harness.js`).

Input: a path to one or more `~/.experience/sessions/<sid>.jsonl` files.
Output: a report (`stdout` + `--out <path>`) listing, for each `intercept` event:

| Field | Source |
|---|---|
| toolName, decision (orig) | trajectory event |
| brain decision (now) | re-issue intercept against current brain |
| match diff | symmetric set diff of principle IDs |
| would-have-blocked | did the rerun decision differ from `allow`? |
| paired with | downstream `posttool` event in same session (success / mistakeKind / evidence) |

### How

- The trajectory format is fixed by `src/ee/session-trajectory.ts`. Replay reads sequentially and reconstructs a synthetic `InterceptRequest` for each `kind: "intercept"` event.
- Replay does **not** call any agent. It calls EE's `/api/intercept` directly with the captured tool name, tool input, and reconstructed scope (cwd may have moved — replay uses `originalCwd` if recorded, else falls back to "test fixture" scope).
- Pairs intercepts with their `posttool` siblings on `(sessionId, toolName, ts within 60s)`.
- Emits per-session summary: `total intercepts`, `decision drift`, `principle drift`, `now-blocking-correctly` (rerun blocked AND posttool had `mistakeKind: "user-veto"` originally), `now-allowing-correctly` (rerun allowed AND posttool had `success: true` originally).

### Why this shape

- Decision drift on its own is meaningless — what matters is whether drift correlates with veto events. The pairing is the eval signal.
- Replay must be cheap. No agent calls, no LLM judge calls inside the replay loop. Only intercept HTTP calls (already cached server-side per `client.ts`).
- Output as JSON so existing `exp-stats.js` style tooling can aggregate across days.

### Acceptance

- `node tools/exp-replay-trajectory.js ~/.experience/sessions/*.jsonl --out report.json` runs to completion against the captured P0 sessions.
- Report contains `now-blocking-correctly > 0` for at least one synthetic session that includes a user-veto.
- Replay never mutates the brain. Side-effect-free.

---

## Item 2 — Cross-model judge consensus

### What

`~/.experience/judge-worker.js` today calls `classifyViaBrain` once per posttool event. P1: call **two** judge models in parallel; record each verdict; only commit `recordJudgeFeedback` when both agree. On disagreement, escalate to a third (tiebreaker) model OR queue for human review.

### How

- Add `judges: [{ model, role }]` to `~/.experience/config.json`. Default: `[{ model: "haiku-4-5", role: "primary" }, { model: "deepseek-v3", role: "secondary" }]`. Tiebreaker omitted by default (queue instead).
- `judge-worker.js` runs both calls in `Promise.all`. Each call is the existing `classifyViaBrain` with `model` parameter threaded through.
- New activity log entries: `op: "judge-consensus"` with fields `{ verdicts: { primary, secondary, tiebreaker? }, agreed: bool, finalVerdict }`.
- Disagreement → `recordJudgeFeedback` is **skipped**. The posttool event still lands in the activity log so the trajectory is complete; it just doesn't reinforce.
- Disagreement queue: append to `~/.experience/judge-disagreements.jsonl` (capped 30 days, like trajectory). Surfaced via a future `exp-disagreements.js` review tool (out of P1 scope — just write the queue).

### Why

- Single-judge bias was a known noise source. Cross-model consensus is cheap insurance: ~2x judge cost (haiku + deepseek are both cheap), ~10x reduction in spurious reinforcement when judges disagree.
- Skipping reinforcement on disagreement is strictly safer than tiebreaking with a third model in the hot path. Disagreement is rare; queueing for offline review preserves data without risking noise.

### Acceptance

- Existing tests in `tests/judge-worker.test.js` still pass with consensus enabled (single-judge mode is fallback when `judges` array has length 1).
- New test: when two judges return different verdicts, `recordJudgeFeedback` is NOT called and the disagreement queue grows by 1 entry.
- Activity log shows `judge-consensus` op alongside existing `judge-brain` ops.
- Default config keeps the existing single-judge behavior (opt-in via config update).

---

## Item 3 — `/api/phase-outcome` endpoint

### What

New POST endpoint on EE server. Body:

```ts
{
  phaseName: string,           // e.g. "implement", "verify", "discuss"
  outcome: "pass" | "fail" | "abandoned",
  evidence: {
    verifierResult?: { passed, failed },
    durationMs: number,
    toolCount: number,
    sessionId: string,
    cwd: string,
  },
  toolEventIds?: string[],     // optional: trajectory event IDs that belong to this phase
}
```

Server applies the verdict to all `intercept` events in `toolEventIds` (or, if absent, all intercepts in the named session) as a **phase-level reinforcement**: each principle that fired during a `pass` phase gets +1 weight; each that fired during a `fail`/`abandoned` phase gets -0.5 weight, scaled by confidence.

### How

- Add route in `server.js` next to `/api/posttool`. Reuses existing brain auth + circuit breaker.
- New helper `experience-core.js#applyPhaseOutcome(payload)` — looks up principle IDs from cache, calls `recordJudgeFeedback` with a synthetic `phase-outcome` source.
- Client side: `src/ee/phase-outcome.ts` (new) — small wrapper. Called from GSD `/gsd-verify-work` skill on completion AND from orchestrator when phase boundary detected (the orchestrator already tracks `gsdPhase` from P0 intent context).
- Idempotency: same `(sessionId, phaseName)` posted twice is a no-op (server keeps a 24h dedup set in memory; restart-safe is not needed for P1).

### Why

- Per-tool reinforcement is too granular and too noisy — verifier pass/fail is the high-SNR signal GSD already produces.
- Phase outcome is the cleanest place to credit-assign principles: any warning that fired inside a passing phase was, by construction, not a blocking false positive.
- "abandoned" (user pressed ESC, dropped the phase) is a soft-veto distinct from "failed" — phase abandonment correlates strongly with bad warnings, where outright failure may correlate more with bad agent code.

### Acceptance

- `curl -XPOST localhost:8082/api/phase-outcome -d '{...}'` returns 200 with the count of principles updated.
- After a passing GSD verify, principles that fired during that phase show increased weight in `exp-stats.js`.
- Negative test: posting same (session, phase) twice returns the cached result, doesn't double-count.
- Server change is gated by feature flag `ENABLE_PHASE_OUTCOME=1` so existing deployments are unaffected.

---

## Item 4 — Negative-space search on user-veto

### What

Given a `posttool` event with `outcome.mistakeKind: "user-veto"`, find principles in the brain that *should have* matched the offending `(toolName, toolInput, cwd)` but didn't fire at intercept time. These are the brain's blind spots.

CLI tool: `tools/exp-negative-space.js --since 7d`. Reads recent veto events from activity log, runs each `(toolName, toolInput)` through the brain's similarity search at a *lower threshold* than intercept uses (e.g., 0.4 instead of 0.7), reports the principle IDs that were close-but-not-close-enough.

### How

- Walk activity log for entries matching `op: "posttool"` AND `payload.outcome.mistakeKind: "user-veto"` since the cutoff.
- For each, issue `experience-core.js#searchSimilarPrinciples(toolName, toolInput, threshold: 0.4)` — a new export that does the same Qdrant query as intercept but with relaxed score threshold.
- Subtract the principles that *did* fire (already in the original `intercept` event's `matches` array — captured in trajectory).
- Output: per veto, list of "near-miss" principle IDs with their actual similarity scores. Sorted by `(score desc, recency desc)`.
- No automatic action — output is a review queue. A human (or, later, an evolution job) decides whether to lower a principle's threshold, broaden its query, or merge it with a sibling.

### Why

- Vetoes are the most expensive signal we capture. Each one represents a brain miss the user actually noticed and corrected. We must not waste them.
- Lowering intercept threshold globally would flood agents with low-confidence noise. The negative-space query runs *offline* at low threshold and *only* against confirmed veto events — high precision, low cost.
- Output feeds the existing evolution loop (`/api/evolve`) by surfacing concrete candidates rather than scanning the whole brain.

### Acceptance

- `node tools/exp-negative-space.js --since 7d --out gaps.json` runs against current activity log.
- Gaps file lists at least one near-miss for the synthetic veto session from P0.
- Tool is read-only against the brain — no `recordJudgeFeedback`, no Qdrant writes.

---

## Priority + dependency graph

```
P0 (shipped)
  │
  ├─► Item 1  Replay harness ──────────────── [no deps]   ★ start here
  │
  ├─► Item 2  Judge consensus ─────────────── [no deps]   ★ parallel
  │
  ├─► Item 3  /api/phase-outcome ──┬─ needs server change, feature-flagged
  │                                └─ orchestrator wiring needs P0 gsdPhase context (already shipped)
  │
  └─► Item 4  Negative-space ───── needs Item 1 patterns (intercept+posttool pairing logic)
                                   AND requires user-veto events in activity log (P0 ships them)
```

**Recommended order:** Item 1 (harness) → Item 2 (consensus, parallel) → Item 4 (reuses harness pairing) → Item 3 (server change, lowest risk last because it touches deployed EE).

**Why this order:** Item 1 is a pure read-only tool, lowest risk, also the prerequisite for evaluating Items 2/3/4. Item 2 is a behavior change inside an already-isolated worker — easy to revert. Item 4 reuses the pairing helper from Item 1. Item 3 is the only server change in the bundle and ships behind a feature flag, so it lands last when we have replay numbers to confirm it helps.

## File-level scope (estimate)

| Item | File | Change | LOC |
|---|---|---|---|
| 1 | `tools/exp-replay-trajectory.js` (new, in experience-engine repo) | replay loop + report | ~220 |
| 1 | `tools/test-exp-replay-trajectory.js` (new) | unit + fixture-based | ~120 |
| 2 | `~/.experience/judge-worker.js` | dual-judge + queue | ~80 |
| 2 | `tests/judge-worker.test.js` | consensus tests | ~60 |
| 3 | `experience-engine/server.js` | new route + handler | ~50 |
| 3 | `experience-engine/.experience/experience-core.js` | `applyPhaseOutcome` | ~80 |
| 3 | `muonroi-cli/src/ee/phase-outcome.ts` (new) | client wrapper | ~40 |
| 3 | orchestrator/GSD wiring | call site | ~30 |
| 3 | tests | integration | ~80 |
| 4 | `tools/exp-negative-space.js` (new) | walker + query | ~150 |
| 4 | `experience-core.js` | `searchSimilarPrinciples` export | ~30 |
| 4 | tests | ~60 |

Total: ~1000 LOC across two repos. Atomic commits per item; items 1, 2, 4 ship from experience-engine, item 3 spans both repos.

## Risks

- **Replay drift** — brain changes between capture and replay; if too much time passes the report becomes ambiguous (was it the brain or the change in fixtures?). Mitigation: stamp each trajectory event with `brainVersion` (already in `intercept` response) and refuse to compare across versions in Item 1's default mode.
- **Judge cost doubling** — two parallel calls per posttool. Mitigation: both judges are cheap models; consensus only runs on events that already had warnings (skip pure-allow posttools). Worst-case ~2x current judge token spend, observed today is small.
- **Phase-outcome over-credit** — a verifier pass that ran *after* an unrelated principle fired could spuriously credit that principle. Mitigation: server only updates principles whose intercept event is present in `toolEventIds`. Without explicit IDs, the server uses a strict same-session+same-phase window.
- **Negative-space FP** — low-threshold search will return many candidates. Mitigation: output is a review queue, not an action. Plus we deliberately scope to *veto* events (rare and high-signal) rather than all posttool events.
- **Deployed server upgrade risk** — Item 3 changes the EE server. Mitigation: feature-flag `ENABLE_PHASE_OUTCOME=1`, default off; existing endpoints untouched.

## Acceptance (overall)

- All four items have green tests.
- A single end-to-end run: capture a session → replay it → the report flags at least one decision change → judge consensus shows the change is supported by both judges → phase-outcome reinforces principles that fired during a passing phase → negative-space scan surfaces zero false negatives on synthetic vetoes.
- No regression in P0 trajectory log shape.
- All P1 server-side changes are reversible via feature flag.

## P2 (out of scope)

- RLHF / brain weight gradient updates from replay reports.
- UI surface in muonroi-cli for replay/disagreements/negative-space.
- Auto-action on negative-space output (threshold tuning, principle merging).
- Cross-tenant aggregation of vetoes.
