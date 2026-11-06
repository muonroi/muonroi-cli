import { afterEach, describe, expect, it, vi } from "vitest";
import { groundWorkerResult } from "../stream-runner.js";
import { outcomesFromMessages } from "../verification-claims.js";
import {
  applyWorkerGrounding,
  assessWorkerAnswer,
  parseWorkerGroundingReports,
  surfaceWorkerGrounding,
  WORKER_GROUNDING_TAG,
  WorkerEvidence,
} from "../worker-grounding.js";

function evidenceWith(...calls: Array<[string, string, unknown, string]>): WorkerEvidence {
  const evidence = new WorkerEvidence();
  for (const [id, tool, input, output] of calls) evidence.observe(id, tool, input, output);
  return evidence;
}

const request = (prompt = "do the task") => ({
  agent: "general",
  description: "d",
  prompt,
  artifactJobPath: "/tmp/delegations/brave-blue-owl.json",
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
});

describe("worker grounding", () => {
  it("flags 'all tests pass' when the worker recorded no test run", () => {
    const evidence = evidenceWith(["r1", "read_file", { file_path: "a.ts" }, "[a.ts: lines 1-10 of 10]\n..."]);
    const report = assessWorkerAnswer("Implemented the parser. All tests pass.", evidence);
    expect(report?.verification).toMatchObject([{ kind: "test", polarity: "pass" }]);
  });

  it("supports the claim when the worker's own bash test run passed", () => {
    const evidence = evidenceWith(["b1", "bash", { command: "bunx vitest run" }, "Test Files 3 passed (3)"]);
    expect(assessWorkerAnswer("All tests pass.", evidence)).toBeNull();
  });

  it("does not flag numbers the assignment itself supplied", () => {
    const evidence = evidenceWith(["r1", "read_file", {}, "contents"]);
    expect(assessWorkerAnswer("Updated the 42 files listed.", evidence, "Update these 42 files")).toBeNull();
    expect(assessWorkerAnswer("Updated the 42 files listed.", evidence)?.unverified).toMatchObject([{ kind: "count" }]);
  });

  it("wraps tools without changing their results and records what really executed", async () => {
    const evidence = new WorkerEvidence();
    const tools = evidence.wrap({
      bash: { execute: async () => "ERROR: exit 1" } as never,
      noop: { description: "no execute" } as never,
    });
    const out = await (tools.bash as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(
      { command: "npm test" },
      { toolCallId: "x1" },
    );
    expect(out).toBe("ERROR: exit 1");
    expect(evidence.verifications()).toMatchObject([{ id: "x1:test", passed: false }]);
    expect(tools.noop).toEqual({ description: "no execute" });
  });

  it("folds a flag line, a structured report and a host verification record into the result", () => {
    const evidence = evidenceWith(["b1", "bash", { command: "bunx tsc --noEmit" }, ""]);
    const report = assessWorkerAnswer("All tests pass.", evidence);
    const result = applyWorkerGrounding(
      { success: true, output: "All tests pass." },
      report,
      evidence.verifications(),
      "worker j1",
    );
    expect(result.success).toBe(true);
    expect(result.output!.startsWith("[host] Grounding check:")).toBe(true);
    expect(result.output).toContain("All tests pass.");
    expect(parseWorkerGroundingReports(result.output!)).toHaveLength(1);
    // The orchestrator can ground later claims on the worker's recorded build run.
    expect(outcomesFromMessages([{ role: "system", content: result.output }])).toMatchObject([
      { kind: "build", passed: true, source: "worker j1" },
    ]);
  });

  it("leaves JSON deliverables and unflagged, run-less results untouched", () => {
    const json = { success: true, output: '{"verdict":"pass"}' };
    expect(applyWorkerGrounding(json, { v: 1, verification: [], unverified: [] }, [], "w")).toBe(json);
    const plain = { success: true, output: "Read the notes." };
    expect(applyWorkerGrounding(plain, null, [], "w")).toBe(plain);
  });

  it("groundWorkerResult: only completed delegated workers are grounded; the env flag disables it", () => {
    const evidence = evidenceWith(["r1", "read_file", {}, "x"]);
    const prepared = { workerEvidence: evidence, request: request() } as never;
    const grounded = groundWorkerResult({ success: true, output: "Build succeeded." }, prepared);
    expect(grounded.output).toContain(WORKER_GROUNDING_TAG);
    const withRun = {
      workerEvidence: evidenceWith(["b1", "bash", { command: "bunx tsc --noEmit" }, ""]),
      request: request(),
    } as never;
    // The host verification record names the job, so main can attribute the run.
    expect(groundWorkerResult({ success: true, output: "Build succeeded." }, withRun).output).toContain(
      '"source":"worker brave-blue-owl"',
    );
    const failed = { success: false, output: "Task failed: x. All tests pass." };
    expect(groundWorkerResult(failed, prepared)).toBe(failed);
    expect(groundWorkerResult({ success: true, output: "ok" }, { request: request() } as never).output).toBe("ok");
    vi.stubEnv("MUONROI_DISABLE_GROUNDING_CHECK", "1");
    expect(groundWorkerResult({ success: true, output: "Build succeeded." }, prepared).output).not.toContain(
      WORKER_GROUNDING_TAG,
    );
  });

  it("surfaces each report once to the TUI as grounding-flag + warn toast", () => {
    const events: Array<Record<string, unknown>> = [];
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent: (e: never) => events.push(e) };
    const evidence = evidenceWith(["r1", "read_file", {}, "x"]);
    const output = applyWorkerGrounding(
      { success: true, output: "All tests pass." },
      assessWorkerAnswer("All tests pass.", evidence),
      [],
      "worker quick-red-fox",
    ).output!;
    const notice = `Background agent complete: \`quick-red-fox\`\n${output}`;
    expect(surfaceWorkerGrounding(notice)).toBe(1);
    expect(surfaceWorkerGrounding(notice)).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(["grounding-flag", "toast"]);
    expect(String((events[0]!.claims as string[])[0])).toContain("worker quick-red-fox");
  });
});
