# Phase 5: EE Bridge Foundation - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

CLI can load experience-core.js in-process via typed bridge with graceful degradation and zero config duplication. This is pure infrastructure plumbing — no user-facing behavior changes.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key constraints from research:
- createRequire pattern for CJS interop (ARCHITECTURE.md validated)
- Lazy singleton pattern for graceful degradation (BRIDGE-02)
- Config resolved from ~/.experience/config.json only (BRIDGE-03)
- EXPERIENCE_* env vars set before import, never write config from CLI
- AbortSignal.timeout on all brain calls (Ollama cold-start protection)
- Default import + destructure only, never named ESM imports for CJS module

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/ee/client.ts` — existing HTTP EE client with circuit breaker (KEPT for sidecar hooks)
- `src/ee/types.ts` — typed contracts for InterceptRequest, PostToolPayload, EEClient interface
- `src/ee/intercept.ts` — pre-tool hook dispatch (stays HTTP-based)
- `src/ee/index.ts` — barrel exports for ee module

### Established Patterns
- Lazy singleton: `getDefaultEEClient()` / `setDefaultEEClient()` pattern in intercept.ts
- Fire-and-forget for posttool/feedback/touch calls
- Circuit breaker for HTTP fallback path
- tenantId="local" for single-tenant local mode

### Integration Points
- `src/pil/layer1-intent.ts` — will consume bridge.classifyViaBrain (Phase 6)
- `src/pil/layer3-ee-injection.ts` — will consume bridge.searchCollection (Phase 6)
- `src/router/warm.ts` — will consume bridge.routeModel (Phase 6)
- Bridge must coexist with HTTP client — both paths active during migration

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description, success criteria, and research/ARCHITECTURE.md for integration strategy.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase stayed within scope.

</deferred>
