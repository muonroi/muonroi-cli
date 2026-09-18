/**
 * create-product-llm-signal.test.ts — D3: `createProductLlm.generate` used to
 * hardcode the `signal` it forwarded to the underlying `CouncilLLM` to
 * `undefined`, so an in-flight call could never be cancelled — only the NEXT
 * call would notice an abort (see the fixed comment at `createProductLlm` in
 * sprint-runner.ts and the ruling-call site in item-debate-runner.ts).
 *
 * This file pins the fix directly on the wrapper, independent of the
 * item-debate-runner seam: a pre-aborted signal must reject before the
 * "provider" (the fake `base.generate`) is ever called, a live signal that
 * aborts mid-call must reject the outer call, and a normal call must be
 * completely unaffected — no cost recorded on either abort path, no retry
 * added by this wrapper (it has none of its own), and a live signal forwards
 * through unchanged when nothing aborts.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import type { CouncilLLM } from "../../council/types.js";
import { loadCatalog } from "../../models/registry.js";
import * as productLedger from "../../usage/product-ledger.js";
import { createProductLlm } from "../sprint-runner.js";

describe("createProductLlm.generate — signal threading (D3)", () => {
  let home: string;
  let model: string;
  const savedHome = process.env.MUONROI_CLI_HOME;

  beforeAll(async () => {
    await loadCatalog();
    model = getTestModels().balanced;
  });

  beforeEach(async () => {
    home = path.join(os.tmpdir(), `product-llm-signal-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(home, { recursive: true });
    process.env.MUONROI_CLI_HOME = home;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("a pre-aborted signal rejects without ever calling base.generate (the provider)", async () => {
    const appended = vi.spyOn(productLedger, "appendProductLedger").mockResolvedValue(undefined);
    const generate = vi.fn(async () => "should never run");
    const base = { generate, research: vi.fn(), debate: vi.fn() } as unknown as CouncilLLM;
    const llm = createProductLlm(base, "run-abort-pre");

    const ac = new AbortController();
    ac.abort();

    await expect(llm.generate(model, "sys", "prompt", 256, undefined, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(generate).not.toHaveBeenCalled();
    // No cost recorded for a call that never reached the provider.
    expect(appended).not.toHaveBeenCalled();
  });

  it("aborting mid-call rejects the outer call", async () => {
    const appended = vi.spyOn(productLedger, "appendProductLedger").mockResolvedValue(undefined);
    // Simulate the underlying CouncilLLM honouring the forwarded signal, the
    // same way createCouncilLLM.generate's real SDK call does.
    const generate = vi.fn(
      (
        _modelId: string,
        _system: string,
        _prompt: string,
        _maxTokens?: number,
        _onUsage?: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise<string>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    const base = { generate, research: vi.fn(), debate: vi.fn() } as unknown as CouncilLLM;
    const llm = createProductLlm(base, "run-abort-mid");

    const ac = new AbortController();
    const pending = llm.generate(model, "sys", "prompt", 256, undefined, ac.signal);
    ac.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // The wrapper adds no retry of its own — base.generate is called exactly once.
    expect(generate).toHaveBeenCalledTimes(1);
    // No cost recorded for a call that never resolved.
    expect(appended).not.toHaveBeenCalled();
  });

  it("forwards the exact signal instance to base.generate when the call is live", async () => {
    const generate = vi.fn(async (..._args: Parameters<CouncilLLM["generate"]>) => "planned");
    const base = { generate, research: vi.fn(), debate: vi.fn() } as unknown as CouncilLLM;
    const llm = createProductLlm(base, "run-live-signal");

    const ac = new AbortController();
    await llm.generate(model, "sys", "prompt", 256, undefined, ac.signal);

    expect(generate).toHaveBeenCalledTimes(1);
    // signal is the 6th positional argument.
    expect(generate.mock.calls[0]?.[5]).toBe(ac.signal);
  });

  it("a normal call with no signal is completely unaffected", async () => {
    vi.spyOn(productLedger, "appendProductLedger").mockResolvedValue(undefined);
    const generate = vi.fn(async (..._args: Parameters<CouncilLLM["generate"]>) => "planned");
    const base = { generate, research: vi.fn(), debate: vi.fn() } as unknown as CouncilLLM;
    const llm = createProductLlm(base, "run-no-signal");

    await expect(llm.generate(model, "sys", "prompt", 256)).resolves.toBe("planned");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[5]).toBeUndefined();
  });
});
