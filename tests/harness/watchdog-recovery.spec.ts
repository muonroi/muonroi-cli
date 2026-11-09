/**
 * tests/harness/watchdog-recovery.spec.ts
 *
 * After the top-level turn watchdog kills a stalled turn the TUI must return to
 * idle and keep accepting input. Live evidence (session 7f24048ad75d,
 * 2026-11-09): `error/watchdog {"kind":"idle","lastPhase":"mainStream.provider"}`
 * at 04:17:28Z, then NO turn was ever recorded again although the harness runner
 * typed a prompt + Enter 21 times; the first of those was typed 27s BEFORE the
 * kill, while the stalled turn was still in flight.
 *
 * Two promises are pinned here:
 *   1. a message typed DURING the stall is delivered after the kill (or visibly
 *      rejected) — never silently dropped;
 *   2. a message typed AFTER the kill starts a normal turn.
 *
 * The stall is the mock model's `{type:"stall"}` part (src/agent-harness/
 * mock-model.ts): the provider accepts the request and sends nothing. The idle
 * watchdog is shortened with MUONROI_TURN_IDLE_MS. The live hang was a LATER
 * step of the turn, issued right after a tool result, so both shapes run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type CostLeakHarness, makeTextStream, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const STALL = [{ type: "stall", stallMs: 600_000 }, ...makeTextStream("STALLED_ROUND_NEVER_SHOWN")];

function readFileRound(callId: string, filePath: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: callId, toolName: "read_file", input: JSON.stringify({ file_path: filePath }) },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
}

describe.each([
  { name: "stall on the first request", head: [] as unknown[][] },
  { name: "stall after a tool result", head: [readFileRound("call-read-1", "notes.txt")] },
])("watchdog recovery ($name)", ({ head }) => {
  let handle: CostLeakHarness | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  async function start(tail: unknown[][]): Promise<CostLeakHarness> {
    handle = await spawnCostLeakHarness(
      { provider: "deepseek", modelId: "deepseek-v4-flash", stream: [...head, STALL, ...tail] },
      {
        permission: "auto-edit",
        isolatedCwd: true,
        projectFiles: { "notes.txt": "hello\n" },
        env: { MUONROI_TURN_IDLE_MS: "3000" },
      },
    );
    return handle;
  }

  async function submitAndStall(h: CostLeakHarness): Promise<void> {
    h.driver.type("first message");
    h.driver.press("Enter");
    const inFlight = await until(() => h.driver.render_visual().includes("Queue a follow-up"), 15_000);
    expect(inFlight, `turn never started — ${h.driver.render_text()}`).toBe(true);
  }

  async function typeAndSubmit(h: CostLeakHarness, message: string): Promise<void> {
    h.driver.type(message);
    await until(() => (h.driver.query("id=composer")?.value ?? "") === message, 5_000);
    h.driver.press("Enter");
  }

  it("accepts a message typed after the kill", async () => {
    const h = await start([makeTextStream("POST_KILL_MESSAGE_ANSWERED")]);
    const text = () => h.driver.render_text();
    await submitAndStall(h);
    const killed = await until(() => text().includes("Turn ended by watchdog"), 40_000);
    expect(killed, `watchdog never ended the turn — ${text()}`).toBe(true);
    const idle = await until(() => !h.driver.render_visual().includes("Queue a follow-up"), 30_000);
    expect(idle, `TUI never returned to idle after the watchdog kill — ${text()}`).toBe(true);

    await typeAndSubmit(h, "after the kill");
    const answered = await until(() => text().includes("POST_KILL_MESSAGE_ANSWERED"), 30_000);
    expect(answered, `input after the watchdog kill started no turn — ${text()}`).toBe(true);
  }, 180_000);

  it("delivers a message typed during the stall", async () => {
    const h = await start([makeTextStream("QUEUED_MESSAGE_ANSWERED")]);
    const text = () => h.driver.render_text();
    await submitAndStall(h);
    // Typed while the stalled turn is still in flight.
    await typeAndSubmit(h, "typed during the stall");
    const killed = await until(() => text().includes("Turn ended by watchdog"), 40_000);
    expect(killed, `watchdog never ended the turn — ${text()}`).toBe(true);
    const delivered = await until(() => text().includes("QUEUED_MESSAGE_ANSWERED"), 30_000);
    expect(delivered, `message typed during the stall was dropped — ${text()}`).toBe(true);
  }, 180_000);
});
