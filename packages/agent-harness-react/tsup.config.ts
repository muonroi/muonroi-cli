import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["react", "react-dom", "@muonroi/agent-harness-core"],
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      // Emit as a runtime expression so consumers can tree-shake in production.
      // esbuild requires a JS literal or entity name here; use "true" for dev builds.
      __MUONROI_HARNESS__: "true",
    };
  },
  // Production build: tree-shake harness code at build time
  // Set MUONROI_HARNESS=false and NODE_ENV=production to eliminate all registry calls
});
