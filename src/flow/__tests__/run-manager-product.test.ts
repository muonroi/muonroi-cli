import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRun, loadRun } from "../run-manager.js";

describe("run-manager product extension", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-flow-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create 6 files in createRun", async () => {
    const run = await createRun(tmpDir);
    const runDir = path.join(tmpDir, "runs", run.id);

    const files = await fs.readdir(runDir);
    expect(files).toContain("roadmap.md");
    expect(files).toContain("state.md");
    expect(files).toContain("delegations.md");
    expect(files).toContain("gray-areas.md");
    expect(files).toContain("iterations.md");
    expect(files).toContain("manifest.md");
    expect(files.length).toBe(6);
  });

  it("should initialize iterations.md and manifest.md", async () => {
    const run = await createRun(tmpDir);
    
    expect(run.iterations).toBeDefined();
    expect(run.iterations.sections.has("Iterations")).toBe(true);
    
    expect(run.manifest).toBeDefined();
    expect(run.manifest.sections.has("Manifest")).toBe(true);
  });

  it("should load 6 SectionMaps in loadRun", async () => {
    const runCreated = await createRun(tmpDir);
    const runLoaded = await loadRun(tmpDir, runCreated.id);

    expect(runLoaded).not.toBeNull();
    if (runLoaded) {
      expect(runLoaded.roadmap).toBeDefined();
      expect(runLoaded.state).toBeDefined();
      expect(runLoaded.delegations).toBeDefined();
      expect(runLoaded.grayAreas).toBeDefined();
      expect(runLoaded.iterations).toBeDefined();
      expect(runLoaded.manifest).toBeDefined();
      
      expect(runLoaded.iterations.sections.has("Iterations")).toBe(true);
      expect(runLoaded.manifest.sections.has("Manifest")).toBe(true);
    }
  });
});
