/**
 * F8 — the undebated-criteria gate.
 *
 * The defect being pinned (run `mttwpmu8ee5b`, sessions 18cd54cdb9c9 /
 * c712c4cb6908 / 9d9f363c14fa): the leader closed the debate saying in plain
 * words that nobody had discussed the NuGet-packaging criterion, and 23 seconds
 * later the loop entered scoping and planned a sprint around exactly that
 * criterion.
 *
 * The distinction this suite exists to defend is between:
 *   - a criterion the panel ARGUED and failed to resolve  → normal, no gate;
 *   - a criterion NO panelist ever addressed              → gate.
 */

import { describe, expect, it, vi } from "vitest";
import { COUNCIL_ANSWER_DISMISSED } from "../../council/types.js";
import type { CouncilStanceRow, StreamChunk } from "../../types/index.js";
import {
  buildUndebatedQuestion,
  findUndebatedCriteria,
  resolveUndebatedGateTimeoutMs,
  runUndebatedCriteriaGate,
  UNDEBATED_GATE_DEFAULT_TIMEOUT_MS,
  UNDEBATED_OPTION_ACCEPT,
  UNDEBATED_OPTION_COUNCIL,
  UNDEBATED_OPTION_NARROW,
  type UndebatedGateDecision,
} from "../undebated-criteria-gate.js";

const ROSTER = ["architect", "engineer", "researcher"];

function row(criterion: string, met: boolean, marks: Array<"+" | "-" | "~" | null>): CouncilStanceRow {
  const stances: CouncilStanceRow["stances"] = {};
  ROSTER.forEach((r, i) => {
    stances[r] = marks[i] ?? null;
  });
  return { criterion, met, stances };
}

// The two criteria the measured run actually carried past the gate.
const NUGET = "Bộ analyzer có thể được đóng gói thành NuGet package TCIS.CodeStandards.Analyzers";
const VS_WARNING = "Visual Studio hiển thị warning khi parameter, argument không đúng chuẩn";

describe("findUndebatedCriteria — the signal", () => {
  it("fires on a criterion every panelist left null (the NuGet case)", () => {
    const rows = [row(NUGET, false, [null, null, null])];
    expect(findUndebatedCriteria(rows)).toEqual([{ index: 0, criterion: NUGET }]);
  });

  it("does NOT fire on an argued-but-unmet criterion", () => {
    // Panel fought over it and did not converge. That is a normal debate
    // outcome, not silence — the leader's closing verdict already covers it.
    const rows = [row(VS_WARNING, false, ["+", "-", "~"])];
    expect(findUndebatedCriteria(rows)).toEqual([]);
  });

  it("does NOT fire when a single panelist spoke and the rest stayed silent", () => {
    const rows = [row(VS_WARNING, false, [null, "-", null])];
    expect(findUndebatedCriteria(rows)).toEqual([]);
  });

  it("does NOT fire when every criterion was engaged", () => {
    const rows = [row(VS_WARNING, true, ["+", "+", "+"]), row("Another", false, ["-", "~", null])];
    expect(findUndebatedCriteria(rows)).toEqual([]);
  });

  it("does NOT fire on a MET criterion, even with no stances recorded", () => {
    expect(findUndebatedCriteria([row(NUGET, true, [null, null, null])])).toEqual([]);
  });

  it("treats an EMPTY stance map as missing data, not silence", () => {
    // No roster was passed to the leader, so nothing is known about who spoke.
    // Firing here would turn "we don't know" into "nobody spoke" — the exact
    // fabrication src/council/stance.ts exists to prevent.
    const rows: CouncilStanceRow[] = [{ criterion: NUGET, met: false, stances: {} }];
    expect(findUndebatedCriteria(rows)).toEqual([]);
  });

  it("returns [] when the debate produced no stance rows at all", () => {
    expect(findUndebatedCriteria(undefined)).toEqual([]);
    expect(findUndebatedCriteria([])).toEqual([]);
  });

  it("reports the criterion INDEX so the caller can drop the right one", () => {
    const rows = [
      row(VS_WARNING, false, ["+", "-", null]),
      row("engaged", true, ["+", "+", "+"]),
      row(NUGET, false, [null, null, null]),
    ];
    expect(findUndebatedCriteria(rows)).toEqual([{ index: 2, criterion: NUGET }]);
  });
});

describe("buildUndebatedQuestion — names the criteria, not a count", () => {
  it("puts the full criterion text in the card context", () => {
    const card = buildUndebatedQuestion([
      { index: 0, criterion: NUGET },
      { index: 3, criterion: VS_WARNING },
    ]);
    // "2 of 5 unmet" is what the old closing message said, and it is why nobody
    // acted on it. The text itself must be present.
    expect(card.context).toContain(NUGET);
    expect(card.context).toContain(VS_WARNING);
    expect(card.content).toContain("Bộ analyzer");
  });

  it("offers debate-further / narrow / accept as real choices", () => {
    const card = buildUndebatedQuestion([{ index: 0, criterion: NUGET }]);
    expect(card.options.map((o) => o.value)).toEqual([
      UNDEBATED_OPTION_COUNCIL,
      UNDEBATED_OPTION_NARROW,
      UNDEBATED_OPTION_ACCEPT,
    ]);
  });
});

