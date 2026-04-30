"use strict";

/**
 * Minimal stdio MCP server stub for smoke tests.
 * Handles Content-Length framed JSON-RPC 2.0 over stdin/stdout.
 */

function sendResponse(obj) {
  const body = JSON.stringify(obj);
  // Content-Length framing per JSON-RPC stdio spec
  process.stdout.write("Content-Length: " + body.length + "\r\n\r\n" + body);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    sendResponse({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-stub", version: "0.0.1" },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // notification — no response required
  } else if (msg.method === "tools/list") {
    sendResponse({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo input",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
            },
          },
        ],
      },
    });
  } else if (msg.id !== undefined) {
    // Unknown request — return empty result
    sendResponse({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

let rawBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  rawBuffer = Buffer.concat([rawBuffer, chunk]);
  while (true) {
    // Find CRLFCRLF header separator
    let headerEnd = -1;
    for (let i = 0; i < rawBuffer.length - 3; i++) {
      if (
        rawBuffer[i] === 0x0d &&
        rawBuffer[i + 1] === 0x0a &&
        rawBuffer[i + 2] === 0x0d &&
        rawBuffer[i + 3] === 0x0a
      ) {
        headerEnd = i;
        break;
      }
    }
    if (headerEnd === -1) break;

    const headerStr = rawBuffer.slice(0, headerEnd).toString("utf8");
    const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) {
      rawBuffer = rawBuffer.slice(headerEnd + 4);
      break;
    }
    const cl = parseInt(clMatch[1], 10);
    const bs = headerEnd + 4;
    if (rawBuffer.length < bs + cl) break;

    const body = rawBuffer.slice(bs, bs + cl).toString("utf8");
    rawBuffer = rawBuffer.slice(bs + cl);
    try {
      handleMessage(JSON.parse(body));
    } catch {
      // Ignore parse errors
    }
  }
});

process.stdin.resume();
