import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureFlowDir, FLOW_DIR_NAME } from "../scaffold.js";

describe("scaffold", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scaffold-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("FLOW_DIR_NAME equals .muonroi-flow", () => {
    expect(FLOW_DIR_NAME).toBe(".muonroi-flow");
  });

  it("creates .muonroi-flow/ with all required files and directories", async () => {
    const flowDir = await ensureFlowDir(tmpDir);
    expect(flowDir).toBe(path.join(tmpDir, ".muonroi-flow"));

    // Check files exist
    const roadmap = await fs.stat(path.join(flowDir, "roadmap.md"));
    expect(roadmap.isFile()).toBe(true);
    const state = await fs.stat(path.join(flowDir, "state.md"));
    expect(state.isFile()).toBe(true);
    const backlog = await fs.stat(path.join(flowDir, "backlog.md"));
    expect(backlog.isFile()).toBe(true);
    const decisions = await fs.stat(path.join(flowDir, "decisions.md"));
    expect(decisions.isFile()).toBe(true);

    // Check directories exist
    const history = await fs.stat(path.join(flowDir, "history"));
    expect(history.isDirectory()).toBe(true);
    const runs = await fs.stat(path.join(flowDir, "runs"));
    expect(runs.isDirectory()).toBe(true);
  });

  it("is idempotent (second call does not overwrite existing files)", async () => {
    await ensureFlowDir(tmpDir);
    const flowDir = path.join(tmpDir, ".muonroi-flow");

    // Write custom content to roadmap.md
    await fs.writeFile(path.join(flowDir, "roadmap.md"), "custom content", "utf8");

    // Call again
    await ensureFlowDir(tmpDir);

    // Verify custom content preserved
    const content = await fs.readFile(path.join(flowDir, "roadmap.md"), "utf8");
    expect(content).toBe("custom content");
  });
});
