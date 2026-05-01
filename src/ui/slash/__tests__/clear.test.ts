import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlashContext } from "../registry.js";

// Import to trigger self-registration
import "../clear.js";

import { dispatchSlash } from "../registry.js";

let tmpDir: string;

const makeCtx = (cwd: string): SlashContext => ({
  cwd,
  tenantId: "local",
  defaultProvider: "anthropic",
  defaultModel: "claude-3-5-sonnet-latest",
});

describe("handleClearSlash", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clear-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns helpful message with no active run", async () => {
    const result = await dispatchSlash("clear", [], makeCtx(tmpDir));
    expect(result).toBeTypeOf("string");
    expect(result!.toLowerCase()).toMatch(/no active run/i);
  });

  it("returns __CLEAR__ signal with relock summary when run exists", async () => {
    const flowDir = path.join(tmpDir, ".muonroi-flow");
    const runId = "test-run-01";
    const runDir = path.join(flowDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });

    // Set up state.md with active run
    await fs.writeFile(path.join(flowDir, "state.md"), "## Active Run\n\ntest-run-01\n", "utf8");

    // Set up run state.md with some content
    await fs.writeFile(
      path.join(runDir, "state.md"),
      "## Resume Digest\n\nWorking on feature X\n\n## Experience Snapshot\n\nSome warnings\n",
      "utf8",
    );

    // Set up decisions.md with some entries
    await fs.writeFile(
      path.join(flowDir, "decisions.md"),
      "## Decisions\n\n- Use JWT\n- Use PostgreSQL\n\n## Facts\n\n- API limit 100/min\n",
      "utf8",
    );

    // Set up gray-areas.md
    await fs.writeFile(
      path.join(runDir, "gray-areas.md"),
      "## Open\n\nG1: Should we use X?\n\n## Resolved\n\nG2: Used Y\n",
      "utf8",
    );

    const result = await dispatchSlash("clear", [], makeCtx(tmpDir));
    expect(result).toBeTypeOf("string");
    expect(result).toContain("__CLEAR__");
    expect(result).toContain("Relocked from");
    expect(result).toContain("test-run-01");
  });

  it("includes decisions count in summary", async () => {
    const flowDir = path.join(tmpDir, ".muonroi-flow");
    const runId = "run-02";
    const runDir = path.join(flowDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });

    await fs.writeFile(path.join(flowDir, "state.md"), "## Active Run\n\nrun-02\n", "utf8");
    await fs.writeFile(path.join(runDir, "state.md"), "## Resume Digest\n\nSome state\n", "utf8");
    await fs.writeFile(path.join(flowDir, "decisions.md"), "## Decisions\n\n- D1\n- D2\n- D3\n", "utf8");

    const result = await dispatchSlash("clear", [], makeCtx(tmpDir));
    expect(result).toContain("Decisions:");
  });
});
