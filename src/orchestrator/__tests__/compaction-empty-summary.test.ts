/**
 * A summarizer call that RETURNS an unusable summary must take the same
 * fallback chain as one that throws (compact model -> main model -> mechanical
 * stub).
 *
 * Measured (session 4edc02516a92): compactions 315, 324, 328, 331, 333, 345,
 * 348, 367, 382, 383, 384, 386, 387, 390, 394 stored an EMPTY summary, each
 * billed exactly its output cap with zero text, and replaced history.
 *
 * Only the provider transport (`generateTextStreamed`) is mocked, so the real
 * `summarizeConversation` -> `compactForContext` chain is exercised.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";

type Reply = { text: string; finishReason?: string; reasoningText?: string; outputTokens?: number };
const replies = new Map<string, Reply>();
const calls: Array<{ modelId: string; maxOutputTokens?: number }> = [];

vi.mock("../../providers/streamed-generate.js", () => ({
  generateTextStreamed: vi.fn(async (args: { model: { modelId?: string }; maxOutputTokens?: number }) => {
    const modelId = String(args.model?.modelId ?? "unknown");
    calls.push({ modelId, maxOutputTokens: args.maxOutputTokens });
    const reply = replies.get(modelId) ?? { text: `real summary from ${modelId}`, finishReason: "stop" };
    return {
      text: reply.text,
      reasoningText: reply.reasoningText,
      finishReason: reply.finishReason ?? "stop",
      usage: { inputTokens: 100, outputTokens: reply.outputTokens ?? 20 },
      toolCalls: [],
    };
  }),
}));

vi.mock("../compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compaction.js")>();
  // The proposer is covered elsewhere; this suite measures the summary chain.
  return { ...actual, proposeCompaction: vi.fn(async () => null) };
});

import {
  assertUsableCompactionSummary,
  COMPACTION_TRUNCATED_MIN_CHARS,
  CompactionSummaryRejectedError,
} from "../compaction.js";
import { __resetCompactionModelCooldownForTests } from "../compaction-model-cooldown.js";
import { Agent } from "../orchestrator.js";

const COMPACT_MODEL = "deepseek-v4-flash"; // catalog fixtures' "fast" tier (see compact-summary-failure.test.ts)
const MAIN_MODEL = "deepseek-v4-pro";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

beforeEach(() => {
  replies.clear();
  calls.length = 0;
  __resetCompactionModelCooldownForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  try {
    closeDatabase();
  } catch (err) {
    console.debug(`[compaction-empty-summary.test] closeDatabase: ${(err as Error).message}`);
  }
});

function makeAgent() {
  const agent = new Agent("sk-dummy", undefined, MAIN_MODEL, undefined, {
    persistSession: true,
    executionRole: "infrastructure",
  });
  // biome-ignore lint/suspicious/noExplicitAny: private state is the pragmatic seam (mirrors compact-summary-failure.test.ts)
  const a = agent as any;
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < 60; i++) {
    out.push({ role: "user", content: `Question ${i}: ${"detail ".repeat(2000)}` });
    out.push({ role: "assistant", content: `Answer ${i}: ${"context ".repeat(2000)}` });
  }
  a.messages = out;
  a.messageSeqs = out.map((_, i) => i + 1);
  return { agent, a };
}

async function compactAndReadSummary() {
  const { agent, a } = makeAgent();
  const ok = await a.compactForContext(
    "deepseek",
    "You are a helpful assistant.",
    8000,
    new AbortController().signal,
    undefined,
    true,
  );
  const row = getDatabase()
    .prepare("SELECT summary FROM compactions WHERE session_id = ? ORDER BY id DESC LIMIT 1")
    .get(agent.getSessionId()!) as { summary: string } | undefined;
  return { ok, summary: row?.summary ?? null, models: [...new Set(calls.map((c) => c.modelId))] };
}

describe("compactForContext rejects unusable summaries through the existing fallback chain", () => {
  it("normal summary: accepted from the compact model, no fallback", async () => {
    const { ok, summary, models } = await compactAndReadSummary();
    expect(ok).toBe(true);
    expect(models).toEqual([COMPACT_MODEL]);
    expect(summary).toContain(`real summary from ${COMPACT_MODEL}`);
  }, 15_000);

  it("empty summary (budget spent, zero text): falls back to the main model", async () => {
    replies.set(COMPACT_MODEL, {
      text: "  \n",
      finishReason: "length",
      outputTokens: 4096,
      reasoningText: "x".repeat(900),
    });
    const { ok, summary, models } = await compactAndReadSummary();
    expect(ok).toBe(true);
    expect(models).toEqual([COMPACT_MODEL, MAIN_MODEL]);
    expect(summary).toContain(`real summary from ${MAIN_MODEL}`);
  }, 15_000);

  it("truncated-short summary (finishReason=length, below the minimum): falls back", async () => {
    replies.set(COMPACT_MODEL, { text: "## Goal\nShip the", finishReason: "length", outputTokens: 4096 });
    const { summary, models } = await compactAndReadSummary();
    expect(models).toEqual([COMPACT_MODEL, MAIN_MODEL]);
    expect(summary).toContain(`real summary from ${MAIN_MODEL}`);
  }, 15_000);

  it("a truncated summary that is long enough is still accepted (it carries real content)", async () => {
    const long = `## Goal\n${"progress detail ".repeat(60)}`;
    replies.set(COMPACT_MODEL, { text: long, finishReason: "length", outputTokens: 4096 });
    const { summary, models } = await compactAndReadSummary();
    expect(models).toEqual([COMPACT_MODEL]);
    expect(summary).toContain("progress detail");
  }, 15_000);

  it("both models empty: never stores an empty summary — the mechanical stub is used", async () => {
    replies.set(COMPACT_MODEL, { text: "", finishReason: "length", outputTokens: 4096 });
    replies.set(MAIN_MODEL, { text: "", finishReason: "length", outputTokens: 4096 });
    const { ok, summary } = await compactAndReadSummary();
    expect(ok).toBe(true);
    expect(summary).toContain("Mechanical compaction");
  }, 15_000);
});

describe("assertUsableCompactionSummary", () => {
  it("throws a typed error carrying model, finishReason, output tokens, budget and reasoning size", () => {
    let caught: unknown;
    try {
      assertUsableCompactionSummary("m", { text: "", finishReason: "length", reasoningText: "abc" }, 4096, 4096);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CompactionSummaryRejectedError);
    const e = caught as CompactionSummaryRejectedError;
    expect(e).toMatchObject({
      reason: "empty",
      modelId: "m",
      finishReason: "length",
      outputTokens: 4096,
      budget: 4096,
    });
    expect(e.reasoningChars).toBe(3);
    expect(e.message).toContain("finishReason=length");
  });

  it("accepts a short summary that finished normally, and a short-but-at-minimum truncated one", () => {
    expect(() => assertUsableCompactionSummary("m", { text: "done.", finishReason: "stop" }, 5, 4096)).not.toThrow();
    expect(() =>
      assertUsableCompactionSummary(
        "m",
        { text: "y".repeat(COMPACTION_TRUNCATED_MIN_CHARS), finishReason: "length" },
        4096,
        4096,
      ),
    ).not.toThrow();
  });
});
