import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSprintReview, runRetro, runStandup, shouldRunStandup } from "../phase-rituals.js";

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

describe("runRetro (subsystem E)", () => {
  const sprintState = { sprintN: 1, scoreBefore: 0.3, scoreAfter: 0.75, criteriaMet: 3, totalCriteria: 4 };

  it("returns LessonsLearned within shape limits", async () => {
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          wentWell: Array.from({ length: 8 }, (_, i) => `Win ${i}`),
          toImprove: ["A".repeat(300)],
          nextSprintFocus: "B".repeat(400),
        }),
        costUsd: 0.05,
      }),
    };
    const out = await runRetro({ sprintState, leader, capUsd: 10, remainingUsd: 1, backoffDelays: [1, 1, 1] });
    expect(out.wentWell.length).toBeLessThanOrEqual(5);
    expect(out.toImprove[0].length).toBeLessThanOrEqual(200);
    expect(out.nextSprintFocus.length).toBeLessThanOrEqual(300);
  });

  it("throws RetroSkippedBudget when remaining below floor", async () => {
    const leader = { generate: vi.fn() };
    await expect(
      runRetro({ sprintState, leader, capUsd: 10, remainingUsd: 0.01, backoffDelays: [1, 1, 1] }),
    ).rejects.toThrow(/RetroSkippedBudget/);
  });

  it("throws on 3 429s (caller marks Retro Skipped)", async () => {
    const err: any = new Error("rate");
    err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    await expect(
      runRetro({ sprintState, leader, capUsd: 10, remainingUsd: 1, backoffDelays: [1, 1, 1] }),
    ).rejects.toThrow();
  });
});

describe("shouldRunStandup boundary cases (subsystem E)", () => {
  let flowDir: string;
  const runId = "r1";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `standup-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("returns false when lastActivityUtc is null", async () => {
    expect(await shouldRunStandup(null, flowDir, runId)).toBe(false);
  });

  it("returns false at exactly 1h elapsed", async () => {
    const exact = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(await shouldRunStandup(exact, flowDir, runId)).toBe(false);
  });

  it("returns false at 1h + 1ms when no phase is in-progress", async () => {
    const past = new Date(Date.now() - (60 * 60 * 1000 + 1)).toISOString();
    expect(await shouldRunStandup(past, flowDir, runId)).toBe(false);
  });

  it("returns true at 1h+1s elapsed AND a phase is in-progress", async () => {
    const past = new Date(Date.now() - (60 * 60 * 1000 + 1000)).toISOString();
    const state = {
      version: 1,
      currentPhaseId: "phase-1",
      phasesStatus: { "phase-1": "in-progress" },
      lastActivityUtc: past,
    };
    await fs.writeFile(
      path.join(flowDir, "runs", runId, "state.md"),
      `## Phase Plan State\n\n${JSON.stringify(state)}\n`,
    );
    expect(await shouldRunStandup(past, flowDir, runId)).toBe(true);
  });

  it("returns false when all phases done even after 2h", async () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const state = { version: 1, currentPhaseId: null, phasesStatus: { "phase-1": "done" }, lastActivityUtc: past };
    await fs.writeFile(
      path.join(flowDir, "runs", runId, "state.md"),
      `## Phase Plan State\n\n${JSON.stringify(state)}\n`,
    );
    expect(await shouldRunStandup(past, flowDir, runId)).toBe(false);
  });
});

describe("runStandup (subsystem E)", () => {
  let flowDir: string;
  const runId = "r1";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `standup-r-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("returns null when remaining below floor", async () => {
    const leader = { generate: vi.fn() };
    const out = await runStandup({ flowDir, runId, leader, capUsd: 10, remainingUsd: 0.05, backoffDelays: [1, 1, 1] });
    expect(out).toBeNull();
    expect(leader.generate).not.toHaveBeenCalled();
  });

  it("returns null when standup hard-cap (3) reached", async () => {
    await fs.writeFile(path.join(flowDir, "runs", runId, "state.md"), "## Standup Count\n\n3\n");
    const leader = { generate: vi.fn() };
    const out = await runStandup({ flowDir, runId, leader, capUsd: 10, remainingUsd: 5, backoffDelays: [1, 1, 1] });
    expect(out).toBeNull();
  });

  it("returns StandupOutcome on successful leader response (council stub)", async () => {
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ blockers: ["B1"], decisions: ["D1"], nextStep: "continue phase-1" }),
        costUsd: 0.1,
      }),
    };
    const state = {
      version: 1,
      currentPhaseId: "phase-1",
      phasesStatus: { "phase-1": "in-progress" },
      lastActivityUtc: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(flowDir, "runs", runId, "state.md"),
      `## Phase Plan State\n\n${JSON.stringify(state)}\n`,
    );
    const out = await runStandup({ flowDir, runId, leader, capUsd: 10, remainingUsd: 5, backoffDelays: [1, 1, 1] });
    expect(out).not.toBeNull();
    expect(out!.blockers).toEqual(["B1"]);
  });
});
