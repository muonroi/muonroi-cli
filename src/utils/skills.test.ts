import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DiscoveredSkill,
  discoverSkills,
  formatCompactSkillsForPrompt,
  formatSkillsForChat,
  formatWorkerSkillsForPrompt,
  resetSkillsCache,
  SKILLS_INDEX_MAX_CHARS,
  skillsGeneration,
  WORKER_SKILLS_INDEX_MAX_CHARS,
} from "./skills";

function fakeSkill(i: number, scope: DiscoveredSkill["scope"] = "project"): DiscoveredSkill {
  return {
    name: `skill-${String(i).padStart(3, "0")}`,
    description: `Description number ${i} ${"padding ".repeat(12)}`,
    skillMdPath: `/x/skill-${i}/SKILL.md`,
    rootDir: `/x/skill-${i}`,
    scope,
  };
}

describe("skills prompt indexes", () => {
  it("bounds the main index and points at the remainder", () => {
    const text = formatCompactSkillsForPrompt(Array.from({ length: 400 }, (_, i) => fakeSkill(i)))!;
    expect(text.length).toBeLessThan(SKILLS_INDEX_MAX_CHARS + 600);
    expect(text).toContain("skill_load(name)");
    expect(text).toMatch(/- \.\.\.and \d+ more \(context_load topic=skills lists them\)$/);
  });

  it("gives workers names only, bounded", () => {
    const text = formatWorkerSkillsForPrompt(Array.from({ length: 400 }, (_, i) => fakeSkill(i)))!;
    expect(text.length).toBeLessThanOrEqual(WORKER_SKILLS_INDEX_MAX_CHARS + 40);
    expect(text).toContain("skill-000");
    expect(text).not.toContain("Description number");
    expect(text).toMatch(/\.\.\.and \d+ more$/);
    expect(formatWorkerSkillsForPrompt([])).toBeNull();
  });

  it("lists project skills before user and bundled ones in /skills", () => {
    const text = formatSkillsForChat([fakeSkill(1, "builtin"), fakeSkill(2, "user"), fakeSkill(3, "project")], "/repo");
    expect(text.indexOf("skill-003 [project]")).toBeLessThan(text.indexOf("skill-002 [user]"));
    expect(text.indexOf("skill-002 [user]")).toBeLessThan(text.indexOf("skill-001 [builtin]"));
    expect(text).toContain("/skill-create");
  });

  it("bumps the generation on every cache reset (prompt prefix cache key)", () => {
    const before = skillsGeneration();
    resetSkillsCache();
    expect(skillsGeneration()).toBe(before + 1);
  });
});

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

