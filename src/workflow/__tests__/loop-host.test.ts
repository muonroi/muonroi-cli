import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import * as closure from "../ee-closure.js";
import { FlowLoopHost } from "../loop-host.js";
import { planningArtifact } from "../paths.js";
import * as planCouncil from "../plan-council.js";
import { readPlanVerifyVerdict } from "../workflow-engine.js";

const SESSION_MODEL = "deepseek-v4-flash";
const GOOD_PLAN = `# Plan

1. Edit src/foo.ts
2. Acceptance: tests pass
`;

describe("FlowLoopHost", () => {
  it("records a failed review attempt with duration and requested-model boundary", async () => {
    tmp = mkdtempSync(join(tmpdir(), "review-failure-"));
    const review = vi
      .spyOn(planCouncil, "runPlanCouncil")
      .mockRejectedValueOnce(new Error("fixture council transport failure"));
    const log = vi.spyOn(closure, "logFlowNativeEvent").mockImplementation(() => {});
    try {
      const result = await host.firePoint("plan:post", {
        cwd: tmp,
        sessionModelId: SESSION_MODEL,
        depth: "standard",
        sessionId: "review-session",
      });
      expect(result.overlayError).toContain("fixture council transport failure");
      expect(log).toHaveBeenCalledWith(
        "review-session",
        expect.objectContaining({
          reviewOutcome: "error",
          requestedModelId: SESSION_MODEL,
          reviewId: expect.any(String),
          durationMs: expect.any(Number),
          reviewError: "fixture council transport failure",
        }),
      );
    } finally {
      review.mockRestore();
      log.mockRestore();
    }
  });
  let tmp: string;
  let host: FlowLoopHost;

  beforeAll(async () => {
    await loadCatalog();
    host = new FlowLoopHost();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("fires flow-core loop render-hooks at plan:post", async () => {
    tmp = mkdtempSync(join(tmpdir(), "loop-host-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const result = await host.firePoint("plan:post", {
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
    });

    expect(result.flowHooks?.point).toBe("plan:post");
    expect(result.overlayRan).toBe(true);
    expect(existsSync(planningArtifact(tmp, "PLAN-REVIEW.md"))).toBe(true);
  });

  it("plan-review:post unlocks execute after council pass", async () => {
    tmp = mkdtempSync(join(tmpdir(), "loop-host-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    await host.firePoint("plan:post", {
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
    });
    await host.firePoint("plan-review:post", {
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
    });

    expect(readPlanVerifyVerdict(tmp)).toBe("pass");
  });
});
