import { PLATFORM_ID } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticSnapshotService } from "../src/snapshot.service.js";

// ---------------------------------------------------------------------------
// Task 4.6a — Platform guard for SSR
// ---------------------------------------------------------------------------

function createFakeTransport() {
  return {
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    close: vi.fn(),
    get readyState() {
      return 1;
    },
  };
}

describe("SemanticSnapshotService — SSR safety (PLATFORM_ID=server)", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        // Simulate Angular Universal / server platform.
        { provide: PLATFORM_ID, useValue: "server" },
      ],
    });
  });

  afterEach(() => {
    TestBed.inject(SemanticSnapshotService).stop();
    TestBed.resetTestingModule();
  });

  it("injects without throwing on server platform", () => {
    expect(() => TestBed.inject(SemanticSnapshotService)).not.toThrow();
  });

  it("start() is a no-op on server platform — does not call transport.send", () => {
    const svc = TestBed.inject(SemanticSnapshotService);
    const transport = createFakeTransport();

    // Should not throw and should not open any network handles.
    expect(() => svc.start(transport as unknown as Parameters<typeof svc.start>[0])).not.toThrow();

    // Verify no frames were sent (no setInterval scheduled).
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("stop() does not throw when start() was a no-op", () => {
    const svc = TestBed.inject(SemanticSnapshotService);
    const transport = createFakeTransport();
    svc.start(transport as unknown as Parameters<typeof svc.start>[0]);
    expect(() => svc.stop()).not.toThrow();
  });
});
