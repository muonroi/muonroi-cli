import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels, registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { installMockModel, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import * as modelRuntime from "../../providers/runtime.js";
import { closeDatabase, getDatabase, getDatabasePath } from "../../storage/db.js";
import {
  appendCompaction,
  appendMessages,
  buildChatEntries,
  loadLatestCompaction,
  loadRawTranscript,
  loadTranscriptState,
} from "../../storage/transcript.js";
import { estimateConversationTokens } from "../compaction.js";
import { WorkingContext } from "../working-context.js";

const captured = vi.hoisted(() => ({
  proposer: vi.fn(async () => null),
  summary: vi.fn(async (_model: string, _preparation: unknown) => ({
    summary: "FALLBACK_CHECKPOINT",
    usage: { promptTokens: 10, completionTokens: 5 },
  })),
}));
vi.mock("../compaction.js", async (original) => ({
  ...(await original<typeof import("../compaction.js")>()),
  proposeCompaction: captured.proposer,
  generateCompactionSummary: captured.summary,
}));
vi.mock("../../ee/intercept.js", async (original) => ({
  ...(await original<typeof import("../../ee/intercept.js")>()),
  getDefaultEEClient: () => ({
    promptStale: async () => null,
    extract: async () => null,
    routeFeedback: async () => null,
  }),
}));

import { Agent } from "../orchestrator.js";

let home: string;
beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});
beforeEach(() => {
  closeDatabase();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "working-context-compact-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("MUONROI_CLI_HOME", home);
  expect(getDatabasePath()).toBe(path.join(home, ".muonroi-cli", "muonroi.db"));
  vi.stubEnv("MUONROI_PROGRESSIVE_CONTEXT", "1");
  vi.stubEnv("MUONROI_EE_BASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("MUONROI_DISABLE_GROUNDING_CHECK", "1");
  vi.stubEnv("MUONROI_SILENT_ROTATION_THRESHOLD", "10000000");
  captured.proposer.mockClear();
  captured.summary.mockClear();
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function fixture(archiveHistory = true) {
  const agent = new Agent("fixture-key", undefined, getTestModels().premium, 3, {
    persistSession: true,
    executionRole: "infrastructure",
  });
  const a = agent as any;
  vi.spyOn(a.bash, "getCwd").mockReturnValue(home);
  const source: ModelMessage[] = [];
  for (let i = 0; i < 12; i++)
    source.push(
      { role: "user", content: `Closed task ${i}` },
      { role: "assistant", content: `STALE_TASK_${i} ${"old log ".repeat(1500)}` },
    );
  source.push({ role: "user", content: "CURRENT_TASK" });
  const w = new WorkingContext(agent.getSessionId()!, home, source);
  const archive = [0, 8].flatMap((offset) =>
    w
      .inspect(offset)
      .turns.filter((t) => !t.protected.length)
      .map((t) => ({ turn_id: t.id, reason: "Completed unrelated task" })),
  );
  const receipt = w.update({
    action: "update",
    expected_revision: 0,
    task_id: "current",
    goal: "Only current work",
    decisions: ["CURRENT_DECISION"],
    open_items: ["UNRESOLVED_CURRENT_FAILURE"],
    archive: archiveHistory ? archive : [],
  });
  expect(receipt).not.toHaveProperty("error");
  source.push(
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolName: "context_load", toolCallId: "working-select", input: { topic: "working_set" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "context_load",
          toolCallId: "working-select",
          output: { type: "text", value: JSON.stringify(receipt) },
        },
      ],
    },
  );
  a.messages = source;
  a.messageSeqs = appendMessages(agent.getSessionId()!, source);
  return { agent, a, source, receipt };
}

describe("pruning before narrative compaction", () => {
  it.each([false, true])("bounds actual SDK overflow recovery with protectedHistory=%s", async (protectedHistory) => {
    const { agent, a, source } = await fixture(false);
    const previousCwd = process.cwd();
    fs.mkdirSync(path.join(home, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".muonroi-cli/settings.json"),
      JSON.stringify({ routerSubSessions: false, routingMode: "fixed", model: getTestModels().premium }),
    );
    process.chdir(home);
    // History + system fits, while schemas + the unchanged output reserve do not.
    const contextWindow = estimateConversationTokens("system", source) + 20000;
    const resolveRuntime = modelRuntime.resolveModelRuntime;
    vi.spyOn(modelRuntime, "resolveModelRuntime").mockImplementation((...args) => {
      const runtime = resolveRuntime(...args);
      return { ...runtime, modelInfo: { ...runtime.modelInfo!, contextWindow } };
    });
    vi.spyOn(a, "getCompactionSettings").mockReturnValue({ reserveTokens: 1000, keepRecentTokens: 200 });
    const compact = vi.spyOn(a, "compactForContext");
    if (protectedHistory) for (const seq of a.messageSeqs) a._pinnedSeqs.add(seq);
    const handle = installMockModel({
      fixture: { autoClassify: true, stream: textOnlyStream("RECOVERED_CONTEXT_FINAL") },
    });
    try {
      const chunks = [];
      for await (const chunk of agent.processMessage("Continue CURRENT_TASK using the existing evidence."))
        chunks.push(chunk);
      const events = getDatabase()
        .prepare("SELECT metadata_json FROM interaction_logs WHERE session_id=? AND event_type='prompt_breakdown'")
        .all(agent.getSessionId()) as { metadata_json: string }[];
      const blocked = events
        .map((row) => JSON.parse(row.metadata_json))
        .map((meta) => meta.data ?? meta)
        .filter((data) => data.contextBudgetBlocked === 1);
      expect(
        blocked.length,
        JSON.stringify({
          errors: chunks.filter((c) => c.type === "error"),
          measured: events.map((row) => {
            const m = JSON.parse(row.metadata_json);
            return { input: m.estimatedInputTokens, window: m.contextWindowTokens, reserve: m.reservedOutputTokens };
          }),
        }),
      ).toBe(protectedHistory ? 2 : 1);
      expect(blocked[0].requestPhase).toBe("preflight");
      expect(blocked[0].estimatedInputTokens + blocked[0].reservedOutputTokens).toBeGreaterThan(
        blocked[0].contextWindowTokens,
      );
      expect(compact.mock.calls.filter((call) => call[5] === true)).toHaveLength(1);
      expect(captured.summary).toHaveBeenCalled();
      const mainCalls = handle.model.doStreamCalls.filter((call) => call.tools?.length);
      if (protectedHistory) {
        expect(mainCalls).toHaveLength(0);
        expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
      } else {
        expect(mainCalls).toHaveLength(1);
        expect(JSON.stringify(mainCalls[0].prompt)).toContain("CURRENT_TASK");
        expect(JSON.stringify(mainCalls[0].prompt)).toContain("UNRESOLVED_CURRENT_FAILURE");
        expect(JSON.stringify(mainCalls[0].prompt)).not.toContain("STALE_TASK_0");
        expect(mainCalls[0].maxOutputTokens).toBe(blocked[0].reservedOutputTokens);
        expect(
          chunks
            .filter((chunk) => chunk.type === "content")
            .map((chunk) => chunk.content)
            .join(""),
        ).toContain("RECOVERED_CONTEXT_FINAL");
      }
      expect(JSON.stringify(loadRawTranscript(agent.getSessionId()!))).toContain("STALE_TASK_0");
    } finally {
      handle.uninstall();
      process.chdir(previousCwd);
      vi.restoreAllMocks();
      await agent.cleanup();
    }
  }, 20000);
  it("honors forced overflow recovery when an active working set archives nothing", async () => {
    const { agent, a } = await fixture(false);
    try {
      await a.compactForContext(
        "fixture",
        "system",
        100000,
        new AbortController().signal,
        { reserveTokens: 1000, keepRecentTokens: 200 },
        true,
      );
      expect(captured.summary).toHaveBeenCalledOnce();
      expect(JSON.stringify(a.messages)).toContain("CURRENT_TASK");
      expect(JSON.stringify(a.messages)).toContain("UNRESOLVED_CURRENT_FAILURE");
    } finally {
      await agent.cleanup();
    }
  });
  it("reduces the request without proposer/summary calls or canonical rewrites", async () => {
    const { agent, a, source } = await fixture();
    const original = JSON.stringify(source);
    try {
      expect(
        await a.compactForContext(
          "fixture",
          "system",
          100000,
          new AbortController().signal,
          { reserveTokens: 1000, keepRecentTokens: 200 },
          false,
        ),
      ).toBe(true);
      expect(captured.proposer).not.toHaveBeenCalled();
      expect(captured.summary).not.toHaveBeenCalled();
      expect(JSON.stringify(a.messages)).toBe(original);
    } finally {
      await agent.cleanup();
    }
  });
  it("sends only the selected history to emergency summary and retains the owned working-set receipt", async () => {
    const { agent, a, receipt } = await fixture();
    a.messages.push({ role: "assistant", content: `ACTIVE_LONG_EVIDENCE ${"current evidence ".repeat(3000)}` });
    a.messageSeqs.push(a.messageSeqs.length + 1);
    try {
      await a.compactForContext(
        "fixture",
        "system",
        2000,
        new AbortController().signal,
        { reserveTokens: 1000, keepRecentTokens: 100 },
        true,
      );
      expect(captured.summary).toHaveBeenCalled();
      const preparation = captured.summary.mock.calls[0]![1];
      expect(JSON.stringify(preparation)).not.toContain("STALE_TASK_");
      expect(JSON.stringify(preparation)).toContain("UNRESOLVED_CURRENT_FAILURE");
      expect(new WorkingContext(agent.getSessionId()!, home, a.messages).snapshot()).toEqual(receipt);
      expect(a.messages.length).toBe(a.messageSeqs.length);
      closeDatabase();
      const resumed = loadTranscriptState(agent.getSessionId()!);
      expect(new WorkingContext(agent.getSessionId()!, home, resumed.messages).snapshot()).toEqual(receipt);
      expect(JSON.stringify(buildChatEntries(agent.getSessionId()!))).not.toContain("[Host working context data]");
      expect(JSON.stringify(loadRawTranscript(agent.getSessionId()!))).toContain("[Host working context data]");
    } finally {
      await agent.cleanup();
    }
  });
  it("atomically rolls back compaction when its working-set receipt cannot be persisted", async () => {
    const { agent } = await fixture();
    try {
      getDatabase().exec(
        `CREATE TRIGGER reject_context_receipt BEFORE INSERT ON messages WHEN NEW.message_json LIKE '%Host working context data%' BEGIN SELECT RAISE(ABORT, 'fixture receipt write failed'); END;`,
      );
      expect(() =>
        appendCompaction(agent.getSessionId()!, 999, "not committed", 1000, "[Host working context data]\n{}"),
      ).toThrow("fixture receipt write failed");
      expect(loadLatestCompaction(agent.getSessionId()!)).toBeNull();
    } finally {
      getDatabase().exec("DROP TRIGGER IF EXISTS reject_context_receipt");
      await agent.cleanup();
    }
  });
  it("gets actual host pin/job protections and refuses cleanup when job lookup fails", async () => {
    const { agent, a } = await fixture();
    a._pinnedSeqs.add(1);
    vi.spyOn(a.delegations, "list").mockResolvedValue([
      { id: "waiting-worker", status: "complete", resultVersion: "v1", deliveryStatus: "delivered" },
      { id: "handled-worker", status: "complete", resultVersion: "v1", deliveryStatus: "acknowledged" },
    ]);
    try {
      const protection = await a.getContextProtection();
      expect(protection.pendingJobIds).toEqual(["waiting-worker"]);
      expect(protection.pinned).toContain(a.messages[0]);
      vi.mocked(a.delegations.list).mockRejectedValue(new Error("fixture job store unavailable"));
      await a.compactForContext(
        "fixture",
        "system",
        100000,
        new AbortController().signal,
        { reserveTokens: 1000, keepRecentTokens: 200 },
        false,
      );
      expect(captured.proposer).not.toHaveBeenCalled();
      expect(captured.summary).not.toHaveBeenCalled();
      expect(JSON.stringify(a.messages)).toContain("STALE_TASK_0");
    } finally {
      await agent.cleanup();
    }
  });
});
