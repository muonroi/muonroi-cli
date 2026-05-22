import { afterEach, describe, expect, it } from "vitest";
import { clearDiscoveryCache, getCachedProjectContext, setCachedProjectContext } from "../discovery-cache.js";
import type { ProjectContext } from "../discovery-types.js";

const EMPTY_CTX: ProjectContext = {
  language: "typescript",
  framework: "next",
  packageManager: "bun",
  domain: null,
  boundedContexts: [],
  eePatterns: [],
  relevantModules: [],
  scannedAt: Date.now(),
  cwd: "/proj",
};

afterEach(() => clearDiscoveryCache());

describe("discovery-cache", () => {
  it("returns null when empty", () => {
    expect(getCachedProjectContext("/proj")).toBeNull();
  });

  it("returns cached context for same cwd", () => {
    setCachedProjectContext(EMPTY_CTX);
    expect(getCachedProjectContext("/proj")).toEqual(EMPTY_CTX);
  });

  it("returns null for different cwd", () => {
    setCachedProjectContext(EMPTY_CTX);
    expect(getCachedProjectContext("/other")).toBeNull();
  });

  it("returns null after TTL expires", () => {
    const old = { ...EMPTY_CTX, scannedAt: Date.now() - 6 * 60_000 };
    setCachedProjectContext(old);
    expect(getCachedProjectContext("/proj")).toBeNull();
  });

  it("clearDiscoveryCache resets", () => {
    setCachedProjectContext(EMPTY_CTX);
    clearDiscoveryCache();
    expect(getCachedProjectContext("/proj")).toBeNull();
  });
});
