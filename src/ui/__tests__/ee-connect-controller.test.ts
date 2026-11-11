import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EE_HOSTED_URL, EE_LOCAL_URL } from "../../ee/ee-connect.js";
import type { LocalBrainDeps } from "../../ee/local-brain.js";
import {
  buildEeConnectActions,
  connectHostedEE,
  connectLocalEE,
  connectSetupLocalEE,
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
  it("offers hosted, local, setup-local, how-it-works, and not-now — in that order", () => {
    expect(buildEeConnectActions().map((a) => a.id)).toEqual(["hosted", "local", "setup-local", "how", "not-now"]);
  });

  it("labels derive from the descriptor (hints mention the endpoints)", () => {
    const actions = buildEeConnectActions();
    expect(actions.find((a) => a.id === "hosted")?.hint).toContain(EE_HOSTED_URL);
    expect(actions.find((a) => a.id === "local")?.hint).toContain(EE_LOCAL_URL);
    expect(actions.find((a) => a.id === "setup-local")?.hint).toContain(EE_LOCAL_URL);
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

/**
 * Run `connectSetupLocalEE` with an injected `setupLocalBrain` that only records
 * the `LocalBrainDeps` it was handed, so a test can interrogate the seams the
 * controller built. The production `setupLocalBrain` is NEVER invoked — these
 * tests must not touch the real home.
 */
async function captureBrainDeps(): Promise<{ brainDeps: LocalBrainDeps; deps: EeConnectDeps }> {
  const { deps } = makeDeps();
  let captured: LocalBrainDeps | undefined;
  deps.setupLocalBrain = vi.fn(async (brainDeps): Promise<{ ok: true; detail: string }> => {
    captured = brainDeps;
    return { ok: true, detail: "captured" };
  });
  const result = await connectSetupLocalEE(deps);
  expect(result.ok).toBe(true);
  if (!captured) {
    throw new Error("connectSetupLocalEE never invoked setupLocalBrain with brainDeps");
  }
  return { brainDeps: captured, deps };
}

describe("connectSetupLocalEE", () => {
  it("happy path: delegates to setupLocalBrain and returns the same shape", async () => {
    const { deps } = makeDeps();
    deps.setupLocalBrain = vi.fn(
      async (): Promise<{ ok: true; detail: string }> => ({
        ok: true,
        detail: "local brain provisioned at 127.0.0.1:9999",
      }),
    );
    const result = await connectSetupLocalEE(deps);
    expect(result).toEqual({
      ok: true,
      detail: "local brain provisioned at 127.0.0.1:9999",
    });
    expect(deps.setupLocalBrain).toHaveBeenCalledTimes(1);
  });

  it("failure path: returns the setupLocalBrain error without throwing", async () => {
    const { deps } = makeDeps();
    deps.setupLocalBrain = vi.fn(
      async (): Promise<{ ok: false; error: string }> => ({
        ok: false,
        error: "npm package missing",
      }),
    );
    const result = await connectSetupLocalEE(deps);
    expect(result).toEqual({ ok: false, error: "npm package missing" });
  });

  it("returns a wiring error when setupLocalBrain dep is not provided", async () => {
    const { deps } = makeDeps({ setupLocalBrain: undefined });
    const result = await connectSetupLocalEE(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not wired");
    }
  });

  it('brainDeps resolve a REAL home (resolveUserHome is not the dead `() => ""` stub)', async () => {
    const { brainDeps } = await captureBrainDeps();
    // The seam must exist at all — a missing one is the same bug in disguise,
    // because setupLocalBrain falls back to `?? ""` at src/ee/local-brain.ts:361.
    expect(brainDeps.resolveUserHome).toBeTypeOf("function");
    const home = brainDeps.resolveUserHome!();
    expect(typeof home).toBe("string");
    expect(home.length).toBeGreaterThan(0);
  });

  it("brainDeps.env is live: MUONROI_EE_PACKAGE_ROOT is read through to process.env", async () => {
    const { brainDeps } = await captureBrainDeps();
    expect(brainDeps.env).toBeTypeOf("function");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ee-connect-root-"));
    const key = "MUONROI_EE_PACKAGE_ROOT";
    const previous = process.env[key];
    try {
      process.env[key] = tmp;
      expect(brainDeps.env!(key)).toBe(tmp);
      // A variable that is not set is `undefined`, not a throw.
      expect(brainDeps.env!("MUONROI_EE_PACKAGE_ROOT_ABSENT_SENTINEL")).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writeConfig receives the SAME home setupLocalBrain resolved", async () => {
    const { brainDeps, deps } = await captureBrainDeps();
    const home = mkdtempSync(path.join(os.tmpdir(), "ee-connect-home-"));
    try {
      await brainDeps.writeConfig!({ serverBaseUrl: "http://127.0.0.1:9" }, { home });
      expect(deps.writeConfig).toHaveBeenCalledWith({ serverBaseUrl: "http://127.0.0.1:9" }, { home });
      const call = vi.mocked(deps.writeConfig).mock.calls[0]!;
      expect(call).toHaveLength(2);
      expect(call[1]?.home).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reloadAuth receives the SAME home setupLocalBrain resolved", async () => {
    const { brainDeps, deps } = await captureBrainDeps();
    await brainDeps.reloadAuth!("/tmp/x");
    expect(deps.reloadAuth).toHaveBeenCalledWith("/tmp/x");
    const call = vi.mocked(deps.reloadAuth).mock.calls[0]!;
    expect(call).toHaveLength(1);
    expect(call[0]).toBe("/tmp/x");
  });

  it("brainDeps keep the real pathExists / ensureStoreDir / localUrl seams (not stubs)", async () => {
    const { brainDeps } = await captureBrainDeps();
    // Regression guard for the hand-rolled stub set: `pathExists: () => false`
    // rejected every candidate server root and `localUrl: undefined` erased the
    // default EE_LOCAL_URL probe target.
    expect(brainDeps.localUrl).toBe(EE_LOCAL_URL);
    expect(brainDeps.pathExists).toBeTypeOf("function");
    expect(brainDeps.ensureStoreDir).toBeTypeOf("function");
    expect(brainDeps.findFreePort).toBeTypeOf("function");
  });

  it("regression: connectHostedEE and connectLocalEE still call writeConfig with ONE argument", async () => {
    const hosted = makeDeps();
    await connectHostedEE("tok-123", hosted.deps);
    expect(hosted.deps.writeConfig).toHaveBeenCalledWith({
      serverBaseUrl: EE_HOSTED_URL,
      serverAuthToken: "tok-123",
    });
    expect(vi.mocked(hosted.deps.writeConfig).mock.calls[0]).toHaveLength(1);

    const local = makeDeps();
    await connectLocalEE(local.deps);
    expect(local.deps.writeConfig).toHaveBeenCalledWith({ serverBaseUrl: EE_LOCAL_URL });
    expect(vi.mocked(local.deps.writeConfig).mock.calls[0]).toHaveLength(1);
  });
});
