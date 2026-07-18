import { describe, expect, it, vi } from "vitest";
import { EE_HOSTED_URL, EE_LOCAL_URL } from "../../ee/ee-connect.js";
import {
  buildEeConnectActions,
  connectHostedEE,
  connectLocalEE,
  type EeConnectDeps,
} from "../ee-connect-controller.js";

function makeDeps(overrides: Partial<EeConnectDeps> = {}) {
  const calls: string[] = [];
  const deps: EeConnectDeps = {
    probeHealth: vi.fn(async () => {
      calls.push("probe");
      return { ok: true, detail: "HTTP 200" };
    }),
    writeConfig: vi.fn(async () => {
      calls.push("write");
    }),
    reloadAuth: vi.fn(async () => {
      calls.push("reload");
      return null;
    }),
    recordConnected: vi.fn(() => {
      calls.push("record");
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("buildEeConnectActions", () => {
  it("offers hosted, local, how-it-works, and not-now — in that order", () => {
    expect(buildEeConnectActions().map((a) => a.id)).toEqual(["hosted", "local", "how", "not-now"]);
  });

  it("labels derive from the descriptor (hints mention the endpoints)", () => {
    const actions = buildEeConnectActions();
    expect(actions.find((a) => a.id === "hosted")?.hint).toContain(EE_HOSTED_URL);
    expect(actions.find((a) => a.id === "local")?.hint).toContain(EE_LOCAL_URL);
  });
});

describe("connectHostedEE", () => {
  it("happy path: probe with token → write config → reload cache → record connected", async () => {
    const { deps, calls } = makeDeps();
    const result = await connectHostedEE("  tok-123  ", deps);
    expect(result).toEqual({ ok: true, detail: "HTTP 200" });
    expect(calls).toEqual(["probe", "write", "reload", "record"]);
    expect(deps.probeHealth).toHaveBeenCalledWith(EE_HOSTED_URL, "tok-123");
    expect(deps.writeConfig).toHaveBeenCalledWith({ serverBaseUrl: EE_HOSTED_URL, serverAuthToken: "tok-123" });
  });

  it("rejects a blank token without probing", async () => {
    const { deps } = makeDeps();
    const result = await connectHostedEE("   ", deps);
    expect(result.ok).toBe(false);
    expect(deps.probeHealth).not.toHaveBeenCalled();
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it("does NOT write config when the probe fails, and never echoes the token", async () => {
    const { deps } = makeDeps({
      probeHealth: vi.fn(async () => ({ ok: false, detail: "HTTP 401 — the server rejected this auth token" })),
    });
    const result = await connectHostedEE("secret-token-abc", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("HTTP 401");
      expect(result.error).not.toContain("secret-token-abc");
    }
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.recordConnected).not.toHaveBeenCalled();
  });

  it("surfaces a config-write failure as an error", async () => {
    const { deps } = makeDeps({
      writeConfig: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    const result = await connectHostedEE("tok-123", deps);
    expect(result).toEqual({ ok: false, error: "Could not write EE config: EACCES" });
    expect(deps.recordConnected).not.toHaveBeenCalled();
  });
});

describe("connectLocalEE", () => {
  it("auto-detect reachable: writes config (no token) and records connected", async () => {
    const { deps, calls } = makeDeps();
    const result = await connectLocalEE(deps);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["probe", "write", "reload", "record"]);
    expect(deps.probeHealth).toHaveBeenCalledWith(EE_LOCAL_URL);
    expect(deps.writeConfig).toHaveBeenCalledWith({ serverBaseUrl: EE_LOCAL_URL });
  });

  it("auto-detect unreachable: returns the start-it-or-use-hosted hint, writes nothing", async () => {
    const { deps } = makeDeps({
      probeHealth: vi.fn(async () => ({ ok: false, detail: "fetch failed" })),
    });
    const result = await connectLocalEE(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(EE_LOCAL_URL);
      expect(result.error).toContain("start it, or use the hosted brain");
    }
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.recordConnected).not.toHaveBeenCalled();
  });
});
