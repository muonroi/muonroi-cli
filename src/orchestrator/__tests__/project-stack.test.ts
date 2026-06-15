import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectStack } from "../prompts.js";

// detectProjectStack feeds the ENVIRONMENT block so every model — in any mode,
// on any provider — knows the concrete stack of the repo it is running inside,
// instead of assuming Python / asking the user to describe the project
// (2026-06-14 dogfood: "model native doesn't know what it can do in the CLI").
describe("detectProjectStack", () => {
  const mkTemp = (slug: string): string => mkdtempSync(join(tmpdir(), `mr-stack-${slug}-`));

  it("detects the current repo as a JS/TS project under git", () => {
    const out = detectProjectStack(process.cwd());
    expect(out).toMatch(/TypeScript|JavaScript/);
    expect(out).toMatch(/vcs: git/);
  });

  it("returns empty string for a bare directory (greenfield)", () => {
    const dir = mkTemp("empty");
    try {
      expect(detectProjectStack(dir)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a Rust project from Cargo.toml", () => {
    const dir = mkTemp("rust");
    try {
      writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'x'\n");
      expect(detectProjectStack(dir)).toMatch(/^Rust/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a .NET project from a .csproj file", () => {
    const dir = mkTemp("net");
    try {
      writeFileSync(join(dir, "App.csproj"), "<Project/>");
      expect(detectProjectStack(dir)).toMatch(/\.NET\/C#/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports package manager + test runner for a bun/vitest TS project", () => {
    const dir = mkTemp("ts");
    try {
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      writeFileSync(join(dir, "bun.lock"), "");
      writeFileSync(join(dir, "vitest.config.ts"), "export default {}");
      const out = detectProjectStack(dir);
      expect(out).toMatch(/TypeScript/);
      expect(out).toMatch(/pkg: bun/);
      expect(out).toMatch(/tests: vitest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty (no throw) for a missing directory", () => {
    expect(detectProjectStack(join(tmpdir(), "definitely-missing-dir-9f8a7b6c"))).toBe("");
  });
});
