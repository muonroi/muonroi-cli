/**
 * U1 — the B4 mid-debate escalation card reuses `phase: "post-debate"` to
 * ride the same UI renderer as the post-debate card, so it fired the SAME
 * duplicate-echo defect (project_askcard_transcript_qa_pairing) as the
 * original U1 slice: the interactive UI already renders one paired
 * question+answer transcript record via `buildAskcardAnswerEntry`
 * (`use-app-logic.tsx`), and `runEscalationPrompt`'s own `\n  ↳ <answer>\n`
 * echo duplicated it. Fixed by gating the "rescope" and "accept" echoes on
 * `QuestionResponder.wasAnsweredByCard` — the same mechanism the original U1
 * clarify/post-debate/refine/plan-confirm sites use.
 *
 * The "extend" branch's own content line is deliberately NOT gated: it
 * reports `grantedRounds`/the new round ceiling, information the UI's paired
 * question+answer record does not carry, so it is not a literal duplicate of
 * the card's answer label (unlike the bare "↳ <choice>" lines).
 */
import { describe, expect, it, vi } from "vitest";
import { runEscalationPrompt } from "../debate.js";
import type { QuestionResponder } from "../types.js";

async function drain(gen: ReturnType<typeof runEscalationPrompt>): Promise<{
  text: string;
  result: { action: "extend" | "accept" | "rescope"; grantedRounds: number };
}> {
  let text = "";
  let result: { action: "extend" | "accept" | "rescope"; grantedRounds: number } | undefined;
  let done = false;
  while (!done) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      done = true;
    } else if (next.value.type === "content" && typeof next.value.content === "string") {
      text += next.value.content;
    }
  }
  return { text, result: result! };
}

const baseOpts = {
  openCriteria: ["Criterion A"],
  pinnedUnmet: 1,
  stuck: false,
  atAbsoluteMax: false,
  currentMax: 3,
};

describe("U1 — escalation prompt echo suppression (headless vs card-answered)", () => {
  it("headless-style responder (no wasAnsweredByCard) keeps the ↳ echo on rescope — its only record of the answer", async () => {
    const headlessResponder: QuestionResponder = vi.fn().mockResolvedValue("escalate_rescope");
    const { text, result } = await drain(runEscalationPrompt({ ...baseOpts, respondToQuestion: headlessResponder }));
    expect(text).toContain("↳ Narrow the scope");
    expect(result.action).toBe("rescope");
  });

  it("headless-style responder keeps the ↳ echo on accept (unmatched answer falls through to accept)", async () => {
    const headlessResponder: QuestionResponder = vi.fn().mockResolvedValue("whatever");
    const { text, result } = await drain(runEscalationPrompt({ ...baseOpts, respondToQuestion: headlessResponder }));
    expect(text).toContain("↳ Accepted the current outcome");
    expect(result.action).toBe("accept");
  });

  it("card-answered responder (wasAnsweredByCard → true) suppresses the ↳ echo on rescope", async () => {
    const cardResponder = vi.fn().mockResolvedValue("escalate_rescope") as unknown as QuestionResponder;
    cardResponder.wasAnsweredByCard = vi.fn().mockReturnValue(true);
    const { text, result } = await drain(runEscalationPrompt({ ...baseOpts, respondToQuestion: cardResponder }));
    expect(text).not.toContain("↳");
    expect(result.action).toBe("rescope");
    expect(cardResponder.wasAnsweredByCard).toHaveBeenCalledTimes(1);
  });

  it("card-answered responder suppresses the ↳ echo on accept", async () => {
    const cardResponder = vi.fn().mockResolvedValue("whatever") as unknown as QuestionResponder;
    cardResponder.wasAnsweredByCard = vi.fn().mockReturnValue(true);
    const { text, result } = await drain(runEscalationPrompt({ ...baseOpts, respondToQuestion: cardResponder }));
    expect(text).not.toContain("↳");
    expect(result.action).toBe("accept");
    expect(cardResponder.wasAnsweredByCard).toHaveBeenCalledTimes(1);
  });

  it("the 'extend' branch's line is NOT gated by wasAnsweredByCard — it carries information the card does not", async () => {
    const cardResponder = vi.fn().mockResolvedValue("escalate_extend") as unknown as QuestionResponder;
    cardResponder.wasAnsweredByCard = vi.fn().mockReturnValue(true);
    const { text, result } = await drain(runEscalationPrompt({ ...baseOpts, respondToQuestion: cardResponder }));
    expect(text).toContain("User extended debate by");
    expect(result.action).toBe("extend");
    // Still consumed exactly once, even though this branch does not gate on it.
    expect(cardResponder.wasAnsweredByCard).toHaveBeenCalledTimes(1);
  });
});
