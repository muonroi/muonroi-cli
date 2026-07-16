/**
 * api-key.spec.ts
 *
 * Onboarding flow (redesigned): a fresh boot with NO configured credential
 * lands straight in chat — there is NO forced API-key modal. Auth is on-demand:
 * sending a message with no provider configured opens the provider picker
 * (`id="model-picker"`) and keeps the typed text for resend.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/api-key.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

// MUONROI_TEST_NO_KEYCHAIN=1 makes getApiKey()/resolveKeyForModel/hasOAuthForModel
// all return null regardless of the dev machine's env, so the boot is truly
// unauthenticated. Runs on every platform.
describe("onboarding: no-auth boots to chat, send opens picker", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      env: {
        MUONROI_TEST_NO_KEYCHAIN: "1",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        // Clear the mock deepseek key seeded by the default spawnHarness env so
        // the boot is genuinely unauthenticated.
        DEEPSEEK_API_KEY: "",
      },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("boots straight to the composer with no forced API-key modal", async () => {
    await driver.wait_for({ selector: "id=composer", timeoutMs: 15_000 });
    expect(driver.query("id=composer")).not.toBeNull();
    // The old forced modal must NOT be present on boot.
    expect(driver.query("id=api-key-modal")).toBeNull();
  });

  it("can type into the composer while unauthenticated", async () => {
    driver.focus("id=composer");
    driver.type("hello there");
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    expect(driver.query("id=composer")).not.toBeNull();
  });

  it("sending with no provider opens the provider picker", async () => {
    driver.press("Enter");
    await driver.wait_for({ selector: "id=model-picker", timeoutMs: 10_000 });
    const node = driver.query("id=model-picker");
    expect(node?.role).toBe("dialog");
  });
});
