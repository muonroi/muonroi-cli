# Quick Task 260502-dcx: Unify CLI 3-tier router with EE route-task/route-model - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning

<domain>
## Task Boundary

Unify CLI 3-tier router (decide.ts) with EE bridge in-process routing (bridge.ts). Currently decide.ts warm/cold paths call EE via HTTP while bridge.ts offers faster in-process routeModel() that's unused by the router.

</domain>

<decisions>
## Implementation Decisions

### Router Unification Strategy
- **Cascade: bridge in-process first, HTTP fallback**
- decide.ts warm tier tries bridge.routeModel() in-process first (faster, no network hop)
- Falls back to HTTP client (warm.ts) only if bridge returns null (core not loaded)
- Cold tier remains HTTP-only (already a fallback path, no need to duplicate)

### Cross-Signal Between Model & Workflow Routing
- **No cross-signal** — keep model routing (decide.ts) and workflow routing (PIL L4 routeTask) independent
- They solve different problems: "which model" vs "which workflow phase"
- No coupling between the two paths

### Claude's Discretion
- Cold path (cold.ts) stays HTTP-only — it's already the last resort before fallback
- bridge.routeModel() timeout handling — use same 250ms budget as current warm.ts

</decisions>

<specifics>
## Specific Ideas

- warm.ts should try bridge.routeModel() first, then existing HTTP call
- bridge.routeModel() already returns EERouteResult with tier/model/confidence
- Need to map EERouteResult to RouteDecision (same as warm.ts currently does for HTTP response)
- Bridge returns null when core not loaded — natural cascade trigger

</specifics>
