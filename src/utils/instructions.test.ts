import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function importLoadCustomInstructions(mockedHome?: string) {
  vi.resetModules();
  vi.doUnmock("os");

  if (mockedHome) {
    process.env.HOME = mockedHome;
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return {
        ...actual,
        homedir: () => mockedHome,
      };
    });
  }

  const mod = await import("./instructions");
  return mod.loadCustomInstructions;
}

const originalHome = process.env.HOME;

describe("loadCustomInstructions", () => {
  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("os");
  });

  it("returns null when no instruction files exist", async () => {
    const home = makeTempDir("muonroi-home-");
    const cwd = makeTempDir("muonroi-cwd-");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBeNull();
  });

  it("loads global plus repo-chain AGENTS files in order", async () => {
    const home = makeTempDir("muonroi-home-");
    const repoRoot = makeTempDir("muonroi-repo-");
    const cwd = path.join(repoRoot, "pkg", "feature");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    fs.mkdirSync(cwd, { recursive: true });

    writeFile(path.join(home, ".muonroi-cli", "AGENTS.md"), "global instructions");
    writeFile(path.join(repoRoot, "AGENTS.md"), "root instructions");
    writeFile(path.join(repoRoot, "pkg", "AGENTS.md"), "pkg instructions");
    writeFile(path.join(repoRoot, "pkg", "feature", "AGENTS.md"), "feature instructions");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBe(
      ["global instructions", "root instructions", "pkg instructions", "feature instructions"].join("\n\n"),
    );
  });

  it("auto-loads CLAUDE/GEMINI/DEEPSEEK/COPILOT/CURSOR alongside AGENTS.md", async () => {
    const home = makeTempDir("muonroi-home-");
    const repoRoot = makeTempDir("muonroi-repo-");
    const cwd = repoRoot;
    fs.mkdirSync(path.join(repoRoot, ".git"));

    writeFile(path.join(repoRoot, "AGENTS.md"), "agents body");
    writeFile(path.join(repoRoot, "CLAUDE.md"), "claude body");
    writeFile(path.join(repoRoot, "GEMINI.md"), "gemini body");
    writeFile(path.join(repoRoot, "DEEPSEEK.md"), "deepseek body");

    const loadCustomInstructions = await importLoadCustomInstructions(home);
    const out = loadCustomInstructions(cwd);
    expect(out).not.toBeNull();
    // AGENTS.md first, others tagged with comment headers, in declared order
    expect(out).toContain("agents body");
    expect(out).toContain("<!-- CLAUDE.md -->\nclaude body");
    expect(out).toContain("<!-- GEMINI.md -->\ngemini body");
    expect(out).toContain("<!-- DEEPSEEK.md -->\ndeepseek body");
    const idxAgents = out!.indexOf("agents body");
    const idxClaude = out!.indexOf("claude body");
    const idxGemini = out!.indexOf("gemini body");
    const idxDeepseek = out!.indexOf("deepseek body");
    expect(idxAgents).toBeLessThan(idxClaude);
    expect(idxClaude).toBeLessThan(idxGemini);
    expect(idxGemini).toBeLessThan(idxDeepseek);
  });

  it("prefers AGENTS.override.md over AGENTS.md in the same directory", async () => {
    const home = makeTempDir("muonroi-home-");
    const repoRoot = makeTempDir("muonroi-repo-");
    const cwd = path.join(repoRoot, "nested");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    fs.mkdirSync(cwd, { recursive: true });

    writeFile(path.join(repoRoot, "AGENTS.md"), "root instructions");
    writeFile(path.join(repoRoot, "nested", "AGENTS.md"), "nested base instructions");
    writeFile(path.join(repoRoot, "nested", "AGENTS.override.md"), "nested override instructions");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBe(["root instructions", "nested override instructions"].join("\n\n"));
  });
});
