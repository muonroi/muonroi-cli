# Harness Extract + React/Angular Adapters Implementation Plan (v1.1, post 4-agent review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Revisions v1.1 — Cross-review fixes

This revision incorporates findings from 4 parallel sub-agent reviews (architecture, feasibility, risk, sequencing). All **HIGH** severity issues and critical **MEDIUM** issues are now sequenced into the plan body. Highlights:

- **HIGH-1 → Task 1.1c**: Core `package.json` ships a `"browser"` export condition that excludes Node-only modules (`mcp-server.ts`, `sidechannel.ts`, anything touching `node:fs`/`node:os`/`node:path`). Prevents adapter-side bundlers from pulling Node built-ins into the browser bundle.
- **HIGH-2 → Task 0.4**: WS envelope gains an explicit `dir: "frame" | "cmd"` discriminator since a single socket carries both server→client frames and client→server commands. Document in `docs/agent-harness/TRANSPORTS.md`.
- **HIGH-3 → Task 3.5**: Production tree-shake switches from a `globalThis.__MUONROI_HARNESS__` runtime flag (NOT statically eliminable) to a compile-time `define` constant (`esbuild --define:__MUONROI_HARNESS__=false` / `vite define`). Both branches of the dead-code guard become statically replaceable.
- **HIGH-4 → Task 4.3 & 4.4**: Angular directive DI must use `@Optional() @SkipSelf() @Host()` decorators to walk the **DOM/element-injector** chain, not the default component-injector chain. Without this, nested directives on non-component host elements resolve the wrong parent.
- **HIGH-5 → Task 1.1 atomic move**: Codemod (`scripts/codemod-harness-imports.ts`) is bundled into the **same commit** as the file move; scope explicitly includes `src/**`, `tests/**`, and `scripts/**`. Prevents the "tests broken for 3 tasks" interval the v1.0 plan would have created.
- **HIGH-6 → Task 5.1**: CB-3 refactor (`throw` → `yield halt`) is now scoped to update **all 3 `runSprint()` call sites** in `src/product-loop/index.ts` (~186, ~388, ~593). Caller #3 currently has no `try/catch` — Task 5.1 adds explicit halt-chunk handling. New `sprint-runner.test.ts` assertions verify yielded halt chunks are forwarded, not swallowed.
- **MEDIUM-8 → Task 1.6 (new)**: `createWebSocketTransport` lives in core from Phase 1 (browser-native `WebSocket` only, no `ws` npm package in source). React + Angular adapters import from core. Removes the entanglement that the v1.0 plan introduced at Phase 4.5.
- **MEDIUM-10 → Task 3.2a & 4.6a**: React Suspense replay + StrictMode double-mount tests added explicitly. Angular SSR guard (`isPlatformBrowser`) wraps `requestAnimationFrame` / `WebSocket` instantiation in the snapshot service.
- **Effort calibration**: Phase 0 raised from ½d → 1d (two framework spikes can't share half a day). Phase 3 raised from 1.5d → 2.5d. Phase 4 raised from 2d → 2.5d. Phase 3 ∥ Phase 4 are now declared parallelizable after Phase 1 — saves ~2-2.5 wall-clock days when run by two subagents concurrently.
- **AC #8 adjusted**: bundle size target `< 2KB gzipped` applies to React only (verified realistic ~800-1200 bytes); Angular target relaxed to `< 8KB gzipped exclusive of Angular framework runtime overhead` due to `ng-package` decorator metadata + `ɵfac`/`ɵdir` codegen that cannot be tree-shaken below ~4KB.

## Motivation

The agent-harness in `src/agent-harness/` is the **signature differentiator** of `muonroi-cli`: it lets agents drive a UI through structured JSON (semantic tree) instead of Playwright DOM/OCR. Token cost is ~1/10 of Playwright; selectors are deterministic; no screenshots.

Today the harness is **OpenTUI-only**: `reconciler-hook.ts` hooks into OpenTUI's `addPostProcessFn`. To support `/ideal`-scaffolded FE apps (React, Angular, …), the harness must be:

1. **Extracted from `muonroi-cli`** into a workspace package, with stable public exports.
2. **Split into core + per-runtime adapters** so new runtimes (React-DOM, Angular) plug in without touching core.
3. **Wired into `/ideal` scaffold**: when CB-3 halts on `no_recipe`, offer to init a new project where:
   - BE is scaffolded from `muonroi-building-block`
   - FE is scaffolded with `<SemanticProvider>` at the root + lint rule enforcing `<Semantic>` on user-visible components.

## Architecture target

```
packages/
├── agent-harness-core/          # protocol, selector, predicate, driver, sidechannel, mock-llm, MCP server, lint helpers, WS transport
│   ├── src/
│   │   ├── protocol.ts          # UINode, Role, LiveFrame, LiveEvent, PROTOCOL_VERSION
│   │   ├── selector.ts          # parseSelector, matchSelector
│   │   ├── predicate.ts         # Zod predicate evaluator
│   │   ├── driver.ts            # createDriver()
│   │   ├── registry.ts          # createSemanticRegistry (DOM/reconciler-agnostic)
│   │   ├── mock-llm.ts          # fixture provider
│   │   ├── transports/
│   │   │   ├── ws.ts            # createWebSocketTransport (browser-native WebSocket only)
│   │   │   └── sidechannel.ts   # ⚠ Node-only: fd 3/4 + named pipe (excluded from "browser" condition)
│   │   ├── mcp-server.ts        # ⚠ Node-only: 16 stdio MCP tools (excluded from "browser" condition)
│   │   └── index.ts             # main export
│   ├── package.json             # name: "@muonroi/agent-harness-core"
│   │                            # exports: { ".": { "browser": "./dist/browser.js", "node": "./dist/node.js", "default": "./dist/node.js" } }
│   └── tsconfig.browser.json    # excludes Node-only files; produces dist/browser.js
│
├── agent-harness-opentui/       # adapter for OpenTUI (current muonroi-cli TUI)
│   └── src/
│       ├── reconciler-hook.ts   # addPostProcessFn hook (moved from src/agent-harness/)
│       ├── semantic.tsx         # <Semantic>, <SemanticProvider> using OpenTUI React renderer
│       ├── agent-mode.ts        # runtime init for --agent-mode
│       └── index.ts
│
├── agent-harness-react/         # NEW: React-DOM adapter (web apps)
│   └── src/
│       ├── semantic.tsx         # <Semantic>, <SemanticProvider> using react-dom
│       ├── snapshot.ts          # registry → LiveFrame, RAF-debounced flush via WS transport
│       └── index.ts             # peer-deps: react>=18, react-dom>=18
│
└── agent-harness-angular/       # NEW: Angular adapter
    └── src/
        ├── semantic.directive.ts    # [muonroiSemantic] directive
        ├── semantic-provider.ts     # root injectable holding SemanticRegistry
        ├── parent-id.token.ts       # SEMANTIC_PARENT_ID injection token (element-injector scope)
        ├── snapshot.service.ts      # ChangeDetectorRef-driven snapshot, isPlatformBrowser guarded
        └── public-api.ts
```

**Key design decisions:**

1. **Core is runtime-agnostic AND browser-conditional.** `SemanticRegistry`, `driver`, `selector`, `predicate`, `protocol`, `mock-llm`, `transports/ws.ts` are isomorphic. `mcp-server.ts` and `transports/sidechannel.ts` are Node-only and excluded from the `"browser"` export condition.
2. **Adapter responsibility:** wire framework lifecycle (component mount/unmount) → `registry.register()/unregister()`; flush registry → `LiveFrame` on a tick via injected transport.
3. **Transport is pluggable.** OpenTUI uses fd 3/4 / named pipe (process spawn). Web FE uses **WebSocket** (browser cannot expose fds). Both implement `Transport { send, onMessage, close }`. MCP server in core accepts either.
4. **WS envelope** carries both directions over a single socket; **`dir: "frame" | "cmd"`** discriminator added at top level. Document in `TRANSPORTS.md`.
5. **Backwards compat:** `muonroi-cli` keeps importing from `src/agent-harness/*` via a thin shim that re-exports from `@muonroi/agent-harness-opentui` + `@muonroi/agent-harness-core`. **Codemod in same commit as file move** ensures zero broken-test windows.
6. **Production tree-shake** uses compile-time `define` (`__MUONROI_HARNESS__: false`) not a runtime global, so esbuild/Vite eliminate the entire registry-call branch.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Workspace migration breaks 26 files / 41 imports in `muonroi-cli` | Atomic Task 1.1: file move + codemod (covering `src/**` + `tests/**` + `scripts/**`) + shim re-export in **one commit** |
| React-DOM fiber walker fragile across React versions | Use **Context + `useEffect`**, not fiber introspection — verified compatible with StrictMode double-mount and Suspense replay (Task 3.2a explicit test coverage) |
| Angular Ivy renderer changes between v14/v16/v18 | Use **directive lifecycle hooks** (`ngOnInit`/`ngOnDestroy`/`ngOnChanges`), not Ivy internals — works v14+ |
| Angular default DI walks component injector, not DOM injector | Task 4.3/4.4: use `@Optional() @SkipSelf() @Host()` decorators on `SEMANTIC_PARENT_ID` injection — walks element-injector tree, matches React's `ParentIdContext` semantics |
| WebSocket transport adds attack surface | Bind to `127.0.0.1` only, require token in URL query, reject non-localhost origins, document harness-only-in-dev. Token check enforced in `transports/ws.ts` |
| Single WS socket conflates frame + cmd traffic | `dir: "frame"\|"cmd"` discriminator field at envelope root; MCP server routes by `dir` |
| Bundle size of `@muonroi/agent-harness-react` shipped to prod | Compile-time `define` constant `__MUONROI_HARNESS__=false` allows esbuild/Vite to drop `<Semantic>` to `<>{children}</>`. Verify ≤ 2 KB gzipped via `bundle-analyzer` (Task 5.4). Angular relaxed to ≤ 8 KB gzipped due to `ng-package` overhead |
| CB-3 throw → yield breaks 3 callers in `src/product-loop/index.ts` | Task 5.1 explicitly enumerates all 3 sites and adds halt-chunk handling. Caller #3 (line ~593, no try/catch) gets an explicit `for await` discriminator check |
| Angular SSR / hydration crashes on `WebSocket` / `requestAnimationFrame` | Task 4.6a: `isPlatformBrowser(inject(PLATFORM_ID))` guard wraps both APIs. Snapshot service is no-op in SSR |

## Phases & tasks

Total: **6 phases, 28 tasks**. Each task is TDD: write failing test → implement → green → commit.

---

### Phase 0 — Spikes & prep (1 day, was ½ day in v1.0)

- [ ] **0.1 — Spike: React-DOM adapter approach.** Build a 50-line throwaway in `spikes/react-dom-harness/` proving `<Semantic>` + `useEffect` + WS transport works in a Vite-served browser. Output: `docs/agent-harness/spike-react-dom-findings.md` (≤300 words). **Acceptance:** WS client receives a `LiveFrame` matching `PROTOCOL_VERSION = "0.1.0"` when a wrapped `<button>` mounts/unmounts, and a 2nd frame is NOT emitted on identical mount (hash-dedup works).
- [ ] **0.2 — Spike: Angular adapter approach.** Throwaway Angular 17 app in `spikes/angular-harness/` proving `[muonroiSemantic]` directive + `inject(SEMANTIC_PARENT_ID, { optional: true, skipSelf: true, host: true })` resolves the correct parent across nested directives on non-component host elements. Output: `docs/agent-harness/spike-angular-findings.md`. **Acceptance:** Same as 0.1, plus `parentId` resolution verified for `<div [muonroiSemantic]><span [muonroiSemantic]>x</span></div>` (span resolves to div as parent, NOT to the component root).
- [ ] **0.3 — Decide workspace tool.** `bun workspaces` (already in `package.json`) vs `pnpm`. Default: **bun workspaces** — no new tooling. Document in `docs/agent-harness/MONOREPO.md`.
- [ ] **0.4 — Specify WS envelope with discriminator.** Document in `docs/agent-harness/TRANSPORTS.md`: messages framed as `{ dir: "frame" | "cmd", ...payload }`. `dir: "frame"` carries the existing `{ mode: "live", ... }` shape; `dir: "cmd"` carries `{ op: "press" | "type" | "focus", ... }`. PROTOCOL_VERSION stays `0.1.0` since the shape is backwards-compatible (servers ignore unknown `dir` values). **Acceptance:** Document + Zod schema for the envelope in `packages/agent-harness-core/src/transports/ws.ts`.

---

### Phase 1 — Extract core package (1.5 days, was 1 day)

- [ ] **1.1 — Atomic file move + codemod + shim** (single commit; required to avoid breaking the test suite during migration).
  - Move from `src/agent-harness/`: `protocol.ts`, `selector.ts`, `predicate.ts`, `driver.ts`, `sidechannel.ts`, `mock-llm.ts`, `idle.ts`, `spec-helpers.ts` → `packages/agent-harness-core/src/`.
  - Move `sidechannel.ts` → `packages/agent-harness-core/src/transports/sidechannel.ts`.
  - Move `src/mcp/harness-driver.ts` → `packages/agent-harness-core/src/mcp-server.ts` (Task 1.3 generalizes the spawn closure).
  - Run `scripts/codemod-harness-imports.ts` to rewrite all 41 imports across `src/**`, `tests/**`, `scripts/**` from relative deep paths to `@muonroi/agent-harness-core/*` or via the shim.
  - Create `src/agent-harness/index.ts` shim that re-exports everything from `@muonroi/agent-harness-core` and `@muonroi/agent-harness-opentui`.
  - **Test:** `bunx vitest run` — full unit + harness suite green in the same commit.
- [ ] **1.1c — `"browser"` export condition.** `packages/agent-harness-core/package.json` exports map:
  ```json
  "exports": {
    ".": {
      "browser": "./dist/browser/index.js",
      "node": "./dist/node/index.js",
      "default": "./dist/node/index.js"
    },
    "./transports/ws": { "browser": "./dist/browser/transports/ws.js", "node": "./dist/node/transports/ws.js" }
  }
  ```
  Add `tsconfig.browser.json` that excludes `mcp-server.ts`, `transports/sidechannel.ts`, and any file importing `node:fs`/`node:os`/`node:path`. **Test:** add `packages/agent-harness-core/__tests__/browser-bundle.spec.ts` that resolves the `"browser"` entry and asserts no Node built-ins appear in the bundled output (use `esbuild` + grep).
- [ ] **1.2 — Move `SemanticRegistry` to core.** Extract `createSemanticRegistry` (currently in `reconciler-hook.ts`) → `packages/agent-harness-core/src/registry.ts`. Drop the OpenTUI-specific frame-emit logic — leave registry pure (just `register/update/snapshot/clear`). **Test:** copy existing `reconciler-hook.spec.ts` tests that target `createSemanticRegistry`, drop OpenTUI ones.
- [ ] **1.3 — Generalize MCP server `tui.start`.** Replace the OpenTUI-specific spawn logic with a generic `transport.start({ command, argv, env })` injection — caller passes the spawn closure. `muonroi-cli` re-injects the OpenTUI spawn in `src/mcp/index.ts`. **Test:** existing `tests/harness/mcp-integration.spec.ts` continues passing.
- [ ] **1.4 — Add lint helpers to core.** Extract `bun run lint:semantic` script logic into `packages/agent-harness-core/src/lint.ts` exporting `findUnwrappedComponents(opts)`. Update root `package.json` `lint:semantic` script to invoke the new path. **Test:** unit test fixture with 1 wrapped + 1 unwrapped `.tsx` returns the unwrapped path.
- [ ] **1.5 — Update `vitest.harness.config.ts` + root scripts.** Verify `include: ["tests/harness/**/*.spec.ts"]` paths still resolve after codemod (they should — tests stay in place, imports rewritten). Verify root `package.json` scripts (`lint:semantic`, `test:harness`, etc.) point at the new package paths. **Test:** `bun run lint:semantic` runs without error against the migrated tree.
- [ ] **1.6 — `createWebSocketTransport` in core (moved up from v1.0 Task 4.5).** `packages/agent-harness-core/src/transports/ws.ts` implements `createWebSocketTransport({ url, token })` returning `{ send(line: string), onMessage(cb), close() }`. Uses **browser-native `WebSocket`** only (no `ws` npm package in source). Token check via URL query string. Envelope discriminator (`dir`) enforced via Zod schema from Task 0.4. **Test:** spin up a `ws` server (devDependency only, used in tests) and assert round-trip + token rejection + invalid `dir` rejection.

---

### Phase 2 — Extract OpenTUI adapter (½ day)

- [ ] **2.1 — Create `packages/agent-harness-opentui/`.** Move `src/agent-harness/reconciler-hook.ts` (the OpenTUI-specific snapshot-flush logic remaining after Task 1.2) + `src/agent-harness/semantic.tsx` + `src/agent-harness/input-bridge.tsx` + `src/agent-harness/agent-mode.ts`. Adapter depends on `@muonroi/agent-harness-core`.
- [ ] **2.2 — Adapter API surface.** Export `installOpenTUIHarness({ registry, transport })` — single entry point that wires `addPostProcessFn` to dump `registry.snapshot()` as `LiveFrame` to the given transport. **Test:** existing `reconciler-hook.spec.ts` re-pointed at the new package.
- [ ] **2.3 — Update `src/ui/app.tsx`** to import from `@muonroi/agent-harness-opentui` instead of `./agent-harness/*`. **Test:** `bunx vitest -c vitest.harness.config.ts run tests/harness/` — green on both Windows (named pipe) and POSIX (fd 3/4).
- [ ] **2.4 — Verification gate.** `bunx tsc --noEmit` in all three packages (`agent-harness-core`, `agent-harness-opentui`, `muonroi-cli`) + full `bunx vitest run`. **Phase 2 cannot be marked complete without this gate passing.**

---

### Phase 3 — React-DOM adapter (2.5 days, was 1.5 days) — PARALLELIZABLE WITH PHASE 4

- [ ] **3.1 — Create `packages/agent-harness-react/`.** Skeleton with `package.json`, `tsconfig.json`, `vitest` config. Peer-deps: `react@>=18`, `react-dom@>=18`. Build target: ESM + CJS via tsup. Compile-time `define`: `__MUONROI_HARNESS__: process.env.MUONROI_HARNESS === "true" || process.env.NODE_ENV !== "production"`.
- [ ] **3.2 — `<SemanticProvider>` + `<Semantic>` for React-DOM.** Mirror OpenTUI's `semantic.tsx` API exactly. Wrapper renders `<React.Fragment>{children}</React.Fragment>` — zero DOM nodes added. Registry calls happen in `useEffect`. **Test:** render `<SemanticProvider registry={r}><Semantic id="x" role="button">hello</Semantic></SemanticProvider>` → `r.snapshot().nodes[0].id === "x"`.
- [ ] **3.2a — StrictMode + Suspense + nested-order tests (NEW from review HIGH-4).**
  - StrictMode double-mount: assert `register → unregister → register → unregister` produces a clean registry on unmount (no leaked entries).
  - Suspense replay: `<Suspense fallback={null}><Semantic id="x" role="button"><LazyChild /></Semantic></Suspense>` — suspend → resume → assert single registration after resume.
  - Nested order: parent + child `<Semantic>` — child `useEffect` fires first, but `snapshot()` after both commit produces correct `parentId` linkage (since registry is snapshot-time, not register-time, ordered).
- [ ] **3.3 — Snapshot flush loop.** `installReactHarness({ registry, transport, fps = 30 })` schedules `registry.snapshot()` → `LiveFrame` on a `requestAnimationFrame` debounce. Deduplicate via hash. **Test:** mount → unmount cycles emit exactly 2 frames (mount + unmount), no spam.
- [ ] **3.4 — Compile-time tree-shake guard.** `<Semantic>` body wraps in `if (__MUONROI_HARNESS__) { ... registry.register(...) ... }`. When `define` sets `__MUONROI_HARNESS__: false`, esbuild eliminates the entire `if` block at build time. **Test:** add `bundle-size.spec.ts` that runs esbuild with `--define:__MUONROI_HARNESS__=false` against a sample import and asserts the output bundle does NOT contain the strings `register`, `snapshot`, or `useContext` from this package.
- [ ] **3.5 — Bundle size verification.** Wire `bundle-analyzer` (or `esbuild --analyze`) in CI. **Acceptance:** prod build of `@muonroi/agent-harness-react` ≤ 2 KB gzipped.
- [ ] **3.6 — E2E test in `tests/harness-react/`.** Spawn a tiny React app via Vite, connect WS driver from a vitest spec, assert `driver.query("id=root-button")` works after click. **Acceptance:** matches the contract of `tests/harness/composer.spec.ts` but for browser.

---

### Phase 4 — Angular adapter (2.5 days, was 2 days) — PARALLELIZABLE WITH PHASE 3

- [ ] **4.1 — Create `packages/agent-harness-angular/`.** Skeleton + `ng-packagr` config for Angular library build. Peer-deps: `@angular/core@>=16`.
- [ ] **4.2 — `SemanticRegistryService` (root injectable).** Wraps `createSemanticRegistry` from core. Provided in root via `providedIn: "root"`. **Test:** `TestBed.inject(SemanticRegistryService).snapshot().nodes.length === 0` on fresh module.
- [ ] **4.3 — `[muonroiSemantic]` directive with element-injector DI (REVISED per review HIGH-4).**
  - Inputs: `id`, `role`, `name`, `value`, `state`, `isModal`, plus boolean inputs `focus`, `selected`, `disabled`.
  - Constructor injects `@Optional() @SkipSelf() @Host() SEMANTIC_PARENT_ID` to resolve the parent directive's id via the **element injector**, not the component injector.
  - Re-provides `SEMANTIC_PARENT_ID` to children via `providers: [{ provide: SEMANTIC_PARENT_ID, useFactory: () => this.id }]` on the directive's host.
  - `ngOnInit` registers; `ngOnDestroy` unregisters; `ngOnChanges` patches via `registry.update(id, diff)`.
  - **Test:** `<button [muonroiSemantic] id="x" role="button">` → registry has node `x`; remove from DOM → registry is empty.
- [ ] **4.4 — Nested directive parent resolution test (NEW from review HIGH-4).** Fixture: `<div [muonroiSemantic] id="d" role="region"><span [muonroiSemantic] id="s" role="button"></span></div>`. Assert `registry.snapshot()` shows `s.parentId === "d"`, NOT the component root.
- [ ] **4.5 — Re-use `createWebSocketTransport` from core** (moved to core in Task 1.6). Angular adapter imports it directly; no Angular-specific transport code needed. **Test:** unit test the import works in the Angular library build.
- [ ] **4.6 — `SemanticSnapshotService`.** Runs outside Angular zone (`NgZone.runOutsideAngular`), debounced via RxJS `interval(33)`. **Test:** mount 3 directives in a fixture → exactly 1 frame emitted per tick, deduped.
- [ ] **4.6a — Platform guard for SSR (NEW from review HIGH-10).** Snapshot service constructor: `if (!isPlatformBrowser(this.platformId)) return;` before instantiating `WebSocket` or scheduling `requestAnimationFrame`. **Test:** `TestBed` with `PLATFORM_ID: "server"` mounts the service without throwing and without opening any network handle.
- [ ] **4.7 — E2E test in `tests/harness-angular/`.** Spawn a tiny Angular CLI app, drive via WS. **Acceptance:** same contract as 3.6.
- [ ] **4.8 — Bundle size verification.** **Acceptance:** prod build of `@muonroi/agent-harness-angular` ≤ 8 KB gzipped (relaxed from 2 KB per review feedback on Angular library overhead).

---

### Phase 5 — `/ideal` scaffolding integration (1 day) — DEPENDS ON: Phase 3 OR Phase 4 (not both)

> Phase 5 ships as soon as ONE FE adapter is green. If only Phase 3 is done, scaffolder offers React-only; Angular added when Phase 4 lands.

- [ ] **5.1 — CB-3 recoverable halt (REVISED per review HIGH-6).**
  - Refactor `src/product-loop/sprint-runner.ts:118` from `throw new Error(...)` to `yield { type: "halt", reason: "no_recipe", recovery_options: [...] }`.
  - Define `RecoveryOption` type in `src/product-loop/types.ts`.
  - **Update all 3 `runSprint()` call sites in `src/product-loop/index.ts` (~line 186, ~388, ~593):**
    - Sites 1 & 2 already wrap in `try/catch` — add explicit `if (chunk.type === "halt") { forward to UI; mark stage="halted"; break; }` inside the `for await` loop.
    - Site 3 has NO `try/catch` — add explicit halt-chunk discriminator check; without it, the halt yields silently and the generator returns normally, making the iteration look completed.
  - **Test:** `sprint-runner.test.ts` line 167 — replace the `expect(throw).toContain("no_recipe")` with `expect(yielded).toMatchObject({ type: "halt", reason: "no_recipe" })`. Add 3 new tests, one per call site, asserting halt chunk is forwarded (not swallowed).
- [ ] **5.2 — TUI renders recovery card.** `src/ui/app.tsx` handles `halt` chunk → renders an info card (matching style of `feat(council): frame Clarified Spec...` cards in commit `a9700d5`) listing the 3 options (init new / point to existing / continue as council brainstorm). Wrap with `<Semantic id="ideal-halt-card" role="dialog" isModal>`. **Test:** new `tests/harness/ideal-halt.spec.ts` asserts card appears with correct options.
- [ ] **5.3 — Init-new flow.** Picking "Init new" prompts user for: project name, BE stack (default: `muonroi-building-block`), FE stack (React if Phase 3 done / Angular if Phase 4 done / none). Scaffolder writes `package.json` + clones `muonroi-building-block` to `<name>/server/` + scaffolds FE skeleton in `<name>/client/` with `<SemanticProvider>` wired. **Test:** unit test scaffolder writes expected file tree; smoke test runs `bun install && bun test` on the scaffolded result.
- [ ] **5.4 — Point-to-existing flow.** Picking "Point to existing" prompts for path; runs `detectVerifyRecipe()` against it; if non-null, re-enters sprint 1 with that cwd. **Test:** integration test with fixture project.
- [ ] **5.5 — Brainstorm-mode fallback.** Picking "Continue as council" downgrades the flow: skips CB-3, skips verify gate, treats sprint as a `/council` debate that yields a spec.md instead of code. **Test:** asserts no `runVerify` is called, output is `spec.md`.

---

### Phase 6 — Polish, docs, ship (½ day)

- [ ] **6.1 — Update `CLAUDE.md`** (harness section) to document the new package boundary + how to add a new framework adapter.
- [ ] **6.2 — Update `docs/agent-harness/PROTOCOL.md`** with the WebSocket transport envelope (`dir` discriminator).
- [ ] **6.3 — `bun run lint:semantic` works across all adapters.** Generalize the script to read `scripts/.semantic-wrap-allow.txt` per-package. **Test:** running it on a fresh `packages/agent-harness-react/` fixture catches unwrapped components.
- [ ] **6.4 — README per package.** One-pager with install, minimal example, link to PROTOCOL.md.
- [ ] **6.5 — CHANGELOG.md entries.** `BREAKING: src/agent-harness/* moved to packages/agent-harness-{core,opentui}` + migration recipe.
- [ ] **6.6 — Release `0.2.0` of all packages** (publish target — public npm vs private registry — defer to user before this task).

---

## Effort estimate (v1.1, calibrated)

| Phase | Effort (v1.0) | Effort (v1.1) | Owner profile |
|---|---|---|---|
| 0 — Spikes | ½ day | **1 day** | Standard model |
| 1 — Core extract | 1 day | **1.5 days** | Standard model |
| 2 — OpenTUI adapter | ½ day | ½ day | Standard model |
| 3 — React-DOM adapter | 1.5 days | **2.5 days** | Standard model |
| 4 — Angular adapter | 2 days | **2.5 days** | Standard model (Angular DI is finicky) |
| 5 — `/ideal` scaffold integration | 1 day | 1 day | Standard model |
| 6 — Polish & ship | ½ day | ½ day | Haiku/cheap model |
| **Total serial** | **7 days** | **~9.5 days** | |
| **Total wall-clock if Phase 3 ∥ Phase 4** | — | **~7 days** | (two subagents in parallel after Phase 1+2) |

## Parallelization plan

- **Phases 0-2 serial** (single subagent): spikes → core extract → OpenTUI adapter.
- **Phases 3 and 4 parallel** (two subagents): after Phase 2's verification gate passes, dispatch React adapter to subagent A and Angular adapter to subagent B simultaneously. They share no files, share no peer-deps, share no test directories.
- **Phase 5 serial after first of {3, 4} completes**: scaffolder ships React-only if Phase 4 still in-flight; Angular path added later.
- **Phase 6 polish parallel**: 6.1, 6.2, 6.3, 6.4, 6.5 can run as 5 parallel cheap-model tasks.

## Acceptance criteria (the whole plan)

1. `bunx tsc --noEmit` clean across **all 4 packages** + `muonroi-cli`.
2. `bunx vitest run` from `muonroi-cli` — **all existing tests green** (zero regression, verified at every phase boundary).
3. New test suites `tests/harness-react/` and `tests/harness-angular/` — both green in CI matrix.
4. `bun run lint:semantic` runs across all packages and reports zero unwrapped page-level components in scaffolded projects.
5. Running `/ideal "build a todo app"` from an empty folder shows the recovery card (NOT the cryptic `Halted by circuit breaker: no_recipe` error). The halt chunk is forwarded by all 3 `runSprint()` call sites, not swallowed.
6. Init-new flow produces a working `bun install && bun test` artifact with BE = `muonroi-building-block` clone and FE = React-with-harness (or Angular-with-harness) skeleton.
7. MCP server `tui.start` continues to work for OpenTUI consumers without code changes.
8. **Bundle size targets:** `@muonroi/agent-harness-react` ≤ 2 KB gzipped (production mode, verified by `bundle-analyzer`). `@muonroi/agent-harness-angular` ≤ 8 KB gzipped exclusive of Angular framework runtime overhead.
9. **`"browser"` export condition verified**: importing `@muonroi/agent-harness-core` from a Vite/Rollup browser bundle produces zero references to `node:fs`, `node:os`, `node:path`, or `mcp-server.ts`.
10. **WS envelope discriminator**: all WS messages carry `dir: "frame" | "cmd"`; messages without `dir` are rejected by Zod schema in core.
11. **Angular SSR safety**: `TestBed` with `PLATFORM_ID: "server"` mounts `SemanticSnapshotService` without throwing and without opening WebSocket / `requestAnimationFrame` handles.

## Open questions

1. **Vue / Svelte adapters** — scope out of this plan? **Recommend: out of scope.** Add as a follow-up after React + Angular ship and patterns stabilize.
2. **Versioning** — independent semver per package, or lockstep? **Recommend: lockstep on 0.x, independent after 1.0** — early-stage core changes break adapters frequently.
3. **Publishing target** — public npm vs private registry? **Defer to user** before Phase 6.6.
4. **React 19 `use()` hook** — flagged as low-risk by feasibility review; defer to a follow-up plan if encountered. Document in CHANGELOG.

## References

- Existing harness design: `docs/superpowers/specs/2026-05-14-agent-harness-design.md`
- Existing protocol: `docs/agent-harness/PROTOCOL.md`, `docs/agent-harness/schema.json`
- Existing OpenTUI hook findings: `docs/agent-harness/spike-0a-findings.md`
- Existing MCP findings: `docs/agent-harness/spike-0d-mcp-sdk.md`
- Prior plan we're extending: `docs/superpowers/plans/2026-05-14-agent-harness.md`
- `muonroi-building-block` (BE framework default): `D:\sources\Core\muonroi-building-block`
- Cross-review findings (this plan):
  - Architecture: `agentId: a4cc8630ec19f8310`
  - Feasibility: `agentId: a6b69022d67240d07`
  - Risk / blast radius: `agentId: a9146823cd132d68d`
  - Sequencing / effort: `agentId: ab17d4da9f9624dfa`
