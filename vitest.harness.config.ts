/**
 * vitest.harness.config.ts
 *
 * Separate Vitest config for E2E harness specs (tests/harness/).
 * Runs specs one-at-a-time to avoid idle-timeout contention when
 * multiple TUI processes are spawned under WSL simultaneously.
 *
 * Usage:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/
 *
 * (The default vitest.config.ts is unchanged — unit tests keep their
 * normal parallelism.)
 */
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const PKG_ROOT = resolve("packages/agent-harness-core/src");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@muonroi\/agent-harness-core\/(.+)$/,
        replacement: `${PKG_ROOT}/$1.ts`,
      },
      {
        find: "@muonroi/agent-harness-core",
        replacement: resolve("packages/agent-harness-core/src/index.ts"),
      },
    ],
  },
  // zod v4 ships ESM-only; vitest's SSR transform fails to resolve the named
  // `z` export at module-eval time (predicate.ts, catalog-client.ts). See
  // vitest.config.ts for the same fix on the unit-test path.
  optimizeDeps: { include: ["zod"] },
  ssr: { noExternal: ["zod"] },
  test: {
    include: ["tests/harness/**/*.spec.ts"],
    exclude: ["dist/**", "node_modules/**", "tmp/**", ".claude/**", ".cursor/**"],
    setupFiles: ["src/__test-stubs__/vitest-setup.ts", "tests/harness/harness-env-isolation.ts"],
    // Every harness spec spawns a REAL agent-mode TUI child (`bun run
    // src/index.ts`), whose cold boot imports the entire CLI graph. Under
    // CPU contention (serial spawns + ambient load) that boot — and the
    // first agentic round-trips — routinely measure 25–46s, occasionally
    // more. The named-pipe handshake budget is already 90s
    // (test-spawn.ts:resolveHandshakeTimeoutMs). For the OUTER vitest
    // hook/test timeouts to not be the binding (and wrong) constraint, they
    // must comfortably exceed handshake(90s) + idle(15s) + textbox(5s).
    // Measured: 60s testTimeout was marginal (the error-states "toast" test
    // legitimately takes ~46s under load). CI-load-sensitive specs (council-flow,
    // discovery-askcard, session-rotation-delegation, determinism) widen their
    // OWN internal waits + per-it timeouts to absorb the 25–46s cold boot on a
    // shared 2-core runner; this outer ceiling is raised to 240s so it stays
    // non-binding for specs that rely on the default. Passing tests still resolve
    // the moment their condition is met — this only widens the ceiling.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // Real-subprocess E2E under CPU starvation is inherently transient:
    // a child can be momentarily starved and miss a round/render within an
    // attempt's window. `retry` re-runs the failed test on a fresh attempt
    // (when load may be lower). It does NOT mask deterministic regressions —
    // a real logic bug fails all attempts and the suite still goes red.
    // Generalizes the per-describe `retry: 2` that error-states.spec.ts
    // already relied on, to every spec.
    retry: 2,
    fileParallelism: false,
    env: {
      // Suppress the agent-harness shim deprecation warning for in-repo runs.
      MUONROI_INTERNAL_SHIM_OK: "1",
    },
  },
});
