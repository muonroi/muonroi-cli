import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRun } from "../../flow/run-manager.js";
import { readManifest, writeManifest, appendIteration, readIterations, markIterationCrashed } from "../artifact-io.js";
import type { ProductRunManifest, IterationState } from "../types.js";

describe("product-loop artifact-io", () => {
  let tmpDir: string;
  let runId: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-artifact-test-"));
    const run = await createRun(tmpDir);
    runId = run.id;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should round-trip manifest", async () => {
    const manifest: ProductRunManifest = {
      idea: "A revolutionary AI agent",
      capUsd: 50,
      maxSprints: 8,
      doneThreshold: 0.9,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      stack: "TypeScript, Vitest"
    };

    await writeManifest(tmpDir, runId, manifest);
    const loaded = await readManifest(tmpDir, runId);
    
    expect(loaded).toEqual(manifest);
  });

  it("should append and read iterations", async () => {
    const it1: IterationState = {
      sprintN: 1,
      stage: "judge",
      scoreBefore: 0.0,
      scoreAfter: 0.4,
      criteriaMet: 1,
      criteriaPartial: 1,
      criteriaUnmet: 4,
      costUsd: 0.12,
      lastVerifyResult: "PASS"
    };

    const it2: IterationState = {
      sprintN: 2,
      stage: "judge",
      scoreBefore: 0.4,
      scoreAfter: 0.6,
      criteriaMet: 3,
      criteriaPartial: 1,
      criteriaUnmet: 2,
      costUsd: 0.25,
      lastVerifyResult: "FAIL"
    };

    await appendIteration(tmpDir, runId, it1);
    await appendIteration(tmpDir, runId, it2);

    const iterations = await readIterations(tmpDir, runId);
    expect(iterations.length).toBe(2);
    expect(iterations[0]).toEqual(it1);
    expect(iterations[1]).toEqual(it2);
  });

  it("should mark iteration crashed", async () => {
    const it1: IterationState = {
      sprintN: 1,
      stage: "implement",
      scoreBefore: 0.0,
      scoreAfter: 0.0,
      criteriaMet: 0,
      criteriaPartial: 0,
      criteriaUnmet: 6,
      costUsd: 0.05,
      lastVerifyResult: "NONE"
    };

    await appendIteration(tmpDir, runId, it1);
    await markIterationCrashed(tmpDir, runId, 1);

    const iterations = await readIterations(tmpDir, runId);
    expect(iterations[0].crashed).toBe(true);
  });

  it("should return null for empty manifest", async () => {
    const loaded = await readManifest(tmpDir, runId);
    expect(loaded).toBeNull();
  });
});
