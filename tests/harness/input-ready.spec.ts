/**
 * input-ready.spec.ts
 *
 * Regression cover for the pre-mount input drop.
 *
 * The agent-mode transport starts reading JSONL commands ~120 ms after process
 * start — and on Windows the handshake that unblocks the PARENT is written
 * before that, so from the driver's point of view the child is "up". But the
 * only consumer of those commands, the React input bridge
 * (`packages/agent-harness-opentui/src/input-bridge.tsx`), registers from a
 * `useEffect` and so does not exist until the app mounts. Measured on this
 * branch across 3 runs:
 *
 *   in-stream listening   t=116-118 ms
 *   onCommand registered  t=562-860 ms
 *
 * Inside that 445-745 ms window `for (const h of commandHandlers) h(cmd)`
 * iterated an EMPTY array. The command vanished with no queue, no error, no
 * event, and no signal back to the driver — which went on believing it had
 * landed. Three separate symptoms traced to it: a hand-driven `/ideal` that
 * produced zero events for 5 minutes, `visual-capture.spec.ts`, and
 * `session-picker.spec.ts`.
 *
 * This spec sends input in exactly that window — no `idle` wait, no selector
 * wait, the very first thing after spawn — and asserts it lands.
 */

import { describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

const MARKER = "premountmarker";

describe("pre-mount input is buffered, not discarded", () => {
  it("delivers a type() sent immediately after spawn, and announces readiness", async () => {
    const ctx = await spawnHarness({});
    try {
      // Deliberately NO wait of any kind first. spawnHarness resolves as soon
      // as the transport handshake completes, which is squarely inside the
      // drop window.
      ctx.driver.type(MARKER);

      // The readiness signal itself. `event` conditions are replay-safe (the
      // driver scans its buffered ring), so this resolves whether the event
      // arrived before or after this call.
      const res = await ctx.driver.wait_for({ event: "input-ready", timeoutMs: 90_000 });
      const ev = (res as { event?: Record<string, unknown> } | undefined)?.event;
      expect(ev, "wait_for({event:'input-ready'}) must carry the matched event inline").toBeTruthy();

      // The payload must survive redaction — a bare {t, kind} would announce
      // readiness while hiding whether input was lost getting there.
      expect(typeof ev?.flushed, `flushed missing from payload: ${JSON.stringify(ev)}`).toBe("number");
      expect(typeof ev?.dropped, `dropped missing from payload: ${JSON.stringify(ev)}`).toBe("number");
      // The command above was sent before the bridge existed, so it MUST have
      // been buffered. flushed === 0 means it was dispatched live, i.e. this
      // spec no longer exercises the window it was written for.
      expect(ev?.flushed, "the pre-mount type() should have been buffered and replayed").toBeGreaterThanOrEqual(1);
      expect(ev?.dropped, "nothing should overflow a 256-slot buffer for one command").toBe(0);

      // And the text must actually be in the composer. The composer mirrors its
      // plainText onto the semantic node's `value` (src/ui/components/prompt-box.tsx).
      // Poll: the replay happens inside the bridge's registering effect, and the
      // resulting textarea state reaches a frame on the next render pass.
      let value = "";
      for (let i = 0; i < 100; i++) {
        value = ctx.driver.query("id=composer")?.value ?? "";
        if (value.includes(MARKER)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(value, `composer value never carried the pre-mount text (got ${JSON.stringify(value)})`).toContain(
        MARKER,
      );
    } finally {
      ctx.cleanup();
      ctx.proc.kill();
    }
  }, 120_000);
});
