import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "../types/index.js";
import {
  CHEAP_MODEL_CONVERGENCE,
  getCheapModelWorkbook,
  injectCheapModelWorkbook,
  shouldInjectCheapModelWorkbook,
  subagentTaskType,
} from "./cheap-model-workbooks.js";

const base = { id: "x", name: "x", description: "", provider: "x", contextWindow: 100_000 } as const;
const info = (tier: ModelInfo["tier"]): ModelInfo => ({ ...base, tier }) as unknown as ModelInfo;

describe("shouldInjectCheapModelWorkbook", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK;
    delete process.env.MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK;
    else process.env.MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK = saved;
  });

  it("fires on fast tier only", () => {
    expect(shouldInjectCheapModelWorkbook(info("fast"))).toBe(true);
    expect(shouldInjectCheapModelWorkbook(info("balanced"))).toBe(false);
    expect(shouldInjectCheapModelWorkbook(info("premium"))).toBe(false);
    expect(shouldInjectCheapModelWorkbook(undefined)).toBe(false);
  });

  it("env override disables it", () => {
    process.env.MUONROI_DISABLE_CHEAP_MODEL_WORKBOOK = "1";
    expect(shouldInjectCheapModelWorkbook(info("fast"))).toBe(false);
  });
});

describe("getCheapModelWorkbook", () => {
  it("always includes the convergence (anti-ramble) block", () => {
    expect(getCheapModelWorkbook("debug")).toContain(CHEAP_MODEL_CONVERGENCE);
    expect(getCheapModelWorkbook(null)).toContain(CHEAP_MODEL_CONVERGENCE);
  });

  it("specialises per task type", () => {
    expect(getCheapModelWorkbook("debug")).toMatch(/read the ACTUAL error|smallest root cause/i);
    expect(getCheapModelWorkbook("debug")).toContain("continue-on-error");
    expect(getCheapModelWorkbook("generate")).toMatch(/GENERATE/);
    expect(getCheapModelWorkbook("refactor")).toMatch(/only what was named/i);
    expect(getCheapModelWorkbook("analyze")).toMatch(/do not read the whole codebase/i);
  });

  it("falls back to convergence-only for an unlisted task type", () => {
    const general = getCheapModelWorkbook("general");
    expect(general).toContain(CHEAP_MODEL_CONVERGENCE);
    // no per-type addendum line for "general"
    expect(general).not.toMatch(/DEBUG:|GENERATE:|REFACTOR:|ANALYZE:/);
  });

  it("emphasises minimising tool calls (the cost lever)", () => {
    expect(CHEAP_MODEL_CONVERGENCE).toMatch(/FEWEST|minimise tool calls/i);
    expect(CHEAP_MODEL_CONVERGENCE).toMatch(/STOP investigating/i);
  });

  it("steers a crisp completion line — finish the action, don't stop mid-step (A4)", () => {
    // Live obs (workbook run 3308b3d02e11): the model's FINAL message was a
    // mid-action narration ("I'm verifying the final workflow content now…")
    // instead of stating completion. Steer it to finish, then state done.
    expect(CHEAP_MODEL_CONVERGENCE).toMatch(/finish the action|don't stop mid|do not stop mid/i);
    expect(CHEAP_MODEL_CONVERGENCE).toMatch(/one line|1 line|state.*(done|complet)/i);
  });

  it("stays compact (under 1000 chars) to preserve attention budget", () => {
    // Bumped 900 → 1000 when the A4 completion-line rule was added.
    expect(getCheapModelWorkbook("debug").length).toBeLessThan(1000);
  });
});

describe("subagentTaskType", () => {
  // Sub-agents have no PIL classifier run of their own; their role IS their
  // task type. The Explore agent is read-only research → analyze; the verify
  // family runs tests/diagnoses failures → debug. Everything else (general,
  // vision, computer, custom) gets the convergence-only block (null).
  it("maps explore → analyze", () => {
    expect(subagentTaskType("explore")).toBe("analyze");
  });

  it("maps the verify family → debug", () => {
    expect(subagentTaskType("verify")).toBe("debug");
    expect(subagentTaskType("verify-detect")).toBe("debug");
    expect(subagentTaskType("verify-manifest")).toBe("debug");
  });

  it("returns null (convergence-only) for general/vision/computer", () => {
    expect(subagentTaskType("general")).toBeNull();
    expect(subagentTaskType("vision")).toBeNull();
    expect(subagentTaskType("computer")).toBeNull();
  });

  it("returns null for an unknown/custom sub-agent name", () => {
    expect(subagentTaskType("my-custom-agent")).toBeNull();
    expect(subagentTaskType("")).toBeNull();
  });

  it("feeds the workbook builder — explore yields the ANALYZE addendum", () => {
    const wb = getCheapModelWorkbook(subagentTaskType("explore"));
    expect(wb).toMatch(/do not read the whole codebase/i);
  });
});

describe("injectCheapModelWorkbook", () => {
  it("prepends the workbook to the system prompt", () => {
    const out = injectCheapModelWorkbook("You are an agent.", "debug");
    expect(out.startsWith(getCheapModelWorkbook("debug"))).toBe(true);
    expect(out.endsWith("You are an agent.")).toBe(true);
  });

  it("is idempotent for the same task type", () => {
    const once = injectCheapModelWorkbook("Sys.", "debug");
    const twice = injectCheapModelWorkbook(once, "debug");
    expect(twice).toBe(once);
  });
});
