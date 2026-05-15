import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// __dirname / import.meta.dirname resolves to packages/agent-harness-angular/
const PKG_ROOT = resolve(import.meta.dirname ?? __dirname);
const CORE_SRC = resolve(PKG_ROOT, "../../packages/agent-harness-core/src");
const ANGULAR_NM = resolve(PKG_ROOT, "node_modules");

/** Resolve a path inside this package's own node_modules. */
function angularPkg(relPath: string) {
  return resolve(ANGULAR_NM, relPath);
}

export default defineConfig({
  resolve: {
    alias: [
      // --- @muonroi/agent-harness-core ---
      {
        find: /^@muonroi\/agent-harness-core\/(.+)$/,
        replacement: `${CORE_SRC}/$1.ts`,
      },
      {
        // Use browser-index to avoid Node-only modules (spec-helpers, mock-llm, sidechannel)
        // that would fail in a jsdom environment.
        find: "@muonroi/agent-harness-core",
        replacement: resolve(CORE_SRC, "browser-index.ts"),
      },

      // --- Angular packages (package-local node_modules) ---
      {
        find: "@angular/core/testing",
        replacement: angularPkg("@angular/core/fesm2022/testing.mjs"),
      },
      {
        find: "@angular/core",
        replacement: angularPkg("@angular/core/fesm2022/core.mjs"),
      },
      {
        find: "@angular/common/testing",
        replacement: angularPkg("@angular/common/fesm2022/testing.mjs"),
      },
      {
        find: "@angular/common",
        replacement: angularPkg("@angular/common/fesm2022/common.mjs"),
      },
      {
        find: "@angular/platform-browser/testing",
        replacement: angularPkg("@angular/platform-browser/fesm2022/testing.mjs"),
      },
      {
        find: "@angular/platform-browser",
        replacement: angularPkg("@angular/platform-browser/fesm2022/platform-browser.mjs"),
      },
      {
        find: "@angular/platform-browser-dynamic/testing",
        replacement: angularPkg("@angular/platform-browser-dynamic/fesm2022/testing.mjs"),
      },
      {
        find: "@angular/platform-browser-dynamic",
        replacement: angularPkg("@angular/platform-browser-dynamic/fesm2022/platform-browser-dynamic.mjs"),
      },
      {
        find: "zone.js/testing",
        replacement: angularPkg("zone.js/fesm2015/zone-testing.js"),
      },
      {
        find: "zone.js",
        replacement: angularPkg("zone.js/fesm2015/zone.js"),
      },
      {
        find: "rxjs/operators",
        replacement: angularPkg("rxjs/dist/esm/operators/index.js"),
      },
      {
        find: "rxjs",
        replacement: angularPkg("rxjs/dist/esm/index.js"),
      },
    ],
  },
  test: {
    root: PKG_ROOT,
    include: ["__tests__/**/*.spec.ts"],
    environment: "jsdom",
    setupFiles: ["__tests__/setup.ts"],
    testTimeout: 30_000,
    globals: false,
    // Note: bundle-size.spec.ts uses @vitest-environment node docblock comment
    // to override the jsdom environment. esbuild requires a proper Node.js env.
  },
});
