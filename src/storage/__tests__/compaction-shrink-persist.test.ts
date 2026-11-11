/**
 * The host budget pass (orchestrator/compaction-budget.ts) shrinks retained
 * history in memory. appendCompaction persisted only first_kept_seq, so after a
 * reload every row from there on came back verbatim (c2fda568be6b: kept 988k
 * tokens live, first_kept_seq stuck at 23). A persisted shrink spec on the
 * compaction row must reproduce the bounded view on load while the canonical
 * message rows stay untouched and /expand (revertLatestCompaction) still
 * yields the full history. Real SQLite against a temp HOME.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateConversationTokens } from "../../orchestrator/compaction.js";
import {
  HOST_COMPACTION_STUB_PREFIX,
  isPersistedShrinkSpec,
  type PersistedShrinkSpec,
  toSeqRanges,
} from "../../orchestrator/compaction-budget.js";
import { closeDatabase, getDatabase } from "../db.js";
import { SessionStore } from "../sessions.js";
import {
  appendCompaction,
  appendMessages,
  buildChatEntries,
  loadRawTranscript,
  loadTranscriptState,
  revertLatestCompaction,
  setLatestCompactionShrink,
} from "../transcript.js";

const big = (tag: string, n = 6_000) => `${tag} ${"payload ".repeat(n / 8)}`;

function turn(i: number): ModelMessage[] {
  return [
    { role: "user", content: `USER_${i}` },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: big(`REASONING_${i}`) },
        { type: "text", text: `ANSWER_${i}` },
        { type: "tool-call", toolCallId: `call_${i}`, toolName: "read_file", input: { path: `f${i}.ts` } },
      ],
    } as ModelMessage,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${i}`,
          toolName: "read_file",
          output: { type: "text", value: big(`RESULT_${i}`) },
        },
      ],
    } as ModelMessage,
    { role: "assistant", content: `DONE_${i}` },
  ];
}

const text = (ms: ModelMessage[]) => JSON.stringify(ms);
// A long unique slice of a tool result: a stub's 200-char preview never contains it.
const full = (tag: string) => big(tag).slice(0, 1500);
const tokens = (ms: ModelMessage[]) => estimateConversationTokens("sys", ms);

describe("compaction shrink is durable", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;
  let sessionId: string;
  let seqs: number[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-shrink-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    closeDatabase();
    getDatabase();
    const session = new SessionStore(tmpHome).createSession("fixture-model", "agent", tmpHome);
    sessionId = session.id;
    // 12 turns of 4 messages = seq 1..48.
    const all: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) all.push(...turn(i));
    seqs = appendMessages(sessionId, all);
  });

  afterEach(() => {
    closeDatabase();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /**
   * What the live pass left: turn 1 retained by a protection (seq 5-8), turns 2-8
   * summarized away, turns 9-11 the verbatim tail (seq 33-48), with the last turn
   * (seq 45-48) as the current turn.
   */
  function compactLikeLive(level: 0 | 1 | 2 | 3 = 1): PersistedShrinkSpec {
    const throughSeq = seqs[seqs.length - 1]!;
    appendCompaction(sessionId, 5, "## Goal\nfixture summary", 100_000);
    const spec: PersistedShrinkSpec = {
      v: 1,
      throughSeq,
      level,
      tailFromSeq: 33,
      currentTurnFromSeq: 45,
      droppedRanges: toSeqRanges([
        9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
      ]),
    };
    setLatestCompactionShrink(sessionId, spec);
    return spec;
  }

  it("without a spec the reload re-inflates to everything from first_kept_seq (the defect)", () => {
    appendCompaction(sessionId, 5, "## Goal\nfixture summary", 100_000);
    const reloaded = loadTranscriptState(sessionId).messages;
    expect(text(reloaded)).toContain("RESULT_5");
    expect(text(reloaded)).toContain("REASONING_3");
    expect(reloaded.length).toBe(1 + (48 - 4));
  });

  it("reload keeps history bounded: dropped turns gone, protected turn shrunk, tail and current turn verbatim", () => {
    const raw = loadRawTranscript(sessionId);
    compactLikeLive(1);
    const state = loadTranscriptState(sessionId);
    const view = state.messages;
    const t = text(view);

    // Rows the live view summarized away do not come back.
    for (const i of [2, 3, 4, 5, 6, 7]) expect(t).not.toContain(`USER_${i}`);
    // The protection-retained turn (seq 5-8) is present but shrunk.
    expect(t).toContain(`"content":"USER_1"`);
    expect(t).toContain(HOST_COMPACTION_STUB_PREFIX);
    expect(t).not.toContain(full("RESULT_1"));
    expect(t).not.toContain("REASONING_1 ");
    expect(t).toContain('retrieve_tool_result({\\"tool_call_id\\":\\"call_1\\"})');
    // Level 1 leaves the verbatim tail alone, including its reasoning and tool results.
    expect(t).toContain("REASONING_9");
    expect(t).toContain(full("RESULT_10"));
    // The current turn is never touched.
    expect(t).toContain("REASONING_11");
    expect(t).toContain(full("RESULT_11"));
    // Bounded against the unshrunk suffix a reload used to return.
    expect(tokens(view)).toBeLessThan(tokens(raw) / 2);
    // Seqs stay aligned with the surviving rows.
    expect(state.seqs).toHaveLength(view.length);
    expect(state.seqs[0]).toBeNull();
    expect(state.seqs.slice(1, 5)).toEqual([5, 6, 7, 8]);
    expect(state.seqs.slice(5)).toEqual(seqs.slice(32));
  });

  it("level 2 shrinks the tail too, but never the current turn", () => {
    compactLikeLive(2);
    const t = text(loadTranscriptState(sessionId).messages);
    expect(t).not.toContain("REASONING_9");
    expect(t).not.toContain(full("RESULT_10"));
    expect(t).toContain("REASONING_11");
    expect(t).toContain(full("RESULT_11"));
  });

  it("level 0 only restores the retained set (no shrink of kept rows)", () => {
    compactLikeLive(0);
    const t = text(loadTranscriptState(sessionId).messages);
    expect(t).not.toContain("USER_5");
    expect(t).toContain(full("RESULT_1"));
    expect(t).not.toContain(HOST_COMPACTION_STUB_PREFIX);
  });

  it("rows appended after the compaction are never shrunk or dropped", () => {
    compactLikeLive(2);
    const later = appendMessages(sessionId, turn(99));
    const t = text(loadTranscriptState(sessionId).messages);
    expect(t).toContain("USER_99");
    expect(t).toContain(full("RESULT_99"));
    expect(later[0]).toBeGreaterThan(48);
  });

  it("does not mutate the canonical rows, and /expand (revert) yields the full history again", () => {
    const rawBefore = text(loadRawTranscript(sessionId));
    compactLikeLive(2);
    expect(text(loadRawTranscript(sessionId))).toBe(rawBefore);
    // The user-facing chat still lists every canonical row from first_kept_seq.
    const chat = buildChatEntries(sessionId);
    expect(JSON.stringify(chat)).toContain("USER_5");

    revertLatestCompaction(sessionId);
    const expanded = loadTranscriptState(sessionId);
    expect(expanded.compaction).toBeNull();
    expect(text(expanded.messages)).toBe(rawBefore);
  });

  it("a malformed spec is ignored: the reload degrades to the suffix, it does not fail", () => {
    appendCompaction(sessionId, 5, "## Goal\nfixture summary", 100_000);
    getDatabase().prepare("UPDATE compactions SET shrink_json = ? WHERE session_id = ?").run("{not json", sessionId);
    const state = loadTranscriptState(sessionId);
    expect(state.compaction?.shrink).toBeUndefined();
    expect(state.messages.length).toBe(1 + 44);
    getDatabase()
      .prepare("UPDATE compactions SET shrink_json = ? WHERE session_id = ?")
      .run(JSON.stringify({ v: 2, nonsense: true }), sessionId);
    expect(loadTranscriptState(sessionId).messages.length).toBe(1 + 44);
  });

  it("setLatestCompactionShrink targets only the newest compaction row", () => {
    appendCompaction(sessionId, 5, "first", 1);
    appendCompaction(sessionId, 9, "second", 1);
    const spec: PersistedShrinkSpec = {
      v: 1,
      throughSeq: 48,
      level: 1,
      tailFromSeq: 33,
      currentTurnFromSeq: 45,
      droppedRanges: [[9, 12]],
    };
    setLatestCompactionShrink(sessionId, spec);
    const rows = getDatabase()
      .prepare("SELECT summary, shrink_json FROM compactions WHERE session_id = ? ORDER BY id")
      .all(sessionId) as Array<{ summary: string; shrink_json: string | null }>;
    expect(rows.map((r) => r.shrink_json !== null)).toEqual([false, true]);
    expect(isPersistedShrinkSpec(JSON.parse(rows[1]!.shrink_json!))).toBe(true);
  });

  it("toSeqRanges collapses runs and de-duplicates", () => {
    expect(toSeqRanges([5, 3, 4, 4, 9, 10, 20])).toEqual([
      [3, 5],
      [9, 10],
      [20, 20],
    ]);
    expect(toSeqRanges([])).toEqual([]);
  });
});
