/**
 * End to end through Agent.compactForContext against real SQLite: the history a
 * session reloads (--session resume) must be the same bounded view the live
 * process holds after compaction. Before, the budget pass (compaction-budget.ts)
 * shrank only memory and the compaction row carried first_kept_seq alone, so a
 * reload brought back every row from there on (c2fda568be6b: 988k tokens live
 * after "saved 0", re-inflated on every restart until the next compaction).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import {
  appendMessages,
  loadRawTranscript,
  loadSessionChainTranscriptState,
  revertLatestCompaction,
} from "../../storage/transcript.js";

vi.mock("../compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compaction.js")>();
  return {
    ...actual,
    proposeCompaction: vi.fn(async () => null),
    generateCompactionSummary: vi.fn(async () => ({
      summary: "## Goal\nShip the docs engine.",
      usage: { promptTokens: 1, completionTokens: 1 },
    })),
  };
});

import { estimateConversationTokens } from "../compaction.js";
import { __resetCompactionModelCooldownForTests } from "../compaction-model-cooldown.js";
import { Agent } from "../orchestrator.js";

let tmpHome: string;
let prevHome: string | undefined;
let prevProfile: string | undefined;

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

beforeEach(() => {
  __resetCompactionModelCooldownForTests();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-shrink-reload-"));
  prevHome = process.env.HOME;
  prevProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // The fire-and-forget EE checkpoint extract enqueues offline; its directory must exist.
  fs.mkdirSync(path.join(tmpHome, ".muonroi-cli", "ee-offline-queue"), { recursive: true });
  closeDatabase();
  getDatabase();
});

afterEach(async () => {
  // Let the fire-and-forget EE writes land before the directory goes away.
  await new Promise((resolve) => setTimeout(resolve, 300));
  vi.clearAllMocks();
  closeDatabase();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function turn(i: number): ModelMessage[] {
  return [
    { role: "user", content: `Question ${i}` },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: `REASONING_${i} ${"think ".repeat(1500)}` },
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
          output: { type: "text", value: `RESULT_${i} ${"payload ".repeat(1500)}` },
        },
      ],
    } as ModelMessage,
    { role: "assistant", content: `Answer ${i}: ${"context ".repeat(300)}` },
  ];
}

function makeAgent() {
  const agent = new Agent("sk-dummy", undefined, "deepseek-v4-pro", undefined, {
    persistSession: true,
    executionRole: "infrastructure",
  });
  // biome-ignore lint/suspicious/noExplicitAny: private state is the pragmatic seam (mirrors compaction-delegation-ledger.test.ts)
  const a = agent as any;
  const conversation: ModelMessage[] = [];
  for (let i = 0; i < 40; i++) conversation.push(...turn(i));
  const seqs = appendMessages(a.session.id, conversation);
  a.messages = [...conversation];
  a.messageSeqs = [...seqs];
  return a;
}

const compact = (a: { compactForContext: (...args: unknown[]) => Promise<boolean> }) =>
  a.compactForContext(
    "deepseek",
    "You are a helpful assistant.",
    30_000,
    new AbortController().signal,
    undefined,
    true,
  );

describe("a reloaded session holds the same bounded history as the live compacted one", () => {
  it("compact -> reload keeps size bounded and aligned with the live view", async () => {
    const a = makeAgent();
    const sessionId = a.session.id as string;
    const raw = loadRawTranscript(sessionId);
    const rawTokens = estimateConversationTokens("sys", raw);

    expect(await compact(a)).toBe(true);
    const live = a.messages as ModelMessage[];
    const liveSeqs = a.messageSeqs as Array<number | null>;
    const liveTokens = estimateConversationTokens("sys", live);
    expect(liveTokens).toBeLessThan(rawTokens);

    const row = getDatabase().prepare("SELECT shrink_json FROM compactions WHERE session_id = ?").get(sessionId) as
      | { shrink_json: string | null }
      | undefined;
    expect(row?.shrink_json).toBeTruthy();
    const spec = JSON.parse(row!.shrink_json!) as { level: number; droppedRanges: Array<[number, number]> };
    expect(spec.level).toBeGreaterThanOrEqual(1);

    const reloaded = loadSessionChainTranscriptState(sessionId);
    const reloadedTokens = estimateConversationTokens("sys", reloaded.messages);
    // Same bounded size as the live process (the reload may add the persisted working receipt).
    expect(reloadedTokens).toBeLessThanOrEqual(liveTokens * 1.1 + 500);
    expect(reloadedTokens).toBeLessThan(rawTokens / 2);

    // Every persisted row the live view holds is present, with the same content, on reload.
    const reloadedBySeq = new Map<number, ModelMessage>();
    reloaded.seqs.forEach((seq, i) => {
      if (seq !== null) reloadedBySeq.set(seq, reloaded.messages[i]!);
    });
    live.forEach((message, i) => {
      const seq = liveSeqs[i];
      if (seq === null || seq === undefined) return;
      expect(JSON.stringify(reloadedBySeq.get(seq)), `seq ${seq}`).toBe(JSON.stringify(message));
    });
    // ...and no persisted row the live view dropped came back.
    const liveSeqSet = new Set(liveSeqs.filter((s): s is number => s !== null));
    const throughSeq = raw.length;
    for (const seq of reloadedBySeq.keys()) if (seq <= throughSeq) expect(liveSeqSet.has(seq), `seq ${seq}`).toBe(true);
  }, 30_000);

  it("the canonical rows are untouched and /expand (revert) restores the full history", async () => {
    const a = makeAgent();
    const sessionId = a.session.id as string;
    const rawBefore = JSON.stringify(loadRawTranscript(sessionId));
    expect(await compact(a)).toBe(true);
    expect(JSON.stringify(loadRawTranscript(sessionId))).toBe(rawBefore);

    revertLatestCompaction(sessionId);
    const expanded = loadSessionChainTranscriptState(sessionId);
    expect(expanded.compaction).toBeNull();
    expect(JSON.stringify(expanded.messages)).toBe(rawBefore);
  }, 30_000);
});
