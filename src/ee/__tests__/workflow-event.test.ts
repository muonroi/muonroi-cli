import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetWorkflowEventState, fireWorkflowEvent } from "../workflow-event.js";

describe("fireWorkflowEvent (Part C client)", () => {
  beforeEach(() => {
    _resetWorkflowEventState();
  });

  it("returns true and posts to /api/workflow-event on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const enqueueImpl = vi.fn(async () => {});
    const ok = await fireWorkflowEvent(
      { kind: "decision", phaseRef: "runs/x#scoping", payload: { a: 1 } },
      { baseUrl: "http://brain", authToken: "t", fetchImpl, enqueueImpl },
    );
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(call[0]).toBe("http://brain/api/workflow-event");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers.Authorization).toBe("Bearer t");
    expect(enqueueImpl).not.toHaveBeenCalled();
  });

  it("DROPS (does not enqueue) on a 404 — Kill #7 head-of-line poison guard", async () => {
    const fetchImpl = vi.fn(async () => new Response("disabled", { status: 404 }));
    const enqueueImpl = vi.fn(async () => {});
    const ok = await fireWorkflowEvent(
      { kind: "sprint-execution", phaseRef: "runs/x#sprint-1" },
      { baseUrl: "http://brain", fetchImpl, enqueueImpl },
    );
    expect(ok).toBe(false);
    expect(enqueueImpl).not.toHaveBeenCalled();
  });

  it("ENQUEUES on a network error for later drain", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const enqueueImpl = vi.fn(async () => {});
    const ok = await fireWorkflowEvent(
      { kind: "mistake", phaseRef: "runs/x#sprint-2" },
      { baseUrl: "http://brain", fetchImpl, enqueueImpl },
    );
    expect(ok).toBe(false);
    expect(enqueueImpl).toHaveBeenCalledOnce();
    const firstCall = enqueueImpl.mock.calls[0] as unknown as Array<{ endpoint: string; body: { kind: string } }>;
    const entry = firstCall[0]!;
    expect(entry.endpoint).toBe("/api/workflow-event");
    expect(entry.body.kind).toBe("mistake");
  });

  it("ENQUEUES on a 5xx (transient) response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 }));
    const enqueueImpl = vi.fn(async () => {});
    const ok = await fireWorkflowEvent(
      { kind: "council-debate", phaseRef: "runs/x#research" },
      { baseUrl: "http://brain", fetchImpl, enqueueImpl },
    );
    expect(ok).toBe(false);
    expect(enqueueImpl).toHaveBeenCalledOnce();
  });
});
