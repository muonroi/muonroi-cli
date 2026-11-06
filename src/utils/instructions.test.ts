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

/** Write the user settings the loader consults (`~/.muonroi-cli/user-settings.json`). */
function writeUserSettings(home: string, settings: Record<string, unknown>): void {
  writeFile(path.join(home, ".muonroi-cli", "user-settings.json"), JSON.stringify(settings));
}

async function importInstructions(mockedHome: string) {
  vi.resetModules();
  vi.doUnmock("os");

  process.env.HOME = mockedHome;
  // instructions.ts resolves its global home through the repo-wide
  // `MUONROI_CLI_HOME ?? homedir() + "/.muonroi-cli"` convention, and
  // vitest-setup.ts pins that var suite-wide — so mocking `os.homedir()`
  // alone does not redirect the loader. Point the var at the same temp home.
  // The homedir mock redirects `loadUserSettings()` (user-settings.json),
  // which the loader reads for projectDocFallbackFilenames / projectDocMaxBytes.
  process.env.MUONROI_CLI_HOME = path.join(mockedHome, ".muonroi-cli");
  vi.doMock("os", async () => {
    const actual = await vi.importActual<typeof import("os")>("os");
    return {
      ...actual,
      homedir: () => mockedHome,
    };
  });

  return import("./instructions");
}

async function importLoadCustomInstructions(mockedHome: string) {
  return (await importInstructions(mockedHome)).loadCustomInstructions;
}

/** A git repo NOT inside the temp home, so the home cannot contribute by accident. */
function makeRepo(): string {
  const repoRoot = makeTempDir("muonroi-repo-");
  fs.mkdirSync(path.join(repoRoot, ".git"));
  return repoRoot;
}

const originalHome = process.env.HOME;
const originalCliHome = process.env.MUONROI_CLI_HOME;

