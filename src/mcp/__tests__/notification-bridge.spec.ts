import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import {
  detectBridgeCapabilities,
  EVENTS_RESOURCE_URI,
  NotificationBridge,
} from "@muonroi/agent-harness-core/notification-bridge";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";

/** Captured calls across all three push channels. */
type FakeTrace = {
  logMessages: Array<{ level: string; data: unknown }>;
  resourceUpdates: string[];
  samplingRequests: unknown[];
};

/**
 * Minimal fake McpServer capturing notifications/sampling so the bridge can be
 * exercised without a real transport. Only the surface the bridge touches is
 * implemented (sendLoggingMessage on the high-level wrapper; sendResourceUpdated
 * + createMessage on the low-level `server`).
 */
function makeFakeServer(
  createMessageImpl:
    | ((params: unknown) => Promise<{ role: string; content: { type: string; text: string } }>)
    | null = null,
): FakeTrace & { server: McpServer } {
  const trace: FakeTrace = { logMessages: [], resourceUpdates: [], samplingRequests: [] };
  const lowLevel = {
    sendResourceUpdated: async (params: { uri: string }) => {
      trace.resourceUpdates.push(params.uri);
    },
    createMessage: async (params: unknown) => {
      trace.samplingRequests.push(params);
      if (createMessageImpl) return createMessageImpl(params);
      throw new Error("sampling not supported");
    },
  };
  const server = {
    sendLoggingMessage: async (params: { level: string; data: unknown }) => {
      trace.logMessages.push({ level: params.level, data: params.data });
    },
    server: lowLevel,
  } as unknown as McpServer;
  return Object.assign(trace, { server });
}

/** A driver whose events() yields a scripted list then closes. */
function scriptedDriver(events: LiveEvent[]): Driver {
  let i = 0;
  return {
    snapshot: () => null,
    changes_since: () => null,
    press: () => {},
    press_sequence: () => {},
    type: () => {},
    focus: () => {},
    wait_for: async () => undefined,
    query: () => null,
    queryAll: () => [],
    count: () => 0,
    expect: () => true,
    last_event: (() => null) as Driver["last_event"],
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          i < events.length ? { value: events[i++], done: false as const } : { value: undefined, done: true as const },
        return: async () => ({ value: undefined, done: true as const }),
      }),
    }),
    render_text: () => "",
    snapshot_visual: () => null,
    render_visual: () => "",
    visual_cell: () => null,
    visual_quality: () => null,
    _ingest: () => {},
    _closeAllSubscribers: () => {},
  } as Driver;
}

describe("detectBridgeCapabilities", () => {
  it("reports logging + resources as always-on (server-side features)", () => {
    const caps = detectBridgeCapabilities(undefined);
    expect(caps.logging).toBe(true);
    expect(caps.resources).toBe(true);
    expect(caps.sampling).toBe(false);
  });

  it("reflects client-advertised sampling", () => {
    const caps = detectBridgeCapabilities({ sampling: {} } as any);
    expect(caps.sampling).toBe(true);
  });
});

describe("NotificationBridge", () => {
  it("emits a debug log message for rich event kinds", async () => {
    const fake = makeFakeServer();
    const driver = scriptedDriver([
      { t: "event", kind: "council-step", phaseId: "p1", phaseKind: "x", state: "done", label: "X" } as LiveEvent,
    ]);
    const bridge = new NotificationBridge(
      fake.server,
      driver,
      { logging: true, resources: false, sampling: false },
      { pushMode: false },
    );
    const stop = bridge.start();
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(fake.logMessages.length).toBeGreaterThanOrEqual(1);
    expect((fake.logMessages[0].data as { kind?: string }).kind).toBe("council-step");
  });

  it("emits a resource-updated notification (throttled) for the events resource", async () => {
    const fake = makeFakeServer();
    const driver = scriptedDriver([
      { t: "event", kind: "council-speaker", role: "A", status: "start", correlationId: "c1" } as LiveEvent,
      { t: "event", kind: "council-speaker", role: "A", status: "tick", correlationId: "c1" } as LiveEvent,
    ]);
    const bridge = new NotificationBridge(
      fake.server,
      driver,
      { logging: false, resources: true, sampling: false },
      { pushMode: false, resourceThrottleMs: 0 },
    );
    const stop = bridge.start();
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(fake.resourceUpdates.length).toBeGreaterThanOrEqual(1);
    expect(fake.resourceUpdates[0]).toBe(EVENTS_RESOURCE_URI);
  });

  it("sends sampling/createMessage on terminal events when pushMode + sampling supported", async () => {
    const fake = makeFakeServer(async () => ({ role: "assistant", content: { type: "text", text: "noop" } }));
    const driver = scriptedDriver([
      { t: "event", kind: "council-step", phaseId: "p1", phaseKind: "x", state: "done", label: "X" } as LiveEvent,
    ]);
    const bridge = new NotificationBridge(
      fake.server,
      driver,
      { logging: false, resources: false, sampling: true },
      { pushMode: true },
    );
    const stop = bridge.start();
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(fake.samplingRequests.length).toBe(1);
  });

  it("disables sampling after the first failure (no retry storm)", async () => {
    // createMessage throws (default fake) → sampling disabled after first attempt.
    const fake = makeFakeServer();
    const driver = scriptedDriver([
      { t: "event", kind: "council-step", phaseId: "p1", phaseKind: "x", state: "done", label: "X" } as LiveEvent,
      { t: "event", kind: "council-step", phaseId: "p2", phaseKind: "x", state: "done", label: "Y" } as LiveEvent,
    ]);
    const bridge = new NotificationBridge(
      fake.server,
      driver,
      { logging: false, resources: false, sampling: true },
      { pushMode: true },
    );
    const stop = bridge.start();
    await new Promise((r) => setTimeout(r, 20));
    stop();
    // Only ONE attempt — the second terminal event is skipped after the disable.
    expect(fake.samplingRequests.length).toBe(1);
  });

  it("does not send sampling when pushMode is off even if the client supports it", async () => {
    const fake = makeFakeServer(async () => ({ role: "assistant", content: { type: "text", text: "noop" } }));
    const driver = scriptedDriver([
      { t: "event", kind: "council-step", phaseId: "p1", phaseKind: "x", state: "done", label: "X" } as LiveEvent,
    ]);
    const bridge = new NotificationBridge(
      fake.server,
      driver,
      { logging: false, resources: false, sampling: true },
      { pushMode: false },
    );
    const stop = bridge.start();
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(fake.samplingRequests.length).toBe(0);
  });
});
