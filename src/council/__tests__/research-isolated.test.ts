/**
 * #2 — mid-debate/initial research runs in an ISOLATED explore sub-agent when the
 * orchestrator wires `runIsolatedTask` (a budget-capped, near-empty child), and
 * transparently falls back to the in-process `llm.research` path otherwise or on
 * failure. Guards the seam: RunCouncilOptions.runIsolatedTask → CouncilConfig →
 * researchWithFallback.
 */
import { describe, expect, it, vi } from "vitest";
import { researchWithFallback } from "../debate.js";
import type { CouncilLLM } from "../types.js";

function fakeLlm(researchImpl: () => Promise<string>): CouncilLLM {
  return {
    generate: vi.fn(),
    debate: vi.fn(),
    research: vi.fn(researchImpl),
  } as unknown as CouncilLLM;
}

describe("#2 researchWithFallback — isolated sub-agent", () => {
  it("uses the isolated task output and does NOT call llm.research on success", async () => {
    const llm = fakeLlm(async () => "SHOULD-NOT-BE-CALLED");
    const runIsolatedTask = vi.fn().mockResolvedValue({
      success: true,
      output: "## Research Findings\nfoo.ts:10 does X",
    });

    const out = await researchWithFallback(
      llm,
      "research-model",
      "topic",
      "ctx",
      undefined,
      () => {},
      {},
      ["research-model"],
      runIsolatedTask,
    );

    expect(out).toContain("foo.ts:10 does X");
    expect(runIsolatedTask).toHaveBeenCalledTimes(1);
    expect(llm.research).not.toHaveBeenCalled();
    // Request shape: read-only explore agent, pinned research model.
    const req = runIsolatedTask.mock.calls[0][0];
    expect(req.agent).toBe("explore");
    expect(req.modelId).toBe("research-model");
    expect(typeof req.prompt).toBe("string");
  });

  it("falls back to llm.research when the isolated task fails", async () => {
    const llm = fakeLlm(async () => "## Source Code Findings\nlegacy in-process findings");
    const runIsolatedTask = vi.fn().mockResolvedValue({ success: false, error: "boom" });

    const out = await researchWithFallback(
      llm,
      "research-model",
      "topic",
      "ctx",
      undefined,
      () => {},
      {},
      ["research-model"],
      runIsolatedTask,
    );

    expect(out).toContain("legacy in-process findings");
    expect(runIsolatedTask).toHaveBeenCalledTimes(1);
    expect(llm.research).toHaveBeenCalledTimes(1);
  });

  it("skips the isolated path entirely when no runIsolatedTask is wired (legacy behavior)", async () => {
    const llm = fakeLlm(async () => "legacy only");
    const out = await researchWithFallback(llm, "m", "topic", "ctx", undefined, () => {}, {}, ["m"]);
    expect(out).toBe("legacy only");
    expect(llm.research).toHaveBeenCalledTimes(1);
  });

  it("does not start the isolated task when the signal is already aborted", async () => {
    const llm = fakeLlm(async () => "legacy after abort");
    const runIsolatedTask = vi.fn();
    const ac = new AbortController();
    ac.abort();

    const out = await researchWithFallback(llm, "m", "topic", "ctx", ac.signal, () => {}, {}, ["m"], runIsolatedTask);

    expect(runIsolatedTask).not.toHaveBeenCalled();
    expect(out).toBe("legacy after abort");
  });
});
