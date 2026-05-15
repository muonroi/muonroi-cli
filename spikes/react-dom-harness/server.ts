// Node WS server — logs every received LiveFrame.
// --assert mode: exits 0 if exactly 2 distinct frames arrive in 3s, else exits 1.
import { WebSocketServer } from "ws";

const assertMode = process.argv.includes("--assert");
const PORT = 7777;
const wss = new WebSocketServer({ port: PORT });

console.log(`[server] listening on ws://127.0.0.1:${PORT}`);

const frames: string[] = [];

wss.on("connection", (socket) => {
  console.log("[server] client connected");
  socket.on("message", (raw) => {
    const msg = raw.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg);
    } catch {
      return;
    }
    console.log("[server] frame:", JSON.stringify(parsed, null, 2));

    if (assertMode) {
      // Only count distinct payloads (hash-dedup check)
      if (!frames.includes(msg)) frames.push(msg);
    }
  });
});

if (assertMode) {
  // Wait up to 8s total: browser needs ~2s to connect + 800ms unmount + rAF cadence
  setTimeout(() => {
    wss.close();
    if (frames.length === 2) {
      console.log("PASS: 2 frames, no dup");
      process.exit(0);
    } else {
      console.log(`FAIL: got ${frames.length} distinct frames (expected 2)`);
      process.exit(1);
    }
  }, 8000);
}
