/**
 * Forensics envelope for opaque provider 4xx errors.
 *
 * Background: 16 occurrences in interaction_logs of
 *   "The parameter is invalid. Please check again."
 * (siliconflow / DeepSeek-V4-Flash, 2026-05-13 → 2026-05-14) were logged with
 * ONLY the friendly message. With nothing else captured — no status code,
 * no response body, no request param names — the cause is unrecoverable
 * without a repro. summarizeApiErrorForLog closes that gap.
 *
 * Test goals:
 *   1. Wire-shape we WANT to persist (statusCode, urlHost, body trunc, param keys).
 *   2. NEVER persist request param VALUES (might contain secrets / PII).
 *   3. Cap response body so a 1MB error response can't bloat interaction_logs.
 *   4. Identity null on non-APICallError so the helper is safe to call
 *      unconditionally from the log site.
 */
import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { summarizeApiErrorForLog } from "../error-utils.js";

describe("summarizeApiErrorForLog", () => {
  it("captures the wire envelope for an APICallError without leaking param values", () => {
    const err = new APICallError({
      message: "The parameter is invalid. Please check again.",
      url: "https://api.siliconflow.com/v1/chat/completions",
      requestBodyValues: {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "secret prompt" }],
        temperature: 0.7,
        tools: [{ type: "function", function: { name: "read_file" } }],
      },
      statusCode: 400,
      responseBody: '{"error":{"message":"The parameter is invalid. Please check again.","code":20015}}',
      isRetryable: false,
    });
    const out = summarizeApiErrorForLog(err);
    expect(out).not.toBeNull();
    expect(out!.statusCode).toBe(400);
    expect(out!.urlHost).toBe("api.siliconflow.com");
    expect(out!.responseBodyTrunc).toBe(
      '{"error":{"message":"The parameter is invalid. Please check again.","code":20015}}',
    );
    // Keys ONLY — values must never reach the log.
    expect(out!.requestParamKeys).toEqual(["messages", "model", "temperature", "tools"]);
    // Confirm no value leak by stringifying the whole envelope.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("DeepSeek-V4-Flash");
    expect(serialized).not.toContain("read_file");
    expect(out!.isRetryable).toBe(false);
  });

  it("truncates response body over 1000 chars to keep interaction_logs bounded", () => {
    const giantBody = `${"x".repeat(2_000)}`;
    const err = new APICallError({
      message: "rate limit",
      url: "https://api.example.com/x",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: giantBody,
    });
    const out = summarizeApiErrorForLog(err);
    expect(out).not.toBeNull();
    expect(out!.responseBodyTrunc!.length).toBeLessThanOrEqual(1020);
    expect(out!.responseBodyTrunc!.endsWith("…[truncated]")).toBe(true);
  });

  it("returns null for non-APICallError so the helper is safe to call unconditionally", () => {
    expect(summarizeApiErrorForLog(new Error("plain"))).toBeNull();
    expect(summarizeApiErrorForLog("string error")).toBeNull();
    expect(summarizeApiErrorForLog(undefined)).toBeNull();
  });

  it("handles malformed URL without throwing — urlHost becomes undefined", () => {
    const err = new APICallError({
      message: "bad",
      url: "not a url",
      requestBodyValues: {},
      statusCode: 500,
    });
    const out = summarizeApiErrorForLog(err);
    expect(out).not.toBeNull();
    expect(out!.urlHost).toBeUndefined();
    expect(out!.statusCode).toBe(500);
  });

  it("handles non-object requestBodyValues without crashing — requestParamKeys becomes undefined", () => {
    const err = new APICallError({
      message: "x",
      url: "https://api.example.com/x",
      requestBodyValues: "raw json string", // pathological case
      statusCode: 400,
    });
    const out = summarizeApiErrorForLog(err);
    expect(out).not.toBeNull();
    expect(out!.requestParamKeys).toBeUndefined();
  });

  it("captures per-assistant reasoning_content lengths (PII-safe) for Z.ai 1210 diagnosis", () => {
    // The b8d363fa1b09 recurrence: uniform shape (all assistant turns carry
    // reasoning_content) but Z.ai still rejected with 1210. The KEY-only
    // signature is identical to a healthy call, so the differentiator MUST
    // come from values — lengths are PII-safe and distinguish:
    //   H1 cumulative reasoning budget exceeded (large totalReasoningChars)
    //   H2 an empty-string reasoning_content on some turn (0 in the lens)
    //   H3 oversized text/tool payload (large content length)
    const err = new APICallError({
      message: "Invalid API parameter, please check the documentation.",
      url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      requestBodyValues: {
        model: "glm-4.7",
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: null, reasoning_content: "plan", tool_calls: [{ id: "a" }] },
          { role: "tool", content: "r1" },
          // tool-only turn — reasoning_content is an EMPTY STRING (H2 candidate)
          { role: "assistant", content: null, reasoning_content: "", tool_calls: [{ id: "b" }] },
          { role: "tool", content: "r2" },
          // big-reasoning turn (H1 candidate)
          { role: "assistant", content: null, reasoning_content: "x".repeat(5000), tool_calls: [{ id: "c" }] },
        ],
      },
      statusCode: 400,
      responseBody: '{"error":{"code":"1210","message":"Invalid API parameter"}}',
    });
    const out = summarizeApiErrorForLog(err);
    expect(out).not.toBeNull();
    expect(out!.assistantFieldKeys).toEqual(["content,reasoning_content,role,tool_calls"]);
    // -1 marks a missing/non-string reasoning_content; here all are strings.
    expect(out!.assistantReasoningLens).toEqual([4, 0, 5000]);
    expect(out!.totalReasoningChars).toBe(5004);
    expect(out!.assistantToolCallCounts).toEqual([1, 1, 1]);
    expect(out!.toolMessageCount).toBe(2);
    // No reasoning prose leaks — only char counts.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("plan");
    expect(serialized).not.toContain("xxxx");
  });

  it("marks -1 for assistant turns missing reasoning_content (c0dcf9153803 shape)", () => {
    const err = new APICallError({
      message: "Invalid API parameter",
      url: "https://api.z.ai/x",
      requestBodyValues: {
        messages: [
          { role: "assistant", content: null, reasoning_content: "ok", tool_calls: [] },
          { role: "assistant", content: null, tool_calls: [{ id: "z" }] }, // missing rc
        ],
      },
      statusCode: 400,
    });
    const out = summarizeApiErrorForLog(err);
    expect(out!.assistantReasoningLens).toEqual([2, -1]);
    expect(out!.totalReasoningChars).toBe(2);
  });

  it("captures assistantToolCallCounts + parallel_tool_calls value for Z.ai H3 (many parallel tools)", () => {
    // Mirrors 94827f75a69e + c7c4a6487847: one assistant emits 12 tool_calls,
    // next request (with 12 role:tool) rejected 1210. config value + counts
    // now persisted in DB so diagnosis does not require wire log.
    const err = new APICallError({
      message: "Invalid API parameter, please check the documentation.",
      url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      requestBodyValues: {
        model: "glm-4.7",
        messages: [
          { role: "user", content: "do many things" },
          {
            role: "assistant",
            content: "plan",
            reasoning_content: "x".repeat(3889),
            tool_calls: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}` })),
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: true,
        max_tokens: 4096,
        temperature: 0.7,
      },
      statusCode: 400,
      responseBody: '{"error":{"code":"1210","message":"Invalid API parameter"}}',
    });
    const out = summarizeApiErrorForLog(err);
    expect(out).not.toBeNull();
    expect(out!.assistantToolCallCounts).toEqual([12]);
    expect(out!.toolMessageCount).toBe(0); // no tool results yet in this simulated request
    expect(out!.configParamValues?.parallel_tool_calls).toBe(true);
    expect(out!.configParamValues?.tool_choice).toBe("auto");
    const ser = JSON.stringify(out);
    expect(ser).not.toContain("do many things"); // no PII leak
  });
});
