# Phase 16 — PIL + EE Integration into Council

**Milestone:** v1.6 Council Quality & Trust
**Status:** Planned (PLAN.md not yet generated)
**Depends on:** Phase 15 (round tool tracing is the integration point for `wrapToolWithEeCheck`)
**Requirements:** CQ-11, CQ-12, CQ-13, CQ-14, CQ-15, CQ-16, CQ-17, CQ-18, CQ-19, CQ-16a, CQ-16b, CQ-16c, CQ-16d
**EE mode (LOCKED):** thin-client only. EE runs on VPS `72.61.127.154:8082` (config at `~/.experience/config.json`, `version: "thin-client"`, auth via `serverAuthToken` / `serverReadAuthToken`). Fat-mode (`~/.experience/experience-core.js`) is OUT OF SCOPE for v1.6 — that file is absent on the dev box and bringing it up is a separate project. All EE calls go through HTTP via `ee/bridge.ts:searchByText` and `ee/client.ts` (intercept/judge/extract/phase-outcome). The existing thin-client circuit breaker + `~/.muonroi-cli/ee-offline-queue/` absorb VPS unreachability.

## Why this phase exists

See `.planning/research/v1.6-council-quality-context.md` (sections 2.2, 2.3, 3.7).

Today the council runs in isolation:
- PIL (`src/pil/pipeline.ts`) runs only for the main agent's per-message processing — never for council
- EE brain (warnings, judge, mistake-detector, phase-outcome) is never queried during a debate, never updated after one
- Council reuses only `grayAreas` from a prior PIL run, dropping `taskType`/`complexityTier`/`domain`/`outputStyle`

This phase brings the project's existing intelligence into the council so debates are calibrated by past experience and outcomes feed back into the brain.

## Integration design

```
runCouncil
  ├─ runPipeline(topic) → ctx { taskType, complexityTier, domain, outputStyle, grayAreas }
  ├─ ee/council-bridge.queryExperience(topic, domain) → warnings[]
  ├─ debate-planner — system prompt seeded with experience snippets
  │     └─ if warnings.length ≥ 1 → auto-add "Experience Auditor" stance
  ├─ runDebate
  │     ├─ research role (Phase 14 wiring)
  │     ├─ rounds (Phase 15 wiring) — tool calls wrapped with wrapToolWithEeCheck → PreToolUse warnings stream into output
  │     └─ leader evaluation
  ├─ runPlanning → synthesis (respects ctx.outputStyle)
  ├─ ee/judge.judgeOutcome(synthesis) → confidence ∈ [0,1]
  │     └─ if confidence < 0.5 → another round OR [NEEDS HUMAN REVIEW] flag
  └─ ee/phase-outcome.recordCouncilOutcome(synthesis, verdict, confidence) → brain learns
```

## Audit findings (2026-05-08, this dev machine)

Verified before adding CQ-16a..d:

- **EE thin-client is HEALTHY** on VPS:
  - `curl -H "Authorization: Bearer <readToken>" http://72.61.127.154:8082/health` → 200
  - Response: `qdrant.status=ok, fileStore.status=ok, embed.status=unknown` (the `unknown` is fine — embed is on-demand)
  - Uptime: ~13 hours when probed
- **Intercept loop is ALIVE**: 562 `ee_intercept` events today (last at 08:38), 2208 cumulative `ee_judge`, 79 `pil`. The thin-client + circuit breaker + auth wiring all work.
- **Layer 3 injection is BROKEN at the data layer** (not the code):
  - `interaction_logs WHERE event_type='ee_injection'`: 27 `no_match` + 24 `error` + 4 `filtered_noise` + **0 `injected`** in last 30 days
  - `error` count is from earlier sessions before today's VPS reachability — today only no_match/filtered_noise, no `error` → server now reachable but brain has no relevant points for user prompts
  - Score floor is `0.55` (`MUONROI_PIL_SCORE_FLOOR`); 4 events filtered just below — suggests brain has loosely-related material but not strong matches yet
  - **Implication:** brain needs bootstrapping (`experience extract` over more sessions, or `experience evolve` to abstract behavioral → principle). This is a runtime/data concern, not a code concern. CQ-16d makes this discoverable.
- **UI render sink is UNWIRED**:
  - `src/ee/render.ts` defaults `_sink = console.warn`
  - `grep "setRenderSink" src/ui src/index.ts` → 0 matches anywhere outside tests
  - In TUI raw mode (Ink), `console.warn` writes to stderr which is suppressed; user never sees `⚠ Experience Warning` even when `emitMatches` fires
  - **Implication:** EVEN IF Layer 3 starts injecting and intercept matches start firing, the user will see nothing. CQ-16a fixes this.
