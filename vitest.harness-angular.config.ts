/**
 * Vitest config for Angular adapter E2E tests (tests/harness-angular/).
 *
 * Uses jsdom environment + zone.js setup.
 * fileParallelism: false prevents multiple TestBed instances racing.
 *
 * Angular packages live in packages/agent-harness-angular/node_modules.
 * Explicit aliases route @angular/*, rxjs, zone.js to that location.
 *
 * IMPORTANT: tests/harness-angular/tsconfig.json extends the Angular package's
 * tsconfig.json (experimentalDecorators: true, useDefineForClassFields: false).
 * Vite 8 / OXC resolves the tsconfig by walking up from the test file's directory,
 * so that tsconfig takes effect for all files under tests/harness-angular/.
 */
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const CORE_SRC = resolve("packages/agent-harness-core/src");
const ANGULAR_PKG = resolve("packages/agent-harness-angular");
const ANGULAR_SRC = resolve(ANGULAR_PKG, "src");
const ANGULAR_NM = resolve(ANGULAR_PKG, "node_modules");

/** Resolve a path inside the Angular package's node_modules. */
function angularPkg(relPath: string) {
  return resolve(ANGULAR_NM, relPath);
}

export default defineConfig({
  resolve: {
    alias: [
      // --- @muonroi packages ---
      {
        find: /^@muonroi\/agent-harness-core\/(.+)$/,
        replacement: `${CORE_SRC}/$1.ts`,
      },
      {
        find: "@muonroi/agent-harness-core",
        replacement: resolve(CORE_SRC, "browser-index.ts"),
      },
      {
        find: "@muonroi/agent-harness-angular",
        replacement: resolve(ANGULAR_SRC, "public-api.ts"),
      },

      // --- Angular packages (resolve to package-local node_modules) ---
      // Order matters: more-specific paths must come before generic ones.
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
        replacement: angularPkg("zone.js/bundles/zone-testing.umd.js"),
      },
      {
        find: "zone.js",
        replacement: angularPkg("zone.js/bundles/zone.umd.js"),
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
    include: ["tests/harness-angular/**/*.spec.ts"],
    environment: "jsdom",
    setupFiles: ["packages/agent-harness-angular/__tests__/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
