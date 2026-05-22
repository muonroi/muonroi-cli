import { describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

import {
  detectFramework,
  detectLanguage,
  detectPackageManager,
  findRelevantModules,
  scanProjectContext,
} from "../layer15-context-scan.js";

describe("detectLanguage()", () => {
  it("detects typescript from tsconfig.json", () => {
    const exists = (p: string) => p.endsWith("tsconfig.json");
    expect(detectLanguage("/proj", exists)).toBe("typescript");
  });
  it("detects python from pyproject.toml", () => {
    const exists = (p: string) => p.endsWith("pyproject.toml") || p.endsWith("requirements.txt");
    expect(detectLanguage("/proj", exists)).toBe("python");
  });
  it("returns null when no signal", () => {
    expect(detectLanguage("/proj", () => false)).toBeNull();
  });
});

describe("detectFramework()", () => {
  it("detects next.js from next.config.js", () => {
    const exists = (p: string) => p.includes("next.config");
    expect(detectFramework("/proj", exists, {})).toBe("next");
  });
  it("detects express from deps", () => {
    expect(detectFramework("/proj", () => false, { express: "4.0.0" })).toBe("express");
  });
  it("detects angular from angular.json", () => {
    const exists = (p: string) => p.endsWith("angular.json");
    expect(detectFramework("/proj", exists, {})).toBe("angular");
  });
});

describe("detectPackageManager()", () => {
  it("detects bun from bun.lockb", () => {
    const exists = (p: string) => p.endsWith("bun.lockb") || p.endsWith("bun.lock");
    expect(detectPackageManager("/proj", exists)).toBe("bun");
  });
  it("detects npm from package-lock.json", () => {
    const exists = (p: string) => p.endsWith("package-lock.json");
    expect(detectPackageManager("/proj", exists)).toBe("npm");
  });
});

describe("findRelevantModules()", () => {
  it("matches keyword against bounded context names", () => {
    const bcs = [
      { path: "src/auth/", name: "auth", entryFiles: [], exportedSymbols: [] },
      { path: "src/billing/", name: "billing", entryFiles: [], exportedSymbols: [] },
    ];
    const result = findRelevantModules("fix auth bug", bcs);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("src/auth/");
  });
  it("returns empty for no keyword matches", () => {
    const bcs = [{ path: "src/auth/", name: "auth", entryFiles: [], exportedSymbols: [] }];
    expect(findRelevantModules("refactor code", bcs)).toHaveLength(0);
  });
});

describe("scanProjectContext()", () => {
  it("returns a ProjectContext with cwd set", async () => {
    const ctx = await scanProjectContext("hello world", "/proj");
    expect(ctx.cwd).toBe("/proj");
    expect(ctx.scannedAt).toBeGreaterThan(0);
  });
});
