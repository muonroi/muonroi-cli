"use strict";

function sendResponse(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write("Content-Length: " + body.length + "\r\n\r\n" + body);
  process.stderr.write("SENT: " + body + "\n");
}

function handleMessage(msg) {
  process.stderr.write("GOT: " + JSON.stringify(msg) + "\n");
  if (msg.method === "initialize") {
    sendResponse({
      jsonrpc: "2.0", id: msg.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo-stub", version: "0.0.1" } }
    });
  } else if (msg.method === "notifications/initialized") {
    process.stderr.write("notifications/initialized received\n");
  } else if (msg.method === "tools/list") {
    sendResponse({
      jsonrpc: "2.0", id: msg.id,
      result: { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] }
    });
  } else if (msg.id !== undefined) {
    sendResponse({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

let rawBuffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  rawBuffer = Buffer.concat([rawBuffer, chunk]);
  while (true) {
    let headerEnd = -1;
    for (let i = 0; i < rawBuffer.length - 3; i++) {
      if (rawBuffer[i] === 0x0d && rawBuffer[i+1] === 0x0a && rawBuffer[i+2] === 0x0d && rawBuffer[i+3] === 0x0a) {
        headerEnd = i; break;
      }
    }
    if (headerEnd === -1) break;
    const headerStr = rawBuffer.slice(0, headerEnd).toString("utf8");
    const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) { rawBuffer = rawBuffer.slice(headerEnd + 4); break; }
    const cl = parseInt(clMatch[1], 10);
    const bs = headerEnd + 4;
    if (rawBuffer.length < bs + cl) break;
    const body = rawBuffer.slice(bs, bs + cl).toString("utf8");
    rawBuffer = rawBuffer.slice(bs + cl);
    try { handleMessage(JSON.parse(body)); } catch(e) { process.stderr.write("PARSE ERR: " + e.message + "\n"); }
  }
});
process.stdin.on("end", () => process.stderr.write("stdin closed\n"));
process.stdin.resume();
