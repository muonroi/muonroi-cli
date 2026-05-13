// src/product-loop/__tests__/discovery-persistence.test.ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { initDiscoveryState, readDiscoveryState, saveDiscoveryAnswer } from "../discovery-persistence.js";

async function mktmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `disc-pers-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("discovery-persistence — state IO", () => {
  let flowDir: string;
  const runId = "run-test";

  beforeEach(async () => {
    flowDir = await mktmp();
  });

  it("returns null when state.md absent", async () => {
    const state = await readDiscoveryState(flowDir, runId);
    expect(state).toBeNull();
  });

  it("initDiscoveryState writes a fresh state with classification", async () => {
    await initDiscoveryState(flowDir, runId, {
      classification: "greenfield",
      prefillSource: { fromDetection: [], fromPrompt: ["productType"] },
    });
    const state = await readDiscoveryState(flowDir, runId);
    expect(state?.phase).toBe("interview");
    expect(state?.classification).toBe("greenfield");
    expect(state?.questionsAsked).toEqual([]);
    expect(state?.userGatePassed).toBe(false);
  });

  it("saveDiscoveryAnswer appends to questionsAnswered idempotently", async () => {
    await initDiscoveryState(flowDir, runId, {
      classification: "greenfield",
      prefillSource: { fromDetection: [], fromPrompt: [] },
    });
    await saveDiscoveryAnswer(flowDir, runId, "productType", "saas");
    await saveDiscoveryAnswer(flowDir, runId, "productType", "saas"); // idempotent
    const state = await readDiscoveryState(flowDir, runId);
    expect(state?.questionsAnswered).toEqual(["productType"]);
    expect(state?.answers.productType).toBe("saas");
  });
});
