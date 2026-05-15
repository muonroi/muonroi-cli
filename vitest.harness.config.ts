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
  test: {
    include: ["tests/harness/**/*.spec.ts"],
    exclude: ["dist/**", "node_modules/**", "tmp/**", ".claude/**", ".cursor/**"],
    setupFiles: ["src/__test-stubs__/vitest-setup.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
