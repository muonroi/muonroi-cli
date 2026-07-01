# GSD Native Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prompt-only GSD "shell" (PIL layer4 + playbook directives) with a **native workflow engine** backed by [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core), so the agent autonomously chooses depth/phase while the CLI enforces state, artifacts, and verify gates.

**Architecture:** muonroi-cli becomes a **Loop Host** for GSD's five-step contract (`discuss → plan → execute → verify → ship`), **extended** with a native **plan-council gate** before execute. We keep the existing playbook mindset (`discuss → research → plan → check-plan → implement → verify` from `src/playbook/directives.ts`) but replace the soft self-review "CHECK-PLAN" step with an enforceable **multi-perspective council** that spawns research / verify / implement sub-agents to debate the draft `PLAN.md` before any code edits. Leader model (premium tier within session provider) owns plan authoring, plan verification synthesis, and council moderation. We **vendor** `gsd-core` (npm dep + pinned tag) and call its runtime (`gsd-core/bin/lib/*`, `gsd-tools`) — we do **not** reimplement phase/state/verification logic in TypeScript. A thin `WorkflowEngine` adapter bridges GSD dispatch to existing muonroi surfaces: orchestrator (execute), council (discuss/plan/**plan-review**), self-verify + `bun test` (verify), `/ideal` product-loop (product kind).

**Tech Stack:** TypeScript (ESM/Bun), `@opengsd/gsd-core` (CJS runtime, Node ≥22 — invoke via `createRequire` or subprocess), existing PIL/orchestrator/product-loop, `.planning/` artifact layout (GSD canonical).

**Evidence — current "shell" problem:**

| Surface | What it does today | Gap |
|---------|-------------------|-----|
| `src/pil/layer4-gsd.ts` | Injects `[playbook]` rubric into `enriched` | Not enforceable; agent can ignore |
| `src/playbook/directives.ts` | Explicitly **not** real GSD — "borrows mindset" | Duplicates skills, no state |
| `src/gsd/` | Types + `detectGsdPhase` keywords only | No engine |
| `~/.claude/skills/gsd-*` | Full workflow via external skills | Out of process; no orchestrator hooks |
| `/ideal` + `product-loop/` | Real sprint/council/verify | Parallel path, not unified with task-level GSD |

**Evidence — session `85d3ff93f583` (user-reported failure while drafting this plan):**

- Model: `glm-4.7` @ Z.ai, 3 user turns, 22 tool calls
- Forensics: peak 64K input, 70.7% cache hit — no cost anomalies
- DB message `seq=30`: assistant emitted `write_file` with **`"input": {}`** (empty args)
- DB message `seq=31`: tool error `Invalid input for tool write_file: JSON parsing failed` — model put plan body in wrong JSON shape
- Session **ends at seq=31** (no recovery turn) — user likely saw provider toast `Invalid API parameter` on the **next** `streamText` retry with malformed tool history
- **Phase 0 hotfix** (parallel): tool-arg validation + single-shot repair before provider call; Z.ai tool-loop message sanitization audit

---

## Decision: Pull gsd-core, Don't Rewrite

**Rationale (from gsd-core spike, `next` branch):**

- Mature modules already exist: `state-transition.cjs`, `phase.cjs`, `verification.cjs`, `loop-host-contract.cjs`, `capability-registry.cjs`, `command-routing-hub.cjs`
- 12 loop extension points are **generated and linted** — stable contract for host integration
- Rewriting in muonroi would fork ~4K commits of edge-case handling (STATE.md drift, phase DAG, verify routing table, workstream inventory)
- gsd-core docs explicitly warn: **do not copy `agents/`/`commands/`** — use installer/runtime

**Integration shape (not installer):**

```
muonroi-cli (Loop Host)
  ├─ WorkflowEngine          ← thin TS facade
  ├─ GsdHostAdapter          ← implements loop points → orchestrator/council/verify
  ├─ PlanCouncil             ← runPlanCouncil() — multi-perspective review before execute
  │    ├─ leader (premium)    ← plan write, moderate, plan-verify synthesize
  │    └─ perspective subs    ← architect / skeptic / research / security / implementer
  ├─ @opengsd/gsd-core        ← npm dependency (pinned)
  │    └─ gsd-tools / bin/lib ← state, phase, verify, dispatch hub
  └─ .planning/               ← PLAN.md, PLAN-REVIEW.md, PLAN-VERIFY.md, STATE.md
```

