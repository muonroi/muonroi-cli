# Run: Integrate StepFun provider

## Requirement Baseline
Original goal:
- Integrate the StepFun provider into muonroi-cli.

Inputs:
- User request (2026-08-18).
- StepFun official Chat Completion, model, tool-call, and pricing documentation.
- Existing OpenAI-compatible provider architecture in `src/providers/`.

Required outcomes:
- R1: StepFun is a first-class API-key provider using its documented OpenAI-compatible endpoint.
- R2: A documented StepFun model is cataloged so it can be selected and routed in the TUI.
- R3: Provider registries and focused tests cover the new provider.

Constraints:
- Do not hardcode model/provider IDs outside catalog and typed provider registries.
- Preserve existing provider routing and API-key storage behavior.
- Use the standard Open Platform endpoint, not the optional Step Plan subscription endpoint.

Out of scope:
- Step Plan subscription-specific endpoint selection.
- StepFun vision, audio, web-search, and OAuth support.

Definition of done:
- StepFun key, base URL, strategy, adapter, capabilities, picker, and catalog entry are wired.
- Relevant tests and typecheck pass without errors or warnings.

Affected area / blast radius:
- Provider contract: `types.ts`, endpoints, keychain, capabilities, strategy, adapter, settings.
- UI: splash/provider configuration screens.
- Model routing: local catalog.
- Tests/docs: provider coverage and catalog README.

Current gate:
- done

Execution mode:
- auto

## Workflow State
- Current stage: done
- Current gate: done
- Next required transition: feature close complete.
- Current roadmap phase: P1
- Current roadmap phase status: verified
- Why blocked or not advancing: none

## Gray Area Register
| ID | Type | Question | Owner | Resolution path | Status |
|---|---|---|---|---|---|
| G1 | contract | Which endpoint and protocol apply? | qc-flow | research | resolved: standard Open Platform OpenAI-compatible `https://api.stepfun.ai/v1` |
| G2 | model | Which model is safe for agent routing? | qc-flow | research | resolved: `step-3.5-flash-2603`, documented as tool-call capable, 256K context, $0.10/$0.30 per 1M |

## Delivery Roadmap
Roadmap goal:
- Deliver a selectible StepFun BYOK provider without changing existing provider behavior.

Roadmap status:
- done

Current roadmap phase:
- P1

| Phase | Status | Purpose | Depends on | Verification checkpoint |
|---|---|---|---|---|
| P1 | verified | Wire provider contract, picker, and catalog | research | focused provider/catalog tests + typecheck |

## Resume Digest
- Goal: first-class StepFun BYOK provider.
- Execution mode: auto.
- Current gate: done.
- Current phase / wave: P1 / W1 complete.
- Remaining blockers: none.
- Experience constraints: API key must remain env-store-backed; no raw key logging.
- Active hook-derived invariants: user provider baseURL overrides must flow through the factory choke point.
- Next verify: completed: focused Vitest provider/catalog suites and `bun run typecheck`.
- Recommended next command: none; feature complete.

## Compact-Safe Summary
- Goal: first-class StepFun BYOK provider.
- Current gate: done.
- Current phase / wave: P1 / W1 complete.
- Requirements still satisfied: R1, R2, R3.
- Remaining blockers: none.
- Experience constraints: env-backed key and factory-level baseURL override.
- Active hook-derived invariants: no hardcoded model selection; catalog owns StepFun model ID.
- Phase relation: independent-next-phase.
- Compaction action: clear.
- Brain session-action verdict: not-evaluated.
- Brain verdict confidence: n/a.
- Brain verdict rationale: no session-action query was needed.
- Brain verdict source: not-recorded.
- Suggested session action: clear after final verification.
- Carry-forward invariants: OpenAI-compatible adapter; `STEPFUN_API_KEY`; standard `/v1` endpoint.
- What to forget: exploratory command output.
- What must remain loaded: this run file and focused source/test files.
- Next verify: none; verified clean.
- Resume with: no active run; feature complete.

