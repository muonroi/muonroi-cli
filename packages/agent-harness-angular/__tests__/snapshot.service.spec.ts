import { Component, PLATFORM_ID } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WsEnvelope } from "@muonroi/agent-harness-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticRegistryService } from "../src/registry.service.js";
import { SemanticDirective } from "../src/semantic.directive.js";
import { SemanticSnapshotService } from "../src/snapshot.service.js";

// ---------------------------------------------------------------------------
// Fixture: 3 semantic nodes
// ---------------------------------------------------------------------------

@Component({
  selector: "test-three-nodes",
  standalone: true,
  imports: [SemanticDirective],
  template: `
    <div muonroiSemantic id="a" role="region">
      <span muonroiSemantic id="b" role="button"></span>
      <span muonroiSemantic id="c" role="button"></span>
    </div>
  `,
})
class ThreeNodesComponent {}

// ---------------------------------------------------------------------------
// Fake transport — captures sent envelopes
// ---------------------------------------------------------------------------

function createFakeTransport() {
  const sent: string[] = [];
  return {
    send: vi.fn((line: string) => sent.push(line)),
    onMessage: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    close: vi.fn(),
    get readyState() {
      return 1; // OPEN
    },
    sent,
  };
}

describe("SemanticSnapshotService — snapshot flush dedup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [ThreeNodesComponent],
      providers: [
        // Use real "browser" platform so SSR guard does NOT fire.
        { provide: PLATFORM_ID, useValue: "browser" },
      ],
    });
  });

  afterEach(() => {
    // Clean up service state.
    TestBed.inject(SemanticSnapshotService).stop();
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it("emits exactly 1 frame per tick when nodes are stable (dedup)", () => {
    const fixture = TestBed.createComponent(ThreeNodesComponent);
    fixture.detectChanges();

    const snapshot = TestBed.inject(SemanticSnapshotService);
    const transport = createFakeTransport();

    snapshot.start(transport as unknown as Parameters<typeof snapshot.start>[0]);

    // Advance 5 ticks of 33ms each (165ms total). The tree is stable → only 1 frame.
    vi.advanceTimersByTime(165);

    expect(transport.send).toHaveBeenCalledTimes(1);

    // Verify the frame has the right structure.
    const rawEnvelope = transport.sent[0];
    const parsed = JSON.parse(rawEnvelope) as WsEnvelope;
    expect(parsed.dir).toBe("frame");
    if (parsed.dir === "frame") {
      expect(parsed.mode).toBe("live");
      // Root node "a" should be present; "b" and "c" are children.
      expect(parsed.nodes.length).toBeGreaterThan(0);
    }
  });

  it("emits a second frame after a node is added (dedup resets)", () => {
    const fixture = TestBed.createComponent(ThreeNodesComponent);
    fixture.detectChanges();

    const registry = TestBed.inject(SemanticRegistryService);
    const snapshot = TestBed.inject(SemanticSnapshotService);
    const transport = createFakeTransport();

    snapshot.start(transport as unknown as Parameters<typeof snapshot.start>[0]);

    vi.advanceTimersByTime(33); // First emission.
    expect(transport.send).toHaveBeenCalledTimes(1);

    // Mutate tree — add a new node.
    const unregister = registry.register({ id: "d", role: "button", parentId: "a" });
    vi.advanceTimersByTime(33); // Second emission — tree changed.
    expect(transport.send).toHaveBeenCalledTimes(2);

    unregister();
    vi.advanceTimersByTime(33); // Third emission — tree changed again.
    expect(transport.send).toHaveBeenCalledTimes(3);
  });

  it("stop() cancels the interval", () => {
    const fixture = TestBed.createComponent(ThreeNodesComponent);
    fixture.detectChanges();

    const snapshot = TestBed.inject(SemanticSnapshotService);
    const transport = createFakeTransport();

    snapshot.start(transport as unknown as Parameters<typeof snapshot.start>[0]);

    vi.advanceTimersByTime(33); // First emission.
    expect(transport.send).toHaveBeenCalledTimes(1);

    snapshot.stop();

    vi.advanceTimersByTime(165); // No new emissions after stop.
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
