/**
 * test-spawn.ts — Cross-platform helper for spawning the agent-mode TUI in tests.
 *
 * On POSIX (Linux/macOS):
 *   Spawns with a 5-element stdio array; child reads/writes fd 3 and fd 4.
 *   Returns proc.stdio[3] as outRead and proc.stdio[4] as inWrite.
 *
 * On Windows:
 *   Creates two named pipes (\\.\pipe\muonroi-harness-{pid}-{uuid}-{in|out})
 *   BEFORE spawning the child. Passes their names via env vars
 *   MUONROI_HARNESS_OUT_PIPE and MUONROI_HARNESS_IN_PIPE. Waits for the child
 *   to connect and send the handshake { t: "handshake", ok: true } within 5 s.
 *   The out pipe is captured into a PassThrough from the connection event
 *   onward, so a child that writes before the handshake reader attaches does not
 *   lose those bytes to a flowing socket with no listener; `outRead` is that
 *   relay, not the raw socket. `inWrite` is the raw socket — the host only
 *   writes to it.
 *
 * Both paths return the same { proc, inWrite, outRead } shape so callers are
 * fully platform-neutral.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";

export type SpawnResult = {
  proc: ChildProcess;
  /** Stream the host writes commands TO the child (the child reads these). */
  inWrite: NodeJS.WritableStream;
  /** Stream the host reads frames/events FROM the child (the child writes these). */
  outRead: NodeJS.ReadableStream;
  /** Clean up resources (servers, sockets). Called automatically by proc 'exit'. */
  cleanup: () => void;
};

