/**
 * Integration test for mid-debate resume (C) — drives the REAL runDebate
 * generator with a recording CouncilLLM and a seeded checkpoint, asserting the
 * debate skips research + openings + completed rounds, restores the accumulated
 * transcript, continues from the last completed round, and clears the checkpoint
 * on normal completion.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { runDebate } from "../debate.js";
import { buildDebateCheckpoint, DEBATE_CHECKPOINT_FILE, writeDebateCheckpoint } from "../debate-checkpoint.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant } from "../types.js";

const PROBLEM = "Decide X vs Y for a small service.";

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: PROBLEM,
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

function makeParticipants(): CouncilParticipant[] {
  return [
    { role: "architect", model: "deepseek-a", position: "opening A", stance: { name: "architect", lens: "design" } },
    { role: "qa", model: "deepseek-b", position: "opening B", stance: { name: "qa", lens: "risk" } },
  ] as unknown as CouncilParticipant[];
}

function makeConfig(participants: CouncilParticipant[], extra: Partial<CouncilConfig>): CouncilConfig {
  return {
    topic: "X vs Y",
    conversationContext: "",
    leaderModelId: "deepseek-leader",
    participants,
    debatePlan: {
      intentSummary: "Pick the better option.",
      stances: [
        { name: "architect", lens: "design" },
        { name: "qa", lens: "risk" },
      ],
      outputShape: {
        kind: "decision",
        sections: [{ key: "rec", heading: "Recommendation", shape: "list" }],
        guardrails: [],
      },
      plannedRounds: 3,
    },
    researchSkipOverride: true,
    runId: "sess-debate-resume-test",
    ...extra,
  } as unknown as CouncilConfig;
}

describe("mid-debate resume (real runDebate)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "debate-resume-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resumes from the checkpoint: skips openings, continues at round+1, clears checkpoint", async () => {
    const participants = makeParticipants();
    // Seed a checkpoint for a debate that completed 2 of 3 rounds.
    const checkpoint = buildDebateCheckpoint({
      problemStatement: PROBLEM,
      roundCount: 2,
      maxRounds: 3,
      exchangeLogs: new Map([["architect<>qa", ["round-1 turn", "round-2 turn"]]]),
      runningSummary: "prior summary",
      researchFindings: "prior research findings",
      active: participants,
      archive: [{ round: 1, role: "architect" as any, model: "deepseek-a", excerpt: "restored", length: 8 }],
      lastCriteriaMet: [],
      bestCriteriaMetCount: 0,
      roundsSinceProgress: 0,
      nextTopic: undefined,
      savedAt: "2026-07-07T00:00:00.000Z",
    });
    await writeDebateCheckpoint(dir, checkpoint);

    const debateModels: string[] = [];
    let researchCalls = 0;
    const llm = {
      generate: async () => "leader/summary text",
      debate: async (model: string) => {
        debateModels.push(model);
        return { text: `debate turn from ${model}`, toolCalls: [] };
      },
      research: async () => {
        researchCalls++;
        return "fresh findings";
      },
    } as unknown as CouncilLLM;

    const chunks: StreamChunk[] = [];
    const gen = runDebate(
      makeSpec(),
      makeConfig(participants, { checkpointDir: dir, resumeCheckpoint: checkpoint }),
      llm,
    );
    let result: Awaited<ReturnType<typeof gen.next>>["value"] | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
      chunks.push(value as StreamChunk);
    }

    // Research phase was NOT re-run.
    expect(researchCalls).toBe(0);

    // The resume banner was emitted.
    const text = chunks.map((c) => (c as { content?: string }).content ?? "").join("");
    expect(text).toContain("Resuming debate from round 3");

    // Opening statements (round 0) were NOT re-generated.
    const roundZeroMsgs = chunks.filter((c) => {
      const cm = (c as { councilMessage?: { round?: number } }).councilMessage;
      return cm?.round === 0;
    });
    expect(roundZeroMsgs).toHaveLength(0);

    // Only the final round (3) ran — its debate turns fired.
    expect(debateModels.length).toBeGreaterThan(0);

    // Returned state resumed the round counter and restored the prior transcript.
    expect(result?.roundCount).toBe(3);
    expect(result?.exchangeLogs.get("architect<>qa")).toEqual(expect.arrayContaining(["round-1 turn", "round-2 turn"]));

    // Checkpoint deleted on normal completion.
    const files = await fs.readdir(dir);
    expect(files).not.toContain(DEBATE_CHECKPOINT_FILE);
  });

  it("ignores a non-matching checkpoint (different panel) and runs fresh", async () => {
    const participants = makeParticipants();
    const staleCheckpoint = buildDebateCheckpoint({
      problemStatement: PROBLEM,
      roundCount: 2,
      maxRounds: 3,
      exchangeLogs: new Map([["x<>y", ["stale"]]]),
      runningSummary: "stale",
      researchFindings: "stale",
      // Different models → checkpointMatches returns false.
      active: [{ role: "architect" as any, model: "other-model", position: "", stance: { name: "a", lens: "l" } }],
      archive: [],
      lastCriteriaMet: [],
      bestCriteriaMetCount: 0,
      roundsSinceProgress: 0,
      savedAt: "2026-07-07T00:00:00.000Z",
    });

    const llm = {
      generate: async () => "opening/leader text",
      debate: async (model: string) => ({ text: `turn ${model}`, toolCalls: [] }),
      research: async () => "findings",
    } as unknown as CouncilLLM;

    const chunks: StreamChunk[] = [];
    const gen = runDebate(
      makeSpec(),
      makeConfig(participants, { checkpointDir: dir, resumeCheckpoint: staleCheckpoint }),
      llm,
    );
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      chunks.push(value as StreamChunk);
    }

    // A fresh run generates opening statements (round 0), NOT a resume banner.
    const text = chunks.map((c) => (c as { content?: string }).content ?? "").join("");
    expect(text).not.toContain("Resuming debate from round");
    const roundZeroMsgs = chunks.filter((c) => {
      const cm = (c as { councilMessage?: { round?: number } }).councilMessage;
      return cm?.round === 0;
    });
    expect(roundZeroMsgs.length).toBeGreaterThan(0);
  });
});
