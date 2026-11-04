import { afterEach, describe, expect, it, vi } from "vitest";
import { logEeFailure } from "../ee-logger.js";
import { logger } from "../logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).__muonroiAgentRuntime;
});

describe("native recall request diagnostics", () => {
  it("records a recognized scope400 to file without terminal noise or an outage toast event", () => {
    const file = vi.spyOn(logger, "file").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitEvent = vi.fn();
    (globalThis as any).__muonroiAgentRuntime = { emitEvent };
    logEeFailure("client.recall", "error", new Error("HTTP 400"), {
      status: 400,
      projectRequired: true,
      elapsedMs: 90,
      responseBody: "Cannot resolve a concrete project for strict recall",
    });
    expect(file).toHaveBeenCalledWith(
      "warn",
      "ee",
      "[ee.client.recall.error]",
      expect.objectContaining({
        message: "HTTP 400",
        status: 400,
        projectRequired: true,
        elapsedMs: 90,
        responseBody: expect.stringContaining("concrete project"),
      }),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it.each([
    400, 401, 403, 429, 500,
  ])("retains the real HTTP%s error event when no scope-refusal proof exists", (status) => {
    vi.spyOn(logger, "file").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitEvent = vi.fn();
    (globalThis as any).__muonroiAgentRuntime = { emitEvent };
    logEeFailure("client.recall", "error", new Error(`HTTP ${status}`), { status, projectRequired: false });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ee-error", source: "client.recall", status }),
    );
  });
});
