import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureFootprintGitignored } from "../settings.js";

describe("ensureFootprintGitignored", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "footprint-gi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when cwd is NOT a git repo", () => {
    ensureFootprintGitignored(dir);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("creates .gitignore with the footprint entry inside a git repo", () => {
    mkdirSync(join(dir, ".git"));
    ensureFootprintGitignored(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toMatch(/^\.muonroi-cli\/$/m);
  });

  it("appends to an existing .gitignore without clobbering it", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "node_modules\n/dist\n");
    ensureFootprintGitignored(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toMatch(/node_modules/);
    expect(content).toMatch(/\/dist/);
    expect(content).toMatch(/^\.muonroi-cli\/$/m);
  });

  it("is idempotent — does not duplicate the entry on repeated calls", () => {
    mkdirSync(join(dir, ".git"));
    ensureFootprintGitignored(dir);
    ensureFootprintGitignored(dir);
    ensureFootprintGitignored(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    const occurrences = content.split(/\r?\n/).filter((l) => l.trim() === ".muonroi-cli/").length;
    expect(occurrences).toBe(1);
  });

  it("recognizes an existing bare '.muonroi-cli' entry and does not re-add", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), ".muonroi-cli\n");
    ensureFootprintGitignored(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toBe(".muonroi-cli\n"); // unchanged
  });
});
