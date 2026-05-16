/**
 * helpers.ts — Shared test utilities for harness E2E specs.
 *
 * Wraps spawnAgentTui to wire the driver's frame/idle/event ingestion in one place,
 * returning a ready-to-use driver. Callers only need to call cleanup in afterAll.
 */

import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
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
};

const DEFAULT_FIXTURES = resolve("tests/harness/fixtures/llm");
const ENTRY = resolve("src/index.ts");

/**
 * Spawn the agent-mode TUI and wire the driver.
 * Does NOT call wait_for — callers decide when the TUI is ready.
 */
export async function spawnHarness(opts: SpawnHarnessOptions = {}): Promise<HarnessContext> {
  const args = [ENTRY, "--agent-mode", "--mock-llm", DEFAULT_FIXTURES, ...(opts.extraArgs ?? [])];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MUONROI_TEST_NO_PERSIST: "1",
    ...(opts.env ?? {}),
  };

  const result: SpawnResult = await spawnAgentTui(args, {
    spawnOpts: { env },
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
  });

  const { proc, inWrite, outRead, cleanup } = result;

  const driver = createDriver({
    sendKey: (k) => inWrite.write(JSON.stringify({ op: "press", key: k }) + "\n"),
    sendType: (t) => inWrite.write(JSON.stringify({ op: "type", text: t }) + "\n"),
  });

  const splitter = createLineSplitter((line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg["mode"] === "live") {
        driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      } else if (msg["t"] === "idle") {
        driver._ingest({ kind: "idle" });
      } else if (msg["t"] === "event") {
        driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
      }
    } catch {
      // ignore malformed lines
    }
  });

  outRead.on("data", (chunk: Buffer | string) => {
    splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });

  return { proc, driver, cleanup };
}
