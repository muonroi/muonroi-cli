import { describe, expect, it } from "vitest";
import { shouldResumeSubSession } from "../sub-session-resume.js";

/**
 * Round 4 (G9) — pure-function coverage for the resume-vs-fork decision,
 * independent of the real-DB integration test in sub-session-realdb.test.ts.
 * See that file's own describe block for the end-to-end version.
 */
describe("shouldResumeSubSession", () => {
  it("is stale (> 15 min) — never resumes, never even asks the classifier", async () => {
    let classifyCalled = false;
    const decision = await shouldResumeSubSession({
      diffMins: 15.1,
      activeGoal: "seal challenge precommit-working-set-drift",
      newRequest: "seal challenge precommit-working-set-drift, tiếp tục",
      classify: async () => {
        classifyCalled = true;
        return { related: true };
      },
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toMatch(/stale/i);
    expect(classifyCalled).toBe(false);
  });

  it("recent + no recorded goal — fails CLOSED (does not resume), never asks the classifier", async () => {
    let classifyCalled = false;
    const decision = await shouldResumeSubSession({
      diffMins: 2,
      activeGoal: null,
      newRequest: "anything",
      classify: async () => {
        classifyCalled = true;
        return { related: true };
      },
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toMatch(/no recorded goal/i);
    expect(classifyCalled).toBe(false);
  });

  it("recent + blank/whitespace-only goal — fails CLOSED the same as null", async () => {
    const decision = await shouldResumeSubSession({
      diffMins: 2,
      activeGoal: "   ",
      newRequest: "anything",
      classify: async () => ({ related: true }),
    });
    expect(decision.resume).toBe(false);
  });

  it("recent + has a goal + classifier says RELATED — resumes", async () => {
    const decision = await shouldResumeSubSession({
      diffMins: 2,
      activeGoal: "seal challenge precommit-working-set-drift",
      newRequest: "done_check báo lỗi gì vậy",
      classify: async () => ({ related: true, reason: "same challenge, follow-up" }),
    });
    expect(decision.resume).toBe(true);
    expect(decision.reason).toBe("same challenge, follow-up");
  });

  it("recent + has a goal + classifier says UNRELATED — does not resume (the G9 repro)", async () => {
    const decision = await shouldResumeSubSession({
      diffMins: 2,
      activeGoal: "seal challenge precommit-working-set-drift",
      newRequest: "tìm repo Python mới và dựng bài tới hết stage0",
      classify: async () => ({ related: false, reason: "different repo/task entirely" }),
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe("different repo/task entirely");
  });

  it("classifier fails (returns null) — fails CLOSED (does not resume), same as an explicit UNRELATED verdict", async () => {
    const decision = await shouldResumeSubSession({
      diffMins: 2,
      activeGoal: "seal challenge precommit-working-set-drift",
      newRequest: "anything",
      classify: async () => null,
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toMatch(/classification failed/i);
  });

  it("passes the exact newRequest and activeGoal through to the classifier, unmodified", async () => {
    let seen: { newRequest: string; activeGoal: string } | null = null;
    await shouldResumeSubSession({
      diffMins: 1,
      activeGoal: "the original goal",
      newRequest: "the new request",
      classify: async (newRequest, activeGoal) => {
        seen = { newRequest, activeGoal };
        return { related: true };
      },
    });
    expect(seen).toEqual({ newRequest: "the new request", activeGoal: "the original goal" });
  });
});
