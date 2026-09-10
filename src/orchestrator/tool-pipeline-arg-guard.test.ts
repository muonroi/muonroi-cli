/**
 * F3 — a corrective message must never be replaced by a "you already have this"
 * stub.
 *
 * Measured (2026-09-09, sub-agent run). Three malformed calls were blocked in
 * one run. The two whose correction reached the model were each REPAIRED on the
 * next call:
 *
 *   15:16:54  bash       BLOCKED (empty-bash): "__elided_note" is a …
 *   15:17:04  bash       {"command":"cat …/TCIS.CodeStandards.csproj"}   ← repaired
 *   15:28:51  read_file  BLOCKED (elision-marker-as-args): …
 *   15:28:55  bash       {"command":"cat …/AnalyzerConfigKeys…"}         ← repaired
 *
 * The third did not, because a wrapper layered OUTSIDE the guard answered first:
 *
 *   15:30:21  bash       {"__elided_note":"[earlier call args elided … 170 chars…"}
 *   15:30:21  bash       {"success":false,"output":"[dup of call #171 — reuse it]"}
 *   15:30:27  bash       {"__elided_note":"[earlier call args elided … 114 chars…"}
 *   15:30:27  bash       {"success":false,"output":"[dup of call #173 — reuse it]"}
 *
 * The guard's corrective message is itself a tool output, so two identical
 * corrections hash equal and the cumulative cap's content dedup replaced the
 * second with a pointer. The model was told to reuse the answer to a call that
 * had never once succeeded — so it learned nothing and repeated the shape.
 *
 * Reproducing it needs no tuned thresholds, but it does need the live SHAPE.
 * Measured correction lengths against the wrappers' 500-char dedup minimum:
 *
 *   bash       strike 1 = 357   strike 2 = 508   strike 3 = 673
 *   grep       strike 1 = 367   strike 2 = 518   strike 3 = 683
 *   read_file  strike 1 = 396   strike 2 = 547   strike 3 = 712
 *
 * So only a correction at strike ≥ 2 is long enough to be deduped, and two
 * corrections hash equal only at the SAME rung — which requires a successful
 * call in between to reset the streak. `bad, bad, recover, bad, bad` is exactly
 * the alternation of blocks and recoveries the run logged, and it is what these
 * tests drive.
 *
 * These tests drive `buildTurnToolPipeline` — the function `executeToolEngine`
 * itself calls — over tools from the real `createBuiltinTools`. Pinning a single
 * wrapper in isolation would prove nothing: this repo has repeatedly shipped a
 * helper-level test that stayed green while the live call site composed
 * something else.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolSet } from "ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../tools/bash.js";
import { createBuiltinTools } from "../tools/registry.js";
import { CrossTurnDedup } from "./cross-turn-dedup.js";
import { ReadPathBudget } from "./read-path-budget.js";
import { buildTurnToolPipeline } from "./tool-engine.js";

const MARKER =
  "[earlier call args elided by sub-agent compactor — 412 chars; consult the matching tool_result for what came back]";
const ELIDED_ARGS = { __elided_note: MARKER };

/** Long enough to clear both dedup layers' 500-char minimum. */
const BIG_CONTENT = "export const line = 1; // padding to clear the dedup minimum\n".repeat(40);

/** Any stub that tells the model to reuse a result it supposedly already has. */
const REUSE_STUB = /dup of call #\d+|dup of \w+ from turn \d+|already returned this EXACT result|read budget exceeded/;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "f3-pipeline-"));
  dirs.push(d);
  writeFileSync(join(d, "big.ts"), BIG_CONTENT, "utf8");
  return d;
}

interface Pipeline {
  tools: ToolSet;
  capState: { cumulative: number; dedupHits: number };
  call: (name: string, input: unknown) => Promise<string>;
  /** A well-formed call, which resets the guard's per-session streak. */
  resetStreak: () => Promise<void>;
  /**
   * Two malformed calls (strikes 1 and 2) followed by a recovery. Returns both
   * corrections. Two rounds produce two byte-identical strike-2 corrections —
   * the only way a correction ever hashes equal to an earlier one.
   */
  malformedRound: (toolName: string) => Promise<[string, string]>;
}

