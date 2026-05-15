/**
 * Browser bundle hygiene test.
 *
 * Verifies that dist/browser/index.js (produced by `bun run build` in the core
 * package) contains no Node built-in imports that would break browser environments.
 *
 * Requires the package to be built before running:
 *   bun --cwd packages/agent-harness-core run build
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(__dirname, "..");
const BROWSER_ENTRY = resolve(PACKAGE_ROOT, "dist/browser/index.js");
const TEST_BUNDLE_OUT = resolve(PACKAGE_ROOT, "dist/__test-bundle.js");

describe("browser bundle hygiene", () => {
  it("dist/browser/index.js exists (package must be built first)", () => {
    // This will throw if the file doesn't exist, which gives a clear error message.
    const content = readFileSync(BROWSER_ENTRY, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("contains no Node built-ins in re-bundled output", async () => {
    // Re-bundle via esbuild from the already-built browser entry.
    // esbuild will inline all imports; any surviving "node:*" reference is a violation.
    await build({
      entryPoints: [BROWSER_ENTRY],
      bundle: true,
      platform: "browser",
      outfile: TEST_BUNDLE_OUT,
      // Do NOT mark node:* as external — we want esbuild to fail or inline them so we can detect them.
      logLevel: "silent",
    });

    const out = readFileSync(TEST_BUNDLE_OUT, "utf8");

    const forbidden = [
      'require("fs")',
      'require("os")',
      'require("path")',
      'require("child_process")',
      'require("net")',
      'require("stream")',
      'require("crypto")',
      'from "node:fs"',
      'from "node:os"',
      'from "node:path"',
      'from "node:child_process"',
      'from "node:net"',
      'from "node:stream"',
      'from "node:tls"',
      'from "node:crypto"',
    ];

    for (const needle of forbidden) {
      expect(out, `browser bundle contains forbidden token: ${needle}`).not.toContain(needle);
    }
  });
});
