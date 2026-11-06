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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function compactAndReadSummaryWithAgent() {
  const { agent, a } = makeAgent();
  await a.compactForContext(
    "deepseek",
    "You are a helpful assistant.",
    8000,
    new AbortController().signal,
    undefined,
    true,
  );
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

  it("a rejected summary's billed tokens are recorded to usage_events under the model that spent them", async () => {
    replies.set(COMPACT_MODEL, { text: "", finishReason: "length", outputTokens: 4096, reasoningText: "r".repeat(50) });
    const { agent } = await compactAndReadSummaryWithAgent();
    const rows = getDatabase()
      .prepare(
        "SELECT model, input_tokens, output_tokens FROM usage_events WHERE session_id = ? AND source = 'compaction' ORDER BY id",
      )
      .all(agent.getSessionId()!) as Array<{ model: string; input_tokens: number; output_tokens: number }>;
    expect(rows).toEqual([
      { model: COMPACT_MODEL, input_tokens: 100, output_tokens: 4096 }, // the rejected, billed attempt
      { model: MAIN_MODEL, input_tokens: 100, output_tokens: 20 }, // the fallback that produced the summary
    ]);
  }, 15_000);

  it("a rejected model is cooled down: the NEXT compaction skips it and goes straight to the fallback", async () => {
    replies.set(COMPACT_MODEL, { text: "", finishReason: "length", outputTokens: 4096 });
    const { a } = await compactAndReadSummaryWithAgent();
    expect(calls.map((c) => c.modelId)).toEqual([COMPACT_MODEL, MAIN_MODEL]);

    calls.length = 0;
    const out: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 60; i++) {
      out.push({ role: "user", content: `Question ${i}: ${"detail ".repeat(2000)}` });
      out.push({ role: "assistant", content: `Answer ${i}: ${"context ".repeat(2000)}` });
    }
    a.messages = out;
    a.messageSeqs = out.map((_, i) => i + 1);
    await a.compactForContext(
      "deepseek",
      "You are a helpful assistant.",
      8000,
      new AbortController().signal,
      undefined,
      true,
    );
    expect(calls.map((c) => c.modelId)).toEqual([MAIN_MODEL]);
  }, 15_000);

  it("both models empty: never stores an empty summary — the mechanical stub is used", async () => {
    replies.set(COMPACT_MODEL, { text: "", finishReason: "length", outputTokens: 4096 });
    replies.set(MAIN_MODEL, { text: "", finishReason: "length", outputTokens: 4096 });
    const { ok, summary } = await compactAndReadSummary();
    expect(ok).toBe(true);
    expect(summary).toContain("Mechanical compaction");
  }, 15_000);
});

describe("compactForContext writes exactly one cost-log row per billed summary call", () => {
  // Before: recordUsage("compaction") appended a second copy of every row
  // (186 cost-log rows for 93 compactions, 2026-11-02..04), double-counting
  // compaction in `usage report --by callsite`.
  // appendCostLog is fire-and-forget, so neither the arrival time nor the
  // append ORDER of two rows is deterministic under load (measured: a full
  // shard run wrote the fallback row before the rejected one). Wait for the
  // expected count and compare as a set — the contract is "one row each".
  async function compactionRows(expected = 1): Promise<Array<Record<string, unknown>>> {
    const home = mkdtempSync(join(tmpdir(), "muonroi-compaction-costlog-"));
    vi.stubEnv("MUONROI_CLI_HOME", home);
    try {
      await compactAndReadSummaryWithAgent();
      const dir = join(home, "usage");
      // appendCostLog is fire-and-forget; wait until the writes settle.
      let rows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 50; i++) {
        rows = existsSync(dir)
          ? readdirSync(dir)
              .filter((f) => f.startsWith("cost-log-"))
              .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
              .map((l) => JSON.parse(l) as Record<string, unknown>)
              .filter((r) => r.phase === "compaction")
          : [];
        if (rows.length >= expected && i >= 5) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return rows;
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("an accepted summary: one row, with iteration and the summarizer's model", async () => {
    const rows = await compactionRows();
    expect(rows.map((r) => [r.callsite, r.model, r.actualInputTokens, r.actualOutputTokens])).toEqual([
      ["orchestrator.compaction", COMPACT_MODEL, 100, 20],
    ]);
    expect(rows[0]?.iteration).toBe(1);
  }, 15_000);

  it("a rejected-but-billed summary and its fallback: one row EACH (both were real calls)", async () => {
    replies.set(COMPACT_MODEL, { text: "", finishReason: "length", outputTokens: 4096, reasoningText: "r".repeat(50) });
    const rows = await compactionRows(2);
    const shape = (r: Record<string, unknown>) => [r.callsite, r.model, r.actualInputTokens, r.actualOutputTokens];
    const byCallsite = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
    expect(rows.map(shape).sort(byCallsite)).toEqual(
      [
        ["orchestrator.compaction.rejected", COMPACT_MODEL, 100, 4096],
        ["orchestrator.compaction", MAIN_MODEL, 100, 20],
      ].sort(byCallsite),
    );
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
