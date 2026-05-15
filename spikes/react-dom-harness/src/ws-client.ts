// Opens a WebSocket to the assert server and exposes a send function.
let ws: WebSocket | null = null;

function connect() {
  ws = new WebSocket("ws://127.0.0.1:7777");
  ws.onclose = () => {
    ws = null;
    setTimeout(connect, 1000);
  };
}
connect();

export function sendFrame(frame: unknown) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}