describe("resolveUndebatedGateTimeoutMs", () => {
  it("defaults to the generous human deadline", () => {
    expect(resolveUndebatedGateTimeoutMs({})).toBe(UNDEBATED_GATE_DEFAULT_TIMEOUT_MS);
    expect(resolveUndebatedGateTimeoutMs({ MUONROI_UNDEBATED_GATE_TIMEOUT_MS: "  " })).toBe(
      UNDEBATED_GATE_DEFAULT_TIMEOUT_MS,
    );
    expect(resolveUndebatedGateTimeoutMs({ MUONROI_UNDEBATED_GATE_TIMEOUT_MS: "nonsense" })).toBe(
      UNDEBATED_GATE_DEFAULT_TIMEOUT_MS,
    );
  });

  it("honours 0 so CI resolves immediately instead of stalling ten minutes", () => {
    expect(resolveUndebatedGateTimeoutMs({ MUONROI_UNDEBATED_GATE_TIMEOUT_MS: "0" })).toBe(0);
  });
});

async function drain(
  gen: ReturnType<typeof runUndebatedCriteriaGate>,
): Promise<{ chunks: StreamChunk[]; decision: UndebatedGateDecision }> {
  const chunks: StreamChunk[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, decision: value as UndebatedGateDecision };
    chunks.push(value as StreamChunk);
  }
}

describe("runUndebatedCriteriaGate — the askcard", () => {
  const undebated = [{ index: 0, criterion: NUGET }];

  it("emits a council_question (the surface that becomes askcard-open)", async () => {
    const respondToQuestion = vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT);
    const { chunks, decision } = await drain(
      runUndebatedCriteriaGate({ undebated, respondToQuestion, timeoutMs: 5_000 }),
    );
    const card = chunks.find((c) => c.type === "council_question");
    expect(card).toBeDefined();
    expect(card?.councilQuestion?.options?.length).toBe(3);
    expect(card?.councilQuestion?.context).toContain(NUGET);
    expect(respondToQuestion).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ action: "accept", unattended: false });
  });

  it("maps each option to its action", async () => {
    for (const [answer, action] of [
      [UNDEBATED_OPTION_COUNCIL, "council"],
      [UNDEBATED_OPTION_NARROW, "narrow"],
      [UNDEBATED_OPTION_ACCEPT, "accept"],
    ] as const) {
      const { decision } = await drain(
        runUndebatedCriteriaGate({
          undebated,
          respondToQuestion: vi.fn().mockResolvedValue(answer),
          timeoutMs: 5_000,
        }),
      );
      expect(decision).toMatchObject({ action, unattended: false });
    }
  });

  it.each([
    ["an unrecognized value (UI drift)", "whatever"],
    ["an empty submit", ""],
    ["an Escape dismissal", COUNCIL_ANSWER_DISMISSED],
  ])("stops on %s — proceeding must be asked for by name", async (_label, answer) => {
    const { decision } = await drain(
      runUndebatedCriteriaGate({
        undebated,
        respondToQuestion: vi.fn().mockResolvedValue(answer),
        timeoutMs: 5_000,
      }),
    );
    expect(decision).toMatchObject({ action: "council", unattended: false });
  });

  it("an UNATTENDED run stops rather than proceeding blind", async () => {
    // Nobody ever answers — the promise never settles, exactly as
    // CouncilManager.createQuestionResponder behaves with no UI attached.
    const neverAnswers = vi.fn(() => new Promise<string>(() => {}));
    const { chunks, decision } = await drain(
      runUndebatedCriteriaGate({ undebated, respondToQuestion: neverAnswers, timeoutMs: 20 }),
    );
    expect(decision).toMatchObject({ action: "council", unattended: true, answer: "" });
    // Still emitted the card first, so an event-stream watcher saw askcard-open.
    expect(chunks.some((c) => c.type === "council_question")).toBe(true);
  });

  it("timeoutMs=0 resolves immediately to the unattended default", async () => {
    const neverAnswers = vi.fn(() => new Promise<string>(() => {}));
    const { decision } = await drain(
      runUndebatedCriteriaGate({ undebated, respondToQuestion: neverAnswers, timeoutMs: 0 }),
    );
    expect(decision).toMatchObject({ action: "council", unattended: true });
    expect(neverAnswers).not.toHaveBeenCalled();
  });

  it("a THROWING responder applies the unattended default instead of crashing", async () => {
    const { decision } = await drain(
      runUndebatedCriteriaGate({
        undebated,
        respondToQuestion: vi.fn().mockRejectedValue(new Error("channel dead")),
        timeoutMs: 5_000,
      }),
    );
    expect(decision).toMatchObject({ action: "council", unattended: true });
  });
});
