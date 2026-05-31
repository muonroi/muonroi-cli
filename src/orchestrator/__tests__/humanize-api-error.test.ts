/**
 * P0 #2 — surface the ROUTED model/provider on account/auth/rate errors so a
 * cryptic provider 402 ("Insufficient Balance") tells the user WHICH model it
 * actually ran (e.g. a project-pinned deepseek model overriding their default)
 * and how to fix it, instead of leaving them guessing.
 */
import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { humanizeApiError } from "../error-utils.js";

function apiErr(statusCode: number, responseBody: string): APICallError {
  return new APICallError({
    message: "provider error",
    url: "https://api.deepseek.com/chat/completions",
    requestBodyValues: { model: "deepseek-v4-flash" },
    statusCode,
    responseBody,
    isRetryable: false,
  });
}

describe("humanizeApiError — routing context (P0 #2)", () => {
  it("adds routed model + provider + a balance hint on 402", () => {
    const err = apiErr(402, '{"error":{"message":"Insufficient Balance"}}');
    const msg = humanizeApiError(err, { modelId: "deepseek-v4-flash", providerId: "deepseek" });
    expect(msg).toContain("Insufficient Balance");
    expect(msg).toContain("deepseek-v4-flash");
    expect(msg).toContain("deepseek");
    expect(msg).toMatch(/-m /); // suggests switching model
    expect(msg).toMatch(/balance|credit/i);
  });

  it("points to keys login on 401/403", () => {
    const msg = humanizeApiError(apiErr(401, '{"error":{"message":"bad key"}}'), {
      modelId: "gpt-5.4-mini",
      providerId: "openai",
    });
    expect(msg).toContain("gpt-5.4-mini");
    expect(msg).toMatch(/keys login/);
  });

  it("mentions rate limit + switch on 429", () => {
    const msg = humanizeApiError(apiErr(429, '{"error":{"message":"slow down"}}'), {
      modelId: "deepseek-v4-flash",
      providerId: "deepseek",
    });
    expect(msg).toMatch(/rate.?limit/i);
    expect(msg).toMatch(/-m /);
  });

  it("does NOT add a routing suffix on server-side 500 (not the user's routing)", () => {
    const msg = humanizeApiError(apiErr(500, '{"error":{"message":"boom"}}'), {
      modelId: "deepseek-v4-flash",
      providerId: "deepseek",
    });
    expect(msg).not.toContain("routed to");
    expect(msg).not.toContain("deepseek-v4-flash");
  });

  it("is unchanged when no context is supplied (backward compatible)", () => {
    const err = apiErr(402, '{"error":{"message":"Insufficient Balance"}}');
    const withoutCtx = humanizeApiError(err);
    expect(withoutCtx).toBe("Insufficient Balance");
    expect(withoutCtx).not.toContain("routed to");
  });

  it("flags balance even when status is unparsed but the body says so", () => {
    // Some gateways surface the balance error without a clean statusCode.
    const err = new Error("Insufficient Balance") as Error & { statusCode?: number };
    const msg = humanizeApiError(err, { modelId: "deepseek-v4-flash", providerId: "deepseek" });
    expect(msg).toContain("deepseek-v4-flash");
    expect(msg).toMatch(/balance|credit/i);
  });
});
