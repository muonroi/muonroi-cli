/**
 * tests/harness/native-delegation-guards.spec.ts
 *
 * Orchestration rules that moved from prompt prose into host enforcement
 * (feat/native-delegation-guards), driven end-to-end through the real TUI with
 * the mock LLM:
 *
 * 1. Reading a RUNNING job returns a refusal, not content; the orchestrator is
 *    then woken with the finished result inline, and the host — not a
 *    model-called delegation_ack — acknowledges it once that turn completes
 *    (DelegationManager.acknowledgeProcessed). delegation_ack is not offered.
 * 2. An edit-capable `task` without writeScope (and without sharedExecution) is
 *    refused before any worker starts (workerWriteScopeRequiredError).
 * 3. The recorded orchestrator request offers task/delegate with `modelId` as an
 *    enum built from the live worker inventory, plus the structured `brief`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { completeDelegation } from "../../src/orchestrator/delegations.js";
import { type CostLeakHarness, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { spawnHarness } from "./helpers.js";
import { type InspectedCall, isMainAgentCall, loadDumpedRecordings, loadWorkerDumpedRecordings } from "./recording.js";

const MODEL = "deepseek-v4-flash";
const SENTINEL = "GUARDS-RESULT-SENTINEL-41c9";
const WAIT_TEXT = "GUARDS-WAIT worker still running";
const REPLY = "GUARDS-REPLY parser accepted";
const REFUSED_TEXT = "GUARDS-SCOPE refusal noted";

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}

function textRound(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
  ];
}

function toolRound(callId: string, toolName: string, input: Record<string, unknown>): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: callId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
  ];
}

const promptText = (call: InspectedCall) => JSON.stringify(call.options.prompt);

function offeredTool(call: InspectedCall, name: string): { inputSchema?: any } | undefined {
  return (call.options.tools as Array<{ name: string; inputSchema?: unknown }> | undefined)?.find(
    (tool) => tool.name === name,
  ) as { inputSchema?: any } | undefined;
}

function toolCallNames(call: InspectedCall): string[] {
  const names: string[] = [];
  for (const message of call.options.prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type: string; toolName?: string }>)
      if (part.type === "tool-call" && part.toolName) names.push(part.toolName);
  }
  return names;
}

function mainCalls(dumpPath: string): InspectedCall[] {
  if (!existsSync(dumpPath)) return [];
  try {
    return loadDumpedRecordings(dumpPath).filter(isMainAgentCall);
  } catch (err) {
    // The child rewrites the dump after every call; a torn read retries.
    console.warn(`[native-delegation-guards] dump not readable yet: ${String(err)}`);
    return [];
  }
}

it("refuses a running read, wakes with the inline result and host-ACKs it without delegation_ack", async () => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-guards-ack-"));
  const fixDir = join(home, "fix");
  mkdirSync(fixDir, { recursive: true });
  const jobId = "brisk-teal-otter";
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({
      responses: [{ match: "*", text: REPLY }],
      model: {
        provider: "deepseek",
        modelId: MODEL,
        stream: [toolRound("read-1", "delegation_read", { id: jobId }), textRound(WAIT_TEXT), textRound(REPLY)],
      },
    }),
    "utf8",
  );
  const dumpPath = join(home, "calls.json");
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/inline-completion-entry.ts"),
    cwd: home,
    fixturesDir: fixDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", MODEL],
    env: {
      MUONROI_INLINE_COMPLETION_HOME: home,
      MUONROI_INLINE_COMPLETION_JOB: jobId,
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
    const seeded = JSON.parse(readFileSync(join(home, "inline-session.json"), "utf8")) as { jobsDir: string };
    const jobPath = join(seeded.jobsDir, `${jobId}.json`);

    ctx.driver.type("check whether the parser worker has finished and report its result");
    ctx.driver.press("Enter");

    // The read of the running job comes back as a refusal, not content.
    let afterRead: InspectedCall | undefined;
    await expect
      .poll(
        () => {
          afterRead = mainCalls(dumpPath).find((call) => promptText(call).includes("delegation_running"));
          return afterRead !== undefined;
        },
        { timeout: 60_000, interval: 250 },
      )
      .toBe(true);
    expect(promptText(afterRead!)).toContain("you will be woken with its result on completion");
    expect(promptText(afterRead!)).not.toContain(SENTINEL);
    await ctx.driver.wait_for({ visualText: WAIT_TEXT, timeoutMs: 30_000 });

    // The worker finishes; the idle tick delivers the result inline and wakes main.
    await completeDelegation(jobPath, `Parser implemented at src/parser.ts:1-40. ${SENTINEL}`);
    let woken: InspectedCall | undefined;
    await expect
      .poll(
        () => {
          woken = mainCalls(dumpPath).find((call) => promptText(call).includes(SENTINEL));
          return woken !== undefined;
        },
        { timeout: 60_000, interval: 250 },
      )
      .toBe(true);
    expect(promptText(woken!)).toContain("no delegation_read needed");
    expect(promptText(woken!)).not.toContain("delegation_ack");
    await ctx.driver.wait_for({ visualText: REPLY, timeoutMs: 30_000 });

    // The host acknowledges the processed result after that turn.
    await expect
      .poll(
        () => {
          const record = JSON.parse(readFileSync(jobPath, "utf8")) as {
            acknowledgedVersion?: string;
            resultVersion?: string;
          };
          return !!record.resultVersion && record.acknowledgedVersion === record.resultVersion;
        },
        { timeout: 30_000, interval: 250 },
      )
      .toBe(true);

    const calls = mainCalls(dumpPath);
    for (const call of calls) {
      expect(toolCallNames(call)).not.toContain("delegation_ack");
      expect(offeredTool(call, "delegation_ack")).toBeUndefined();
    }
    expect(offeredTool(calls[0]!, "delegation_read")).toBeDefined();
  } catch (err) {
    console.error(
      `native-delegation-guards (ack): ${err instanceof Error ? err.message : String(err)}\n${ctx.driver.render_text()}`,
    );
    throw err;
  } finally {
    ctx.proc.kill();
    await new Promise<void>((resolveExit) => {
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) resolveExit();
      else ctx.proc.once("exit", () => resolveExit());
    });
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/native-delegation-guards.spec.ts");
  }
}, 180_000);

it("refuses an edit task without writeScope before any worker starts; modelId is the live-inventory enum", async () => {
  let handle: CostLeakHarness | null = null;
  try {
    handle = await spawnCostLeakHarness(
      {
        provider: "deepseek",
        modelId: MODEL,
        stream: [
          toolRound("task-1", "task", {
            agent: "general",
            description: "edit the parser",
            prompt: "Edit src/parser.ts to handle empty input.",
            modelId: MODEL,
            background: false,
          }),
          textRound(REFUSED_TEXT),
        ],
      },
      {
        permission: "auto-edit",
        projectFiles: { "src/parser.ts": "export const parse = (s: string) => s;\n" },
        env: { MUONROI_EE_BASE_URL: "http://127.0.0.1:1" },
      },
    );
    handle.driver.type("please edit the parser source file to handle empty input using a worker");
    handle.driver.press("Enter");

    let refusedCall: InspectedCall | undefined;
    await expect
      .poll(
        () => {
          refusedCall = mainCalls(handle!.dumpPath).find((call) =>
            promptText(call).includes("worker_write_scope_required"),
          );
          return refusedCall !== undefined;
        },
        { timeout: 90_000, interval: 250 },
      )
      .toBe(true);
    const text = promptText(refusedCall!);
    expect(text).toContain("No worker was started");
    expect(text).toContain("sharedExecution:true");
    await handle.driver.wait_for({ visualText: REFUSED_TEXT, timeoutMs: 30_000 });
    expect(loadWorkerDumpedRecordings(handle.dumpPath)).toHaveLength(0);

    // The request that dispatched offered modelId as an enum of the live inventory.
    const first = mainCalls(handle.dumpPath)[0]!;
    const taskSchema = offeredTool(first, "task")?.inputSchema;
    expect(Array.isArray(taskSchema?.properties?.modelId?.enum)).toBe(true);
    expect(taskSchema.properties.modelId.enum).toContain(MODEL);
    expect(taskSchema.properties.brief?.required).toEqual([
      "role",
      "scope",
      "input",
      "question",
      "exclusions",
      "budget",
      "evidence",
    ]);
    expect(taskSchema.properties.sharedExecution?.type).toBe("boolean");
    expect(offeredTool(first, "delegate")?.inputSchema?.properties?.modelId?.enum).toEqual(
      taskSchema.properties.modelId.enum,
    );
  } catch (err) {
    console.error(
      `native-delegation-guards (scope): ${err instanceof Error ? err.message : String(err)}\n${handle?.driver.render_text() ?? ""}`,
    );
    throw err;
  } finally {
    handle?.cleanup();
  }
}, 180_000);
