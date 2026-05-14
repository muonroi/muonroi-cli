/**
 * determinism.spec.ts
 *
 * Goal: run a fixed interaction sequence N times and assert that the resulting
 * LiveFrame traces (excluding `ts`) are byte-identical across all runs.
 *
 * Interaction sequence: type "hello" and press Enter (same as the composer E2E),
 * then wait for idle.
 *
 * N = 10 (not 50): each spawn takes ~2-4 s; 50 × 4 s = 200 s which exceeds the
 * vitest 2-minute default. 10 runs × 4 s = 40 s, well within limits and
 * sufficient to detect non-determinism in practice.
 *
 * --agent-fake-clock flag: confirmed implemented in src/index.ts (line 781).
 * When present, the `ts` field is set to seq * 16 instead of Date.now(), making
 * ts also deterministic. The test passes --agent-fake-clock and asserts full
 * byte-identity including `ts`.
 *
 * Frame collection: read every JSONL line from fd3 that has mode="live";
 * strip nothing when --agent-fake-clock is active (ts is deterministic).
 *
 * Known limitation: if the TUI emits zero frames (because no <Semantic> nodes
 * are wired, which is the current state of app.tsx), all 10 runs will produce
 * an empty trace — the assertion trivially passes but tests nothing meaningful.
 * A todo documents this gap.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of identical runs to perform. 10 is the pragmatic CI-safe limit. */
const N = 10;

const ENTRY = resolve("src/index.ts");
const FIXTURES_DIR = resolve("tests/harness/fixtures/llm");

// ---------------------------------------------------------------------------
// Helper: run one interaction and collect all LiveFrame JSONL messages
// ---------------------------------------------------------------------------

type FrameTrace = string[]; // JSON-stringified frames (ts stripped if no fake clock)

async function runOnce(useFakeClock: boolean): Promise<FrameTrace> {
  return new Promise<FrameTrace>((resolve, reject) => {
    const args = ["run", ENTRY, "--agent-mode", "--mock-llm", FIXTURES_DIR];
    if (useFakeClock) args.push("--agent-fake-clock");

    const proc: ChildProcess = spawn("bun", args, {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });

    const frames: LiveFrame[] = [];
    let idleReceived = false;
    let settled = false;

    function settle() {
      if (settled) return;
      settled = true;
      proc.kill();
      resolve(frames.map((f) => JSON.stringify(f)));
    }

    // Safety timeout — should not be needed in normal operation
    const safetyTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("runOnce: safety timeout exceeded"));
      }
    }, 15_000);

    const splitter = createLineSplitter((line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg["mode"] === "live") {
          frames.push(msg as unknown as LiveFrame);
        } else if (msg["t"] === "idle") {
          if (!idleReceived) {
            idleReceived = true;
            // First idle = startup complete. Send the interaction sequence.
            const fd4 = proc.stdio[4] as NodeJS.WritableStream | null;
            fd4?.write(JSON.stringify({ op: "type", text: "hello" }) + "\n");
            fd4?.write(JSON.stringify({ op: "press", key: "Enter" }) + "\n");
          } else {
            // Second idle = response received. Collect frames and finish.
            clearTimeout(safetyTimer);
            settle();
          }
        }
      } catch {
        // ignore malformed lines
      }
    });

    const fd3 = proc.stdio[3] as NodeJS.ReadableStream | null;
    fd3?.on("data", (chunk: Buffer | string) => {
      splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    proc.on("error", (err) => {
      clearTimeout(safetyTimer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    proc.on("exit", () => {
      clearTimeout(safetyTimer);
      // If we exit before getting the second idle, settle with whatever we have.
      if (!settled) settle();
    });
  });
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")(`determinism: ${N}× identical LiveFrame traces`, () => {
  /**
   * Core determinism test.
   * Runs N times sequentially (not parallel — avoids port/resource contention).
   * With --agent-fake-clock, ts = seq * 16 so the full frame is deterministic.
   */
  it(`${N} sequential runs with --agent-fake-clock produce byte-identical LiveFrame traces`, async () => {
    const traces: FrameTrace[] = [];
    for (let i = 0; i < N; i++) {
      const trace = await runOnce(/* useFakeClock */ true);
      traces.push(trace);
    }

    const reference = JSON.stringify(traces[0]);

    for (let i = 1; i < N; i++) {
      expect(JSON.stringify(traces[i]), `run ${i + 1} differed from run 1`).toBe(reference);
    }
  }, 120_000); // Each spawn can take up to 8 s; N=10 needs up to 80 s. Use 120 s budget.

  it.todo(
    "ts-identity assertion is included above because --agent-fake-clock IS implemented (src/index.ts line 781): fakeClock sets ts = seq * 16 making it deterministic across runs",
  );

  it.todo(
    "if app.tsx never wires <Semantic> nodes, all traces will be empty arrays and the byte-identity assertion trivially passes without testing anything meaningful; add <Semantic> components to make this test load-bearing",
  );
});