**Bun/ESM note:** gsd-core ships CJS (`gsd-core/bin/lib/*.cjs`). Use `createRequire(import.meta.url)` for in-process calls in spike; fall back to `bunx gsd-tools <family> <sub>` subprocess if native `require` friction blocks CI.

---

## Plan Quality Gate — Multi-Perspective Council (before execute)

**Mindset preserved:** The heavy-tier playbook rubric (`src/playbook/directives.ts:124-135`) already prescribes `discuss → research → plan → CHECK-PLAN → implement → verify`. Today CHECK-PLAN is prompt-only — the same model reviews its own plan. Native GSD **keeps this sequence** but makes CHECK-PLAN a **hard gate** backed by real council infrastructure.

**Extended workflow (task-level, `standard` + `heavy` depth):**

```
discuss → research → plan → plan-council → execute → verify → ship
                              ↑
                    (replaces soft CHECK-PLAN)
```

| Step | Who runs it | Model routing | Output artifact |
|------|-------------|---------------|-----------------|
| **discuss** | Leader + askcard | `resolveLeaderModelDetailed(sessionModel)` — premium within session provider | Gray-area notes in `STATE.md` |
| **research** | Parallel `task` sub-agents (research role) | `getRoleModel("research")` or catalog `research` slot; non-leader tiers OK | `RESEARCH.md` or inline findings block |
| **plan** | Leader drafts | **Leader = highest reachable tier** on session provider (`leader.ts:TIER_RANK premium`) | `.planning/PLAN.md` (numbered steps + acceptance criteria) |
| **plan-council** | Leader moderates; N perspective sub-agents | Leader premium; participants via `resolveParticipants()` — architect / skeptic / implementer / security lenses | `PLAN-REVIEW.md` + revised `PLAN.md` if consensus requires changes |
| **plan-verify** | Leader synthesizes pass/fail | **Leader premium** — same model as plan-council moderator | `PLAN-VERIFY.md` verdict; `STATE.md` phase → `execute` only on pass |
| **execute** | Top-level agent or `task` sub-agents | Session model or `getRoleModel("implement")` | Code diffs + commits |
| **verify** | `self-verify` tier1 + scoped `bun test` | `getRoleModel("verify")` for verify narration | Test evidence in session + `STATE.md` |

**Council perspectives (spawned sub-agents, non-overlapping scopes):**

| Perspective | Role source | Mandate |
|-------------|-------------|---------|
| **Architect** | `implement` participant or dedicated stance | Structural fit, file map correctness, dependency order |
| **Devil's Advocate** | `verify` participant / skeptic stance | Challenge assumptions, missing edge cases, YAGNI violations |
| **Research** | `research` participant | Ground plan claims against codebase evidence (`file:line` citations) |
| **Security** | Optional 4th slot when `catalog.council` provides it | Permission model, path traversal, secret handling in planned edits |
| **Implementer** | `implement` participant | Feasibility, estimate realism, testability of acceptance criteria |

Leader runs **one moderated round** (not full `/council` debate — no convergence loop unless `heavy` + unresolved HIGH concerns). Sub-agents return structured JSON: `{ verdict: "approve"|"revise"|"block", concerns: [...], evidence: [...] }`. Leader merges into `PLAN-REVIEW.md`; on `revise`, plan returns to `plan` phase (max 2 revision cycles before askcard escalation).

**Depth gating (agent-first, registry-enforced):**

| `modelDepthTier` | Plan-council behaviour |
|------------------|------------------------|
| `quick` | Skip — inline CHECK-PLAN rubric only (legacy playbook hint) |
| `standard` | Lightweight: 2 sub-agents (research + verify perspectives), leader synthesis only |
| `heavy` | Full council: ≥3 participants, all perspectives, hard gate blocks `gsd_execute` until `plan-verify` pass |

