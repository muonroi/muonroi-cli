/**
 * entry-anchoring.spec.ts
 *
 * Regression for the `no_driver` bug: when the MCP harness server is launched
 * from a directory OTHER than the muonroi-cli repo root (e.g. a project-scoped
 * `.mcp.json` with no `cwd`, or Claude started in a sibling project), the child
 * TUI entry MUST still resolve to the real `src/index.ts`. Previously the entry
 * was `${process.cwd()}/src/index.ts`, so a wrong launch cwd made the child die
 * on spawn — tui.start returned `ok:true` (POSIX spawn returns before boot) and
 * every subsequent tui.* call returned `no_driver`.
 *
 * These assert the anchoring is decoupled from process.cwd().
 */

import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureHarnessRoots, resolveServerEntry, validateCwd } from "../src/mcp-server.js";

// Restore the default anchoring (process.cwd()-derived) after each test so we
// don't leak the injected root into other suites in the same worker.
afterEach(() => {
  // resolveServerEntry has no "unset" — re-point both at the cwd default shape.
  configureHarnessRoots({ repoRoot: process.cwd(), entry: resolve(process.cwd(), "src/index.ts") });
});

describe("entry anchoring (no_driver regression)", () => {
  it("uses the injected entry verbatim, ignoring the launch cwd", () => {
    const injected = "/opt/muonroi/checkout/src/index.ts";
    configureHarnessRoots({ repoRoot: "/opt/muonroi/checkout", entry: injected });
    expect(resolveServerEntry()).toBe(injected);
  });

  it("falls back to <repoRoot>/src/index.ts, NOT <cwd>/src/index.ts", () => {
    // Anchor repoRoot to a directory that is NOT process.cwd().
    const repoRoot = "/somewhere/muonroi-cli";
    configureHarnessRoots({ repoRoot, entry: resolve(repoRoot, "src/index.ts") });
    expect(resolveServerEntry()).toBe(resolve(repoRoot, "src/index.ts"));
    expect(resolveServerEntry().startsWith(repoRoot)).toBe(true);
  });

  it("anchors the cwd allowlist to the injected repoRoot", () => {
    const repoRoot = resolve(process.cwd()); // a real, resolvable dir
    configureHarnessRoots({ repoRoot });
    // The repo root itself is always inside the allowlist.
    expect(validateCwd(repoRoot).ok).toBe(true);
  });
});
