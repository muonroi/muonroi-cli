# Sprint 1: Council Workflow Migration Plan

> Generated from council run **mrepzjjz8ffb** | 2026-07-10

---

## 1. Blob Inventory & Native Mapping

| # | .cjs Blob | Exports Used | Native Module | Consumers | Load Pattern |
|---|---|---|---|---|---|
| 1 | loop-host-contract.cjs | LOOP_HOST_CONTRACT (LoopHostContractEntry[]) | src/gsd/native/loop-host-contract.ts | gsd-runtime.ts:30, loop-host.ts:12, host-adapter.ts:1 | loadGsdLib() |
| 2 | state-document.cjs | stateExtractField, stateReplaceField | src/gsd/native/state-document.ts | gsd-runtime.ts:44, workflow-engine.ts:152,171 | loadGsdLib() |
| 3 | loop-resolver.cjs | resolveLoopHooks({point,registry,config}) | src/gsd/native/orchestrator.ts | gsd-dispatch.ts:232 (resolveLoopHooksInProcess) | loadGsdLib() |
| 4 | config-loader.cjs | loadConfig(cwd) | src/gsd/native/config-loader.ts | gsd-dispatch.ts:239 | loadGsdLib() |
| 5 | capability-registry.cjs | Whole module as registry object | src/gsd/native/registry.ts | gsd-dispatch.ts:240 | loadGsdLib() |
| 6* | @opengsd/gsd-core/package.json | require.resolve() for bin path | **KEPT** — not migrated in sprint 1 | gsd-dispatch.ts:20, gsd-runtime.ts:9 | require.resolve() |

*#6 stays in sprint 1 — used only for `gsd-tools.cjs` subprocess spawning (execFileSync), not require(). The 9 dispatch functions using `runGsdTools()` are state-management operations, not council-workflow. Removing the npm dep in sprint 1 would break the subprocess path.

---

## 2. Architecture — Before vs After

**Before** (dynamic require coupling):

```
gsd-runtime.ts
  gsdCoreLibDir()     -> require.resolve("@opengsd/gsd-core/package.json")
  loadGsdLib(name)    -> require(<dir>/<name>.cjs)
    loop-host-contract.cjs -> LOOP_HOST_CONTRACT
    state-document.cjs     -> stateExtractField / stateReplaceField

gsd-dispatch.ts
  resolveGsdToolsBin() -> require.resolve("@opengsd/gsd-core/package.json") [KEPT]
  runGsdTools()        -> execFileSync(gsd-tools.cjs) [KEPT]
  resolveLoopHooksInProcess()
    loadGsdLib("loop-resolver")       -> loop-resolver.cjs
    loadGsdLib("config-loader")       -> config-loader.cjs
    loadGsdLib("capability-registry") -> capability-registry.cjs
```

**After** (native TypeScript):

```
src/gsd/native/
  types.ts               -> Persona, Council, Debate, DebateTurn, DebateFault, ModelBinding
  registry.ts            -> createFrozenRegistry(), resolveModel()
  orchestrator.ts        -> resolveLoopHooks(point, registry, config)
  loop-host-contract.ts  -> LOOP_HOST_CONTRACT (static data)
  state-document.ts      -> stateExtractField, stateReplaceField (pure string fns)
  config-loader.ts       -> loadConfig(cwd) (reads .planning/config.json)

gsd-runtime.ts -> SIMPLIFIED: direct imports from native/, drops all require() usage
gsd-dispatch.ts -> REWIRED: resolveLoopHooksInProcess uses native orchestrator + config-loader + registry;
                   runGsdTools() subprocess path UNCHANGED
```

---

## 3. Council-Approved Architecture Rules

1. **Deep freeze** the registry — `Object.freeze()` on root AND all nested objects. Not Proxy, not shallow const.
2. **Contract test, not snapshot test** — assertion fails only if a persona is *used* without mapping, not if added to an enum without usage.
3. **debate:error as typed event in registry fixture** — added as fixture row, not bare stub. Makes the error channel assertable. Handler is UNWIRED (no-op) in sprint 1.
4. **Parallel-debate**: `Promise.all` per-turn await with per-council queue, not interleaved microsteps. `DebateFault` error type needed.
5. **Four native behaviors** for equivalence: (1) async turn sequencing, (2) per-turn timeout, (3) debate:error emission on drop, (4) fallback logic. Sprint 1: stub #3 with typed event. Sprint 2: drop recovery.
6. **DebateFault** error type: codes = `timeout | drop | parse | provider`.

---

## 4. Entity Types