**Model routing rules (Zero Hardcode — catalog + settings only):**

- **Leader** (plan write, plan-council moderate, plan-verify synthesize): `resolveLeaderModelDetailed(sessionModelId)` from `src/council/leader.ts` — auto-promotes to highest `premium` tier on session provider when `roleModels.leader` is unset or lower-tier; respects explicit `roleModels.leader` unless strictly promotable within same provider.
- **Council participants**: `resolveParticipants(sessionModelId, councilPreferMultiProvider)` — catalog slots when role-models unset; never cross-provider unless user opted in (`councilPreferMultiProvider`).
- **Sub-agent spawn**: reuse `Agent.runTaskRequest()` with capped budget (`MUONROI_SUB_AGENT_BUDGET_CHARS`); each perspective gets isolated scope — only leader synthesis re-enters parent context (matches playbook research directive).
- **Cost-aware downshift**: `pickCouncilTaskModel()` applies to classifier sub-tasks only; **plan write, plan-council moderation, and plan-verify synthesis NEVER downshift** — always leader premium.

**Enforcement (hard gate, not prompt-only):**

- `gsd_execute` tool returns `{ blocked: true, reason: "plan-verify pending" }` when `STATE.md` phase ≠ `execute` or `PLAN-VERIFY.md` lacks `verdict: pass`.
- `plan:post` loop point fires `runPlanCouncil()` before advancing phase.
- Harness emits `council-step` / `council-speaker` events during plan-council (existing protocol v0.4.0).

**Alignment with existing surfaces:**

| Existing | Reuse in plan-council |
|----------|----------------------|
| `src/council/index.ts` | Debate runner, askcard, research-need eval |
| `src/council/leader.ts` | `resolveLeaderModelDetailed`, `resolveParticipants`, `pickCouncilTaskModel` |
| `src/council/decisions-lock.ts` | Merge architect/skeptic sections into `PLAN-REVIEW.md` |
| `src/orchestrator/orchestrator.ts` | `runTaskRequest` for perspective sub-agents |
| `src/playbook/directives.ts` | Heavy rubric CHECK-PLAN step → pointer to native `gsd_plan_review` tool |

---

## File Map (target)

**New:**

| Path | Responsibility |
|------|----------------|
| `vendor/gsd-core` OR npm `@opengsd/gsd-core` | Pinned upstream runtime (prefer npm `package.json` dep; optional git submodule for dogfooding) |
| `src/gsd/host-adapter.ts` | Maps 12 loop-host points to muonroi calls |
| `src/gsd/workflow-engine.ts` | `resolveWorkflowState`, `dispatch`, `advancePhase` — wraps gsd-tools |
| `src/gsd/workflow-tools.ts` | Agent-facing tools: `gsd_status`, `gsd_discuss`, `gsd_plan`, `gsd_plan_review`, `gsd_execute`, `gsd_verify` |
| `src/gsd/plan-council.ts` | `runPlanCouncil()` — spawn perspective sub-agents, leader synthesis, write `PLAN-REVIEW.md` + `PLAN-VERIFY.md` |
| `src/gsd/plan-council-prompts.ts` | Perspective-specific system prompts (architect / skeptic / research / security / implementer) |
| `src/gsd/config-bridge.ts` | Maps `~/.muonroi-cli/settings.json` model roles → `.planning/config.json` gsd model overrides |
| `src/gsd/__tests__/host-adapter.test.ts` | Loop-point wiring characterization tests |
| `src/gsd/__tests__/workflow-engine.test.ts` | Init/progress/state round-trip against temp `.planning/` |
| `src/gsd/__tests__/plan-council.test.ts` | Depth gating, leader premium routing, execute-block until plan-verify pass |

**Modify:**

