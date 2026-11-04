import { afterEach, describe, expect, it, vi } from "vitest";
import { reportRetryNotice, setRetryReporter, withVisibleRetry } from "../visible-retry.js";

afterEach(() => {
  setRetryReporter(null);
  vi.restoreAllMocks();
});

describe("retry notice routing", () => {
  it("marks provider throttling so the TUI can retain diagnostics without a toast", async () => {
    const reporter = vi.fn();
    setRetryReporter(reporter);
    const error = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    const call = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("recovered");
    await expect(withVisibleRetry(call, { delaysMs: [0] })).resolves.toBe("recovered");
    expect(reporter).toHaveBeenCalledWith(expect.stringContaining("429"), "warn", { kind: "rate-limit" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps non-throttling retry notices on their existing route", async () => {
    const reporter = vi.fn();
    setRetryReporter(reporter);
    const call = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValue("recovered");
    await withVisibleRetry(call, { delaysMs: [0] });
    expect(reporter).toHaveBeenCalledWith(expect.stringContaining("socket hang up"), "warn");
  });

  it("still reports throttling to stderr outside the TUI", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    reportRetryNotice("provider retry", "warn", { kind: "rate-limit" });
    expect(stderr).toHaveBeenCalledWith("provider retry\n");
  });
});