| Entity | Key Fields | Description |
|---|---|---|
| Persona | id, label, role (ModelRole), description | Council participant type |
| Council | id, personas[], topic, debates[], config | Group debating a topic |
| Debate | id, topic, turns[], status, startedAt, endedAt | Complete debate with rounds |
| DebateTurn | personaId, role, content, round, tokenCount?, error? | One persona's response in one round |
| ModelBinding | personaId, modelId, providerId, fallbackChain[] | Persona-to-model assignment |
| DebateFault (Error) | code (timeout|drop|parse|provider), debateId?, personaId? | Debate lifecycle error |
| LoopHostContractEntry | step, points[], agentRoles[], coreArtifacts | GSD loop contract entry |
| CouncilConfig | maxRounds, perTurnTimeoutMs, execution (parallel|sequential) | Council behavior config |

---

## 5. Internal API Surface

| Function | Module | Signature | Replaces |
|---|---|---|---|
| createFrozenRegistry() | registry.ts | (personas, bindings) => Readonly<Record<string, Readonly<ModelBinding>>> | capability-registry.cjs |
| resolveModel() | registry.ts | (registry, personaId) => ModelBinding | Inline resolution |
| resolveLoopHooks() | orchestrator.ts | ({point, registry, config}) => {point, activeHooks[]} | loop-resolver.cjs |
| loadConfig() | config-loader.ts | (cwd) => Record<string, unknown> | config-loader.cjs |
| stateExtractField() | state-document.ts | (content, fieldName) => string\|null | state-document.cjs |
| stateReplaceField() | state-document.ts | (content, fieldName, newValue) => string | state-document.cjs |
| LOOP_HOST_CONTRACT | loop-host-contract.ts | LoopHostContractEntry[] (frozen static) | loop-host-contract.cjs |

---

## 6. Acceptance Criteria

### Backlog Item 1: Inventory + Mapping

- **Inventory**: grep for `loadGsdLib` across src/gsd/ finds exactly 5 unique module names (loop-host-contract, state-document, loop-resolver, config-loader, capability-registry). Each has a native counterpart in src/gsd/native/.
- **gsd-tools separation**: The `execFileSync` subprocess path is documented as NOT migrated in sprint 1. The npm dep entry stays until sprint 2.

### Backlog Item 2: Native Council-Workflow Modules

- **Deep freeze**: `Object.isFrozen()` returns true for the registry root and all nested objects. Mutation silently fails.
- **debate:error fixture**: Querying the registry for "debate:error" returns a typed entry (event, personaId, code, message). Handler is UNWIRED.
- **Persona resolution**: Every persona in the registry resolves to exactly one modelId via `resolveModel()`. Missing persona throws `DebateFault` with code "provider".
- **Contract test semantics**: Adding a persona to an enum WITHOUT usage does NOT fail the contract test. Only calling `resolveModel()` for an unmapped persona fails.
- **State document purity**: `stateExtractField()` / `stateReplaceField()` are pure string functions — no I/O, no mutation of inputs.
- **Loop host contract**: `LOOP_HOST_CONTRACT` is a frozen static array imported from a module, not loaded via dynamic require.

### Backlog Item 3: Rewire Dispatch

- **In-process path**: `resolveLoopHooksInProcess()` uses native orchestrator, config-loader, registry — zero calls to `loadGsdLib()`.
- **Subprocess path**: `runGsdTools()` + all 9 dispatch functions STILL work via `execFileSync(gsd-tools.cjs)` and `require.resolve("@opengsd/gsd-core/package.json")`.
- **Test suite**: `bun test src/gsd/` — all 26 test files pass. `bunx tsc --noEmit` — zero type errors.

### Dependency removal (attempted last)

- Removing `@opengsd/gsd-core` from package.json is ATTEMPTED as the final step.
- If subprocess path breaks → REVERT the removal. Document the remaining dependency for sprint 2.

---

## 7. Action Items (Ordered)

### Phase A: Foundation

| # | Action | Predecessor | Est. |
|---|---|---|---|
| A1 | Create src/gsd/native/ with index.ts | — | 5m |
| A2 | Write native/types.ts — all entity types + DebateFault | — | 15m |
| A3 | Write native/loop-host-contract.ts — static LOOP_HOST_CONTRACT | — | 10m |
| A4 | Write native/state-document.ts — stateExtractField, stateReplaceField | — | 10m |
| A5 | Write native/config-loader.ts — loadConfig(cwd) reads .planning/config.json | — | 10m |

### Phase B: Registry + Test (test-first — freeze before dispatch touched)

| # | Action | Predecessor | Est. |
|---|---|---|---|
| B1 | Write native/registry.test.ts — deep-freeze + debate:error + contract assertions | A2 | 20m |
| B2 | Write native/registry.ts — createFrozenRegistry(), resolveModel() | A2, B1 (TDD) | 20m |
| B3 | Green: `bun test src/gsd/native/__tests__/registry.test.ts` | B2 | 5m |

### Phase C: Orchestrator

