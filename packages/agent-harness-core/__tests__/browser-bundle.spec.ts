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
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(__dirname, "..");
const BROWSER_ENTRY = resolve(PACKAGE_ROOT, "dist/browser/index.js");

const FORBIDDEN_NODE_TOKENS = [
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

describe("browser bundle hygiene", () => {
  it("dist/browser/index.js exists (package must be built first)", () => {
    // This will throw if the file doesn't exist, which gives a clear error message.
    const content = readFileSync(BROWSER_ENTRY, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("contains no Node built-ins in the built browser bundle", () => {
    // Scan the pre-built dist/browser/index.js (produced by package build).
    // Re-invoking esbuild in vitest is flaky when host/binary versions diverge.
    const out = readFileSync(BROWSER_ENTRY, "utf8");
    for (const needle of FORBIDDEN_NODE_TOKENS) {
      expect(out, `browser bundle contains forbidden token: ${needle}`).not.toContain(needle);
    }
  });
});
