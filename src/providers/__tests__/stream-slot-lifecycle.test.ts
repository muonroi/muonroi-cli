import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapModelWithGate } from "../model-gate.js";
import { settleLedgerWrites } from "../rate-ledger.js";
import { __rateLimiterStateForTests, __resetRateLimiterForTests } from "../rate-limiter.js";

describe("provider stream slot lifecycle", () => {
  let home: string;
  const provider = "stream-lifecycle-fixture";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-stream-lifecycle-"));
    vi.stubEnv("MUONROI_CLI_HOME", home);
    vi.stubEnv("MUONROI_RATE_LEDGER", "1");
    vi.stubEnv("MUONROI_RATE_LIMIT", "1");
    __resetRateLimiterForTests();
  });

  afterEach(async () => {
    await settleLedgerWrites();
    vi.unstubAllEnvs();
    __resetRateLimiterForTests();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function fixture(createStream: () => ReadableStream) {
    const transport = vi.fn(async () => ({ stream: createStream() }));
    const model = wrapModelWithGate(
      { specificationVersion: "v3", provider, modelId: "fixture", supportedUrls: {}, doStream: transport },
      { stage: "main", providerId: provider, modelId: "fixture", rateLimits: { concurrency: 5 } },
    );
    return { model, transport };
  }

  async function expectReleased() {
    await vi.waitFor(() => expect(__rateLimiterStateForTests(provider)?.inFlight).toBe(0));
    await settleLedgerWrites();
    const ledger = JSON.parse(fs.readFileSync(path.join(home, "rate-ledger", `${provider}.json`), "utf8"));
    expect(ledger.entries.every((entry: { inFlight: boolean }) => !entry.inFlight)).toBe(true);
  }

  it.each(["error", "cancel", "abort"] as const)("dispatches again after five stream %s terminations", async (mode) => {
    const reason = new Error(`fixture ${mode}`);
    const { model, transport } = fixture(
      () =>
        new ReadableStream({
          start(c) {
            if (mode === "error") c.error(reason);
          },
        }),
    );
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const result = await model.doStream({ prompt: [], abortSignal: controller.signal });
      if (mode === "error") await expect(result.stream.getReader().read()).rejects.toBe(reason);
      else if (mode === "cancel") await result.stream.cancel(reason);
      else controller.abort(reason);
    }
    await expectReleased();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("next request blocked locally")), 500);
    try {
      const next = await model.doStream({ prompt: [], abortSignal: controller.signal });
      expect(transport).toHaveBeenCalledTimes(6);
      await next.stream.cancel();
      await expectReleased();
    } finally {
      clearTimeout(timeout);
    }
  });

  it("keeps a healthy stream's slot until finish and settles its usage", async () => {
    let source!: ReadableStreamDefaultController;
    const { model } = fixture(
      () =>
        new ReadableStream({
          start(c) {
            source = c;
          },
        }),
    );
    const result = await model.doStream({ prompt: [] });
    const reader = result.stream.getReader();
    source.enqueue({ type: "text-delta", delta: "still running" });
    expect((await reader.read()).value).toEqual({ type: "text-delta", delta: "still running" });
    expect(__rateLimiterStateForTests(provider)?.inFlight).toBe(1);
    source.enqueue({ type: "finish", usage: { inputTokens: 10, outputTokens: 4 } });
    source.close();
    expect((await reader.read()).value.type).toBe("finish");
    expect((await reader.read()).done).toBe(true);
    await expectReleased();
    const ledger = JSON.parse(fs.readFileSync(path.join(home, "rate-ledger", `${provider}.json`), "utf8"));
    expect(ledger.entries[0].tokens).toBe(14);
  });
});