function buildPipeline(
  cwd: string,
  sessionId: string,
  opts: { dedup?: CrossTurnDedup | null; readBudget?: ReadPathBudget | null; capDedup?: boolean } = {},
): Pipeline {
  const raw = createBuiltinTools(new BashTool(cwd), "agent", { sessionId }) as unknown as ToolSet;
  const built = buildTurnToolPipeline(raw, {
    capOptions: {
      maxCumulativeChars: 400_000,
      midTierRatio: 0.5,
      highTierRatio: 0.8,
      label: "top-level",
      dedupRepeatOutputs: opts.capDedup ?? true,
    },
    dedup: opts.dedup ?? null,
    readBudget: opts.readBudget ?? null,
  });
  const call: Pipeline["call"] = async (name, input) => {
    const tool = built.tools[name] as { execute?: (i: unknown, ctx?: unknown) => unknown };
    if (!tool?.execute) throw new Error(`tool ${name} missing from the pipeline`);
    const result = await tool.execute(input, {});
    return typeof result === "string" ? result : JSON.stringify(result);
  };
  const resetStreak = async () => {
    const out = await call("read_file", { file_path: "big.ts" });
    if (out.includes("BLOCKED")) throw new Error(`streak-reset call was itself blocked: ${out.slice(0, 120)}`);
  };
  return {
    tools: built.tools,
    capState: built.capState,
    call,
    resetStreak,
    malformedRound: async (toolName) => {
      const strike1 = await call(toolName, ELIDED_ARGS);
      const strike2 = await call(toolName, ELIDED_ARGS);
      await resetStreak();
      return [strike1, strike2];
    },
  };
}

describe("F3 — the arg guard's correction survives every outer wrapper", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
  });

  it("gives a REPEATED marker call the correction, never the cap's dup stub", async () => {
    const p = buildPipeline(tempDir(), "F3-cap-dedup");

    // Round 1 caches the strike-2 correction; round 2 re-issues the identical
    // one. This is the 15:30:21 / 15:30:27 pair.
    const round1 = await p.malformedRound("bash");
    const round2 = await p.malformedRound("bash");

    for (const [label, out] of [
      ["round 1 strike 1", round1[0]],
      ["round 1 strike 2", round1[1]],
      ["round 2 strike 1", round2[0]],
      ["round 2 strike 2", round2[1]],
    ] as const) {
      expect(out, label).toContain("BLOCKED (empty-bash)");
      expect(out, label).toContain("__elided_note");
      expect(out, label).toContain("ls -la");
      expect(out, label).not.toMatch(REUSE_STUB);
    }
    // The repeat is corrected, not silenced: still the strike-2 rung.
    expect(round2[1]).toMatch(/2 malformed tool calls in a row/);
    // The ONE dedup hit is round 2's well-formed recovery read of the same file
    // — real output still dedups; only calls that never ran are exempt.
    expect(p.capState.dedupHits).toBe(1);
  });

  it("does the same when the cross-turn dedup is the layer that would answer", async () => {
    const dedup = new CrossTurnDedup();
    const p = buildPipeline(tempDir(), "F3-crossturn-block", { dedup, capDedup: false });

    dedup.beginTurn();
    const round1 = await p.malformedRound("grep");
    dedup.beginTurn();
    const round2 = await p.malformedRound("grep");

    for (const out of [...round1, ...round2]) {
      expect(out).toContain("BLOCKED (elision-marker-as-args)");
      expect(out).toContain("__elided_note");
      expect(out).not.toMatch(REUSE_STUB);
    }
    expect(round2[1]).toMatch(/2 malformed tool calls in a row/);
    // Same here: the only hit is the well-formed recovery read, repeated across
    // the two turns. No correction was ever cached — there is nothing to reuse.
    expect(dedup.getStats().hits).toBe(1);
  });

  it("lets a marker call past the read-path budget so the guard, not the budget, answers", async () => {
    // The budget is the one outer wrapper that PRE-EMPTS the call. Left alone it
    // keys its counter on the marker text (which reads as a file_path) and then
    // answers "refer to your earlier result" — with the guard never running, so
    // the escalation ladder never advances either.
    const budget = new ReadPathBudget(1);
    const p = buildPipeline(tempDir(), "F3-budget", { readBudget: budget });

    const first = await p.call("read_file", { file_path: MARKER });
    const second = await p.call("read_file", { file_path: MARKER });

    for (const out of [first, second]) {
      expect(out).toContain("BLOCKED (elision-marker-as-args)");
      expect(out).not.toContain("read budget exceeded");
    }
    expect(second).toMatch(/2 malformed tool calls in a row/);
    expect(budget.getStats().capExceededHits).toBe(0);
    // …and the marker never even entered the counter.
    expect(budget.getStats().trackedPaths).toBe(0);
  });

  it("advances the escalation ladder across consecutive repeats", async () => {
    const p = buildPipeline(tempDir(), "F3-ladder");

    const first = await p.call("bash", ELIDED_ARGS);
    expect(first).not.toMatch(/malformed tool calls in a row/);

    const second = await p.call("bash", ELIDED_ARGS);
    expect(second).toMatch(/2 malformed tool calls in a row/);
    expect(second).toMatch(/Read the tool schema above/);

    const third = await p.call("bash", ELIDED_ARGS);
    expect(third).toMatch(/3 malformed tool calls in a row/);
    expect(third).toMatch(/STOP issuing tool calls now and reply in plain text/);

    for (const out of [first, second, third]) expect(out).not.toMatch(REUSE_STUB);
  });

  it("still deduplicates a repeated WELL-FORMED call (cap dedup not weakened)", async () => {
    const p = buildPipeline(tempDir(), "F3-wellformed");

    const first = await p.call("read_file", { file_path: "big.ts" });
    expect(first).toContain("export const line = 1;");
    expect(first).not.toMatch(REUSE_STUB);

    const second = await p.call("read_file", { file_path: "big.ts" });
    expect(second).toMatch(/dup of call #\d+ — reuse it/);
    expect(p.capState.dedupHits).toBe(1);
  });

  it("still deduplicates a repeated WELL-FORMED call across turns (C3 not weakened)", async () => {
    const dedup = new CrossTurnDedup();
    const p = buildPipeline(tempDir(), "F3-crossturn-ok", { dedup, capDedup: false });

    dedup.beginTurn();
    const first = await p.call("read_file", { file_path: "big.ts" });
    expect(first).toContain("export const line = 1;");

    dedup.beginTurn();
    const second = await p.call("read_file", { file_path: "big.ts" });
    expect(second).toMatch(/\[dup of read_file from turn 1 — reuse\]/);
    expect(dedup.getStats().hits).toBe(1);
  });

  it("still enforces the read-path budget on well-formed reads", async () => {
    const budget = new ReadPathBudget(1);
    const p = buildPipeline(tempDir(), "F3-budget-wellformed", { readBudget: budget });

    await p.call("read_file", { file_path: "big.ts" });
    const second = await p.call("read_file", { file_path: "big.ts" });
    expect(second).toContain("read budget exceeded");
    expect(budget.getStats().capExceededHits).toBe(1);
  });
});

