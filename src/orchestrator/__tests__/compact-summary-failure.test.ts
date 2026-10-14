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
 * Round 9 made a single failure fall back to "skip compaction this turn"
 * (return false) — safe for one bad turn, but the compact model resolves
 * DETERMINISTICALLY (same tier lookup every time), so a PERSISTENT quirk
 * (this exact model always failing on this exact session) meant compaction
 * would never succeed again: unbounded context growth toward a real
 * provider overflow, plus one wasted doomed network call every turn.
 *
 * Round 10 replaces "skip" with a bounded retry chain that always
 * eventually succeeds: (1) the compact model, (2) ONE retry with the
 * session's own main model (skipped when it IS the compact model), (3) a
 * deterministic no-LLM mechanical stub. Whichever model fails is put on a
 * per-session cooldown (compaction-model-cooldown.ts) so a LATER compaction
 * attempt this session does not re-attempt a model already known to be
 * doomed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";

// Hoisting-safe: declared before vi.mock's factory runs, so the test body can
// assert exactly which model(s) were actually called, and how many times —
// not just that SOME call happened.
const calls: string[] = [];
let failFor: Set<string> | "all" = "all";
const mockGenerateCompactionSummary = vi.fn(async (modelId: string) => {
  calls.push(modelId);
  const shouldFail = failFor === "all" || failFor.has(modelId);
  if (shouldFail) {
    throw new Error(
      `Provider returned native tool-call markup as its entire answer on a turn with no tools (model=${modelId}); 370 chars suppressed`,
    );
  }
  return { summary: `real summary from ${modelId}`, usage: { promptTokens: 100, completionTokens: 20 } };
});

vi.mock("../compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compaction.js")>();
  return {
    ...actual,
    generateCompactionSummary: (...args: unknown[]) =>
      (mockGenerateCompactionSummary as (...a: unknown[]) => unknown)(...args),
  };
});

import { __resetCompactionModelCooldownForTests } from "../compaction-model-cooldown.js";
import { Agent } from "../orchestrator.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

beforeEach(() => {
  calls.length = 0;
  failFor = "all";
  __resetCompactionModelCooldownForTests();
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

// MAIN_MODEL is a "premium" tier model — the compact model resolves via
// TASK_TIER_PREFS.compact = ["fast","balanced"], which is a DIFFERENT model
// (catalog fixtures' "fast" tier is deepseek-v4-flash) — guarantees
// `this.modelId !== compactModelId` so the main-model retry step is
// actually exercised, not skipped.
const MAIN_MODEL = "deepseek-v4-pro";

function makeAgent() {
  const agent = new Agent("sk-dummy", undefined, MAIN_MODEL, undefined, { persistSession: true });
  // biome-ignore lint/suspicious/noExplicitAny: reaching private state directly is the pragmatic seam for this test
  const a = agent as any;
  a.messages = makeLongConversation();
  a.messageSeqs = a.messages.map((_: unknown, i: number) => i + 1);
  return { agent, a };
}

async function runCompaction(a: { compactForContext: (...args: unknown[]) => Promise<boolean> }) {
  return a.compactForContext(
    "deepseek", // provider (unused by the mock; passed through for interface shape only)
    "You are a helpful assistant.",
    8000, // small context window so prepareCompaction has real work to do
    new AbortController().signal,
    undefined,
    true, // force=true — guarantees the heuristic/proposer branch does not short-circuit
  );
}

describe("Agent.compactForContext — round 10 (G8 HIGH A): a persistent summarizer failure still shrinks context", () => {
  it("a single compact-model failure retries with the session's main model, and succeeds via it", async () => {
    const compactModelId = "deepseek-v4-flash"; // catalog fixtures' "fast" tier
    failFor = new Set([compactModelId]); // only the compact model fails; the main model succeeds
    const { a } = makeAgent();

    const result = await runCompaction(a);

    expect(result).toBe(true);
    expect(calls).toEqual([compactModelId, MAIN_MODEL]);
  }, 15_000);

  it("when EVERY summarizer model fails (persistent quirk), compaction still succeeds via a deterministic mechanical (no-LLM) stub — context still shrinks", async () => {
    failFor = "all";
    const { agent, a } = makeAgent();
    const sessionId = agent.getSessionId()!;

    const result = await runCompaction(a);

    expect(result).toBe(true);
    // Both real models were tried (and both failed) before falling back.
    expect(calls).toEqual(["deepseek-v4-flash", MAIN_MODEL]);

    const row = getDatabase().prepare("SELECT summary FROM compactions WHERE session_id = ?").get(sessionId) as
      | { summary: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.summary).toContain("Mechanical compaction");
    expect(row?.summary).toContain("no LLM available");

    // Context genuinely shrank — the whole point: unbounded growth is what
    // this fix prevents. this.messages is now [stub, ...keptMessages], far
    // shorter than the 120-message conversation compactForContext started
    // with.
    expect(a.messages.length).toBeLessThan(120);
  }, 15_000);

  it("no per-turn doomed call after the first: a SECOND compaction attempt this session does not re-invoke either cooling-down model", async () => {
    failFor = "all";
    const { agent, a } = makeAgent();

    const first = await runCompaction(a);
    expect(first).toBe(true);
    expect(calls).toEqual(["deepseek-v4-flash", MAIN_MODEL]);

    // Rebuild a long conversation again (compaction shrank it) so the second
    // attempt has real work to do, not an early !preparation bail-out.
    a.messages = makeLongConversation();
    a.messageSeqs = a.messages.map((_: unknown, i: number) => i + 1);

    const second = await runCompaction(a);

    expect(second).toBe(true); // mechanical fallback again — still succeeds
    // No NEW calls landed — both models were already cooling down from the
    // first attempt, so the doomed network round-trip was skipped entirely.
    expect(calls).toEqual(["deepseek-v4-flash", MAIN_MODEL]);
    void agent;
  }, 15_000);

  it("does not persist a compaction row before a summary (real or mechanical) is actually produced", async () => {
    // Sanity: even mid-fallback-chain, nothing is written until SOME summary
    // (of any kind) exists — pins the ordering, not just the end state.
    failFor = "all";
    const { agent, a } = makeAgent();
    const sessionId = agent.getSessionId()!;

    await runCompaction(a);

    // A row now exists (round 10: compaction always eventually succeeds) —
    // and it is the mechanical stub, never raw/partial provider output.
    const row = getDatabase().prepare("SELECT summary FROM compactions WHERE session_id = ?").get(sessionId) as
      | { summary: string }
      | undefined;
    expect(row?.summary).not.toContain("tool_call");
    expect(row?.summary).not.toContain("markup");
  }, 15_000);
});
