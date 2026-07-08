/**
 * agent-mode.ts — Runtime that the --agent-mode CLI flag activates.
 *
 * Transport (POSIX):
 *   fd 3 (out, JSONL writes) and fd 4 (in, JSONL reads), opened via
 *   createWriteStream/createReadStream. Parent must spawn with a 5-element
 *   stdio array using node:child_process.spawn.
 *
 * Transport (Windows):
 *   If env vars MUONROI_HARNESS_OUT_PIPE and MUONROI_HARNESS_IN_PIPE are set,
 *   the child connects to those named pipes instead of using fd 3/4. The child
 *   sends a { t: "handshake", ok: true } JSONL line on the out pipe once
 *   connected, so the parent can synchronize before sending commands.
 *
 * For tests, pass opts.injectStreams to inject in-memory PassThrough streams
 * instead of opening real fds — this avoids touching process state in tests.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { createEventFilter } from "@muonroi/agent-harness-core/event-filter";
import { redactEvent } from "@muonroi/agent-harness-core/event-redact";
import { createIdleDetector } from "@muonroi/agent-harness-core/idle";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter, createSidechannelWriter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { installOpenTUIHarness, type OpenTUIHarnessTransport } from "./install.js";
import type { SemanticRegistry } from "./reconciler-hook.js";
import { createSemanticRegistry } from "./reconciler-hook.js";
import { createVisualCaptureHook, type RendererLike } from "./visual-capture.js";

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
  /**
   * Attach the OpenTUI renderer once it exists (constructed AFTER this runtime
   * — see src/index.ts). Enables VisualFrame capture of the real cell grid.
   */
  attachRenderer: (renderer: RendererLike) => void;
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
  } else if (
    process.platform === "win32" &&
    process.env["MUONROI_HARNESS_OUT_PIPE"] &&
    process.env["MUONROI_HARNESS_IN_PIPE"]
  ) {
    // Windows: connect to named pipes provided by the parent (test-spawn.ts).
    // The parent creates both pipe servers before spawning this child, so both
    // pipes are ready when we arrive here. On connect, emit a handshake line on
    // the out pipe so the parent knows the transport is ready.
    const { createConnection } = await import("node:net");

    const outPipeName = process.env["MUONROI_HARNESS_OUT_PIPE"];
    const inPipeName = process.env["MUONROI_HARNESS_IN_PIPE"];

    const outSock = createConnection(outPipeName);
    const inSock = createConnection(inPipeName);

    // Wait for both sockets to establish their connection before proceeding.
    // If either fails, log to stderr and exit — the parent will time out and
    // surface a clear error.
    await new Promise<void>((resolve, reject) => {
      let connected = 0;
      const onConnect = () => {
        if (++connected === 2) resolve();
      };
      outSock.once("connect", onConnect);
      inSock.once("connect", onConnect);
      outSock.once("error", reject);
      inSock.once("error", reject);
    }).catch((err: unknown) => {
      process.stderr.write(`[agent-mode] named-pipe connect error: ${String(err)}\n`);
      process.exit(1);
    });

    // Emit handshake so parent's waitForHandshake() can unblock.
    outSock.write(JSON.stringify({ t: "handshake", ok: true }) + "\n");

    outStream = outSock;
    inStream = inSock;

    // Apply determinism: force terminal dimensions so layout is reproducible.
    process.stdout.columns = opts.cols;
    (process.stdout as unknown as { rows: number }).rows = opts.rows;
  } else {
    // POSIX (Linux/macOS): open fds 3 (write) and 4 (read). The parent is
    // responsible for spawning with a 5-element stdio array via
    // node:child_process.spawn (Bun's spawn does not forward extra fds on
    // Windows — confirmed by spike-0c).
    outStream = createWriteStream("", { fd: 3 });
    inStream = createReadStream("", { fd: 4 });

    // Apply determinism: force terminal dimensions so layout is reproducible.
    process.stdout.columns = opts.cols;
    (process.stdout as unknown as { rows: number }).rows = opts.rows;
  }

  // --- Clock ---------------------------------------------------------------
  // now() is exposed on AgentModeRuntime so callers can get a consistent
  // timestamp.  fakeClock returns 0 (a stable sentinel for tests) because the
  // seq counter is now owned by installOpenTUIHarness internally.
  const now = (): number => (opts.fakeClock ? 0 : Date.now());

  // --- Semantic registry ---------------------------------------------------
  const registry = createSemanticRegistry();

  // --- Visual capture (real rendered cell grid) ----------------------------
  // The renderer does not exist yet — it is constructed after this runtime and
  // handed back via attachRenderer(). The hook reads it late-bound.
  let rendererRef: RendererLike | undefined;
  const visualHook = createVisualCaptureHook(() => rendererRef);

  // --- Idle detector -------------------------------------------------------
  const idle = createIdleDetector({
    quiescenceMs: opts.idleMs,
    onIdle: () => {
      const line = createSidechannelWriter.serialize({ t: "idle" });
      outStream.write(line);
    },
  });

  // --- Harness install ------------------------------------------------------
  // Wire registry → outStream via installOpenTUIHarness.  The transport wraps
  // the raw outStream; close() is handled by uninstall() in dispose().
  // onFrame threads idle.markActivity() so the idle detector resets after each
  // emitted frame (prevents spurious idle events mid-render-burst).
  const transport: OpenTUIHarnessTransport = {
    send: (line: string) => outStream.write(line),
    close: () => outStream.end(),
  };

  const harnessHandle = installOpenTUIHarness({
    registry,
    transport,
    fps: 60,
    onFrame: () => idle.markActivity(),
    // Pass --agent-fake-clock through to the snapshot hook so LiveFrame.ts
    // becomes deterministic (seq*16). Without this, ts = Date.now() and the
    // determinism spec sees timestamps differ between runs.
    fakeClock: opts.fakeClock,
    // Emit a VisualFrame (real rendered cell grid) alongside each semantic
    // change. No-op until attachRenderer() supplies the renderer.
    captureVisual: (seq, ts) => visualHook.capture(seq, ts),
  });

  // --- Command channel (in stream → handlers) ------------------------------
  const commandHandlers: Array<(cmd: unknown) => void> = [];

  const splitter = createLineSplitter((line) => {
    try {
      const cmd = JSON.parse(line);
      // Any incoming command is "activity" — reset the idle quiescence timer
      // so the next idle event fires after the system settles post-dispatch.
      // Without this, wait_for({idle: true}) after press/type can never
      // resolve because no frame write happens to mark activity (e.g., when
      // the input changes textarea state but no Semantic field is mirrored).
      idle.markActivity();
      for (const h of commandHandlers) h(cmd);
    } catch {
      // Malformed JSONL from host — ignore silently.
    }
  });

  inStream.on("data", (chunk: Buffer | string) => {
    splitter(chunk);
  });

  // --- Volume filter -------------------------------------------------------
  // Reads MUONROI_HARNESS_EVENTS once at startup; default drops "llm-token".
  const isKindAllowed = createEventFilter(process.env["MUONROI_HARNESS_EVENTS"]);

  // --- Public API ----------------------------------------------------------

  // capture() is called from app.tsx's addPostProcessFn after each renderer
  // pass — it forces an immediate snapshot via captureNow() rather than waiting
  // for the next poll interval tick.
  const capture = (): void => {
    harnessHandle.captureNow();
  };

  const emitEvent = (e: LiveEvent): void => {
    // t:"idle" is the idle sentinel — not a LiveEvent with kind; bypass filter.
    if (e.t === "event") {
      if (!isKindAllowed(e.kind)) return; // filtered out — no-op
    }
    // Redact payload before writing to the wire.
    const safe = e.t === "event" ? redactEvent(e) : e;
    outStream.write(createSidechannelWriter.serialize(safe));
    // stream.delta events mark activity (text is flowing — not yet idle).
    if (e.t === "event" && e.kind === "stream.delta") {
      idle.markActivity();
    }
  };

  const onCommand = (h: (cmd: unknown) => void): void => {
    commandHandlers.push(h);
  };

  const attachRenderer = (renderer: RendererLike): void => {
    rendererRef = renderer;
    visualHook.resetDedup(); // force the first visual frame after attach
  };

  const dispose = (): void => {
    harnessHandle.uninstall(); // stops poll interval; transport.close() ends outStream
    idle.dispose();
    // in stream is read-only — destroy if possible.
    if (typeof (inStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === "function") {
      (inStream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
    }
  };

  return { registry, capture, emitEvent, onCommand, now, attachRenderer, dispose };
}
