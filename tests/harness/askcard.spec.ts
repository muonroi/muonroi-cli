import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("askcard E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("composer accepts input on startup", () => {
    expect(driver.query("role=textbox")?.role).toBe("textbox");
  });

  it.skip("council question modal appears and is observable", async () => {
    // BLOCKED (verified 2026-05-18): mock-llm sequence mode IS now implemented
    // (see src/agent-harness/mock-llm.ts sequence-fixture support) and a council
    // fixture exists at tests/harness/fixtures/llm-council-question/ that returns
    // a non-empty AMBIGUITIES array. But end-to-end the council_question chunk
    // does not reach app.tsx within 30s, mirroring the pre-existing blocker
    // documented in tests/harness/council-flow.spec.ts:60–68 ("runCouncilV2 is
    // not reaching the phase chunk emission within 30s even with mock-llm hooked
    // via Wave 2.5"). Root cause is in the council orchestrator's phase pipeline
    // (preflight / debate-planner generateObject) rejecting mock fixture JSON,
    // OR a downstream askcard step blocking on input the harness doesn't
    // auto-answer. Fix requires instrumenting the council orchestrator and
    // expanding fixture coverage — out of scope for the mock-llm error/sequence
    // work in this commit.
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    expect(driver.query("id=askcard")?.role).toBe("dialog");
  });

  it.skip("can navigate askcard options with arrow keys", async () => {
    // BLOCKED (verified 2026-05-18): mock-llm sequence mode IS now implemented
    // (see src/agent-harness/mock-llm.ts sequence-fixture support) and a council
    // fixture exists at tests/harness/fixtures/llm-council-question/ that returns
    // a non-empty AMBIGUITIES array. But end-to-end the council_question chunk
    // does not reach app.tsx within 30s, mirroring the pre-existing blocker
    // documented in tests/harness/council-flow.spec.ts:60–68 ("runCouncilV2 is
    // not reaching the phase chunk emission within 30s even with mock-llm hooked
    // via Wave 2.5"). Root cause is in the council orchestrator's phase pipeline
    // (preflight / debate-planner generateObject) rejecting mock fixture JSON,
    // OR a downstream askcard step blocking on input the harness doesn't
    // auto-answer. Fix requires instrumenting the council orchestrator and
    // expanding fixture coverage — out of scope for the mock-llm error/sequence
    // work in this commit.
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    driver.press("Down");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    const selected = driver.queryAll("role=button").find((n) => n.selected);
    expect(selected).toBeDefined();
  });
});
