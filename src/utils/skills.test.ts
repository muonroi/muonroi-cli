import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills, resetSkillsCache } from "./skills";

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
