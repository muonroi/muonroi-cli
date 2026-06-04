/**
 * Corrective guard for malformed bash tool calls (missing / empty `command`).
 *
 * Live obs (2026-06-04, deepseek long session 734e65cffdf6): on an open-ended
 * "find a bug" task the cheap model emitted `bash` calls with EMPTY arguments
 * (`{}`, no `command`) three times in a row until the loop-guard askcard fired.
 * Root cause: the registry passed `input.command` (undefined) straight to
 * `bash.execute()`, where `command.startsWith(...)` threw an opaque TypeError.
 * An opaque error doesn't steer a cheap model to self-correct — it just repeats
 * the malformed call. The guard returns a crisp, actionable instruction instead
 * so the next step supplies a real command.
 */

import os from "node:os";
import { describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
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

describe("bash tool — empty/missing command corrective guard", () => {
  it("returns a corrective error (not a thrown TypeError) for missing command {}", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    const out = await runBash(tools, {});
    expect(out).toMatch(/ERROR/);
    expect(out).toMatch(/non-empty/i);
    expect(out).toMatch(/command/i);
  });

  it("returns the corrective error for an empty-string command", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    const out = await runBash(tools, { command: "" });
    expect(out).toMatch(/ERROR/);
    expect(out).toMatch(/non-empty/i);
  });

  it("returns the corrective error for a whitespace-only command", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    const out = await runBash(tools, { command: "   " });
    expect(out).toMatch(/ERROR/);
    expect(out).toMatch(/non-empty/i);
  });

  it("does NOT block a real command", async () => {
    const bash = new BashTool(os.tmpdir());
    const tools = createBuiltinTools(bash, "agent");
    const out = await runBash(tools, { command: "echo guard-ok", timeout: 10_000 });
    expect(out).toContain("guard-ok");
    expect(out).toMatch(/\[bash_run_id: bash-\d+\]/);
    expect(out).not.toMatch(/non-empty/i);
  }, 15_000);
});
