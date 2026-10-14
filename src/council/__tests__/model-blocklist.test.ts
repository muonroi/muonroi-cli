/**
 * Session-scoped council model blocklist (model-blocklist.ts).
 *
 * Guards Fix 2 for session 947db934b573: opencode-go returned a 403
 * RegionError for opencode/deepseek-v4-flash and a later utility call in the
 * SAME session picked it again and burned the identical failure. These tests
 * pin: the narrow 401/403 + isRetryable:false classification (429/5xx/timeout
 * must NOT qualify), session scoping (one session's block does not leak into
 * another), the one-shot notification contract, and that nothing here ever
 * touches disk.
 */
import { APICallError } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeApiErrorForLog } from "../../orchestrator/error-utils.js";
import {
  blockModel,
  clearModelBlocklist,
  clearAuthBlocksWhere,
  consumeBlockNotification,
  formatBlockedModelWarning,
  getBlockedModel,
  isModelBlocked,
  isNonRetryableAuthFailure,
} from "../model-blocklist.js";

beforeEach(() => {
  clearModelBlocklist();
});

function apiError(statusCode: number, isRetryable?: boolean): APICallError {
  return new APICallError({
    message: "The latest version of this model is only available hosted in China and requires explicit opt in.",
    url: "https://opencode.ai/zen/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: '{"type":"error","error":{"type":"RegionError"}}',
    isRetryable,
  });
}

describe("isNonRetryableAuthFailure", () => {
  it("qualifies a 403 with SDK isRetryable:false", () => {
    const forensics = summarizeApiErrorForLog(apiError(403, false));
    expect(isNonRetryableAuthFailure(forensics)).toBe(true);
  });

  it("qualifies a 401 with SDK isRetryable:false", () => {
    const forensics = summarizeApiErrorForLog(apiError(401, false));
    expect(isNonRetryableAuthFailure(forensics)).toBe(true);
  });

  it("does NOT qualify a 429 (transient — must keep retrying)", () => {
    const forensics = summarizeApiErrorForLog(apiError(429, false));
    expect(isNonRetryableAuthFailure(forensics)).toBe(false);
  });

  it("does NOT qualify a 5xx (transient — must keep retrying)", () => {
    const forensics = summarizeApiErrorForLog(apiError(503, false));
    expect(isNonRetryableAuthFailure(forensics)).toBe(false);
  });

  it("does NOT qualify a 403 the SDK still marks retryable", () => {
    const forensics = summarizeApiErrorForLog(apiError(403, true));
    expect(isNonRetryableAuthFailure(forensics)).toBe(false);
  });

  it("qualifies a 403 with isRetryable omitted — the AI SDK's own default for 403 IS false (matches the live evidence: the SDK classified the RegionError as non-retryable without any override)", () => {
    const forensics = summarizeApiErrorForLog(apiError(403, undefined));
    expect(forensics?.isRetryable).toBe(false);
    expect(isNonRetryableAuthFailure(forensics)).toBe(true);
  });

  it("returns false for a plain Error (no forensics at all — e.g. a timeout)", () => {
    expect(isNonRetryableAuthFailure(summarizeApiErrorForLog(new Error("The operation timed out.")))).toBe(false);
  });

  it("returns false for null forensics", () => {
    expect(isNonRetryableAuthFailure(null)).toBe(false);
  });
});

describe("blockModel / isModelBlocked / getBlockedModel", () => {
  it("blocks a model within its session scope", () => {
    blockModel("sess-1", "opencode/deepseek-v4-flash", { statusCode: 403, reason: "RegionError" });
    expect(isModelBlocked("sess-1", "opencode/deepseek-v4-flash")).toBe(true);
    const info = getBlockedModel("sess-1", "opencode/deepseek-v4-flash");
    expect(info?.statusCode).toBe(403);
    expect(info?.reason).toBe("RegionError");
    expect(typeof info?.blockedAt).toBe("number");
  });

  it("does not block an unrelated model in the same session", () => {
    blockModel("sess-1", "opencode/deepseek-v4-flash", { statusCode: 403, reason: "RegionError" });
    expect(isModelBlocked("sess-1", "deepseek-chat")).toBe(false);
  });

  it("scopes blocks per session — one session's block does not leak into another", () => {
    blockModel("sess-1", "opencode/deepseek-v4-flash", { statusCode: 403, reason: "RegionError" });
    expect(isModelBlocked("sess-2", "opencode/deepseek-v4-flash")).toBe(false);
  });

  it("shares one process-wide bucket when sessionId is undefined (headless/test callers)", () => {
    blockModel(undefined, "opencode/deepseek-v4-flash", { statusCode: 401, reason: "no key" });
    expect(isModelBlocked(undefined, "opencode/deepseek-v4-flash")).toBe(true);
  });
});

