import { afterEach, describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import {
  __resetInteractivePauseForTests,
  beginBoundedWorkerWait,
  endBoundedWorkerWait,
  isInteractivePaused,
} from "../interactive-pause.js";
import { withTurnWatchdog } from "../turn-watchdog.js";

afterEach(() => __resetInteractivePauseForTests());
describe("bounded worker waits preserve original hard turn budget", () => {
  it("suppresses idle detection but expires the original total deadline without a budget reset", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    async function* source(): AsyncGenerator<StreamChunk, void, unknown> {
      await ready;
      yield { type: "done" };
    }
    beginBoundedWorkerWait();
    const fallback = setTimeout(release, 300);
    try {
      const drain = (async () => {
        for await (const _ of withTurnWatchdog(source(), {
          idleMs: 10,
          totalMs: 80,
          label: "Bounded message wait",
          shouldSuppressFire: isInteractivePaused,
        })) {
          /*drain*/
        }
      })();
      await expect(drain).rejects.toMatchObject({ kind: "total" });
      expect(isInteractivePaused()).toBe(true);
    } finally {
      clearTimeout(fallback);
      release();
      endBoundedWorkerWait();
    }
    expect(isInteractivePaused()).toBe(false);
  });
});
