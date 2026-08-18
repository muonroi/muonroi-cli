# Run: Catalog all StepFun models

## Requirement Baseline
Original goal:
- Add every StepFun model shown by the user to both the FastAPI-served catalog and `catalog.json`.

Inputs:
- User screenshot listing nine StepFun model IDs.
- Official StepFun model and pricing documentation.
- `services/catalog-api/main.py` and `src/models/catalog-client.ts` schemas.

Required outcomes:
- R1: All nine screenshot model IDs are present in `src/models/catalog.json`.
- R2: FastAPI preserves and serves the model metadata without null-shaped client regressions.
- R3: Only text-capable agent models participate in automatic routing; endpoint-specialized audio/image models remain cataloged but excluded.

Constraints:
- Preserve exact vendor model IDs and current vendor pricing.
- Record non-token pricing units instead of inventing token prices.
- No support claim for media endpoints the CLI does not implement.

Out of scope:
- Implementing image generation/editing, TTS, ASR, or WebSocket realtime calls.

Definition of done:
- Static catalog and FastAPI endpoint expose all nine IDs with test coverage.
- TypeScript and Python schemas validate the same fields.

Affected area / blast radius:
- Catalog JSON, TS client schema, FastAPI Pydantic schema, tests, and catalog documentation.

Current gate:
- execute

Execution mode:
- auto

## Workflow State
- Current stage: closed
- Current gate: closed
- Next required transition: none.
- Current roadmap phase: P1
- Current roadmap phase status: completed
- Why blocked or not advancing: none

## Gray Area Register
| ID | Type | Question | Owner | Resolution path | Status |
|---|---|---|---|---|---|
| G1 | repository | Does FastAPI have a separate catalog source? | qc-flow | research | resolved: it reads `src/models/catalog.json` directly |
| G2 | contract | How can non-token prices survive FastAPI serialization? | qc-flow | research | resolved: add optional price-unit fields to mirrored schemas |
| G3 | safety | Should media endpoint models auto-route to the text agent? | qc-flow | research | resolved: catalog them with `tier_routing:false` |

## Delivery Roadmap
Roadmap goal:
- Complete the StepFun model catalog while preserving safe agent routing.

Roadmap status:
- completed

| Phase | Status | Purpose | Depends on | Verification checkpoint |
|---|---|---|---|---|
| P1 | completed | Add model rows, shared metadata fields, and direct FastAPI coverage | research | catalog validation, FastAPI pytest, typecheck |

## Resume Digest
- Goal: catalog all nine StepFun models and expose them through FastAPI.
- Execution mode: auto.
- Current gate: execute.
- Current phase / wave: P1 / W1.
- Remaining blockers: none.
- Experience constraints: FastAPI response must exclude null optionals; catalog.json remains its source.
- Active hook-derived invariants: custom base URL/credential paths are unaffected.
- Next verify: focused Vitest + `pytest services/catalog-api/` + typecheck.
- Recommended next command: `Use $qc-flow and resume from runs/catalog-stepfun-models.md in session 01a01379-6a30-77f0-bd51-a0c3542b2fd2.`

## Compact-Safe Summary
- Goal: catalog all nine StepFun models.
- Current gate: execute.
- Current phase / wave: P1 / W1.
- Requirements still satisfied: R1, R2, R3.
- Remaining blockers: none.
- Experience constraints: FastAPI and TS schema must stay mirrored.
- Active hook-derived invariants: media models never enter automatic text-agent routing.
- Phase relation: independent-next-phase.
- Compaction action: clear.
- Brain session-action verdict: not-evaluated.
- Brain verdict confidence: n/a.
- Brain verdict rationale: no session-action decision needed.
- Brain verdict source: not-recorded.
- Suggested session action: clear after feature close.
- Carry-forward invariants: source catalog path, null omission, tier routing guard.
- What to forget: web-search excerpts.
- What must remain loaded: model rows and verification results.
- Next verify: focused TS/Python tests.
- Resume with: `Use $qc-flow and resume from runs/catalog-stepfun-models.md in session 01a01379-6a30-77f0-bd51-a0c3542b2fd2.`

## Wave Handoff
- Trigger: broad verify preparation.
- Source checkpoint: P1 / W1.
- Next target: phase-close.
- Phase relation: independent-next-phase.
- Brain session-action verdict: not-evaluated.
- Brain verdict confidence: n/a.
- Brain verdict rationale: no session-action decision needed.
- Brain verdict source: not-recorded.
- Suggested session action: clear after feature close.
- Sealed decisions: screenshot IDs, source catalog path, media routing guard.
- Carry-forward invariants: schemas preserve unit pricing fields and no null optional response fields.
- Expired context: exploratory output.
- What to forget: exploratory output.
- What must remain loaded: source diff, tests.
- Resume payload: `Use $qc-flow and resume from runs/catalog-stepfun-models.md in session 01a01379-6a30-77f0-bd51-a0c3542b2fd2.`