| # | Action | Predecessor | Est. |
|---|---|---|---|
| C1 | Write native/orchestrator.ts — resolveLoopHooks() | A2, B2 | 20m |
| C2 | Write native/orchestrator.test.ts | C1 | 15m |

### Phase D: Rewire Runtime

| # | Action | Predecessor | Est. |
|---|---|---|---|
| D1 | Rewrite gsd-runtime.ts — replace loadGsdLib() calls with direct imports, keep gsdCoreLibDir() only for bin path | A3, A4 | 15m |
| D2 | Verify existing gsd-dispatch.test.ts still passes (subprocess-based tests unaffected) | D1 | 5m |

### Phase E: Rewire Dispatch (resolveLoopHooksInProcess)

| # | Action | Predecessor | Est. |
|---|---|---|---|
| E1 | Rewrite resolveLoopHooksInProcess() — native imports instead of loadGsdLib() | C1, D1 | 15m |
| E2 | Verify gsd-dispatch.test.ts + loop-host.test.ts + host-adapter.test.ts | E1 | 5m |

### Phase F: Full Verification + Dependency

| # | Action | Predecessor | Est. |
|---|---|---|---|
| F1 | `bun test src/gsd/` — all 26 test files | E2 | 10m |
| F2 | `bunx tsc --noEmit` — zero type errors | F1 | 5m |
| F3 | Attempt npm dep removal. If subprocess breaks: REVERT, document remaining dep for sprint 2 | F1 | 5m |

**Total: ~3 hours**

---

## 8. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | gsd-tools.cjs subprocess blocks npm dep removal | HIGH | Keep dep entry in sprint 1. The require()-path IS eliminated. Subprocess binary resolution depends on the npm package. Document as sprint 2 work. |
| R2 | Hidden error handling in opaque .cjs blobs | MEDIUM | The .cjs blobs may have unique error paths. Each native module gets explicit error handling with logging. The debate:error fixture catches divergence. |
| R3 | Parallel-debate timing differences | MEDIUM | gsd-core may use a custom scheduler. Our `Promise.all` design differs. Use deterministic mock timers in tests. |
| R4 | Registry env/config read at require() time | LOW | Deep-frozen registry eliminates runtime reads. Verify with an env-read test. |
| R5 | Silent error swallowing without debate:error | MEDIUM | debate:error as fixture row + unwired handler makes the channel assertable. Covered by the contract test. |
| R6 | Broken index.ts exports | LOW | All exports from gsd-runtime.ts (loadLoopHostContract, allLoopHostPoints) and gsd-dispatch.ts must be preserved. Index test coverage catches regressions. |

---

## 9. Key Tradeoffs (from council debate)

| Decision | Chosen Path | Alternative Rejected | Rationale |
|---|---|---|---|
| Registry freeze | Deep freeze (Object.freeze) | Proxy or shallow const | Proxy adds runtime cost, shallow const misses nested. Deep freeze is explicit. |
| Test type | Contract test | Snapshot test | Contract fails on USE without mapping, not on enum addition. Snapshot would make every enum change a test failure. |
| debate:error placement | Registry fixture row | Bare stub | Fixture row makes the error channel assertable by the same test that validates routing. |
| Sprint 1 scope | require() path only | Full dep removal | gsd-tools.cjs subprocess (9 functions) is state management, not council-workflow. Splitting keeps sprint 1 focused on the 5 require() blobs. |
| Dependency removal | Attempted last, revert if broken | Force removal | Removing the dep before the subprocess CLI is natively reimplemented breaks 9 dispatch functions. Pragmatic: keep dep entry, document for sprint 2. |

---

## 10. Consensus Notes (Dissenting Opinions)

- Test-First Registry Specialist wanted frozen **snapshot** before dispatch touched (serializes sprint). Developer Experience Advocate wanted **contract test** + stub boundary (allows parallel work). **Resolution**: Contract test + stub boundary wins.
- Test-First Registry Specialist's strengthening of `debate:error` (add as fixture row, not bare stub) was adopted.
- Migration Architect proposed `debate:error` as bare stub; Test-First Registry Specialist's fixture-row approach won.
- Skeptic had no recorded position.
- Cost-Controller flagged that the registry snapshot must freeze BEFORE dispatch is touched.
- Architect flagged four native behaviors needed for equivalence; sprint 1 takes three and stubs the fourth.

---

## 11. Next Actions

1. **Read existing source files**: gsd-runtime.ts (47 lines), gsd-dispatch.ts (267 lines), all 26 test files in src/gsd/__tests__ — already done.
2. **Start Phase A**: Create src/gsd/native/ with types.ts, loop-host-contract.ts, state-document.ts, config-loader.ts.
3. **Phase B (test-first)**: Write registry contract test, then implement registry.ts.
4. **Phase C-E**: Orchestrator, rewire runtime, rewire dispatch.
5. **Phase F**: Run full test suite, attempt npm dep removal.