| Path | Change |
|------|--------|
| `src/pil/layer4-gsd.ts` | Shrink rubric → short hint + inject active `STATE.md` position; delegate depth to `WorkflowEngine` |
| `src/playbook/directives.ts` | Deprecate long HYBRID rubrics for `standard/heavy` when `MUONROI_GSD_NATIVE=1`; CHECK-PLAN step points to `gsd_plan_review` |
| `src/tools/registry.ts` | Register workflow tools when native GSD enabled; hard-block `gsd_execute` when plan-verify pending |
| `src/council/leader.ts` | Export `resolvePlanCouncilLeader()` wrapper (alias `resolveLeaderModelDetailed` with plan-council telemetry tag) |
| `src/orchestrator/message-processor.ts` | On turn start: `workflowEngine.syncContext(pilCtx)`; on tool success: phase boundary hooks |
| `src/product-loop/loop-driver.ts` | Optional: `WorkflowKind.product` delegates phase lifecycle to gsd-core `phase.cjs` |
| `src/ee/phase-tracker.ts` | Read phase from gsd `STATE.md` instead of PIL guess |
| `package.json` | Add `@opengsd/gsd-core` dependency + `engines.node >= 22` note for gsd subprocess |

**Do NOT modify:** gsd-core source inside node_modules (upstream only; patch via adapter).

---

## Phase 0 — Hotfix + Spike (1–2 days)

### Task 0.1: Session `85d3ff93f583` tool-loop hardening

- [ ] Reproduce: glm-4.7 + `write_file` with empty `input` → confirm provider error on next round
- [ ] In `tool-engine.ts`: if tool call args fail Zod/JSON parse, **do not** append malformed assistant tool-call to provider history; inject repair user message instead
- [ ] Add test: empty `write_file` input → repair path, session continues
- [ ] Audit Z.ai multi-turn tool+reasoning message shape (seq 30 has `reasoning` + broken `tool-call`)

### Task 0.2: gsd-core boot spike

- [ ] `bun add @opengsd/gsd-core@1.7.0-rc.1` (or pin git tag)
- [ ] Spike script `scripts/spike-gsd-boot.ts`: `createRequire` → `loop-host-contract.cjs`, `init.progress` in temp dir
- [ ] Document: Bun can/cannot call `gsd-tools` in-process (evidence in spike output)
- [ ] Gate: spike passes in CI (linux + optional WSL)

---

## Phase 1 — Loop Host Foundation (3–5 days)

### Task 1.1: `.planning/` bootstrap

- [ ] `ensurePlanningWorkspace(cwd)` — create `.planning/config.json` from catalog-driven defaults if missing
- [ ] Bridge muonroi `getRoleModels()` → gsd config `models.*` keys (no hardcoded model IDs — catalog + settings only)
- [ ] Feature flag: `MUONROI_GSD_NATIVE=1` (default off until Phase 3)

### Task 1.2: `WorkflowEngine` read path

- [ ] `readState(cwd)` → parse `STATE.md` via gsd `state-document.cjs`
- [ ] `readProgress(cwd)` → `init.progress` dispatch
- [ ] `currentPhase(cwd)` → phase locator
- [ ] Unit tests with fixture `.planning/` tree

### Task 1.3: `GsdHostAdapter` skeleton

Wire loop-host points (no-op passthrough first, then real hooks):

| Loop point | muonroi hook |
|------------|--------------|
| `discuss:pre/post` | council gate / askcard (existing) |
| `plan:pre` | Leader (premium) drafts `PLAN.md` from research findings |
| `plan:post` | **`runPlanCouncil()`** — multi-perspective review; writes `PLAN-REVIEW.md` |
| `plan-review:post` | Leader (premium) synthesizes `PLAN-VERIFY.md`; advances `STATE.md` → `execute` on pass |
| `execute:pre/wave:*/post` | orchestrator `processMessage` / subagent `task` — **blocked** until plan-verify pass |
| `verify:pre/post` | `self-verify` tier1 + `bun test` scoped |
| `ship:pre/post` | `maintain/pr-builder` optional |

- [ ] Characterization test: all 12 points registered, order matches `loop-host-contract.cjs`

---

## Phase 2 — Agent-First Native Tools (3–4 days)

Replace "you should use GSD" prompt text with **callable tools** the model chooses:

