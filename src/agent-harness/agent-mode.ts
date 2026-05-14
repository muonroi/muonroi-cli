/**
 * agent-mode.ts — Runtime that the --agent-mode CLI flag activates.
 *
 * Transport: fd 3 (out, JSONL writes) and fd 4 (in, JSONL reads), opened via
 * createWriteStream/createReadStream per spike-0c findings. Node child_process
 * correctly forwards extra fds on Windows (Bun does not); the harness driver
 * spawns via node:child_process.spawn everywhere for consistency.
 *
 * No Windows named-pipe handshake is needed here. Spike-0c confirmed that
 * inheritable fds work on Windows when the parent uses node:child_process.spawn
 * with a 5-element stdio array. The TOCTOU concern noted in Revisions v1.1 only
 * applied to the abandoned named-pipe approach.
 *
 * For tests, pass opts.injectStreams to inject in-memory PassThrough streams
 * instead of opening real fds — this avoids touching process state in tests.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { createIdleDetector } from "./idle.js";
import type { LiveEvent } from "./protocol.js";
import type { SemanticRegistry } from "./reconciler-hook.js";
import { createReconcilerHook, createSemanticRegistry } from "./reconciler-hook.js";
import { createLineSplitter, createSidechannelWriter } from "./sidechannel.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export type AgentModeOptions = {
  cols: number;
  rows: number;
  idleMs: number;
  fakeClock?: boolean;
  /** For tests: inject in-memory streams instead of fds 3/4. */
  injectStreams?: { out: NodeJS.WritableStream; in: NodeJS.ReadableStream };
  /** For tests: inject a writer for handshake instead of process.stdout. */
  handshakeOut?: NodeJS.WritableStream;
};

export type AgentModeRuntime = {
  registry: SemanticRegistry;
  /** Build and emit a frame if content changed (dedup handled by reconciler hook). */
  capture: () => void;
  /** Emit an event (stream.delta, toast, idle). */
  emitEvent: (e: LiveEvent) => void;
  /** Register a handler for incoming commands from the host. */
  onCommand: (h: (cmd: unknown) => void) => void;
  /** Get the current timestamp (real or fake clock). */
  now: () => number;
  /** Tear down: close streams, dispose idle detector. */
  dispose: () => void;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function startAgentMode(opts: AgentModeOptions): Promise<AgentModeRuntime> {
  const testing = opts.injectStreams !== undefined;

  // --- Transport -----------------------------------------------------------
  let outStream: NodeJS.WritableStream;
  let inStream: NodeJS.ReadableStream;

  if (testing) {
    // Tests inject PassThrough streams; skip fd opening and terminal resizing.
    outStream = opts.injectStreams!.out;
    inStream = opts.injectStreams!.in;
  } else {
    // Production: open fds 3 (write) and 4 (read). The parent process is
    // responsible for spawning this CLI with:
    //   stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"]
    // using node:child_process.spawn (Bun's spawn does not forward extra fds
    // on Windows — confirmed by spike-0c).
    outStream = createWriteStream("", { fd: 3 });
    inStream = createReadStream("", { fd: 4 });

    // Apply determinism: force terminal dimensions so layout is reproducible.
    process.stdout.columns = opts.cols;
    (process.stdout as unknown as { rows: number }).rows = opts.rows;
  }

  // --- Sequence / clock ----------------------------------------------------
  let seq = 0;
  const now = (): number => (opts.fakeClock ? seq * 16 : Date.now());

  // --- Semantic registry + reconciler hook ---------------------------------
  const registry = createSemanticRegistry();
  const hook = createReconcilerHook({
    registry,
    getSeq: () => seq++,
    getTs: now,
  });

  // --- Idle detector -------------------------------------------------------
  const idle = createIdleDetector({
    quiescenceMs: opts.idleMs,
    onIdle: () => {
      const line = createSidechannelWriter.serialize({ t: "idle" });
      outStream.write(line);
    },
  });

  // --- Command channel (in stream → handlers) ------------------------------
  const commandHandlers: Array<(cmd: unknown) => void> = [];

  const splitter = createLineSplitter((line) => {
    try {
      const cmd = JSON.parse(line);
      for (const h of commandHandlers) h(cmd);
    } catch {
      // Malformed JSONL from host — ignore silently.
    }
  });

  inStream.on("data", (chunk: Buffer | string) => {
    splitter(chunk);
  });

  // --- Public API ----------------------------------------------------------

  const capture = (): void => {
    const frame = hook.capture();
    if (frame !== null) {
      outStream.write(createSidechannelWriter.serialize(frame));
      idle.markActivity();
    }
  };

  const emitEvent = (e: LiveEvent): void => {
    outStream.write(createSidechannelWriter.serialize(e));
    // stream.delta events mark activity (text is flowing — not yet idle).
    if (e.t === "event" && e.kind === "stream.delta") {
      idle.markActivity();
    }
  };

  const onCommand = (h: (cmd: unknown) => void): void => {
    commandHandlers.push(h);
  };

  const dispose = (): void => {
    idle.dispose();
    // End the out stream; in stream is read-only — unpipe/destroy.
    outStream.end();
    if (typeof (inStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === "function") {
      (inStream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
    }
  };

  return { registry, capture, emitEvent, onCommand, now, dispose };
}
