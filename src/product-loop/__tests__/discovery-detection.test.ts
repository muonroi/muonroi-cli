// src/product-loop/__tests__/discovery-detection.test.ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { detectExistingProject } from "../discovery-detection.js";

async function mktmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `detect-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("discovery-detection", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mktmp();
  });

  it("classifies empty cwd as greenfield", async () => {
    const sig = await detectExistingProject(cwd);
    expect(sig.classification).toBe("greenfield");
    expect(sig.srcFileCount).toBe(0);
    expect(sig.manifests).toEqual([]);
  });

  it("classifies cwd with only README as greenfield", async () => {
    await fs.writeFile(path.join(cwd, "README.md"), "# x");
    const sig = await detectExistingProject(cwd);
    expect(sig.classification).toBe("greenfield");
  });

  it("classifies cwd with package.json + 10 src files as existing", async () => {
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ dependencies: { react: "^18" } }));
    await fs.mkdir(path.join(cwd, "src"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "src", `f${i}.ts`), "export const x = 1;");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.classification).toBe("existing");
    expect(sig.srcFileCount).toBeGreaterThan(5);
    expect(sig.manifests[0].type).toBe("package.json");
    expect(sig.languages).toContain("TypeScript");
    expect(sig.frameworks).toContain("react");
  });

  it("detects Cargo.toml as Rust manifest", async () => {
    await fs.writeFile(path.join(cwd, "Cargo.toml"), '[package]\nname = "x"');
    await fs.mkdir(path.join(cwd, "src"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "src", `f${i}.rs`), "fn main() {}");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.manifests[0].type).toBe("Cargo.toml");
    expect(sig.languages).toContain("Rust");
  });

  it("detects go.mod as Go manifest", async () => {
    await fs.writeFile(path.join(cwd, "go.mod"), "module x\n");
    await fs.mkdir(path.join(cwd, "internal"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "internal", `f${i}.go`), "package x");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.manifests[0].type).toBe("go.mod");
    expect(sig.languages).toContain("Go");
  });
});
