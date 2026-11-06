import { APICallError } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { _resetProviderThinkingDegrade, isProviderThinkingDegraded } from "../../providers/strategies/thinking-mode.js";
import { classifyToolFailure, failureText, wrapToolSetWithRepeatRefusal } from "../repeat-failure-refusal.js";
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
    const execute = vi.fn(async () => {
      throw new Error("ENOENT: no such file or directory, open 'src/missing.ts'");
    });
    const tools = wrapToolSetWithRepeatRefusal({ read_file: { execute } } as unknown as ToolSet);
    await expect(run(tools, "read_file", { file_path: "src/missing.ts" })).rejects.toThrow(/ENOENT/);
    await expect(run(tools, "read_file", { file_path: "src/missing.ts" })).rejects.toThrow(/repeat_refused.*ENOENT/);
    expect(execute).toHaveBeenCalledTimes(1);

    expect(failureText({ success: false, output: "bad" })).toBe("bad");
    expect(failureText({ isError: true, content: [] })).toBe("failed");
    expect(failureText({ isError: true, content: [{ type: "text", text: "HTTP 502 Bad Gateway" }] })).toBe(
      "HTTP 502 Bad Gateway",
    );
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

describe("repeat-failure refusal — transient vs deterministic", () => {
  const deterministic: Array<[string, () => unknown]> = [
    ["validation error", () => "ERROR invalid_args: file_path must be a string"],
    ["file not found", () => "ERROR: File not found: src/missing.ts"],
    ["permission refusal", () => ({ success: false, error: "Permission denied: write outside the worker writeScope" })],
    [
      "host gate refusal",
      () => ({ success: false, error: "BLOCKED by FLOW mutation gate: plan review has not passed" }),
    ],
    [
      "identical non-zero exit, same output",
      () => ({ success: false, error: "FAIL src/a.test.ts > adds\nexpected 3, got 4\n[exit code 1]" }),
    ],
    ["HTTP 404 from a web tool", () => ({ success: false, error: "HTTP 404 Not Found: https://example.invalid/x" })],
  ];
  for (const [label, outcome] of deterministic) {
    it(`refuses the identical retry after a deterministic failure: ${label}`, async () => {
      const execute = vi.fn(async () => outcome());
      const tools = wrapToolSetWithRepeatRefusal({ t: { execute } } as unknown as ToolSet);
      await run(tools, "t", { a: 1 });
      await expect(run(tools, "t", { a: 1 })).rejects.toThrow(/repeat_refused: t was NOT run .*Repeating it cannot/);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  }

  const statusError = (statusCode: number) =>
    new APICallError({ message: "upstream", url: "https://mcp.invalid/rpc", requestBodyValues: {}, statusCode });
  const transient: Array<[string, () => unknown]> = [
    [
      "bash timeout annotation",
      () => ({ success: false, error: "running tests...\n[command timed out after 600000ms and was killed]" }),
    ],
    ["cancelled tool", () => ({ success: false, error: "[Cancelled]" })],
    [
      "ECONNRESET thrown",
      () => {
        throw Object.assign(new Error("request failed"), { code: "ECONNRESET" });
      },
    ],
    ["ETIMEDOUT text", () => "ERROR: connect ETIMEDOUT 10.0.0.1:443"],
    ["ENOTFOUND text", () => "ERROR: getaddrinfo ENOTFOUND api.example.invalid"],
    [
      "HTTP 503 text from an MCP tool",
      () => ({ isError: true, content: [{ type: "text", text: "HTTP 503 Service Unavailable" }] }),
    ],
    [
      "HTTP 500 thrown by a web tool",
      () => {
        throw statusError(500);
      },
    ],
    [
      "HTTP 429 thrown",
      () => {
        throw statusError(429);
      },
    ],
    ["rate limit text", () => ({ success: false, error: "Rate limit exceeded for this API key, try again later" })],
    ["HTTP 408 status code text", () => ({ success: false, error: "request failed with status code 408" })],
    ["tool-reported retryable", () => ({ success: false, error: "index busy", retryable: true })],
    [
      "AbortError thrown",
      () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    ],
  ];
  for (const [label, outcome] of transient) {
    it(`allows exactly one identical retry after a transient failure: ${label}`, async () => {
      const execute = vi.fn(async () => outcome());
      const tools = wrapToolSetWithRepeatRefusal({ t: { execute } } as unknown as ToolSet);
      const attempt = async (): Promise<string> => {
        try {
          return JSON.stringify(await run(tools, "t", { a: 1 }));
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };
      expect(await attempt()).not.toMatch(/repeat_refused/);
      expect(await attempt()).not.toMatch(/repeat_refused/); // the one identical retry ran
      // The retry failed too: the third identical call is refused before it runs.
      await expect(run(tools, "t", { a: 1 })).rejects.toThrow(/repeat_refused: t was NOT run .*transient error/);
      expect(execute).toHaveBeenCalledTimes(2);
    });
  }

  it("a successful retry clears the record; a later transient failure gets its own one retry", async () => {
    const outcomes = ["ERROR: HTTP 503", "ok", "ERROR: HTTP 503", "ERROR: HTTP 503"];
    const execute = vi.fn(async () => outcomes.shift() ?? "ok");
    const tools = wrapToolSetWithRepeatRefusal({ web_fetch: { execute } } as unknown as ToolSet);
    await run(tools, "web_fetch", { url: "u" }); // 503
    expect(await run(tools, "web_fetch", { url: "u" })).toBe("ok"); // retry succeeds
    await run(tools, "web_fetch", { url: "u" }); // 503 again: a fresh failure
    await run(tools, "web_fetch", { url: "u" }); // its own single retry
    await expect(run(tools, "web_fetch", { url: "u" })).rejects.toThrow(/repeat_refused/);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("a retry that fails deterministically is refused after it, not retried again", async () => {
    const outcomes = ["ERROR: socket hang up", "ERROR: File not found: a.md"];
    const execute = vi.fn(async () => outcomes.shift() ?? "ok");
    const tools = wrapToolSetWithRepeatRefusal({ mcp_docs__read: { execute } } as unknown as ToolSet);
    await run(tools, "mcp_docs__read", { id: "a" });
    await run(tools, "mcp_docs__read", { id: "a" });
    await expect(run(tools, "mcp_docs__read", { id: "a" })).rejects.toThrow(/repeat_refused.*File not found/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("a different failing call in between starts a fresh allowance for the next one", async () => {
    const execute = vi.fn(async (input: unknown) => `ERROR: HTTP 502 for ${JSON.stringify(input)}`);
    const tools = wrapToolSetWithRepeatRefusal({ t: { execute } } as unknown as ToolSet);
    await run(tools, "t", { a: 1 });
    await run(tools, "t", { a: 1 }); // retry spent for a=1
    await run(tools, "t", { a: 2 }); // different call
    await run(tools, "t", { a: 2 }); // its own retry
    await expect(run(tools, "t", { a: 2 })).rejects.toThrow(/repeat_refused/);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("classifies through the stream retry classifier without its provider side effects", () => {
    _resetProviderThinkingDegrade();
    // The z.ai generic 400 reject latches thinking OFF when a PROVIDER request hits it; a tool must not.
    expect(classifyToolFailure({ text: "HTTP 400: Unexpected end of JSON input" })).toEqual({
      kind: "deterministic",
      reason: "http-400-param-reject",
    });
    expect(isProviderThinkingDegraded()).toBe(false);
    expect(classifyToolFailure({ text: "repeat_refused: t was NOT run — HTTP 503" }).kind).toBe("deterministic");
    expect(classifyToolFailure({ text: "HTTP 503" }).reason).toBe("http-503");
    expect(classifyToolFailure({ text: "ERROR: Too Many Requests" }).reason).toBe("rate-limit-message");
  });
});