## Session Risk
- low
Why:
- One bounded catalog/schema wave.

## Context Risk
- low
Why:
- Source, contracts, pricing, and verify commands are evidence-backed.

## Burn Risk
- low
Why:
- Research closes all schema and model-metadata questions before editing.

## Stall Status
- none
Last stalled step:
- none
Next smaller check:
- focused catalog parser test.

## Approval Strategy
- local-only
Current reason:
- local edits and verification only.
If blocked:
- capture the exact failure in this artifact.

## Experience Snapshot
Active warnings:
- [id:1772f26c col:experience-selfqa] FastAPI null optionals made remote catalog invalid for the CLI.
Why:
- New optional unit-pricing fields must use FastAPI's existing `response_model_exclude_none=True` behavior.
Decision impact:
- Mirror fields in Pydantic and Zod, and test the actual endpoint payload.
Experience constraints:
- Do not add null values that make the client reject the whole remote catalog.
Active hook-derived invariants:
- `services/catalog-api/main.py` remains a direct server of `src/models/catalog.json`.
Still relevant:
- yes
Warning disposition:
- [id:1772f26c col:experience-selfqa] status=applied evidence=artifact reason=verified source path and null-omission response behavior
Ignored warnings:
- none

## Clarify State
Goal:
- Add all screenshot StepFun models to the shared catalog.

Required outcomes:
- R1, R2, R3.

Constraints:
- Accurate pricing/unit metadata; no media-runtime implementation claim.

Out of scope:
- Media endpoint implementation.

Known context:
- repo/module: `src/models/catalog.json`, `src/models/catalog-client.ts`, `services/catalog-api/main.py`.
- likely files/search targets: same plus catalog/FastAPI tests.
- technical constraints: required numeric token-price fields; FastAPI drops undeclared model fields.

Affected area / blast radius:
- user-visible flows or UI: extra catalog models; automatic picker stays text-agent-safe.
- API / contract / integration points: `GET /api/v1/models` returns new rows and metadata.
- data / schema / persistence: shared JSON and mirrored schemas.
- config / env / deploy / CI: no deployment configuration change.
- tests / observability / docs / security: direct FastAPI coverage, catalog validation, README.

User-confirmed assumptions:
- A1: every model in the supplied screenshot belongs in the StepFun catalog.

Open questions:
- none.

Gray-area triggers:
- none.

Context sufficiency check:
- Repo area known: yes
- Relevant files identifiable: yes
- Affected area explicit: yes
- Protected boundaries known: yes
- Constraints understood: yes
- Risks understood: yes
- Verify path known: yes

Decision:
- `clear`

Next action:
- Execute P1/W1.

## Evidence Basis
- repo evidence: `_default_catalog_path()` resolves to `src/models/catalog.json`; FastAPI serializes declared Pydantic fields only; client Zod schema validates remote catalog.
- docs or external evidence: official StepFun docs name IDs, endpoints, capability boundaries, and pricing.
- explicit research-skip rationale: max output limits not published for all media models, so catalog uses zero only for endpoint-specialized non-token models excluded from routing.

## Research Pack
Goal:
- Verify the shared source and canonical metadata for every requested model.

Missing context being filled:
- FastAPI source path and exact pricing/unit treatment.

Affected area being validated:
- shared catalog JSON and TS/Python schemas.

Research questions:
- Q1: Does FastAPI use a distinct catalog? -> no; it reads `src/models/catalog.json`.
- Q2: Which screenshot models are text-agent capable? -> Step 3.5 and Step 3.7 Chat Completions; other audio/image models require specialty endpoints.
- Q3: How are prices published? -> token pricing for reasoning/end-to-end speech; unit pricing for TTS/ASR/image.

Evidence:
- `services/catalog-api/main.py` catalog path and response model.
- Official StepFun docs: Step 3.7, Step 3.5, audio overview, image edit, and pricing details.

Answered questions:
- Q1 -> direct shared catalog source.
- Q2 -> automatic routing for both Step 3.5 text-model IDs and `step-3.7-flash`; all specialty models `tier_routing:false`.
- Q3 -> use declared optional `pricing_unit`/`unit_price` for non-token billing.

Unresolved questions:
- none.

Active gray-area triggers:
- none.

Decision:
- `context-sufficient`

Why:
- Exact model IDs, API compatibility, price data, affected schemas, and verification paths are proven.

Next action:
- Implement P1/W1.