describe("F3 — the composition site itself", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
  });

  it("nests the layers cap → dedup → readBudget, outermost last", async () => {
    // Observable consequences of the order, rather than a restatement of it: the
    // read budget sits OUTSIDE the cap, so a budget-stubbed read never reaches
    // the cap's cumulative accounting.
    const budget = new ReadPathBudget(1);
    const p = buildPipeline(tempDir(), "F3-order", { readBudget: budget });

    const first = await p.call("read_file", { file_path: "big.ts" });
    expect(first).toContain("export const line = 1;");
    const afterRealRead = p.capState.cumulative;
    expect(afterRealRead).toBeGreaterThan(BIG_CONTENT.length / 2);

    const stubbed = await p.call("read_file", { file_path: "big.ts" });
    expect(stubbed).toContain("read budget exceeded");
    expect(p.capState.cumulative).toBe(afterRealRead);
  });

  it("is the function executeToolEngine actually composes with", async () => {
    // The failure mode this guards against is a green pipeline test next to a
    // live call site that re-typed the stack by hand. Assert the engine routes
    // through the same builder these tests drive, and that no second hand-rolled
    // composition survives beside it.
    const src = await readFile(fileURLToPath(new URL("./tool-engine.ts", import.meta.url)), "utf8");
    expect(src).toContain("buildTurnToolPipeline(rawToolSet, {");
    expect(src).not.toMatch(/wrapToolSetWithReadBudget\(\s*wrapToolSetWithDedup\(topLevelCap/);
    expect(src.match(/wrapToolSetWithDedup\(/g)?.length ?? 0).toBe(1);
    expect(src.match(/wrapToolSetWithCap\(/g)?.length ?? 0).toBe(1);
    expect(src.match(/wrapToolSetWithReadBudget\(/g)?.length ?? 0).toBe(1);
  });
});
