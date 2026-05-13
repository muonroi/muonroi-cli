import { describe, expect, it, vi } from "vitest";
import { generateSprintReview } from "../phase-rituals.js";

describe("generateSprintReview (subsystem E)", () => {
  const sprintState = {
    sprintN: 1,
    scoreBefore: 0.3,
    scoreAfter: 0.75,
    criteriaMet: 3,
    totalCriteria: 4,
  };

  it("happy path returns leader summary", async () => {
    const leader = { generate: vi.fn().mockResolvedValue({ content: "We shipped X and learned Y.", costUsd: 0.05 }) };
    const out = await generateSprintReview({
      sprintState,
      phase: { id: "phase-1" } as any,
      leader,
      capUsd: 10,
      remainingUsd: 1,
      backoffDelays: [1, 1, 1],
    });
    expect(out.summary).toContain("X");
    expect(out.usedFallback).toBe(false);
  });

  it("deterministic fallback when leader fails 3×", async () => {
    const leader = { generate: vi.fn().mockRejectedValue(new Error("nope")) };
    const out = await generateSprintReview({
      sprintState,
      phase: { id: "phase-1" } as any,
      leader,
      capUsd: 10,
      remainingUsd: 1,
      backoffDelays: [1, 1, 1],
    });
    expect(out.usedFallback).toBe(true);
    expect(out.summary).toContain("Sprint 1");
    expect(out.summary).toContain("0.30");
    expect(out.summary).toContain("0.75");
    expect(out.summary).toContain("3/4");
  });

  it("deterministic fallback when remainingUsd below floor", async () => {
    const leader = { generate: vi.fn() };
    const out = await generateSprintReview({
      sprintState,
      phase: { id: "phase-1" } as any,
      leader,
      capUsd: 10,
      remainingUsd: 0.05,
      backoffDelays: [1, 1, 1],
    });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(out.usedFallback).toBe(true);
  });

  it("429 backoff exhausted → fallback", async () => {
    const err: any = new Error("rate");
    err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    const out = await generateSprintReview({
      sprintState,
      phase: { id: "phase-1" } as any,
      leader,
      capUsd: 10,
      remainingUsd: 1,
      backoffDelays: [1, 1, 1],
    });
    expect(out.usedFallback).toBe(true);
  });
});
