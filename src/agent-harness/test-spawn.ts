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
 *   Returns the connected socket streams.
 *
 * Both paths return the same { proc, inWrite, outRead } shape so callers are
 * fully platform-neutral.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

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

async function waitForConnection(server: Server, timeoutMs: number, label: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Named pipe "${label}": client did not connect within ${timeoutMs} ms`));
    }, timeoutMs);

    server.once("connection", (sock) => {
      clearTimeout(timer);
      resolve(sock);
    });
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForHandshake(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Handshake not received within ${timeoutMs} ms`));
    }, timeoutMs);

    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      clearTimeout(timer);
      socket.off("data", onData);
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.t === "handshake" && msg.ok === true) {
          resolve();
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
  let outSocket: Socket;
  try {
    [inSocket, outSocket] = await Promise.all([
      waitForConnection(inServer, timeoutMs, inPipeName),
      waitForConnection(outServer, timeoutMs, outPipeName),
    ]);
    // outPipe is where the child writes frames — wait for the handshake line.
    await waitForHandshake(outSocket, timeoutMs);
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

  attachStreamErrorGuards(inSocket, outSocket);

  return {
    proc,
    inWrite: inSocket, // host writes commands → child reads on MUONROI_HARNESS_IN_PIPE
    outRead: outSocket, // child writes frames → host reads from MUONROI_HARNESS_OUT_PIPE
    cleanup,
  };
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