## Wave Handoff
- Trigger: feature close.
- Source checkpoint: P1 / W1.
- Next target: done.
- Phase relation: independent-next-phase.
- Brain session-action verdict: not-evaluated.
- Brain verdict confidence: n/a.
- Brain verdict rationale: no session-action query was needed.
- Brain verdict source: not-recorded.
- Suggested session action: clear after final verification.
- Sealed decisions: standard Open Platform API endpoint; one cataloged agent model.
- Carry-forward invariants: key resolution and custom baseURL rules remain centralized.
- Expired context: external-search snippets.
- What to forget: exploratory output.
- What must remain loaded: plan, source changes, test results.
- Resume payload: no active run; feature complete.

## Session Risk
- low
Why:
- One bounded implementation wave.

## Context Risk
- low
Why:
- Contract, source surface, and verify path are documented in this run.

## Burn Risk
- low
Why:
- No repeated verification or speculative fixes.

## Stall Status
- none
Last stalled step:
- none
Next smaller check:
- focused Vitest command.

## Approval Strategy
- local-only
Current reason:
- Repository edits and local verification only.
If blocked:
- record the command and exact failure in this run.

## Experience Snapshot
Active warnings:
- [id:b52cc357 col:experience-selfqa] env-store-backed BYOK and API key / OAuth exclusivity.
Why:
- StepFun is an API-key provider and must use the established env-store keychain path.
Decision impact:
- Add only the `STEPFUN_API_KEY` mapping; do not create a new credential store.
Experience constraints:
- Key secrets remain redacted and no OAuth path is introduced.
Active hook-derived invariants:
- User `providers.stepfun.baseURL` must resolve at the factory choke point.
Still relevant:
- yes
Warning disposition:
- [id:b52cc357 col:experience-selfqa] status=applied evidence=artifact reason=uses existing env-store and factory override paths
Ignored warnings:
- none

## Clarify State
Goal:
- Integrate the StepFun provider.

Required outcomes:
- R1: API-key provider wiring.
- R2: selectable/routable catalog model.
- R3: focused coverage.

Constraints:
- Standard Open Platform endpoint only.

Out of scope:
- Step Plan, multimodal APIs, OAuth.

Known context:
- repo/module: provider strategy registry, adapter registry, settings/keychain, model catalog, TUI lists.
- likely files/search targets: `src/providers/*`, `src/utils/settings.ts`, `src/ui/app.tsx`, `src/cli/config/screen-providers.ts`, `src/models/catalog.json`.
- technical constraints: provider IDs are typed and every registry must cover `ALL_PROVIDER_IDS`.

Affected area / blast radius:
- user-visible flows or UI: provider picker and provider-key configuration.
- API / contract / integration points: OpenAI-compatible chat-completions factory.
- data / schema / persistence: existing env-store key mapping and user baseURL config.
- config / env / deploy / CI: `STEPFUN_API_KEY`, optional `providers.stepfun.baseURL`.
- tests / observability / docs / security: provider coverage, catalog tests, catalog README; no key logs.

User-confirmed assumptions:
- A1: "tích hợp provider" includes a user-selectable and routable implementation.

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
- repo evidence: `ProviderId`, endpoint, keychain, strategy, adapter, capabilities, settings, UI, and catalog registries all require explicit StepFun entries; coverage test enforces the first four registries.
- docs or external evidence: StepFun officially documents OpenAI-compatible Chat Completions at `https://api.stepfun.ai/v1`, tool calling, `step-3.5-flash-2603` agent/coding use, 256K context, and $0.10 input / $0.30 output per 1M tokens.
- explicit research-skip rationale: vision/audio/web-search/Step Plan are outside this scoped provider integration.

## Research Pack
Goal:
- Establish the safe StepFun contract and all first-class provider integration points.

Missing context being filled:
- Endpoint, auth mechanism, agent model metadata, repository registry coverage.

Affected area being validated:
- Provider runtime and adapter, key storage/settings, TUI/provider screens, local catalog, focused tests.

Research questions:
- Q1: Does StepFun expose an OpenAI-compatible API and tool calls?
- Q2: Which endpoint and agent model metadata are authoritative?
- Q3: What repository registries must cover a new provider?

Evidence:
- StepFun Chat Completion docs: `POST https://api.stepfun.ai/v1/chat/completions`, Bearer API key, tool schema support.
- StepFun model overview/reasoning docs: `step-3.5-flash-2603` is agent/coding optimized with tool use and 256K context.
- StepFun pricing docs: $0.10 input ($0.02 cached) and $0.30 output per 1M for `step-3.5-flash-2603`.
- `src/providers/types.ts`, `endpoints.ts`, `keychain.ts`, strategy/adapter/capabilities registries, `settings.ts`, and TUI source show the required typed integration surface.