| Tool | Maps to | When agent uses it |
|------|---------|-------------------|
| `gsd_status` | `init.progress` | Orient mid-task |
| `gsd_discuss` | discuss phase + askcard | Ambiguity / gray areas |
| `gsd_plan` | plan phase → `PLAN.md` (leader premium) | Multi-step task ≥3 steps |
| `gsd_plan_review` | plan-council + plan-verify (leader premium) | **After `gsd_plan`, before `gsd_execute`** — mandatory at `standard`/`heavy` depth |
| `gsd_execute` | execute wave → subagent or top-level loop | After `PLAN-VERIFY.md` verdict pass only |
| `gsd_verify` | verify → tests + self-verify | Before declaring done |

- [ ] Tool descriptions: agent-first ("use when task complexity warrants"), not mandatory
- [ ] `todo_write` remains UI checklist; gsd state is source of truth in `STATE.md`
- [ ] Vision gate / cost caps unchanged — workflow tools respect existing budgets

### Task 2.1: `runPlanCouncil()` — multi-perspective plan review

- [ ] `plan-council.ts`: accept `PLAN.md` + research findings; spawn N perspective sub-agents via `runTaskRequest`
- [ ] Leader (premium via `resolveLeaderModelDetailed`) moderates one round; merge perspectives into `PLAN-REVIEW.md`
- [ ] Leader synthesizes `PLAN-VERIFY.md` with `{ verdict, concerns[], revisionRequired }`
- [ ] On `revise`: rewrite `PLAN.md`, re-run council (max 2 cycles → askcard escalation)
- [ ] Emit harness events: `council-step`, `council-speaker`, `council-turn-length` during plan-council
- [ ] Unit test: `gsd_execute` blocked when `PLAN-VERIFY.md` missing or `verdict !== pass`
- [ ] Unit test: `quick` depth skips plan-council; `heavy` spawns ≥3 perspectives

### Task 2.2: Depth auto-selection (keep agent-first)

- [ ] L1 `modelDepthTier` (`quick|standard|heavy`) sets **default** workflow depth
- [ ] Agent may escalate via `gsd_plan` + `gsd_plan_review` or de-escalate via inline execute (quick only)
- [ ] Remove duplicate keyword phase detection from hot path (`detectGsdPhase` → diagnostic only)
- [ ] Registry gating: `gsd_plan_review` registered only when depth ≥ `standard` AND `MUONROI_GSD_NATIVE=1`

---

## Phase 3 — Layer4 Migration (2–3 days)

- [ ] When `MUONROI_GSD_NATIVE=1`: layer4 injects ≤200 chars hint + `STATE.md` position block, **not** 1.7K-char HEAVY rubric
- [ ] `informational` turns (questions, reports): skip workflow tools entirely (existing gate preserved)
- [ ] Chitchat: skip (existing gate preserved)
- [ ] Telemetry: `logInteraction` event `gsd-native` with phase, depth, tool invocations, plan-council participant count + leader tier

### Task 3.1: Deprecation path

- [ ] `MUONROI_GSD_NATIVE=0` keeps legacy playbook (rollback)
- [ ] Default flip to `1` after harness self-verify passes on workflow surfaces
- [ ] Update `src/pil/native-capabilities-workbook.ts` to describe native tools not external skills

---

## Phase 4 — `/ideal` Convergence (5–8 days, optional parallel)

**Non-goal:** Replace `/ideal` UX. **Goal:** Share phase engine.

- [ ] `WorkflowKind.product` in gsd types → `/ideal` scoping writes `PROJECT.md` + `ROADMAP.md` per gsd conventions
- [ ] `phase-runner.ts` (product-loop) calls gsd `phase.cjs` for DAG instead of bespoke `phases.md` only
- [ ] Keep sprint-runner, council, discovery as muonroi-specific capabilities registered in `capability-registry` overlay (future ADR-1244-style)

---

## Phase 5 — EE Closure (2 days)

- [ ] `firePhaseOutcome` on gsd `verify:post` pass/fail
- [ ] `ee.query` recall for `.planning/` checkpoint summaries (extend existing anti-mù path)
- [ ] Remove dead `routeTask` brain call from layer4 when unified PIL supplies `gsd_phase`

---

## What We Explicitly Do NOT Port

