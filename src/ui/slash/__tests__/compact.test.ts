import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlashContext } from "../registry.js";

// Import to trigger self-registration
import "../compact.js";

import { dispatchSlash } from "../registry.js";

let tmpDir: string;

const makeCtx = (cwd: string): SlashContext => ({
  cwd,
  tenantId: "local",
  defaultProvider: "anthropic",
  defaultModel: "claude-3-5-sonnet-latest",
});

describe("handleCompactSlash", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compact-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns helpful message with no active run", async () => {
    // No .muonroi-flow/ directory at all
    const result = await dispatchSlash("compact", [], makeCtx(tmpDir));
    expect(result).toBeTypeOf("string");
    expect(result!.toLowerCase()).toMatch(/no active run|nothing to compact/i);
  });

  it("returns signal string __COMPACT__ when preconditions met", async () => {
    // Set up flow dir with active run
    const flowDir = path.join(tmpDir, ".muonroi-flow");
    await fs.mkdir(path.join(flowDir, "runs", "test-run-01"), {
      recursive: true,
    });
    await fs.mkdir(path.join(flowDir, "history"), { recursive: true });
    await fs.writeFile(path.join(flowDir, "state.md"), "## Active Run\n\ntest-run-01\n", "utf8");
    // Create run state.md
    await fs.writeFile(
      path.join(flowDir, "runs", "test-run-01", "state.md"),
      "## Resume Digest\n\nActive run state\n",
      "utf8",
    );

    const result = await dispatchSlash("compact", [], makeCtx(tmpDir));
    expect(result).toBeTypeOf("string");
    expect(result).toContain("__COMPACT__");
  });
});
