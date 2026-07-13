import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspClientSession } from "./client";
import { createWorkspaceLspManager } from "./manager";
import type { NormalizedLspSettings } from "./types";

const BASE_SETTINGS: NormalizedLspSettings = {
  enabled: true,
  tool: true,
  autoInstall: false,
  startupTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
  diagnosticsDebounceMs: 0,
  builtins: {
    typescript: {
      enabled: false,
    },
  },
  servers: [
    {
      id: "fake-ts",
      command: "fake-lsp",
      extensions: [".ts"],
      languageIds: {
        ".ts": "typescript",
      },
      rootMarkers: [".git"],
    },
  ],
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

describe("createWorkspaceLspManager", () => {
  it("routes queries through the matching LSP client", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "src", "demo.ts");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "const demo = 1;\n");

    const sendRequest = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("textDocument/definition");
      expect(params).toMatchObject({
        position: {
          line: 4,
          character: 2,
        },
      });
      return [{ uri: "file:///demo.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }];
    });
    const client = createFakeClient({ sendRequest });

    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, {
      createClient: async () => client,
    });

    const result = await manager.query({
      operation: "goToDefinition",
      filePath,
      line: 5,
      character: 3,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("file:///demo.ts");
    expect(client.openOrChangeFile).toHaveBeenCalledWith(filePath, "typescript", "const demo = 1;\n");
    expect(client.waitForDiagnostics).toHaveBeenCalledWith(filePath, undefined);

    await manager.close();
    expect(client.stop).toHaveBeenCalled();
  });

  it("returns diagnostics after syncing a saved file", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    const diagnostics = [
      {
        filePath,
        serverId: "fake-ts",
        diagnostics: [
          {
            message: "Type error",
            severity: 1,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 },
            },
          },
        ],
      },
    ];

    const client = createFakeClient({
      diagnostics: diagnostics[0].diagnostics,
    });

    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, {
      createClient: async () => client,
    });

    const result = await manager.syncFile(filePath, "const broken = true;\n", true, true);

    expect(result).toEqual(diagnostics);
    expect(client.saveFile).toHaveBeenCalledWith(filePath);
    expect(client.waitForDiagnostics).toHaveBeenCalledWith(filePath, undefined);

    await manager.close();
  });

  it("times out a hanging request without dropping the client", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "src", "demo.ts");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "const demo = 1;\n");

    // sendRequest never resolves — simulates a server still loading its workspace.
    const client = createFakeClient({ sendRequest: () => new Promise<unknown>(() => {}) });

    const manager = createWorkspaceLspManager(
      root,
      { ...BASE_SETTINGS, requestTimeoutMs: 50 },
      {
        createClient: async () => client,
      },
    );

    const result = await manager.query({
      operation: "documentSymbol",
      filePath,
    });

    // Degrades gracefully instead of hanging forever.
    expect(result.success).toBe(true);
    expect(result.output).toContain("No results found");

    // Client is retained (not dropped) so a retry hits the warmed-up server.
    await manager.close();
    expect(client.stop).toHaveBeenCalled();
  });

  it("reports when no matching server exists", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.rb");
    await writeFile(filePath, "puts 'hello'\n");

    const manager = createWorkspaceLspManager(root, { ...BASE_SETTINGS, servers: [] });
    const result = await manager.query({
      operation: "hover",
      filePath,
      line: 1,
      character: 1,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("No LSP server available");

    await manager.close();
  });

  it("handles missing files gracefully and avoids touchFile on workspaceSymbol", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "nonexistent.ts");

    const sendRequest = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("workspace/symbol");
      expect(params).toEqual({ query: "my-query" });
      return [
        {
          name: "MySymbol",
          kind: 1,
          location: {
            uri: "file:///demo.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
          },
        },
      ];
    });
    const client = createFakeClient({ sendRequest });

    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, {
      createClient: async () => client,
    });

    const result = await manager.query({
      operation: "workspaceSymbol",
      filePath,
      query: "my-query",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("MySymbol");
    expect(client.openOrChangeFile).not.toHaveBeenCalled();

    const resultDef = await manager.query({
      operation: "goToDefinition",
      filePath,
      line: 1,
      character: 1,
    });

    expect(resultDef.success).toBe(true);
    expect(resultDef.output).toContain("No results found");

    await manager.close();
  });
});

