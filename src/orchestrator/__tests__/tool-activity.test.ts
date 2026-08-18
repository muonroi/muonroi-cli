import { afterEach, describe, expect, it } from "vitest";
import {
  __resetToolActivityForTests,
  beginToolActivity,
  endToolActivity,
  isToolActivityLive,
  toolActivityBudgetMs,
} from "../tool-activity.js";

/**
 * Session 708f0fc4ac8b @04:19:38 — the agent ran `bun test` through the bash
 * tool with `timeout: 120000`. The full suite takes ~315s, so the turn yielded
 * no chunk while it ran. `MUONROI_TURN_IDLE_MS` also defaults to 120_000, so at
 * 04:21:38.106 — exactly 120s later — the top-level turn watchdog fired:
 *
 *   [WARN] Top-level turn watchdog fired — finalizing turn
 *   {"kind":"idle","message":"assistant turn produced no output for 120s — treated as hung"}
 *
 * A healthy turn was killed as hung, and 283 ms later the parent absorbed a
 * stale answer. The watchdog must defer to a tool's OWN deadline while that tool
 * is still inside it — but keep guarding once the tool overruns, since catching
 * a wedged tool is the reason the watchdog exists.
 */
describe("tool activity registry", () => {
  afterEach(() => {
    __resetToolActivityForTests();
  });

  it("suppresses the watchdog while a tool is inside its declared deadline", () => {
    const t0 = 1_000_000;
    beginToolActivity(120_000, t0);

    expect(isToolActivityLive(t0 + 119_000)).toBe(true);
  });

  it("lets the tool's own timeout win the race against an equal turn-idle window", () => {
    const t0 = 1_000_000;
    beginToolActivity(120_000, t0);

    // The exact tie observed live: bash timeout 120_000 vs turn idle 120_000.
    expect(isToolActivityLive(t0 + 120_000)).toBe(true);
  });

  it("stops suppressing once the tool overruns its own deadline (wedged tool still caught)", () => {
    const t0 = 1_000_000;
    beginToolActivity(120_000, t0);

    expect(isToolActivityLive(t0 + 120_000 + toolActivityBudgetMs().graceMs + 1)).toBe(false);
  });

  it("stops suppressing as soon as the tool finishes", () => {
    const t0 = 1_000_000;
    const id = beginToolActivity(120_000, t0);
    endToolActivity(id);

    expect(isToolActivityLive(t0 + 1)).toBe(false);
  });

  it("suppresses while ANY parallel tool call is still live", () => {
    const t0 = 1_000_000;
    const quick = beginToolActivity(1_000, t0);
    beginToolActivity(120_000, t0);
    endToolActivity(quick);

    expect(isToolActivityLive(t0 + 60_000)).toBe(true);
  });

  it("applies the default ceiling to a tool that declares no deadline", () => {
    const t0 = 1_000_000;
    const { defaultMs, graceMs } = toolActivityBudgetMs();
    beginToolActivity(null, t0);

    expect(isToolActivityLive(t0 + defaultMs)).toBe(true);
    expect(isToolActivityLive(t0 + defaultMs + graceMs + 1)).toBe(false);
  });

  it("is inert when no tool is running", () => {
    expect(isToolActivityLive(Date.now())).toBe(false);
  });
});
