import { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { abortableStream } from "../llm-deadline.js";

describe("abortable SDK stream", () => {
  it("ends a read when doStream never settles, even though SDK already emitted start", async () => {
    const controller = new AbortController();
    const result = streamText({
      model: new MockLanguageModelV3({ doStream: () => new Promise(() => {}) }),
      prompt: "probe",
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    const parts: string[] = [];
    const consume = (async () => {
      for await (const part of abortableStream(result.fullStream, controller.signal, "SDK stall", { type: "abort" }))
        parts.push(part.type);
    })();
    await vi.waitFor(() => expect(parts).toEqual(["start"]));
    controller.abort(new Error("provider-stall"));
    await consume;
    expect(parts).toEqual(["start", "abort"]);
  });

  it("discards a late read and never waits on a wedged return", async () => {
    const controller = new AbortController();
    let resolveLate!: (v: IteratorResult<string>) => void;
    const cleanup = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
    const next = vi.fn(
      () =>
        new Promise<IteratorResult<string>>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const stream = { [Symbol.asyncIterator]: () => ({ next, return: cleanup }) };
    const parts: string[] = [];
    const consume = (async () => {
      for await (const part of abortableStream(stream, controller.signal, "late read", "aborted")) parts.push(part);
    })();
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    controller.abort(new Error("stop"));
    await consume;
    resolveLate({ done: false, value: "LATE_PROVIDER_OUTPUT" });
    await Promise.resolve();
    expect(parts).toEqual(["aborted"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("propagates provider errors without converting them into cancellation", async () => {
    const cleanup = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("real provider failure");
        },
        return: cleanup,
      }),
    };
    const consume = async () => {
      for await (const _ of abortableStream(stream, new AbortController().signal, "failed provider", "aborted")) {
        /* drain */
      }
    };
    await expect(consume()).rejects.toThrow("real provider failure");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
