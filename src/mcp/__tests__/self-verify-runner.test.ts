import { describe, expect, it, vi } from "vitest";

vi.mock("../../self-qa/index.js", () => ({ runSelfVerify: vi.fn(async (opts) => opts) }));

import { runSelfVerify } from "../../self-qa/index.js";
import { defaultRunner } from "../self-verify-runner.js";

describe("task-owned selfverify routing", () => {
  it("preserves explicit workspace, empty files and fixture selection all the way to the planner", async () => {
    const log = vi.fn();
    await defaultRunner.tier1(
      { kind: "tier1", cwd: "/target", files: [], mockLlmDir: "/fixture", emit: false },
      log,
      new AbortController().signal,
    );
    expect(runSelfVerify).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/target", diffFilesOverride: [], mockLlmDir: "/fixture", emitSpecs: false, log }),
    );
  });
});
