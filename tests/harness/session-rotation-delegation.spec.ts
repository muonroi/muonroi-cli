import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { spawnHarness } from "./helpers.js";

const requireSync = createRequire(import.meta.url);

/**
 * Contract pinned here (since b014c9b9 "harden native flow and scoped worker
 * orchestration"):
 *
 *   The TUI's main session runs with `executionRole: "orchestrator"` (the
 *   default in `Agent`'s constructor; src/index.ts never overrides it for the
 *   TUI or headless main). The orchestrator role NEVER consults the
 *   sub-session router (`classifySubSessionAction`), never router-forks a
 *   `SPAWN_SUB_SESSION` child and never silently rotates (`ROTATE_SESSION` /
 *   size threshold) — the gate is `this.executionRole === "orchestrator" || …`
 *   in Agent.processMessage, and it holds even with
 *   MUONROI_FORCE_ROUTING_CLASSIFY=1. Main delegates explicitly through its
 *   worker tools instead.
 *
 * This spec previously asserted the opposite (router fork + absorb, silent
 * rotation into a linked child) through the TUI. It was CI-quarantined
 * (describe.skipIf(CI): "2 tests | 2 skipped" in Harness Suite run
 * 41782565369 at b014c9b9), so it only ever failed locally — on every
 * platform, not just Windows. Measured on the instrumented run: the debug log
 * read "Skipping sub-session routing classification", the mock model saw
 * exactly one fixture round (`doStream #1`), and the router line the fixture
 * scripted for the classifier ("SPAWN_SUB_SESSION,0.98,…") landed verbatim as
 * main's own assistant reply in a single root session.
 *
 * The router/rotation MECHANICS (fork, link, absorb, rotate) are still covered
 * where they are reachable — a non-orchestrator role — by
 * src/orchestrator/__tests__/sub-session-delegation.test.ts and
 * src/orchestrator/__tests__/sub-session-realdb.test.ts (real SQLite,
 * `executionRole: "infrastructure"`).
 *
 * The fixture keeps the router line as round 0 on purpose: if main ever runs
 * the router again, the classifier consumes round 0, so the assertions below
 * (round 0 reaches main verbatim, exactly one fixture round consumed, one
 * unlinked session) all flip.
 */

type Row = Record<string, unknown>;

/**
 * Block until the DB satisfies `ready` — the positive postcondition the test
 * goes on to assert. `wait_for({idle:true})` cannot express "the turn
 * finished" (idle can fire before the turn produces a single frame).
 * Messages commit live (`appendMessages` → `withTransaction`), so the row is
 * visible the moment it lands.
 */
