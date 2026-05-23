/**
 * Verifies Bước 3-1 (always-on runId footer) and Bước 3-3 (inline reminder
 * on canonical-hash match) at the registry tool layer. Uses a real BashTool
 * against echo-style portable commands so the cache + footer wiring is
 * exercised end-to-end.
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

describe("Bước 3-1 — always-on runId footer", () => {
  beforeEach(() => clearBashOutputCache());

  it("emits [bash_run_id: bash-N] footer even when output is tiny", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    const out = await runBash(tools, { command: "echo small-output", timeout: 10_000 });
    expect(out).toMatch(/\[bash_run_id: bash-\d+\]/);
    // Tiny output → no hint about bash_output_get (would be noise).
    expect(out).not.toContain("use bash_output_get");
  });

  it("adds the bash_output_get hint only when cached output >= 4000 chars", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    // ~5000 char output via printf.
    const cmd =
      process.platform === "win32"
        ? `node -e "console.log('x'.repeat(5000))"`
        : `node -e "console.log('x'.repeat(5000))"`;
    const out = await runBash(tools, { command: cmd, timeout: 10_000 });
    expect(out).toMatch(/\[bash_run_id: bash-\d+ — \d+ chars cached; use bash_output_get/);
  }, 20_000);
});

describe("Bước 3-3 — inline reminder on canonical hash match", () => {
  beforeEach(() => clearBashOutputCache());

  it("appends [reminder: ...] when the second bash call canonicalizes identically", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    // Same underlying intent (`echo same-base`) with different cosmetic
    // wrapping (pipe to tail vs head). canonicalizeBashCommand collapses
    // these to the same hash.
    const first = await runBash(tools, { command: "echo same-base | head -1", timeout: 10_000 });
    const firstRunId = first.match(/bash-(\d+)/)?.[0];
    expect(firstRunId).toBeDefined();

    const second = await runBash(tools, { command: "echo same-base | tail -1", timeout: 10_000 });
    expect(second).toContain("[reminder:");
    expect(second).toContain(`run_id=${firstRunId}`);
    expect(second).toMatch(/Use bash_output_get/);
  }, 20_000);

  it("does NOT append the reminder when the canonical form differs", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    await runBash(tools, { command: "echo first", timeout: 10_000 });
    const second = await runBash(tools, { command: "echo second-different", timeout: 10_000 });
    expect(second).not.toContain("[reminder:");
    // Footer still present though.
    expect(second).toMatch(/\[bash_run_id: bash-\d+\]/);
  }, 20_000);

  it("resets / advances correctly across three consecutive same-intent calls", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    const r1 = await runBash(tools, { command: "echo repeat-me", timeout: 10_000 });
    const r2 = await runBash(tools, { command: "echo repeat-me | head -1", timeout: 10_000 });
    const r3 = await runBash(tools, { command: "echo repeat-me | tail -1", timeout: 10_000 });
    expect(r1).not.toContain("[reminder:");
    // r2's reminder must reference r1's runId.
    const r1Id = r1.match(/bash-(\d+)/)?.[0];
    expect(r2).toContain(`run_id=${r1Id}`);
    // r3's reminder must reference r2's runId (the LATEST match, not r1).
    const r2Id = r2.match(/bash-(\d+)/)?.[0];
    expect(r3).toContain(`run_id=${r2Id}`);
    // Sanity: ids are distinct.
    expect(r1Id).not.toBe(r2Id);
  }, 30_000);
});
