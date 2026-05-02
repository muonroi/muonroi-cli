---
phase: quick
plan: 260502-edr
type: execute
wave: 1
depends_on: []
files_modified:
  - src/ee/tenant.ts
  - src/hooks/index.ts
  - src/orchestrator/orchestrator.ts
  - src/ee/intercept.ts
  - src/utils/settings.ts
  - src/cloud/index.ts
  - src/billing/index.ts
autonomous: true
requirements: [PRE-P4-CLEANUP]
must_haves:
  truths:
    - "Zero hardcoded tenantId 'local' strings in production source files (tests excluded)"
    - "No PaymentSettings / PaymentChain / payment-related types or functions in codebase"
    - "src/cloud/ and src/billing/ directories exist with barrel exports"
  artifacts:
    - path: "src/ee/tenant.ts"
      provides: "Centralized tenantId getter/setter"
      exports: ["getTenantId", "setTenantId"]
    - path: "src/cloud/index.ts"
      provides: "Phase 4 cloud stub"
    - path: "src/billing/index.ts"
      provides: "Phase 4 billing stub"
  key_links:
    - from: "src/hooks/index.ts"
      to: "src/ee/tenant.ts"
      via: "import getTenantId"
      pattern: "getTenantId\\(\\)"
    - from: "src/orchestrator/orchestrator.ts"
      to: "src/ee/tenant.ts"
      via: "import getTenantId"
      pattern: "getTenantId\\(\\)"
    - from: "src/ee/intercept.ts"
      to: "src/ee/tenant.ts"
      via: "import getTenantId"
      pattern: "getTenantId\\(\\)"
---

<objective>
Pre-phase-4 cleanup: centralize tenantId into a single module, remove dead blockchain payment code, and create cloud/billing directory stubs for phase 4 planning.

Purpose: Clean foundation before phase 4 (cloud + billing) begins — no dead code, single source of truth for tenantId, and real directory paths for the planner to reference.
Output: 1 new module (tenant.ts), 2 stub barrels, cleaned settings.ts
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/ee/tenant.ts (will be created)
@src/hooks/index.ts
@src/orchestrator/orchestrator.ts
@src/ee/intercept.ts
@src/utils/settings.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Centralize tenantId into src/ee/tenant.ts and replace all hardcoded "local"</name>
  <files>src/ee/tenant.ts, src/hooks/index.ts, src/orchestrator/orchestrator.ts, src/ee/intercept.ts</files>
  <action>
1. Create `src/ee/tenant.ts`:
```typescript
/**
 * Centralized tenant ID — single source of truth.
 * Default "local" for BYOK/self-hosted mode.
 * Phase 4 cloud mode will call setTenantId() after auth.
 */
let _tenantId = "local";

export function getTenantId(): string {
  return _tenantId;
}

export function setTenantId(id: string): void {
  _tenantId = id;
}
```

2. In `src/hooks/index.ts`, add `import { getTenantId } from "../ee/tenant.js";` at top.
   Replace ALL 4 occurrences of `tenantId: "local"` with `tenantId: getTenantId()`:
   - Line ~126 (JudgeContext in PostToolUse)
   - Line ~138 (posttool call in PostToolUse)
   - Line ~157 (JudgeContext in PostToolUseFailure)
   - Line ~169 (posttool call in PostToolUseFailure)

3. In `src/orchestrator/orchestrator.ts`, add `import { getTenantId } from "../ee/tenant.js";` at top.
   Replace line ~1738: `tenantId: "local"` with `tenantId: getTenantId()`.

4. In `src/ee/intercept.ts`, add `import { getTenantId } from "./tenant.js";` at top.
   Replace line ~111: `const tenantId = req.tenantId ?? "local"` with `const tenantId = req.tenantId ?? getTenantId()`.

