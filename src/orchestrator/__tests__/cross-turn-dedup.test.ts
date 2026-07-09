import type { ToolSet } from "ai";
import { afterEach, describe, expect, it } from "vitest";

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
      expect(second).toContain("[dup of");
      expect(second).toContain("read_file");
      expect(second).toContain("turn 1");
    });

    it("distinct large tool outputs do not collide on sha256-16", () => {
      // Two large strings differing only in last char must produce different
      // stubs (i.e. no false-positive dedup hit). Regression coverage for the
      // sha1-12 → sha256-16 upgrade — at 48 bits the birthday bound made this
      // theoretically plausible; at 64 bits it's astronomically unlikely.
      const dedup = new CrossTurnDedup({ minChars: 100 });
      dedup.beginTurn();
      const a = "A".repeat(2_000);
      const b = `${"A".repeat(1_999)}B`;

      expect(dedup.maybeDedup("read_file", a)).toBeNull();
      // Distinct content must NOT hit the cache.
      expect(dedup.maybeDedup("read_file", b)).toBeNull();
      // Two distinct payloads → two distinct cache entries (verified via
      // cache size since the marker no longer embeds the hash post-G3).
      expect(dedup.getStats().size).toBe(2);

      // Next user turn — re-emitting either payload triggers a cross-turn hit.
      dedup.beginTurn();
      const stubA = dedup.maybeDedup("read_file", a);
      const stubB = dedup.maybeDedup("read_file", b);
      expect(stubA).not.toBeNull();
      expect(stubB).not.toBeNull();
      expect(dedup.getStats().hits).toBe(2);
    });

    it("does not dedup different outputs", () => {
      const dedup = new CrossTurnDedup();
      dedup.beginTurn();
      const a = "a".repeat(1_000);
      const b = "b".repeat(1_000);
      expect(dedup.maybeDedup("read_file", a)).toBeNull();
      expect(dedup.maybeDedup("read_file", b)).toBeNull();
      // Next turn — re-run yields a cross-turn hit for a, miss for c.
      dedup.beginTurn();
      expect(dedup.maybeDedup("read_file", a)).not.toBeNull();
      const c = "c".repeat(1_000);
      expect(dedup.maybeDedup("read_file", c)).toBeNull();
    });

    it("same-turn loop: re-serves content on the first in-turn repeat, then hard-stops", () => {
      // Regression for the O1 fallback: a cheap model that re-issues an
      // identical read WITHIN one turn used to get a bare "reuse" stub, then
      // fell back to reading each file singly (measured: batch → stub → stub →
      // 4 single reads). The fix re-serves content ONCE so the loop is
      // satisfied, then hard-stops any further in-turn repeat.
      const dedup = new CrossTurnDedup({ minChars: 10 });
      dedup.beginTurn();
      const payload = "L".repeat(1_000);

      // First occurrence — passthrough.
      expect(dedup.maybeDedup("read_file", payload)).toBeNull();
      // First SAME-TURN repeat — re-serve content (null passthrough), NOT a stub.
      expect(dedup.maybeDedup("read_file", payload)).toBeNull();
      // Second same-turn repeat — hard-stop stub instructing the model to stop.
      const stop = dedup.maybeDedup("read_file", payload);
      expect(stop).not.toBeNull();
      expect(stop).toContain("STOP re-calling");
      // Only the hard-stop counts as a saved hit (the re-serve re-bills).
      expect(dedup.getStats().hits).toBe(1);
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

      // Next turn — so a re-run is a cross-turn hit (stub), not a same-turn
      // re-serve (null), isolating the eviction assertion.
      dedup.beginTurn();
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

      dedup.beginTurn();
      const second = (await exec({})) as string;
      expect(second).not.toBe(payload);
      expect(second).toContain("[dup of");
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

      dedup.beginTurn();
      const second = (await exec({})) as { output: string };
      expect(second.output).toContain("[dup of");
    });

    it("dedups MCP content-array text parts across calls", async () => {
      // MCP results are { type: "content", value: [{type:"text", text}] } — a
      // shape the dedup previously ignored, so re-fetching the same MCP payload
      // (e.g. the same docs page) re-billed full content every turn.
      const dedup = new CrossTurnDedup({ minChars: 10 });
      dedup.beginTurn();
      const payload = "r".repeat(1_000);
      const tools: ToolSet = {
        mcp_docs__fetch: makeTool({ type: "content", value: [{ type: "text", text: payload }] }),
      };
      const wrapped = wrapToolSetWithDedup(tools, dedup);
      const exec = (wrapped.mcp_docs__fetch as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;

      const first = (await exec({})) as { value: Array<{ text: string }> };
      expect(first.value[0]!.text).toBe(payload);

      dedup.beginTurn();
      const second = (await exec({})) as { value: Array<{ text: string }> };
      expect(second.value[0]!.text).toContain("[dup of");
    });

    it("leaves non-text MCP content parts (images) untouched", async () => {
      const dedup = new CrossTurnDedup({ minChars: 10 });
      dedup.beginTurn();
      const image = { type: "image", data: "BASE64", mediaType: "image/png" };
      const tools: ToolSet = { mcp_x__shot: makeTool({ type: "content", value: [image] }) };
      const wrapped = wrapToolSetWithDedup(tools, dedup);
      const exec = (wrapped.mcp_x__shot as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;

      const out = (await exec({})) as { value: unknown[] };
      expect(out.value[0]).toEqual(image);
    });
  });
});
