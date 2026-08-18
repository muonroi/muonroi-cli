import { describe, expect, it } from "vitest";
import { createMockModel, errorStream, textOnlyStream } from "../../agent-harness/mock-model.js";
import { generateTextStreamed } from "../streamed-generate.js";

describe("generateTextStreamed", () => {
  it("collects streamed text (the codex-safe generateText drop-in)", async () => {
    const { model } = createMockModel({ stream: textOnlyStream("Hello, streamed world") });
    const res = await generateTextStreamed({ model, prompt: "hi" });
    expect(res.text).toBe("Hello, streamed world");
    expect(res.usage).toBeDefined();
    expect(res.finishReason).toBe("stop");
  });

  it("re-throws a provider error stream part so caller retry/fallback still fires", async () => {
    // This is the exact failure the fix targets: the codex/oauth endpoint 400s
    // non-stream requests with 'Stream must be set to true'. A real provider
    // surfaces that as an `error` stream part; the drop-in must re-throw it just
    // as generateText threw, not swallow it into an empty result.
    const { model } = createMockModel({ stream: errorStream({ message: "Stream must be set to true" }) });
    await expect(generateTextStreamed({ model, prompt: "hi" })).rejects.toThrow(/Stream must be set to true/);
  });

  it("works with messages (not just prompt)", async () => {
    const { model } = createMockModel({ stream: textOnlyStream("from messages") });
    const res = await generateTextStreamed({
      model,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.text).toBe("from messages");
  });
});
