import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const pkgRoot = resolve(import.meta.dirname ?? __dirname);

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: false,
    root: pkgRoot,
    include: ["**/__tests__/**/*.spec.{ts,tsx}", "../../tests/harness-react/**/*.spec.tsx"],
  },
  resolve: {
    alias: [
      {
        find: /^@muonroi\/agent-harness-core\/(.+)$/,
        replacement: resolve(pkgRoot, "../../packages/agent-harness-core/src/$1.ts"),
      },
      {
        find: "@muonroi/agent-harness-core",
        replacement: resolve(pkgRoot, "../../packages/agent-harness-core/src/browser-index.ts"),
      },
    ],
  },
  define: {
    __MUONROI_HARNESS__: "true",
  },
});
