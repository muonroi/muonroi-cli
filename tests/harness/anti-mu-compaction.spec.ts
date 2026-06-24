/**
 * tests/harness/anti-mu-compaction.spec.ts
 *
 * Issue #3 — cognitive-loop self-verify, increment 1.
 *
 * The cost-leak B3/B4 specs prove the compactor keeps cumulative prompt size
 * under a ceiling. They do NOT prove the anti-mù SEMANTICS the agent depends on:
 * that in the SAME multi-round loop a high-value early `read_file` result
 * survives VERBATIM while a low-value result is rewritten to the elision stub,
 * that the elided (not the kept) result is handed to `persistArtifact` for EE
 * rehydration, and that a checkpoint reminder is injected at the compaction
 * boundary. This spec drives a scripted 5-round mock-model `streamText`
 * prepareStep loop through the REAL `compactSubAgentMessages` and asserts those
 * invariants — the first end-to-end coverage of "going blind after compaction".
 *
 * Altitude: in-process, no TUI/Driver/transport, no real LLM, no real EE. The
 * prepareStep closure REPRODUCES (does not import) the persistArtifact +
 * checkpoint-reminder wiring from message-processor.ts:1803-1825 / :1914-1919 at
 * unit altitude — see the DRIFT RISK note on prepareStep below. Increment 2 (the
 * ee_query rehydrate READ leg) is deferred pending the searchEE/getDefaultEEClient
 * seam decision.
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { installMockModel } from "../../src/agent-harness/mock-model.js";
import { attachReminderToMessages, buildCheckpointReminder } from "../../src/orchestrator/scope-reminder.js";
import { compactSubAgentMessages } from "../../src/orchestrator/subagent-compactor.js";
import { cumulativePromptChars, inspectByRole } from "./recording.js";

// Unique marker embedded in the high-value read_file output. If the compactor
// keeps that result verbatim it MUST appear (untouched) in the final prompt.
const HIGH_SENTINEL = "HV_SENTINEL_8f3a2b_kept_verbatim";
// Distinctive slice of buildCheckpointReminder (scope-reminder.ts:227).
const REMINDER_NEEDLE = "tool-artifact id=XXX";

function toolCallChunks(id: string, toolName: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify({ arg: id }) },
    {
      type: "finish",
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
}

function finalTextChunks(text: string): LanguageModelV3StreamPart[] {
  const id = "final";
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    {
      type: "finish",
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
    },
  ];
}

// read_file is in IMPORTANT_TOOL_NAMES → kept verbatim. fake_lowval is NOT and
// carries no high-value content signal → stubbed. Both return ~10k chars so the
// threshold is crossed after round 2.
function buildTools() {
  return {
    read_file: tool({
      description: "Stub high-value read for anti-mù verification.",
      inputSchema: z.object({ arg: z.string() }),
      execute: async ({ arg }: { arg: string }) => `READ src/${arg}\n${HIGH_SENTINEL}\n${"H".repeat(10_000)}`,
    }),
    fake_lowval: tool({
      description: "Stub low-value read that gets compacted.",
      inputSchema: z.object({ arg: z.string() }),
      execute: async ({ arg }: { arg: string }) => `RAW ${arg} low value\n${"L".repeat(20_000)}`,
    }),
  };
}

interface LoopResult {
  handle: ReturnType<typeof installMockModel>;
  uninstall: () => void;
  persistSpy: ReturnType<typeof vi.fn>;
}

async function runAntiMuLoop(opts: { withCompactor?: boolean } = {}): Promise<LoopResult> {
  const withCompactor = opts.withCompactor ?? true;
  // Round 1: high-value read_file (oldest → a real compaction candidate, so its
  // survival is due to isHighValueToolResult, not recency). Rounds 2-4: low-value.
  // keepLastTurns=1 keeps only round 4 by recency, so round 1 (hv) and rounds
  // 2-3 (lv) are all in the compaction zone.
  const handle = installMockModel({
    fixture: {
      stream: [
        toolCallChunks("hv1", "read_file"),
        toolCallChunks("lv1", "fake_lowval"),
        toolCallChunks("lv2", "fake_lowval"),
        toolCallChunks("lv3", "fake_lowval"),
        finalTextChunks("done"),
      ],
    },
  });

  const persistSpy = vi.fn();

  const result = streamText({
    model: handle.model,
    system: "You are the Explore sub-agent. You are read-only.",
    messages: [{ role: "user", content: "trace auth wiring" }],
    tools: buildTools(),
    stopWhen: stepCountIs(10),
    maxRetries: 0,
    // DRIFT RISK: this closure reproduces the production wiring at
    // message-processor.ts:1803-1825 (persistArtifact) + :1914-1919 (compaction
    // note + checkpoint reminder). If that wiring changes (reason string, or the
    // reminder leaves the tool_result channel) this passes while production
    // regresses — increment 2 escalates one assertion to the full orchestrator
    // (spawnCostLeakHarness) so the REAL wiring is exercised at least once.
    ...(withCompactor
      ? {
          prepareStep: ({ messages, stepNumber }: { messages: unknown[]; stepNumber: number }) => {
            if (stepNumber < 1) return undefined;
            const compacted = compactSubAgentMessages(messages as never, {
              thresholdChars: 60_000,
              keepLastTurns: 1,
              persistArtifact: persistSpy,
            });
            const didElide = JSON.stringify(compacted).includes("elided by sub-agent compactor");
            if (!didElide) return { messages: compacted };
            const note = `[context compacted at step ${stepNumber} — older low-value tool results rewritten to stubs. ${buildCheckpointReminder(stepNumber, true)}]`;
            return { messages: attachReminderToMessages(compacted, note) };
          },
        }
      : {}),
  });

  for await (const _ of result.fullStream) {
    // drain so every round-trip's doStream call is recorded
  }

  return { handle, uninstall: handle.uninstall, persistSpy };
}

describe("issue #3 — anti-mù compaction loop (cognitive-loop self-verify, increment 1)", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("keeps the high-value read_file result VERBATIM while stubbing low-value in the same loop", async () => {
    const { handle, uninstall } = await runAntiMuLoop();
    cleanup = uninstall;

    const calls = inspectByRole(handle, "sub-agent");
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const lastPrompt = JSON.stringify(calls[calls.length - 1]!.options.prompt);

    // (a) high-value kept verbatim: its unique sentinel survives, and it was
    // NOT rewritten into a tool_result stub.
    expect(lastPrompt).toContain(HIGH_SENTINEL);
    expect(lastPrompt).not.toMatch(/tool=read_file \(id=hv1\)/);

    // (b) low-value stubbed: the earlier fake_lowval result is elided, and the
    // stub reports the original char length (N = rawPreview.length).
    expect(lastPrompt).toMatch(/tool=fake_lowval \(id=lv1\) — \d+ chars elided by sub-agent compactor/);
  });

  it("hands ONLY the elided low-value result to persistArtifact (rehydrate WRITE leg)", async () => {
    const { persistSpy, uninstall } = await runAntiMuLoop();
    cleanup = uninstall;

    // Fired for the stubbed low-value result with the production reason string.
    expect(persistSpy.mock.calls.some((c) => c[1] === "fake_lowval" && c[3] === "elided-by-compactor")).toBe(true);
    // NEVER fired for the high-value read_file result (it was kept, not elided).
    expect(persistSpy.mock.calls.every((c) => c[1] !== "read_file")).toBe(true);
  });

  it("injects the checkpoint reminder at the compaction boundary, not before round 1", async () => {
    const { handle, uninstall } = await runAntiMuLoop();
    cleanup = uninstall;

    const calls = inspectByRole(handle, "sub-agent");
    // The very first call (step 0, no prior tool results) has no compaction and
    // therefore no reminder.
    expect(JSON.stringify(calls[0]!.options.prompt)).not.toContain(REMINDER_NEEDLE);
    // A later call (after compaction fired) carries the ee_query rehydrate hint.
    expect(calls.some((c) => JSON.stringify(c.options.prompt).includes(REMINDER_NEEDLE))).toBe(true);
  });

  it("still bounds prompt growth vs no-compaction (compaction works even while preserving high-value)", async () => {
    // A hardcoded ceiling is the wrong sentinel here: keeping the high-value
    // read_file result VERBATIM across every round legitimately costs more than
    // the all-low-value cost-leak-b3 baseline. The honest invariant is relative —
    // compaction must materially reduce cumulative size vs running the SAME loop
    // with no compactor. The reduction is smaller than cost-leak-b3's ~50%
    // precisely because one 40k artifact is preserved on purpose.
    const off = await runAntiMuLoop({ withCompactor: false });
    const without = cumulativePromptChars(off.handle);
    off.uninstall();

    const on = await runAntiMuLoop({ withCompactor: true });
    const withCompactor = cumulativePromptChars(on.handle);
    cleanup = on.uninstall;

    expect(withCompactor).toBeLessThan(without * 0.85);
  });
});
