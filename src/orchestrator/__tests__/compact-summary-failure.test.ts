/**
 * Round 9 (G11a) — `Agent.compactForContext`'s summary-generation phase
 * (`generateCompactionSummary` / `summarizeConversation`, compaction.ts) had
 * NO caller-side catch at all: measured live (session d331c42cea14, sub
 * d16a40a6c275, 2026-09-27T01:30:48Z), step-3.5-flash's
 * `ToolCallMarkupLeakError` — the SAME tool-markup guard that already fires
 * on `proposeCompaction`'s tool-less call, which treats it as non-fatal —
 * propagated straight out of this second, unguarded call, ending the whole
 * sub-session's turn empty ("No assistant messages found to absorb from
 * sub-session"), raw `<tool_call>` markup left on screen.
 *
 * `compactForContext` now wraps `generateCompactionSummary` in a try/catch
 * and returns `false` (skip compaction this turn — the conversation just
 * stays uncompacted for one more turn) on ANY failure, mirroring
 * `proposeCompaction`'s own established non-fatal contract.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";

// Hoisting-safe: declared before vi.mock's factory runs, so the test body can
// assert the mock was actually reached (not bypassed by an earlier bail-out
// in compactForContext, which would ALSO happen to return false).
const mockGenerateCompactionSummary = vi.fn(async () => {
  throw new Error(
    "Provider returned native tool-call markup as its entire answer on a turn with no tools (model=step-3.5-flash); 370 chars suppressed",
  );
});

vi.mock("../compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compaction.js")>();
  return {
    ...actual,
    generateCompactionSummary: (...args: unknown[]) =>
      (mockGenerateCompactionSummary as (...a: unknown[]) => unknown)(...args),
  };
});

import { Agent } from "../orchestrator.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

afterEach(() => {
  vi.clearAllMocks();
  try {
    closeDatabase();
  } catch {
    /* ignore */
  }
});

/**
 * A long, repetitive conversation — big enough (well over
 * DEFAULT_KEEP_RECENT_TOKENS=20_000) that prepareCompaction finds real
 * history to summarize instead of bailing out with keptMessages===everything.
 */
function makeLongConversation(): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < 60; i++) {
    out.push({ role: "user", content: `Question ${i}: ${"detail ".repeat(2000)}` });
    out.push({ role: "assistant", content: `Answer ${i}: ${"context ".repeat(2000)}` });
  }
  return out;
}

describe("Agent.compactForContext — round 9 (G11a): a summary-generation failure never ends the turn", () => {
  it("returns false (skips compaction this turn) instead of throwing when generateCompactionSummary rejects", async () => {
    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, { persistSession: true });
    // biome-ignore lint/suspicious/noExplicitAny: reaching a private method directly is the pragmatic seam for this test
    const a = agent as any;
    a.messages = makeLongConversation();
    a.messageSeqs = a.messages.map((_: unknown, i: number) => i + 1);

    // force=true guarantees the heuristic/proposer branch does not short-circuit
    // before ever reaching generateCompactionSummary.
    const result = await a.compactForContext(
      a.providerId,
      "You are a helpful assistant.",
      8000, // small context window so prepareCompaction has real work to do
      new AbortController().signal,
      undefined,
      true,
    );

    expect(result).toBe(false);
    // Confirms the fixed catch path was actually exercised, not an earlier
    // bail-out (e.g. !preparation) that would also happen to return false.
    expect(mockGenerateCompactionSummary).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("does not persist a compaction row when the summary call fails", async () => {
    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, { persistSession: true });
    const sessionId = agent.getSessionId()!;
    // biome-ignore lint/suspicious/noExplicitAny: reaching a private method directly is the pragmatic seam for this test
    const a = agent as any;
    a.messages = makeLongConversation();
    a.messageSeqs = a.messages.map((_: unknown, i: number) => i + 1);

    await a.compactForContext(
      a.providerId,
      "You are a helpful assistant.",
      8000,
      new AbortController().signal,
      undefined,
      true,
    );

    expect(mockGenerateCompactionSummary).toHaveBeenCalledTimes(1);
    const row = getDatabase().prepare("SELECT * FROM compactions WHERE session_id = ?").get(sessionId);
    expect(row).toBeUndefined();
  }, 15_000);
});
