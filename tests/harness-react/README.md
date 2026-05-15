# tests/harness-react — React Harness E2E Tests

## Approach

These tests exercise the `@muonroi/agent-harness-react` package end-to-end using a
**Node-only programmatic approach** rather than a full browser launch.

### Why Node-only (no Vite + Playwright)?

The plan's Task 3.6 noted: "Given Task 0.1 found Playwright/Chromium boot times out on
Windows, prefer JSDom-driven E2E." After evaluating the options:

- **JSDom-driven Vite**: Requires Vite preview server + headless browser coordination;
  flaky on Windows due to named-pipe socket timing.
- **Node-only programmatic**: Uses `happy-dom` to provide a DOM environment for React,
  wires a real `ws` WebSocket server, and exercises the full `installReactHarness` →
  WS transport path. Proves the same contract deterministically.

### Contract verified

The E2E test proves:
1. `createSemanticRegistry` + `<Semantic id="root-button" role="button">` registers correctly.
2. `installReactHarness` sends frames to a real `ws` WebSocket server.
3. The server receives `{dir:"frame", mode:"live", nodes:[{id:"root-button", role:"button"}]}`.
4. Frame dedup works: mounting once → 1 frame; unmounting → 1 more frame.

### Running

```bash
# From repo root (React tests are excluded from root vitest.config.ts)
cd packages/agent-harness-react && bunx vitest run

# Or run only E2E
cd packages/agent-harness-react && bunx vitest run ../../tests/harness-react/e2e.spec.ts
```
