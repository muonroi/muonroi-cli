/**
 * @vitest-environment node
 *
 * Task 4.8 — Bundle size verification for @muonroi/agent-harness-angular.
 *
 * Strategy: use esbuild to bundle the Angular library entry point with
 * Angular framework packages and rxjs marked as external (peer-deps).
 * Gzip the output and assert ≤ 8 KB.
 *
 * We do NOT use ng-packagr here (too heavy for vitest invocation).
 * esbuild against the entry with externals gives us a representative
 * measure of the library-only code size.
 */

import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const ENTRY = resolve(__dirname, "../src/public-api.ts");
const MAX_GZIPPED_BYTES = 8 * 1024; // 8 KB

describe("@muonroi/agent-harness-angular bundle size", () => {
  it("gzipped bundle is ≤ 8 KB (excludes Angular framework runtime)", async () => {
    const result = await build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "esm",
      minify: true,
      platform: "browser",
      // Mark all Angular/rxjs/zone/core as external — they are peer-deps and
      // not part of the library's own code weight.
      external: [
        "@angular/core",
        "@angular/common",
        "rxjs",
        "rxjs/*",
        "rxjs/operators",
        "zone.js",
        "@muonroi/agent-harness-core",
      ],
      // Silence "could not resolve" for peer dep type imports.
      logLevel: "silent",
    });

    const code = result.outputFiles[0].text;
    const gzipped = gzipSync(Buffer.from(code));

    console.log(`  Bundle: ${code.length} bytes raw, ${gzipped.length} bytes gzipped (limit: ${MAX_GZIPPED_BYTES})`);

    expect(gzipped.length).toBeLessThanOrEqual(MAX_GZIPPED_BYTES);
  });
});
