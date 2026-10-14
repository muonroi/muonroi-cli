/**
 * Background shells must report their own end, and the agent must not wait on
 * them with `sleep` — that kept the turn (and the user's prompt) locked for the
 * whole job instead of letting the job's completion wake the agent.
 */

import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { processJobKey } from "../utils/background-jobs.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

const tools: BashTool[] = [];
function makeBash(): BashTool {
  const bash = new BashTool(os.tmpdir());
  tools.push(bash);
  return bash;
}

afterEach(async () => {
  for (const b of tools.splice(0)) await b.cleanup();
});

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function startedProcess(output: string | undefined): { id: number; pid: number } {
  const m = /id: (\d+), pid: (\d+)/.exec(output ?? "");
  if (!m) throw new Error(`no started line in: ${output}`);
  return { id: Number(m[1]), pid: Number(m[2]) };
}

describe("BashTool background exit notices", () => {
  it("reports a finished background process once, with the tail of its output", async () => {
    const bash = makeBash();
    const started = await bash.startBackground("echo hello-from-bg");
    expect(started.success).toBe(true);
    expect(started.output).toMatch(/end your turn/i);
    const { id, pid } = startedProcess(started.output);

    await waitFor(() => bash.getBackgroundProcessStates()[processJobKey(id, pid)]?.state !== "running");
    expect(bash.getBackgroundProcessStates()[processJobKey(id, pid)]).toEqual({ state: "done", exitCode: 0 });

    // The log stream flushes on exit — give it a beat before reading the tail.
    await new Promise((r) => setTimeout(r, 100));
    const notices = await bash.consumeExitNotifications();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`Background process finished: id ${id}`);
    expect(notices[0]).toContain("hello-from-bg");
    expect(await bash.consumeExitNotifications()).toEqual([]);
  });

  it("marks a non-zero exit as failed", async () => {
    const bash = makeBash();
    const { id, pid } = startedProcess((await bash.startBackground("exit 3")).output);
    await waitFor(() => bash.getBackgroundProcessStates()[processJobKey(id, pid)]?.state !== "running");
    expect(bash.getBackgroundProcessStates()[processJobKey(id, pid)]).toEqual({ state: "failed", exitCode: 3 });
    expect((await bash.consumeExitNotifications())[0]).toContain("Background process failed");
  });

  it("does not report a process the agent stopped itself", async () => {
    const bash = makeBash();
    const { id } = startedProcess((await bash.startBackground("sleep 30")).output);
    expect(await bash.hasRunningBackgroundJobs()).toBe(true);
    await bash.stopProcess(id);
    expect(await bash.hasRunningBackgroundJobs()).toBe(false);
    expect(await bash.consumeExitNotifications()).toEqual([]);
  });

  it("counts probed jobs (delegations) as running background work", async () => {
    const bash = makeBash();
    expect(await bash.hasRunningBackgroundJobs()).toBe(false);
    bash.setBackgroundJobProbe(async () => true);
    expect(await bash.hasRunningBackgroundJobs()).toBe(true);
  });
});

describe("bash tool — sleep-poll guard", () => {
  async function run(bash: BashTool, command: string): Promise<string> {
    const t = createBuiltinTools(bash, "agent").bash as unknown as { execute: (i: unknown) => Promise<unknown> };
    return String(await t.execute({ command, timeout: 10_000 }));
  }

  it("refuses a long sleep while a background job is running", async () => {
    const bash = makeBash();
    bash.setBackgroundJobProbe(async () => true);
    const out = await run(bash, "sleep 120; cat results.txt");
    expect(out).toMatch(/Refused/);
    expect(out).toMatch(/End your turn/);
  });

  it("allows the same sleep when nothing runs in the background", async () => {
    const bash = makeBash();
    const out = await run(bash, "sleep 0.1 && echo slept");
    expect(out).toContain("slept");
    // No background jobs → even a long sleep is not this guard's business.
    bash.setBackgroundJobProbe(async () => false);
    expect(await run(bash, "echo fine")).toContain("fine");
  });

  it("allows a short sleep (waiting for a server to bind) while jobs run", async () => {
    const bash = makeBash();
    bash.setBackgroundJobProbe(async () => true);
    expect(await run(bash, "sleep 1 && echo up")).toContain("up");
  });
});