describe("loadCustomInstructions — AGENTS.md only (Codex parity)", () => {
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

  it("loads global plus repo-chain AGENTS files in root → cwd order", async () => {
    const home = makeTempDir("muonroi-home-");
    const repoRoot = makeRepo();
    const cwd = path.join(repoRoot, "pkg", "feature");
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

  it("does NOT load CLAUDE/GEMINI/DEEPSEEK/COPILOT/CURSOR by default — AGENTS.md only", async () => {
    const home = makeTempDir("muonroi-home-");
    const repoRoot = makeRepo();
    const nested = path.join(repoRoot, "nested");
    writeFile(path.join(repoRoot, "AGENTS.md"), "agents body");
    for (const name of ["CLAUDE.md", "GEMINI.md", "DEEPSEEK.md", "COPILOT.md", "CURSOR.md"]) {
      writeFile(path.join(repoRoot, name), `${name} MARKER`);
      writeFile(path.join(nested, name), `nested ${name} MARKER`);
    }
    writeFile(path.join(home, ".muonroi-cli", "CLAUDE.md"), "global CLAUDE MARKER");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBe("agents body");
    // A directory with only non-AGENTS files contributes nothing.
    expect(loadCustomInstructions(nested)).toBe("agents body");
  });

  it("returns null for a repo that has only a CLAUDE.md", async () => {
    const home = makeTempDir("muonroi-home-");
    const repoRoot = makeRepo();
    writeFile(path.join(repoRoot, "CLAUDE.md"), "claude only");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBeNull();
  });

  describe("opt-in projectDocFallbackFilenames (Codex project_doc_fallback_filenames)", () => {
    it("loads a listed fallback file in a directory that has no AGENTS.md, labelled with its name", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeRepo();
      const nested = path.join(repoRoot, "nested");
      writeFile(path.join(repoRoot, "AGENTS.md"), "root agents");
      writeFile(path.join(repoRoot, "CLAUDE.md"), "root CLAUDE MARKER");
      writeFile(path.join(nested, "CLAUDE.md"), "nested claude body");
      writeFile(path.join(nested, "GEMINI.md"), "nested GEMINI MARKER");
      writeUserSettings(home, { projectDocFallbackFilenames: ["CLAUDE.md"] });
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      const out = loadCustomInstructions(nested);
      // At most one file per directory: the root has AGENTS.md, so its CLAUDE.md is not read.
      // The label is relative to cwd (here cwd IS `nested`).
      expect(out).toBe(["root agents", "<!-- CLAUDE.md -->\nnested claude body"].join("\n\n"));
      expect(out).not.toContain("root CLAUDE MARKER");
      expect(out).not.toContain("GEMINI MARKER");
    });

    it("honours fallback order, and the global home never uses fallbacks", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeRepo();
      writeFile(path.join(repoRoot, "GEMINI.md"), "gemini body");
      writeFile(path.join(repoRoot, "CLAUDE.md"), "claude body");
      writeFile(path.join(home, ".muonroi-cli", "GEMINI.md"), "GLOBAL GEMINI MARKER");
      writeUserSettings(home, { projectDocFallbackFilenames: ["GEMINI.md", "CLAUDE.md"] });
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      expect(loadCustomInstructions(repoRoot)).toBe("<!-- GEMINI.md -->\ngemini body");
    });

    it("ignores entries that are not a bare filename", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeRepo();
      writeFile(path.join(repoRoot, "sub", "CLAUDE.md"), "SUBDIR MARKER");
      writeFile(path.join(path.dirname(repoRoot), "ESCAPE.md"), "ESCAPE MARKER");
      writeUserSettings(home, {
        projectDocFallbackFilenames: ["sub/CLAUDE.md", "sub\\CLAUDE.md", "../ESCAPE.md", "..", ""],
      });
      const { loadCustomInstructions, projectCandidateFilenames } = await importInstructions(home);

      expect(loadCustomInstructions(repoRoot)).toBeNull();
      expect(projectCandidateFilenames(["sub/CLAUDE.md", "..", "CLAUDE.md", "CLAUDE.md", "AGENTS.md"])).toEqual([
        "AGENTS.override.md",
        "AGENTS.md",
        "CLAUDE.md",
      ]);
    });
  });

  describe("AGENTS.override.md precedence", () => {
    it("prefers AGENTS.override.md over AGENTS.md in the same directory", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeRepo();
      const cwd = path.join(repoRoot, "nested");
      fs.mkdirSync(cwd, { recursive: true });

      writeFile(path.join(repoRoot, "AGENTS.md"), "root instructions");
      writeFile(path.join(repoRoot, "nested", "AGENTS.md"), "nested base instructions");
      writeFile(path.join(repoRoot, "nested", "AGENTS.override.md"), "nested override instructions");
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      expect(loadCustomInstructions(cwd)).toBe(["root instructions", "nested override instructions"].join("\n\n"));
    });

    it("global: AGENTS.override.md wins; an EMPTY override falls back to AGENTS.md (first non-empty)", async () => {
      const home = makeTempDir("muonroi-home-");
      const cwd = makeTempDir("muonroi-cwd-");
      writeFile(path.join(home, ".muonroi-cli", "AGENTS.md"), "global base");
      writeFile(path.join(home, ".muonroi-cli", "AGENTS.override.md"), "global override");
      let loadCustomInstructions = await importLoadCustomInstructions(home);
      expect(loadCustomInstructions(cwd)).toBe("global override");

      writeFile(path.join(home, ".muonroi-cli", "AGENTS.override.md"), "   \n");
      loadCustomInstructions = await importLoadCustomInstructions(home);
      expect(loadCustomInstructions(cwd)).toBe("global base");
    });

    it("project: an EMPTY AGENTS.override.md is selected and skipped — the directory's AGENTS.md is not read", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeRepo();
      writeFile(path.join(repoRoot, "AGENTS.override.md"), "\n");
      writeFile(path.join(repoRoot, "AGENTS.md"), "SHADOWED MARKER");
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      expect(loadCustomInstructions(repoRoot)).toBeNull();
    });
  });

  describe("nothing above the project root", () => {
    it("does not load AGENTS.md / CLAUDE.md from directories above the git root, even inside $HOME", async () => {
      const home = makeTempDir("muonroi-home-");
      const core = path.join(home, "Personal", "Core");
      const repoRoot = path.join(core, "shipd-challenges");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      writeFile(path.join(home, "AGENTS.md"), "HOME AGENTS MARKER");
      writeFile(path.join(home, "CLAUDE.md"), "HOME CLAUDE MARKER");
      writeFile(path.join(core, "AGENTS.md"), "CORE AGENTS MARKER");
      writeFile(path.join(core, "CLAUDE.md"), "CORE CLAUDE MARKER");
      writeFile(path.join(repoRoot, "AGENTS.md"), "project instructions");
      // Even an opt-in fallback must not widen the walk above the root.
      writeUserSettings(home, { projectDocFallbackFilenames: ["CLAUDE.md"] });
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      expect(loadCustomInstructions(repoRoot)).toBe("project instructions");
    });

    it("with no git root, only the cwd itself is checked", async () => {
      const home = makeTempDir("muonroi-home-");
      const parent = makeTempDir("muonroi-nogit-");
      const cwd = path.join(parent, "child");
      writeFile(path.join(parent, "AGENTS.md"), "PARENT MARKER");
      writeFile(path.join(cwd, "AGENTS.md"), "cwd instructions");
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      expect(loadCustomInstructions(cwd)).toBe("cwd instructions");
    });
  });

  describe("project byte budget (Codex project_doc_max_bytes)", () => {
    it("truncates the file that crosses the default 32 KiB budget and drops later files; global is not counted", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeRepo();
      const a = path.join(repoRoot, "a");
      const b = path.join(a, "b");
      const { DEFAULT_PROJECT_DOC_MAX_BYTES } = await import("./settings");
      expect(DEFAULT_PROJECT_DOC_MAX_BYTES).toBe(32 * 1024);
      const rootBody = `R${"r".repeat(20 * 1024 - 1)}`;
      const aBody = `A${"a".repeat(20 * 1024 - 1)}`;
      const globalBody = `G${"g".repeat(40 * 1024 - 1)}`;
      writeFile(path.join(repoRoot, "AGENTS.md"), rootBody);
      writeFile(path.join(a, "AGENTS.md"), aBody);
      writeFile(path.join(b, "AGENTS.md"), "DROPPED MARKER");
      writeFile(path.join(home, ".muonroi-cli", "AGENTS.md"), globalBody);
      const loadCustomInstructions = await importLoadCustomInstructions(home);

      const out = loadCustomInstructions(b)!;
      const [global, root, aSeg, ...rest] = out.split("\n\n");
      expect(global).toBe(globalBody); // a 40 KiB global file is NOT charged against the project budget
      expect(root).toBe(rootBody);
      expect(aSeg).toBe(aBody.slice(0, 32 * 1024 - 20 * 1024)); // truncated to the remaining 12 KiB
      expect(rest).toEqual([]);
      expect(out).not.toContain("DROPPED MARKER");
    });

    it("projectDocMaxBytes overrides the budget; 0 disables project instructions but keeps the global file", async () => {
      const home = makeTempDir("muonroi-home-");
      const repoRoot = makeRepo();
      writeFile(path.join(repoRoot, "AGENTS.md"), "0123456789");
      writeFile(path.join(home, ".muonroi-cli", "AGENTS.md"), "global");
      writeUserSettings(home, { projectDocMaxBytes: 4 });
      let loadCustomInstructions = await importLoadCustomInstructions(home);
      expect(loadCustomInstructions(repoRoot)).toBe(["global", "0123"].join("\n\n"));

      writeUserSettings(home, { projectDocMaxBytes: 0 });
      loadCustomInstructions = await importLoadCustomInstructions(home);
      expect(loadCustomInstructions(repoRoot)).toBe("global");
    });
  });

  // CI regression (macOS + Windows red, Linux green): comparing a raw path
  // against a realpath'd one made `path.relative` start with `..` whenever the
  // two spellings of one directory differed — macOS `/var` → `/private/var`,
  // Windows 8.3 short names. The loader canonicalises cwd and finds the git
  // root by walking up from THAT, so root and cwd share one spelling. This
  // reaches the repo THROUGH a symlink/junction, exactly as `/var` is on macOS.
  it("loads the root → cwd chain when cwd is spelled through a symlink (macOS /var → /private/var, Windows 8.3 names)", async () => {
    const home = makeTempDir("muonroi-home-");
    const realRepo = makeRepo();
    const linkParent = makeTempDir("muonroi-repo-link-");
    const linkedRepo = path.join(linkParent, "repo");
    fs.symlinkSync(realRepo, linkedRepo, process.platform === "win32" ? "junction" : "dir");
    expect(fs.realpathSync.native(linkedRepo)).not.toBe(linkedRepo); // the precondition the bug needs
    writeFile(path.join(realRepo, "AGENTS.md"), "root instructions");
    writeFile(path.join(realRepo, "pkg", "AGENTS.md"), "pkg instructions");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(path.join(linkedRepo, "pkg"))).toBe(
      ["root instructions", "pkg instructions"].join("\n\n"),
    );
  });
});
