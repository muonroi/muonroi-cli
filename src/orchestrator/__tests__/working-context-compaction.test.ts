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
  revertLatestCompaction,
} from "../../storage/transcript.js";
import { estimateConversationTokens } from "../compaction.js";
import { HOST_COMPACTION_STUB_PREFIX } from "../compaction-budget.js";
import { __resetCompactionModelCooldownForTests, markCompactionModelCooldown } from "../compaction-model-cooldown.js";
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
      ).toBe(1);
      expect(blocked[0].requestPhase).toBe("preflight");
      expect(blocked[0].estimatedInputTokens + blocked[0].reservedOutputTokens).toBeGreaterThan(
        blocked[0].contextWindowTokens,
      );
      expect(compact.mock.calls.filter((call) => call[5] === true)).toHaveLength(1);
      expect(captured.summary).toHaveBeenCalled();
      const mainCalls = handle.model.doStreamCalls.filter((call) => call.tools?.length);
      if (protectedHistory) {
        // Every message pinned used to make overflow recovery impossible (the
        // turn ended in an error with no model call). Protections now choose
        // which turns stay, not that their bulk stays: the host budget pass
        // keeps the pinned user text verbatim and shrinks the assistant bulk
        // (session c2fda568be6b: 41 compactions, nearly all "saved 0").
        expect(mainCalls).toHaveLength(1);
        const prompt = JSON.stringify(mainCalls[0].prompt);
        expect(prompt).toContain("Closed task 0");
        expect(prompt).toContain(HOST_COMPACTION_STUB_PREFIX);
        expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
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
        // The kept tail must cover the context_load call + receipt (~180 est tokens with the pinned
        // root fields) so the current user turn stays verbatim instead of entering the split-turn prefix.
        { reserveTokens: 1000, keepRecentTokens: 400 },
        true,
      );
      expect(captured.summary).toHaveBeenCalledOnce();
      expect(JSON.stringify(a.messages)).toContain("CURRENT_TASK");
      expect(JSON.stringify(a.messages)).toContain("UNRESOLVED_CURRENT_FAILURE");
    } finally {
      await agent.cleanup();
    }
  });
  // Session c2fda568be6b: every turn mentioned an unacknowledged jobId, so
  // `outstanding-job` protected ~830k tokens; both summarizers were cooling
  // down; 41 compactions logged "saved 0" while history reached ~942k tokens.
  it("all summarizers cooling down + every turn protected: the deterministic pass still shrinks the prompt", async () => {
    const { agent, a } = await fixture(false);
    vi.spyOn(a, "getContextProtection").mockResolvedValue({ pinned: [], pendingJobIds: ["Closed task"] });
    markCompactionModelCooldown(agent.getSessionId()!, a._resolveCompactModel());
    markCompactionModelCooldown(agent.getSessionId()!, a.modelId);
    try {
      await a.compactForContext(
        "fixture",
        "system",
        1_000_000,
        new AbortController().signal,
        // Tail covers the context_load pair + receipt so CURRENT_TASK stays a kept (not summarized) turn.
        { reserveTokens: 1000, keepRecentTokens: 400 },
        true,
      );
      expect(captured.summary).not.toHaveBeenCalled();
      const row = getDatabase()
        .prepare(
          "SELECT metadata_json FROM interaction_logs WHERE session_id=? AND event_type='compaction' AND event_subtype IS NULL ORDER BY id DESC LIMIT 1",
        )
        .get(agent.getSessionId()) as { metadata_json: string };
      const meta = JSON.parse(row.metadata_json);
      const data = meta.data ?? meta;
      expect(data.summaryModel).toBeNull(); // mechanical stub
      expect(data.budgetLevel).toBeGreaterThanOrEqual(1);
      expect(data.saved).toBeGreaterThan(data.tokensBefore / 2);
      const after = JSON.stringify(a.messages);
      expect(after).toContain("Mechanical compaction");
      for (let i = 0; i < 12; i++) expect(after).toContain(`Closed task ${i}`); // protected turns still visible
      expect(after).toContain("CURRENT_TASK");
      expect(a.messages.length).toBe(a.messageSeqs.length);
    } finally {
      __resetCompactionModelCooldownForTests();
      await agent.cleanup();
    }
  });
  // Same scenario, then a --session resume: the shrink was memory-only, so the
  // compaction row (first_kept_seq = the earliest protected turn) brought the
  // whole history back verbatim until the next compaction.
  it("every turn protected: a reload holds the same bounded view, canonical rows untouched, /expand restores all", async () => {
    const { agent, a } = await fixture(false);
    vi.spyOn(a, "getContextProtection").mockResolvedValue({ pinned: [], pendingJobIds: ["Closed task"] });
    markCompactionModelCooldown(agent.getSessionId()!, a._resolveCompactModel());
    markCompactionModelCooldown(agent.getSessionId()!, a.modelId);
    try {
      const sessionId = agent.getSessionId()!;
      const rawBefore = loadRawTranscript(sessionId);
      const rawTokens = estimateConversationTokens("system", loadRawTranscript(sessionId));
      await a.compactForContext(
        "fixture",
        "system",
        1_000_000,
        new AbortController().signal,
        { reserveTokens: 1000, keepRecentTokens: 400 },
        true,
      );
      const liveTokens = estimateConversationTokens("system", a.messages);
      expect(liveTokens).toBeLessThan(rawTokens / 2);

      // What the row used to be: first_kept_seq at the earliest protected turn, so the
      // un-shrunk suffix is (nearly) the whole transcript.
      const compaction = loadLatestCompaction(sessionId)!;
      expect(compaction.firstKeptSeq).toBeLessThanOrEqual(2);
      expect(compaction.shrink?.level).toBeGreaterThanOrEqual(1);

      closeDatabase();
      const resumed = loadTranscriptState(sessionId);
      const resumedTokens = estimateConversationTokens("system", resumed.messages);
      // Bounded like the live view (the persisted working receipt is the only extra row).
      expect(resumedTokens).toBeLessThanOrEqual(liveTokens * 1.1 + 500);
      expect(resumedTokens).toBeLessThan(rawTokens / 2);
      const resumedText = JSON.stringify(resumed.messages);
      expect(resumedText).toContain(HOST_COMPACTION_STUB_PREFIX);
      for (let i = 0; i < 12; i++) expect(resumedText).toContain(`Closed task ${i}`);
      expect(resumedText).toContain("CURRENT_TASK");

      // Canonical rows are never rewritten (compaction only appends its working receipt), and
      // /expand (revert) brings the full history back.
      const rawAfter = loadRawTranscript(sessionId);
      expect(JSON.stringify(rawAfter.slice(0, rawBefore.length))).toBe(JSON.stringify(rawBefore));
      revertLatestCompaction(sessionId);
      expect(JSON.stringify(loadTranscriptState(sessionId).messages)).toBe(JSON.stringify(rawAfter));
    } finally {
      __resetCompactionModelCooldownForTests();
      await agent.cleanup();
    }
  });
  // Same session, 11:25Z-11:46Z: 15 turns ended on "Request context overflow"
  // with no model call, no assistant message and no interaction_logs error row.
  it("a turn that still cannot fit after compaction ends with a visible, logged error — never silently", async () => {
    const { agent, a } = await fixture(false);
    const previousCwd = process.cwd();
    fs.mkdirSync(path.join(home, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".muonroi-cli/settings.json"),
      JSON.stringify({ routerSubSessions: false, routingMode: "fixed", model: getTestModels().premium }),
    );
    process.chdir(home);
    const contextWindow = 6_000; // the current user turn alone exceeds it; compaction never touches the current turn
    const resolveRuntime = modelRuntime.resolveModelRuntime;
    vi.spyOn(modelRuntime, "resolveModelRuntime").mockImplementation((...args) => {
      const runtime = resolveRuntime(...args);
      return { ...runtime, modelInfo: { ...runtime.modelInfo!, contextWindow } };
    });
    vi.spyOn(a, "getCompactionSettings").mockReturnValue({ reserveTokens: 1000, keepRecentTokens: 200 });
    const handle = installMockModel({ fixture: { autoClassify: true, stream: textOnlyStream("NEVER_SENT") } });
    try {
      const chunks = [];
      for await (const chunk of agent.processMessage(`Continue CURRENT_TASK ${"huge pasted log ".repeat(4000)}`))
        chunks.push(chunk);
      expect(handle.model.doStreamCalls.filter((call) => call.tools?.length)).toHaveLength(0);
      const errors = chunks.filter((c) => c.type === "error");
      expect(errors).toHaveLength(1);
      expect(String(errors[0]!.content)).toMatch(/context/i);
      const rows = getDatabase()
        .prepare("SELECT event_subtype, metadata_json FROM interaction_logs WHERE session_id=? AND event_type='error'")
        .all(agent.getSessionId()) as { event_subtype: string; metadata_json: string }[];
      expect(rows.map((r) => r.event_subtype)).toContain("context_overflow");
      const data = JSON.parse(rows.find((r) => r.event_subtype === "context_overflow")!.metadata_json);
      expect(JSON.stringify(data)).toContain("Request context overflow");
    } finally {
      handle.uninstall();
      process.chdir(previousCwd);
      vi.restoreAllMocks();
      await agent.cleanup();
    }
  }, 20000);
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
