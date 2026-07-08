/**
 * Unit tests for the mid-debate checkpoint module (C).
 * Covers the pure serialize/restore/match helpers + atomic file IO round-trip.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDebateCheckpoint,
  checkpointMatches,
  DEBATE_CHECKPOINT_FILE,
  DEBATE_CHECKPOINT_VERSION,
  type DebateCheckpoint,
  deleteDebateCheckpoint,
  readDebateCheckpoint,
  restoreExchangeLogs,
  writeDebateCheckpoint,
} from "../debate-checkpoint.js";
import type { CouncilParticipant } from "../types.js";

function makeActive(): CouncilParticipant[] {
  return [
    {
      role: "architect" as any,
      model: "deepseek-pro",
      position: "pos A",
      stance: { name: "Architect", lens: "design" },
    },
    { role: "qa" as any, model: "opencode/kimi", position: "pos B", stance: { name: "Skeptic", lens: "risk" } },
  ];
}

function makeInput(overrides: Partial<Parameters<typeof buildDebateCheckpoint>[0]> = {}) {
  return {
    problemStatement: "Decide X vs Y",
    roundCount: 3,
    maxRounds: 5,
    exchangeLogs: new Map<string, string[]>([
      ["architect<>qa", ["turn 1", "turn 2"]],
      ["qa<>research", ["turn 3"]],
    ]),
    runningSummary: "summary so far",
    researchFindings: "findings",
    active: makeActive(),
    archive: [{ round: 1, role: "architect" as any, model: "deepseek-pro", excerpt: "ex", length: 100 }],
    lastCriteriaMet: [true, false],
    bestCriteriaMetCount: 1,
    roundsSinceProgress: 0,
    nextTopic: "close criterion 2",
    savedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("debate-checkpoint: build + restore", () => {
  it("serializes the Map exchangeLogs as entry tuples and round-trips them", () => {
    const cp = buildDebateCheckpoint(makeInput());
    expect(cp.version).toBe(DEBATE_CHECKPOINT_VERSION);
    expect(cp.participantModels).toEqual(["deepseek-pro", "opencode/kimi"]);
    expect(Array.isArray(cp.exchangeLogs)).toBe(true);

    const restored = restoreExchangeLogs(cp);
    expect(restored).toBeInstanceOf(Map);
    expect(restored.get("architect<>qa")).toEqual(["turn 1", "turn 2"]);
    expect(restored.get("qa<>research")).toEqual(["turn 3"]);
  });

  it("preserves convergence trackers + active positions", () => {
    const cp = buildDebateCheckpoint(makeInput());
    expect(cp.roundCount).toBe(3);
    expect(cp.maxRounds).toBe(5);
    expect(cp.lastCriteriaMet).toEqual([true, false]);
    expect(cp.bestCriteriaMetCount).toBe(1);
    expect(cp.nextTopic).toBe("close criterion 2");
    expect(cp.active[0]?.position).toBe("pos A");
    expect(cp.active[1]?.stance?.name).toBe("Skeptic");
  });

  it("copies collections defensively (no shared mutable references)", () => {
    const input = makeInput();
    const cp = buildDebateCheckpoint(input);
    input.exchangeLogs.get("architect<>qa")!.push("mutated after build");
    input.lastCriteriaMet.push(true);
    // The checkpoint must not reflect post-build mutation of the inputs.
    expect(cp.exchangeLogs.find(([k]) => k === "architect<>qa")?.[1]).toEqual(["turn 1", "turn 2"]);
    expect(cp.lastCriteriaMet).toEqual([true, false]);
  });
});

describe("debate-checkpoint: checkpointMatches", () => {
  const cp = buildDebateCheckpoint(makeInput());

  it("matches when problem statement + model set agree (order-insensitive)", () => {
    expect(checkpointMatches(cp, "Decide X vs Y", ["opencode/kimi", "deepseek-pro"])).toBe(true);
  });

  it("rejects a different problem statement", () => {
    expect(checkpointMatches(cp, "Decide A vs B", ["deepseek-pro", "opencode/kimi"])).toBe(false);
  });

  it("rejects a different panel (model added/removed)", () => {
    expect(checkpointMatches(cp, "Decide X vs Y", ["deepseek-pro"])).toBe(false);
    expect(checkpointMatches(cp, "Decide X vs Y", ["deepseek-pro", "opencode/kimi", "extra"])).toBe(false);
  });

  it("rejects a version mismatch", () => {
    const stale: DebateCheckpoint = { ...cp, version: 999 as any };
    expect(checkpointMatches(stale, "Decide X vs Y", ["deepseek-pro", "opencode/kimi"])).toBe(false);
  });

  it("rejects roundCount < 1 (nothing to resume)", () => {
    const zero = buildDebateCheckpoint(makeInput({ roundCount: 0 }));
    expect(checkpointMatches(zero, "Decide X vs Y", ["deepseek-pro", "opencode/kimi"])).toBe(false);
  });
});

describe("debate-checkpoint: file IO", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "debate-cp-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes atomically and reads back an identical payload", async () => {
    const cp = buildDebateCheckpoint(makeInput());
    await writeDebateCheckpoint(dir, cp);
    // No temp file left behind.
    const files = await fs.readdir(dir);
    expect(files).toEqual([DEBATE_CHECKPOINT_FILE]);
    const back = await readDebateCheckpoint(dir);
    expect(back).toEqual(cp);
  });

  it("read returns null when the file is absent", async () => {
    expect(await readDebateCheckpoint(dir)).toBeNull();
  });

  it("read returns null on a corrupt (unparseable) file", async () => {
    await fs.writeFile(path.join(dir, DEBATE_CHECKPOINT_FILE), "{not json", "utf8");
    expect(await readDebateCheckpoint(dir)).toBeNull();
  });

  it("read returns null on a version mismatch", async () => {
    const cp = buildDebateCheckpoint(makeInput());
    await fs.writeFile(path.join(dir, DEBATE_CHECKPOINT_FILE), JSON.stringify({ ...cp, version: 999 }), "utf8");
    expect(await readDebateCheckpoint(dir)).toBeNull();
  });

  it("delete removes the checkpoint and is a no-op when already absent", async () => {
    const cp = buildDebateCheckpoint(makeInput());
    await writeDebateCheckpoint(dir, cp);
    await deleteDebateCheckpoint(dir);
    expect(await readDebateCheckpoint(dir)).toBeNull();
    // Second delete must not throw.
    await deleteDebateCheckpoint(dir);
    expect(await readDebateCheckpoint(dir)).toBeNull();
  });
});
