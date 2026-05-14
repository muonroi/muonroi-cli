import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockLlm } from "../mock-llm";

describe("mock-llm", () => {
  it("returns fixture matching prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-"));
    writeFileSync(
      join(dir, "fix.json"),
      JSON.stringify({
        responses: [{ match: "hello", text: "world" }],
      }),
    );
    const m = createMockLlm({ dir });
    expect(await m.complete({ prompt: "hello there" })).toEqual({ text: "world" });
  });

  it("falls back to wildcard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-"));
    writeFileSync(
      join(dir, "fix.json"),
      JSON.stringify({
        responses: [{ match: "*", text: "default" }],
      }),
    );
    const m = createMockLlm({ dir });
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "default" });
  });

  it("throws on no match without wildcard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-"));
    writeFileSync(
      join(dir, "fix.json"),
      JSON.stringify({
        responses: [{ match: "specific", text: "x" }],
      }),
    );
    const m = createMockLlm({ dir });
    await expect(m.complete({ prompt: "other" })).rejects.toThrow(/no fixture/);
  });

  // ── Sequence mode tests ────────────────────────────────────────────────────

  it("sequence: consumes entries in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-seq-"));
    writeFileSync(
      join(dir, "seq.json"),
      JSON.stringify({
        sequence: [{ text: "first" }, { text: "second" }, { text: "third" }],
      }),
    );
    const m = createMockLlm({ dir });
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "first" });
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "second" });
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "third" });
  });

  it("sequence: exhausted sequence sticks on last entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-seq-exhausted-"));
    writeFileSync(
      join(dir, "seq.json"),
      JSON.stringify({
        sequence: [{ text: "a" }, { text: "b" }],
      }),
    );
    const m = createMockLlm({ dir });
    expect(await m.complete({ prompt: "p" })).toEqual({ text: "a" });
    expect(await m.complete({ prompt: "p" })).toEqual({ text: "b" });
    // Exhausted — keeps returning last entry
    expect(await m.complete({ prompt: "p" })).toEqual({ text: "b" });
    expect(await m.complete({ prompt: "p" })).toEqual({ text: "b" });
  });

  it("sequence: entry with match constraint is skipped when prompt doesn't match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-seq-match-"));
    writeFileSync(
      join(dir, "seq.json"),
      JSON.stringify({
        sequence: [{ text: "matched", match: "keyword" }, { text: "fallback" }],
      }),
    );
    const m = createMockLlm({ dir });
    // First call: prompt lacks the required term — skips first seq entry, falls through to second
    expect(await m.complete({ prompt: "unrelated prompt text" })).toEqual({ text: "fallback" });
  });

  it("sequence: entry with match constraint is consumed when prompt includes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-seq-match2-"));
    writeFileSync(
      join(dir, "seq.json"),
      JSON.stringify({
        sequence: [{ text: "matched", match: "keyword" }, { text: "second" }],
      }),
    );
    const m = createMockLlm({ dir });
    // First call includes keyword — consumes first entry
    expect(await m.complete({ prompt: "has keyword in it" })).toEqual({ text: "matched" });
    // Second call — advances to second entry
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "second" });
  });

  it("sequence and responses fixtures coexist: sequence tried first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-mixed-"));
    // responses fixture
    writeFileSync(
      join(dir, "a-responses.json"),
      JSON.stringify({
        responses: [{ match: "*", text: "from-responses" }],
      }),
    );
    // sequence fixture (alphabetically after, but tried first by design)
    writeFileSync(
      join(dir, "b-sequence.json"),
      JSON.stringify({
        sequence: [{ text: "from-sequence" }],
      }),
    );
    const m = createMockLlm({ dir });
    // First call: sequence wins
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "from-sequence" });
    // Second call: sequence exhausted (sticks on last), still "from-sequence"
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "from-sequence" });
  });
});
