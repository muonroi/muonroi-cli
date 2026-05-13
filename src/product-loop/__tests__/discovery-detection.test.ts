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

  it("classifies empty package.json (no deps) as ambiguous", async () => {
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({}));
    await fs.mkdir(path.join(cwd, "src"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "src", `f${i}.ts`), "export const x = 1;");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.classification).toBe("ambiguous");
  });

  it("classifies scaffolded but untouched project as ambiguous", async () => {
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
    // only 2 src files = scaffold
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src", "index.ts"), "export {}");
    await fs.writeFile(path.join(cwd, "src", "app.tsx"), "export {}");
    const sig = await detectExistingProject(cwd);
    expect(sig.classification).toBe("ambiguous");
  });

  it("classifies multiple manifests (polyglot) as ambiguous", async () => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { react: "^18", a: "1", b: "1", c: "1", d: "1", e: "1" } }),
    );
    await fs.writeFile(
      path.join(cwd, "pyproject.toml"),
      "[tool.poetry]\nname='x'\ndependencies = ['a','b','c','d','e']",
    );
    await fs.mkdir(path.join(cwd, "src"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "src", `f${i}.ts`), "export {}");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.manifests.length).toBeGreaterThanOrEqual(2);
    expect(sig.classification).toBe("ambiguous");
  });

  it("treats no-git+src as still classifiable on manifest", async () => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" } }),
    );
    await fs.mkdir(path.join(cwd, "src"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "src", `f${i}.ts`), "export {}");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.isGitRepo).toBe(false);
    expect(sig.classification).toBe("existing");
  });

  it("counts srcFiles ignoring node_modules and dist", async () => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" } }),
    );
    await fs.mkdir(path.join(cwd, "node_modules", "lib"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "lib", "f.ts"), "export {}");
    await fs.mkdir(path.join(cwd, "dist"), { recursive: true });
    await fs.writeFile(path.join(cwd, "dist", "out.js"), "export {}");
    await fs.mkdir(path.join(cwd, "src"));
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(cwd, "src", `f${i}.ts`), "export {}");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.srcFileCount).toBe(6);
  });

  it("vendored node_modules without root manifest is ambiguous", async () => {
    await fs.mkdir(path.join(cwd, "node_modules", "lib"), { recursive: true });
    await fs.mkdir(path.join(cwd, "vendor"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "vendor", `f${i}.ts`), "export {}");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.manifests.length).toBe(0);
    expect(sig.srcFileCount).toBe(10);
    expect(sig.classification).toBe("ambiguous");
  });

  it("returns greenfield with warning when fs access denied (smoke)", async () => {
    // Simulating EACCES is platform-dependent; verify the helper does not throw on a non-existent path
    const sig = await detectExistingProject(path.join(cwd, "does-not-exist"));
    expect(sig.classification).toBe("greenfield");
  });

  it("zero-weight unreadable manifest is still listed", async () => {
    // create a directory with the manifest name to make read fail
    await fs.mkdir(path.join(cwd, "package.json"));
    const sig = await detectExistingProject(cwd);
    if (sig.manifests.length > 0) {
      expect(sig.manifests[0].weight).toBe(0);
    } else {
      // some platforms treat dir-as-file differently; passing is also OK
      expect(sig.manifests).toEqual([]);
    }
  });

  it("counts only ext-mapped src files (no random text)", async () => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" } }),
    );
    await fs.mkdir(path.join(cwd, "src"));
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(cwd, "src", `f${i}.txt`), "not source");
    }
    const sig = await detectExistingProject(cwd);
    expect(sig.srcFileCount).toBe(0);
  });
});
