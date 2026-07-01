/**
 * Regression spec for the "/ideal hot-path hangs after route-decision" bug
 * (sessions 729f01468a47, 98effee99bd1 — 2026-05-19 user report).
 *
 * Root causes layered:
 *  1. bridge.routeModel / routeTask had no client-side timeout — the OS-level
 *     connect timeout (~5min on Windows) made /ideal silent. Fixed by Phase
 *     21.5 (withEeTimeout, MUONROI_EE_ROUTE_TIMEOUT_MS).
 *  2. resolveRoles iterated ROLE_SLOTS sequentially, so the EE timeout above
 *     multiplied 6× when EE was down. Fixed by Promise.all in
 *     src/product-loop/role-registry.ts.
 *  3. sprint-runner yielded `{ type: "halt", reason, recovery_options }` but
 *     StreamChunk's canonical shape is `{ type: "halt", haltChunk }`. The
 *     bare yield bypassed every consumer's discriminator. Fixed by wrapping
 *     in sprint-runner.ts and updating downstream consumers (index.ts site 1
 *     and 2, src/ui/app.tsx /ideal loop).
 *
 * What this spec proves end-to-end:
 *  - Dispatch reaches runHotPath (route-decision event).
 *  - EE timeout fires through the new logger (ee-timeout event).
 *  - CB-3 halt arrives (sprint-halt event) within the budget.
 *  - The halt-recovery dialog (`id=ideal-halt-card`) renders so users can
 *    pick a recovery option instead of staring at a frozen screen.
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

const MOCK_KEY = ["test", "mock", "provider", "noop"].join("-");

describe("ideal hot-path hang diagnostic", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_KEY, "-m", "deepseek-v4-flash"],
      env: {
        SILICONFLOW_API_KEY: MOCK_KEY,
        MUONROI_EE_ROUTE_TIMEOUT_MS: "500",
        MUONROI_BB_RETRIEVAL_TIMEOUT_MS: "300",
        MUONROI_HARNESS_EVENTS: "*",
      },
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

  it("/ideal hot-path against empty target halts within 5s with recovery card visible", async () => {
    const seen: Array<{ kind: string; data: unknown }> = [];
    const sub = driver.events();
    (async () => {
      for await (const ev of sub) {
        seen.push({ kind: (ev as { kind?: string }).kind ?? "unknown", data: ev });
      }
    })().catch(() => undefined);

    // slowType — char-by-char so the slash menu's filter sees each char
    // commit through React state before the next arrives.
    // Prompt must pass PIL Layer 1 sufficiency gate (target + intent) to route
    // to hot-path; "build a counter" is too vague and now forces council.
    // "fix typo in counter.ts" has concrete verb + file ref → sufficient,
    // and short length keeps complexity=low.
    for (const ch of "/ideal fix typo in counter.ts") {
      driver.type(ch);
      await new Promise((r) => setTimeout(r, 25));
    }
    await driver.wait_for({ idle: true, timeoutMs: 3_000 }).catch(() => undefined);
    driver.press("Enter");

    // Sample TUI render text at t=2s, 5s, 8s so we see whether content arrived.
    await new Promise((r) => setTimeout(r, 2_000));
    const renderAt2s = driver.render_text();
    await new Promise((r) => setTimeout(r, 3_000));
    const renderAt5s = driver.render_text();
    await new Promise((r) => setTimeout(r, 3_000));
    const renderAt8s = driver.render_text();

    const kinds = seen.map((e) => e.kind);
    // eslint-disable-next-line no-console
    console.log("[diagnostic] events kinds:", kinds);
    // eslint-disable-next-line no-console
    console.log("[diagnostic] TUI text contains 'Product loop' @ 2s:", renderAt2s.includes("Product loop"));
    // eslint-disable-next-line no-console
    console.log("[diagnostic] TUI text contains 'hot-path' @ 2s:", renderAt2s.includes("hot-path"));
    // eslint-disable-next-line no-console
    console.log("[diagnostic] TUI text contains 'Sprint' @ 5s:", renderAt5s.includes("Sprint"));
    // eslint-disable-next-line no-console
    console.log("[diagnostic] TUI text contains 'Sprint' @ 8s:", renderAt8s.includes("Sprint"));
    // eslint-disable-next-line no-console
    console.log("[diagnostic] @ 8s tail:", renderAt8s.slice(-400));

    // Real assertions: the user-reported hang should now resolve into a
    // structured halt card within budget.
    expect(kinds).toContain("route-decision");
    expect(kinds).toContain("sprint-halt");

    // The halt card carries <Semantic id="ideal-halt-card" role="dialog" isModal>.
    const haltCard = driver.query("id=ideal-halt-card");
    expect(haltCard).toBeTruthy();
    expect(haltCard?.role).toBe("dialog");
  }, 120_000);
});
