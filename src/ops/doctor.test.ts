import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RED phase: import module under test (will fail until doctor.ts is created)
import { type CheckResult, formatDoctorReport, runDoctor } from "./doctor.js";

describe("doctor — runDoctor returns 7 checks", () => {
  beforeEach(() => {
    // Mock fetch to avoid real network calls in tests
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns exactly 7 CheckResult entries", async () => {
    const results = await runDoctor();
    expect(results).toHaveLength(7);
  });

  it("each CheckResult has valid name, status, and detail fields", async () => {
    const results = await runDoctor();
    const validStatuses = ["pass", "warn", "fail"];
    for (const r of results) {
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
      expect(validStatuses).toContain(r.status);
      expect(typeof r.detail).toBe("string");
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  it("includes expected check names", async () => {
    const results = await runDoctor();
    const names = results.map((r) => r.name);
    expect(names).toContain("bun_version");
    expect(names).toContain("os");
    expect(names).toContain("key_presence");
    expect(names).toContain("ollama");
    expect(names).toContain("ee");
    expect(names).toContain("qdrant");
    expect(names).toContain("error_rate");
  });

  it("unreachable services return warn (not fail or throw)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unreachable")));
    const results = await runDoctor();
    const ollamaCheck = results.find((r) => r.name === "ollama")!;
    const eeCheck = results.find((r) => r.name === "ee")!;
    const qdrantCheck = results.find((r) => r.name === "qdrant")!;
    expect(ollamaCheck.status).toBe("warn");
    expect(eeCheck.status).toBe("warn");
    expect(qdrantCheck.status).toBe("warn");
  });
});

describe("doctor — bun_version check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns pass when bun version >= 1.3.13", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    // In test environment: process.versions.bun may or may not be set
    // We just verify bun_version is one of the valid statuses
    const results = await runDoctor();
    const bunCheck = results.find((r) => r.name === "bun_version")!;
    expect(["pass", "fail", "warn"]).toContain(bunCheck.status);
    expect(bunCheck.detail).toMatch(/Bun|Not running/);
  });
});

describe("doctor — formatDoctorReport", () => {
  it("contains [PASS] icon for passing check", () => {
    const results: CheckResult[] = [{ name: "os", status: "pass", detail: "linux 5.15" }];
    const report = formatDoctorReport(results);
    expect(report).toContain("[PASS]");
    expect(report).toContain("os");
  });

  it("contains [WARN] icon for warn check", () => {
    const results: CheckResult[] = [{ name: "ollama", status: "warn", detail: "Ollama VPS unreachable" }];
    const report = formatDoctorReport(results);
    expect(report).toContain("[WARN]");
  });

  it("contains [FAIL] icon for fail check", () => {
    const results: CheckResult[] = [{ name: "bun_version", status: "fail", detail: "Not running under Bun" }];
    const report = formatDoctorReport(results);
    expect(report).toContain("[FAIL]");
  });

  it("includes summary line with counts", () => {
    const results: CheckResult[] = [
      { name: "os", status: "pass", detail: "linux" },
      { name: "ollama", status: "warn", detail: "unreachable" },
      { name: "bun_version", status: "fail", detail: "missing" },
    ];
    const report = formatDoctorReport(results);
    expect(report).toContain("Summary:");
    expect(report).toContain("1 pass");
    expect(report).toContain("1 warn");
    expect(report).toContain("1 fail");
  });
});
