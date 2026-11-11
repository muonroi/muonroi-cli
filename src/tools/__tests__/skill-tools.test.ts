import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_USER_DISMISSED } from "../../orchestrator/ask-user.js";
import { filterExecutionTools } from "../../orchestrator/orchestration-policy.js";
import { resetSkillsCache } from "../../utils/skills.js";
import { registerSkillTools } from "../skill-tools.js";
import { filterScopedWorkerTools } from "../worker-write-scope.js";

const tempDirs: string[] = [];
let savedCliHome: string | undefined;

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-skill-tools-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, ".agents", "skills", "seeded");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    "---\nname: seeded\ndescription: Seeded.\n---\n\nSEEDED-BODY for $ARGUMENTS\n",
  );
  fs.writeFileSync(path.join(dir, "references", "guide.md"), "ref");
  return root;
}

async function call(tools: ToolSet, name: string, input: unknown): Promise<string> {
  const t = tools[name] as { execute: (i: unknown, ctx: unknown) => Promise<string> };
  return t.execute(input, { toolCallId: "t1", messages: [] });
}

beforeEach(() => {
  savedCliHome = process.env.MUONROI_CLI_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-skill-tools-home-"));
  tempDirs.push(home);
  process.env.MUONROI_CLI_HOME = home;
  resetSkillsCache();
});

afterEach(() => {
  if (savedCliHome === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = savedCliHome;
  resetSkillsCache();
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("skill_load", () => {
  it("returns the body without frontmatter, substituted arguments and bundled files", async () => {
    const root = repo();
    const tools: ToolSet = {};
    registerSkillTools(tools, () => root, { allowCreate: false });
    expect(tools.skill_create).toBeUndefined();
    const out = await call(tools, "skill_load", { name: "seeded", arguments: "v3" });
    expect(out).toContain("SEEDED-BODY for v3");
    expect(out).not.toContain("description: Seeded.");
    expect(out).toContain("- references/guide.md");
  });

  it("names the available skills when the name is unknown", async () => {
    const root = repo();
    const tools: ToolSet = {};
    registerSkillTools(tools, () => root, { allowCreate: false });
    const out = await call(tools, "skill_load", { name: "missing" });
    expect(out).toMatch(/^ERROR: No skill named "missing"\. Available: .*seeded/);
  });
});

describe("skill_create", () => {
  it("creates a skill that skill_load serves in the same session", async () => {
    const root = repo();
    const tools: ToolSet = {};
    registerSkillTools(tools, () => root, { allowCreate: true });
    const out = await call(tools, "skill_create", {
      name: "fresh-one",
      description: "Fresh. Use when testing.",
      scope: "project",
      instructions: "FRESH-BODY",
    });
    expect(out).toContain('Created skill "fresh-one" (project)');
    expect(await call(tools, "skill_load", { name: "fresh-one" })).toContain("FRESH-BODY");
  });

  it("refuses invalid names without writing", async () => {
    const root = repo();
    const tools: ToolSet = {};
    registerSkillTools(tools, () => root, { allowCreate: true });
    const out = await call(tools, "skill_create", { name: "../../etc", description: "x", scope: "project" });
    expect(out).toMatch(/^ERROR: Invalid skill name/);
  });

  it("replaces an existing skill only after the host asks and the user says overwrite", async () => {
    const root = repo();
    const target = path.join(root, ".agents", "skills", "seeded", "SKILL.md");
    const before = fs.readFileSync(target, "utf8");
    const askUser = vi.fn(async () => "keep");
    const tools: ToolSet = {};
    registerSkillTools(tools, () => root, { allowCreate: true, askUser });
    const input = { name: "seeded", description: "New.", scope: "project", instructions: "NEW" };

    expect(await call(tools, "skill_create", input)).toContain("call skill_create again with overwrite=true");
    expect(askUser).not.toHaveBeenCalled();

    expect(await call(tools, "skill_create", { ...input, overwrite: true })).toMatch(/^NOT CHANGED/);
    askUser.mockResolvedValueOnce(ASK_USER_DISMISSED);
    expect(await call(tools, "skill_create", { ...input, overwrite: true })).toContain("dismissed");
    expect(fs.readFileSync(target, "utf8")).toBe(before);

    askUser.mockResolvedValueOnce("overwrite");
    expect(await call(tools, "skill_create", { ...input, overwrite: true })).toContain("Replaced skill");
    expect(fs.readFileSync(target, "utf8")).toContain("NEW");
  });

  it("refuses to overwrite when no answerer exists", async () => {
    const root = repo();
    const tools: ToolSet = {};
    registerSkillTools(tools, () => root, { allowCreate: true });
    const out = await call(tools, "skill_create", {
      name: "seeded",
      description: "New.",
      scope: "project",
      overwrite: true,
    });
    expect(out).toContain("no interactive answerer");
  });
});

describe("role boundaries", () => {
  it("main gets both tools; workers and scoped workers get skill_load only", () => {
    const tools: ToolSet = {};
    registerSkillTools(tools, () => os.tmpdir(), { allowCreate: true });
    expect(Object.keys(filterExecutionTools(tools, tools, "orchestrator")).sort()).toEqual([
      "skill_create",
      "skill_load",
    ]);
    expect(Object.keys(filterExecutionTools(tools, tools, "worker"))).toEqual(["skill_load"]);
    expect(Object.keys(filterExecutionTools(tools, tools, "infrastructure"))).toEqual(["skill_load"]);
    expect(Object.keys(filterScopedWorkerTools(tools, tools))).toEqual(["skill_load"]);
  });
});
