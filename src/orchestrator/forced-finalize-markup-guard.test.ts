/**
 * P0-5b regression pin — case (b), the FORCED-FINALIZE shape.
 *
 * Measured 2026-09-04 (SELF-IMPROVEMENT-PLAN §4.1): with **no `tools` key at
 * all** plus `tool_choice: "none"` — exactly what `forcedFinalize`
 * (`src/orchestrator/scope-ceiling.ts:222`) sends, because
 * `generateTextStreamed` only attaches `tools` when `hasTools` is true — StepFun
 * returns its native `<tool_call>…</tool_call>` markup as plain-text content
 * with `finish_reason: "stop"`. The AI SDK does not parse it, so it landed in
 * the user-visible final answer.
 *
 * This spec drives the REAL `forcedFinalize` → `generateTextStreamed` →
 * `streamText` path against a provider stub that reproduces that response, and
 * asserts three things:
 *   1. the request really is the case-(b) shape (no `tools` reaches the model);
 *   2. unguarded, the markup comes back as `result.text` — the bug;
 *   3. guarded, it never does: the caller gets a typed `ToolCallMarkupLeakError`
 *      instead of markup, and instead of a silently-empty answer.
 *
 * `forcedFinalize` is also the path stall-rescue delegates to
 * (`tool-engine.ts:3581`), so pinning it pins both call sites.
 */

import { describe, expect, it, vi } from "vitest";
import { ToolCallMarkupLeakError, wrapModelWithToolMarkupGuard } from "../providers/tool-markup-guard.js";
import { forcedFinalize } from "./scope-ceiling.js";

/** The verbatim 101-char leak captured against api.stepfun.ai on 2026-09-04. */
const MEASURED_LEAK = `<tool_call>
<function=read_file>
<parameter=path>
src/config.js
</parameter>
</function>
</tool_call>`;

/**
 * A provider stub that answers every call with `MEASURED_LEAK` as plain text and
 * `finishReason: "stop"` — the measured StepFun response for case (b). Records
 * the call params so the request SHAPE can be asserted, not assumed.
 */
function leakingModel() {
  const seen: Array<Record<string, unknown>> = [];
  const model = {
    specificationVersion: "v3" as const,
    provider: "stub",
    modelId: "stub-leaker",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: MEASURED_LEAK }],
      finishReason: "stop",
      usage: {},
      warnings: [],
    }),
    doStream: async (params: Record<string, unknown>) => {
      seen.push(params);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: MEASURED_LEAK });
            controller.enqueue({ type: "text-end", id: "0" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return { model, seen };
}

const MESSAGES = [
  { role: "user" as const, content: "read src/config.js" },
  { role: "assistant" as const, content: "ok" },
];

describe("forcedFinalize + P0-5b guard — case (b), no `tools` key at all", () => {
  it("sends the case-(b) shape: no tools reach the provider", async () => {
    const { model, seen } = leakingModel();
    await forcedFinalize({ model, messages: MESSAGES, system: "be brief" });
    expect(seen).toHaveLength(1);
    // The measured leak precondition: an empty tool set on a turn whose history
    // already carries tool usage. `undefined` (not `[]`) is what this path sends.
    expect(seen[0].tools).toBeUndefined();
  });

  it("UNGUARDED: the markup comes back as the final answer (the bug being fixed)", async () => {
    const { model } = leakingModel();
    const res = await forcedFinalize({ model, messages: MESSAGES });
    expect(res.text).toBe(MEASURED_LEAK);
  });

  it("GUARDED: raises a typed failure instead of markup, and never an empty answer", async () => {
    const { model } = leakingModel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const guarded = wrapModelWithToolMarkupGuard(model, { enabled: true, modelId: "stub-leaker" });
    await expect(forcedFinalize({ model: guarded, messages: MESSAGES })).rejects.toBeInstanceOf(
      ToolCallMarkupLeakError,
    );
    warn.mockRestore();
  });

  it("GUARDED: a legitimate synthesis that quotes the markup still returns verbatim", async () => {
    const answer = `I could not read the file. StepFun returned:\n${MEASURED_LEAK}\nwhich is not an answer.`;
    const { model } = leakingModel();
    model.doStream = async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "0" });
          // split INSIDE the quoted markup so the hold-back path runs
          controller.enqueue({ type: "text-delta", id: "0", delta: answer.slice(0, 55) });
          controller.enqueue({ type: "text-delta", id: "0", delta: answer.slice(55) });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    });
    const guarded = wrapModelWithToolMarkupGuard(model, { enabled: true, modelId: "stub-leaker" });
    const res = await forcedFinalize({ model: guarded, messages: MESSAGES });
    expect(res.text).toBe(answer);
  });
});
