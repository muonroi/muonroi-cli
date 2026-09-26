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
    // instructions.ts now resolves its home through the repo-wide
    // `MUONROI_CLI_HOME ?? homedir() + "/.muonroi-cli"` convention, and
    // vitest-setup.ts pins that var suite-wide — so mocking `os.homedir()`
    // alone no longer redirects the loader. Point the var at the same temp
    // home this test already builds; the homedir mock stays as belt-and-braces
    // for anything else the module reads.
    process.env.MUONROI_CLI_HOME = path.join(mockedHome, ".muonroi-cli");
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
const originalCliHome = process.env.MUONROI_CLI_HOME;

describe("loadCustomInstructions", () => {
  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalCliHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = originalCliHome;
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

  // Parity fix (G4): Claude Code also loads parent-directory CLAUDE.md files
  // above the project's own root, up to $HOME. Measured (FINDINGS.md G4): a
  // Vietnamese request got an all-English reply because "reply in the
  // user's own language" lives in `~/Personal/Core/CLAUDE.md`, one directory
  // above the git root `~/Personal/Core/shipd-challenges` — a file this
  // loader never reached before.
  describe("ancestor directories above the git root, up to $HOME (G4)", () => {
    it("loads an ancestor directory's CLAUDE.md above the git root, ordered before the project's own", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = path.join(home, "Personal", "Core", "shipd-challenges");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      writeFile(path.join(home, "Personal", "Core", "CLAUDE.md"), "reply in the user's own language");
      writeFile(path.join(repoRoot, "AGENTS.md"), "project instructions");
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      const out = loadCustomInstructions(repoRoot);
      expect(out).not.toBeNull();
      expect(out).toContain("reply in the user's own language");
      expect(out).toContain("project instructions");
      expect(out!.indexOf("reply in the user's own language")).toBeLessThan(out!.indexOf("project instructions"));
    });

    it("loads $HOME's own CLAUDE.md when the git root sits directly inside $HOME", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = path.join(home, "myrepo");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      writeFile(path.join(home, "CLAUDE.md"), "home-level rule");
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      expect(loadCustomInstructions(repoRoot)).toContain("home-level rule");
    });

    it("does not walk ancestors, and does not throw, when the git root is outside $HOME entirely", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeTempDir("muonroi-repo-outside-"); // sibling tmp dir, NOT inside home
      fs.mkdirSync(path.join(repoRoot, ".git"));
      writeFile(path.join(repoRoot, "AGENTS.md"), "project instructions only");
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      expect(loadCustomInstructions(repoRoot)).toBe("project instructions only");
    });

    it("does not double-load the git root itself as one of its own ancestors", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = path.join(home, "repo");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      writeFile(path.join(repoRoot, "AGENTS.md"), "root instructions");
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      const out = loadCustomInstructions(repoRoot);
      expect(out?.split("root instructions").length).toBe(2); // one match, i.e. appears exactly once
    });

    it("caps ancestor bytes loaded — a deep chain cannot balloon the prompt past MAX_ANCESTOR_INSTRUCTIONS_BYTES", async () => {
      const home = makeTempDir("muonroi-home-");
      const level1 = path.join(home, "level1");
      const level2 = path.join(level1, "level2");
      const repoRoot = path.join(level2, "repo");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

      const { MAX_ANCESTOR_INSTRUCTIONS_BYTES } = await import("./instructions");
      const padded = (label: string) =>
        `${label}:${"x".repeat(MAX_ANCESTOR_INSTRUCTIONS_BYTES / 2 - label.length - 1)}`;
      // Each segment alone fits the cap; two together do not (cap is on the
      // CUMULATIVE ancestor total, not per file) — home is walked first, so
      // it survives and the deeper level(s) after it are dropped.
      writeFile(path.join(home, "CLAUDE.md"), padded("L0"));
      writeFile(path.join(level1, "CLAUDE.md"), padded("L1"));
      writeFile(path.join(level2, "CLAUDE.md"), padded("L2"));
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      const out = loadCustomInstructions(repoRoot);
      expect(out).not.toBeNull();
      expect(out).toContain("L0:");
      expect(out).not.toContain("L1:");
      expect(out).not.toContain("L2:");
    });
  });
});
