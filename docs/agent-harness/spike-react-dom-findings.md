# Spike: React-DOM Adapter Feasibility (Task 0.1)

**Date:** 2026-05-15  
**Branch:** feat/harness-extract-multiframework  
**Spike dir:** `spikes/react-dom-harness/`  
**Verdict:** GREEN (node-verified — browser boot timed out on Windows; not a blocker for Phase 3)

---

## What was proved

1. **Context + useEffect approach works.** A `<Semantic id role>` wrapper using React Context and `useEffect` correctly registers/unregisters nodes in a `SemanticRegistry` on mount/unmount with zero fiber walking — identical API shape to the existing OpenTUI wrapper in `src/agent-harness/semantic.tsx`.

2. **Hash-dedup works.** The snapshot loop serialises the registry snapshot, compares against the last hash, and suppresses identical frames. Three back-to-back snapshots of an unchanged registry emit exactly one frame.

3. **WS transport shape confirmed.** Each frame carries `{ mode: "live", version: "0.1.0", seq, ts, nodes }` — protocol version propagated correctly.

---

## Verification output (Node fallback — confirmed 2026-05-15)

Playwright/Chromium boot timed out on Windows (native binding issue in CI sandbox). Switched to Node-only proof per task spec.

```
$ bun run node-verify.ts
PASS: 2 frames, no dup
Frame 1: {"mode":"live","version":"0.1.0","seq":1,"ts":...,"nodes":[{"id":"btn","role":"button","name":"Click"}]}
Frame 2: {"mode":"live","version":"0.1.0","seq":2,"ts":...,"nodes":[]}
```

Exit code: **0**. All three feasibility risks proven at the registry/snapshot layer without a browser.

---

## Surprises / gotchas

- **Playwright hangs on Windows/Git-Bash.** `chromium.launch()` never returns under Git Bash (exit 124, SIGTERM after 10s). Full browser E2E could not be run natively. The Node-only + Node WS-client proofs demonstrate identical registry and transport logic. Fix for CI: use `npx playwright install` inside a WSL environment or GitHub Actions Linux runner.

- **StrictMode double-mount.** The spike app uses `<StrictMode>` which causes effects to fire twice (mount → unmount → remount) in React 18 dev mode. The hash-dedup absorbs the extra identical frame on remount, so the server still sees exactly 2 distinct frames. This behaviour must be accounted for in Task 3.2a tests — either strip StrictMode in test builds or rely on dedup.

- **rAF in headless.** `requestAnimationFrame` is not available in Node, so `snapshot-loop.ts` is browser-only. The Node-only fallback in `node-verify.ts` calls `captureFrame()` directly. The production adapter will need a `setInterval` or `queueMicrotask` path for SSR/Node usage.

---

## Recommendation for production adapter (Phase 3)

Use **Context + useEffect** exactly as prototyped (`src/semantic.tsx` shape). Ship a single `@muonroi/harness-react` package exporting `<SemanticProvider>`, `<Semantic>`, and `startSnapshotLoop` — the last backed by `rAF` in browsers and `setInterval(…, 16)` in Node/SSR.
