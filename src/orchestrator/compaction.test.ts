import type { ModelMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEffectiveTranscript, type PersistedCompaction } from "../storage/transcript-view";
import { getAutoCompactMinNewTokens } from "../utils/settings";
import {
  COMPACTION_META_MAX_OUTPUT_TOKENS,
  COMPACTION_SUMMARY_HEADER,
  createCompactionSummaryMessage,
  findCutPoint,
  isCompactionThrash,
  metaCompactionMaxTokens,
  prepareCompaction,
  serializeConversation,
  shouldCompactContext,
} from "./compaction";
import { buildCheckpointReminder } from "./scope-reminder.js";
import { __forceFallbackForTests } from "./token-counter";

// Pin token counts to the chars/4 fallback so cut-point assertions remain stable.
// The real BPE tokenizer is exercised by token-counter's own tests.
beforeAll(() => __forceFallbackForTests(true));
afterAll(() => __forceFallbackForTests(false));

function user(text: string): ModelMessage {
  return { role: "user", content: text } as ModelMessage;
}

function assistantText(text: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as ModelMessage;
}

function assistantToolCall(toolCallId: string, toolName: string, input: Record<string, unknown> = {}): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  } as ModelMessage;
}

function toolResult(toolCallId: string, toolName: string, output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output }],
  } as ModelMessage;
}

describe("compaction helpers", () => {
  it("triggers when context exceeds reserved headroom", () => {
    const settings = { reserveTokens: 100, keepRecentTokens: 40 };

    expect(shouldCompactContext(901, 1000, settings)).toBe(true);
    expect(shouldCompactContext(900, 1000, settings)).toBe(false);
  });

  it("never selects a tool-result message as the cut point", () => {
    const messages = [
      user("inspect this file"),
      assistantToolCall("call-1", "read_file", { path: "src/index.ts" }),
      toolResult("call-1", "read_file", "x".repeat(400)),
      assistantText("I found the relevant section."),
      user("continue"),
    ];

    const cutPoint = findCutPoint(messages, 0, 130);

    expect(cutPoint.firstKeptIndex).not.toBe(2);
    expect(messages[cutPoint.firstKeptIndex]?.role).not.toBe("tool");
  });

  it("detects split turns and captures the turn prefix for summarization", () => {
    const messages = [
      user("Refactor the session loader."),
      assistantText("a".repeat(320)),
      assistantText("recent status update"),
    ];

    const preparation = prepareCompaction(messages, "system prompt", {
      reserveTokens: 100,
      keepRecentTokens: 5,
    });

    expect(preparation).not.toBeNull();
    expect(preparation?.isSplitTurn).toBe(true);
    expect(preparation?.messagesToSummarize).toHaveLength(0);
    expect(preparation?.turnPrefixMessages).toHaveLength(2);
    expect(preparation?.keptMessages).toHaveLength(1);
  });

  it("excludes the previous summary message from new compaction input", () => {
    const messages = [
      createCompactionSummaryMessage("Earlier work"),
      user("Handle migration edge cases"),
      assistantText("I added the table and loader changes."),
      user("Now wire the retry path"),
    ];

    const preparation = prepareCompaction(messages, "system prompt", {
      reserveTokens: 100,
      keepRecentTokens: 4,
    });

    expect(preparation).not.toBeNull();
    expect(preparation?.previousSummary).toBe("Earlier work");
    expect(preparation?.messagesToSummarize[0]).toEqual(user("Handle migration edge cases"));
    expect(preparation?.messagesToSummarize.some((message) => message.role === "system")).toBe(false);
  });

  it("serializes tool results with truncation markers", () => {
    const transcript = serializeConversation([user("Read the output"), toolResult("call-1", "bash", "x".repeat(8105))]);

    expect(transcript).toContain("[Tool result from bash]:");
    expect(transcript).toContain("more characters truncated");
  });

  it("preserves both head and tail of long tool results", () => {
    // Distinctive head and tail tokens — head-only truncation would lose the tail.
    const head = "HEAD_MARKER_START";
    const tail = "TAIL_MARKER_END";
    const filler = "x".repeat(10_000);
    const payload = `${head}${filler}${tail}`;
    const transcript = serializeConversation([user("read"), toolResult("call-1", "bash", payload)]);

    expect(transcript).toContain(head);
    expect(transcript).toContain(tail);
    expect(transcript).toContain("more characters truncated");
  });

  it("dedupes identical large tool-result payloads across history + turn-prefix slices", () => {
    const bigOutput = "y".repeat(2000); // > DEDUP_MIN_CHARS (500)
    const messages = [
      user("read it"),
      assistantToolCall("c1", "read_file", { path: "src/a.ts" }),
      toolResult("c1", "read_file", bigOutput),
      assistantText("ok"),
      user("read it again"),
      assistantToolCall("c2", "read_file", { path: "src/a.ts" }),
      toolResult("c2", "read_file", bigOutput),
      assistantText("done"),
      user("latest"),
      assistantText("recent reply"),
    ];

    const preparation = prepareCompaction(messages, "system", {
      reserveTokens: 100,
      keepRecentTokens: 50,
    });

    expect(preparation).not.toBeNull();
    const fullSlice = [...(preparation?.messagesToSummarize ?? []), ...(preparation?.turnPrefixMessages ?? [])];
    const serialized = serializeConversation(fullSlice);
    // First occurrence kept verbatim, second replaced with the elision marker.
    expect(serialized).toContain("Identical to earlier read_file result");
    expect(serialized.match(/y{2000}/g) ?? []).toHaveLength(1);
  });

  it("builds the effective transcript from the latest persisted checkpoint", () => {
    const rawMessages = [
      user("old request"),
      assistantText("old answer"),
      user("new request"),
      assistantText("new answer"),
      user("latest request"),
    ];
    const seqs = [1, 2, 3, 4, 5];
    const timestamps = seqs.map((seq) => new Date(`2026-03-20T00:00:0${seq}.000Z`));
    const checkpoint: PersistedCompaction = {
      firstKeptSeq: 4,
      summary: "Summarized old work",
      tokensBefore: 1234,
      createdAt: new Date("2026-03-20T00:00:10.000Z"),
    };

    const transcript = buildEffectiveTranscript(rawMessages, seqs, timestamps, checkpoint);

    expect(transcript.messages).toHaveLength(3);
    expect(transcript.seqs).toEqual([null, 4, 5]);
    expect(transcript.messages[0]).toEqual(createCompactionSummaryMessage("Summarized old work"));
    expect(
      transcript.messages[0]?.role === "system" && typeof transcript.messages[0].content === "string"
        ? transcript.messages[0].content
        : "",
    ).toContain(COMPACTION_SUMMARY_HEADER);
  });

  it("creates compaction summary with EE-extractable checkpoint meta (Progress ✔ DONE shape for pilContext/layer3)", () => {
    // This is the exact text shape persisted to EE behavioral collection on cli-compact-checkpoint
    // (orchestrator compactForContext + extract). Layer 3 searches for it; agent uses via "task finished?".
    const summaryMsg = createCompactionSummaryMessage(
      "Goal: implement anti-mu\nPlan: Phase 1-3\nProgress: ✔ DONE dedup marker\n↻ In Progress: layer1 enrich",
    );
    const content = typeof summaryMsg.content === "string" ? summaryMsg.content : "";
    expect(content).toContain("Context checkpoint summary");
    expect(content).toContain("✔ DONE");
    expect(content).toContain("Progress");
    expect(summaryMsg.role).toBe("system");
  });

  it("buildCheckpointReminder now includes PRESERVE + KEEP_TOOL_IDS + tool-artifact query for anti-mù (ideas 3+4)", () => {
    const r = buildCheckpointReminder(3, true);
    expect(r).toContain("PRESERVE");
    expect(r).toContain("KEEP_TOOL_IDS");
    expect(r).toContain("tool-artifact");
  });
});

