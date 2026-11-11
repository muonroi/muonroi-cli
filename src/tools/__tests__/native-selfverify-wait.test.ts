import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { JobManager } from "../../mcp/self-verify-jobs.js";
import { isInteractivePaused } from "../../orchestrator/interactive-pause.js";

const control = vi.hoisted(() => ({ resolve: (_report: unknown) => {} }));
const jm = vi.hoisted(() => ({ current: null as JobManager | null }));

vi.mock("../../mcp/self-verify-runner.js", () => ({
  getSelfVerifyJobManager: () => {
    jm.current ??= new JobManager({
      tier1: () =>
        new Promise((resolve) => {
          control.resolve = resolve as (report: unknown) => void;
        }) as never,
      agentic: () => new Promise(() => {}) as never,
    });
    return jm.current;
  },
}));

const { registerNativeMuonroiTools } = await import("../native-tools.js");

describe("native selfverify tools deliver completion instead of polling", () => {
  const tools = registerNativeMuonroiTools({} as ToolSet, { cwd: process.cwd() }) as Record<string, any>;

  it("start's description no longer tells the model to poll selfverify_status", () => {
    expect(tools.selfverify_start.description).not.toMatch(/poll selfverify_status,/);
    expect(tools.selfverify_start.description).toContain("completion notice");
    expect(tools.selfverify_result.description).toContain("waits");
  });

  it("selfverify_result host-waits a running run (watchdogs paused) and returns its report", async () => {
    const { runId } = JSON.parse(await tools.selfverify_start.execute({ mode: "tier1", files: ["src/a.ts"] }, {}));
    const pending = tools.selfverify_result.execute({ runId }, { abortSignal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isInteractivePaused()).toBe(true);
    control.resolve({ summary: { passed: 4 } });
    expect(JSON.parse(await pending)).toEqual({ summary: { passed: 4 } });
    expect(isInteractivePaused()).toBe(false);
    // The caller already read the outcome: no duplicate completion notice.
    expect(jm.current!.consumeCompletionNotices()).toEqual([]);
  });

  it("a bounded wait that ends while the run continues reports still_running", async () => {
    const { runId } = JSON.parse(await tools.selfverify_start.execute({ mode: "tier1", files: ["src/b.ts"] }, {}));
    expect(await tools.selfverify_result.execute({ runId, waitMs: 5 }, {})).toMatch(/^ERROR still_running/);
    control.resolve({ summary: { passed: 1 } });
    await jm.current!.waitFor(runId);
    const notices = jm.current!.consumeCompletionNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`runId=${runId}`);
  });
});
