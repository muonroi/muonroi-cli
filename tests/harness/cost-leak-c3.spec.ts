/**
 * tests/harness/cost-leak-c3.spec.ts
 *
 * Cost-leak verification: C3 — cross-turn tool-output dedup replaces
 * identical tool_result strings with a short reference stub on the
 * second-and-subsequent emission across user turns of one session.
 *
 * Failing mode (pre-fix / dedup disabled): identical tool outputs across
 * turns are re-billed in full.
 *
 * Passing mode: the second identical output is replaced with
 *   "[tool_result identical to earlier turn — dedup ref sha256=..., ...]"
 * and distinct outputs are NOT deduped (no false-positive hash collisions).
 *
 * Drives the dedup wrap directly (no TUI spawn) — mirrors how the
 * orchestrator wires `wrapToolSetWithDedup` around `childBaseTools`.
 */

import type { ToolSet } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { CrossTurnDedup, wrapToolSetWithDedup } from "../../src/orchestrator/cross-turn-dedup.js";

function makeStringTool(returnValue: string): ToolSet[string] {
  return {
    description: "Stub read for cost-leak-c3 verification.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => returnValue,
    // biome-ignore lint: minimal AI ToolSet shape used by the wrapper only
  } as unknown as ToolSet[string];
}

describe("C3: cross-turn tool-output dedup uses sha256-16 stubs", () => {
  let dedup: CrossTurnDedup | null = null;
  afterEach(() => {
    dedup?.clear();
    dedup = null;
  });

  it("identical tool_result across turns → second emission becomes a sha256 stub", async () => {
    dedup = new CrossTurnDedup({ minChars: 100 });
    dedup.beginTurn(); // turn 1
    const payload = `READ:/tmp/x.txt\n${"x".repeat(2_000)}`;
    const tools: ToolSet = { fake_read: makeStringTool(payload) };
    const wrapped = wrapToolSetWithDedup(tools, dedup);
    const exec = (wrapped.fake_read as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;

    // Turn 1: tool result passes through verbatim.
    const first = (await exec({})) as string;
    expect(first).toBe(payload);

    // Turn 2: identical tool result must become a dedup stub.
    dedup.beginTurn();
    const second = (await exec({})) as string;
    expect(second).not.toBe(payload);
    // G3 — short marker: "[dup of <tool> from turn <N> — reuse]"
    expect(second).toContain("[dup of fake_read from turn 1");
  });

  it("distinct tool_result payloads do NOT collide on sha256-16", async () => {
    dedup = new CrossTurnDedup({ minChars: 100 });
    dedup.beginTurn();

    const payloadA = `READ:/tmp/a.txt\n${"A".repeat(2_000)}`;
    const payloadB = `READ:/tmp/b.txt\n${"A".repeat(1_999)}B`;

    const tools: ToolSet = {
      read_a: makeStringTool(payloadA),
      read_b: makeStringTool(payloadB),
    };
    const wrapped = wrapToolSetWithDedup(tools, dedup);
    const execA = (wrapped.read_a as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;
    const execB = (wrapped.read_b as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;

    // First emission of each: pass-through (no dedup).
    expect(await execA({})).toBe(payloadA);
    expect(await execB({})).toBe(payloadB);

    // Re-emit each in a new turn; both must hit dedup but with DIFFERENT
    // hashes — distinct cache entries, not a false-positive collision.
    dedup.beginTurn();
    const stubA = (await execA({})) as string;
    const stubB = (await execB({})) as string;
    // G3 — markers identify the originating tool; A and B must differ so we
    // know the cache entries are distinct (no sha256 collision elided them
    // into the same entry).
    expect(stubA).toContain("[dup of read_a from turn 1");
    expect(stubB).toContain("[dup of read_b from turn 1");
    expect(stubA).not.toBe(stubB);

    // Stats sanity: 2 distinct inserts, 2 hits.
    const stats = dedup.getStats();
    expect(stats.inserts).toBe(2);
    expect(stats.hits).toBe(2);
  });
});
