import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSkillMarkdown,
  createSkill,
  parseSkillCreateArgs,
  runSkillCreateFlow,
  type SkillCreateQuestion,
  validateSkillDescription,
  validateSkillName,
} from "./skill-authoring";
import { discoverSkills, findSkill, readSkillBody, resetSkillsCache } from "./skills";

const tempDirs: string[] = [];
let savedCliHome: string | undefined;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function repo(): string {
  const root = tempDir("muonroi-skill-author-");
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

beforeEach(() => {
  savedCliHome = process.env.MUONROI_CLI_HOME;
  process.env.MUONROI_CLI_HOME = tempDir("muonroi-skill-home-");
  resetSkillsCache();
});

afterEach(() => {
  if (savedCliHome === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = savedCliHome;
  resetSkillsCache();
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("validateSkillName", () => {
  it.each(["release-check", "a", "pdf2text", "x".repeat(64)])("accepts %s", (name) => {
    expect(validateSkillName(name)).toBeNull();
  });
  it.each([
    "",
    "Release-Check",
    "-lead",
    "trail-",
    "dou--ble",
    "with space",
    "../escape",
    "a/b",
    "a\\b",
    "dot.name",
    "x".repeat(65),
    "gsd-plan",
    "muonroi-flow",
  ])("rejects %j", (name) => {
    expect(validateSkillName(name)).not.toBeNull();
  });
});

describe("validateSkillDescription", () => {
  it("requires 1..1024 non-blank characters", () => {
    expect(validateSkillDescription("   ")).not.toBeNull();
    expect(validateSkillDescription("x".repeat(1025))).not.toBeNull();
    expect(validateSkillDescription("Does a thing. Use when X.")).toBeNull();
  });
});

describe("buildSkillMarkdown", () => {
  it("round-trips a description with quotes, colons and backslashes through discovery", () => {
    const root = repo();
    const description = 'Handles "quoted" input: C:\\path\\x #1. Use when asked.';
    const result = createSkill({ cwd: root, name: "tricky", description, scope: "project" });
    expect(result.ok).toBe(true);
    const skill = findSkill(discoverSkills(root), "tricky");
    expect(skill?.description).toBe(description);
    expect(skill?.scope).toBe("project");
  });
  it("uses supplied instructions as the body and a scaffold otherwise", () => {
    expect(buildSkillMarkdown({ name: "a-b", description: "d", instructions: "# Mine\nstep" })).toBe(
      '---\nname: a-b\ndescription: "d"\n---\n\n# Mine\nstep\n',
    );
    const scaffold = buildSkillMarkdown({ name: "a-b", description: "Does d." });
    expect(scaffold).toContain("# A B");
    expect(scaffold).toContain("## Instructions");
    expect(scaffold).toContain("$ARGUMENTS");
  });
});

describe("createSkill", () => {
  it("writes project skills under <git root>/.agents/skills even from a subdirectory", () => {
    const root = repo();
    const nested = path.join(root, "pkg", "app");
    fs.mkdirSync(nested, { recursive: true });
    const result = createSkill({ cwd: nested, name: "nested-made", description: "D.", scope: "project" });
    expect(result).toMatchObject({ ok: true, path: path.join(root, ".agents", "skills", "nested-made", "SKILL.md") });
  });

  it("writes user skills under <cli home>/skills and makes them discoverable at once", () => {
    const root = repo();
    discoverSkills(root); // warm the cache: creation must invalidate it
    const result = createSkill({ cwd: root, name: "mine", description: "Personal.", scope: "user" });
    expect(result).toMatchObject({
      ok: true,
      path: path.join(process.env.MUONROI_CLI_HOME!, "skills", "mine", "SKILL.md"),
    });
    expect(findSkill(discoverSkills(root), "mine")?.scope).toBe("user");
  });

  it("refuses to overwrite without the flag and leaves the file untouched", () => {
    const root = repo();
    expect(createSkill({ cwd: root, name: "keep", description: "First.", scope: "project" }).ok).toBe(true);
    const target = path.join(root, ".agents", "skills", "keep", "SKILL.md");
    const before = fs.readFileSync(target, "utf8");
    const again = createSkill({ cwd: root, name: "keep", description: "Second.", scope: "project" });
    expect(again).toMatchObject({ ok: false, code: "exists", path: target });
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const forced = createSkill({ cwd: root, name: "keep", description: "Second.", scope: "project", overwrite: true });
    expect(forced).toMatchObject({ ok: true, overwritten: true });
    expect(fs.readFileSync(target, "utf8")).toContain('"Second."');
  });

  it("rejects traversal and invalid scope before touching disk", () => {
    const root = repo();
    expect(createSkill({ cwd: root, name: "../evil", description: "D.", scope: "project" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      createSkill({ cwd: root, name: "ok-name", description: "D.", scope: "global" as unknown as "user" }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(fs.existsSync(path.join(root, ".agents"))).toBe(false);
  });

  it("reports when a same-named project skill outranks a new user skill", () => {
    const root = repo();
    createSkill({ cwd: root, name: "dup", description: "Project one.", scope: "project" });
    const user = createSkill({ cwd: root, name: "dup", description: "User one.", scope: "user" });
    expect(user.ok && user.note).toContain("takes precedence");
  });
});

describe("parseSkillCreateArgs", () => {
  it("parses name, scope flags and a free-text description", () => {
    expect(parseSkillCreateArgs("notes-digest --user Summarise notes.")).toEqual({
      name: "notes-digest",
      scope: "user",
      description: "Summarise notes.",
    });
    expect(parseSkillCreateArgs('--scope=project x "Quoted desc"')).toEqual({
      name: "x",
      scope: "project",
      description: "Quoted desc",
    });
    expect(parseSkillCreateArgs("")).toEqual({});
  });
});

describe("runSkillCreateFlow", () => {
  function scripted(answers: Array<string | null>) {
    const asked: SkillCreateQuestion[] = [];
    return {
      asked,
      ask: async (q: SkillCreateQuestion) => {
        asked.push(q);
        return answers.length ? answers.shift()! : null;
      },
    };
  }

  it("asks only for missing fields, in order name → description → scope", async () => {
    const root = repo();
    const s = scripted(["flow-made", "Made by the flow. Use when testing.", "project"]);
    const result = await runSkillCreateFlow({ cwd: root, argsText: "", ask: s.ask });
    expect(result.ok).toBe(true);
    expect(s.asked.map((q) => q.question)).toEqual([
      "Skill name?",
      'What does "flow-made" do, and when should it be used?',
      'Where should "flow-made" live?',
    ]);
    expect(s.asked[2]!.options!.map((o) => o.value)).toEqual(["project", "user"]);
    const skill = findSkill(discoverSkills(root), "flow-made")!;
    expect(readSkillBody(skill)).toContain("Made by the flow. Use when testing.");
  });

  it("asks nothing when every field is typed", async () => {
    const root = repo();
    const s = scripted([]);
    const result = await runSkillCreateFlow({ cwd: root, argsText: "typed-one --project Typed.", ask: s.ask });
    expect(result.ok).toBe(true);
    expect(s.asked).toEqual([]);
  });

  it("stops without writing when a question is dismissed or the name is invalid", async () => {
    const root = repo();
    expect((await runSkillCreateFlow({ cwd: root, argsText: "", ask: scripted([null]).ask })).ok).toBe(false);
    const bad = await runSkillCreateFlow({ cwd: root, argsText: "Bad_Name --project D.", ask: scripted([]).ask });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toContain("Nothing was written");
    expect(fs.existsSync(path.join(root, ".agents"))).toBe(false);
  });

  it("confirms before replacing an existing skill and keeps it by default", async () => {
    const root = repo();
    await runSkillCreateFlow({ cwd: root, argsText: "twice --project First.", ask: scripted([]).ask });
    const target = path.join(root, ".agents", "skills", "twice", "SKILL.md");
    const before = fs.readFileSync(target, "utf8");
    const kept = await runSkillCreateFlow({
      cwd: root,
      argsText: "twice --project Second.",
      ask: scripted(["keep"]).ask,
    });
    expect(kept.ok).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const replaced = await runSkillCreateFlow({
      cwd: root,
      argsText: "twice --project Second.",
      ask: scripted(["overwrite"]).ask,
    });
    expect(replaced.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain('"Second."');
  });
});
