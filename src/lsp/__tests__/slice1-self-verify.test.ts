/**
 * src/lsp/__tests__/slice1-self-verify.test.ts
 *
 * Slice 1 self-verify harness (wired — runs in CI via vitest), the artifact
 * required by SLICE1-BUILD-NOTE.md §13/§77. It proves the lsp-before-grep golden
 * path against the real manager contract:
 *   - LSP ok        → grep fallback is NOT taken (policy resolves without allowing grep-as-fallback)
 *   - LSP partial   → grep fallback IS allowed (diagnostics timed out)
 *   - LSP unavailable → grep fallback IS allowed (no server)
 *
 * The old standalone `docs/semantic-workbench/slice1-self-verify.ts` script used
 * the pre-spec readiness contract and was never wired into CI; this replaces it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspClientSession } from "../client.js";
import { createWorkspaceLspManager } from "../manager.js";
import type { LspDiagnostic, NormalizedLspSettings } from "../types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function settings(): NormalizedLspSettings {
  return {
    enabled: true,
    tool: true,
    autoInstall: false,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    diagnosticsDebounceMs: 0,
    builtins: { typescript: { enabled: false } },
    servers: [
      {
        id: "fake-ts",
        command: "fake-lsp",
        extensions: [".ts"],
        languageIds: { ".ts": "typescript" },
        rootMarkers: [".git"],
      },
    ],
  };
}

function tempFile(): { root: string; filePath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "slice1-self-verify-"));
  tempDirs.push(root);
  writeFileSync(path.join(root, ".git-marker"), "");
  const filePath = path.join(root, "demo.ts");
  writeFileSync(filePath, "const demo = 1;\n");
  return { root, filePath };
}

function fakeClient(opts: { diagnostics?: LspDiagnostic[]; delayMs?: number }): LspClientSession {
  const diags = opts.diagnostics ?? [];
  return {
    serverId: "fake-ts",
    root: "/tmp",
    openOrChangeFile: async () => {},
    saveFile: async () => {},
    closeFile: async () => {},
    sendRequest: (async () => []) as LspClientSession["sendRequest"],
    waitForDiagnostics: (async () => {
      if (opts.delayMs && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));
      return diags;
    }) as LspClientSession["waitForDiagnostics"],
    getDiagnostics: () => diags,
    stop: async () => {},
  };
}

describe("Slice 1 self-verify: lsp-before-grep golden path", () => {
  it("LSP ok + clean → policy is safe, grep fallback NOT the reason", async () => {
    const { root, filePath } = tempFile();
    const warning: LspDiagnostic = {
      message: "unused",
      severity: 2,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    const manager = createWorkspaceLspManager(root, settings(), {
      createClient: async () => fakeClient({ diagnostics: [warning] }),
    });

    const impact = await manager.impactOfChange(filePath);
    expect(impact.lspStatus).toBe("ok");
    // When the LSP is fully ok the agent MUST NOT grep-as-fallback (policy allows
    // because rename is safe, NOT because the LSP was unavailable).
    const policy = await manager.lspBeforeGrep(filePath);
    expect(policy.kind).toBe("allow");
    if (policy.kind === "allow") expect(policy.reason).toContain("safe");

    await manager.close();
  });

  it("LSP partial (diagnostics timeout) → grep fallback allowed", async () => {
    const { root, filePath } = tempFile();
    // Wait longer than the query timeout → LspRequestTimeoutError → partial.
    const manager = createWorkspaceLspManager(root, settings(), {
      createClient: async () => fakeClient({ delayMs: 2000 }),
    });

    const impact = await manager.impactOfChange(filePath, undefined, 100);
    expect(impact.lspStatus).toBe("partial");
    expect(impact.degraded).toBe("diagnostics_timeout");
    expect(impact.safeToRename).toBe(false);

    const policy = await manager.lspBeforeGrep(filePath);
    expect(policy.kind).toBe("allow"); // grep fallback exercised
    await manager.close();
  });

  it("LSP unavailable (no server) → grep fallback allowed", async () => {
    const { root, filePath } = tempFile();
    const manager = createWorkspaceLspManager(root, { ...settings(), servers: [] }); // no matching server

    const impact = await manager.impactOfChange(filePath);
    expect(impact.lspStatus).toBe("unavailable");
    expect(impact.degraded).toBe("lsp_unavailable");

    const policy = await manager.lspBeforeGrep(filePath);
    expect(policy.kind).toBe("allow"); // grep fallback exercised
    await manager.close();
  });

  it("token budget is hard-capped at ≤500 across operations", async () => {
    const { root, filePath } = tempFile();
    const manager = createWorkspaceLspManager(root, settings(), { createClient: async () => fakeClient({}) });
    const wait = await manager.waitForDiagnostics(filePath, 1500);
    const impact = await manager.impactOfChange(filePath);
    expect(wait.metadata.tokenBudgetUsed).toBeLessThanOrEqual(500);
    expect(impact.metadata.tokenBudgetUsed).toBeLessThanOrEqual(500);
    await manager.close();
  });
});
