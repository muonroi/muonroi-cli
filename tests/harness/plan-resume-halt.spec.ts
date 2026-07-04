/**
 * plan-resume-halt.spec.ts — E2E harness: user-halt (ESC) during plan creation,
 * then resume with bare "tiếp tục" / "continue" must NOT re-ask for plan details.
 *
 * Trigger: spawn with --inject-halt (synthetic halt card) + drive a /ideal flow
 * that surfaces plan text, then press Escape (user-halt), then type "tiếp tục".
 *
 * Fixture: tests/harness/fixtures/llm/plan-resume.json returns "APPROVED PLAN" text
 * on plan-like prompts and a continuation reply on "tiếp tục" that references prior
 * plan content (no re-ask).
 */
import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("plan creation → user-halt (ESC) → resume on 'tiếp tục'", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--inject-halt"],
      fixturesDir: "tests/harness/fixtures/llm/plan-resume",
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("select 'Continue as council brainstorm' from halt card", async () => {
    // Navigate to option 2 (continue_as_council) and enter to proceed into planning flow.
    driver.press("Down");
    driver.press("Down");
    driver.press("Return");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    const card = driver.query("id=ideal-halt-card");
    expect(card).toBeNull();
  });

  // QUARANTINED (obsolete flow): these two assert that a build/plan prompt
  // emits APPROVED PLAN chat text after the halt card. Since this spec was
  // written the PIL layer1 build-intent router (src/pil/layer1-intent.ts:1080,
  // isGreenfieldBuildTask) intercepts any create/build prompt and routes it to
  // a scaffolding dialog (#init-new-form / #point-to-existing-form) BEFORE any
  // LLM call — so the mock's APPROVED PLAN fixture never fires and no listitem
  // renders. The trigger is prompt-intent based (not cwd), so there is no env
  // bypass; the halt→"tiếp tục" resume-without-re-ask contract needs a rewrite
  // around the current scaffolding UX. Tracked in scripts/.harness-skips-allow.json.
  // Test 1 above (halt-card navigation) still runs and passes.
  it.skip("type a plan request and observe APPROVED PLAN emitted", async () => {
    driver.type("/ideal build a counter --force-council");
    driver.press("Return");
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    // The plan text should surface in log or status; we just assert we did not
    // immediately get a re-ask question.
    const items = driver.queryAll("role=listitem");
    const text = items.map((n) => n.name || "").join(" ");
    expect(text.length).toBeGreaterThan(0);
  }, 20_000);

  it.skip("user presses Escape (simulated halt) and then types 'tiếp tục'", async () => {
    // In this synthetic harness we simulate user-halt by pressing Escape
    // (real user ESC during plan would trigger discardAbortedTurn + [Interrupted]).
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });

    driver.type("tiếp tục");
    driver.press("Return");
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });

    // Continuation response from fixture must reference prior plan content
    // (e.g. "Tiếp tục thực hiện plan") and NOT re-ask for plan details.
    const items = driver.queryAll("role=listitem");
    const joined = items.map((n) => (n.name || "") + " " + (n.value || "")).join("\n");
    expect(joined).toMatch(/tiếp tục|continue|plan|counter/i);
    // Negative: must not contain typical re-ask language from early discovery.
    expect(joined.toLowerCase()).not.toMatch(/bạn muốn|muốn làm gì|chi tiết|detail|clarif/i);
  }, 25_000);
});
