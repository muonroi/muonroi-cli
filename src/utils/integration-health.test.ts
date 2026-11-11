import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpIdentityEnvironment } from "../mcp/runtime.js";
import { integrationHealth, observeShellReadiness, recordIntegrationHealth } from "./integration-health.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-health-"));
  vi.stubEnv("MUONROI_CLI_HOME", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
describe("observed integration readiness", () => {
  it("keeps tool failure separate from a successful connection and survives a fresh read", () => {
    expect(integrationHealth().status).toBe("unknown");
    recordIntegrationHealth({ component: "mcp:fixture", check: "connection", status: "ready", detail: "connected" });
    recordIntegrationHealth({
      component: "mcp:fixture",
      check: "tool:search",
      status: "unavailable",
      detail: "identity_required",
    });
    recordIntegrationHealth({ component: "mcp:fixture", check: "connection", status: "ready", detail: "reconnected" });
    const status = integrationHealth();
    expect(status.status).toBe("degraded");
    expect(status.checks.find((c) => c.check === "tool:search")?.failures).toBe(1);
    expect(status.observations).toBe(3);
  });
  it("captures observed exit127 JSON shell failures and records a later recovery without erasing failure count", () => {
    observeShellReadiness(
      { command: "missing-workflow" },
      JSON.stringify({ success: false, output: "command not found; exit 127" }),
      dir,
    );
    expect(integrationHealth().checks[0]).toMatchObject({ status: "unavailable", cwd: dir, failures: 1 });
    const row = integrationHealth().checks[0];
    recordIntegrationHealth({ ...row, status: "ready", detail: "actual successful check" });
    expect(integrationHealth().checks[0]?.failures).toBe(1);
  });
  it("forwards actual identity keys only, never ambient credentials", () => {
    vi.stubEnv("AG_NAME", "fixture-name");
    vi.stubEnv("AG_BUS_DB", "fixture-db");
    vi.stubEnv("SOME_API_KEY", "must-not-forward");
    expect(mcpIdentityEnvironment()).toMatchObject({ AG_NAME: "fixture-name", AG_BUS_DB: "fixture-db" });
    expect(mcpIdentityEnvironment()).not.toHaveProperty("SOME_API_KEY");
  });
});
