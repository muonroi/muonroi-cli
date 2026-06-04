import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_OPERATING_CONTRACT, buildContractSection } from "./agent-operating-contract.js";

describe("AGENT_OPERATING_CONTRACT", () => {
  it("covers all five work phases", () => {
    expect(AGENT_OPERATING_CONTRACT).toMatch(/BEFORE ACTING/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/READING/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/EXECUTING/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/WHEN UNSURE/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/REPORTING/i);
  });

  it("carries the anti-hallucination / grounding rule in the REPORTING phase", () => {
    // The decisive failure this contract addresses: a model asserting a count
    // or file:line it never verified (live: deepseek claimed 67 tests, actual
    // 401). REPORTING must forbid guessing numbers and require running the check
    // or labelling "unverified".
    expect(AGENT_OPERATING_CONTRACT).toMatch(/unverified/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/never guess|do not guess/i);
  });

  it("forbids masking failures in the EXECUTING phase", () => {
    expect(AGENT_OPERATING_CONTRACT).toMatch(/\|\| true|swallow|skipped|mask/i);
  });

  it("requires verify/cross-check before concluding when unsure", () => {
    expect(AGENT_OPERATING_CONTRACT).toMatch(/verify|cross-check|reproduc/i);
  });

  it("has clear start/end markers so the model treats it as a prelude", () => {
    expect(AGENT_OPERATING_CONTRACT).toMatch(/AGENT OPERATING CONTRACT/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/END CONTRACT/i);
  });

  it("stays compact (under 1200 chars) to preserve attention budget on every turn", () => {
    expect(AGENT_OPERATING_CONTRACT.length).toBeLessThan(1200);
  });
});

describe("buildContractSection", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.MUONROI_DISABLE_AGENT_CONTRACT;
    delete process.env.MUONROI_DISABLE_AGENT_CONTRACT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MUONROI_DISABLE_AGENT_CONTRACT;
    else process.env.MUONROI_DISABLE_AGENT_CONTRACT = saved;
  });

  it("returns the contract followed by a blank-line separator by default", () => {
    const section = buildContractSection();
    expect(section.startsWith(AGENT_OPERATING_CONTRACT)).toBe(true);
    expect(section.endsWith("\n\n")).toBe(true);
  });

  it("is empty for chitchat turns (no tools, no factual claims to ground)", () => {
    expect(buildContractSection({ chitchat: true })).toBe("");
  });

  it("is empty when disabled via env override", () => {
    process.env.MUONROI_DISABLE_AGENT_CONTRACT = "1";
    expect(buildContractSection()).toBe("");
    expect(buildContractSection({ chitchat: false })).toBe("");
  });
});
