// src/product-loop/__tests__/discovery-persistence.test.ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireRunLock,
  buildProjectContextFromState,
  initDiscoveryState,
  markUserGatePassed,
  readDiscoveryState,
  readProjectContext,
  releaseRunLock,
  resumeArtifactWriteIfNeeded,
  saveDiscoveryAnswer,
  writeProjectContext,
} from "../discovery-persistence.js";

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

describe("discovery-persistence — artifact + resume", () => {
  let flowDir: string;
  const runId = "run-art";

  beforeEach(async () => {
    flowDir = await mktmp();
  });

  it("writeProjectContext + readProjectContext round-trip", async () => {
    const ctx = {
      version: 1 as const,
      schemaName: "project-context" as const,
      generatedAt: "2026-05-13T10:00:00Z",
      idea: "test",
      detection: {
        isGitRepo: false,
        hasCommitHistory: false,
        srcFileCount: 0,
        manifests: [],
        languages: [],
        frameworks: [],
        classification: "greenfield" as const,
      },
      context: {
        productType: "saas" as const,
        targetPlatform: ["web" as const],
        audience: { persona: "devs", scale: "1k-100k" as const, geography: "SEA" },
        backendArchitecture: "monolith" as const,
        backendStack: { language: "TS", framework: "Nest" },
        dbStrategy: { mode: "greenfield" as const, engine: "PG" },
      },
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only" as const, feEnforced: true } },
      userOverrides: [],
    };
    await writeProjectContext(flowDir, runId, ctx);
    const read = await readProjectContext(flowDir, runId);
    expect(read?.idea).toBe("test");
    expect(read?.version).toBe(1);
  });

  it("buildProjectContextFromState derives artifact from saved answers", async () => {
    await initDiscoveryState(flowDir, runId, {
      classification: "greenfield",
      prefillSource: { fromDetection: [], fromPrompt: [] },
    });
    await saveDiscoveryAnswer(flowDir, runId, "productType", "saas");
    const state = await readDiscoveryState(flowDir, runId);
    const ctx = buildProjectContextFromState(state!, "idea text", {
      isGitRepo: false,
      hasCommitHistory: false,
      srcFileCount: 0,
      manifests: [],
      languages: [],
      frameworks: [],
      classification: "greenfield",
    });
    expect(ctx.context.productType).toBe("saas");
    expect(ctx.idea).toBe("idea text");
  });

  it("resume from awaiting-artifact-write re-derives and writes idempotently", async () => {
    await initDiscoveryState(flowDir, runId, {
      classification: "greenfield",
      prefillSource: { fromDetection: [], fromPrompt: [] },
    });
    await saveDiscoveryAnswer(flowDir, runId, "productType", "saas");
    await saveDiscoveryAnswer(flowDir, runId, "targetPlatform", ["web"]);
    await saveDiscoveryAnswer(flowDir, runId, "audience", { persona: "x", scale: "1k-100k", geography: "SEA" });
    await saveDiscoveryAnswer(flowDir, runId, "backendArchitecture", "monolith");
    await saveDiscoveryAnswer(flowDir, runId, "backendStack", { language: "TS", framework: "Nest" });
    await saveDiscoveryAnswer(flowDir, runId, "dbStrategy", { mode: "greenfield", engine: "PG" });
    await markUserGatePassed(flowDir, runId);

    // simulate crash: artifact not written yet
    expect(await readProjectContext(flowDir, runId)).toBeNull();

    await resumeArtifactWriteIfNeeded(flowDir, runId, "idea text", {
      isGitRepo: false,
      hasCommitHistory: false,
      srcFileCount: 0,
      manifests: [],
      languages: [],
      frameworks: [],
      classification: "greenfield",
    });
    const state = await readDiscoveryState(flowDir, runId);
    expect(state?.phase).toBe("done");
    expect(await readProjectContext(flowDir, runId)).not.toBeNull();

    // calling again is a no-op
    await resumeArtifactWriteIfNeeded(flowDir, runId, "idea text", {
      isGitRepo: false,
      hasCommitHistory: false,
      srcFileCount: 0,
      manifests: [],
      languages: [],
      frameworks: [],
      classification: "greenfield",
    });
  });

  it("lockfile prevents concurrent runs", async () => {
    await acquireRunLock(flowDir, runId);
    await expect(acquireRunLock(flowDir, runId)).rejects.toThrow(/already running|locked/i);
    await releaseRunLock(flowDir, runId);
    await expect(acquireRunLock(flowDir, runId)).resolves.toBeUndefined();
    await releaseRunLock(flowDir, runId);
  });
});
