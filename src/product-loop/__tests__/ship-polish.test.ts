import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { polishDelivery } from "../ship-polish.js";
import type { ProductSpec } from "../types.js";

function makeSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    idea: "Build a CLI that summarizes git logs",
    persona: "open-source maintainers",
    mvp: ["parse log", "render summary"],
    phase2: ["AI auto-categorization"],
    architecture: "single-binary Node CLI; pure stdout",
    ioContract: "stdin: git log --oneline\nstdout: markdown summary",
    folderStructure: "src/, bin/, tests/",
    sprintEstimate: 3,
    costEstimate: 2,
    createdAt: new Date(),
    ...overrides,
  };
}

async function makeTmp(): Promise<{ cwd: string; runDir: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ship-cwd-"));
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "ship-run-"));
  return { cwd, runDir };
}

describe("polishDelivery", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    for (const c of cleanups) {
      await fs.rm(c, { recursive: true, force: true });
    }
    cleanups.length = 0;
  });

  it("writes README from spec when none exists", async () => {
    const { cwd, runDir } = await makeTmp();
    cleanups.push(cwd, runDir);
    const r = await polishDelivery({ cwd, runDir, productSpec: makeSpec(), runId: "r1" });
    expect(r.readmeWritten).toBe(true);
    const readme = await fs.readFile(path.join(cwd, "README.md"), "utf-8");
    expect(readme).toContain("# Build a CLI that summarizes git logs");
    expect(readme).toContain("## Audience");
    expect(readme).toContain("- parse log");
    expect(readme).toContain("## Architecture");
    expect(readme).toMatch(/scaffolded/i);
  });

  it("preserves existing README", async () => {
    const { cwd, runDir } = await makeTmp();
    cleanups.push(cwd, runDir);
    await fs.writeFile(path.join(cwd, "README.md"), "# Existing\n", "utf-8");
    const r = await polishDelivery({ cwd, runDir, productSpec: makeSpec(), runId: "r2" });
    expect(r.readmeWritten).toBe(false);
    expect(r.preserved).toContain("README.md");
    const readme = await fs.readFile(path.join(cwd, "README.md"), "utf-8");
    expect(readme.trim()).toBe("# Existing");
  });

  it("fills missing package.json fields without overwriting present ones", async () => {
    const { cwd, runDir } = await makeTmp();
    cleanups.push(cwd, runDir);
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ version: "1.2.3", scripts: { build: "tsc" } }, null, 2),
      "utf-8",
    );
    const r = await polishDelivery({ cwd, runDir, productSpec: makeSpec(), runId: "r3" });
    expect(r.packageJsonUpdated).toBe(true);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8"));
    // existing fields preserved
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.scripts.build).toBe("tsc");
    // missing fields filled
    expect(pkg.name).toBeTruthy();
    expect(pkg.description).toContain("git logs");
  });

  it("leaves a fully-populated package.json alone", async () => {
    const { cwd, runDir } = await makeTmp();
    cleanups.push(cwd, runDir);
    const original = { name: "fixed", version: "2.0.0", description: "stay" };
    await fs.writeFile(path.join(cwd, "package.json"), `${JSON.stringify(original, null, 2)}\n`, "utf-8");
    const r = await polishDelivery({ cwd, runDir, productSpec: makeSpec(), runId: "r4" });
    expect(r.packageJsonUpdated).toBe(false);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8"));
    expect(pkg).toEqual(original);
  });

  it("skips silently when there is no package.json", async () => {
    const { cwd, runDir } = await makeTmp();
    cleanups.push(cwd, runDir);
    const r = await polishDelivery({ cwd, runDir, productSpec: makeSpec(), runId: "r5" });
    expect(r.packageJsonUpdated).toBe(false);
    // no package.json should be created
    await expect(fs.access(path.join(cwd, "package.json"))).rejects.toBeTruthy();
  });

  it("always writes delivery-notes.md to runDir", async () => {
    const { cwd, runDir } = await makeTmp();
    cleanups.push(cwd, runDir);
    await polishDelivery({ cwd, runDir, productSpec: makeSpec(), runId: "r6" });
    const notes = await fs.readFile(path.join(runDir, "delivery-notes.md"), "utf-8");
    expect(notes).toContain("Delivery");
  });
});
