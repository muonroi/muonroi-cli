/**
 * tests/harness/cost-leak-tui-smoke.spec.ts
 *
 * Phase F (pre-task): smallest possible smoke test that proves the TUI E2E
 * cost-leak harness path actually works end-to-end:
 *   1. Write a temp fixture dir with a `model` block.
 *   2. Spawn the TUI with --mock-llm <dir> + MUONROI_MOCK_MODEL_DUMP=<file>.
 *   3. Drive composer input as a real user (type + Enter).
 *   4. Wait for idle, kill child gracefully.
 *   5. loadDumpedRecordings(dumpPath) returns >= 1 InspectedCall.
 *
 * If this spec fails, the rest of the Phase F TUI specs cannot work. Fix the
 * wiring before writing any more E2E cost-leak coverage.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnHarness } from "./helpers.js";
import { loadDumpedRecordings } from "./recording.js";

function writeSmokeFixture(dir: string): void {
  // Minimal text-only stream matching StreamChunks shape (see mock-model.ts).
  const fixture = {
    model: {
      provider: "mock",
      modelId: "mock-smoke",
      stream: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hello" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
        },
      ],
    },
  };
  writeFileSync(join(dir, "smoke.json"), JSON.stringify(fixture), "utf8");
}

describe("cost-leak TUI smoke — fixture + dump path works end-to-end", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let workDir: string;
  let dumpPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-cl-smoke-"));
    const fixDir = join(workDir, "fix");
    require("node:fs").mkdirSync(fixDir);
    writeSmokeFixture(fixDir);
    dumpPath = join(workDir, "calls.json");

    // Pass an explicit -k + -m so the API-key modal does not grab focus on a
    // fresh clone (see CLAUDE.md "Known caveats" + composer.spec.ts).
    // Override --mock-llm to our temp fixture dir (NOT the default fixtures
    // path picked by spawnHarness).
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--mock-llm", fixDir],
      env: {
        MUONROI_MOCK_MODEL_DUMP: dumpPath,
        MUONROI_NO_SHELL_HOLD: "1",
      },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    // Capture stderr to help diagnose if streamText is never invoked.
    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[child] ${chunk.toString("utf8")}`);
    });

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    try {
      proc?.kill();
    } catch {
      // ignore
    }
    cleanup?.();
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("a user prompt drives at least one streamText call recorded in the dump", async () => {
    driver.type("hello");
    driver.press("Enter");

    // Wait for log to render (LLM round-trip completed) and for idle.
    await driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });

    // Give the orchestrator a chance to actually invoke streamText. The log
    // node appears as soon as the user message is echoed, well before the
    // model is hit. 3s is a generous floor on a fast text-only fixture.
    await new Promise((r) => setTimeout(r, 3000));

    // Diagnostic: dump the snapshot so we can see what's focused.
    process.stderr.write(`\n[debug] snapshot text:\n${driver.render_text()}\n[end debug]\n`);

    // Trigger graceful shutdown via /exit slash command — Windows ignores
    // signal handlers for child_process.kill(), so we use the in-band exit
    // path the TUI itself wires up (handleExit -> onExit -> process.exit).
    driver.type("/exit");
    driver.press("Enter");

    // Wait for the child to actually exit (gives the exit handler time to
    // run dumpRecordings synchronously). Generous timeout — clean exit may
    // take >5s due to shell-hold delays and bash.cleanup chains.
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null) {
        process.stderr.write(`[debug] proc.exitCode already set: ${proc.exitCode}\n`);
        resolve();
        return;
      }
      proc.once("exit", (code, signal) => {
        process.stderr.write(`[debug] proc exit event: code=${code} signal=${signal}\n`);
        resolve();
      });
      setTimeout(() => {
        process.stderr.write(`[debug] proc.kill fallback fired after 20s — /exit did not exit cleanly\n`);
        try {
          proc.kill();
        } catch {
          // ignore
        }
        resolve();
      }, 20_000);
    });

    // Poll for dump file (atomic rename means it appears all at once).
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && !existsSync(dumpPath)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(existsSync(dumpPath)).toBe(true);
    // Diagnostic: surface raw file size if loading fails.
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(dumpPath, "utf8");
    if (raw.trim() === "[]") {
      throw new Error(
        `Dump file is empty array — TUI exited without invoking streamText. Stderr might explain why. raw=${raw.slice(0, 200)}`,
      );
    }
    const loaded = loadDumpedRecordings(dumpPath);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    // Sanity: the prompt should appear in user-text of the first call.
    expect(loaded[0]?.userText.length).toBeGreaterThan(0);
  }, 60_000);
});
