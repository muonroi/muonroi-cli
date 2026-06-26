import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// RED phase: import module under test (will fail until bug-report.ts is created)
import { type BugReportBundle, buildBugReport, formatBugReport } from "./bug-report.js";

const mockFiles = new Map<string, string | Error>();

// Mock fs/promises for controlled test environment
vi.mock("fs/promises", () => {
  const actual = require("fs/promises");
  return {
    ...actual,
    readFile: vi.fn(async (filePath: any, options?: any) => {
      const pathStr = String(filePath).replace(/\\/g, "/");
      // Only intercept our mocked config and log paths to prevent leaking to other tests
      if (pathStr.endsWith("config.json") && mockFiles.has("config.json")) {
        const val = mockFiles.get("config.json");
        if (val instanceof Error) throw val;
        return val;
      }
      if (pathStr.endsWith("errors.log") && mockFiles.has("errors.log")) {
        const val = mockFiles.get("errors.log");
        if (val instanceof Error) throw val;
        return val;
      }
      return actual.readFile(filePath, options);
    }),
  };
});

// Mock runDoctor to avoid real network calls
vi.mock("./doctor.js", () => ({
  runDoctor: vi.fn(() =>
    Promise.resolve([
      { name: "bun_version", status: "pass", detail: "Bun 1.3.13" },
      { name: "os", status: "pass", detail: "linux 5.15" },
      { name: "key_presence", status: "pass", detail: "API key in env" },
      { name: "ollama", status: "warn", detail: "Ollama unreachable" },
      { name: "ee", status: "warn", detail: "EE unreachable" },
      { name: "qdrant", status: "warn", detail: "Qdrant unreachable" },
      { name: "error_rate", status: "pass", detail: "0 errors in last 24h" },
    ]),
  ),
}));

// Mock EE health to avoid real network calls
vi.mock("../ee/health.js", () => ({
  health: vi.fn(() => Promise.resolve({ ok: false, status: 503 })),
}));

describe("buildBugReport — required sections", () => {
  beforeEach(() => {
    mockFiles.clear();
    // Default: no config, no error log (ENOENT)
    mockFiles.set("config.json", new Error("ENOENT: file not found"));
    mockFiles.set("errors.log", new Error("ENOENT: file not found"));
  });

  afterEach(() => {
    mockFiles.clear();
  });

  it("returns all required sections", async () => {
    const bundle = await buildBugReport();
    expect(bundle).toHaveProperty("generated_at");
    expect(bundle).toHaveProperty("bun_version");
    expect(bundle).toHaveProperty("os");
    expect(bundle).toHaveProperty("doctor");
    expect(bundle).toHaveProperty("config_redacted");
    expect(bundle).toHaveProperty("error_log_tail");
    expect(bundle.os).toHaveProperty("platform");
    expect(bundle.os).toHaveProperty("release");
    expect(bundle.os).toHaveProperty("arch");
  });

  it("generated_at is a valid ISO 8601 timestamp", async () => {
    const bundle = await buildBugReport();
    expect(() => new Date(bundle.generated_at)).not.toThrow();
    expect(new Date(bundle.generated_at).toISOString()).toBe(bundle.generated_at);
  });

  it("doctor results contain 7 entries from runDoctor()", async () => {
    const bundle = await buildBugReport();
    expect(bundle.doctor).toHaveLength(7);
  });
});

describe("buildBugReport — config_redacted does NOT contain authToken", () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  afterEach(() => {
    mockFiles.clear();
  });

  it("config_redacted excludes ee.authToken and includes cap.monthly_usd", async () => {
    const mockConfig = JSON.stringify({
      ee: { authToken: "secret-token-123456" },
      cap: { monthly_usd: 15 },
      router: { confidence_threshold: 0.55 },
    });
    mockFiles.set("config.json", mockConfig);
    mockFiles.set("errors.log", new Error("ENOENT: file not found"));

    const bundle = await buildBugReport();

    // Should include cap.monthly_usd
    expect(bundle.config_redacted["cap.monthly_usd"]).toBe(15);

    // Should NOT contain the auth token value anywhere in the bundle JSON
    const bundleJson = JSON.stringify(bundle);
    expect(bundleJson).not.toContain("secret-token-123456");

    // Should NOT have authToken as a key
    expect(Object.keys(bundle.config_redacted)).not.toContain("authToken");
    expect(Object.keys(bundle.config_redacted)).not.toContain("ee.authToken");
  });
});

describe("buildBugReport — error_log_tail scrubs API keys", () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  afterEach(() => {
    mockFiles.clear();
  });

  it("scrubs sk-ant-* keys from error log lines", async () => {
    const errorLogContent = [
      "2026-04-30T10:00:00Z Error calling sk-ant-abc123def456ghi789xyz at /api",
      "2026-04-30T10:01:00Z Normal log line without secrets",
    ].join("\n");

    mockFiles.set("errors.log", errorLogContent);
    mockFiles.set("config.json", new Error("ENOENT: file not found"));

    const bundle = await buildBugReport();

    // The error log tail should not contain the original API key
    expect(bundle.error_log_tail.join(" ")).not.toContain("sk-ant-abc123def456ghi789xyz");
    // Should have 2 lines from the log
    expect(bundle.error_log_tail).toHaveLength(2);
    // First line should be redacted (contains ***REDACTED***)
    expect(bundle.error_log_tail[0]).toContain("***REDACTED***");
    // Normal line should be intact
    expect(bundle.error_log_tail[1]).toContain("Normal log line without secrets");
  });

  it("limits error_log_tail to max 20 lines", async () => {
    const manyLines = Array.from(
      { length: 30 },
      (_, i) => `2026-04-30T10:00:0${String(i).padStart(2, "0")}Z Log line ${i}`,
    ).join("\n");

    mockFiles.set("errors.log", manyLines);
    mockFiles.set("config.json", new Error("ENOENT: file not found"));

    const bundle = await buildBugReport();
    expect(bundle.error_log_tail.length).toBeLessThanOrEqual(20);
  });
});

describe("formatBugReport — produces valid JSON", () => {
  it("formatBugReport produces valid JSON string", () => {
    const bundle: BugReportBundle = {
      generated_at: new Date().toISOString(),
      bun_version: "1.3.13",
      os: { platform: "linux", release: "5.15", arch: "x64" },
      doctor: [{ name: "os", status: "pass", detail: "linux" }],
      config_redacted: { "cap.monthly_usd": 15 },
      error_log_tail: [],
      ee_status: null,
    };
    const json = formatBugReport(bundle);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.bun_version).toBe("1.3.13");
  });
});