describe("consumeBlockNotification — one-shot per (scope, model)", () => {
  it("returns true the first time and false on every later call for the same model", () => {
    expect(consumeBlockNotification("sess-1", "opencode/deepseek-v4-flash")).toBe(true);
    expect(consumeBlockNotification("sess-1", "opencode/deepseek-v4-flash")).toBe(false);
    expect(consumeBlockNotification("sess-1", "opencode/deepseek-v4-flash")).toBe(false);
  });

  it("is independent per model within the same scope", () => {
    expect(consumeBlockNotification("sess-1", "model-a")).toBe(true);
    expect(consumeBlockNotification("sess-1", "model-b")).toBe(true);
  });

  it("is independent per scope for the same model", () => {
    expect(consumeBlockNotification("sess-1", "model-a")).toBe(true);
    expect(consumeBlockNotification("sess-2", "model-a")).toBe(true);
  });
});

describe("formatBlockedModelWarning", () => {
  it("names the model and the reason", () => {
    const text = formatBlockedModelWarning({
      modelId: "opencode/deepseek-v4-flash",
      statusCode: 403,
      reason: "RegionError",
      blockedAt: Date.now(),
    });
    expect(text).toContain("opencode/deepseek-v4-flash");
    expect(text).toContain("403");
    expect(text).toContain("RegionError");
  });
});

describe("clearModelBlocklist", () => {
  it("clears a single scope without touching others", () => {
    blockModel("sess-1", "m1", { statusCode: 403, reason: "x" });
    blockModel("sess-2", "m1", { statusCode: 403, reason: "x" });
    clearModelBlocklist("sess-1");
    expect(isModelBlocked("sess-1", "m1")).toBe(false);
    expect(isModelBlocked("sess-2", "m1")).toBe(true);
  });

  it("clears every scope when called with no argument", () => {
    blockModel("sess-1", "m1", { statusCode: 403, reason: "x" });
    blockModel("sess-2", "m1", { statusCode: 403, reason: "x" });
    clearModelBlocklist();
    expect(isModelBlocked("sess-1", "m1")).toBe(false);
    expect(isModelBlocked("sess-2", "m1")).toBe(false);
  });
});

describe("clearAuthBlocksWhere — a credential change must not leave stale blocks", () => {
  // Regression for a measured session (2026-09-09, 478bb611a315): a wrong key
  // blocked step-3.5-flash at 01:57; the user fixed the key at 01:59 and the
  // council still logged `reason: "blocked"` for it at 02:05. Only a restart
  // cleared it. `clearModelBlocklist` existed but had no production caller.
  beforeEach(() => clearModelBlocklist());

  it("clears matching blocks across EVERY session scope, because a credential change is global", () => {
    blockModel("sess-A", "step-3.5-flash", { statusCode: 401, reason: "Incorrect API key provided" });
    blockModel("sess-B", "step-3.7-flash", { statusCode: 401, reason: "Incorrect API key provided" });

    const cleared = clearAuthBlocksWhere((i) => i.modelId.startsWith("step-"));

    expect(cleared).toBe(2);
    expect(isModelBlocked("sess-A", "step-3.5-flash")).toBe(false);
    expect(isModelBlocked("sess-B", "step-3.7-flash")).toBe(false);
  });

  it("leaves a block the predicate does not match — scoped, not a blanket wipe", () => {
    blockModel("sess-A", "step-3.5-flash", { statusCode: 401, reason: "bad key" });
    blockModel("sess-A", "glm-5.2", { statusCode: 403, reason: "unrelated provider" });

    clearAuthBlocksWhere((i) => i.modelId.startsWith("step-"));

    expect(isModelBlocked("sess-A", "step-3.5-flash")).toBe(false);
    expect(isModelBlocked("sess-A", "glm-5.2")).toBe(true);
  });

  it("forgets the one-shot notification too, so a later re-block warns again", () => {
    blockModel("sess-A", "step-3.5-flash", { statusCode: 401, reason: "bad key" });
    expect(consumeBlockNotification("sess-A", "step-3.5-flash")).toBe(true);
    expect(consumeBlockNotification("sess-A", "step-3.5-flash")).toBe(false);

    clearAuthBlocksWhere((i) => i.modelId.startsWith("step-"));
    blockModel("sess-A", "step-3.5-flash", { statusCode: 401, reason: "bad key again" });

    expect(consumeBlockNotification("sess-A", "step-3.5-flash")).toBe(true);
  });

  it("reports zero and changes nothing when no block matches", () => {
    blockModel("sess-A", "glm-5.2", { statusCode: 403, reason: "unrelated" });
    expect(clearAuthBlocksWhere((i) => i.modelId.startsWith("step-"))).toBe(0);
    expect(isModelBlocked("sess-A", "glm-5.2")).toBe(true);
  });
});
