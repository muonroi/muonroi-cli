import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ baseUrl: "https://fixture.invalid/brain" }));
vi.mock("./auth.js", () => ({
  loadEEAuthToken: async () => "private-token",
  getCachedServerBaseUrl: () => config.baseUrl,
}));
vi.mock("./client.js", () => ({ createEEClient: vi.fn(() => ({ health: async () => ({ ok: true, status: 200 }) })) }));

import { healthEE } from "./search.js";

describe("EE health contract", () => {
  beforeEach(() => {
    config.baseUrl = "https://fixture.invalid/brain";
  });
  it("identifies the probed endpoint and does not claim recall readiness", async () => {
    const result = await healthEE();
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      check: "reachability",
      endpoint: "https://fixture.invalid/brain/health",
      recallReady: "not_checked",
    });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("omits endpoint credentials and query parameters from diagnostics", async () => {
    config.baseUrl = "https://username:private-password@fixture.invalid/brain?token=private-query";
    const result = await healthEE();
    expect(result.endpoint).toBe("https://fixture.invalid/brain");
    expect(JSON.stringify(result)).not.toMatch(/private-|username/);
  });
  it("reports malformed endpoint configuration as unavailable", async () => {
    config.baseUrl = "not-a-url";
    expect(await healthEE()).toMatchObject({ ok: false, status: 0, endpoint: "invalid-config" });
  });
});
