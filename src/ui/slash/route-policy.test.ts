import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { decide } = vi.hoisted(() => ({
  decide: vi.fn(async (_prompt: string, opts: any) => ({
    tier: "hot",
    provider: opts.defaultProvider,
    model: opts.defaultModel,
    reason: opts.forcedReason ?? "fixture",
    routingMode: opts.routingMode,
  })),
}));
vi.mock("../../router/decide.js", () => ({ decide }));
vi.mock("../../utils/settings.js", async (original) => ({
  ...(await original<typeof import("../../utils/settings.js")>()),
  loadUserSettings: () => ({}),
}));
import { handleRouteSlash } from "./route.js";

describe("route policy command owns its addressed cwd", () => {
  let fixture: string;
  const context = () => ({
    cwd: fixture,
    tenantId: "fixture",
    defaultProvider: "fixture-provider",
    defaultModel: "fixture-model",
    lastPrompt: "read source",
  });
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "muonroi-route-policy-"));
    mkdirSync(join(fixture, ".muonroi-cli"));
    writeFileSync(
      join(fixture, ".muonroi-cli/settings.json"),
      JSON.stringify({ model: "fixture-model", preserved: "keep" }),
    );
    decide.mockClear();
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));
  const settings = (cwd: string) => readFileSync(join(cwd, ".muonroi-cli/settings.json"), "utf8");
  const processConfigHash = () =>
    existsSync(join(process.cwd(), ".muonroi-cli/settings.json"))
      ? createHash("sha256").update(settings(process.cwd())).digest("hex")
      : "absent";
  it("status reports a project pin without running routing or rewriting config", async () => {
    const before = settings(fixture);
    expect(await handleRouteSlash(["status"], context())).toContain("fixed (project-model-pin)");
    expect(decide).not.toHaveBeenCalled();
    expect(settings(fixture)).toBe(before);
  });
  it("persists mode only to the addressed project and preserves its other fields", async () => {
    const processConfig = processConfigHash();
    await handleRouteSlash(["mode", "suggest"], context());
    expect(JSON.parse(settings(fixture))).toEqual({
      model: "fixture-model",
      preserved: "keep",
      routingMode: "suggest",
    });
    expect(processConfigHash()).toBe(processConfig);
    expect(decide).not.toHaveBeenCalled();
    await handleRouteSlash(["read", "source"], context());
    expect(decide.mock.calls[0][1]).toMatchObject({ cwd: fixture, routingMode: "suggest" });
    expect(decide.mock.calls[0][1].forcedModel).toBeUndefined();
  });
  it("rejects invalid modes without writes, and previews the same pin as main", async () => {
    const before = settings(fixture);
    expect(await handleRouteSlash(["mode", "bad"], context())).toContain("Usage:");
    expect(settings(fixture)).toBe(before);
    await handleRouteSlash(["read", "source"], context());
    expect(decide.mock.calls[0][1]).toMatchObject({
      forcedModel: "fixture-model",
      routingMode: "fixed",
      forcedReason: "project-model-pin",
    });
  });
});
