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
        model: "deepseek-ai/DeepSeek-V4-Flash",
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
});
