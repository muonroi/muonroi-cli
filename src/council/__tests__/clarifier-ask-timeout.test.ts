/**
 * Debt 3 — `runClarification`'s per-question `respondToQuestion` await used to
 * wait forever, like every card waiter except the undebated-criteria gate. It
 * IS reachable unattended (see `CLARIFIER_ASK_DEFAULT_TIMEOUT_MS`'s doc in
 * clarifier.ts): `/ideal`'s default gather phase calls `runClarification`
 * directly with the orchestrator's unconditional question responder, bypassing
 * `council/index.ts`'s `skipClarification` gate entirely. These tests pin the
 * fix: a bounded deadline, a withdrawn card, and a halt — never a silent
 * proceed with an invented answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import {
  CLARIFIER_ASK_DEFAULT_TIMEOUT_MS,
  ClarifierAskTimeoutError,
  resolveClarifierAskTimeoutMs,
  runClarification,
} from "../clarifier.js";
import type { CouncilLLM, QuestionResponder } from "../types.js";

const ORIGINAL_ENV = process.env.MUONROI_CLARIFIER_ASK_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.MUONROI_CLARIFIER_ASK_TIMEOUT_MS;
  else process.env.MUONROI_CLARIFIER_ASK_TIMEOUT_MS = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("resolveClarifierAskTimeoutMs", () => {
  it("defaults to CLARIFIER_ASK_DEFAULT_TIMEOUT_MS when unset", () => {
    expect(resolveClarifierAskTimeoutMs({} as NodeJS.ProcessEnv)).toBe(CLARIFIER_ASK_DEFAULT_TIMEOUT_MS);
  });

  it("honours a valid override", () => {
    expect(resolveClarifierAskTimeoutMs({ MUONROI_CLARIFIER_ASK_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it("allows 0 (do not wait at all)", () => {
    expect(resolveClarifierAskTimeoutMs({ MUONROI_CLARIFIER_ASK_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });

  it("falls back to the default and logs on an invalid override, same validation style as getNoProgressSprintLimit", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      resolveClarifierAskTimeoutMs({ MUONROI_CLARIFIER_ASK_TIMEOUT_MS: "not-a-number" } as NodeJS.ProcessEnv),
    ).toBe(CLARIFIER_ASK_DEFAULT_TIMEOUT_MS);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(resolveClarifierAskTimeoutMs({ MUONROI_CLARIFIER_ASK_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv)).toBe(
      CLARIFIER_ASK_DEFAULT_TIMEOUT_MS,
    );
  });
});

describe("runClarification — ask-timeout (Debt 3)", () => {
  const mockLLM: CouncilLLM = {
    generate: vi.fn().mockResolvedValue('["Which database do you want?"]'),
  } as any;

  it("withdraws the card and throws ClarifierAskTimeoutError when nobody answers within the deadline", async () => {
    process.env.MUONROI_CLARIFIER_ASK_TIMEOUT_MS = "20"; // 20ms — fast test, real deadline behavior
    const withdraw = vi.fn();
    // Never resolves — simulates an unattended run with nobody at the composer.
    const neverAnswers: QuestionResponder = Object.assign(() => new Promise<string>(() => {}), { withdraw });

    const gen = runClarification("Build a thing", "model", "context", neverAnswers, mockLLM);

    const chunks: StreamChunk[] = [];
    let thrown: unknown;
    try {
      for (;;) {
        const next = await gen.next();
        if (next.done) break;
        chunks.push(next.value);
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ClarifierAskTimeoutError);

    const withdrawnChunk = chunks.find((c) => c.type === "council_question_withdrawn");
    expect(withdrawnChunk).toBeDefined();
    expect(withdrawnChunk?.councilQuestionWithdrawn?.reason).toBe("timeout");

    // The withdrawn questionId matches the card that was actually shown.
    const askedChunk = chunks.find((c) => c.type === "council_question");
    expect(withdrawnChunk?.councilQuestionWithdrawn?.questionId).toBe(askedChunk?.councilQuestion?.questionId);

    expect(withdraw).toHaveBeenCalledWith(askedChunk?.councilQuestion?.questionId, "timeout");
  });

  it("still answers normally when the responder resolves before the deadline (no regression)", async () => {
    process.env.MUONROI_CLARIFIER_ASK_TIMEOUT_MS = "5000";
    const respond: QuestionResponder = vi.fn().mockResolvedValue("PostgreSQL");

    const gen = runClarification("Build a thing", "model", "context", respond, mockLLM, undefined, undefined, 1);
    let result: unknown;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    expect(result).toBeDefined();
    expect((respond as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});
