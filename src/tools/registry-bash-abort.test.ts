/**
 * Regression — session 7ec700df5589 / d22397a9e47d (2026-07-29).
 *
 * `bash.execute(command, timeout, abortSignal)` takes an abort signal, and
 * `BashTool` uses it to kill the child. But the registry called it as
 * `bash.execute(input.command, input.timeout ?? 30000)` — two args — so
 * `abortSignal` was always `undefined` and `onAbort` was NEVER registered. The
 * turn watchdog's `abortController.abort()` therefore could not touch a running
 * bash child: cancelling was structurally impossible, not merely unreliable.
 *
 * The AI SDK does supply the signal — it is `ToolCallOptions.abortSignal`, and
 * streamText is called with one (src/orchestrator/stream-runner.ts). The registry
 * just never declared or forwarded it.
 *
 * These tests drive the tool the way the SDK does (args + call options) and
 * assert the signal actually reaches the child.
 */

import os from "node:os";
import { describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown, options?: unknown) => Promise<unknown> | unknown;
}

async function runBash(
  tools: Record<string, unknown>,
  args: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<string> {
  const t = tools.bash as ToolWithExecute;
  if (!t?.execute) throw new Error("bash tool has no execute");
  const out = await t.execute(args, options);
  return typeof out === "string" ? out : JSON.stringify(out);
}

function posixAvailable(bash: BashTool): boolean {
  return bash.getResolvedShell().isPosix;
}

describe("registry bash — abortSignal is forwarded to the child", () => {
  it("cancels a long-running command when the turn is aborted", async () => {
    const bash = new BashTool(os.tmpdir(), { shellSettings: { kind: "bash" } });
    if (!posixAvailable(bash)) return;
    const tools = createBuiltinTools(bash, "agent");

    const controller = new AbortController();
    const startedAt = Date.now();
    // 30s of work with a 60s tool timeout: the ONLY thing that can end this
    // early is the abort signal reaching the child.
    const pending = runBash(
      tools,
      { command: "sleep 30", timeout: 60_000 },
      { toolCallId: "call_abort_1", abortSignal: controller.signal },
    );
    setTimeout(() => controller.abort(), 500);

    const out = await pending;
    const elapsedMs = Date.now() - startedAt;
    // Pre-fix this ran the full 30s because onAbort was never registered.
    expect(elapsedMs).toBeLessThan(15_000);
    expect(out).toMatch(/Cancelled/i);
  }, 45_000);

  it("still runs normally when no signal is supplied", async () => {
    const bash = new BashTool(os.tmpdir(), { shellSettings: { kind: "bash" } });
    if (!posixAvailable(bash)) return;
    const tools = createBuiltinTools(bash, "agent");

    const out = await runBash(tools, { command: "echo no-signal-ok" }, { toolCallId: "call_abort_2" });
    expect(out).toContain("no-signal-ok");
  }, 20_000);

  it("does not start the command at all when the signal is already aborted", async () => {
    const bash = new BashTool(os.tmpdir(), { shellSettings: { kind: "bash" } });
    if (!posixAvailable(bash)) return;
    const tools = createBuiltinTools(bash, "agent");

    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    const out = await runBash(
      tools,
      { command: "sleep 30", timeout: 60_000 },
      { toolCallId: "call_abort_3", abortSignal: controller.signal },
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(out).toMatch(/Cancelled/i);
  }, 45_000);
});
