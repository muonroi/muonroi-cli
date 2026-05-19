import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrossTurnDedup, isCrossTurnDedupEnabled, wrapToolSetWithDedup } from "../cross-turn-dedup.js";

describe("CrossTurnDedup", () => {
  describe("maybeDedup", () => {
    it("returns null for the first occurrence and a stub for the second", () => {
      const dedup = new CrossTurnDedup();
      dedup.beginTurn();
      const payload = "x".repeat(2_000);

      // First call: passes through.
      const first = dedup.maybeDedup("read_file", payload);
      expect(first).toBeNull();

      // Second user turn — bump counter.
      dedup.beginTurn();
      const second = dedup.maybeDedup("read_file", payload);
      expect(second).not.toBeNull();
      expect(second).toContain("identical to earlier turn");
      expect(second).toContain("tool=read_file");
      expect(second).toContain("turn=1");
      expect(second).toContain("sha256=");
    });

    it("distinct large tool outputs do not collide on sha256-16", () => {
      // Two large strings differing only in last char must produce different
      // stubs (i.e. no false-positive dedup hit). Regression coverage for the
      // sha1-12 → sha256-16 upgrade — at 48 bits the birthday bound made this
      // theoretically plausible; at 64 bits it's astronomically unlikely.
      const dedup = new CrossTurnDedup({ minChars: 100 });
      dedup.beginTurn();
      const a = "A".repeat(2_000);
      const b = "A".repeat(1_999) + "B";

      expect(dedup.maybeDedup("read_file", a)).toBeNull();
      // Distinct content must NOT hit the cache.
      expect(dedup.maybeDedup("read_file", b)).toBeNull();

      // Re-emitting `a` must produce a stub whose hash differs from the one
      // that would be produced for `b` — i.e. distinct cache entries coexist.
      const stubA = dedup.maybeDedup("read_file", a);
      const stubB = dedup.maybeDedup("read_file", b);
      expect(stubA).not.toBeNull();
      expect(stubB).not.toBeNull();
      const hashA = /sha256=([0-9a-f]+)/.exec(stubA as string)?.[1];
      const hashB = /sha256=([0-9a-f]+)/.exec(stubB as string)?.[1];
      expect(hashA).toBeDefined();
      expect(hashB).toBeDefined();
      expect(hashA).toHaveLength(16);
      expect(hashB).toHaveLength(16);
      expect(hashA).not.toBe(hashB);
    });

    it("does not dedup different outputs", () => {
      const dedup = new CrossTurnDedup();
      dedup.beginTurn();
      const a = "a".repeat(1_000);
      const b = "b".repeat(1_000);
      expect(dedup.maybeDedup("read_file", a)).toBeNull();
      expect(dedup.maybeDedup("read_file", b)).toBeNull();
      // Re-run yields a hit for a, miss for c.
      expect(dedup.maybeDedup("read_file", a)).not.toBeNull();
      const c = "c".repeat(1_000);
      expect(dedup.maybeDedup("read_file", c)).toBeNull();
    });

    it("skips outputs below the min-chars threshold", () => {
      const dedup = new CrossTurnDedup({ minChars: 500 });
      dedup.beginTurn();
      const small = "y".repeat(100);
      expect(dedup.maybeDedup("bash", small)).toBeNull();
      expect(dedup.maybeDedup("bash", small)).toBeNull();
      expect(dedup.getStats().inserts).toBe(0);
      expect(dedup.getStats().hits).toBe(0);
    });

    it("evicts oldest entry after exceeding maxEntries", () => {
      const dedup = new CrossTurnDedup({ maxEntries: 3, minChars: 10 });
      dedup.beginTurn();
      // Insert 4 distinct payloads — first should be evicted.
      const payloads = ["A", "B", "C", "D"].map((c) => c.repeat(50));
      for (const p of payloads) expect(dedup.maybeDedup("read_file", p)).toBeNull();
      expect(dedup.getStats().size).toBe(3);

      // First payload should no longer be cached (evicted) — re-running it
      // returns null, not a stub.
      expect(dedup.maybeDedup("read_file", payloads[0]!)).toBeNull();
      // Latest payload should still be cached — re-running returns a stub.
      expect(dedup.maybeDedup("read_file", payloads[3]!)).not.toBeNull();
    });

    it("no-ops when constructed with enabled=false", () => {
      const dedup = new CrossTurnDedup({ enabled: false });
      dedup.beginTurn();
      const payload = "z".repeat(2_000);
      expect(dedup.maybeDedup("read_file", payload)).toBeNull();
      expect(dedup.maybeDedup("read_file", payload)).toBeNull();
      expect(dedup.getStats().inserts).toBe(0);
      expect(dedup.getStats().hits).toBe(0);
    });
  });

  describe("isCrossTurnDedupEnabled", () => {
    const original = process.env.MUONROI_CROSS_TURN_DEDUP;
    afterEach(() => {
      if (original === undefined) delete process.env.MUONROI_CROSS_TURN_DEDUP;
      else process.env.MUONROI_CROSS_TURN_DEDUP = original;
    });

    it("defaults to enabled", () => {
      delete process.env.MUONROI_CROSS_TURN_DEDUP;
      expect(isCrossTurnDedupEnabled()).toBe(true);
    });

    it("respects MUONROI_CROSS_TURN_DEDUP=0", () => {
      process.env.MUONROI_CROSS_TURN_DEDUP = "0";
      expect(isCrossTurnDedupEnabled()).toBe(false);
    });

    it("respects MUONROI_CROSS_TURN_DEDUP=false", () => {
      process.env.MUONROI_CROSS_TURN_DEDUP = "false";
      expect(isCrossTurnDedupEnabled()).toBe(false);
    });
  });

  describe("wrapToolSetWithDedup", () => {
    function makeTool(returnValue: unknown): ToolSet[string] {
      return {
        description: "test tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => returnValue,
        // biome-ignore lint: minimal AI ToolSet shape used by the wrapper only
      } as unknown as ToolSet[string];
    }

    it("returns the same tool set when dedup is null", () => {
      const tools: ToolSet = { read_file: makeTool("payload") };
      expect(wrapToolSetWithDedup(tools, null)).toBe(tools);
    });

    it("dedups string outputs across calls", async () => {
      const dedup = new CrossTurnDedup({ minChars: 10 });
      dedup.beginTurn();
      const payload = "p".repeat(1_000);
      const tools: ToolSet = { read_file: makeTool(payload) };
      const wrapped = wrapToolSetWithDedup(tools, dedup);
      const exec = (wrapped.read_file as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;

      const first = await exec({});
      expect(first).toBe(payload);

      const second = (await exec({})) as string;
      expect(second).not.toBe(payload);
      expect(second).toContain("identical to earlier turn");
    });

    it("dedups the .output field on object-shaped results", async () => {
      const dedup = new CrossTurnDedup({ minChars: 10 });
      dedup.beginTurn();
      const payload = "q".repeat(1_000);
      const tools: ToolSet = { read_file: makeTool({ success: true, output: payload }) };
      const wrapped = wrapToolSetWithDedup(tools, dedup);
      const exec = (wrapped.read_file as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;

      const first = (await exec({})) as { output: string };
      expect(first.output).toBe(payload);

      const second = (await exec({})) as { output: string };
      expect(second.output).toContain("identical to earlier turn");
    });
  });
});
