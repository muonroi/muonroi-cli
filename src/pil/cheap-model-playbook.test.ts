import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "../types/index.js";
import {
  appendCheapModelPlaybook,
  CHEAP_MODEL_PLAYBOOK,
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

describe("appendCheapModelPlaybook", () => {
  it("appends the playbook with blank-line separator when prompt has no trailing newline", () => {
    const out = appendCheapModelPlaybook("You are an agent.");
    expect(out).toBe(`You are an agent.\n\n${CHEAP_MODEL_PLAYBOOK}`);
  });

  it("uses single newline separator when prompt already ends with newline", () => {
    const out = appendCheapModelPlaybook("You are an agent.\n");
    expect(out).toBe(`You are an agent.\n\n${CHEAP_MODEL_PLAYBOOK}`);
  });

  it("is idempotent — passing already-suffixed prompt returns it unchanged", () => {
    const once = appendCheapModelPlaybook("Sys.");
    const twice = appendCheapModelPlaybook(once);
    expect(twice).toBe(once);
  });

  it("playbook content mentions the four key tool steering rules", () => {
    expect(CHEAP_MODEL_PLAYBOOK).toContain("bash_output_get");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/task\(agent="explore"\)/);
    expect(CHEAP_MODEL_PLAYBOOK).toContain("grep");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/ERROR/);
  });

  it("playbook is short (under 800 chars) to preserve attention budget", () => {
    expect(CHEAP_MODEL_PLAYBOOK.length).toBeLessThan(800);
  });
});
