import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolSet } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { TaskContext } from "../../orchestrator/task-context.js";
import { discoverSkills, formatCompactSkillsForPrompt, resetSkillsCache } from "../../utils/skills.js";
import { registerContextLoader } from "../context-load.js";

const roots: string[] = [];
afterEach(() => {
  resetSkillsCache();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("context_load discoverability and isolation", () => {
  it.each([
    "orchestrator",
    "worker",
    "infrastructure",
    undefined,
  ] as const)("projects %s reference and skill instructions without changing stage", async (role) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-role-"));
    roots.push(root);
    const tools: ToolSet = {};
    const context = new TaskContext("role-fixture", root);
    registerContextLoader(tools, context, () => root, role);
    const run = async (input: unknown) =>
      JSON.parse(
        (await tools.context_load!.execute!(input as never, { toolCallId: "reference", messages: [] })) as string,
      );
    const reference = await run({ topic: "reference" });
    const skills = await run({ topic: "skills", query: "nonexistent" });
    if (role === "orchestrator") {
      expect(reference.content).toContain("main coordination");
      expect(reference.content).toContain("runtime-only");
      expect(reference.content).not.toContain("TOOLS (call directly)");
      expect(reference.content).not.toContain("flow_execute");
      expect(reference.content).toContain("Native read_file and grep only read");
      expect(skills.note).toContain("Read the original");
      expect(skills.note).not.toContain("Delegate reading");
    } else {
      expect(reference.content).toContain("TOOLS (call directly)");
      expect(reference.content).toContain("verification_run");
      expect(skills.note).toContain("Read the original");
    }
    if (role === "worker") {
      expect(reference.note).toContain("workers cannot recursively dispatch");
      expect(reference.note).toContain("explore/review remain read-only");
    }
    expect(context.snapshot().stage).toBe("orient");
  });
  it("keeps all skill names discoverable with original metadata/path pagination", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-skills-"));
    roots.push(root);
    for (let i = 0; i < 7; i++) {
      const dir = path.join(root, ".agents/skills", `phase-fixture-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: phase-fixture-${i}\ndescription: required fixture details ${"long-description ".repeat(30)}\n---\nDO_NOT_OMIT_REQUIRED_SKILL_${i}\n`,
      );
    }
    const tools: ToolSet = {};
    const context = new TaskContext("main", root);
    registerContextLoader(tools, context, () => root);
    const run = async (input: unknown) =>
      JSON.parse((await tools.context_load!.execute!(input as never, { toolCallId: "ctx", messages: [] })) as string);
    const index = formatCompactSkillsForPrompt(discoverSkills(root))!;
    for (let i = 0; i < 7; i++) expect(index).toContain(`phase-fixture-${i}`);
    const first = await run({ topic: "skills", query: "phase-fixture" });
    expect(first.total).toBe(7);
    expect(first.skills).toHaveLength(5);
    const second = await run({ topic: "skills", query: "phase-fixture", offset: first.next_offset });
    expect(second.skills).toHaveLength(2);
    expect(second.next_offset).toBeNull();
    const named = await run({ topic: "skills", query: "phase-fixture-6" });
    expect(fs.readFileSync(named.skills[0].path, "utf8")).toContain("DO_NOT_OMIT_REQUIRED_SKILL_6");
    expect((await run({ topic: "skills", query: "no-such-fixture" })).skills).toEqual([]);
    expect(context.snapshot().stage).toBe("orient");
    expect((await run({ topic: "skills", offset: -1 })).error).toBeDefined();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      tools.context_load!.execute!({ stage: "verify" } as never, {
        toolCallId: "abort",
        messages: [],
        abortSignal: aborted.signal,
      }),
    ).rejects.toThrow();
    expect(context.snapshot().stage).toBe("orient");
  });
});
