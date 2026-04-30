import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { startStubEEServer, type StubHandle } from "../__test-stubs__/ee-server.js";
import { createEEClient } from "./client.js";
import type { FeedbackPayload } from "./types.js";

describe("EEClient feedback + touch fire-and-forget", () => {
  let stub: StubHandle;
  let ee: ReturnType<typeof createEEClient>;

  beforeAll(async () => {
    stub = await startStubEEServer({});
    ee = createEEClient({ baseUrl: `http://localhost:${stub.port}` });
  });

  afterAll(async () => {
    await stub.stop();
  });

  it("feedback() returns void synchronously; calls /api/feedback POST", async () => {
    const payload: FeedbackPayload = {
      principle_uuid: "P1",
      classification: "FOLLOWED",
      tool_name: "Edit",
      duration_ms: 42,
      tenantId: "local",
    };
    const result = ee.feedback(payload);
    expect(result).toBeUndefined();

    // Wait for fire-and-forget to land
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.calls.feedback.length).toBe(1);
    expect(stub.calls.feedback[0]).toMatchObject({
      principle_uuid: "P1",
      classification: "FOLLOWED",
    });
  });

  it("touch() returns void synchronously; calls /api/principle/touch POST", async () => {
    const result = ee.touch("P2", "local");
    expect(result).toBeUndefined();

    await new Promise((r) => setTimeout(r, 50));
    expect(stub.calls.touch.length).toBe(1);
    expect(stub.calls.touch[0]).toBe("P2");
  });

  it("feedback() never throws even on network error", () => {
    const broken = createEEClient({
      baseUrl: "http://localhost:1",
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    expect(() => broken.feedback({
      principle_uuid: "X",
      classification: "IGNORED",
      tool_name: "Bash",
      duration_ms: 0,
      tenantId: "local",
    })).not.toThrow();
  });

  it("touch() never throws even on network error", () => {
    const broken = createEEClient({
      baseUrl: "http://localhost:1",
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    expect(() => broken.touch("X", "local")).not.toThrow();
  });
});
