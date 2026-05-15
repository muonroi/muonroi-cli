import WebSocket from "ws";
import type { LiveFrame } from "./snapshot-loop";

const PORT = 7778;

/**
 * Opens a WebSocket connection to the local server (port 7778) and sends
 * each LiveFrame as a JSON string. Reconnects once on close.
 */
export function createWsTransport(url = `ws://127.0.0.1:${PORT}`): (frame: LiveFrame) => void {
  let ws: WebSocket | null = null;
  const queue: string[] = [];

  function connect(): void {
    ws = new WebSocket(url);
    ws.on("open", () => {
      for (const msg of queue) ws!.send(msg);
      queue.length = 0;
    });
    ws.on("close", () => {
      ws = null;
    });
    ws.on("error", (err) => {
      console.error("[ws-client] error:", err.message);
    });
  }

  connect();

  return (frame: LiveFrame) => {
    const msg = JSON.stringify(frame);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      queue.push(msg);
    }
  };
}
