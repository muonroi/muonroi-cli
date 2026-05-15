# Spike: Angular Adapter Feasibility (Task 0.2)

**Date:** 2026-05-15  
**Branch:** feat/harness-extract-multiframework  
**Spike dir:** `spikes/angular-harness/`  
**Verdict:** GREEN (node-verified — browser boot skipped on Windows; same fallback as Task 0.1)

---

## What was proved

1. **`[muonroiSemantic]` directive + element-injector chain works.** The directive uses `inject(SEMANTIC_PARENT_ID, { optional: true, skipSelf: true })` to resolve its parent's id from the element-injector hierarchy. For `<div [muonroiSemantic] id="d"><span [muonroiSemantic] id="s">x</span></div>`, the span's `parentId` resolved to `"d"` — NOT the component root injector. The HIGH-4 risk is mitigated.

2. **Re-provision via `useFactory` + `deps: [SemanticDirective]` works.** Each directive re-provides `SEMANTIC_PARENT_ID` on its own element injector using a factory that returns `self.id`. Angular resolves the circular dep correctly because the directive instance is available in the element injector by the time children are created.

3. **`ngOnInit`/`ngOnDestroy` lifecycle wires cleanly into the registry.** Mount emits frame 1 (tree: `d` as root, `s` as child). Unmount emits frame 2 (empty nodes). Hash-dedup suppressed 2 extra identical snapshots.

4. **Protocol shape confirmed.** `{ mode: "live", version: "0.1.0", seq, ts, nodes }` — consistent with Task 0.1 and `src/agent-harness/protocol.ts`.

---

## Verification output (Node fallback — confirmed 2026-05-15)

```
$ npx ts-node --project tsconfig.json node-verify.ts
PASS: parent resolution + 2 frames + no dup
Frame 1: { "mode":"live","version":"0.1.0","seq":1,"nodes":[{"id":"d","role":"region","children":[{"id":"s","role":"button"}]}] }
Frame 2: { "mode":"live","version":"0.1.0","seq":2,"nodes":[] }
s.parentId was: d
```

Exit code: **0**.

---

## Surprises / gotchas

- **jsdom required for TestBed.** Angular's `BrowserDynamicTestingModule` reads `document` at import time. A minimal jsdom setup (global `window`, `document`, `HTMLElement`, etc.) must be installed BEFORE importing Angular. The `node-verify.ts` bootstraps jsdom first, then imports zone.js and Angular.

- **zone.js/node vs zone.js.** Node environments must import `zone.js/node` (patches `setTimeout`, `Promise`, etc.) rather than the browser bundle. Missing this caused `Zone` not-defined errors with zone.js 0.14.x.

- **`useDefineForClassFields: false` is required.** With TypeScript `target: ES2022` and Angular decorators, `useDefineForClassFields: true` (the TS default for ES2022+) would overwrite Angular's decorator-based metadata. Setting it to `false` is mandatory for `emitDecoratorMetadata` to work.

- **Workspace Angular packages bleed.** Without an explicit `moduleResolution: "node"` tsconfig and a local `node_modules`, ts-node resolved to the workspace's Angular source (`.ts` files). The spike's own `node_modules/@angular` overrides correctly once the tsconfig is isolated.

- **Browser path skipped.** Same as Task 0.1 — Playwright/Chromium boot not attempted on Windows. Node-only verification via TestBed is the canonical Angular testing pattern anyway.

---

## Verdict for Phase 4

**GREEN.** The `[muonroiSemantic]` directive pattern is viable. Element-injector token re-provision resolves parent ids correctly across nested DOM elements. No surprises that would block the production adapter.

---

## Recommendation for production adapter (Phase 4)

Use a **standalone `[muonroiSemantic]` directive** with `providers: [{ provide: SEMANTIC_PARENT_ID, useFactory: (d) => d.id, deps: [SemanticDirective] }]` and `inject(SEMANTIC_PARENT_ID, { optional: true, skipSelf: true })` for parent resolution. Ship as `@muonroi/harness-angular` exporting the directive, `SemanticRegistry` service, and `startSnapshotLoop` backed by `setInterval` (no `rAF` — Angular zones manage CD cycles).