## Decision Register
| ID | Decision | Why now | Revisit when | Status |
|---|---|---|---|---|
| D1 | FastAPI continues to serve the shared JSON, not a duplicated catalog | source proves this topology | catalog architecture changes | active |
| D2 | Use `tier_routing:false` for image/audio-specialized rows | protects text agent from incompatible endpoints | CLI gains those media runtimes | active |
| D3 | Preserve published non-token prices with explicit unit fields | avoids fabricated per-token price data | catalog cost model gains native units | active |

## Dependency Register
| ID | Scope | Depends on | Why | Risk if wrong | Status |
|---|---|---|---|---|---|
| DEP1 | API catalog | Pydantic `CatalogModel` | undeclared fields are dropped | lost unit price metadata | clear |
| DEP2 | CLI catalog | Zod `CatalogModelSchema` | remote payload must validate | fallback to static catalog | clear |

## Verified Plan
Goal: complete StepFun model coverage through the shared catalog without routing media APIs as text-agent models.
Feature / issue this roadmap closes: all screenshot StepFun models in shared catalog.
Roadmap phase this plan implements: P1.
Requirements covered: R1, R2, R3.
Out of scope: media API execution.
Plan inputs / evidence:
- Research Pack and official docs.

Affected area coverage:
- Add shared optional unit-pricing fields to TS/Python schemas.
- Add nine exact catalog rows and remove the conflicting base-model alias.
- Add catalog and FastAPI endpoint assertions.

| Phase | Status | Purpose | Covers requirements | Depends on | Exit criteria | Verify |
|---|---|---|---|---|---|---|
| P1 | completed | Complete catalog and schemas | R1, R2, R3 | research | all nine IDs served and validated | Vitest, pytest, typecheck |

## Waves
| Wave | Phase | Status | Change | Done when | Verify |
|---|---|---|---|---|---|
| W1 | P1 | completed | Shared schema fields, model rows, tests/docs | every screenshot ID and price metadata persists through API | focused Vitest + pytest + typecheck |

## Current Execution Wave
Phase: P1
Wave: W1
Purpose: Complete StepFun catalog coverage and preserve API serialization.
Covers requirements: R1, R2, R3.
Depends on: none.

Files expected to change:
- `src/models/catalog.json`, `catalog.README.md`, `catalog-client.ts`, catalog tests.
- `services/catalog-api/main.py`, `test_main.py`.

Done when:
- All nine IDs are static and served through `/api/v1/models?provider=stepfun`.

Verify:
- relevant Vitest, `pytest services/catalog-api/ -q`, `bun run typecheck`.

Invariant requirements:
- no specialized media model participates in automatic text-agent routing.
- the remote API excludes unset optional fields.

Wave Handoff preparation:
- Candidate phase relation: independent-next-phase.
- Candidate compaction action: clear.
- Candidate sealed decisions: D1, D2, D3.
- Candidate carry-forward invariants: direct catalog source, tier-routing guard.
- Candidate expired context: search snippets.
- Candidate what to forget: raw web output.
- Candidate what must remain loaded: catalog rows and tests.

Current status:
- `completed`

Current step notes:
- Added nine exact rows, shared price/limit fields, and direct FastAPI coverage.

Risks:
- Pydantic could drop fields or client schema could reject remote shape.

Experience inputs:
- [id:1772f26c col:experience-selfqa] applied.

Verification result:
- passed: `bun run typecheck`; focused catalog/registry Vitest (42 tests); StepFun provider Vitest (44 tests); `python -m pytest services/catalog-api/ -q` (18 tests).

## Goal-Backward Verification
Goal this checkpoint proves:
- All user-supplied StepFun model IDs are reliably available to both catalog consumers.

Proof status:
- passed

| Check | Why it proves the goal | Evidence | Status |
|---|---|---|---|
| Static IDs | contains all nine requested IDs | catalog-validation Vitest assertion | passed |
| FastAPI response | server returns the same IDs and unit metadata | direct `/api/v1/models?provider=stepfun` pytest assertion | passed |
| Client validation | remote shape remains consumable | Zod catalog validation and TypeScript typecheck | passed |

## Current Status
Current phase: P1 complete.
Current wave: W1 complete.
Execution state: completed.

## Recommended Next Command
- No follow-up action required.

## Verification Ledger
- 2026-08-18 FastAPI/catalog source + official StepFun docs -> pass (context sufficient)
- 2026-08-18 `bun run typecheck` -> pass
- 2026-08-18 focused catalog/registry Vitest -> 42 passed
- 2026-08-18 focused StepFun provider Vitest -> 44 passed
- 2026-08-18 `python -m pytest services/catalog-api/ -q` -> 18 passed (one upstream TestClient deprecation warning)

## Blockers
- none

## Requirements Still Satisfied
- R1
- R2
- R3

## Relock History
- v1: initial clarify/research/verified plan.
