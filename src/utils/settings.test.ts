import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeSandboxMode", () => {
  it("returns shuru for shuru input", async () => {
    const { normalizeSandboxMode } = await import("./settings");
    expect(normalizeSandboxMode("shuru")).toBe("shuru");
  });

  it("returns off for any other input", async () => {
    const { normalizeSandboxMode } = await import("./settings");
    expect(normalizeSandboxMode("invalid")).toBe("off");
    expect(normalizeSandboxMode(undefined)).toBe("off");
    expect(normalizeSandboxMode(null)).toBe("off");
    expect(normalizeSandboxMode(42)).toBe("off");
  });
});

describe("normalizeSandboxSettings", () => {
  it("returns empty object for non-object input", async () => {
    const { normalizeSandboxSettings } = await import("./settings");
    expect(normalizeSandboxSettings(null)).toEqual({});
    expect(normalizeSandboxSettings("string")).toEqual({});
    expect(normalizeSandboxSettings(undefined)).toEqual({});
    expect(normalizeSandboxSettings([])).toEqual({});
  });

  it("normalizes valid fields", async () => {
    const { normalizeSandboxSettings } = await import("./settings");
    const result = normalizeSandboxSettings({
      allowNet: true,
      allowedHosts: ["api.openai.com", ""],
      cpus: 4,
      memory: 2048,
      ports: ["3000:3000", "bad", "8080:8080"],
    });
    expect(result.allowNet).toBe(true);
    expect(result.allowedHosts).toEqual(["api.openai.com"]);
    expect(result.cpus).toBe(4);
    expect(result.memory).toBe(2048);
    expect(result.ports).toEqual(["3000:3000", "8080:8080"]);
  });

  it("ignores non-positive numbers for cpus and memory", async () => {
    const { normalizeSandboxSettings } = await import("./settings");
    const result = normalizeSandboxSettings({ cpus: 0, memory: -1 });
    expect(result.cpus).toBeUndefined();
    expect(result.memory).toBeUndefined();
  });

  it("normalizes secrets", async () => {
    const { normalizeSandboxSettings } = await import("./settings");
    const result = normalizeSandboxSettings({
      secrets: [{ name: "API_KEY", fromEnv: "MY_KEY", hosts: ["api.example.com"] }, { name: "", fromEnv: "BAD" }, null],
    });
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets![0].name).toBe("API_KEY");
  });
});

describe("mergeSandboxSettings", () => {
  it("returns empty when both undefined", async () => {
    const { mergeSandboxSettings } = await import("./settings");
    expect(mergeSandboxSettings(undefined, undefined)).toEqual({});
  });

  it("returns base when override is undefined", async () => {
    const { mergeSandboxSettings } = await import("./settings");
    const result = mergeSandboxSettings({ allowNet: true, cpus: 2 }, undefined);
    expect(result.allowNet).toBe(true);
    expect(result.cpus).toBe(2);
  });

  it("override takes precedence", async () => {
    const { mergeSandboxSettings } = await import("./settings");
    const result = mergeSandboxSettings({ allowNet: true, cpus: 2 }, { allowNet: false, memory: 1024 });
    expect(result.allowNet).toBe(false);
    expect(result.cpus).toBe(2);
    expect(result.memory).toBe(1024);
  });
});

describe("isReservedSubagentName", () => {
  it("identifies reserved names", async () => {
    const { isReservedSubagentName } = await import("./settings");
    expect(isReservedSubagentName("general")).toBe(true);
    expect(isReservedSubagentName("explore")).toBe(true);
    expect(isReservedSubagentName("vision")).toBe(true);
    expect(isReservedSubagentName("verify")).toBe(true);
    expect(isReservedSubagentName("computer")).toBe(true);
  });

  it("trims and lowercases input", async () => {
    const { isReservedSubagentName } = await import("./settings");
    expect(isReservedSubagentName("  General  ")).toBe(true);
    expect(isReservedSubagentName("EXPLORE")).toBe(true);
  });

  it("rejects non-reserved names", async () => {
    const { isReservedSubagentName } = await import("./settings");
    expect(isReservedSubagentName("my-agent")).toBe(false);
    expect(isReservedSubagentName("custom")).toBe(false);
  });
});

describe("parseSubAgentsRawList", () => {
  it("returns empty for non-array input", async () => {
    const { parseSubAgentsRawList } = await import("./settings");
    expect(parseSubAgentsRawList(null)).toEqual([]);
    expect(parseSubAgentsRawList("string")).toEqual([]);
    expect(parseSubAgentsRawList(42)).toEqual([]);
  });

  it("filters invalid entries", async () => {
    const { parseSubAgentsRawList } = await import("./settings");
    const result = parseSubAgentsRawList([
      null,
      { name: "", model: "claude-sonnet-4-6-20250514", instruction: "test" },
      { name: "explore", model: "claude-sonnet-4-6-20250514", instruction: "reserved" },
    ]);
    expect(result).toEqual([]);
  });

  it("deduplicates by lowercase name", async () => {
    const { parseSubAgentsRawList } = await import("./settings");
    const result = parseSubAgentsRawList([
      { name: "MyAgent", model: "claude-sonnet-4-6-20250514", instruction: "first" },
      { name: "myagent", model: "claude-sonnet-4-6-20250514", instruction: "dupe" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("MyAgent");
  });
});

describe("resolveTelegramStreamSettings", () => {
  it("returns defaults when settings undefined", async () => {
    const { resolveTelegramStreamSettings } = await import("./settings");
    const result = resolveTelegramStreamSettings(undefined);
    expect(result.streaming).toBe("partial");
    expect(result.typingIndicator).toBe(true);
    expect(result.nativeDrafts).toBe(false);
  });

  it("respects explicit off", async () => {
    const { resolveTelegramStreamSettings } = await import("./settings");
    const result = resolveTelegramStreamSettings({ streaming: "off", typingIndicator: false });
    expect(result.streaming).toBe("off");
    expect(result.typingIndicator).toBe(false);
  });
});

describe("resolveTelegramAudioInputSettings", () => {
  it("returns defaults when settings undefined", async () => {
    const { resolveTelegramAudioInputSettings } = await import("./settings");
    const result = resolveTelegramAudioInputSettings(undefined);
    expect(result.enabled).toBe(true);
    expect(result.language).toBe("en");
  });

  it("respects explicit values", async () => {
    const { resolveTelegramAudioInputSettings } = await import("./settings");
    const result = resolveTelegramAudioInputSettings({
      audioInput: { enabled: false, language: "vi" },
    });
    expect(result.enabled).toBe(false);
    expect(result.language).toBe("vi");
  });
});