afterEach(() => {
  resetSkillsCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("discoverSkills", () => {
  it("bundles Muonroi Flow and omits legacy shared definitions without deleting their files", () => {
    const repoRoot = makeTempDir("muonroi-skills-native-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeSkill(repoRoot, "gsd-execute-phase", "Legacy workflow");
    writeSkill(repoRoot, "muonroi-flow", "Untrusted override");
    const legacy = path.join(repoRoot, ".agents/skills/gsd-execute-phase/SKILL.md");
    const before = fs.readFileSync(legacy, "utf8");
    const skills = discoverSkills(repoRoot);
    expect(skills.some((s) => /^gsd(?:-|$)/.test(s.name))).toBe(false);
    const native = skills.find((s) => s.name === "muonroi-flow")!;
    expect(native.scope).toBe("builtin");
    expect(fs.readFileSync(native.skillMdPath, "utf8")).toContain("flow_plan_review");
    expect(fs.readFileSync(legacy, "utf8")).toBe(before);
  });
  it("discovers project skills from parent directories up to the git root", () => {
    const repoRoot = makeTempDir("muonroi-skills-root-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Host browser smoke testing");

    const skills = discoverSkills(nested);
    expect(skills.map((skill) => skill.name)).toContain("agent-browser");
    expect(skills.find((skill) => skill.name === "agent-browser")?.scope).toBe("project");
  });

  it("lets nearer project skills override parent project skills", () => {
    const repoRoot = makeTempDir("muonroi-skills-override-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Root browser skill");
    writeSkill(path.join(repoRoot, "tmp"), "agent-browser", "Nested browser skill");

    const skills = discoverSkills(nested);
    expect(skills.find((skill) => skill.name === "agent-browser")?.description).toBe("Nested browser skill");
  });

  // Round 4 (G10): a `Dirent` for a symlink is not a directory
  // (`e.isDirectory()` is false even when the link resolves to one), so
  // `.agents/skills/<name>` as a SYMLINK (e.g. Shipd's
  // `.agents/skills/shipd-challenge -> ../../shipd-verify/skill`, matching
  // Claude Code's own support for symlinked skill dirs) was silently
  // invisible — `listSkillDirectories` skipped it outright.
  it("discovers a symlinked skill directory, with its frontmatter name/description", () => {
    const repoRoot = makeTempDir("muonroi-skills-symlink-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    // The real target lives OUTSIDE .agents/skills/, mirroring
    // shipd-verify/skill being the real directory and
    // .agents/skills/shipd-challenge being a symlink pointing at it.
    const realTarget = path.join(repoRoot, "shipd-verify-skill");
    fs.mkdirSync(realTarget, { recursive: true });
    fs.writeFileSync(
      path.join(realTarget, "SKILL.md"),
      "---\nname: shipd-challenge\ndescription: Author a Shipd challenge\n---\n\n# shipd-challenge\n",
      "utf8",
    );

    const skillsDir = path.join(repoRoot, ".agents", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(realTarget, path.join(skillsDir, "shipd-challenge"), "dir");

    const skills = discoverSkills(repoRoot);
    const found = skills.find((skill) => skill.name === "shipd-challenge");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Author a Shipd challenge");
    expect(found?.scope).toBe("project");
  });

  it("skips a dangling symlink without throwing", () => {
    const repoRoot = makeTempDir("muonroi-skills-dangling-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    const skillsDir = path.join(repoRoot, ".agents", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    // Points at a target that does not exist.
    fs.symlinkSync(path.join(repoRoot, "does-not-exist"), path.join(skillsDir, "ghost-skill"), "dir");

    expect(() => discoverSkills(repoRoot)).not.toThrow();
    const skills = discoverSkills(repoRoot);
    expect(skills.find((skill) => skill.name === "ghost-skill")).toBeUndefined();
  });

  it("outside a git repository scans only the cwd, not every parent up to the drive root", () => {
    const outer = makeTempDir("muonroi-skills-nogit-");
    const inner = path.join(outer, "work");
    fs.mkdirSync(inner, { recursive: true });
    writeSkill(outer, "parent-only", "Lives in a non-git parent");
    writeSkill(inner, "cwd-skill", "Lives in the cwd");
    const names = discoverSkills(inner).map((s) => s.name);
    expect(names).toContain("cwd-skill");
    expect(names).not.toContain("parent-only");
  });

  it("reads user skills from <cli home>/skills", () => {
    const repoRoot = makeTempDir("muonroi-skills-clihome-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const home = makeTempDir("muonroi-skills-clihome-home-");
    const saved = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = home;
    try {
      const dir = path.join(home, "skills", "cli-owned");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: cli-owned\ndescription: From cli home\n---\n");
      expect(discoverSkills(repoRoot).find((s) => s.name === "cli-owned")?.scope).toBe("user");
    } finally {
      if (saved === undefined) delete process.env.MUONROI_CLI_HOME;
      else process.env.MUONROI_CLI_HOME = saved;
    }
  });

  it("skips a symlink that resolves to a plain FILE, not a directory", () => {
    const repoRoot = makeTempDir("muonroi-skills-file-symlink-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    const realFile = path.join(repoRoot, "not-a-skill.txt");
    fs.writeFileSync(realFile, "just a file, not a skill directory", "utf8");

    const skillsDir = path.join(repoRoot, ".agents", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(realFile, path.join(skillsDir, "file-skill"), "file");

    expect(() => discoverSkills(repoRoot)).not.toThrow();
    const skills = discoverSkills(repoRoot);
    expect(skills.find((skill) => skill.name === "file-skill")).toBeUndefined();
  });
});
