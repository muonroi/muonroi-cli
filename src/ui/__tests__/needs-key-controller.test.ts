import { describe, expect, it, vi } from "vitest";
import type { MissingKeyServer } from "../../mcp/key-requirements";
import {
  buildNeedsKeyActions,
  MIN_MCP_KEY_LEN,
  type SubmitKeyDeps,
  submitMcpServerKey,
} from "../needs-key-controller";

const tavily: MissingKeyServer = {
  id: "tavily",
  label: "Tavily Search",
  envVar: "TAVILY_API_KEY",
  setupHint: "Add a Tavily key via /mcp.",
  nativeFallback: "web_search",
};

const futureServer: MissingKeyServer = {
  id: "some-future-mcp",
  label: "Future MCP",
  envVar: "FUTURE_API_KEY",
  setupHint: "Add a key.",
};

function makeDeps(overrides: Partial<SubmitKeyDeps> = {}): SubmitKeyDeps & {
  validateKey: ReturnType<typeof vi.fn>;
  storeKey: ReturnType<typeof vi.fn>;
  setServerEnabled: ReturnType<typeof vi.fn>;
  resetNotice: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
} {
  return {
    validateKey: vi.fn(async () => true),
    storeKey: vi.fn(async () => true),
    setServerEnabled: vi.fn(() => true),
    resetNotice: vi.fn(),
    reconnect: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

describe("buildNeedsKeyActions — the card's action list", () => {
  it("renders paste-key first, plus use-builtin when a native fallback exists", () => {
    const actions = buildNeedsKeyActions(tavily);
    expect(actions.map((a) => a.id)).toEqual(["paste-key", "use-builtin", "disable", "snooze"]);
    // Labels generalize on the descriptor — no hardcoded server names in the UI.
    expect(actions[0]?.label).toContain("TAVILY_API_KEY");
    expect(actions[1]?.label).toContain("web_search");
    expect(actions[2]?.label).toContain("Tavily Search");
  });

  it("omits use-builtin when the server has no native fallback", () => {
    const actions = buildNeedsKeyActions(futureServer);
    expect(actions.map((a) => a.id)).toEqual(["paste-key", "disable", "snooze"]);
    expect(actions[0]?.label).toContain("FUTURE_API_KEY");
  });
});

describe("submitMcpServerKey — the paste-key pipeline", () => {
  const goodKey = "tvly-0123456789abcdef0123";

  it("validates, stores, re-enables, resets the notice, and reconnects on success", async () => {
    const deps = makeDeps();
    const result = await submitMcpServerKey(tavily, `  ${goodKey}  `, deps);
    expect(result).toEqual({ ok: true });
    expect(deps.validateKey).toHaveBeenCalledWith("tavily", goodKey);
    // Keychain slot resolved from MCP_KEY_REQUIREMENTS, key trimmed.
    expect(deps.storeKey).toHaveBeenCalledWith("tavily", goodKey);
    expect(deps.setServerEnabled).toHaveBeenCalledWith("tavily", true);
    expect(deps.resetNotice).toHaveBeenCalledWith("tavily");
    expect(deps.reconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects a too-short key without probing or storing", async () => {
    const deps = makeDeps();
    const result = await submitMcpServerKey(tavily, "short", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MIN_MCP_KEY_LEN));
    expect(deps.validateKey).not.toHaveBeenCalled();
    expect(deps.storeKey).not.toHaveBeenCalled();
    expect(deps.reconnect).not.toHaveBeenCalled();
  });

  it("surfaces validation failure and does not store or reconnect", async () => {
    const deps = makeDeps({ validateKey: vi.fn(async () => false) });
    const result = await submitMcpServerKey(tavily, goodKey, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/validation failed/i);
    expect(deps.storeKey).not.toHaveBeenCalled();
    expect(deps.setServerEnabled).not.toHaveBeenCalled();
    expect(deps.reconnect).not.toHaveBeenCalled();
  });

  it("fails cleanly when the server has no registered keychain slot", async () => {
    const deps = makeDeps();
    const result = await submitMcpServerKey(futureServer, goodKey, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("some-future-mcp");
    expect(deps.storeKey).not.toHaveBeenCalled();
  });

  it("surfaces a storage error without reconnecting", async () => {
    const deps = makeDeps({
      storeKey: vi.fn(async () => {
        throw new Error("registry write denied");
      }),
    });
    const result = await submitMcpServerKey(tavily, goodKey, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("registry write denied");
    expect(deps.reconnect).not.toHaveBeenCalled();
  });
});
