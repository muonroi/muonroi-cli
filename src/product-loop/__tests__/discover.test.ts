import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProject, formatDiscoverySummary } from "../discover.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "discover-"));
}

describe("discoverProject", () => {
  it("returns hasProject=false when cwd is undefined", async () => {
    const r = await discoverProject(undefined);
    expect(r.hasProject).toBe(false);
    expect(r.prefilled.size).toBe(0);
  });

  it("returns hasProject=false for empty dir", async () => {
    const dir = await tmpDir();
    const r = await discoverProject(dir);
    expect(r.hasProject).toBe(false);
    expect(r.prefilled.size).toBe(0);
  });

  it("detects package.json with test script + framework", async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { test: "vitest run" },
        dependencies: { react: "18.0.0" },
        devDependencies: { vitest: "1.0.0" },
      }),
    );
    const r = await discoverProject(dir);
    expect(r.hasProject).toBe(true);
    expect(r.prefilled.get("tech-constraints")).toMatch(/TypeScript\/JavaScript/);
    expect(r.prefilled.get("tech-constraints")).toMatch(/React/);
    expect(r.prefilled.get("tech-constraints")).toMatch(/Vitest/);
    expect(r.prefilled.get("success-metric")).toMatch(/vitest run/);
  });

  it("ignores placeholder 'no test specified' script", async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    );
    const r = await discoverProject(dir);
    expect(r.prefilled.has("tech-constraints")).toBe(true);
    expect(r.prefilled.has("success-metric")).toBe(false);
  });

  it("detects Cargo.toml and infers cargo test", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "Cargo.toml"), `[package]\nname = "demo"\n`);
    const r = await discoverProject(dir);
    expect(r.prefilled.get("tech-constraints")).toBe("Rust");
    expect(r.prefilled.get("success-metric")).toMatch(/cargo test/);
  });

  it("detects go.mod and infers go test", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "go.mod"), "module demo\n");
    const r = await discoverProject(dir);
    expect(r.prefilled.get("tech-constraints")).toBe("Go");
    expect(r.prefilled.get("success-metric")).toMatch(/go test/);
  });

  it("survives an unparseable package.json", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "package.json"), "{ not json");
    const r = await discoverProject(dir);
    expect(r.hasProject).toBe(true);
    expect(r.prefilled.has("tech-constraints")).toBe(true);
    expect(r.prefilled.has("success-metric")).toBe(false);
  });

  it("formatDiscoverySummary returns greenfield message when no project", () => {
    const s = formatDiscoverySummary({ hasProject: false, prefilled: new Map(), evidence: [], notes: [] });
    expect(s).toMatch(/greenfield/i);
  });

  it("formatDiscoverySummary lists evidence when prefilled", () => {
    const s = formatDiscoverySummary({
      hasProject: true,
      prefilled: new Map([["tech-constraints", "Rust"]]),
      evidence: [{ dim: "tech-constraints", source: "Cargo.toml", value: "Rust" }],
      notes: [],
    });
    expect(s).toMatch(/Cargo.toml/);
    expect(s).toMatch(/Skipping 1/);
  });
});