Answered questions:
- Q1 -> yes; use the existing `@ai-sdk/openai-compatible` integration path.
- Q2 -> standard base URL is `https://api.stepfun.ai/v1`; catalog `step-3.5-flash-2603`.
- Q3 -> type IDs, endpoint/keychain/settings, strategy/adapter/capabilities, splash/config UI, catalog/docs, and focused tests.

Unresolved questions:
- none.

Active gray-area triggers:
- none.

Evidence basis for planning:
- repo evidence: explicit typed records and coverage test.
- docs or external evidence: official StepFun docs above.
- explicit research-skip rationale for any untouched area: Step Plan and multimodal endpoints are separate products/capabilities.

Decision:
- `context-sufficient`

Why:
- The API contract, supported model, required repository surface, protected boundaries, and verification commands are concrete.

Next action:
- Execute the verified P1/W1 plan.

## Decision Register
| ID | Decision | Why now | Revisit when | Status |
|---|---|---|---|---|
| D1 | Use standard Open Platform `https://api.stepfun.ai/v1` | It is the general API contract; Step Plan is optional and out of scope | Step Plan support is requested | active |
| D2 | Catalog `step-3.5-flash-2603` as one model satisfying all routing tiers | Officially agent/coding optimized, tool-call capable, 256K; prevents unsupported model selection | Additional StepFun models are requested | active |

## Dependency Register
| ID | Scope | Depends on | Why | Risk if wrong | Status |
|---|---|---|---|---|---|
| DEP1 | Runtime strategy | `@ai-sdk/openai-compatible` | StepFun speaks the documented OpenAI-compatible API | requests cannot be sent | clear |
| DEP2 | Catalog model | official StepFun model/pricing docs | model ID/price must be current | selection/cost wrong | clear |

## Verified Plan
Goal: deliver StepFun as a selectable/routable BYOK provider through the existing OpenAI-compatible path.
Feature / issue this roadmap closes: StepFun provider integration.
Roadmap phase this plan implements: P1.
Requirements covered: R1, R2, R3.
Out of scope: Step Plan, multimodal, OAuth.
Plan inputs / evidence:
- Research Pack and official StepFun docs.
- Typed provider registries and coverage test.

Affected area coverage:
- Provider contract: add `stepfun` exactly where `ProviderId`-keyed records require it.
- Configuration/UI: expose it in existing settings and provider key flows.
- Routing: catalog a documented agent model without changing other provider orders.

| Phase | Status | Purpose | Covers requirements | Depends on | Exit criteria | Verify |
|---|---|---|---|---|---|---|
| P1 | verified | Add StepFun entries/strategy/catalog and coverage updates | R1, R2, R3 | research | all explicit provider surfaces covered | focused tests + typecheck |

## Waves
| Wave | Phase | Status | Change | Done when | Verify |
|---|---|---|---|---|---|
| W1 | P1 | done | Wire all provider surfaces, catalog model, docs, and tests | StepFun works through the same paths as existing OpenAI-compatible providers | focused Vitest suites + `bun run typecheck` |

## Plan Check
Requirement trace:
- R1 -> P1/W1 typed provider entries and `StepFunStrategy`.
- R2 -> P1/W1 catalog entry and picker exposure.
- R3 -> P1/W1 coverage/test expectation updates.

Affected-area trace:
- UI / flows -> splash and config provider arrays.
- API / contracts -> endpoint, strategy, adapter.
- data / persistence -> env-store mapping and user settings type/config.
- config / CI / deploy -> no deployment impact.
- tests / docs / observability / security -> focused test expectations and catalog README; no secret logging.

Risks:
- Step Plan endpoint differs from standard endpoint; scope fixes the standard endpoint explicitly.

Assumptions:
- User requests the general Open Platform provider rather than Step Plan subscription integration.

Verification of plan:
- Every phase maps to requirements: yes
- The roadmap closes one feature or issue cleanly: yes
- Affected area is explicit: yes
- Evidence basis is sufficient: yes
- Dependencies are clear: yes
- Verify path exists for each wave: yes
- Out of scope is explicit: yes
- Risky assumptions are called out: yes

