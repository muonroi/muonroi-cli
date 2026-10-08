/**
 * `ensureCouncilFactory` (credential resolution: keychain read +
 * `createProviderFactoryAsync`) previously ran with NO bound at all inside
 * `CouncilLLM.generate()` / `.debate()` / `.research()`, ahead of the
 * deadline signal those callers combine further down. A stuck OAuth refresh
 * or a held mutex hung the ENTIRE call regardless of the caller's own
 * deadline. See the doc comment on `getCouncilFactoryDeadlineMs` in
 * `../llm.ts` for the confirmed live evidence (session 697419024ec8: a
 * small-prompt council leader call took 64.5s wall clock despite a 2500ms
 * caller deadline; sibling session 1e9db4d68da0 never returned at all).
 *
 * This test proves the fix: a credential-resolution await that never settles
 * is bounded by `MUONROI_COUNCIL_FACTORY_TIMEOUT_MS` and rejects instead of
 * hanging forever — fail open, with a labeled error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../providers/keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/keychain.js")>();
  return {
    ...actual,
    // Never resolves — simulates a stuck keychain read / OAuth refresh /
    // held mutex, exactly the unbounded-hang class this fix guards against.
    loadKeyForProvider: vi.fn(() => new Promise<never>(() => {})),
  };
});

vi.mock("../../providers/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/runtime.js")>();
  return {
    ...actual,
    detectProviderForModel: vi.fn(() => "openai"),
    createProviderFactoryAsync: vi.fn(async () => ({ factory: () => ({}) })),
  };
});

import type { BashTool } from "../../tools/bash.js";
import { createCouncilLLM } from "../llm.js";

describe("ensureCouncilFactory — bounded credential resolution", () => {
  const ORIGINAL_ENV = process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS;
    else process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS = ORIGINAL_ENV;
  });

  it("rejects within the bound instead of hanging forever, and fails open (does not crash the process)", async () => {
    // Clamped floor is 1000ms (see getCouncilFactoryDeadlineMs below).
    process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS = "1000";
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as unknown as BashTool, "agent", "test-session", stats);

    const start = Date.now();
    await expect(llm.generate("gpt-stub-model", "sys", "prompt", 100)).rejects.toThrow(/exceeded 1000ms/);
    const elapsedMs = Date.now() - start;

    // Bounded: rejects close to the 1000ms budget, not the vitest test timeout.
    expect(elapsedMs).toBeLessThan(4000);
  }, 10_000);

  it("getCouncilFactoryDeadlineMs — validated env override, clamped, fail-open default", async () => {
    const { getCouncilFactoryDeadlineMs } = await import("../llm.js");

    delete process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS;
    expect(getCouncilFactoryDeadlineMs()).toBe(10_000);

    process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS = "5000";
    expect(getCouncilFactoryDeadlineMs()).toBe(5000);

    // Out of range / garbage → falls back to the default rather than arming
    // a zero or negative timer (which `withDeadlineRace` treats as disabled).
    process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS = "0";
    expect(getCouncilFactoryDeadlineMs()).toBe(10_000);
    process.env.MUONROI_COUNCIL_FACTORY_TIMEOUT_MS = "not-a-number";
    expect(getCouncilFactoryDeadlineMs()).toBe(10_000);
  });
});
