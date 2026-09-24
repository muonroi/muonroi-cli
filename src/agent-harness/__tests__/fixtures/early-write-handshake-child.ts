/**
 * A fake agent-mode child that writes its handshake IMMEDIATELY on connecting to
 * the out pipe — before it connects the in pipe, and therefore before the parent
 * can possibly have attached its handshake reader.
 *
 * This is the race one step earlier than `coalescing-handshake-child.ts`. That
 * fixture deliberately WAITS so the parent is already reading, because it is
 * about the bytes that ride in the same chunk as the handshake. This one attacks
 * the window before the reader exists at all: in `spawnWindows` that window runs
 * from the `connection` event, through `Promise.all` waiting on the SECOND pipe,
 * to `waitForHandshake` attaching its listener.
 *
 * Measured under Bun 1.3.13: a server-side socket from `net.createServer`
 * arrives FLOWING (`isPaused() === false`), and a flowing readable with no
 * `data` listener emits to nobody — a 41-byte write landed with
 * `readableLength === 0` a full second later, gone. So a child that writes in
 * that window loses its handshake, and the caller gets a 90-second
 * `Handshake not received` throw that blames the wrong thing.
 *
 * Writing out FIRST and connecting in SECOND is what makes the window wide and
 * deterministic: the parent's `Promise.all` cannot resolve — and so
 * `waitForHandshake` cannot attach — until the in pipe connects, which this
 * child delays until after the write has already gone out.
 *
 * The real child connects both pipes and then writes ~120 ms later, so it
 * normally wins this race. The fixture removes the luck.
 */

import { createConnection, type Socket } from "node:net";

const outPipe = process.env.MUONROI_HARNESS_OUT_PIPE;
const inPipe = process.env.MUONROI_HARNESS_IN_PIPE;

if (!outPipe || !inPipe) {
  process.stderr.write("[early-write-child] MUONROI_HARNESS_{OUT,IN}_PIPE must both be set\n");
  process.exit(2);
}

/** Written after the handshake; the test asserts it survives too. */
const AFTER_HANDSHAKE = JSON.stringify({ t: "event", kind: "toast", level: "error", text: "EARLY-WRITE-LINE" });

/**
 * Gap between the early write and connecting the in pipe — i.e. how long the
 * parent is held in `Promise.all` with the bytes already written and no reader
 * attached.
 *
 * Any gap loses the bytes under a Bun parent — measured 3/3 at 300 ms and 3/3 at
 * 600 ms, all `Handshake not received within 8000 ms`. Under a NODE parent (the
 * vitest worker) no gap loses them: 300/600/1000/1500 ms were all green pre-fix,
 * because Node's server socket stays at `readableFlowing === null` and buffers.
 * That is why the test drives this child through a Bun parent
 * (`early-write-parent-driver.ts`) rather than calling `spawnAgentTui` directly.
 */
const IN_PIPE_DELAY_MS = Number.parseInt(process.env.MUONROI_HARNESS_TEST_IN_DELAY_MS ?? "", 10) || 600;

function connect(path: string, label: string): Promise<Socket> {
  return new Promise((res, rej) => {
    const sock = createConnection(path);
    sock.once("connect", () => res(sock));
    sock.once("error", (err) => rej(new Error(`${label} pipe: ${err.message}`)));
  });
}

try {
  const outSock = await connect(outPipe, "out");
  // THE EARLY WRITE: the parent has one connected pipe and is still awaiting the
  // other, so no handshake reader exists yet.
  outSock.write(`${JSON.stringify({ t: "handshake", ok: true })}\n${AFTER_HANDSHAKE}\n`);

  setTimeout(() => {
    connect(inPipe, "in")
      .then((inSock) => {
        // Consume the command channel so the parent's writes never back up.
        inSock.on("data", () => {});
      })
      .catch((err) => {
        process.stderr.write(`[early-write-child] in pipe failed: ${err.message}\n`);
        process.exit(4);
      });
  }, IN_PIPE_DELAY_MS);
} catch (err) {
  process.stderr.write(`[early-write-child] connect failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
}

// Hold the process open so the parent observes a live child, as the real
// agent-mode transport would, until it is killed in teardown.
setInterval(() => {}, 1_000);