Plan status:
- `verified`

## Current Execution Wave
Phase: P1
Wave: W1
Purpose: Add the standard StepFun OpenAI-compatible provider across explicit provider surfaces.
Covers requirements: R1, R2, R3.
Depends on: none.

Files expected to change:
- `src/providers/types.ts`, `endpoints.ts`, `keychain.ts`, `adapter.ts`, `capabilities.ts`, `strategies/registry.ts`, new `strategies/stepfun.strategy.ts`.
- `src/utils/settings.ts`, `src/ui/app.tsx`, `src/cli/config/screen-providers.ts`.
- `src/models/catalog.json`, `catalog.README.md`, focused provider tests.

Done when:
- Every typed registry covers `stepfun`; `STEPFUN_API_KEY` is routed through env-store; the catalog model is selectable.

Verify:
- Focused provider/catalog Vitest suites, followed by `bun run typecheck`.

Invariant requirements:
- Do not create another credential store.
- Factory-level custom baseURL precedence remains centralized in `runtime.ts`.
- Do not introduce Step Plan configuration without a user request.

Wave Handoff preparation:
- Candidate phase relation: independent-next-phase.
- Candidate compaction action: clear.
- Candidate sealed decisions: D1, D2.
- Candidate carry-forward invariants: typed registry coverage and env-store key management.
- Candidate expired context: external-search details.
- Candidate what to forget: exploratory output.
- Candidate what must remain loaded: source diff and verification results.

Current status:
- `done`

Current step notes:
- Provider, catalog, TUI, settings, tests, and documentation updated.

Risks:
- Cross-registry omission; coverage and typecheck will detect it.

Experience inputs:
- [id:b52cc357 col:experience-selfqa] applied.

Verification result:
- `bun run typecheck` -> pass (`tsc --noEmit`).
- Focused Vitest provider/catalog suite -> pass (6 files, 57 tests).

## Goal-Backward Verification
Goal this checkpoint proves:
- A user can configure and select StepFun as a first-class BYOK provider.

Proof status:
- verified

| Check | Why it proves the goal | Evidence | Status |
|---|---|---|---|
| Provider coverage | all runtime/adaptor/capability records resolve StepFun | focused suite passed | verified |
| Catalog/picker verification | a StepFun model exists and UI admits the provider | runtime integration and catalog validation passed | verified |
| Typecheck | typed provider surfaces are complete | `bun run typecheck` passed | verified |

## Current Status
Current phase: P1.
Current wave: W1.
Execution state: done.

## Latest Phase Close
Phase: P1
Result:
- StepFun is available as a first-class OpenAI-compatible BYOK provider with `STEPFUN_API_KEY`, its standard `/v1` endpoint, a cataloged agent model, and UI exposure.

Requirements covered:
- R1, R2, R3.

Verification completed:
- `bun run typecheck` -> pass.
- `bunx vitest run src/providers/endpoints.test.ts src/providers/adapter.test.ts src/providers/__tests__/provider-coverage.test.ts src/providers/__tests__/capabilities-cosmetic.test.ts src/providers/__tests__/runtime-integration.test.ts src/models/catalog-validation.test.ts` -> 6 files / 57 tests passed.

Requirements still satisfied:
- R1, R2, R3.

Phase Relation:
- independent-next-phase

Compaction action:
- clear

Sealed decisions:
- D1, D2.

Carry-forward invariants:
- StepFun remains API-key-only and uses the existing OpenAI-compatible and env-store paths.

Expired context:
- exploratory research output.

What to forget:
- phase-local implementation detail.

What must remain loaded:
- final source diff and verification results.

Open risks:
- none.

Decision:
- feature-complete

Why:
- The implemented and tested surface satisfies every required outcome.

## Latest Feature Close
- Feature complete: StepFun provider integration delivered and verified.

## Recommended Next Command
- none; feature complete.

## Verification Ledger
- 2026-08-18 official StepFun docs + repository registry inspection -> pass (context sufficient)
- 2026-08-18 `bun run typecheck` -> pass.
- 2026-08-18 focused provider/catalog Vitest suite -> pass (6 files, 57 tests).

## Blockers
- none

## Requirements Still Satisfied
- R1
- R2
- R3

## Relock History
- v1: initial clarified/researched/verified plan.
