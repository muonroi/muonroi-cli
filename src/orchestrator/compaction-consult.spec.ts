/**
 * C1 / C2 / C3 — "an automatic compaction must ask the main-context agent first,
 * and must honour what that agent says must be preserved."
 *
 * Evidence these tests pin:
 *   - C1: tool-engine.ts consumed `_proactiveCompact.instructions` (the `focus`
 *     argument of the `compact` tool, src/tools/registry.ts) and then called
 *     runCompaction() with no reference to it — the agent could say HOW to
 *     compact and the answer was dropped.
 *   - C2: Orchestrator.compactForContext threaded `customInstructions` into
 *     generateCompactionSummary but only ever set it for sub-sessions, so the
 *     working agent's focus never reached the summarizer. Measured harm:
 *     interaction_logs id=6313, session e28336959a62,
 *     2026-09-09T02:30:54.991Z, 61472 -> 24470 tokens, after which the agent
 *     re-read the files it had been working on.
 *   - C3: no automatic compaction ever asked anybody.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetProactiveCompactForTests,
  beginCompactionTurn,
  getCompactionFocus,
  requestProactiveCompact,
} from "./compact-request.js";
import {
  buildCompactionCustomInstructions,
  evaluateCompactionConsult,
  SUB_SESSION_COMPACTION_INSTRUCTION,
} from "./compaction-consult.js";
import { G2_FIRST_ESCALATION_FILL } from "./subagent-compactor.js";

const baseConsult = {
  wouldCompact: true,
  alreadyAsked: false,
  agentFocus: null as string | null,
  ctxFill: 0.3,
  contextWindowTokens: 128_000,
  estPromptTokens: 38_400,
  stepNumber: 7,
};

describe("C3 — the agent is consulted before an automatic compaction", () => {
  beforeEach(() => {
    __resetProactiveCompactForTests();
  });

  it("defers the compaction by one step and asks, when there is real headroom", () => {
    const d = evaluateCompactionConsult(baseConsult);
    expect(d).not.toBeNull();
    expect(d?.action).toBe("defer");
    // The note must tell the agent WHEN it happens and HOW to answer.
    expect(d?.note).toContain("before your NEXT step");
    expect(d?.note).toContain("`compact` tool with a `focus`");
    expect(d?.note).toMatch(/~30% of this model's context window/);
    expect(d?.note).toContain("128000 tokens");
  });

  it("does NOT defer above the headroom line — it compacts and says so", () => {
    const d = evaluateCompactionConsult({
      ...baseConsult,
      ctxFill: G2_FIRST_ESCALATION_FILL + 0.05,
      estPromptTokens: 83_200,
    });
    expect(d?.action).toBe("ask-and-compact");
    // Must not promise a deferral that did not happen.
    expect(d?.note).toContain("compressed THIS step, already");
    expect(d?.note).not.toContain("before your NEXT step");
  });

  it("treats an UNKNOWN context window as no headroom, never as plenty", () => {
    const d = evaluateCompactionConsult({
      ...baseConsult,
      contextWindowTokens: 0,
      ctxFill: 0,
    });
    expect(d?.action).toBe("ask-and-compact");
    expect(d?.note).toContain("context window is unknown");
  });

  it("stays silent when nothing would be compacted", () => {
    expect(evaluateCompactionConsult({ ...baseConsult, wouldCompact: false })).toBeNull();
  });

  it("stays silent once asked — the note must not fire every step", () => {
    expect(evaluateCompactionConsult({ ...baseConsult, alreadyAsked: true })).toBeNull();
  });

  it("stays silent when the agent has already stated a focus", () => {
    expect(
      evaluateCompactionConsult({ ...baseConsult, agentFocus: "keep src/orchestrator/tool-engine.ts:2180-2260" }),
    ).toBeNull();
  });

  it("uses the compactor's own first-escalation fill (0.6) as the headroom line", () => {
    // Derived from computeDynamicParams in subagent-compactor.ts: 0.6 is where
    // the compactor FIRST starts shrinking the verbatim keep window.
    expect(G2_FIRST_ESCALATION_FILL).toBe(0.6);
    expect(evaluateCompactionConsult({ ...baseConsult, ctxFill: 0.59 })?.action).toBe("defer");
    expect(evaluateCompactionConsult({ ...baseConsult, ctxFill: 0.6 })?.action).toBe("ask-and-compact");
  });

  it("is wired into the auto-compaction branch of tool-engine prepareStep", () => {
    const src = readFileSync(join(process.cwd(), "src/orchestrator/tool-engine.ts"), "utf8");
    expect(src).toContain("evaluateCompactionConsult(");
    expect(src).toContain("estimateCompactionPressure(");
    // Deferral must return the UN-compacted history with the note attached.
    expect(src).toContain('_consult?.action === "defer"');
    expect(src).toContain("compactConsultAskedThisTurn = true");
  });
});

describe("C2 — the agent's focus reaches the summarizing compaction", () => {
  beforeEach(() => {
    __resetProactiveCompactForTests();
  });

  it("carries the focus into customInstructions", () => {
    const out = buildCompactionCustomInstructions({
      isSubSession: false,
      agentFocus: "keep src/orchestrator/orchestrator.ts:1839-1852 and the tsc error text",
    });
    expect(out).toBeDefined();
    expect(out).toContain("AGENT PRESERVATION FOCUS:");
    expect(out).toContain("src/orchestrator/orchestrator.ts:1839-1852");
  });

  it("MERGES with the sub-session instruction rather than replacing it", () => {
    const out = buildCompactionCustomInstructions({
      isSubSession: true,
      agentFocus: "keep the failing vitest output",
    });
    expect(out).toContain(SUB_SESSION_COMPACTION_INSTRUCTION);
    expect(out).toContain("keep the failing vitest output");
  });

  it("is byte-identical to the old behaviour when there is nothing to say", () => {
    expect(buildCompactionCustomInstructions({ isSubSession: false, agentFocus: null })).toBeUndefined();
    expect(buildCompactionCustomInstructions({ isSubSession: false, agentFocus: "   " })).toBeUndefined();
    expect(buildCompactionCustomInstructions({ isSubSession: true, agentFocus: null })).toBe(
      SUB_SESSION_COMPACTION_INSTRUCTION,
    );
  });

  it("is wired into Orchestrator.compactForContext", () => {
    const src = readFileSync(join(process.cwd(), "src/orchestrator/orchestrator.ts"), "utf8");
    expect(src).toContain("buildCompactionCustomInstructions({ isSubSession, agentFocus: getCompactionFocus() })");
    // ...and the result is what generateCompactionSummary receives.
    expect(src).toMatch(/generateCompactionSummary\(\s*compactModelId,\s*preparation,\s*customInstructions,/);
  });
});

describe("the compact tool's focus is retained for both compaction paths", () => {
  beforeEach(() => {
    __resetProactiveCompactForTests();
  });

  it("survives consumeProactiveCompact so the summarizing path can still read it", () => {
    requestProactiveCompact("keep src/a.ts:10-40 open");
    expect(getCompactionFocus()).toBe("keep src/a.ts:10-40 open");
  });

  it("is not erased by a later bare compact() with no focus", () => {
    requestProactiveCompact("keep src/a.ts:10-40 open");
    requestProactiveCompact(null);
    expect(getCompactionFocus()).toBe("keep src/a.ts:10-40 open");
  });

  it("is scoped to one user turn", () => {
    requestProactiveCompact("keep src/a.ts:10-40 open");
    beginCompactionTurn();
    expect(getCompactionFocus()).toBeNull();
  });
});
