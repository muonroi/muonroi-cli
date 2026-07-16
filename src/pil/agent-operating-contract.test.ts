import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_OPERATING_CONTRACT, buildContractSection } from "./agent-operating-contract.js";

describe("AGENT_OPERATING_CONTRACT", () => {
  it("covers core work phases + anti-mù compaction contract (upgrade)", () => {
    expect(AGENT_OPERATING_CONTRACT).toMatch(/BEFORE ACTING/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/READING/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/EXECUTING/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/WHEN UNSURE/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/REPORTING/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/ANTI-MÙ\s*\/\s*COMPACTION/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/PRESERVE_FULL_CONTEXT/i);
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

  it("REPORTING forbids over-answering with unrequested numbers", () => {
    // Live (deepseek Task B, 2026-06-04): the model volunteered an unrequested,
    // wrong "10026 total lines" stat. REPORTING must steer "answer only what
    // was asked".
    expect(AGENT_OPERATING_CONTRACT).toMatch(/only what (was|is) asked|do not volunteer|don't volunteer/i);
  });

  it("REPORTING forbids claiming verification or edits that were not actually done", () => {
    // Live (grok, 2026-06-06): the model reported it added listener-cleanup code
    // and "verified" a build — but the cleanup was never written and the build
    // step was skipped (it hit a phantom sandbox path). REPORTING must forbid
    // claiming a build/test ran or that code was applied unless it actually was.
    expect(AGENT_OPERATING_CONTRACT).toMatch(/never claim a (build|test|command|verification)/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/describe edits|did not actually (do|apply|run)/i);
  });

  it("has clear start/end markers so the model treats it as a prelude", () => {
    expect(AGENT_OPERATING_CONTRACT).toMatch(/AGENT OPERATING CONTRACT/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/END CONTRACT/i);
  });

  it("carries the git-safety rule (never push on red; no broad git add of secrets)", () => {
    expect(AGENT_OPERATING_CONTRACT).toMatch(/GIT SAFETY/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/push on red|never push/i);
    expect(AGENT_OPERATING_CONTRACT).toMatch(/git add -A|stage explicitly/i);
  });

  it("stays compact (under 2000 chars) to preserve attention budget on every turn (git-safety rule added)", () => {
    expect(AGENT_OPERATING_CONTRACT.length).toBeLessThan(2000);
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
