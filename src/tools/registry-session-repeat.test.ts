/**
 * Phase 4R — session-scoped bash canonical-repeat detector.
 *
 * Verifies that the `[reminder: ...]` injection survives across
 * `createBuiltinTools()` rebuilds when the sessionId is preserved. The
 * baseline session `77cd2e11c6a5` re-ran an identical `grep` 9 times
 * because each askcard answer rebuilt the registry and wiped the
 * per-closure detector state. The fix lifts the state to a
 * process-global Map keyed by sessionId so the detector survives
 * registry rebuilds within the same session.
 */

import os from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { clearBashOutputCache } from "./bash-output-cache.js";
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

describe("Phase 4R — session-scoped bash repeat detector", () => {
  beforeEach(() => {
    clearBashOutputCache();
    // Reset the process-global state so each test starts clean. The
    // registry reads from this Map lazily, so clearing it here is enough.
    (globalThis as { __muonroiBashRepeatState?: Map<string, unknown> }).__muonroiBashRepeatState = new Map();
  });

  it("fires reminder when the SAME sessionId is reused across registry rebuilds", async () => {
    const bash = new BashTool(os.tmpdir());

    // Turn 1: build registry with sessionId=S1, run command, no reminder.
    const tools1 = createBuiltinTools(bash, "agent", { sessionId: "S1" });
    const first = await runBash(tools1, { command: "echo same-base | head -1", timeout: 10_000 });
    const firstRunId = first.match(/bash-(\d+)/)?.[0];
    expect(firstRunId).toBeDefined();
    expect(first).not.toContain("[reminder:");

    // Simulate askcard answer or sub-agent turn: tear down + rebuild
    // registry, but keep the same sessionId. Pre-fix this would reset
    // the per-closure state and miss the repeat.
    const tools2 = createBuiltinTools(bash, "agent", { sessionId: "S1" });
    const second = await runBash(tools2, { command: "echo same-base | tail -1", timeout: 10_000 });
    expect(second).toContain("[reminder:");
    expect(second).toContain(`run_id=${firstRunId}`);
    expect(second).toMatch(/Use bash_output_get/);
  }, 30_000);

  it("does NOT fire reminder when a DIFFERENT sessionId issues the same canonical command", async () => {
    const bash = new BashTool(os.tmpdir());

    const toolsS1 = createBuiltinTools(bash, "agent", { sessionId: "S1" });
    await runBash(toolsS1, { command: "echo cross-session | head -1", timeout: 10_000 });

    // Different session — must NOT see S1's history.
    const toolsS2 = createBuiltinTools(bash, "agent", { sessionId: "S2" });
    const out = await runBash(toolsS2, { command: "echo cross-session | tail -1", timeout: 10_000 });
    expect(out).not.toContain("[reminder:");
    // Footer still fires.
    expect(out).toMatch(/\[bash_run_id: bash-\d+\]/);
  }, 30_000);

  it("fires reminder across 3 separate registry rebuilds within the same session", async () => {
    const bash = new BashTool(os.tmpdir());

    const tools1 = createBuiltinTools(bash, "agent", { sessionId: "S3" });
    const r1 = await runBash(tools1, { command: "echo repeat-me", timeout: 10_000 });
    expect(r1).not.toContain("[reminder:");
    const r1Id = r1.match(/bash-(\d+)/)?.[0];

    const tools2 = createBuiltinTools(bash, "agent", { sessionId: "S3" });
    const r2 = await runBash(tools2, { command: "echo repeat-me | head -1", timeout: 10_000 });
    expect(r2).toContain(`run_id=${r1Id}`);
    const r2Id = r2.match(/bash-(\d+)/)?.[0];

    const tools3 = createBuiltinTools(bash, "agent", { sessionId: "S3" });
    const r3 = await runBash(tools3, { command: "echo repeat-me | tail -1", timeout: 10_000 });
    // Each rebuild MUST chain — r3 sees the latest runId (r2's), not r1's.
    expect(r3).toContain(`run_id=${r2Id}`);
    expect(r1Id).not.toBe(r2Id);
  }, 45_000);

  it("legacy callers (no sessionId) keep per-instance isolation", async () => {
    const bash = new BashTool(os.tmpdir());

    // No sessionId — each registry instance is isolated, matching the
    // pre-4R closure behaviour. This is what registry-bash-footer.test.ts
    // implicitly relies on.
    const toolsA = createBuiltinTools(bash, "agent");
    await runBash(toolsA, { command: "echo legacy-iso | head -1", timeout: 10_000 });

    const toolsB = createBuiltinTools(bash, "agent");
    const out = await runBash(toolsB, { command: "echo legacy-iso | tail -1", timeout: 10_000 });
    expect(out).not.toContain("[reminder:");
  }, 30_000);
});
