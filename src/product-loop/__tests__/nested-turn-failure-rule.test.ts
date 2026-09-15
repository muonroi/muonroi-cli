/**
 * nested-turn-failure-rule.test.ts — "this nested turn failed" has exactly ONE
 * definition, and both kinds of consumer read it.
 *
 * `forwardNestedTurn` FORWARDS a nested stream upward; the two verify agents
 * (`product-loop/sprint-runner.buildVerifyAgent`,
 * `maintain/task-runner.buildVerifyAgent`) COLLECT it into a payload instead.
 * The collecting shape was written with its own loop that kept only `content`
 * chunks, so it had no failure rule at all and reported `{success:true}` over a
 * turn the watchdog had killed. A second, hand-written copy of the rule would
 * drift the same way, so the rule lives in one place and both helpers share it.
 *
 * These cases pin that the two helpers agree, chunk-script for chunk-script.
 */

import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { collectNestedTurn, forwardNestedTurn } from "../nested-turn.js";

const WATCHDOG_ERROR = {
  type: "error",
  content: "Turn ended by watchdog: assistant turn produced no output for 120s — treated as hung",
} as unknown as StreamChunk;
const DONE = { type: "done" } as unknown as StreamChunk;
const text = (s: string) => ({ type: "content", content: s }) as unknown as StreamChunk;

function scripted(chunks: StreamChunk[]): AsyncGenerator<StreamChunk, void, unknown> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

async function viaForward(chunks: StreamChunk[]): Promise<{ output: string; failure: string | null }> {
  let output = "";
  const gen = forwardNestedTurn(scripted(chunks));
  let step = await gen.next();
  while (!step.done) {
    const c = step.value;
    if (c.type === "content" && typeof c.content === "string") output += c.content;
    step = await gen.next();
  }
  return { output, failure: step.value.failure };
}

/** Each case: the nested turn's chunk script, and whether it counts as failed. */
const CASES: Array<{ name: string; script: StreamChunk[]; failed: boolean }> = [
  { name: "normal completion (content, done)", script: [text("a"), DONE], failed: false },
  { name: "watchdog kill (content, error, done)", script: [text("a"), WATCHDOG_ERROR, DONE], failed: true },
  { name: "error as the very last chunk, no done", script: [text("a"), WATCHDOG_ERROR], failed: true },
  { name: "error only, then done", script: [WATCHDOG_ERROR, DONE], failed: true },
  { name: "recovered error (error, content, done)", script: [WATCHDOG_ERROR, text("b"), DONE], failed: false },
  { name: "recovered error, stream just ends after content", script: [WATCHDOG_ERROR, text("b")], failed: false },
  { name: "empty stream", script: [], failed: false },
];

describe("nested-turn — one failure rule, shared by the forwarding and collecting consumers", () => {
  for (const c of CASES) {
    it(`${c.name} → failed=${c.failed}, same for both helpers`, async () => {
      const collected = await collectNestedTurn(scripted(c.script));
      const forwarded = await viaForward(c.script);

      expect(collected.failure !== null).toBe(c.failed);
      expect(forwarded.failure !== null).toBe(c.failed);
      // Same verdict AND same text — one rule, not two that happen to agree.
      expect(collected.failure).toBe(forwarded.failure);
      // Both see the same user-visible text; `done`/`error` never land in it.
      expect(collected.output).toBe(forwarded.output);
    });
  }

  it("carries the failure's own message, so the caller can say WHY", async () => {
    const collected = await collectNestedTurn(scripted([text("a"), WATCHDOG_ERROR, DONE]));
    expect(collected.failure).toContain("Turn ended by watchdog");
  });

  it("an error chunk with no message still counts as a failure", async () => {
    const bare = { type: "error" } as unknown as StreamChunk;
    const collected = await collectNestedTurn(scripted([bare, DONE]));
    expect(collected.failure).toBe("nested turn ended with an error chunk that carried no message");
  });

  it("collects only `content` text — `done` and `error` chunks never reach the payload", async () => {
    const collected = await collectNestedTurn(scripted([text("one "), WATCHDOG_ERROR, text("two"), DONE]));
    expect(collected.output).toBe("one two");
  });

  it("a throw from the nested generator propagates — the caller's finally still runs", async () => {
    const boom = new Error("stream died mid-turn");
    const gen = (async function* () {
      yield text("a");
      throw boom;
    })();
    await expect(collectNestedTurn(gen)).rejects.toThrow("stream died mid-turn");
  });
});
