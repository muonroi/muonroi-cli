/**
 * Compaction on a reasoning model must (a) ask the provider for its cheapest
 * DOCUMENTED reasoning effort and (b) keep the cost of a rejected summary
 * attributable.
 *
 * Evidence (session 4edc02516a92): 15 of 74 compactions on step-3.7-flash came
 * back EMPTY, each billing exactly its output cap — reasoning ate the budget.
 * The minimization knob was a no-op for that model because the catalog said
 * `supports_effort: false`, contradicting StepFun's own docs
 * (platform.stepfun.ai/docs/en/guides/models/step-3.7-flash: "supports three
 * reasoning effort levels" low/medium/high via `reasoning_effort`). Probed live
 * 2026-11-05 on https://api.stepfun.ai/step_plan/v1: `reasoning_effort:"low"`
 * is accepted and applied (prompt_tokens 471 -> 476, mean completion tokens
 * 990 -> 740 over 4 samples each); `reasoning_effort:"none"`,
 * `thinking:{type:"disabled"}` and `enable_thinking:false` are accepted but
 * ignored (prompt_tokens unchanged, reasoning still emitted).
 *
 * Only `fetch` is stubbed: the real `summarizeConversation` -> AI SDK
 * openai-compatible serialization path builds the request body.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelInfo, loadCatalog } from "../../models/registry.js";
import { createProviderFactory } from "../../providers/runtime.js";
import {
  CompactionSummaryRejectedError,
  generateCompactionSummary,
  getBilledCompactionUsage,
  type PreparedCompaction,
} from "../compaction.js";

const MODEL_ID = "step-3.7-flash";
const bodies: Array<Record<string, unknown>> = [];

/** Reply shape keyed by a marker found in the request body. */
type StubReply = { content: string; reasoning: string; finish: "stop" | "length"; prompt: number; completion: number };
let replyFor: (body: string) => StubReply = () => ({
  content: "## Goal\nsummary",
  reasoning: "",
  finish: "stop",
  prompt: 100,
  completion: 20,
});

function sse(reply: StubReply): string {
  const chunks: unknown[] = [];
  if (reply.reasoning) chunks.push({ choices: [{ index: 0, delta: { reasoning_content: reply.reasoning } }] });
  if (reply.content) chunks.push({ choices: [{ index: 0, delta: { content: reply.content } }] });
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: reply.finish }],
    usage: {
      prompt_tokens: reply.prompt,
      completion_tokens: reply.completion,
      total_tokens: reply.prompt + reply.completion,
    },
  });
  return `${chunks.map((c) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", ...(c as object) })}\n\n`).join("")}data: [DONE]\n\n`;
}

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  bodies.length = 0;
  vi.stubEnv("MUONROI_GATE", "0");
  createProviderFactory("stepfun", { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const raw = String(init?.body);
      bodies.push(JSON.parse(raw));
      return new Response(sse(replyFor(raw)), { status: 200, headers: { "content-type": "text/event-stream" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  replyFor = () => ({ content: "## Goal\nsummary", reasoning: "", finish: "stop", prompt: 100, completion: 20 });
});

function preparation(overrides: Partial<PreparedCompaction> = {}): PreparedCompaction {
  return {
    messagesToSummarize: [
      { role: "user", content: "HISTORY-MARKER fix the parser" },
      { role: "assistant", content: "Edited src/parser.ts line 20; tests green." },
    ],
    turnPrefixMessages: [],
    keptMessages: [],
    firstKeptIndex: 2,
    isSplitTurn: false,
    tokensBefore: 50_000,
    settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
    ...overrides,
  };
}

describe("compaction reasoning control (StepFun step-3.7-flash)", () => {
  it("catalog declares the documented reasoning_effort knob for step-3.7-flash", () => {
    const info = getModelInfo(MODEL_ID);
    expect(info?.provider).toBe("stepfun");
    expect(info?.reasoning).toBe(true);
    expect(info?.supportsReasoningEffort).toBe(true);
  });

  it("the summarizer request body carries reasoning_effort=low and no ignored disable params", async () => {
    const result = await generateCompactionSummary(MODEL_ID, preparation());
    expect(result.summary).toContain("summary");
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.model).toBe(MODEL_ID);
    expect(body.reasoning_effort).toBe("low");
    // Probed live: StepFun accepts these but ignores them — never send them.
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("enable_thinking");
  });

  it("a rejected (reasoning-only, length-capped) summary still reports the tokens it billed", async () => {
    replyFor = () => ({ content: "", reasoning: "r".repeat(500), finish: "length", prompt: 3_000, completion: 4_096 });
    let caught: unknown;
    try {
      await generateCompactionSummary(MODEL_ID, preparation());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CompactionSummaryRejectedError);
    expect((caught as CompactionSummaryRejectedError).reason).toBe("empty");
    expect(getBilledCompactionUsage(caught)).toEqual({ promptTokens: 3_000, completionTokens: 4_096 });
  });

  it("split turn: one half rejected -> the error carries BOTH halves' billed tokens", async () => {
    replyFor = (raw) =>
      raw.includes("PREFIX-MARKER")
        ? { content: "", reasoning: "r".repeat(300), finish: "length", prompt: 1_000, completion: 2_048 }
        : { content: "## Goal\nhistory summary", reasoning: "", finish: "stop", prompt: 2_000, completion: 300 };
    let caught: unknown;
    try {
      await generateCompactionSummary(
        MODEL_ID,
        preparation({ isSplitTurn: true, turnPrefixMessages: [{ role: "user", content: "PREFIX-MARKER big turn" }] }),
      );
    } catch (err) {
      caught = err;
    }
    expect(bodies).toHaveLength(2);
    expect(caught).toBeInstanceOf(CompactionSummaryRejectedError);
    expect(getBilledCompactionUsage(caught)).toEqual({ promptTokens: 3_000, completionTokens: 2_348 });
  });

  it("errors with no billed usage report zero (provider threw before any usage)", () => {
    expect(getBilledCompactionUsage(new Error("boom"))).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(getBilledCompactionUsage("not an error")).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});
