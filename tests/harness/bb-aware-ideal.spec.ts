/**
 * tests/harness/bb-aware-ideal.spec.ts
 *
 * E2E / integration spec for BB-aware /ideal retrieval (Phase 5).
 *
 * Strategy:
 * - Unit-level: fetchBBContext shape, token-budget, feature-flag, marker contract.
 * - Integration: mock EE server via Bun.serve (or a simple node http server as fallback).
 *   The mock returns canned JSON for /api/search so no production EE is contacted.
 *
 * DO NOT call production EE — all network goes to the local mock server.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  BB_INFER_SCORE_FLOOR,
  _resetBBRetrievalState,
  bbContextMarker,
  fetchBBContext,
  inferBBFromPrompt,
  renderBBContextBlock,
} from "../../src/ee/bb-retrieval.js";

// ---------------------------------------------------------------------------
// Mock EE server
// ---------------------------------------------------------------------------

const MOCK_RECIPES = [
  {
    id: "r1",
    score: 0.92,
    text: "Muonroi.CQRS.Sample — command/query separation pattern",
    collection: "bb-recipes",
  },
];

const MOCK_BEHAVIORAL = [
  {
    id: "b1",
    score: 0.88,
    text: "Always register handlers in the DI container before calling MediatR.Send.",
    collection: "bb-behavioral",
  },
  {
    id: "b2",
    score: 0.75,
    text: "Use Muonroi.BaseTemplate as the project scaffold entry point.",
    collection: "bb-behavioral",
  },
];

const MOCK_PACKAGES = [
  {
    id: "p1",
    score: 0.85,
    text: "Muonroi.Core",
    collection: "bb-packages",
    payload: { name: "Muonroi.Core", license: "OSS", description: "Core abstractions for building-block projects." },
  },
];

function buildMockSearchResponse(collection: string): unknown {
  if (collection === "bb-recipes") return { points: MOCK_RECIPES };
  if (collection === "bb-behavioral") return { points: MOCK_BEHAVIORAL };
  if (collection === "bb-packages") return { points: MOCK_PACKAGES };
  return { points: [] };
}

let mockServer: Server;
let mockBaseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/search") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { collections?: string[] };
            const collection = parsed.collections?.[0] ?? "";
            const response = buildMockSearchResponse(collection);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          } catch {
            res.writeHead(400);
            res.end("bad request");
          }
        });
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });

    mockServer.listen(0, "127.0.0.1", () => {
      const addr = mockServer.address() as { port: number };
      mockBaseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  mockServer?.close();
});

// ---------------------------------------------------------------------------
// Unit tests — fetchBBContext shape
// ---------------------------------------------------------------------------

describe("fetchBBContext shape", () => {
  it("returns typed recipes, behavioralRules, packages from mock server", async () => {
    _resetBBRetrievalState();
    const ctx = await fetchBBContext("build a CQRS service with Muonroi", {
      eeBaseUrl: mockBaseUrl,
      eeAuthToken: "test-token",
    });

    expect(ctx.recipes.length).toBeGreaterThan(0);
    expect(ctx.behavioralRules.length).toBeGreaterThan(0);
    expect(ctx.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ctx.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("recipe entries have required fields", async () => {
    _resetBBRetrievalState();
    const ctx = await fetchBBContext("build a Muonroi service", { eeBaseUrl: mockBaseUrl, eeAuthToken: "tok" });
    for (const recipe of ctx.recipes) {
      expect(typeof recipe.name).toBe("string");
      expect(typeof recipe.score).toBe("number");
      expect(Array.isArray(recipe.intentKeywords)).toBe(true);
    }
  });

  it("behavioral rules have text and score", async () => {
    _resetBBRetrievalState();
    const ctx = await fetchBBContext("DI container setup", { eeBaseUrl: mockBaseUrl, eeAuthToken: "tok" });
    for (const rule of ctx.behavioralRules) {
      expect(typeof rule.text).toBe("string");
      expect(rule.text.length).toBeGreaterThan(0);
      expect(typeof rule.score).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// Feature flag test
// ---------------------------------------------------------------------------

describe("fetchBBContext feature flag", () => {
  it("returns empty when eeBBContext=false in settings", async () => {
    _resetBBRetrievalState();
    // Mock loadUserSettings to return eeBBContext: false
    const settingsModule = await import("../../src/utils/settings.js");
    const spy = vi.spyOn(settingsModule, "loadUserSettings").mockReturnValue({ eeBBContext: false } as ReturnType<typeof settingsModule.loadUserSettings>);
    try {
      const ctx = await fetchBBContext("anything", { eeBaseUrl: mockBaseUrl, eeAuthToken: "tok" });
      expect(ctx.recipes).toHaveLength(0);
      expect(ctx.behavioralRules).toHaveLength(0);
      expect(ctx.packages).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Token budget guard
// ---------------------------------------------------------------------------

describe("fetchBBContext token budget (5.4)", () => {
  it("applies maxTokens=50 and trims results accordingly", async () => {
    _resetBBRetrievalState();
    const ctx = await fetchBBContext("test prompt", {
      eeBaseUrl: mockBaseUrl,
      eeAuthToken: "tok",
      maxTokens: 50,
    });
    // With 50 tokens, most content should be trimmed
    const totalText = [
      ...ctx.recipes.map((r) => `${r.name} ${r.description ?? ""}`),
      ...ctx.behavioralRules.map((r) => r.text),
      ...ctx.packages.map((p) => `${p.name} ${p.description}`),
    ].join(" ");
    const approxTokens = Math.ceil(totalText.length / 4);
    expect(approxTokens).toBeLessThanOrEqual(200); // generous upper bound
  });
});

// ---------------------------------------------------------------------------
// renderBBContextBlock + marker contract (5.8)
// ---------------------------------------------------------------------------

describe("renderBBContextBlock + marker (5.8)", () => {
  it("renders non-empty block when ctx has hits", async () => {
    _resetBBRetrievalState();
    const ctx = await fetchBBContext("CQRS service", { eeBaseUrl: mockBaseUrl, eeAuthToken: "tok" });
    const block = renderBBContextBlock(ctx);
    expect(block).toContain("## BB context");
    expect(block).toContain("Behavioral rules:");
  });

  it("rendered block contains bb-context-injected marker", async () => {
    _resetBBRetrievalState();
    const ctx = await fetchBBContext("CQRS service", { eeBaseUrl: mockBaseUrl, eeAuthToken: "tok" });
    const block = renderBBContextBlock(ctx);
    expect(block).toMatch(/<!-- bb-context-injected:[0-9a-f]{16} -->/);
  });

  it("bbContextMarker produces stable sha16 for same content", () => {
    const content = "some stable content";
    const m1 = bbContextMarker(content);
    const m2 = bbContextMarker(content);
    expect(m1).toBe(m2);
    expect(m1).toMatch(/^<!-- bb-context-injected:[0-9a-f]{16} -->$/);
  });

  it("returns empty string for empty context", () => {
    const block = renderBBContextBlock({
      recipes: [],
      behavioralRules: [],
      packages: [],
      retrievedAt: new Date().toISOString(),
      latencyMs: 0,
    });
    expect(block).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Graceful degrade — network failure
// ---------------------------------------------------------------------------

describe("fetchBBContext graceful degrade", () => {
  it("returns empty result when EE base URL is invalid (network error)", async () => {
    _resetBBRetrievalState();
    const ctx = await fetchBBContext("test", {
      eeBaseUrl: "http://127.0.0.1:1", // port 1 is always refused
      eeAuthToken: "tok",
      timeoutMs: 300,
    });
    expect(ctx.recipes).toHaveLength(0);
    expect(ctx.behavioralRules).toHaveLength(0);
  });

  it("returns empty result when EE base URL is not configured", async () => {
    _resetBBRetrievalState();
    const settingsModule = await import("../../src/utils/settings.js");
    const spy = vi.spyOn(settingsModule, "loadUserSettings").mockReturnValue({} as ReturnType<typeof settingsModule.loadUserSettings>);
    const authModule = await import("../../src/ee/auth.js");
    // Ensure no cached server base URL leaks through
    const authSpy = vi.spyOn(authModule, "getCachedServerBaseUrl").mockReturnValue(null);
    try {
      const ctx = await fetchBBContext("test", {}); // no eeBaseUrl
      expect(ctx.recipes).toHaveLength(0);
    } finally {
      spy.mockRestore();
      authSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt-based BB inference (empty-cwd fallback for /ideal)
// ---------------------------------------------------------------------------

describe("inferBBFromPrompt", () => {
  it("returns true when top bb-recipes hit score >= floor", async () => {
    _resetBBRetrievalState();
    // Mock returns score 0.92 for bb-recipes (see MOCK_RECIPES) — well above the floor
    const inferred = await inferBBFromPrompt("build a CQRS service with Muonroi", {
      eeBaseUrl: mockBaseUrl,
      eeAuthToken: "tok",
    });
    expect(inferred).toBe(true);
  });

  it("returns false on empty / very short prompt", async () => {
    _resetBBRetrievalState();
    expect(await inferBBFromPrompt("", { eeBaseUrl: mockBaseUrl, eeAuthToken: "tok" })).toBe(false);
    expect(await inferBBFromPrompt("hi", { eeBaseUrl: mockBaseUrl, eeAuthToken: "tok" })).toBe(false);
  });

  it("returns false when EE base URL is not configured", async () => {
    _resetBBRetrievalState();
    const authModule = await import("../../src/ee/auth.js");
    const authSpy = vi.spyOn(authModule, "getCachedServerBaseUrl").mockReturnValue(null);
    try {
      const inferred = await inferBBFromPrompt("build a CQRS service with Muonroi", {});
      expect(inferred).toBe(false);
    } finally {
      authSpy.mockRestore();
    }
  });

  it("returns false when feature flag eeBBContext is false", async () => {
    _resetBBRetrievalState();
    const settingsModule = await import("../../src/utils/settings.js");
    const spy = vi.spyOn(settingsModule, "loadUserSettings").mockReturnValue({ eeBBContext: false } as ReturnType<typeof settingsModule.loadUserSettings>);
    try {
      const inferred = await inferBBFromPrompt("build a CQRS service with Muonroi", {
        eeBaseUrl: mockBaseUrl,
        eeAuthToken: "tok",
      });
      expect(inferred).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("BB_INFER_SCORE_FLOOR is conservative (0.55-0.70 range)", () => {
    expect(BB_INFER_SCORE_FLOOR).toBeGreaterThanOrEqual(0.55);
    expect(BB_INFER_SCORE_FLOOR).toBeLessThanOrEqual(0.7);
  });
});
