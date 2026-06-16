/**
 * Integration: git-safety guards wired into the bash tool (registry.ts).
 * Unit logic lives in git-safety.test.ts; this asserts the WIRING — a blocked
 * push returns the block message WITHOUT executing, and a broad stage appends
 * the sensitive-path warning to the tool output.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { clearBashOutputCache } from "./bash-output-cache.js";
import { __resetGitSafetyState, recordCommandOutcome } from "./git-safety.js";
import { createBuiltinTools } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown) => Promise<unknown> | unknown;
}

async function runBash(tools: Record<string, unknown>, args: Record<string, unknown>): Promise<string> {
  const t = tools.bash as ToolWithExecute;
  if (!t?.execute) throw new Error("bash tool has no execute");
  const out = await t.execute(args);
  return typeof out === "string" ? out : JSON.stringify(out);
}

describe("git-safety wiring in bash tool", () => {
  beforeEach(() => {
    clearBashOutputCache();
    (globalThis as { __muonroiBashRepeatState?: Map<string, unknown> }).__muonroiBashRepeatState = new Map();
    __resetGitSafetyState();
    delete process.env.MUONROI_ALLOW_PUSH_ON_RED;
  });
  afterEach(() => {
    delete process.env.MUONROI_ALLOW_PUSH_ON_RED;
  });

  it("BLOCKS git push (without executing) after a verification failed this session", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent", { sessionId: "GS1" });
    // Simulate a failed test earlier in the session.
    recordCommandOutcome("GS1", "npm test", false);

    const out = await runBash(tools, { command: "git push origin main", timeout: 10_000 });
    expect(out).toMatch(/^BLOCKED:/);
    expect(out).toMatch(/npm test/);
    // The distinctive block message proves git push never ran (a real push in
    // tmpdir would fail with a git error like "not a git repository", not this).
    expect(out).not.toMatch(/not a git repository|fatal:/i);
  }, 20_000);

  it("ALLOWS git push once the failed verification re-runs green", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent", { sessionId: "GS2" });
    recordCommandOutcome("GS2", "npm test", false);
    recordCommandOutcome("GS2", "npm test", true); // re-ran green

    const out = await runBash(tools, { command: "git push origin main", timeout: 10_000 });
    expect(out).not.toMatch(/^BLOCKED:/);
  }, 20_000);

  it("respects MUONROI_ALLOW_PUSH_ON_RED override", async () => {
    process.env.MUONROI_ALLOW_PUSH_ON_RED = "1";
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent", { sessionId: "GS3" });
    recordCommandOutcome("GS3", "vitest run", false);

    const out = await runBash(tools, { command: "git push", timeout: 10_000 });
    expect(out).not.toMatch(/^BLOCKED:/);
  }, 20_000);

  it("blocks push across registry rebuilds even with NO sessionId (stable process key)", async () => {
    // Regression for the anon-key false negative: createBuiltinTools() without a
    // sessionId must still gate the push, because production call sites
    // (message-processor) don't thread sessionId and rebuild the registry every
    // turn. A failing verify in one anon registry must block a push in the next.
    const bash = new BashTool(os.tmpdir());
    // `npm test` is a recognized verification command and fails fast here
    // (no package.json in a temp dir) → recorded as a failed verify under the
    // stable process key.
    const toolsA = createBuiltinTools(bash, "agent"); // no sessionId
    const failOut = await runBash(toolsA, { command: "npm test", timeout: 20_000 });
    expect(failOut).toMatch(/ERROR/); // the verify failed

    // Fresh anon registry (simulates the per-turn rebuild).
    const toolsB = createBuiltinTools(bash, "agent"); // no sessionId
    const pushOut = await runBash(toolsB, { command: "git push origin main", timeout: 10_000 });
    expect(pushOut).toMatch(/^BLOCKED:/);
  }, 30_000);

  it("appends a sensitive-path WARNING on a broad git add when secrets exist", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "gs-stage-"));
    writeFileSync(join(dir, ".env"), "API_KEY=secret");
    try {
      const bash = new BashTool(dir);
      const tools = createBuiltinTools(bash, "agent", { sessionId: "GS4" });
      const out = await runBash(tools, { command: "git add -A", timeout: 10_000 });
      expect(out).toMatch(/\[WARNING:/);
      expect(out).toMatch(/\.env/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
