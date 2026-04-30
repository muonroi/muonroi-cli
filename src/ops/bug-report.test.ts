import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// RED phase: import module under test (will fail until bug-report.ts is created)
import { buildBugReport, formatBugReport, type BugReportBundle } from "./bug-report.js";

// Mock fs/promises for controlled test environment
// bug-report.ts uses named import { readFile } from "fs/promises"
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

// Mock runDoctor to avoid real network calls
vi.mock("./doctor.js", () => ({
  runDoctor: vi.fn().mockResolvedValue([
    { name: "bun_version", status: "pass", detail: "Bun 1.3.13" },
    { name: "os", status: "pass", detail: "linux 5.15" },
    { name: "key_presence", status: "pass", detail: "API key in env" },
    { name: "ollama", status: "warn", detail: "Ollama unreachable" },
    { name: "ee", status: "warn", detail: "EE unreachable" },
    { name: "qdrant", status: "warn", detail: "Qdrant unreachable" },
    { name: "error_rate", status: "pass", detail: "0 errors in last 24h" },
  ]),
}));

// Mock EE health to avoid real network calls
vi.mock("../ee/health.js", () => ({
  health: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
}));

/** Helper to get the mocked readFile from the vi.mock above */
async function getMockedReadFile(): Promise<Mock> {
  const mod = await import("fs/promises");
  return (mod as unknown as { readFile: Mock }).readFile;
}

describe("buildBugReport — required sections", () => {
  beforeEach(async () => {
    const readFile = await getMockedReadFile();
    // Default: no config, no error log
    readFile.mockRejectedValue(new Error("ENOENT: file not found"));
  });

  afterEach(() => {
    vi.clearAllMocks();
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
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("config_redacted excludes ee.authToken and includes cap.monthly_usd", async () => {
    const mockConfig = JSON.stringify({
      ee: { authToken: "secret-token-123456" },
      cap: { monthly_usd: 15 },
      router: { confidence_threshold: 0.55 },
    });
    const readFile = await getMockedReadFile();
    readFile.mockImplementation((filePath: unknown) => {
      // Match by filename ending to avoid Windows/Unix path separator issues
      if (String(filePath).endsWith("config.json")) return Promise.resolve(mockConfig);
      return Promise.reject(new Error("ENOENT: file not found"));
    });

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
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("scrubs sk-ant-* keys from error log lines", async () => {
    const errorLogContent = [
      "2026-04-30T10:00:00Z Error calling sk-ant-abc123def456ghi789xyz at /api",
      "2026-04-30T10:01:00Z Normal log line without secrets",
    ].join("\n");

    const readFile = await getMockedReadFile();
    readFile.mockImplementation((filePath: unknown) => {
      // Match by filename ending to avoid Windows/Unix path separator issues
      if (String(filePath).endsWith("errors.log")) return Promise.resolve(errorLogContent);
      return Promise.reject(new Error("ENOENT: file not found"));
    });

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
    const manyLines = Array.from({ length: 30 }, (_, i) =>
      `2026-04-30T10:00:0${String(i).padStart(2, "0")}Z Log line ${i}`
    ).join("\n");

    const readFile = await getMockedReadFile();
    readFile.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith("errors.log")) return Promise.resolve(manyLines);
      return Promise.reject(new Error("ENOENT: file not found"));
    });

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
