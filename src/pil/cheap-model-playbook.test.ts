import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "../types/index.js";
import {
  appendCheapModelPlaybook,
  CHEAP_MODEL_PLAYBOOK,
  injectCheapModelPlaybook,
  shouldInjectCheapModelPlaybook,
} from "./cheap-model-playbook.js";

const baseInfo = {
  id: "x",
  name: "x",
  description: "",
  provider: "x",
  contextWindow: 100_000,
} as const;

function info(tier: ModelInfo["tier"]): ModelInfo {
  return { ...baseInfo, tier } as unknown as ModelInfo;
}

describe("shouldInjectCheapModelPlaybook", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK;
    delete process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK;
    else process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = savedEnv;
  });

  it("fires on fast tier", () => {
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(true);
  });

  it("does NOT fire on balanced tier", () => {
    expect(shouldInjectCheapModelPlaybook(info("balanced"))).toBe(false);
  });

  it("does NOT fire on premium tier", () => {
    expect(shouldInjectCheapModelPlaybook(info("premium"))).toBe(false);
  });

  it("does NOT fire when modelInfo is undefined", () => {
    expect(shouldInjectCheapModelPlaybook(undefined)).toBe(false);
  });

  it("does NOT fire when tier is absent on ModelInfo", () => {
    const noTier = { ...baseInfo } as unknown as ModelInfo;
    expect(shouldInjectCheapModelPlaybook(noTier)).toBe(false);
  });

  it("env override disables for fast tier", () => {
    process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = "1";
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(false);
  });

  it("env override with non-'1' value does not disable", () => {
    process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = "0";
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(true);
    process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = "true";
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(true);
  });
});

describe("injectCheapModelPlaybook", () => {
  it("PREPENDS the playbook so it lands at the front of attention", () => {
    const out = injectCheapModelPlaybook("You are an agent.");
    expect(out).toBe(`${CHEAP_MODEL_PLAYBOOK}You are an agent.`);
    // Primacy property — system prompt now opens with the CRITICAL marker.
    expect(out.startsWith("[CRITICAL TOOL-USE RULES")).toBe(true);
  });

  it("is idempotent — passing already-prefixed prompt returns it unchanged", () => {
    const once = injectCheapModelPlaybook("Sys.");
    const twice = injectCheapModelPlaybook(once);
    expect(twice).toBe(once);
  });

  it("playbook content mentions the four key tool steering rules", () => {
    expect(CHEAP_MODEL_PLAYBOOK).toContain("bash_output_get");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/task\(agent="explore"\)/);
    expect(CHEAP_MODEL_PLAYBOOK).toContain("grep");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/ERROR/);
  });

  it("rule 1 wording now applies to every bash call (not just retries)", () => {
    // Live forensics showed cheap models rationalized that the first call
    // isn't a re-run, so the "NEVER re-run" wording let them skip the rule.
    // The new wording explicitly says EVERY bash call.
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/EVERY bash call/i);
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/do NOT pipe.*tail/i);
  });

  it("steers fix QUALITY: root-cause over masking (rule 5) and read real failure logs (rule 6)", () => {
    // Grounded in a live observation (gpt-5.4-mini self-fixing a failing CI
    // workflow): the cheap model masked the failure with `continue-on-error:
    // true` instead of guarding the missing-secret root cause, and never read
    // the actual run log. These two rules steer fast-tier models away from
    // symptom-masking and toward evidence-first root-cause fixes.
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/root cause/i);
    expect(CHEAP_MODEL_PLAYBOOK).toContain("continue-on-error");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/CONDITIONAL|skip when absent/i);
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/failure (log|output)|run log/i);
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/before .*hypothesi/i);
  });

  it("playbook stays short (under 1600 chars) to preserve attention budget", () => {
    // Bumped 1500 → 1600 when rules 5/6 (fix-quality steering) were added.
    // Still a tight prelude; primacy placement matters more than absolute length.
    expect(CHEAP_MODEL_PLAYBOOK.length).toBeLessThan(1600);
  });

  it("deprecated appendCheapModelPlaybook alias still works (now actually prepends)", () => {
    const out = appendCheapModelPlaybook("Sys.");
    expect(out).toBe(`${CHEAP_MODEL_PLAYBOOK}Sys.`);
  });
});
