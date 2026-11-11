import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({
  loadEEAuthToken: async () => "fixture-private-token",
  getCachedServerBaseUrl: () => "https://fixture.invalid",
}));

import { BashTool } from "../tools/bash.js";
import { createBuiltinTools } from "../tools/registry.js";
import * as eeLogger from "../utils/ee-logger.js";
import { createEEClient } from "./client.js";
import { formatRecallForAgent, recallEE } from "./search.js";

const scopeError = "Cannot resolve a concrete project for strict recall; pass project_slug from /api/projects";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recall HTTP diagnostic belongs to its request", () => {
  it("retains the low-level null contract and reports status/missing-project separately", async () => {
    vi.spyOn(eeLogger, "logEeFailure").mockImplementation(() => {});
    const onHttpError = vi.fn();
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: scopeError }), { status: 400 }),
    );
    expect(
      await createEEClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).recall("scope", {
        strictProject: true,
        cwd: "D:/consumer",
        onHttpError,
      }),
    ).toBeNull();
    expect(onHttpError).toHaveBeenCalledWith({ status: 400, projectRequired: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("surfaces project-required in the actual native tool without claiming an outage or empty brain", async () => {
    vi.spyOn(eeLogger, "logEeFailure").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: scopeError }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const bash = new BashTool("D:/consumer");
    try {
      const tools = createBuiltinTools(bash, "agent");
      const tool = tools.ee_query as { execute: (input: unknown, options: unknown) => Promise<unknown> };
      const result = String(await tool.execute({ query: "project=muonroi-cli" }, {}));
      expect(result).toContain("[ee_project_required]");
      expect(result).toContain("HTTP 400");
      expect(result).toContain("/api/projects");
      expect(result).not.toMatch(/ee_unavailable|0 entries|fixture-private-token/);
      const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(body.strict_project).toBe(true);
      expect(body.project_slug).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await bash.cleanup();
    }
  });
  it.each([
    401, 403, 429, 500,
  ])("preserves HTTP%s as a rejection, not a missing project or no-response timeout", async (status) => {
    vi.spyOn(eeLogger, "logEeFailure").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "fixture rejection" }), { status })),
    );
    const result = await recallEE("q", { project: "repo-a", cwd: "D:/repo-a", strictProject: true });
    const text = formatRecallForAgent(result!);
    expect(text).toContain("[ee_request_rejected]");
    expect(text).toContain(`HTTP ${status}`);
    expect(text).not.toMatch(/ee_unavailable|ee_project_required|0 entries/);
    expect(result?.entries).toEqual([]);
  });
  it("does not reuse another concurrent request's rejection or turn a network error into a scope refusal", async () => {
    vi.spyOn(eeLogger, "logEeFailure").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const { query } = JSON.parse(init.body);
        if (query === "reject") return new Response(JSON.stringify({ error: scopeError }), { status: 400 });
        throw new TypeError("fixture network failure");
      }),
    );
    const [rejected, unavailable] = await Promise.all([
      recallEE("reject", { strictProject: true }),
      recallEE("network", { strictProject: true }),
    ]);
    expect(rejected?.text).toContain("ee_project_required");
    expect(unavailable).toBeNull();
  });
  it("does not log a reflected authorization token in an HTTP failure body", async () => {
    const log = vi.spyOn(eeLogger, "logEeFailure").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rejected fixture-secret-token", detail: "x".repeat(5000) }), {
          status: 401,
        }),
    );
    const reflectedFixture = ["fixture", "secret", "token"].join("-");
    await createEEClient({ authToken: reflectedFixture, fetchImpl: fetchImpl as unknown as typeof fetch }).recall("q");
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-secret-token");
    expect((log.mock.calls[0][3]?.responseBody as string).length).toBeLessThanOrEqual(2000);
  });
  it("preserves the HTTP rejection when the error body is not JSON", async () => {
    vi.spyOn(eeLogger, "logEeFailure").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("fixture unavailable", { status: 503 })),
    );
    const result = await recallEE("q", { strictProject: true });
    expect(result?.text).toContain("HTTP 503");
    expect(result?.text).toContain("ee_request_rejected");
  });
});
