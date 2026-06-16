/**
 * src/mcp/self-verify-runner.ts
 *
 * The default self-verify Runner (drives runSelfVerify / runAgenticLoop in
 * process) plus a process-shared JobManager singleton. Shared by BOTH surfaces:
 * the native in-CLI selfverify_* builtins (src/tools/native-tools.ts) and the
 * muonroi-tools MCP server (src/mcp/tools-server.ts, for external agents) — so a
 * run started on either surface is visible to both, and there is one job space.
 */

import { JobManager, type Runner } from "./self-verify-jobs.js";

/** Default runner: drives the real self-verify functions in-process. */
export const defaultRunner: Runner = {
  async tier1(opts, log) {
    // signal intentionally not forwarded: runSelfVerify/runAgenticLoop do not yet
    // accept an AbortSignal. cancel() marks the job and discards the late result.
    const { runSelfVerify } = await import("../self-qa/index.js");
    return runSelfVerify({
      baseRef: opts.since,
      maxScenarios: opts.max,
      emitSpecs: opts.emit,
      specOutDir: opts.out,
      log,
    });
  },
  async agentic(opts, log) {
    const { createLLMBrain, runAgenticLoop } = await import("../self-qa/agentic-loop.js");
    const brain = await createLLMBrain({ modelId: opts.llm });
    return runAgenticLoop({ goal: opts.goal, brain, maxTurns: opts.turns ?? 20, log });
  },
};

let shared: JobManager | null = null;

/** Process-shared self-verify JobManager (created lazily on first use). */
export function getSelfVerifyJobManager(): JobManager {
  if (!shared) shared = new JobManager(defaultRunner);
  return shared;
}
