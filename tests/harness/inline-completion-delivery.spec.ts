/**
 * tests/harness/inline-completion-delivery.spec.ts
 *
 * A finished background worker's result must reach the orchestrator inside the
 * completion notice, so the orchestrator does not spend a model step on
 * delegation_read. Measured before the change (session 4edc02516a92): 88 of 720
 * orchestrator tool steps were a lone full delegation_read, 69 of them directly
 * after a completion notice that carried only a one-line summary.
 *
 * Flow: the entry fixture resumes a main session that has just dispatched one
 * worker (task call + receipt + running job record). The spec finishes that
 * worker on disk exactly as a worker process does (completeDelegation). The
 * TUI's own idle tick claims the notice and auto-wakes the orchestrator, whose
 * mock-model request is recorded and asserted:
 *   - the worker's result text is in the prompt exactly once (the wake prompt
 *     no longer repeats the inline body);
 *   - no delegation_read tool call exists anywhere in the request;
 *   - the orchestrator contract is sent once (it used to be sent twice);
 *   - the job is delivered (deliveredVersion === resultVersion) without a read.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { completeDelegation } from "../../src/orchestrator/delegations.js";
import { spawnHarness } from "./helpers.js";
import { type InspectedCall, loadDumpedRecordings } from "./recording.js";

const SENTINEL = "WORKER-RESULT-SENTINEL-7f3a";
const REPLY = "ORCH-REPLY parser landed";
// First line of the contract; present once per orchestrator request.
const CONTRACT_MARK = "You are the main orchestrator";

function textStream(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    },
  ];
}

function promptText(call: InspectedCall): string {
  return JSON.stringify(call.options.prompt);
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function toolCallNames(call: InspectedCall): string[] {
  const names: string[] = [];
  for (const message of call.options.prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type: string; toolName?: string }>) {
      if (part.type === "tool-call" && part.toolName) names.push(part.toolName);
    }
  }
  return names;
}

it("delivers a finished worker's result inline so the orchestrator never calls delegation_read", async () => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-inline-completion-"));
  const fixDir = join(home, "fix");
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({ responses: [{ match: "*", text: REPLY }], model: { stream: [textStream(REPLY)] } }),
    "utf8",
  );
  const dumpPath = join(home, "calls.json");
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/inline-completion-entry.ts"),
    cwd: home,
    fixturesDir: fixDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
    env: {
      MUONROI_INLINE_COMPLETION_HOME: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_ROUTER_SUB_SESSION: "0",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_FLOW_ASSESSOR: "0",
      MUONROI_NO_SHELL_HOLD: "1",
    },
  });
  try {
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 60_000 });
    const seeded = JSON.parse(readFileSync(join(home, "inline-session.json"), "utf8")) as {
      jobId: string;
      jobsDir: string;
    };
    const jobPath = join(seeded.jobsDir, `${seeded.jobId}.json`);

    // The worker finishes: same writer a worker process uses.
    await completeDelegation(
      jobPath,
      `Parser implemented.\nChanged src/parser.ts:1-40. ${SENTINEL}\nTests: parser.test.ts 3/3 passed.`,
    );

    // The idle tick claims the notice and wakes the orchestrator; wait for the
    // recorded request that carries the worker's result.
    let carrying: InspectedCall | undefined;
    await expect
      .poll(
        () => {
          if (!existsSync(dumpPath)) return false;
          try {
            // Only the orchestrator's own request counts; auxiliary calls (PIL
            // classify, compaction proposer) also see the transcript.
            carrying = loadDumpedRecordings(dumpPath).find(
              (call) => call.systemText.includes(CONTRACT_MARK) && promptText(call).includes(SENTINEL),
            );
          } catch (err) {
            // The child rewrites the dump after every call; a torn read retries.
            console.warn(`[inline-completion] dump not readable yet: ${String(err)}`);
            return false;
          }
          return carrying !== undefined;
        },
        { timeout: 60_000, interval: 250 },
      )
      .toBe(true);
    await ctx.driver.wait_for({ visualText: REPLY, timeoutMs: 30_000 });

    const call = carrying!;
    const text = promptText(call);
    expect(countOf(text, SENTINEL)).toBe(1);
    expect(text).toContain("no delegation_read needed");
    expect(countOf(text, CONTRACT_MARK)).toBe(1);

    const calls = loadDumpedRecordings(dumpPath);
    for (const recorded of calls) expect(toolCallNames(recorded)).not.toContain("delegation_read");

    const record = JSON.parse(readFileSync(jobPath, "utf8")) as { deliveredVersion?: string; resultVersion?: string };
    expect(record.resultVersion).toBeTruthy();
    expect(record.deliveredVersion).toBe(record.resultVersion);
  } catch (err) {
    console.error(
      `inline completion spec: ${err instanceof Error ? err.message : String(err)}\n${ctx.driver.render_text()}`,
    );
    throw err;
  } finally {
    ctx.proc.kill();
    await new Promise<void>((resolveExit) => {
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) resolveExit();
      else ctx.proc.once("exit", () => resolveExit());
    });
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/inline-completion-delivery.spec.ts");
  }
}, 150_000);
