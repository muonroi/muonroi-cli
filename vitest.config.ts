import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const PKG_ROOT = resolve("packages/agent-harness-core/src");

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
    ],
  },
  test: {
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}", "tests/perf/**/*.bench.ts"],
    exclude: ["dist/**", "node_modules/**", "tmp/**", ".claude/**", ".cursor/**"],
    setupFiles: ["src/__test-stubs__/vitest-setup.ts"],
    testTimeout: 30_000,
  },
});
