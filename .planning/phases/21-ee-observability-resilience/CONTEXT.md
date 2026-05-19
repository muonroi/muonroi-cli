# Phase 21: EE Observability & Resilience

**Milestone:** v1.8 Hardening & Resilience
**Status:** Not planned yet
**Created:** 2026-05-19

## Origin

Code review of 2026-05-19 found that Experience Engine call sites in `src/ee/bridge.ts`, `src/pil/layer3-ee-injection.ts`, and `src/orchestrator/orchestrator.ts` swallow timeouts and errors via `.catch(() => {})`. Users see slow prompts but never learn why; operators cannot tell from logs whether BB retrieval is degrading the product.

## Goal

Turn every silent EE failure into a visible, structured signal — without breaking the existing graceful-degrade contract documented in `docs/ee/EE-DOWN-BEHAVIOR.md`.

1. Each EE call site (BB retrieval, PIL retrieve, EE judge, EE-feedback) emits `agentRuntime.emitEvent('ee-timeout', { source, elapsedMs, budgetMs })` AND `'ee-error'` on non-timeout failures.
2. The TUI shows a passive non-modal toast `running without BB context` when BB retrieval times out (debounced per session — once per session is enough).
3. `userSettings.eeBBContext` is reachable from `/config` (currently only flippable by editing config JSON).
4. `PIL_SEARCH_TIMEOUT_MS` (currently 1500) is re-measured against SiliconFlow thin-client p95 latency; choose a value backed by data, not a guess.
5. Every `.catch(() => {})` on an EE path is replaced with `.catch((e) => logger.warn('ee.<source>.failed', { e }))` (or equivalent) so the next operator audit has a trail.

## Success Criteria

1. Harness E2E spec `tests/harness/ee-timeout.spec.ts` (new) injects a slow EE stub and asserts:
   - `ee-timeout` event fires within budgetMs + 200ms.
   - Toast with text matching `/without BB context/` appears.
   - The original prompt still completes successfully (degrade contract intact).
2. `/config` screen lists `eeBBContext` toggle and `PIL_SEARCH_TIMEOUT_MS` value.
3. Grep audit: zero remaining `.catch(() => {})` on EE call paths after this phase (allow-list documented in plan if any are deliberate).
4. New tuning doc `docs/ee/PIL-TIMEOUT-CALIBRATION.md` shows the measurement methodology and chosen value.

## Out of Scope

- Replacing the EE transport itself or changing the protocol.
- Adding a retry layer beyond the existing retry-once in `bb-retrieval.ts`.
- Building a full observability dashboard (logging is enough for this phase).

## Open Questions

- Should the toast be dismissable, or always passive (auto-fade)?
- One toast per session or one toast per EE source (BB / PIL / judge)?
- Is there a single `agentRuntime` event sink, or do BB and PIL emit independently?
