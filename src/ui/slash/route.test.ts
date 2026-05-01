import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type StubHandle, startStubEEServer } from "../../__test-stubs__/ee-server.js";
import { createEEClient } from "../../ee/client.js";
import { setDefaultEEClient } from "../../ee/intercept.js";
import { midstreamPolicy } from "../../usage/midstream.js";
import { dispatchSlash, listSlashCommands, registerSlash, type SlashContext } from "./registry.js";

// Import route.ts to trigger self-registration
import "./route.js";

const CTX: SlashContext = {
  cwd: "/tmp",
  tenantId: "local",
  defaultProvider: "anthropic",
  defaultModel: "claude-3-5-sonnet-latest",
  lastPrompt: "create file foo.ts",
};

describe("slash registry", () => {
  it("registerSlash + dispatchSlash round-trip", async () => {
    registerSlash("test-cmd", (_args, _ctx) => "test-result");
    const result = await dispatchSlash("test-cmd", [], CTX);
    expect(result).toBe("test-result");
  });

  it("dispatchSlash returns null for unregistered command", async () => {
    const result = await dispatchSlash("nonexistent", [], CTX);
    expect(result).toBeNull();
  });

  it("listSlashCommands includes route after import", () => {
    const cmds = listSlashCommands();
    expect(cmds).toContain("route");
  });
});

describe("handleRouteSlash", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    // Stub EE with no handlers -> warm/cold both fail -> fallback path
    stub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
  });

  afterAll(async () => {
    await stub.stop();
  });

  beforeEach(() => {
    midstreamPolicy.clear();
  });

  it("returns string containing tier, model, provider, reason", async () => {
    const result = await dispatchSlash("route", ["create file x"], CTX);
    expect(result).toBeTypeOf("string");
    expect(result).toContain("Tier:");
    expect(result).toContain("Provider:");
    expect(result).toContain("Model:");
    expect(result).toContain("Reason:");
  });

  it("uses lastPrompt when no args given", async () => {
    const result = await dispatchSlash("route", [], CTX);
    expect(result).toBeTypeOf("string");
    expect(result).toContain("Tier:");
  });

  it("returns help text when no prompt and no lastPrompt", async () => {
    const noPromptCtx = { ...CTX, lastPrompt: undefined };
    const result = await dispatchSlash("route", [], noPromptCtx);
    expect(result).toContain("/route:");
    expect(result).toContain("no recent prompt");
  });

  it("includes cap-driven note when cap_overridden", async () => {
    // Force midstream refuse -> decide will set cap_overridden
    midstreamPolicy.forceRefuseNext();
    const result = await dispatchSlash("route", ["create file x"], CTX);
    expect(result).toContain("Cap-driven");
  });
});
