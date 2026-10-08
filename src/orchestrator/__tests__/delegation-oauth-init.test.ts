import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getTestModelForProvider } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { __resetProviderFactoryRegistry } from "../../providers/runtime.js";
import { closeDatabase } from "../../storage/db.js";
import { Agent } from "../orchestrator.js";

vi.mock("../../providers/auth/registry.js", () => ({
  listOAuthProviderIds: async () => ["openai"],
  getOAuthProviderConfig: async (id: string) =>
    id === "openai"
      ? {
          loadTokensWithRefresh: async () => ({ accessToken: "fixture" }),
          provider: { authHeaders: () => ({ Authorization: "Bearer fixture" }) },
          baseURL: "https://oauth.example.invalid/backend/codex",
          defaultProviderOptions: { store: false, instructions: "Fixture" },
          unsupportedParams: ["maxOutputTokens"],
        }
      : undefined,
}));

it("initializes OAuth before an isolated background task uses the real provider transport", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-delegation-oauth-"));
  const cwd = process.cwd();
  const keys = ["HOME", "USERPROFILE", "MUONROI_EE_BASE_URL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  fs.mkdirSync(path.join(home, ".muonroi-cli"));
  fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), "{}");
  process.chdir(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
  closeDatabase();
  __resetProviderFactoryRegistry();
  await loadCatalog();
  const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.includes("/responses")) throw new Error(`Unexpected fixture request: ${url}`);
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(
      JSON.stringify({ error: { message: "Fixture provider rejected request", type: "invalid_request_error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  });
  const modelId = getTestModelForProvider("openai", "fast");
  const agent = new Agent("oauth", undefined, modelId, 1, { persistSession: false });
  try {
    const result = await agent.runTaskRequest({
      agent: "explore",
      modelId,
      description: "Inspect",
      prompt: "Read evidence",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("HTTP 400: Fixture provider rejected request");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://oauth.example.invalid/backend/codex/responses");
    expect(requests[0].authorization).toBe("Bearer fixture");
    expect(requests[0].body).not.toHaveProperty("max_output_tokens");
    expect(requests[0].body.store).toBe(false);
  } finally {
    fetchSpy.mockRestore();
    await agent.cleanup();
    __resetProviderFactoryRegistry();
    closeDatabase();
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 15000);