describe("metaCompactionMaxTokens — meta summary cap (tunable, session 2b7a10219499)", () => {
  it("defaults to 1536 — looser than the old hard 1024, still well below the 14k-char problem", () => {
    delete process.env.MUONROI_META_COMPACT_MAX_TOKENS;
    expect(metaCompactionMaxTokens()).toBe(COMPACTION_META_MAX_OUTPUT_TOKENS);
    expect(COMPACTION_META_MAX_OUTPUT_TOKENS).toBe(1536);
    expect(COMPACTION_META_MAX_OUTPUT_TOKENS).toBeGreaterThan(1024);
  });

  it("honors a valid MUONROI_META_COMPACT_MAX_TOKENS override", () => {
    process.env.MUONROI_META_COMPACT_MAX_TOKENS = "2048";
    try {
      expect(metaCompactionMaxTokens()).toBe(2048);
    } finally {
      delete process.env.MUONROI_META_COMPACT_MAX_TOKENS;
    }
  });

  it("clamps out-of-range / garbage overrides to the default", () => {
    for (const bad of ["999999", "100", "-5", "abc", ""]) {
      process.env.MUONROI_META_COMPACT_MAX_TOKENS = bad;
      expect(metaCompactionMaxTokens(), bad).toBe(COMPACTION_META_MAX_OUTPUT_TOKENS);
    }
    delete process.env.MUONROI_META_COMPACT_MAX_TOKENS;
  });
});

describe("getAutoCompactMinNewTokens", () => {
  it("defaults to 20000", () => {
    expect(getAutoCompactMinNewTokens()).toBe(20_000);
  });
});

describe("isCompactionThrash — cross-turn anti-thrash predicate (session ff932f8568e8)", () => {
  it("skips a compaction ~14K after the last (the observed thrash)", () => {
    // last compaction dropped to ~36K; next turn at ~50K → 14K new < 20K floor
    expect(isCompactionThrash(50_613, 36_600, 20_000)).toBe(true);
  });
  it("allows compaction once enough new tokens accumulate", () => {
    expect(isCompactionThrash(60_000, 36_600, 20_000)).toBe(false);
  });
  it("never skips the first compaction of a session", () => {
    expect(isCompactionThrash(300_000, null, 20_000)).toBe(false);
  });
});
