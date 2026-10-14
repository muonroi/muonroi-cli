import { afterEach, describe, expect, it } from "vitest";
import {
  __resetToolActivityForTests,
  beginToolActivity,
  endToolActivity,
  isToolActivityLive,
  noteToolActivityProgress,
  toolActivityBudgetMs,
  withToolActivity,
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

  it("does not let another request's tool suppress an idle provider", () => {
    const foreign = beginToolActivity(120_000, 1000);
    expect(isToolActivityLive(2000, new Set())).toBe(false);
    expect(isToolActivityLive(2000, new Set([foreign]))).toBe(true);
  });

  it("renews only the owning council idle budget on actual nested progress", async () => {
    const t0 = 1_000_000;
    const { defaultMs, graceMs } = toolActivityBudgetMs();
    const owner = beginToolActivity(null, t0);
    const foreign = beginToolActivity(null, t0);
    await withToolActivity(owner, async () => {
      await Promise.resolve();
      noteToolActivityProgress(t0 + defaultMs - 1);
    });
    const afterInitialBudget = t0 + defaultMs + graceMs + 1;
    expect(isToolActivityLive(afterInitialBudget, new Set([owner]))).toBe(true);
    expect(isToolActivityLive(afterInitialBudget, new Set([foreign]))).toBe(false);
    expect(isToolActivityLive(t0 + 2 * defaultMs + graceMs, new Set([owner]))).toBe(false);
  });

  it("never renews an explicit command deadline or revives expired work", () => {
    const t0 = 1_000_000;
    const explicit = beginToolActivity(1000, t0);
    withToolActivity(explicit, () => noteToolActivityProgress(t0 + 900));
    expect(isToolActivityLive(t0 + 1000 + toolActivityBudgetMs().graceMs + 1, new Set([explicit]))).toBe(false);
    const expired = beginToolActivity(null, t0);
    const later = t0 + toolActivityBudgetMs().defaultMs + toolActivityBudgetMs().graceMs + 1;
    withToolActivity(expired, () => noteToolActivityProgress(later));
    expect(isToolActivityLive(later, new Set([expired]))).toBe(false);
  });
});
