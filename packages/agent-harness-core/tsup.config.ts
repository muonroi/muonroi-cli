import { defineConfig } from "tsup";

export default defineConfig([
  // Node bundle — includes all Node-only modules
  {
    entry: {
      index: "src/index.ts",
      lint: "src/lint.ts",
      "mcp-server": "src/mcp-server.ts",
      registry: "src/registry.ts",
      "transports/sidechannel": "src/transports/sidechannel.ts",
    },
    outDir: "dist/node",
    format: ["esm"],
    sourcemap: "inline",
    dts: false,
    clean: true,
    target: "node18",
    platform: "node",
    // Prevent tsup from bundling workspace/external deps
    noExternal: [],
  },
  // Browser bundle — excludes Node-only entries (mock-llm, spec-helpers, mcp-server, sidechannel)
  {
    entry: {
      index: "src/browser-index.ts",
      registry: "src/registry.ts",
    },
    outDir: "dist/browser",
    format: ["esm"],
    sourcemap: "inline",
    dts: false,
    clean: false,
    target: "es2022",
    platform: "browser",
    // These should not appear in browser output; mark them external to get a hard error if imported
    external: [
      "node:fs",
      "node:os",
      "node:path",
      "node:child_process",
      "node:net",
      "node:stream",
      "node:tls",
      "node:crypto",
    ],
  },
]);
