/**
 * WS transport verification (no browser required).
 * Mimics the browser-side snapshot loop: connects to the assert server,
 * sends 2 frames (mount + unmount) with dedup, then closes.
 */
import WebSocket from "ws";
import { createRegistry } from "./src/registry";

const PORT = 7777;
const PROTOCOL_VERSION = "0.1.0" as const;
const registry = createRegistry();
let lastHash = "";
let seq = 0;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

ws.on("open", () => {
  function sendIfChanged() {
    const nodes = registry.snapshot();
    const hash = JSON.stringify(nodes);
    if (hash === lastHash) return;
    lastHash = hash;
    const frame = { mode: "live" as const, version: PROTOCOL_VERSION, seq: ++seq, ts: Date.now(), nodes };
    ws.send(JSON.stringify(frame));
  }

  // Frame 1: mount btn
  const unregister = registry.register({ id: "btn", role: "button", name: "Click" });
  sendIfChanged();

  // No-op (dedup)
  sendIfChanged();

  // Frame 2: unmount btn (after 200ms to give server time to log frame 1)
  setTimeout(() => {
    unregister();
    sendIfChanged();
    // No-op (dedup)
    sendIfChanged();
    // Close after 200ms more
    setTimeout(() => ws.close(), 200);
  }, 200);
});

ws.on("error", (err) => {
  console.error("WS error:", err.message);
  process.exit(1);
});
