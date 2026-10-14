/**
 * Debt 3 — the legacy fixed-question interview's `buildLiveTuiAsk` (used when
 * `MUONROI_IDEAL_AGENT_INTERVIEW=0` opts out of the default agent-driven
 * gather) used to wait for `respondToQuestion` forever. It IS reachable
 * unattended: opting out of the agent-driven interview says nothing about
 * whether a human is present, and `runGatherPhase` is driven by the same
 * unconditional responder as every other `/ideal` phase. These tests pin the
 * fix: a bounded deadline, a withdrawn card, and a halt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionResponder } from "../../council/types.js";
import type { StreamChunk } from "../../types/index.js";
import {
  buildLiveTuiAsk,
  GATHER_ASK_DEFAULT_TIMEOUT_MS,
  GatherAskTimeoutError,
  resolveGatherAskTimeoutMs,
} from "../gather.js";

const ORIGINAL_ENV = process.env.MUONROI_GATHER_ASK_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.MUONROI_GATHER_ASK_TIMEOUT_MS;
  else process.env.MUONROI_GATHER_ASK_TIMEOUT_MS = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("resolveGatherAskTimeoutMs", () => {
  it("defaults to GATHER_ASK_DEFAULT_TIMEOUT_MS when unset", () => {
    expect(resolveGatherAskTimeoutMs({} as NodeJS.ProcessEnv)).toBe(GATHER_ASK_DEFAULT_TIMEOUT_MS);
  });

  it("honours a valid override", () => {
    expect(resolveGatherAskTimeoutMs({ MUONROI_GATHER_ASK_TIMEOUT_MS: "3000" } as NodeJS.ProcessEnv)).toBe(3000);
  });

  it("falls back to the default and logs on an invalid override", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveGatherAskTimeoutMs({ MUONROI_GATHER_ASK_TIMEOUT_MS: "nope" } as NodeJS.ProcessEnv)).toBe(
      GATHER_ASK_DEFAULT_TIMEOUT_MS,
    );
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});

describe("buildLiveTuiAsk — ask-timeout (Debt 3)", () => {
  it("withdraws the card and throws GatherAskTimeoutError when nobody answers within the deadline", async () => {
    process.env.MUONROI_GATHER_ASK_TIMEOUT_MS = "20"; // 20ms — fast test, real deadline behavior
    const withdraw = vi.fn();
    // Never resolves — simulates an unattended run with nobody at the composer.
    const neverAnswers: QuestionResponder = Object.assign(() => new Promise<string>(() => {}), { withdraw });

    const emitted: StreamChunk[] = [];
    const tuiAsk = buildLiveTuiAsk((c) => emitted.push(c), neverAnswers);

    await expect(tuiAsk("Which database?", ["Postgres", "MySQL"])).rejects.toBeInstanceOf(GatherAskTimeoutError);

    const askedChunk = emitted.find((c) => c.type === "council_question");
    const withdrawnChunk = emitted.find((c) => c.type === "council_question_withdrawn");
    expect(askedChunk).toBeDefined();
    expect(withdrawnChunk).toBeDefined();
    expect(withdrawnChunk?.councilQuestionWithdrawn?.reason).toBe("timeout");
    expect(withdrawnChunk?.councilQuestionWithdrawn?.questionId).toBe(askedChunk?.councilQuestion?.questionId);
    expect(withdraw).toHaveBeenCalledWith(askedChunk?.councilQuestion?.questionId, "timeout");
  });

  it("still answers normally when the responder resolves before the deadline (no regression)", async () => {
    process.env.MUONROI_GATHER_ASK_TIMEOUT_MS = "5000";
    const respond: QuestionResponder = vi.fn().mockResolvedValue("Postgres");
    const emitted: StreamChunk[] = [];
    const tuiAsk = buildLiveTuiAsk((c) => emitted.push(c), respond);

    const answer = await tuiAsk("Which database?", ["Postgres", "MySQL"]);
    expect(answer).toBe("Postgres");
    expect(emitted.some((c) => c.type === "council_question_withdrawn")).toBe(false);
  });

  it("info-only calls (no options) never block on the responder at all", async () => {
    const respond: QuestionResponder = vi.fn(() => new Promise<string>(() => {})); // would hang forever if called
    const emitted: StreamChunk[] = [];
    const tuiAsk = buildLiveTuiAsk((c) => emitted.push(c), respond);

    const answer = await tuiAsk("Just FYI", []);
    expect(answer).toBe("");
    expect(respond).not.toHaveBeenCalled();
  });
});