- 50+ Claude/Cursor skill markdown files as mandatory slash commands
- gsd-core installer / runtime-specific transforms (Claude Code frontmatter) — muonroi IS the runtime
- Graphify / workstreams / ultraplan (optional capabilities later via registry overlay)
- Duplicate STATE.md logic in TS (always call gsd-core)

---

## Risk Register

| Risk | Mitigation |
|------|------------|
| Node 22 vs Bun runtime | Subprocess `gsd-tools` fallback; CI matrix |
| CJS/ESM interop | `createRequire`; no fork of gsd sources |
| Double workflow (`/ideal` + native) | Feature flags; `WorkflowKind` discriminant |
| Model emits broken tool calls (85d3ff93f583) | Phase 0 repair gate before provider round-trip |
| Prompt budget bloat | Shrink layer4; read STATE.md on demand via `gsd_status` tool |
| Zero Hardcode Rule | All model routing via catalog + settings → gsd config bridge |
| Plan-council latency + cost (3–5 LLM calls) | Depth gating (`quick` skips); cost-aware on classifier only; leader premium justified for plan quality; cap revision cycles at 2 |
| Leader tier unavailable on provider | Fail-open to session model with telemetry warning; never cross-provider silently |
| Plan-council blocks urgent hotfix | `debug` phase + `quick` tier bypass; explicit `gsd_execute --force` behind yolo + audit log |

---

## Verification Criteria

**Phase 0:**
- [ ] `bun test` green including new tool-loop repair test
- [ ] Spike script exits 0: reads `loop-host-contract`, runs `init.progress` on temp project

**Phase 1–2:**
- [ ] `gsd_status` in headless `--prompt` session returns valid progress JSON
- [ ] Agent completes 3-step task: plan → **plan-review** → edit file → verify without external `gsd-*` skills
- [ ] `STATE.md` updates after each phase transition (file evidence)
- [ ] `PLAN-REVIEW.md` + `PLAN-VERIFY.md` written before first `write_file`/`edit_file` at `heavy` depth
- [ ] `gsd_execute` returns blocked when called before plan-verify pass (registry test)
- [ ] Leader model in plan-council is `premium` tier when catalog provides one on session provider (forensics event)

**Phase 3:**
- [ ] Tier 1 self-verify on touched `src/gsd/**`, `src/pil/layer4-gsd.ts`, `src/tools/registry.ts`
- [ ] Chitchat turn: layer4 `applied: false` (no GSD tools offered)
- [ ] Informational question: no implement/verify narration leak (regression vs session 829a83888dd2)

**Phase 4–5:**
- [ ] `/ideal` greenfield run produces gsd-compatible `.planning/` tree
- [ ] `usage forensics` shows `gsd-native` interaction events

---

## PR Stack (suggested order)

1. `fix/tools-empty-args-repair` — Phase 0 hotfix (session 85d3ff93f583 class)
2. `feat/gsd-spike-vendor` — npm dep + boot spike + CI
3. `feat/gsd-workflow-engine-read` — Phase 1 read path + tests
4. `feat/gsd-host-adapter` — loop points wired (discuss/verify first)
5. `feat/gsd-native-tools` — registry tools + feature flag
6. `feat/gsd-plan-council` — `runPlanCouncil()` + `gsd_plan_review` + execute hard gate
7. `feat/gsd-layer4-shrink` — replace playbook shell; CHECK-PLAN → `gsd_plan_review`
8. `feat/ideal-gsd-phase-unify` — Phase 4 (can lag)

---

## Open Questions (resolve in Phase 0 spike)

1. **npm pin vs git submodule?** — Default npm `@opengsd/gsd-core@1.7.0-rc.1`; submodule only if we need pre-release patches.
2. **In-process vs subprocess gsd-tools?** — Decide from spike evidence (latency, Bun `require` stability).
3. **Default on?** — Stay opt-in (`MUONROI_GSD_NATIVE=1`) until Phase 3 harness green.
4. **Plan-council participant count at `standard` depth?** — Default 2 (research + verify); spike whether 3 improves quality enough to justify cost.
5. **`plan-review:post` as separate loop point vs nested in `plan:post`?** — Decide from gsd-core `loop-host-contract.cjs` — add host overlay point if upstream lacks it.