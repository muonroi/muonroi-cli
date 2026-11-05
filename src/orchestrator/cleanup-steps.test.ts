import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../utils/logger.js";
import { runCleanupStep, runCleanupSteps } from "./cleanup-steps.js";

describe("runCleanupStep", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a never-settling step is abandoned at the bound and logged by name", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const t0 = Date.now();
    const out = await runCleanupStep("mcp", () => new Promise(() => {}), 50);
    expect(out.status).toBe("timed-out");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(warn).toHaveBeenCalledWith("orchestrator", expect.stringContaining('cleanup step "mcp" did not settle'), {
      step: "mcp",
      timeoutMs: 50,
    });
  });

  it("a rejected step is logged with its name and message, never silently", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const out = await runCleanupStep("lsp", () => Promise.reject(new Error("boom")), 1_000);
    expect(out.status).toBe("rejected");
    expect(error).toHaveBeenCalledWith(
      "orchestrator",
      expect.stringContaining('cleanup step "lsp" failed: boom'),
      expect.objectContaining({ step: "lsp" }),
    );
  });

  it("a synchronously throwing step is reported as rejected", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const out = await runCleanupStep(
      "bash",
      () => {
        throw new Error("sync");
      },
      1_000,
    );
    expect(out.status).toBe("rejected");
    expect(error).toHaveBeenCalledWith("orchestrator", expect.stringContaining('"bash" threw: sync'), { step: "bash" });
  });

  it("runs steps concurrently: one hung step does not delay the others' completion", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    let fastDone = false;
    const outs = await runCleanupSteps(
      [
        ["hung", () => new Promise(() => {})],
        [
          "fast",
          async () => {
            fastDone = true;
          },
        ],
      ],
      50,
    );
    expect(fastDone).toBe(true);
    expect(outs.map((o) => [o.name, o.status])).toEqual([
      ["hung", "timed-out"],
      ["fast", "done"],
    ]);
  });
});
