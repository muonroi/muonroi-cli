import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getModelByTier, loadCatalog } from "../../models/registry.js";
import { loadCustomInstructions } from "../../utils/instructions.js";
import { buildSystemPromptParts, resetStaticPrefixCache } from "../prompts.js";

const original = process.env.MUONROI_PROGRESSIVE_CONTEXT;
const roots: string[] = [];
beforeAll(async () => {
  await loadCatalog();
});
afterEach(() => {
  if (original === undefined) delete process.env.MUONROI_PROGRESSIVE_CONTEXT;
  else process.env.MUONROI_PROGRESSIVE_CONTEXT = original;
  resetStaticPrefixCache();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("progressive prompt invariants", () => {
  it("separates root and worker cached guidance while retaining runtime policy", () => {
    process.env.MUONROI_PROGRESSIVE_CONTEXT = "1";
    const model = getModelByTier("fast");
    if (!model) throw new Error("Fixture catalog lacks a fast-tier model");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-prefix-"));
    roots.push(root);
    const skill = path.join(root, ".agents", "skills", "role-skill");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: role-skill\ndescription: Scoped role guidance fixture\n---\nUse assigned evidence.\n",
    );
    const build = (executionRole?: "orchestrator" | "worker" | "infrastructure") =>
      buildSystemPromptParts(root, "agent", "off", undefined, [], undefined, model.provider, undefined, {
        executionRole,
        permissionMode: "safe",
      });
    const workerFirst = build("worker");
    const main = build("orchestrator");
    const workerAfter = build("worker");
    expect(main.staticPrefix).toContain("main coordination");
    expect(main.staticPrefix).toContain("runtime-only");
    expect(main.staticPrefix).toContain('topic="working_set"');
    expect(main.staticPrefix).toContain("native read_file and grep");
    expect(main.staticPrefix).not.toContain("RESEARCH FIRST: explore code");
    expect(main.staticPrefix).toContain("role-skill");
    expect(main.staticPrefix).toContain("call skill_load(name) and follow the returned instructions");
    expect(main.staticPrefix).not.toContain("Delegate reading the selected SKILL.md");
    expect(workerFirst.staticPrefix).toBe(workerAfter.staticPrefix);
    expect(workerAfter.staticPrefix).toContain("read_file / grep");
    expect(build().staticPrefix).toBe(workerFirst.staticPrefix);
    expect(build("infrastructure").staticPrefix).toBe(workerFirst.staticPrefix);
    expect(build("orchestrator").staticPrefix).toBe(main.staticPrefix);
    expect(main.dynamicSuffix).toContain("permission mode: safe");
  });
  it("keeps full applicable repo instructions and the permission snapshot while changing only optional catalogs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "progressive-policies-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      "MANDATORY_POLICY_SENTINEL: preserve this exact instruction including repeated words repeated words.\n",
    );
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      "OTHER_REQUIRED_POLICY_SENTINEL: required checks remain authoritative.\n",
    );
    const model = getModelByTier("fast");
    if (!model) throw new Error("Fixture catalog lacks a fast-tier model");
    const build = (toolTurn = false) =>
      buildSystemPromptParts(root, "agent", "off", undefined, [], undefined, model.provider, undefined, {
        toolTurn,
        permissionMode: "safe",
      });
    process.env.MUONROI_PROGRESSIVE_CONTEXT = "0";
    const legacy = build();
    process.env.MUONROI_PROGRESSIVE_CONTEXT = "1";
    const progressive = build();
    const reduced = build(true);
    const policy = loadCustomInstructions(root)!;
    expect(legacy.staticPrefix).toContain(policy);
    expect(progressive.staticPrefix).toContain(policy);
    expect(progressive.staticPrefix).not.toContain("CLI STEERING & PROMPT INJECTION");
    expect(legacy.staticPrefix).toContain("CLI STEERING & PROMPT INJECTION");
    expect(progressive.staticPrefix).toBe(reduced.staticPrefix);
    expect(progressive.dynamicSuffix).toContain("permission mode: safe");
    expect(progressive.staticPrefix).toContain("context_load");
    expect(Object.values(progressive.components!).reduce((a, b) => a + b, 0)).toBe(progressive.staticPrefix.length);
    expect(reduced.components).toEqual(progressive.components);
    expect(progressive.components!.systemCustomChars).toBe(legacy.components!.systemCustomChars);
  });
});
