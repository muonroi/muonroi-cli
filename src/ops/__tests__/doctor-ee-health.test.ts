/**
 * doctor-ee-health.test.ts
 *
 * CQ-16c/16d regression tests: runDoctor reports ee.health and ee.brain
 * with mode/circuit detail and brain-emptiness bootstrap hint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock healthDetailed before doctor.ts imports it
vi.mock("../../ee/health.js", () => ({
  healthDetailed: vi.fn(),
}));

// Mock getDatabase with a minimal SQLite-like interface
const mockGet = vi.fn().mockReturnValue({ cnt: 0 });
const mockPrepare = vi.fn().mockReturnValue({ get: mockGet });
vi.mock("../../storage/db.js", () => ({
  getDatabase: vi.fn(() => ({ prepare: mockPrepare })),
}));

// Mock other external dependencies to prevent network calls in doctor
vi.mock("../../ee/intercept.js", () => ({
  getDefaultEEClient: vi.fn(() => ({
    health: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  })),
}));

import { healthDetailed } from "../../ee/health.js";
import { runDoctor } from "../doctor.js";

const healthDetailedMock = vi.mocked(healthDetailed);

const HEALTH_OK = {
  ok: true,
  status: 200,
  mode: "thin-client" as const,
  circuit: "closed" as const,
  components: {
    server: { ok: true, status: 200 },
    gates: { ok: true, status: 200 },
  },
};

describe("doctor EE health checks (CQ-16c/16d)", () => {
  beforeEach(() => {
    healthDetailedMock.mockResolvedValue(HEALTH_OK);
    mockGet.mockReturnValue({ cnt: 0 });
  });

  it("ee.health result is present in runDoctor output", async () => {
    const results = await runDoctor();
    const eeHealth = results.find((r) => r.name === "ee.health");
    expect(eeHealth).toBeDefined();
  });

  it("ee.brain result is present in runDoctor output", async () => {
    const results = await runDoctor();
    const eeBrain = results.find((r) => r.name === "ee.brain");
    expect(eeBrain).toBeDefined();
  });

  it("ee.health passes and includes mode=thin-client when EE is healthy", async () => {
    const results = await runDoctor();
    const eeHealth = results.find((r) => r.name === "ee.health");
    expect(eeHealth?.status).toBe("pass");
    expect(eeHealth?.detail).toContain("mode=thin-client");
  });

  it("ee.health warns with VPS address hint when EE unreachable (ok=false, thin-client)", async () => {
    healthDetailedMock.mockResolvedValue({
      ok: false,
      status: 0,
      mode: "thin-client",
      circuit: "open",
      components: {
        server: { ok: false, status: 0 },
        gates: { ok: false, status: 0 },
      },
    });
    const results = await runDoctor();
    const eeHealth = results.find((r) => r.name === "ee.health");
    expect(eeHealth?.status).toBe("warn");
    expect(eeHealth?.detail).toContain("72.61.127.154");
  });

  it("ee.health warns gracefully when healthDetailed throws", async () => {
    healthDetailedMock.mockRejectedValue(new Error("network timeout"));
    const results = await runDoctor();
    const eeHealth = results.find((r) => r.name === "ee.health");
    expect(eeHealth?.status).toBe("warn");
  });

  it("ee.brain passes when no_match count is 0", async () => {
    mockGet.mockReturnValue({ cnt: 0 });
    const results = await runDoctor();
    const eeBrain = results.find((r) => r.name === "ee.brain");
    expect(eeBrain?.status).toBe("pass");
  });

  it("ee.brain warns with bootstrap hint when no_match count >= 50", async () => {
    mockGet.mockReturnValue({ cnt: 50 });
    const results = await runDoctor();
    const eeBrain = results.find((r) => r.name === "ee.brain");
    expect(eeBrain?.status).toBe("warn");
    expect(eeBrain?.detail).toContain("experience extract");
  });

  it("ee.brain passes when no_match count is 49 (below threshold)", async () => {
    mockGet.mockReturnValue({ cnt: 49 });
    const results = await runDoctor();
    const eeBrain = results.find((r) => r.name === "ee.brain");
    expect(eeBrain?.status).toBe("pass");
  });
});