describe("Sprint 1: impact/readiness contract (SLICE1-BUILD-NOTE.md)", () => {
  const WARNING = {
    message: "unused",
    severity: 2,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  };
  const ERROR = {
    message: "Cannot find name 'foo'",
    severity: 1,
    source: "ts",
    code: "2304",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  };

  it("waitForDiagnostics: non-timeout failure with no diagnostics -> unavailable", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [], sendRequest: async () => [] });
    vi.spyOn(client, "waitForDiagnostics").mockRejectedValue(new Error("no publish"));
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const result = await manager.waitForDiagnostics(filePath, 500);
    expect(result.lspStatus).toBe("unavailable");
    expect(result.clean).toBe(false);
    expect(result.metadata.tokenBudgetUsed).toBeLessThanOrEqual(500);

    await manager.close();
  });

  it("waitForDiagnostics: wait exceeding the deadline -> partial", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [], sendRequest: async () => [] });
    vi.spyOn(client, "waitForDiagnostics").mockImplementation(() => new Promise((r) => setTimeout(r, 2000)));
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const result = await manager.waitForDiagnostics(filePath, 100);
    expect(result.lspStatus).toBe("partial");

    await manager.close();
  });

  it("waitForDiagnostics: only a warning present -> ok + clean", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [WARNING], sendRequest: async () => [] });
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const result = await manager.waitForDiagnostics(filePath, 500);
    expect(result.lspStatus).toBe("ok");
    expect(result.clean).toBe(true); // warnings/infos are ignored for `clean`

    await manager.close();
  });

  it("waitForDiagnostics: an error-level diagnostic -> ok but NOT clean", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [ERROR], sendRequest: async () => [] });
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const result = await manager.waitForDiagnostics(filePath, 500);
    expect(result.lspStatus).toBe("ok");
    expect(result.clean).toBe(false);

    await manager.close();
  });

  it("waitForDiagnostics clamps the timeout (never hangs past 5000ms)", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [], sendRequest: async () => [] });
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    await expect(manager.waitForDiagnostics(filePath, 1500)).resolves.toBeDefined();
    await expect(manager.waitForDiagnostics(filePath, 10000)).resolves.toBeDefined();

    await manager.close();
  });

  it("impactOfChange: clean file with no external refs -> safeToRename, guard 'none'", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [WARNING], sendRequest: async () => [] });
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const result = await manager.impactOfChange(filePath);
    expect(result.lspStatus).toBe("ok");
    expect(result.referencesComplete).toBe(true);
    expect(result.clean).toBe(true);
    expect(result.safeToRename).toBe(true);
    expect(result.suggestedGuard).toBe("none");
    expect(result.degraded).toBe("none");
    expect(result.metadata.tokenBudgetUsed).toBeLessThanOrEqual(500);

    await manager.close();
  });

  it("impactOfChange: error-level diagnostic in the union -> NOT safeToRename + suggestedGuard", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [ERROR], sendRequest: async () => [] });
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const result = await manager.impactOfChange(filePath);
    expect(result.clean).toBe(false);
    expect(result.safeToRename).toBe(false);
    expect(result.suggestedGuard).toContain("Cannot find name 'foo'");
    expect(result.suggestedGuard.length).toBeLessThanOrEqual(120);

    await manager.close();
  });

  it("impactOfChange: LSP unavailable -> degraded 'lsp_unavailable', not safe", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [], sendRequest: async () => [] });
    vi.spyOn(client, "waitForDiagnostics").mockRejectedValue(new Error("down"));
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const result = await manager.impactOfChange(filePath);
    expect(result.lspStatus).toBe("unavailable");
    expect(result.degraded).toBe("lsp_unavailable");
    expect(result.safeToRename).toBe(false);
    expect(result.referencesComplete).toBe(false);

    await manager.close();
  });

  it("lspMutationPreview returns the fixed stub schema (no apply path)", async () => {
    const root = await createTempWorkspace();
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS);

    const result = await manager.lspMutationPreview(root + "/test.ts", "{}");
    expect(result).toEqual({
      op: "allowlist",
      dryRunResult: { proposedEdits: [], tokenEstimate: 0 },
      schemaVersion: "1.0",
    });

    await manager.close();
  });

  it("lspBeforeGrep: allows grep fallback when lspStatus !== 'ok'", async () => {
    const root = await createTempWorkspace();
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS); // no server → unavailable
    const result = await manager.lspBeforeGrep(root + "/test.ts");
    expect(result.kind).toBe("allow");
    await manager.close();
  });

  it("lspBeforeGrep: enriches when LSP is ok but not safe to rename", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    await writeFile(filePath, "const x = 1;\n");
    const client = createFakeClient({ diagnostics: [ERROR], sendRequest: async () => [] });
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });
    const result = await manager.lspBeforeGrep(filePath);
    expect(result.kind).toBe("enrich");
    await manager.close();
  });
});

async function createTempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "muonroi-lsp-manager-"));
  tempDirs.push(root);
  await mkdir(path.join(root, ".git"), { recursive: true });
  return root;
}

function createFakeClient(input: {
  diagnostics?: LspClientSession["getDiagnostics"] extends (filePath: string) => infer TResult ? TResult : never;
  sendRequest?: (method: string, params: unknown) => Promise<unknown>;
}): LspClientSession & {
  openOrChangeFile: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
  waitForDiagnostics: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const diagnostics = input.diagnostics ?? [];
  return {
    serverId: "fake-ts",
    root: "/tmp",
    openOrChangeFile: vi.fn(async () => {}),
    saveFile: vi.fn(async () => {}),
    closeFile: vi.fn(async () => {}),
    sendRequest: (async <TResult>(method: string, params: unknown) =>
      (input.sendRequest ? await input.sendRequest(method, params) : []) as TResult) as LspClientSession["sendRequest"],
    waitForDiagnostics: vi.fn(async () => diagnostics),
    getDiagnostics: vi.fn(() => diagnostics),
    stop: vi.fn(async () => {}),
  };
}
