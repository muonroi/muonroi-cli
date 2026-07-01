# GSD Milestone Completion Plan (Phase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between muonroi native GSD task workflow (`discuss → plan → execute → verify`) and upstream **milestone artifacts** (`.planning/phases/*`, ROADMAP checkboxes, ship polish) — without porting graphify/workstreams/50+ external skills.

**Architecture:** Extend existing Loop Host (`src/gsd/loop-host.ts`) + `workflow-tools.ts` with three new modules: `phase-sync.ts` (gsd-tools `phase add/complete` + `roadmap update-plan-progress`), `ship-bridge.ts` (task-level delivery polish reusing `ship-polish.ts` patterns), and optional `edit-gate.ts` (heavy-only hard block on `write_file`/`edit_file`). All state transitions continue to delegate to `@opengsd/gsd-core` via `gsd-dispatch.ts` — no duplicate STATE.md logic in TS.

**Tech Stack:** TypeScript (Bun), `@opengsd/gsd-core@1.7.0-rc.1`, existing PIL/orchestrator/product-loop.

**Evidence — current gaps (post Phase 1–5):**

| Gap | Evidence |
|-----|----------|
| No `gsd_ship` tool | `GSD_WORKFLOW_TOOL_NAMES` ends at `gsd_verify`; `ship:post` overlay is `deferred` |
| No phase dir lifecycle | `phase add` creates `.planning/phases/02-*` in spike but muonroi never calls it |
| `gsd_status` thin | Returns `state` + raw `progress` only — no `current_phase`, `phases_remaining` |
| No edit hard-gate | `canExecute()` gates `gsd_execute` only; `registry.ts` has no GSD gate on `edit_file` |
| Workbook stale | `native-capabilities-workbook.ts` omits `gsd_*` tools |

**Non-goals (unchanged from Phase 4–5 plan):**

- Graphify, workstreams, ultraplan, gsd installer
- Replace `/ideal` UX
- Port 50+ external skill markdown files
- Duplicate gsd-core STATE/phase logic in TypeScript

---

## Phase 6.1 — Phase Sync Module (2 days)

### Task 6.1.1: `dispatchPhase*` wrappers

**New:** `src/gsd/phase-sync.ts`

| Function | gsd-tools call | When |
|----------|----------------|------|
| `dispatchPhaseAdd(cwd, description)` | `phase add <description>` | `gsd_plan` success (first plan for task) |
| `dispatchPhaseComplete(cwd, phaseNum)` | `phase complete <N>` | `gsd_verify` pass |
| `dispatchRoadmapPlanProgress(cwd, phaseNum)` | `roadmap update-plan-progress <N>` | after phase complete |
| `syncTaskPhaseOnPlan(cwd, planTitle)` | compose above | called from `gsd_plan` |
| `syncTaskPhaseOnVerifyPass(cwd)` | read ROADMAP analyze → complete current | called from `verify:post` |

- [ ] Parse plain-text stdout from `phase add` (returns phase number like `"02"`) — extend `gsd-dispatch` or handle in phase-sync
- [ ] Copy `PLAN.md` → `.planning/phases/<dir>/PLAN.md` when phase dir created
- [ ] Write `VERIFY.md` evidence into phase dir on verify pass
- [ ] Idempotent: skip `phase add` if `.planning/phases/` already has dir for current task slug
- [ ] Unit tests: `src/gsd/__tests__/phase-sync.test.ts` with temp `.planning/`

### Task 6.1.2: Wire loop host + tools

- [ ] `loop-host.ts` `plan:post` overlay → `syncTaskPhaseOnPlan` when `Workflow Kind` ≠ `product`
- [ ] `loop-host.ts` `verify:post` overlay → `syncTaskPhaseOnVerifyPass` on pass
- [ ] `product` kind: defer to existing `syncPhasePlanToRoadmap` (no duplicate phase add)

---

## Phase 6.2 — `gsd_ship` Tool (1 day)

### Task 6.2.1: `ship-bridge.ts`

**New:** `src/gsd/ship-bridge.ts`

Reuse patterns from `src/product-loop/ship-polish.ts` but for **task-level** ship (no ProductSpec required):

| Action | Behaviour |
|--------|-----------|
| README.md | Write stub from `PLAN.md` title + acceptance if missing |
| package.json | Fill missing name/description/version only (never overwrite) |
| SHIP.md | Always write `.planning/SHIP.md` with verify evidence + changed files summary |
| Git | **No** `git init`/commit (same policy as ship-polish) |

- [ ] `runTaskShip(cwd, opts)` returns `ShipResult` with notes[]
- [ ] `loop-host.ts` `ship:pre/post` call `runTaskShip` instead of deferred stub
- [ ] Advance STATE phase → `review` + Status `Phase complete` (existing)

### Task 6.2.2: `gsd_ship` tool registration

- [ ] Add to `GSD_WORKFLOW_TOOL_NAMES` + `registerGsdWorkflowTools`
- [ ] Description: agent-first — "after gsd_verify pass, polish delivery artifacts"
- [ ] Input: optional `{ notes, commitMessage }` — commitMessage stored in SHIP.md only
- [ ] Fire `logGsdNativeEvent` with `loopPoint: ship:post`
- [ ] Test: `workflow-tools.test.ts` — gsd_ship writes SHIP.md

---

## Phase 6.3 — `gsd_status` Enrichment (0.5 day)

### Task 6.3.1: Structured status payload

Extend `gsd_status` execute to return:

```json
{
  "state": { "phase", "depth", "planVerified" },
  "progress": { "milestone_version", "current_phase", "next_phase", "phase_count", "completed_count", "phases_remaining" },
  "gates": { "canExecute", "canShip", "planVerifyVerdict" },
  "artifacts": { "planExists", "planVerifyExists", "verifyExists", "phaseDir" }
}
```

