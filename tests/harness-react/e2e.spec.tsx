/**
 * e2e.spec.tsx — End-to-end test for @muonroi/agent-harness-react WS transport.
 *
 * Contract proved:
 * 1. Registry node with id="root-button" role="button" is captured by installReactHarness.
 * 2. installReactHarness sends a WsEnvelope: { dir:"frame", mode:"live", nodes:[...] }
 * 3. A real ws server receives and parses the envelope.
 * 4. Frame dedup: same content → no duplicate frames within idle ticks.
 * 5. Unregistering the node → next tick emits a frame with empty nodes array.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket as WsSocket } from "ws";
import { WebSocketServer, WebSocket as WS } from "ws";
import { createSemanticRegistry } from "../../packages/agent-harness-core/src/registry.js";
import { installReactHarness } from "../../packages/agent-harness-react/src/install.js";

// ---------------------------------------------------------------------------
// WebSocket server setup — single server, reused across all tests
// ---------------------------------------------------------------------------

let wss: WebSocketServer;
let serverPort: number;

// Buffer of all received messages keyed by connection index
const allServerMessages: Array<{ clientIndex: number; data: unknown }> = [];
let clientIndex = 0;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      if (addr && typeof addr === "object") {
        serverPort = addr.port;
      }

      // Set up connection handler ONCE — captures all incoming clients
      wss.on("connection", (socket: WsSocket) => {
        const myIndex = clientIndex++;
        socket.on("message", (data: Buffer) => {
          try {
            allServerMessages.push({ clientIndex: myIndex, data: JSON.parse(data.toString("utf8")) });
          } catch {
            // skip malformed
          }
        });
      });

      resolve();
    });
    wss.on("error", reject);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss?.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Helper: create a WS client transport + isolated frame collection
// ---------------------------------------------------------------------------

async function openTransport(): Promise<{
  transport: { send(line: string): void; close(): void };
  myClientIndex: number;
}> {
  const myIndex = clientIndex; // the NEXT client index that will be assigned on connection
  const ws = new WS(`ws://127.0.0.1:${serverPort}?token=test`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  // At this point clientIndex was incremented in the server's "connection" event
  return {
    transport: {
      send(line: string) {
        if (ws.readyState === WS.OPEN) ws.send(line);
      },
      close() {
        ws.close();
      },
    },
    myClientIndex: myIndex,
  };
}

function framesFor(myClientIndex: number): unknown[] {
  return allServerMessages.filter((m) => m.clientIndex === myClientIndex).map((m) => m.data);
}

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

describe("React harness WS transport E2E", () => {
  it("server receives frame with id=root-button after registry.register()", async () => {
    const r = createSemanticRegistry();
    const { transport, myClientIndex } = await openTransport();

    // Register a node
    const unregister = r.register({ id: "root-button", role: "button", name: "Click me" });
    const handle = installReactHarness({ registry: r, transport, fps: 50 });

    // Wait for a frame to arrive
    const deadline = Date.now() + 3000;
    while (framesFor(myClientIndex).length === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 20));
    }

    const frames = framesFor(myClientIndex);
    expect(frames.length).toBeGreaterThanOrEqual(1);

    const frame = frames[0] as {
      dir: string;
      mode: string;
      nodes: Array<{ id: string; role: string; name?: string }>;
    };

    // Verify WsEnvelope contract
    expect(frame.dir).toBe("frame");
    expect(frame.mode).toBe("live");
    expect(frame.nodes).toHaveLength(1);
    expect(frame.nodes[0].id).toBe("root-button");
    expect(frame.nodes[0].role).toBe("button");
    expect(frame.nodes[0].name).toBe("Click me");

    // Unregister → next tick emits empty nodes
    const countBefore = frames.length;
    unregister();

    const deadline2 = Date.now() + 3000;
    while (framesFor(myClientIndex).length <= countBefore && Date.now() < deadline2) {
      await new Promise((res) => setTimeout(res, 20));
    }

    const latestFrames = framesFor(myClientIndex);
    const lastFrame = latestFrames[latestFrames.length - 1] as {
      dir: string;
      nodes: unknown[];
    };
    expect(lastFrame.dir).toBe("frame");
    expect(lastFrame.nodes).toHaveLength(0);

    handle.uninstall();
    transport.close();
  }, 10_000);

  it("dedup: same registry content → exactly 1 frame emitted over multiple ticks", async () => {
    const r = createSemanticRegistry();
    const { transport, myClientIndex } = await openTransport();

    const unregister = r.register({ id: "dup-node", role: "button" });
    const handle = installReactHarness({ registry: r, transport, fps: 50 });

    // Wait for first frame (~20ms at 50fps)
    const deadline = Date.now() + 3000;
    while (framesFor(myClientIndex).length === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(framesFor(myClientIndex).length).toBeGreaterThanOrEqual(1);

    // Let ~10 more ticks pass (200ms at 50fps) with NO registry changes
    await new Promise((res) => setTimeout(res, 200));

    // Dedup: still exactly 1 frame (no changes, hash matches)
    expect(framesFor(myClientIndex).length).toBe(1);

    unregister();
    handle.uninstall();
    transport.close();
  }, 10_000);
});
