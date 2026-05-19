/**
 * Task 4.7 — E2E test for @muonroi/agent-harness-angular
 *
 * Strategy: Bootstrap a minimal Angular standalone component in TestBed (jsdom),
 * run the SemanticSnapshotService against a live WebSocket server, and assert
 * the server receives a {dir:"frame", ...} envelope containing the expected nodes.
 *
 * Per spike findings: DO NOT attempt ng serve + Playwright — times out on Windows.
 * TestBed in jsdom is the canonical Angular testing pattern and is fast.
 *
 * We use the `ws` package (devDependency in agent-harness-core) as the WS server.
 * The Angular side uses `createWebSocketTransport` from core with the `ws` package
 * as the WebSocketImpl polyfill (required in Node environments).
 */

import { createServer } from "node:http";
import { resolve } from "node:path";
import { Component, PLATFORM_ID } from "@angular/core";
import { fakeAsync, flush, TestBed, tick } from "@angular/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as WsImpl } from "ws";
import "zone.js";

import { SemanticRegistryService } from "../../packages/agent-harness-angular/src/registry.service.js";
// Resolve Angular package to this test file's node_modules via workspace.
// These imports work in vitest with the alias config in vitest.harness-angular.config.ts.
import { SemanticDirective } from "../../packages/agent-harness-angular/src/semantic.directive.js";
import { SemanticSnapshotService } from "../../packages/agent-harness-angular/src/snapshot.service.js";
import type { FrameEnvelope } from "../../packages/agent-harness-core/src/transports/ws.js";
import { createWebSocketTransport } from "../../packages/agent-harness-core/src/transports/ws.js";

// ---------------------------------------------------------------------------
// Fixture component — minimal standalone app with one semantic button
// ---------------------------------------------------------------------------

@Component({
  selector: "fixture-root",
  standalone: true,
  imports: [SemanticDirective],
  template: `<button muonroiSemantic id="root-button" role="button">Click</button>`,
})
class FixtureRootComponent {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// E2E spec
// ---------------------------------------------------------------------------

describe("Angular adapter E2E — WS transport", () => {
  let wss: WebSocketServer;
  let port: number;
  let receivedMessages: string[] = [];
  const TOKEN = "test-e2e-token";

  beforeAll(async () => {
    port = await pickFreePort();
    receivedMessages = [];

    wss = new WebSocketServer({ host: "127.0.0.1", port });

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", `http://127.0.0.1:${port}`);
      const token = url.searchParams.get("token");
      if (token !== TOKEN) {
        ws.close(4001, "Unauthorized");
        return;
      }
      ws.on("message", (data) => {
        receivedMessages.push(data.toString());
      });
    });

    await new Promise<void>((res) => wss.once("listening", res));
  });

  afterAll(async () => {
    await new Promise<void>((res) => wss.close(() => res()));
  });

  it("server receives a frame envelope with id=root-button and role=button", async () => {
    TestBed.configureTestingModule({
      imports: [FixtureRootComponent],
      providers: [{ provide: PLATFORM_ID, useValue: "browser" }],
    });

    const fixture = TestBed.createComponent(FixtureRootComponent);
    fixture.detectChanges();

    // Create WS transport using the ws package as the WS implementation.
    const transport = createWebSocketTransport({
      url: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      WebSocketImpl: WsImpl as unknown as typeof globalThis.WebSocket,
    });

    // Wait for WS to open.
    await new Promise<void>((res, rej) => {
      const tid = setTimeout(() => rej(new Error("WS open timeout")), 5000);
      const unsub = transport.onError((err) => {
        clearTimeout(tid);
        unsub();
        rej(err);
      });
      if (transport.readyState === 1) {
        clearTimeout(tid);
        unsub();
        res();
        return;
      }
      // Poll readyState — ws opens asynchronously.
      const poll = setInterval(() => {
        if (transport.readyState === 1) {
          clearInterval(poll);
          clearTimeout(tid);
          unsub();
          res();
        }
      }, 10);
    });

    // Start snapshot service.
    const snapshotSvc = TestBed.inject(SemanticSnapshotService);
    snapshotSvc.start(transport, 30);

    // Wait for at least one frame to arrive at the server (max 500ms).
    await new Promise<void>((res, rej) => {
      const tid = setTimeout(() => {
        if (receivedMessages.length > 0) res();
        else rej(new Error("No WS messages received within 500ms"));
      }, 500);
    });

    snapshotSvc.stop();
    transport.close();
    fixture.destroy();

    // Parse received frames and find a frame envelope.
    const frames = receivedMessages
      .map((raw) => {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((m): m is Record<string, unknown> => m !== null && m["dir"] === "frame");

    expect(frames.length).toBeGreaterThan(0);

    const frame = frames[0] as FrameEnvelope;
    expect(frame.mode).toBe("live");
    expect(frame.version).toBe("0.3.0");

    // Find root-button node somewhere in the tree.
    function findNode(nodes: FrameEnvelope["nodes"], id: string): (typeof nodes)[number] | undefined {
      for (const n of nodes) {
        if (n.id === id) return n;
        if (n.children) {
          const found = findNode(n.children, id);
          if (found) return found;
        }
      }
      return undefined;
    }

    const btn = findNode(frame.nodes, "root-button");
    expect(btn).toBeDefined();
    expect(btn?.role).toBe("button");
  });
});
