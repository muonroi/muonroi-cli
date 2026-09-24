/**
 * A fake agent-mode child that makes the handshake COALESCE with the lines after
 * it, so the loss path in `waitForHandshake` is deterministic rather than a
 * 1-in-many race.
 *
 * Ordering matters, and the obvious version does not work. Writing immediately
 * on connect loses everything for a different reason: a server-side socket from
 * `net.createServer` arrives FLOWING (measured `isPaused() === false`), so bytes
 * written before any `data` listener exists are emitted to nobody and dropped
 * (measured `readableLength === 0` a second later). That is not the path under
 * test.
 *
 * So this child does what the real one does — connect both pipes, then write —
 * but delays the write until the parent has certainly attached its handshake
 * reader, and then emits the handshake AND the two following lines in a SINGLE
 * write. The reader therefore receives all three in one chunk, which is exactly
 * the condition under which the old code kept the first line and discarded the
 * remainder.
 *
 * The real child never coalesces: it writes the handshake alone ~120 ms in, and
 * measured leftover was 0 bytes across 75 spawns. The fixture has to manufacture
 * the chunk boundary precisely because reality does not produce it.
 */

import { createConnection, type Socket } from "node:net";

const outPipe = process.env.MUONROI_HARNESS_OUT_PIPE;
const inPipe = process.env.MUONROI_HARNESS_IN_PIPE;

if (!outPipe || !inPipe) {
  process.stderr.write("[coalescing-child] MUONROI_HARNESS_{OUT,IN}_PIPE must both be set\n");
  process.exit(2);
}

/** The two lines that must survive the handshake read; the test asserts on both. */
const AFTER_HANDSHAKE = [
  JSON.stringify({ t: "idle" }),
  JSON.stringify({ t: "event", kind: "toast", level: "error", text: "POST-HANDSHAKE-LINE" }),
];

/**
 * How long to wait after both pipes are up before writing.
 *
 * The parent attaches its handshake reader within microtasks of the second
 * connection landing, so this only has to clear that; it is generous because an
 * early write is silently dropped (see above) and would make the test lie.
 */
const WRITE_DELAY_MS = 750;

function connect(path: string, label: string): Promise<Socket> {
  return new Promise((res, rej) => {
    const sock = createConnection(path);
    sock.once("connect", () => res(sock));
    sock.once("error", (err) => rej(new Error(`${label} pipe: ${err.message}`)));
  });
}

try {
  const [outSock, inSock] = await Promise.all([connect(outPipe, "out"), connect(inPipe, "in")]);
  // Consume the command channel so the parent's writes never back up.
  inSock.on("data", () => {});

  setTimeout(() => {
    // ONE write: handshake + the lines the old code discarded.
    outSock.write(`${JSON.stringify({ t: "handshake", ok: true })}\n${AFTER_HANDSHAKE.join("\n")}\n`);
  }, WRITE_DELAY_MS);
} catch (err) {
  process.stderr.write(`[coalescing-child] connect failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
}

// Hold the process open so the parent observes a live child, as the real
// agent-mode transport would, until it is killed in teardown.
setInterval(() => {}, 1_000);
