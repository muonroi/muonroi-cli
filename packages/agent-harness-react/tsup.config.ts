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
      __MUONROI_HARNESS__: 'process.env.MUONROI_HARNESS === "true" || process.env.NODE_ENV !== "production"',
    };
  },
  // Production build: tree-shake harness code at build time
  // Set MUONROI_HARNESS=false and NODE_ENV=production to eliminate all registry calls
});