- [ ] `phases_remaining = phase_count - completed_count` when both present
- [ ] `canShip` = verify passed + phase is `verify` or `review`
- [ ] `phaseDir` = latest `.planning/phases/*` dir name if any
- [ ] Test: `workflow-engine.test.ts` or dedicated status test

---

## Phase 6.4 — Optional Hard Gate (1 day)

### Task 6.4.1: `MUONROI_GSD_HARD_GATE` flag

**New:** `src/gsd/edit-gate.ts`

| Env | Behaviour |
|-----|-----------|
| unset / `0` | Soft gate only (current) |
| `1` | Block `write_file`/`edit_file` at `heavy` depth when `readPlanVerifyVerdict() !== 'pass'` |

- [ ] `shouldBlockEdit(cwd, depth)` — returns `{ blocked, reason }`
- [ ] Wire in `registry.ts` `write_file`/`edit_file` execute paths (same pattern as empty-write block)
- [ ] `quick` and `standard` never hard-block edits
- [ ] Test: `src/tools/__tests__/registry-gsd-gate.test.ts`

### Task 6.4.2: Layer4 hybrid hint for heavy

- [ ] When native on + `heavy`: append one line to hint: `CALL gsd_plan_review before edit_file at heavy depth`
- [ ] Keep ≤200 char base hint; heavy line adds ~60 chars max
- [ ] Test: `layer4-gsd.test.ts` asserts hybrid line present at heavy

---

## Phase 6.5 — Docs & Telemetry (0.5 day)

### Task 6.5.1: Native capabilities workbook

- [ ] Add `gsd_status`, `gsd_plan`, `gsd_plan_review`, `gsd_execute`, `gsd_verify`, `gsd_ship` to `NATIVE_CAPABILITIES` block
- [ ] One-line agent-first guidance: "use when multi-step code deliverable"

### Task 6.5.2: Telemetry

- [ ] `logGsdNativeEvent` on `phase-sync` complete + ship
- [ ] Extend `GsdNativeTelemetry` with `phaseNumber`, `shipNotes`

---

## Verification Criteria

**Unit:**
- [ ] `bunx vitest run src/gsd/__tests__/` — all green
- [ ] `bunx vitest run src/pil/__tests__/layer4-gsd.test.ts` — green
- [ ] `bunx vitest run src/gsd/__tests__/workflow-tools.test.ts` — includes gsd_ship
- [ ] `bun run typecheck` — 0 errors

**Integration (headless):**
- [ ] Temp project: `gsd_plan` → phase dir exists under `.planning/phases/`
- [ ] `gsd_verify` pass → ROADMAP checkbox `[x]` for phase (if ROADMAP present)
- [ ] `gsd_ship` → `.planning/SHIP.md` exists

**Regression:**
- [ ] `MUONROI_GSD_NATIVE=0` — no gsd_* tools, no edit gate
- [ ] `Workflow Kind=product` — phase-sync task path skipped

---

## PR Stack

1. `feat/gsd-phase-sync` — phase-sync module + loop host wiring
2. `feat/gsd-ship-tool` — ship-bridge + gsd_ship
3. `feat/gsd-status-enrich` — enriched gsd_status
4. `feat/gsd-hard-gate-opt-in` — edit-gate + layer4 hybrid
5. `docs/gsd-native-capabilities` — workbook update

---

## Risk Register

| Risk | Mitigation |
|------|------------|
| `phase add` returns plain text not JSON | Handle in phase-sync; already seen in spike (`stdout=02`) |
| Double phase dirs on re-plan | Idempotent slug check before add |
| Hard gate blocks urgent hotfix | Opt-in env only; `quick` never blocked; `gsd_execute --force` pattern documented |
| ship-polish needs ProductSpec | ship-bridge uses PLAN.md only — no ProductSpec dependency |
| Product `/ideal` double-sync | Skip task phase-sync when `Workflow Kind=product` |

---

## Open Questions (resolved in plan)

1. **Hard gate default?** — Opt-in `MUONROI_GSD_HARD_GATE=1`; soft agent-first remains default.
2. **Phase numbering?** — Trust gsd-tools `phase add` return value; don't invent numbers in TS.
3. **Milestone complete?** — Defer `milestone complete` to manual/user — task-level chat completes one phase at a time.

---

## Multi-Perspective Review Amendments (2026-07-01)

**Verdict:** APPROVE WITH CHANGES (architect + skeptic + implementer + security)

| # | Amendment | Source |
|---|-----------|--------|
| 1 | Hook `syncTaskPhaseOnPlan` at **`plan:pre`** (not `plan:post`) | Architect |
| 2 | Gate `verify:post` — phase-sync + advance only when `passed === true`; add `passed` to `gsd_verify` schema | Skeptic (blocker) |
| 3 | Add `ensureTaskRoadmap()` before `phase add` | Implementer |
| 4 | Write `*-VERIFICATION.md` (frontmatter `status: passed`) + `SUMMARY.md` before `phase complete` | Implementer |
| 5 | Add `readWorkflowKind()` guard — skip task sync when `product` | Architect + Skeptic |
| 6 | Narrow `ship-bridge` to **SHIP.md only** (no README/package.json v1) | Skeptic |
| 7 | **Defer Phase 6.4** edit-gate; extend nativeHint with `gsd_ship` instead | Skeptic |
| 8 | `dispatchPhase*` wrappers live in `gsd-dispatch.ts` | Architect |
| 9 | Require non-empty `evidence` when `passed !== false` on `gsd_verify` | Security |
| 10 | Store `Milestone Phase Dir` in STATE extension table for idempotency | Implementer |