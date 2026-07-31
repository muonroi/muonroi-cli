import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import type { TaskRequest } from "../../types/index.js";
import { buildSubagentPrompt, MODE_PROMPTS } from "../prompts.js";

/**
 * Locks the invariants that commit dfd1d517 relies on.
 *
 * That commit removed the Explore sub-agent's local rule
 * `"Do not create, modify, or delete files."` because it duplicated
 * `MODE_PROMPTS["ask"]`'s `"NEVER create, modify, or delete files"`, which
 * `buildSystemPrompt` appends anyway. The dedup is only safe while FOUR
 * separate facts hold — and each lives in a different part of the assembly:
 *
 *   1. Explore resolves to mode `ask` (prompts.ts:675)
 *   2. `MODE_PROMPTS.ask` carries the read-only rule in its BEHAVIOR block, not
 *      its TOOLS block — `stripToolsSection` deletes TOOLS wholesale for every
 *      non-anthropic provider (prompts.ts:440), which is what Explore actually
 *      runs on
 *   3. `buildSubagentPrompt` still appends `buildSystemPrompt(..., {subAgent:true})`
 *   4. the two rules that were NOT duplicates survive
 *
 * Break any one and the Explore sub-agent silently loses its only read-only
 * instruction — a regression no type checker or existing test would catch. The
 * council that proposed the dedup listed exactly this snapshot as an MVP item
 * ("Snapshot Explore prompt", mitigation for "Assembly sub-agent brittle").
 */
describe("Explore sub-agent prompt invariants", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-explore-prompt-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  const request = { agent: "explore", description: "map the prompt layers" } as TaskRequest;
  const build = (providerId: string) => buildSubagentPrompt(request, tmpHome, null, "off", [], undefined, providerId);

  beforeAll(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    loadCatalog();
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  it("keeps the read-only rule reachable on an anthropic-style provider", () => {
    expect(build("anthropic")).toContain("NEVER create, modify, or delete files");
  });

  it("keeps the read-only rule reachable on a non-anthropic provider (TOOLS section stripped)", () => {
    // The regression that matters: Explore runs on deepseek/openai-style
    // providers, where stripToolsSection removes the whole TOOLS block. The rule
    // must therefore live in BEHAVIOR, and this asserts it survives that path.
    const prompt = build("deepseek");
    expect(prompt).toContain("NEVER create, modify, or delete files");
  });

  it("carries no LOCAL read-only duplicate any more", () => {
    // The exact string dfd1d517 deleted. Re-adding it re-creates the duplication
    // the council debated away; the assertion above already proves the rule is
    // still delivered by the mode prompt.
    expect(build("anthropic")).not.toContain("Do not create, modify, or delete files.");
  });

  it("still appends the sub-agent system prompt (contract + environment)", () => {
    // Cutting the embedded buildSystemPrompt call was the REJECTED option — it
    // carries the operating contract, ENVIRONMENT, cwd and date. If it goes, the
    // read-only rule goes with it, which is why this is asserted here and not
    // only in a prompt-size test.
    const prompt = build("anthropic");
    expect(prompt).toContain("Delegated task: map the prompt layers");
    expect(prompt.indexOf("Delegated task:")).toBeLessThan(prompt.indexOf("NEVER create, modify, or delete files"));
  });

  it("retains the two Explore rules that were never duplicates", () => {
    const prompt = build("anthropic");
    expect(prompt).toContain("Prefer `read_file` and search commands over broad shell exploration.");
    expect(prompt).toContain("FOR THE PARENT AGENT");
  });

  it("pins the read-only rule to the BEHAVIOR block of MODE_PROMPTS.ask", () => {
    // Guards the delivery mechanism itself: if someone moves the rule up into
    // TOOLS, every non-anthropic Explore run loses it while the anthropic test
    // above would still pass.
    const ask = MODE_PROMPTS.ask;
    const behaviorAt = ask.indexOf("BEHAVIOR:");
    const ruleAt = ask.indexOf("NEVER create, modify, or delete files");
    expect(behaviorAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeGreaterThan(behaviorAt);
  });
});
