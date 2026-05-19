/**
 * Tests for src/ee/bb-design.ts (Plan 23-01a).
 *
 * Covers 5 scenarios:
 *  1. happy path — template + commercial filter
 *  2. allowCommercial=true — commercial pkgs not filtered
 *  3. no template recipe — returns null
 *  4. EE 503 — returns null + ee-error logged
 *  5. EE timeout — returns null + ee-timeout logged
 *
 * Mocks `global.fetch` via vi.spyOn. Routes EE base URL through
 * MUONROI_EE_BASE_URL so we don't depend on ~/.experience/config.json.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as eeLogger from "../../utils/ee-logger.js";
import { designBBPackages } from "../bb-design.js";

const FAKE_BASE = "http://127.0.0.1:65535";

interface RawPoint {
  text: string;
  score: number;
}

interface MockResponse {
  status?: number;
  body?: { points: RawPoint[] };
  /** When true, returns a never-resolving Promise to simulate timeout. */
  hang?: boolean;
}

type CollectionResponses = Record<string, MockResponse>;

function makeFetchMock(byCollection: CollectionResponses) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : (url as URL).toString();
    if (!u.endsWith("/api/search")) {
      throw new Error(`unexpected fetch URL: ${u}`);
    }
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(bodyStr) as { query: string; collections: string[]; limit: number };
    const collection = body.collections[0];
    const mock = byCollection[collection];
    if (!mock) {
      // Default empty hit set.
      return new Response(JSON.stringify({ points: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (mock.hang) {
      // Never resolve — let AbortSignal.timeout fire.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    return new Response(JSON.stringify(mock.body ?? { points: [] }), {
      status: mock.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

const TEMPLATE_TEXT =
  "Template Muonroi Microservices Solution (mr-micro-sln): Muonroi microservices template with selectable OSS or enterprise tier and optional control-plane integration. | uses: Muonroi.AspNetCore, Muonroi.Tenancy, Muonroi.AuthZ";

const PRINCIPLE_AUTHZ_TEXT =
  "Commercial package Muonroi.AuthZ requires a valid Muonroi commercial license for production use";

const PRINCIPLE_CONSUL_TEXT =
  "Commercial package Muonroi.ServiceDiscovery.Consul requires a valid Muonroi commercial license for production use";

describe("designBBPackages", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MUONROI_EE_BASE_URL = FAKE_BASE;
    delete process.env.MUONROI_BB_DESIGN_TIMEOUT_MS;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns the matched template with commercial pkgs blocked (happy path)", async () => {
    const fetchMock = makeFetchMock({
      "bb-recipes": {
        body: {
          points: [
            { text: TEMPLATE_TEXT, score: 0.87 },
            { text: "Sample TodoApi project not a template", score: 0.6 },
          ],
        },
      },
      "experience-principles": {
        body: {
          points: [
            { text: PRINCIPLE_AUTHZ_TEXT, score: 0.9 },
            { text: PRINCIPLE_CONSUL_TEXT, score: 0.85 },
          ],
        },
      },
      "bb-behavioral": {
        body: {
          points: [
            { text: "Register infrastructure via AddInfrastructure()", score: 0.8 },
            { text: "Use modular boundaries: never import Application from Domain", score: 0.75 },
            { text: "Register infrastructure via AddInfrastructure()", score: 0.72 },
          ],
        },
      },
    });
    vi.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await designBBPackages("multi-tenant SaaS billing");

    expect(result).not.toBeNull();
    expect(result!.template.shortName).toBe("mr-micro-sln");
    expect(result!.template.nugetId).toBe("Muonroi.Microservices.Template");
    expect(result!.template.version).toBe("1.10.0");
    expect(result!.packageIds).toEqual(["Muonroi.AspNetCore", "Muonroi.Tenancy"]);
    expect(result!.commercialBlocked).toEqual(["Muonroi.AuthZ"]);
    expect(result!.confidence).toBeCloseTo(0.87);
    expect(result!.rationale).toContain("Muonroi microservices template");
    // Dedup of duplicate AddInfrastructure entries -> 2 hints, not 3.
    expect(result!.behavioralHints).toHaveLength(2);
    expect(result!.behavioralHints[0]).toContain("AddInfrastructure");
  });

  it("includes commercial packages when allowCommercial=true", async () => {
    const fetchMock = makeFetchMock({
      "bb-recipes": { body: { points: [{ text: TEMPLATE_TEXT, score: 0.87 }] } },
      "experience-principles": { body: { points: [{ text: PRINCIPLE_AUTHZ_TEXT, score: 0.9 }] } },
      "bb-behavioral": { body: { points: [] } },
    });
    vi.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await designBBPackages("multi-tenant SaaS billing", { allowCommercial: true });

    expect(result).not.toBeNull();
    expect(result!.packageIds).toEqual(["Muonroi.AspNetCore", "Muonroi.Tenancy", "Muonroi.AuthZ"]);
    expect(result!.commercialBlocked).toEqual([]);
  });

  it("returns null when no template recipe is found in top-5", async () => {
    const fetchMock = makeFetchMock({
      "bb-recipes": {
        body: {
          points: [
            { text: "Sample TodoApi project: not a template", score: 0.5 },
            { text: "Some other text", score: 0.4 },
          ],
        },
      },
      "experience-principles": { body: { points: [] } },
      "bb-behavioral": { body: { points: [] } },
    });
    vi.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const logSpy = vi.spyOn(eeLogger, "logEeFailure");
    const result = await designBBPackages("anything");

    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalled();
    const lastCall = logSpy.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("bb-design");
    expect(lastCall[1]).toBe("error");
  });

  it("returns null + logs ee-error when EE returns 503", async () => {
    const fetchMock = makeFetchMock({
      "bb-recipes": { status: 503, body: { points: [] } },
      "experience-principles": { status: 503, body: { points: [] } },
      "bb-behavioral": { status: 503, body: { points: [] } },
    });
    vi.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const logSpy = vi.spyOn(eeLogger, "logEeFailure");
    const result = await designBBPackages("anything");

    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalled();
    const errorCall = logSpy.mock.calls.find((c) => c[0] === "bb-design" && c[1] === "error");
    expect(errorCall).toBeDefined();
  });

  it("returns null + logs ee-timeout when fetch hangs past budget", async () => {
    process.env.MUONROI_BB_DESIGN_TIMEOUT_MS = "500";

    // Re-import bb-design so it picks up the lowered timeout at module init.
    vi.resetModules();
    const { designBBPackages: designFresh } = await import("../bb-design.js");

    const fetchMock = makeFetchMock({
      "bb-recipes": { hang: true },
      "experience-principles": { hang: true },
      "bb-behavioral": { hang: true },
    });
    vi.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const freshLogger = await import("../../utils/ee-logger.js");
    const logSpy = vi.spyOn(freshLogger, "logEeFailure");

    const t0 = Date.now();
    const result = await designFresh("anything");
    const elapsed = Date.now() - t0;

    expect(result).toBeNull();
    // Should resolve within roughly the budget (some slack for CI scheduling).
    expect(elapsed).toBeLessThan(3000);
    expect(logSpy).toHaveBeenCalled();
    const timeoutCall = logSpy.mock.calls.find((c) => c[0] === "bb-design" && c[1] === "timeout");
    expect(timeoutCall).toBeDefined();
  });
});
