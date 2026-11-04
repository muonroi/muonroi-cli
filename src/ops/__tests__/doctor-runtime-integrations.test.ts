import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordIntegrationHealth } from "../../utils/integration-health.js";
import { checkRuntimeIntegrations } from "../doctor.js";

describe("doctor recorded integration diagnostics", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-journal-"));
    vi.stubEnv("MUONROI_CLI_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("does not certify integrations without observations", () => {
    expect(checkRuntimeIntegrations()).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("No recent integration observations"),
    });
  });
  it("surfaces repeated auth/PIL failures with observed timestamps without dumping response bodies", () => {
    for (let n = 0; n < 3; n++)
      recordIntegrationHealth({
        component: "mcp:fixture",
        check: "authentication",
        status: "unavailable",
        detail: "PRIVATE_RESPONSE_SENTINEL",
      });
    recordIntegrationHealth({
      component: "pil",
      check: "background-enrichment",
      status: "degraded",
      detail: "timeout",
      phase: "layer5-context-enrichment",
      durationMs: 3500,
    });
    const result = checkRuntimeIntegrations();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("mcp:fixture/authentication=unavailable (3/3; last ");
    expect(result.detail).toContain("pil/background-enrichment=degraded");
    expect(result.detail).toContain("phase layer5-context-enrichment; 3500ms");
    expect(result.detail).not.toContain("PRIVATE_RESPONSE_SENTINEL");
    expect(result.detail).toContain("No live probe");
  });
  it("uses the latest observation for a recovered check and keeps its history", () => {
    recordIntegrationHealth({ component: "mcp:fixture", check: "connection", status: "unavailable", detail: "old" });
    recordIntegrationHealth({ component: "mcp:fixture", check: "connection", status: "ready", detail: "recovered" });
    expect(checkRuntimeIntegrations()).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("2 observations/24h"),
    });
  });
});
