---
phase: quick-260502-dcx
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/router/warm.ts
  - src/router/warm.test.ts
autonomous: true
requirements: [UNIFY-WARM-CASCADE]
must_haves:
  truths:
    - "warm tier tries bridge.routeModel() in-process first before HTTP"
    - "warm tier falls back to HTTP when bridge returns null"
    - "existing HTTP-only behavior preserved when EE core not loaded"
  artifacts:
    - path: "src/router/warm.ts"
      provides: "Cascade: bridge in-process -> HTTP fallback"
      contains: "routeModel"
    - path: "src/router/warm.test.ts"
      provides: "Tests for bridge-first cascade and HTTP fallback"
  key_links:
    - from: "src/router/warm.ts"
      to: "src/ee/bridge.ts"
      via: "import routeModel"
      pattern: "import.*routeModel.*bridge"
---

<objective>
Add in-process bridge cascade to warm router tier.

Purpose: Eliminate HTTP round-trip for model routing when EE core is loaded in-process, reducing warm-path latency from ~250ms network to ~5ms in-process. HTTP fallback preserved for when core is absent.

Output: Modified warm.ts with bridge-first cascade, updated tests covering both paths.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/router/warm.ts
@src/ee/bridge.ts
@src/router/types.ts
@src/router/warm.test.ts

<interfaces>
<!-- Key types the executor needs -->

From src/ee/bridge.ts:
```typescript
export interface EERouteResult {
  tier: string;
  model: string;
  reasoningEffort?: string;
  confidence: number;
  source: string;
  reason: string;
  taskHash: string | null;
}
export async function routeModel(task: string, context: Record<string, unknown>, runtime: string): Promise<EERouteResult | null>;
```

From src/router/types.ts:
```typescript
export interface RouteDecision {
  tier: Tier;
  model: string;
  provider: string;
  reason: string;
  confidence?: number;
  cap_overridden?: boolean;
  taskHash?: string;
  source?: string;
  reasoningEffort?: "low" | "medium" | "high";
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add bridge cascade to warm.ts with tests</name>
  <files>src/router/warm.ts, src/router/warm.test.ts</files>
  <behavior>
    - Test: when bridge.routeModel returns a result, callWarmRoute returns mapped RouteDecision without calling HTTP
    - Test: when bridge.routeModel returns null, callWarmRoute falls through to existing HTTP path and returns HTTP result
    - Test: existing tests still pass (HTTP-only path remains functional)
  </behavior>
  <action>
    **warm.ts changes (per locked decision — cascade bridge in-process first, HTTP fallback):**

    1. Add import: `import { routeModel as bridgeRouteModel } from "../ee/bridge.js";`

    2. At the TOP of `callWarmRoute`, before the existing HTTP call:
       ```
       const bridgeResult = await bridgeRouteModel(prompt, opts.context ?? {}, "muonroi-cli");
       if (bridgeResult) {
         return {
           tier: bridgeResult.tier === "fast" ? "hot" : bridgeResult.tier === "premium" ? "cold" : "warm",
           model: bridgeResult.model,
           provider: "",
           reason: `warm:bridge:${bridgeResult.reason}`,
           confidence: bridgeResult.confidence,
           taskHash: bridgeResult.taskHash ?? undefined,
           source: bridgeResult.source,
           reasoningEffort: bridgeResult.reasoningEffort as RouteDecision["reasoningEffort"],
         };
       }
       ```

    3. Existing HTTP call remains unchanged as the fallback path.

    4. Note: reason prefix is `warm:bridge:` for bridge results vs `warm:` for HTTP results — allows log differentiation.

    **warm.test.ts changes:**

    1. Add a new describe block "bridge cascade" with vi.mock for `../ee/bridge.js`
    2. Test: mock bridgeRouteModel to return an EERouteResult — verify callWarmRoute returns mapped RouteDecision with `warm:bridge:` reason prefix, and HTTP is NOT called
    3. Test: mock bridgeRouteModel to return null — verify callWarmRoute falls through to HTTP stub and returns result with `warm:` reason prefix
    4. Keep existing test suite untouched (it tests HTTP-only path which is still valid)
  </action>
  <verify>
    <automated>cd D:/Personal/Core/muonroi-cli && npx vitest run src/router/warm.test.ts</automated>
  </verify>
  <done>
    - warm.ts imports bridge.routeModel and tries it before HTTP
    - Bridge result mapped to RouteDecision with `warm:bridge:` reason prefix
    - Null bridge result falls through to existing HTTP call
    - All tests pass: bridge-first path, HTTP fallback path, existing tests
  </done>
</task>

</tasks>

<verification>
- `npx vitest run src/router/warm.test.ts` — all tests pass
- `npx tsc --noEmit` — no type errors
- grep warm.ts for both `bridgeRouteModel` import and existing `getDefaultEEClient().routeModel` call
</verification>

<success_criteria>
- callWarmRoute tries in-process bridge first, HTTP second
- Bridge returning null triggers HTTP fallback (no behavior change from user perspective)
- Reason field distinguishes bridge vs HTTP source
- All existing and new tests pass
- No type errors
</success_criteria>

<output>
After completion, create `.planning/quick/260502-dcx-unify-cli-3-tier-router-with-ee-route-ta/260502-dcx-SUMMARY.md`
</output>