Do NOT touch test files (*.test.ts) — they can keep hardcoded "local" as fixtures.
  </action>
  <verify>
    <automated>cd /d/Personal/Core/muonroi-cli && grep -rn 'tenantId.*"local"' src/ --include='*.ts' | grep -v test | grep -v node_modules | grep -v tenant.ts</automated>
  </verify>
  <done>Zero hardcoded "local" tenantId in production .ts files (excluding tenant.ts default and test files). All 4 source locations use getTenantId().</done>
</task>

<task type="auto">
  <name>Task 2: Remove dead PaymentSettings blockchain code from settings.ts</name>
  <files>src/utils/settings.ts</files>
  <action>
Remove ALL payment-related code from `src/utils/settings.ts`:

1. Delete type alias (line ~19): `export type PaymentChain = "base" | "base-sepolia";`
2. Delete interface (lines ~21-23): `export interface PaymentApprovalSettings { ... }`
3. Delete interface (lines ~25-29): `export interface PaymentSettings { ... }`
4. Delete constant (lines ~31-37): `const DEFAULT_PAYMENT_SETTINGS: Required<PaymentSettings> = { ... };`
5. Delete field from UserSettings interface (line ~175): `payments?: PaymentSettings;`
6. Delete merge logic in saveUserSettings (lines ~273-284): the entire `...(partial.payments !== undefined ? { payments: ... } : {})` block
7. Delete function (lines ~650-662): `export function loadPaymentSettings(): Required<PaymentSettings> { ... }`
8. Delete function (lines ~664-666): `export function savePaymentSettings(partial: PaymentSettings): void { ... }`

Verify no other file imports these symbols (already confirmed — only settings.ts references them).
  </action>
  <verify>
    <automated>cd /d/Personal/Core/muonroi-cli && grep -rn 'PaymentSettings\|PaymentChain\|PaymentApproval\|loadPaymentSettings\|savePaymentSettings\|DEFAULT_PAYMENT' src/ --include='*.ts' | grep -v node_modules</automated>
  </verify>
  <done>Zero payment-related types, interfaces, constants, or functions in the codebase. settings.ts compiles cleanly.</done>
</task>

<task type="auto">
  <name>Task 3: Create src/cloud/ and src/billing/ directory stubs</name>
  <files>src/cloud/index.ts, src/billing/index.ts</files>
  <action>
1. Create `src/cloud/index.ts`:
```typescript
/**
 * Phase 4: Cloud EE client, auth, migration, pricing.
 * This barrel will export cloud-mode functionality once implemented.
 */
export {};
```

2. Create `src/billing/index.ts`:
```typescript
/**
 * Phase 4: LemonSqueezy subscription, webhook handler, tier management.
 * This barrel will export billing functionality once implemented.
 */
export {};
```

These are placeholder stubs — phase 4 planner will reference these real directory paths.
  </action>
  <verify>
    <automated>cd /d/Personal/Core/muonroi-cli && test -f src/cloud/index.ts && test -f src/billing/index.ts && echo "PASS: both stubs exist"</automated>
  </verify>
  <done>src/cloud/index.ts and src/billing/index.ts exist with descriptive comments and empty barrel exports.</done>
</task>

</tasks>

<verification>
1. `grep -rn 'tenantId.*"local"' src/ --include='*.ts' | grep -v test | grep -v tenant.ts` returns empty
2. `grep -rn 'PaymentSettings\|PaymentChain' src/ --include='*.ts'` returns empty
3. `ls src/cloud/index.ts src/billing/index.ts` both exist
4. `npx tsc --noEmit` compiles without errors
</verification>

<success_criteria>
- tenantId centralized: single module, all production code uses getTenantId()
- Payment dead code removed: zero references in codebase
- Phase 4 directory stubs exist and are importable
- TypeScript compiles clean
</success_criteria>

<output>
After completion, create `.planning/quick/260502-edr-pre-phase-4-cleanup-centralize-tenantid-/260502-edr-SUMMARY.md`
</output>