type SpawnOptions = {
  /** Extra spawn options forwarded to child_process.spawn (env, etc.). */
  spawnOpts?: Omit<Parameters<typeof spawn>[2], "stdio">;
  /**
   * Handshake timeout on Windows. Default: 15000 ms. Override via
   * MUONROI_HARNESS_HANDSHAKE_TIMEOUT env var (millis). The default was
   * bumped from 5s to 15s because cold-start spawns under MCP server load
   * routinely exceeded 5s and produced confusing `client did not connect`
   * errors that surfaced as transient flakes in agent-driven E2E flows.
   */
  handshakeTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Internal: teardown-safe stream error guards
// ---------------------------------------------------------------------------

/**
 * Attach `'error'` listeners to both transport streams so a broken-pipe write
 * (EPIPE / UV_EPIPE -4047 on Windows) or a peer reset (ECONNRESET) during
 * process teardown is logged and swallowed instead of surfacing as an
 * *uncaught* stream error that crashes the whole vitest worker.
 *
 * Root cause of the flake: when the child is killed in `afterAll`, an in-flight
 * `inWrite.write()` (driver sendKey/sendType) or a half-open `outRead` races the
 * child's death. A WritableStream with no `'error'` listener rethrows EPIPE as
 * an unhandled exception — under full-suite load this reliably reproduces on
 * `events.spec.ts` and fails the file even though every assertion passed.
 *
 * Logging (not silent swallow) satisfies the No-Silent-Catch rule — teardown
 * broken-pipe is expected, but a mid-test error still gets a diagnostic line.
 */
function attachStreamErrorGuards(inWrite: NodeJS.WritableStream, outRead: NodeJS.ReadableStream): void {
  const guard = (label: string) => (err: NodeJS.ErrnoException) => {
    // EPIPE / ECONNRESET / ERR_STREAM_DESTROYED are all normal teardown races.
    const code = err?.code ?? "unknown";
    if (code !== "EPIPE" && code !== "ECONNRESET" && code !== "ERR_STREAM_DESTROYED") {
      console.error(`[test-spawn] ${label} stream error (${code}): ${err?.message}`);
    }
  };
  inWrite.on("error", guard("inWrite"));
  outRead.on("error", guard("outRead"));
}

// ---------------------------------------------------------------------------
// Internal: Windows named-pipe transport
// ---------------------------------------------------------------------------

function makePipeName(role: "in" | "out"): string {
  // Use process.pid + a UUID to avoid collisions between concurrent test suites.
  return `\\\\.\\pipe\\muonroi-harness-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}-${role}`;
}

type Connected = {
  socket: Socket;
  /**
   * Everything the child has written since the instant the connection landed,
   * in order. Present only for a pipe opened with `capture: true`.
   */
  stream?: PassThrough;
};

/**
 * Wait for the child to connect, and — for a pipe we will READ — start capturing
 * immediately, in the connection handler itself.
 *
 * Without the capture there is a window in which bytes are silently destroyed:
 * `spawnWindows` resolves this promise, then sits in `Promise.all` waiting for
 * the OTHER pipe, and only then attaches the handshake reader. Nothing is
 * consuming the socket for that whole span, and under Bun that is not a benign
 * state. Measured over that exact sequence, with a child writing 87 bytes
 * immediately on connecting:
 *
 *   [out connection event]                  readableFlowing=null  readableLength=0
 *   [after Promise.all, reader about to attach]
 *                                           readableFlowing=true  readableLength=0
 *   RESULT received=""
 *
 * The socket arrives BUFFERING and flips itself to FLOWING inside the gap with
 * no listener attached; a flowing readable with nowhere to emit discards what it
 * receives. The handshake is then gone with no error, and the caller gets a
 * 90-second `Handshake not received` throw that blames the wrong thing.
 *
 * Pausing here does NOT fix it, and that had to be measured rather than reasoned
 * from Node's documented semantics. `pause()` takes effect synchronously
 * (`isPaused()=true`, `readableFlowing=false` on the next line) and Bun undoes it
 * before the bytes land — sampled 300 ms later the same socket reported
 * `isPaused()=false`, `readableFlowing=true`, `readableLength=0`, so a later
 * explicit `resume()` had nothing to deliver.
 *
 * `pipe()` is what works, and works for a reason that does not depend on resume
 * semantics at all: it wires the destination first and only then starts the
 * flow, so there is no listener-less instant. Measured, the relay held
 * `readableLength=41` with no consumer and delivered every byte to a consumer
 * attaching a second later. Same mechanism as `relayHandshakeLeftover` below,
 * one step earlier in the sequence.
 *
 * The in pipe is opened with `capture: false`: the host only ever WRITES to it,
 * so a relay there would buffer forever with nobody to drain it.
 */
async function waitForConnection(
  server: Server,
  timeoutMs: number,
  label: string,
  opts: { capture: boolean },
): Promise<Connected> {
  return new Promise<Connected>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Named pipe "${label}": client did not connect within ${timeoutMs} ms`));
    }, timeoutMs);

    server.once("connection", (sock) => {
      clearTimeout(timer);
      if (!opts.capture) {
        resolve({ socket: sock });
        return;
      }
      const stream = new PassThrough();
      // Wired in the connection handler, before this promise resolves and so
      // before any `await` can yield — the earliest reachable instant.
      sock.pipe(stream);
      // `pipe` does not forward 'error'; re-emit so a consumer still sees the
      // real cause instead of a stream that just stops.
      sock.on("error", (err) => stream.destroy(err));
      resolve({ socket: sock, stream });
    });
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Read the child's handshake line and RETURN whatever followed it, so the caller
 * can put those bytes back in front of the stream.
 *
 * Reads the CAPTURE RELAY built in `waitForConnection`, never the raw socket.
 * That is what makes this reader's arrival time stop mattering: the relay has
 * been accumulating since the connection event, so a handshake the child wrote
 * before this function existed is sitting in it rather than having been
 * discarded by a flowing socket. It also means a `pause()` here acts on a plain
 * in-memory `PassThrough` — pure stream code with no net layer to undo it — and
 * not on the Bun socket whose `pause()` was measured to be reverted (see
 * `waitForConnection`).
 *
 * The handshake shares the out pipe with every frame, event and idle sentinel
 * the child will ever send. Anything that arrives in the same chunk sits in
 * `buf` after the newline, and this function used to drop it on the floor:
 * `off("data", onData)` stopped the listener, nothing re-delivered the
 * remainder, and the caller's splitter — attached microtasks later — never saw
 * it. A lost idle sentinel or first frame presents as precisely the
 * intermittent "child never became ready" this transport is hardest to debug
 * for, with no trace that anything was lost.
 *
 * Measured 2026-09-24 over 75 spawns of the real agent-mode child: leftover was
 * 0 bytes every time, because the child writes the handshake alone ~120 ms in.
 * So the leftover path is latent, not an active bug — and the guard below keeps
 * it a strict no-op on that measured-normal path: with nothing left over the
 * relay is never paused, no second relay is built, and the caller gets the
 * capture relay unchanged.
 *
 * When there IS a remainder, this pauses the relay and returns the bytes to
 * `spawnWindows`, which puts them back in front of the live stream. Pausing
 * before yielding control is what stops the remainder being lost a second way,
 * in the gap between this listener detaching and the next one attaching.
 *
 * It deliberately does NOT `unshift` and hand the stream straight back. That was
 * the first attempt and it does not work on this runtime: after
 * `pause()` + `unshift()` the bytes are genuinely buffered
 * (`readableLength === 87`), but under Bun attaching a `data` listener does NOT
 * resume an explicitly paused stream the way Node documents — measured, the
 * consumer attached and received nothing while `isPaused()` stayed true and the
 * 87 bytes sat there. Hence `relayHandshakeLeftover`, which does not depend on
 * resume semantics at all.
 *
 * @returns the bytes that followed the handshake line — `""` on the normal path.
 */
async function waitForHandshake(socket: PassThrough, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Handshake not received within ${timeoutMs} ms`));
    }, timeoutMs);

    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      const leftover = buf.slice(nl + 1);
      clearTimeout(timer);
      socket.off("data", onData);
      // Pause BEFORE yielding control, or the flowing socket drops the
      // remainder in the gap where no listener exists.
      if (leftover.length > 0) socket.pause();
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.t === "handshake" && msg.ok === true) {
          resolve(leftover);
        } else {
          reject(new Error(`Unexpected handshake payload: ${line}`));
        }
      } catch {
        reject(new Error(`Malformed handshake line: ${line}`));
      }
    };

    socket.on("data", onData);
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.off("data", onData);
      reject(err);
    });
  });
}

