import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog, MODELS } from "../../models/registry.js";
import { closeDatabase } from "../../storage/db.js";
import { appendMessages, loadRawTranscript } from "../../storage/transcript.js";
import * as settings from "../../utils/settings.js";
import { Agent } from "../orchestrator.js";
import { RequestHistory } from "../request-history.js";

vi.mock("../../pil/pipeline.js", () => ({ runPipeline: () => new Promise(() => {}) }));
vi.mock("../../ee/intercept.js", async (original) => ({
  ...(await original<typeof import("../../ee/intercept.js")>()),
  getDefaultEEClient: () => ({
    promptStale: async () => null,
    extract: async () => null,
    routeFeedback: async () => null,
  }),
}));

it.each([
  "reuse",
  "preserve",
  "keep",
  "invalidate",
])("replays compacted history with %s behavior on the next user turn", async (scenario) => {
  await loadCatalog();
  const chosen = MODELS.find(
    (row) =>
      row.tier === "premium" &&
      row.provider &&
      row.contextWindow >= 128000 &&
      row.supportsClientTools !== false &&
      !row.id.startsWith("claude"),
  );
  if (!chosen) throw new Error("No eligible non-Claude catalog fixture");
  const cwd = process.cwd(),
    home = mkdtempSync(join(tmpdir(), "cross-turn-history-"));
  const env = {
    HOME: home,
    USERPROFILE: home,
    MUONROI_CLI_HOME: home,
    MUONROI_AUTH_DIR: join(home, "auth"),
    MUONROI_ENV_FILE: join(home, ".env"),
    MUONROI_FLOW_NATIVE: "0",
    MUONROI_PROGRESSIVE_CONTEXT: "1",
    MUONROI_SILENT_ROTATION_THRESHOLD: "10000000",
    MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS: "10000",
    MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST: "1",
    MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  process.chdir(home);
  closeDatabase();
  mkdirSync(join(home, ".muonroi-cli"), { recursive: true });
  writeFileSync(
    join(home, ".muonroi-cli/settings.json"),
    JSON.stringify({ routerSubSessions: false, peakHourPolicy: { enabled: false } }),
  );
  vi.spyOn(settings, "isModelDisabled").mockImplementation((id) => id !== chosen.id);
  vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
  const project = vi.spyOn(RequestHistory.prototype, "project");
  const streams = [
    toolCallStream({ toolCallId: "inspect-models", toolName: "worker_models", input: {} }),
    textOnlyStream("FIRST_TURN_DONE"),
    textOnlyStream("SECOND_TURN_DONE"),
  ];
  const handle = installMockModel({ fixture: { autoClassify: true, stream: streams } });
  const agent = new Agent("fixture-key", undefined, chosen.id, 5, {
    executionRole: "orchestrator",
    persistSession: true,
    permissionMode: "yolo",
  });
  const source: ModelMessage[] = [];
  for (let n = 0; n < 12; n++)
    source.push(
      { role: "user", content: `Completed historical task ${n}` },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: `old-${n}`, toolName: "fixture_read", input: { file: `file-${n}` } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `old-${n}`,
            toolName: "fixture_read",
            output: { type: "text", value: `HISTORICAL_PAYLOAD_${n} ` + "old evidence ".repeat(1500) },
          },
        ],
      },
      { role: "assistant", content: `Closed historical task ${n}` },
    );
  const state = agent as unknown as { messages: ModelMessage[]; messageSeqs: number[] };
  state.messages = source;
  state.messageSeqs = appendMessages(agent.getSessionId()!, source);
  try {
    for await (const chunk of agent.processMessage("Inspect eligible models and summarize this completed audit"))
      expect(chunk.type).not.toBe("error");
    const firstCalls = handle.model.doStreamCalls.filter((call) => call.tools?.some((t) => t.name === "worker_models"));
    expect(firstCalls).toHaveLength(2);
    // The history is over the threshold when the turn starts, so it is
    // compacted BEFORE step 0 (compact-at-turn-start) rather than sent raw and
    // rewritten on step 1 — and step 1 extends step 0's prefix.
    const rawChars = JSON.stringify(source).length;
    const compactChars = JSON.stringify(firstCalls[1]!.prompt).length;
    expect(JSON.stringify(firstCalls[0]!.prompt).length).toBeLessThan(rawChars / 2);
    expect(compactChars).toBeLessThan(rawChars / 2);
    const step0 = firstCalls[0]!.prompt;
    expect(firstCalls[1]!.prompt.slice(0, step0.length - 1)).toEqual(step0.slice(0, step0.length - 1));
    if (scenario === "preserve" || scenario === "keep") {
      const directive = scenario === "preserve" ? "PRESERVE_FULL_CONTEXT" : "KEEP_TOOL_IDS: old-0";
      const step = toolCallStream({ toolCallId: "inspect-after-preserve", toolName: "worker_models", input: {} });
      step.splice(1, 0, ...textOnlyStream(directive).slice(1, -1));
      streams.splice(2, 1, step, textOnlyStream("PRESERVATION_DONE"));
    }
    if (scenario === "invalidate") state.messages[0] = { role: "user", content: "Changed historical request" };
    for await (const chunk of agent.processMessage("Continue coordinating the completed audit"))
      expect(chunk.type).not.toBe("error");
    const calls = handle.model.doStreamCalls.filter((call) => call.tools?.some((t) => t.name === "worker_models"));
    const nextChars = JSON.stringify(calls.at(-1)!.prompt).length;
    console.info("cross-turn request history chars", JSON.stringify({ rawChars, compactChars, nextChars }));
    if (scenario === "reuse") expect(nextChars).toBeLessThan(rawChars / 2);
    if (scenario === "preserve") expect(nextChars).toBeGreaterThan(rawChars / 2);
    // An invalidated replay is not used: turn 2 starts from the changed canonical
    // history (and, being over the threshold, is compacted fresh before step 0).
    const lastProjection = project.mock.results.at(-1)?.value as { savedChars: number } | undefined;
    if (scenario === "invalidate") expect(lastProjection?.savedChars).toBe(0);
    if (scenario === "reuse") expect(lastProjection?.savedChars).toBeGreaterThan(0);
    if (scenario === "keep")
      expect(JSON.stringify(calls.at(-1)!.prompt)).toContain(`HISTORICAL_PAYLOAD_0 ${"old evidence ".repeat(100)}`);
    const compactPrompt = firstCalls[1]!.prompt;
    const boundary = compactPrompt.findIndex(
      (message) => message.role === "user" && JSON.stringify(message.content).includes("Inspect eligible models"),
    );
    expect(boundary).toBeGreaterThan(0);
    if (scenario === "reuse") expect(calls.at(-1)!.prompt.slice(0, boundary)).toEqual(compactPrompt.slice(0, boundary));
    if (scenario === "reuse" && process.env.MUONROI_CACHE_EVIDENCE_PATH)
      writeFileSync(
        process.env.MUONROI_CACHE_EVIDENCE_PATH,
        JSON.stringify({ rawChars, compactChars, nextChars, stablePrefixMessages: boundary }),
      );
    expect(JSON.stringify(loadRawTranscript(agent.getSessionId()!))).toContain("HISTORICAL_PAYLOAD_0");
    expect(JSON.stringify(state.messages)).toContain("HISTORICAL_PAYLOAD_0");
  } finally {
    await agent.cleanup();
    handle.uninstall();
    closeDatabase();
    vi.restoreAllMocks();
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 30000);
