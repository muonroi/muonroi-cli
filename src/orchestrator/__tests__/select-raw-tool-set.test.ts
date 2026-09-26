import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { selectRawToolSet } from "../tool-engine.js";

/**
 * Parity fix (G2) — "xin chào" (a greeting) on the FIRST turn of a session
 * classified as chitchat, so `isChitchat && !priorTurnHadTools` gave the
 * turn ZERO tools. The project's own FRAMEWORK.md requires running
 * `bash shipd-verify/briefing.sh` unconditionally at session start; with no
 * tools to call, the model emitted raw native tool-call markup as its
 * entire answer (measured live, session 08a9c9a84990). `firstTurnToolsEnabled`
 * is the fix: it wins over BOTH restrictive branches, but only on the first
 * turn — an ordinary later chitchat turn is unaffected.
 *
 * Round 2 (G2 MEDIUM scope): this used to fire on the mere PRESENCE of an
 * AGENTS.md/CLAUDE.md file — a cost/latency change for every project that
 * has one. `firstTurnToolsEnabled` is now the caller's own resolved value
 * of `isFirstTurnToolsEnabledByProject()` (an explicit
 * `.muonroi-cli/settings.json` opt-in), not `loadCustomInstructions() !==
 * null` — `selectRawToolSet` itself stays a pure boolean-in predicate either
 * way, so these tests exercise the same precedence tier under its new name.
 */
describe("selectRawToolSet", () => {
  const baseTools = { bash: {}, read_file: {}, edit_file: {}, grep: {} } as unknown as ToolSet;

  it("a provider with no client-tool support gets none, no matter what else is true", () => {
    const result = selectRawToolSet({
      baseTools,
      supportsClientTools: false,
      firstTurnToolsEnabled: true,
      isChitchat: false,
      isDirectAnswer: false,
      priorTurnHadTools: false,
    });
    expect(result).toEqual({});
  });

  it("G2: first turn + project instructions overrides chitchat's empty tool set", () => {
    const result = selectRawToolSet({
      baseTools,
      supportsClientTools: true,
      firstTurnToolsEnabled: true,
      isChitchat: true,
      isDirectAnswer: false,
      priorTurnHadTools: false,
    });
    expect(result).toBe(baseTools);
  });

  it("G2: first turn + project instructions overrides direct-answer's read-only-only tool set", () => {
    const result = selectRawToolSet({
      baseTools,
      supportsClientTools: true,
      firstTurnToolsEnabled: true,
      isChitchat: false,
      isDirectAnswer: true,
      priorTurnHadTools: false,
    });
    expect(result).toBe(baseTools);
  });

  it("without firstTurnToolsEnabled, chitchat on a fresh turn still gets zero tools (no regression)", () => {
    const result = selectRawToolSet({
      baseTools,
      supportsClientTools: true,
      firstTurnToolsEnabled: false,
      isChitchat: true,
      isDirectAnswer: false,
      priorTurnHadTools: false,
    });
    expect(result).toEqual({});
  });

  it("without firstTurnToolsEnabled, direct-answer on a fresh turn still gets read-only tools only (no regression)", () => {
    const result = selectRawToolSet({
      baseTools,
      supportsClientTools: true,
      firstTurnToolsEnabled: false,
      isChitchat: false,
      isDirectAnswer: true,
      priorTurnHadTools: false,
    });
    expect(result).toEqual({ read_file: {}, grep: {} });
    expect(result).not.toHaveProperty("bash");
    expect(result).not.toHaveProperty("edit_file");
  });

  it("BUG-A guard preserved: chitchat with prior-turn tool history keeps the full tool set (continuation), firstTurnToolsEnabled=false", () => {
    const result = selectRawToolSet({
      baseTools,
      supportsClientTools: true,
      firstTurnToolsEnabled: false,
      isChitchat: true,
      isDirectAnswer: false,
      priorTurnHadTools: true,
    });
    expect(result).toBe(baseTools);
  });

  it("plain task turn (neither chitchat nor direct-answer nor project-instructed) gets the full tool set", () => {
    const result = selectRawToolSet({
      baseTools,
      supportsClientTools: true,
      firstTurnToolsEnabled: false,
      isChitchat: false,
      isDirectAnswer: false,
      priorTurnHadTools: false,
    });
    expect(result).toBe(baseTools);
  });
});
