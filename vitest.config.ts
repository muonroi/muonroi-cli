import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const PKG_ROOT = resolve("packages/agent-harness-core/src");
const OPENTUI_PKG_ROOT = resolve("packages/agent-harness-opentui/src");

export default defineConfig({
  resolve: {
    alias: [
      {
        // @muonroi/agent-harness-core/transports/sidechannel → packages/agent-harness-core/src/transports/sidechannel.ts
        find: /^@muonroi\/agent-harness-core\/(.+)$/,
        replacement: `${PKG_ROOT}/$1.ts`,
      },
      {
        // @muonroi/agent-harness-core (bare) → packages/agent-harness-core/src/index.ts
        find: "@muonroi/agent-harness-core",
        replacement: resolve("packages/agent-harness-core/src/index.ts"),
      },
      {
        // @muonroi/agent-harness-opentui (bare) → packages/agent-harness-opentui/src/index.ts
        find: "@muonroi/agent-harness-opentui",
        replacement: `${OPENTUI_PKG_ROOT}/index.ts`,
      },
    ],
  },
  test: {
    fileParallelism: false,
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}", "tests/perf/**/*.bench.ts"],
    exclude: [
      "dist/**",
      "**/dist/**",
      "node_modules/**",
      "**/node_modules/**",
      "tmp/**",
      ".claude/**",
      ".cursor/**",
      // Angular tests require jsdom + zone.js + TestBed.initTestEnvironment().
      // Run via: bunx vitest -c packages/agent-harness-angular/vitest.config.ts run
      // or:      bun run test:harness-angular
      "packages/agent-harness-angular/**",
      // Angular E2E tests — require zone.js setup
      "tests/harness-angular/**",
      // React adapter tests require happy-dom environment.
      // Run via: bunx vitest -c packages/agent-harness-react/vitest.config.ts run
      // or:      bun run test:harness-react (from root)
      "packages/agent-harness-react/**",
      // React E2E tests — require happy-dom / WS transport setup
      "tests/harness-react/**",
      // OpenTUI E2E specs require the dedicated harness config (longer timeouts,
      // fileParallelism:false). Run via: bunx vitest -c vitest.harness.config.ts run tests/harness/
      "tests/harness/**",
      // export-transcripts.test.ts is bun-native (uses bun:sqlite `db.run(sql, ...args)`
      // API that vitest's module loader cannot resolve). Run with: `bun test
      // src/ee/__tests__/export-transcripts.test.ts`.
      "src/ee/__tests__/export-transcripts.test.ts",
    ],
    setupFiles: ["src/__test-stubs__/vitest-setup.ts"],
    testTimeout: 30_000,
    env: {
      // Suppress the agent-harness shim deprecation warning for in-repo runs.
      MUONROI_INTERNAL_SHIM_OK: "1",
    },
  },
});
