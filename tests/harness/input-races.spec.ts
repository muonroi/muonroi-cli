/**
 * tests/harness/input-races.spec.ts
 *
 * Input delivery after the transcript grows and after a model turn.
 *
 *   1. Many `/help` outputs in a row overflow the transcript; the next
 *      command's Enter must still submit. Before the fix the child's main
 *      thread blocked inside OpenTUI's native stdout write (the harness never
 *      drained the child's stdout pipe), so after ~4 full-screen repaints no key
 *      reached it at all — see `drainRenderOutput` in src/agent-harness/test-spawn.ts.
 *   2. The composer's semantic `value` must mirror typed text after a model
 *      turn, not only before the first one. It was read off the textarea at
 *      render time and nothing re-rendered PromptBox after the turn, so it sat
 *      at "" — see the `onContentChange` bump in src/ui/components/prompt-box.tsx.
 *
 * Every wait is gated on a real condition (transcript entry count, composer
 * value, log overflow geometry) — never on a sleep.
 */
import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CostLeakHarness, makeTextStream, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { spawnHarness } from "./helpers.js";

const TRANSCRIPT_ENTRY = 'id*="^msg-\\d+$"';

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

function composerValue(driver: Driver): string {
  return driver.query("id=composer")?.value ?? "";
}

/** Failure evidence: what the tree looked like when a wait gave up. */
function describeTree(driver: Driver): string {
  const entries = driver.queryAll(TRANSCRIPT_ENTRY).map((n) => `${n.id}:${(n.name ?? "").slice(0, 40)}`);
  return `composer="${composerValue(driver)}" focus=${JSON.stringify(driver.queryAll("focus").map((n) => n.id))} log=${JSON.stringify(driver.query("id=log")?.props)} entries=${JSON.stringify(entries)}`;
}

/** Type, wait until the composer mirrors it, press Enter, wait for the transcript to grow. */
async function submit(driver: Driver, text: string, label: string): Promise<void> {
  const before = driver.count(TRANSCRIPT_ENTRY);
  driver.type(text);
  const mirrored = await until(() => composerValue(driver) === text, 5_000);
  expect(mirrored, `${label}: composer never mirrored "${text}" — ${describeTree(driver)}`).toBe(true);
  driver.press("Enter");
  const grew = await until(() => driver.count(TRANSCRIPT_ENTRY) > before, 10_000);
  expect(grew, `${label}: Enter did not submit (entries stayed ${before}) — ${describeTree(driver)}`).toBe(true);
}

describe("input races: Enter after the transcript overflows", { retry: 0 }, () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
      env: { MUONROI_HARNESS_SCROLL_GEOM: "1" },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("Enter still submits after many /help outputs overflow the transcript", async () => {
    for (let i = 1; i <= 8; i++) await submit(driver, "/help", `/help #${i}`);
    // The precondition the report is about: the transcript really overflows.
    await driver.wait_for({ selector: "id=log props.overflows=true", timeoutMs: 15_000 });
    await submit(driver, "/help", "/help after overflow");
  }, 180_000);
});

describe("input races: composer value after a model turn", { retry: 0 }, () => {
  const FINAL = "INPUT_RACES_TURN_DONE";
  let handle: CostLeakHarness | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("composer value mirrors typed text after a model turn", async () => {
    handle = await spawnCostLeakHarness(
      { provider: "deepseek", modelId: "deepseek-v4-flash", stream: [makeTextStream(FINAL)] },
      { permission: "auto-edit", isolatedCwd: true },
    );
    const { driver } = handle;
    await submit(driver, "reply with the marker", "turn 1");
    const answered = await until(() => driver.render_text().includes(FINAL), 30_000);
    expect(answered, `model answer never rendered — ${describeTree(driver)}`).toBe(true);
    // Let the turn end (the composer stops offering to queue a follow-up) so no
    // turn-end render can refresh the mirror for us.
    const ended = await until(() => !driver.render_visual().includes("Queue a follow-up"), 30_000);
    expect(ended, `turn never ended — ${describeTree(driver)}`).toBe(true);

    driver.type("after turn");
    const mirrored = await until(() => composerValue(driver) === "after turn", 5_000);
    expect(mirrored, `composer value after a model turn — ${describeTree(driver)}`).toBe(true);
  }, 120_000);
});
