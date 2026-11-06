import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { failureText, wrapToolSetWithRepeatRefusal } from "../repeat-failure-refusal.js";
import { buildTurnToolPipeline } from "../tool-engine.js";

type Exec = (input: unknown, ctx?: unknown) => Promise<unknown>;
const run = (tools: ToolSet, name: string, input: unknown) => (tools[name] as { execute: Exec }).execute(input, {});

describe("repeat-failure refusal (P25)", () => {
  it("refuses the 2nd identical call after a failure, before it runs, and names the prior error", async () => {
    const execute = vi.fn(async () => "ERROR: old_string not found in src/a.ts");
    const tools = wrapToolSetWithRepeatRefusal({ edit_file: { execute } } as unknown as ToolSet);
    expect(await run(tools, "edit_file", { file_path: "src/a.ts", old_string: "x" })).toMatch(/^ERROR/);
    await expect(run(tools, "edit_file", { file_path: "src/a.ts", old_string: "x" })).rejects.toThrow(
      /repeat_refused: edit_file was NOT run .*old_string not found in src\/a\.ts/,
    );
    // Still refused on the 3rd try; the tool itself ran exactly once.
    await expect(run(tools, "edit_file", { file_path: "src/a.ts", old_string: "x" })).rejects.toThrow(/repeat_refused/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs a call whose arguments changed", async () => {
    const execute = vi.fn(async () => "ERROR: boom");
    const tools = wrapToolSetWithRepeatRefusal({ bash: { execute } } as unknown as ToolSet);
    await run(tools, "bash", { command: "a" });
    await run(tools, "bash", { command: "b" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("any non-failing call in between clears the record (edit, then rerun the same failing test)", async () => {
    const test = vi.fn(async () => "ERROR: 1 failed");
    const edit = vi.fn(async () => "OK");
    const tools = wrapToolSetWithRepeatRefusal({
      bash: { execute: test },
      edit_file: { execute: edit },
    } as unknown as ToolSet);
    await run(tools, "bash", { command: "bunx vitest run x" });
    await run(tools, "edit_file", { file_path: "x.ts" });
    await run(tools, "bash", { command: "bunx vitest run x" });
    expect(test).toHaveBeenCalledTimes(2);
  });

  it("treats thrown errors and structured failures as failures, success as a reset", async () => {
    let n = 0;
    const execute = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("network down");
      return { success: true, output: "fine" };
    });
    const tools = wrapToolSetWithRepeatRefusal({ fetch_url: { execute } } as unknown as ToolSet);
    await expect(run(tools, "fetch_url", { url: "u" })).rejects.toThrow("network down");
    await expect(run(tools, "fetch_url", { url: "u" })).rejects.toThrow(/repeat_refused.*network down/);
    expect(execute).toHaveBeenCalledTimes(1);

    expect(failureText({ success: false, output: "bad" })).toBe("bad");
    expect(failureText({ isError: true, content: [] })).toBe("failed");
    expect(failureText("ERROR invalid_args: x")).toBe("ERROR invalid_args: x");
    expect(failureText("all good")).toBeNull();
    expect(failureText({ success: true })).toBeNull();
  });

  it("is part of the main turn pipeline (outermost layer)", async () => {
    const execute = vi.fn(async () => "ERROR: nope");
    const { tools } = buildTurnToolPipeline(
      { grep: { execute } } as unknown as ToolSet,
      {
        capOptions: { maxCumulativeChars: 1_000_000, label: "test" },
        dedup: null,
        readBudget: null,
      } as never,
    );
    await run(tools, "grep", { pattern: "p" });
    await expect(run(tools, "grep", { pattern: "p" })).rejects.toThrow(/repeat_refused/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