async function waitForDb(dbPath: string, what: string, ready: (db: any) => boolean, timeoutMs: number): Promise<void> {
  const BetterSqlite3 = requireSync("better-sqlite3");
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (existsSync(dbPath)) {
      let db: any;
      try {
        db = new BetterSqlite3(dbPath, { readonly: true });
        if (ready(db)) return;
      } catch (err) {
        // Expected while the child is mid-write (locked / half-created schema);
        // only the final timeout message is a real failure.
        lastErr = err instanceof Error ? err.message : String(err);
      } finally {
        try {
          db?.close();
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${lastErr ? ` (last DB error: ${lastErr})` : ""}`);
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Ask the TUI to /exit, falling back to kill — and in BOTH cases wait until
 * the child is actually dead before the caller opens the DB. On Windows the
 * child's open handles keep the WAL locked until the process is gone: opening
 * the DB right after `proc.kill()` (without awaiting 'exit') failed with
 * SQLITE_IOERR_TRUNCATE "disk I/O error", and succeeded once the exit landed.
 * POSIX locks are advisory, which is why the old "kill and read immediately"
 * teardown never showed this on Linux.
 */
async function stopChild(proc: ChildProcess, driver: Driver): Promise<void> {
  driver.type("/exit");
  driver.press("Enter");
  if (await waitForExit(proc, 5_000)) return;
  proc.kill();
  if (await waitForExit(proc, 15_000)) return;
  throw new Error(`child pid=${proc.pid} still alive 15s after kill — DB handles not released`);
}

function textStopRound(id: string, delta: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta },
    { type: "text-end", id },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    },
  ];
}

function assistantText(messageJson: unknown): string {
  const content = (JSON.parse(String(messageJson)) as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? c?.content ?? "").join("");
  return "";
}

type MainTurnResult = {
  sessions: Row[];
  messages: Row[];
  /** `[mock-model] doStream #N` lines — fixture rounds actually consumed. */
  fixtureRoundsConsumed: number;
};

/**
 * Drive ONE main-session turn in the TUI with the router forced on
 * (MUONROI_FORCE_ROUTING_CLASSIFY=1) and a fixture whose round 0 is the
 * router line and round 1 is what a forked/rotated child would answer.
 * Returns the final DB state after a graceful /exit.
 */
async function runMainTurn(workDir: string, tag: string, prompt: string, rounds: unknown[][]): Promise<MainTurnResult> {
  const fixDir = join(workDir, `fix-${tag}`);
  const homeDir = join(workDir, `home-${tag}`);
  mkdirSync(fixDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({ model: { provider: "mock", modelId: "mock-deepseek", stream: rounds } }),
    "utf8",
  );
  const dbPath = join(homeDir, ".muonroi-cli", "muonroi.db");
  const round0Text = String((rounds[0]![2] as { delta: string }).delta);

  const ctx = await spawnHarness({
    fixturesDir: fixDir,
    cwd: homeDir,
    env: {
      MUONROI_FORCE_ROUTING_CLASSIFY: "1",
      MUONROI_NO_SHELL_HOLD: "1",
      // EE unreachable: no EE-informed variance / network latency in the turn.
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      // Makes the mock print one `doStream #N` line per fixture round consumed.
      MUONROI_DEBUG_MOCK_MODEL: "1",
    },
  });
  let stderr = "";
  ctx.proc.stderr?.on("data", (d: Buffer | string) => {
    stderr += d.toString();
  });

  try {
    await ctx.driver.wait_for({ idle: true, timeoutMs: 60_000 });
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });

    ctx.driver.type(prompt);
    ctx.driver.press("Enter");

    // Positive postcondition first, so the absence assertions that follow can
    // never pass vacuously on a turn that simply did not run.
    await waitForDb(
      dbPath,
      "main's assistant reply to land",
      (db) =>
        (db.prepare("SELECT message_json FROM messages WHERE role = 'assistant'").all() as Row[]).some((r) =>
          assistantText(r.message_json).includes(round0Text),
        ),
      60_000,
    );

    await stopChild(ctx.proc, ctx.driver);

    expect(existsSync(dbPath)).toBe(true);
    const BetterSqlite3 = requireSync("better-sqlite3");
    const db = new BetterSqlite3(dbPath);
    try {
      return {
        sessions: db.prepare("SELECT id, parent_session_id FROM sessions").all() as Row[],
        messages: db
          .prepare("SELECT session_id, role, message_json FROM messages ORDER BY session_id, seq")
          .all() as Row[],
        fixtureRoundsConsumed: (stderr.match(/\[mock-model\] doStream #\d+/g) ?? []).length,
      };
    } finally {
      db.close();
    }
  } finally {
    ctx.cleanup();
  }
}

// CI-quarantined (runs locally + pre-push, skipped only on CI) — kept from the
// router-fork version of this spec, whose heavy classifier → fork → absorb flow
// timed out on the shared 2-core runner. describe.skipIf is exempt from
// lint:harness-skips (env guard, not coverage).
describe.skipIf(!!process.env.CI)(
  "E2E Harness - main (orchestrator) session never router-forks or silently rotates",
  () => {
    let workDir: string;

    beforeAll(() => {
      workDir = mkdtempSync(join(tmpdir(), "muonroi-sd-"));
    });

    afterAll(() => {
      bestEffortRemoveSync(workDir, "tests/harness/session-rotation-delegation.spec.ts");
    });

    it("does not consult the router or fork a SPAWN_SUB_SESSION child: main answers in its own single session", async () => {
      const routerLine = "SPAWN_SUB_SESSION,0.98,complex task that needs tool usage";
      const childAnswer = "Result Summary: completed task successfully.";
      const r = await runMainTurn(workDir, "spawn", "create verification script", [
        textStopRound("t1", routerLine),
        textStopRound(
          "t2",
          `Key Changes: created verification script\nVerification Details: run verified\n${childAnswer}`,
        ),
      ]);

      // The router was never called: the round scripted for it was the ONLY
      // fixture round consumed, and it reached main verbatim as main's reply.
      expect(r.fixtureRoundsConsumed).toBe(1);
      expect(r.sessions).toHaveLength(1);
      const root = r.sessions[0]!;
      expect(root.parent_session_id, "main must not be linked under any parent").toBeNull();
      const mainAssistant = r.messages.filter((m) => m.session_id === root.id && m.role === "assistant");
      expect(mainAssistant).toHaveLength(1);
      expect(assistantText(mainAssistant[0]!.message_json)).toBe(routerLine);
      // No child ran, so nothing a child would have produced was absorbed.
      expect(r.messages.some((m) => String(m.message_json).includes(childAnswer))).toBe(false);
    }, 150_000);

    it("does not silently rotate on ROTATE_SESSION: no rotation child, no rotation notice, one session", async () => {
      const routerLine = "ROTATE_SESSION,0.95,user switches topic";
      const rotatedAnswer = "Switched session details.";
      const r = await runMainTurn(workDir, "rotate", "switch to a different topic", [
        textStopRound("t1", routerLine),
        textStopRound("t2", rotatedAnswer),
      ]);

      expect(r.fixtureRoundsConsumed).toBe(1);
      expect(r.sessions).toHaveLength(1);
      const root = r.sessions[0]!;
      expect(root.parent_session_id, "main must not be linked under any parent").toBeNull();
      const mainAssistant = r.messages.filter((m) => m.session_id === root.id && m.role === "assistant");
      expect(mainAssistant).toHaveLength(1);
      expect(assistantText(mainAssistant[0]!.message_json)).toBe(routerLine);
      // The rotation path yields a "Xoay vòng session ngầm" notice and runs the
      // turn in the rotated child; neither may appear.
      expect(r.messages.some((m) => String(m.message_json).includes("Xoay vòng session ngầm"))).toBe(false);
      expect(r.messages.some((m) => String(m.message_json).includes(rotatedAnswer))).toBe(false);
    }, 150_000);
  },
);
