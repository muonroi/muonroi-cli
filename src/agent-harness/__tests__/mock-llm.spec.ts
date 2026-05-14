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
});