function resolveHandshakeTimeoutMs(opts: SpawnOptions): number {
  if (typeof opts.handshakeTimeoutMs === "number" && opts.handshakeTimeoutMs > 0) {
    return opts.handshakeTimeoutMs;
  }
  const envOverride = Number.parseInt(process.env["MUONROI_HARNESS_HANDSHAKE_TIMEOUT"] ?? "", 10);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  // Bumped 5s → 15s → 90s. Cold child boot is a full `bun run src/index.ts`
  // import of the whole CLI, which on heavy/resource-constrained hosts measures
  // ~40s (smoke-boot) before the named pipe is even opened — and agent-mode boot
  // under MCP-server load runs longer — so 15s surfaced as a confusing
  // "client did not connect" on the first tui.start. 90s gives comfortable margin;
  // override via MUONROI_HARNESS_HANDSHAKE_TIMEOUT for slower hosts/prebuilt runs.
  return 90_000;
}

async function spawnWindows(args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  const timeoutMs = resolveHandshakeTimeoutMs(opts);

  const inPipeName = makePipeName("in");
  const outPipeName = makePipeName("out");

  // Create both servers BEFORE spawning the child so the pipe names are
  // already listening when the child calls createConnection.
  const inServer = createServer({ allowHalfOpen: true });
  const outServer = createServer({ allowHalfOpen: true });

  await new Promise<void>((res, rej) => {
    let done = 0;
    const onListen = () => {
      if (++done === 2) res();
    };
    inServer.once("error", rej);
    outServer.once("error", rej);
    inServer.listen(inPipeName, onListen);
    outServer.listen(outPipeName, onListen);
  });

  const baseEnv = { ...(opts.spawnOpts?.env ?? process.env) } as Record<string, string>;
  baseEnv.MUONROI_HARNESS_IN_PIPE = inPipeName;
  baseEnv.MUONROI_HARNESS_OUT_PIPE = outPipeName;

  const mergedOpts = {
    ...opts.spawnOpts,
    env: baseEnv,
    // stdio[0..2] piped for stdin/out/err; no extra fds needed.
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };

  const proc = spawn("bun", ["run", ...args], mergedOpts);

  // Wait for both child sockets to connect, then for the handshake on outPipe.
  let inSocket: Socket;
  // Everything the child wrote on the out pipe, captured from the connection
  // event onward — see `waitForConnection`. The handshake reader and the caller
  // both read THIS, never the raw out socket, so no byte can land in an unread
  // gap. The out socket needs no name of its own past this point: the pipe keeps
  // it referenced, and the 'error' listener it needs was attached at connection
  // time and re-emits onto this relay.
  let outStream: PassThrough;
  let handshakeLeftover = "";
  try {
    const [inConn, outConn] = await Promise.all([
      waitForConnection(inServer, timeoutMs, inPipeName, { capture: false }),
      waitForConnection(outServer, timeoutMs, outPipeName, { capture: true }),
    ]);
    inSocket = inConn.socket;
    // `capture: true` above guarantees this; the cast is the type system catching
    // up with the option, not an assumption about the runtime.
    outStream = outConn.stream as PassThrough;
    // outPipe is where the child writes frames — wait for the handshake line.
    handshakeLeftover = await waitForHandshake(outStream, timeoutMs);
  } catch (err) {
    if (proc && typeof proc.kill === "function") {
      proc.kill();
    }
    inServer.close();
    outServer.close();
    throw err;
  }

  const cleanup = () => {
    inServer.close();
    outServer.close();
  };
  proc.once("exit", cleanup);

  const outRead = relayHandshakeLeftover(outStream, handshakeLeftover);
  // Guard the stream the CALLER actually holds, not the raw socket. A socket
  // error is re-emitted onto the capture relay (see `waitForConnection`), so
  // guarding only the socket would leave that `destroy(err)` unhandled and take
  // down the whole worker on an ordinary teardown EPIPE.
  attachStreamErrorGuards(inSocket, outRead);

  return {
    proc,
    inWrite: inSocket, // host writes commands → child reads on MUONROI_HARNESS_IN_PIPE
    outRead,
    cleanup,
  };
}

