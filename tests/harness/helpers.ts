/**
 * helpers.ts — Shared test utilities for harness E2E specs.
 *
 * Wraps spawnAgentTui to wire the driver's frame/idle/event ingestion in one place,
 * returning a ready-to-use driver. Callers only need to call cleanup in afterAll.
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDriver, type Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { type SpawnResult, spawnAgentTui } from "../../src/agent-harness/test-spawn.js";

export type HarnessContext = {
  proc: ChildProcess;
  driver: Driver;
  cleanup: () => void;
};

export type SpawnHarnessOptions = {
  /** Extra CLI args inserted after the entry point and --agent-mode. */
  extraArgs?: string[];
  /** Extra env vars forwarded to the child. Merged with process.env. */
  env?: Record<string, string>;
  /** Timeout for the initial wait_for({idle}) call. Default: 15 000 ms. */
  idleTimeoutMs?: number;
  /** Handshake timeout for the named-pipe transport (Windows). Default: 5 000 ms. */
  handshakeTimeoutMs?: number;
  /**
   * Override the mock-llm fixtures directory. Defaults to the shared
   * `tests/harness/fixtures/llm`. Council/ideal specs pass a dedicated dir so
   * their tailored model fixture (DebatePlan via `generate`, etc.) does not
   * perturb the shared cost-leak fixtures.
   */
  fixturesDir?: string;
  /**
   * Working directory for the spawned child. Defaults to the repo root.
   * Council/ideal E2E specs pass a fresh greenfield temp dir so the discover
   * phase does not scan the real (large) repo — that scan is the dominant,
   * variable cost that made the council E2E flaky.
   */
  cwd?: string;
};

const DEFAULT_FIXTURES = resolve("tests/harness/fixtures/llm");
const ENTRY = resolve("src/index.ts");

/**
 * Spawn the agent-mode TUI and wire the driver.
 * Does NOT call wait_for — callers decide when the TUI is ready.
 */
export async function spawnHarness(opts: SpawnHarnessOptions = {}): Promise<HarnessContext> {
  const fixtures = opts.fixturesDir ?? DEFAULT_FIXTURES;
  const args = [ENTRY, "--agent-mode", "--mock-llm", fixtures, ...(opts.extraArgs ?? [])];

  let tempHome: string | undefined;
  let homeDir = opts.cwd;
  if (!homeDir) {
    tempHome = mkdtempSync(join(tmpdir(), "muonroi-harness-home-"));
    homeDir = tempHome;
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: homeDir,
    USERPROFILE: homeDir,
    // MUONROI_TEST_NO_PERSIST: "1",
    // Suppress the agent-harness shim deprecation warning in the spawned
    // child — this is an internal-callsite spawn, not an external consumer.
    MUONROI_INTERNAL_SHIM_OK: "1",
    ANTHROPIC_API_KEY: "sk-ant-mock",
    OPENAI_API_KEY: "sk-mock",
    GOOGLE_GENERATIVE_AI_API_KEY: "mock",
    ...(opts.env ?? {}),
  };

  const result: SpawnResult = await spawnAgentTui(args, {
    spawnOpts: { env, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
  });

  const { proc, inWrite, outRead, cleanup: spawnCleanup } = result;

  const driver = createDriver({
    sendKey: (k) => inWrite.write(`${JSON.stringify({ op: "press", key: k })}\n`),
    sendType: (t) => inWrite.write(`${JSON.stringify({ op: "type", text: t })}\n`),
  });

  const splitter = createLineSplitter((line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.mode === "live") {
        driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      } else if (msg.t === "idle") {
        driver._ingest({ kind: "idle" });
      } else if (msg.t === "event") {
        driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
      }
    } catch {
      // ignore malformed lines
    }
  });

  outRead.on("data", (chunk: Buffer | string) => {
    splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });

  // Phase 21 / disconnect — surface transport teardown as a typed event so
  // E2E specs can assert a disconnect contract instead of waiting for a
  // wait_for timeout. Both 'end' (orderly EOF) and 'close' (possibly with
  // error) are forwarded — duplicates are harmless because last_event reads
  // the most recent matching kind.
  let disconnected = false;
  proc.stderr?.on("data", (d) => {
    const txt = d.toString();
    process.stdout.write(`STDERR: ${txt}`);
  });
  const emitDisconnect = (reason: "end" | "close") => {
    if (disconnected) return;
    disconnected = true;
    driver._ingest({
      kind: "event",
      event: { t: "event", kind: "disconnect", reason, ts: Date.now() },
    });
    driver._closeAllSubscribers();
  };
  outRead.on("end", () => emitDisconnect("end"));
  outRead.on("close", () => emitDisconnect("close"));

  const cleanup = () => {
    spawnCleanup();
    if (tempHome) {
      try {
        rmSync(tempHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  return { proc, driver, cleanup };
}