- **Layer 3 IS read by the model when injection succeeds** — confirmed by trace:
  ```
  layer3-ee-injection.ts:148  ctx.enriched += `[experience: ...]\n- <text> [id:xxxx]`
  orchestrator.ts:2946        const enrichedMessage = pilCtx.enriched
                              → sent to model as user message
  ```
  So once data + render are unblocked, the integration just works.

## Open questions for plan-phase

1. **`queryExperience` latency budget on a 5s `serverTimeoutMs`** — when VPS is slow, wait or short-circuit? Recommend 1.5s hard cap on council critical path; pre-fetch parallel with clarifier/preflight to hide cost.
2. **`ee/judge.ts` schema fit** — current schema is for phase outcomes. Council outcomes have different dimensions (evidence-grounded? convergence? actionability?). May need new `judgeCouncilOutcome` variant.
3. **"Experience Auditor" participant accounting** — additive when `experienceMode=advisory` (3rd voice), replaces a generic role when `experienceMode=enforcing`?
4. **Default for `council.experienceMode`** — `advisory` initially.
5. **`setRenderSink` wiring point** — most natural is `src/index.ts` boot. The sink emits a synthetic `StreamChunk` into the active orchestrator's chat stream. Single-orchestrator-at-a-time invariant is currently true, so the global sink → active stream pattern is safe; revisit if multi-session concurrency lands.
6. **Brain bootstrap automation (CQ-16d)** — should the diagnostic just hint, or auto-trigger `experience extract` after N sessions? Recommend hint-only in v1.6; auto-trigger is v2 since it touches the VPS write path.

## Out of scope (deferred to Phase 17)

- `parseOutcome` resilience
- `/council inspect` slash command
- `[Council Tool Trace]` persistence
- Doctor warnings / docs

## Files to touch (estimated)

**Council integration (CQ-11..CQ-19)**
- `src/council/index.ts` — add PIL invocation, EE pre-fetch, judge post-call, recordCouncilOutcome post-call, outputStyle propagation
- `src/ee/council-bridge.ts` (NEW) — `queryExperience(topic, domain)` thin-client only (`searchByText` over `experience-behavioral` + `experience-principles`)
- `src/ee/judge.ts` — possibly new `judgeCouncilOutcome` variant
- `src/ee/phase-outcome.ts` — `recordCouncilOutcome` helper
- `src/council/debate-planner.ts` — experience-seeded prompt; auto-add Auditor stance
- `src/council/llm.ts` — `wrapToolWithEeCheck` over MCP+builtin tools (uses Phase 15 wiring)
- `src/council/prompts.ts` — synthesis prompt respects outputStyle
- `src/utils/settings.ts` — `council.experienceMode` flag

**EE visibility / health (CQ-16a..d)**
- `src/index.ts` — boot wires `setRenderSink` into orchestrator stream
- `src/ee/render.ts` — sink signature accepts `(line | StreamChunk)`; helper to convert warning blocks to `experience_warning` chunks
- `src/pil/layer3-ee-injection.ts` — emit `experience_injected` StreamChunk on success path
- `src/types/index.ts` — extend `StreamChunk` union with `experience_warning` and `experience_injected` kinds
- `src/ui/app.tsx` (or relevant slot) — render `experience_*` chunks as collapsible blocks
- `src/ops/doctor.ts` — EE thin-client `/health` probe with auth, brain-emptiness diagnostic from `interaction_logs`
- New tests: `src/ee/__tests__/render-sink-wiring.test.ts`, `src/ops/__tests__/doctor-ee-health.test.ts`, `src/pil/__tests__/layer3-injected-chunk.test.ts`

## Acceptance test

1. Topic with a known brain warning (after CQ-16d-suggested bootstrap) → `[Council Memory]` records show "Experience Auditor" stance + warnings cited in rounds
2. Run with VPS unreachable (block `72.61.127.154`) → council completes within latency budget, skips warnings, queues outcome offline; chat UI shows EE health indicator turn red but no crash
3. Synthesis confidence < 0.5 → either extra round runs OR `[NEEDS HUMAN REVIEW]` appears in synthesis output
4. After run, EE brain or offline queue contains a council-outcome entry
5. **(CQ-16a)** `emitMatches` invoked with a fake match → chat UI renders `⚠ [Experience]` block; nothing leaks to stderr
6. **(CQ-16b)** Force Layer 3 to return a fake high-score match → user sees a `experience_injected` chunk in chat with id/score/snippet, expandable to full text
7. **(CQ-16c)** `muonroi doctor` against healthy VPS → reports `ee.health=ok, qdrant=ok, fileStore=ok, embed=unknown(ok)`; against unreachable VPS → reports actionable hint
8. **(CQ-16d)** Seed DB with 50 `ee_injection` events of `event_subtype='no_match'` → doctor emits brain-emptiness hint with the suggested next step