/**
 * Put the bytes that rode along with the handshake back in front of the stream.
 *
 * On the normal path — `leftover === ""`, which is what all 75 measured spawns
 * of the real child produced — this returns the capture relay itself, so no
 * SECOND stream is added to the hot path.
 *
 * When the child DID coalesce, `waitForHandshake` has already paused the relay
 * and the remainder would otherwise be gone for good. Relaying through another
 * PassThrough is used rather than `unshift()` because unshift needs the
 * consumer's `data` listener to resume the stream, and under Bun it does not:
 * measured, after `pause()` + `unshift()` the 87 leftover bytes were correctly
 * buffered (`readableLength === 87`) and the consumer that attached afterwards
 * received nothing, with `isPaused()` still true. `pipe()` resumes the source
 * itself and only after its destination is wired, so nothing can fall into a
 * listener-less gap.
 */
function relayHandshakeLeftover(socket: PassThrough, leftover: string): NodeJS.ReadableStream {
  if (leftover.length === 0) return socket;

  const relay = new PassThrough();
  // Queue the remainder FIRST so it is read before anything still in flight,
  // preserving the child's line order.
  relay.write(leftover);
  // `pipe` forwards 'end' to the relay, which is what keeps the disconnect
  // contract that callers assert on (`outRead.on("end"|"close")`).
  socket.pipe(relay);
  // A socket error is not forwarded by pipe; re-emit it so a consumer's error
  // handling still sees the real cause instead of a stream that just stops.
  socket.on("error", (err) => relay.destroy(err));
  return relay;
}

// ---------------------------------------------------------------------------
// Internal: POSIX fd 3/4 transport
// ---------------------------------------------------------------------------

function spawnPosix(args: string[], opts: SpawnOptions): SpawnResult {
  const spawnOptions = {
    ...opts.spawnOpts,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe", "pipe", "pipe"],
  };
  const proc = spawn("bun", ["run", ...args], spawnOptions);

  const outRead = proc.stdio[3] as NodeJS.ReadableStream;
  const inWrite = proc.stdio[4] as NodeJS.WritableStream;

  attachStreamErrorGuards(inWrite, outRead);

  return { proc, inWrite, outRead, cleanup: () => {} };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn the agent-mode TUI and return transport streams.
 *
 * @param args  Arguments after "bun run" — typically ["src/index.ts",
 *              "--agent-mode", "--mock-llm", fixturesDir, ...]
 * @param opts  Optional spawn and handshake options.
 */
export async function spawnAgentTui(args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  if (process.platform === "win32") {
    return spawnWindows(args, opts);
  }
  return spawnPosix(args, opts);
}
