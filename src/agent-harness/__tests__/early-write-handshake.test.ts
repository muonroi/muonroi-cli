/**
 * A child that writes BEFORE the parent attaches a reader must not lose those
 * bytes.
 *
 * `handshake-leftover.test.ts` covers the bytes that arrive in the same chunk as
 * the handshake. This covers the window one step earlier: between the
 * `connection` event and `waitForHandshake` attaching its `data` listener,
 * `spawnWindows` is blocked in `Promise.all` waiting for the SECOND pipe. A
 * server-side socket arrives with nothing consuming it, and under Bun it does
 * not stay that way.
 *
 * ## What was measured (Bun 1.3.13, Windows named pipes)
 *
 * Mirroring the `spawnWindows` sequence and sampling the out socket at each
 * step, with a child that writes 87 bytes immediately on connecting:
 *
 *   [out connection event]                  readableFlowing=null  readableLength=0
 *   [in connection event]                   readableFlowing=null  readableLength=0
 *   [after Promise.all, reader about to attach]
 *                                           readableFlowing=true  readableLength=0
 *   [after attaching the data listener]     readableFlowing=true  readableLength=0
 *   RESULT received=""
 *
 * The socket arrives BUFFERING (`readableFlowing === null`) and then flips
 * itself to FLOWING inside the gap with no listener attached — a flowing
 * readable with nowhere to emit discards what it receives, so the bytes are gone
 * with no error and no trace. The caller then gets a 90-second
 * `Handshake not received` throw that blames the timeout instead of the write.
 *
 * ## Why "pause on connection" is not the fix
 *
 * Do not trust Node's documented stream semantics on this runtime; this was
 * measured both ways. `pause()` in the connection handler DOES take effect
 * synchronously — `isPaused()=true`, `readableFlowing=false` on the very next
 * line — and is then undone by Bun before the bytes land:
 *
 *   before pause: isPaused=false readableFlowing=null
 *   after  pause: isPaused=true  readableFlowing=false
 *   +300ms      : isPaused=false readableFlowing=true  readableLength=0
 *
 * So a later explicit `resume()` had nothing left to deliver (received ""), and
 * attaching a `data` listener without resuming delivered nothing either. Only
 * `socket.pipe(passThrough)` in the connection handler survived: the relay held
 * `readableLength=41` with no consumer and delivered every byte to a consumer
 * attaching a second later. `pipe()` works because it resumes the socket itself
 * and only after its destination is wired, so nothing can fall into a
 * listener-less gap — the same mechanism `f448d24c` landed for the leftover
 * path, applied one step earlier.
 *
 * ## Why this test spawns a Bun parent instead of calling spawnAgentTui
 *
 * The vitest worker is NODE, not Bun — measured `typeof Bun === "undefined"`,
 * `process.versions.node === "24.18.0"` inside a test. Node's server socket
 * stays at `readableFlowing === null` and buffers, so the race cannot happen
 * there: calling `spawnAgentTui` directly from a spec was green PRE-FIX at
 * in-pipe gaps of 300, 600, 1000 and 1500 ms. A spec written that way asserts
 * nothing.
 *
 * Every production caller of `spawnAgentTui` runs under `bun run` —
 * `src/mcp/opentui-spawn.ts` (the MCP `tui.start` path) and
 * `src/self-qa/{orchestrator,agentic-loop}.ts` — so this is a shipped path the
 * Node-hosted suite is structurally blind to. `fixtures/early-write-parent-driver.ts`
 * puts the Bun parent back in the loop; pre-fix it reported
 * `{"ok":false,"error":"Handshake not received within 8000 ms"}` on 6/6 runs
 * (3 at a 300 ms in-pipe gap, 3 at 600 ms).
 *
 * Windows-only by nature: the handshake and the named-pipe servers exist only on
 * that transport. `spawnPosix` hands back fd 3/4 with no handshake at all.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DRIVER = resolve("src/agent-harness/__tests__/fixtures/early-write-parent-driver.ts");

type DriverResult = { ok: boolean; received?: string; error?: string };

/**
 * Run the Bun-parent driver and return the single RESULT line it prints.
 *
 * Its stderr is folded into the failure message: a driver that dies before
 * emitting RESULT would otherwise fail as an unhelpful parse error.
 */
async function runBunParent(timeoutMs: number, child?: string): Promise<DriverResult> {
  return new Promise<DriverResult>((res, rej) => {
    const args = child ? ["run", DRIVER, child] : ["run", DRIVER];
    const proc = spawn("bun", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      rej(new Error(`bun parent driver did not finish within ${timeoutMs} ms. stderr: ${stderr}`));
    }, timeoutMs);

    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.once("error", (err) => {
      clearTimeout(timer);
      rej(err);
    });
    proc.once("exit", () => {
      clearTimeout(timer);
      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("RESULT "));
      if (!line) {
        rej(new Error(`driver printed no RESULT line.\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      try {
        res(JSON.parse(line.slice("RESULT ".length)) as DriverResult);
      } catch (err) {
        rej(new Error(`unparsable RESULT line "${line}": ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

describe.skipIf(process.platform !== "win32")("named-pipe early write", () => {
  it("accepts a handshake written before the reader attached, and delivers what followed", async () => {
    const result = await runBunParent(45_000);

    // Pre-fix this was {ok:false, error:"Handshake not received within 8000 ms"}
    // on every run: the handshake had been discarded by the flowing socket, so
    // the reader waited out the whole timeout on a child that had already spoken.
    expect(result.ok, `spawn failed: ${result.error}`).toBe(true);

    const received = result.received ?? "";
    expect(received, `received: ${JSON.stringify(received)}`).toContain("EARLY-WRITE-LINE");
    // The handshake was consumed by the reader, not replayed to the caller.
    expect(received).not.toContain('"handshake"');
  }, 60_000);

  it("still delivers the coalesced leftover when the whole chain runs under Bun", async () => {
    // `handshake-leftover.test.ts` covers this child, but from a NODE parent, so
    // it never exercised the chained relay on the runtime whose pause/resume
    // behaviour the code reasons about. Measured here: the leftover path was
    // ALREADY correct under Bun before this change (3/3 green against the
    // pre-fix test-spawn), and stays correct after it — the capture relay's
    // `pause()` does stick, unlike the Bun socket's. This case exists so a
    // future edit to the chain cannot break Bun while Node stays green.
    const result = await runBunParent(45_000, "src/agent-harness/__tests__/fixtures/coalescing-handshake-child.ts");

    expect(result.ok, `spawn failed: ${result.error}`).toBe(true);
    const received = result.received ?? "";
    expect(received, `received: ${JSON.stringify(received)}`).toContain('"t":"idle"');
    expect(received, `received: ${JSON.stringify(received)}`).toContain("POST-HANDSHAKE-LINE");
    expect(received).not.toContain('"handshake"');
    // Order is part of the contract: the leftover is queued ahead of the live
    // stream, so the idle sentinel must still precede the event that followed it.
    expect(received.indexOf('"t":"idle"')).toBeLessThan(received.indexOf("POST-HANDSHAKE-LINE"));
  }, 60_000);
});
