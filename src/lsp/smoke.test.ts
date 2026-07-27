import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLspClientSession } from "./client.js";
import { lspNpmCachedWhich, lspNpmWhich } from "./npm-cache.js";

let tsServerAvailable = false;
let cachedTsServerAvailable = false;
let cachedTsServerCommand: string | null = null;
let bundledTsServerPath: string | null = null;
let tmpDir = "";

beforeAll(async () => {
  // Check if typescript-language-server AND typescript are both available
  try {
    execSync("bunx typescript-language-server --version", { timeout: 5000, stdio: "pipe" });
    execSync("bunx tsc --version", { timeout: 5000, stdio: "pipe" });
    tsServerAvailable = true;
  } catch {
    tsServerAvailable = false;
  }

  try {
    cachedTsServerCommand = await lspNpmWhich("typescript-language-server", "typescript-language-server");
    cachedTsServerAvailable = cachedTsServerCommand !== null;
  } catch {
    cachedTsServerAvailable = false;
    cachedTsServerCommand = null;
  }

  bundledTsServerPath = resolveBundledTsServerPath();

  // Create temp directory with a minimal TypeScript project
  tmpDir = path.join(os.tmpdir(), `lsp-smoke-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  writeFileSync(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
    "utf8",
  );

  writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "lsp-smoke", private: true }, null, 2),
    "utf8",
  );

  writeFileSync(path.join(tmpDir, "test.ts"), "const x: number = 1;\n", "utf8");
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Best-effort cleanup
  }
});

describe("LSP smoke test — createLspClientSession", () => {
  it("initializes LSP session with typescript-language-server", { timeout: 30000 }, async () => {
    if (!tsServerAvailable || !bundledTsServerPath || process.env.CI) return;

    const session = await createLspClientSession({
      serverId: "ts-smoke",
      root: tmpDir,
      launch: {
        command: "bunx",
        args: ["typescript-language-server", "--stdio"],
        initializationOptions: { tsserver: { path: bundledTsServerPath } },
      },
      startupTimeoutMs: 15000,
      diagnosticsDebounceMs: 500,
    });

    expect(session.serverId).toBe("ts-smoke");

    await session.openOrChangeFile(path.join(tmpDir, "test.ts"), "typescript", "const x: number = 1;");

    await session.stop();
  });

  it("initializes LSP session with the cached npm binary path", { timeout: 30000 }, async () => {
    if (!cachedTsServerAvailable || !bundledTsServerPath || process.env.CI) return;

    const cachedCommand = await lspNpmCachedWhich("typescript-language-server", "typescript-language-server");

    expect(cachedCommand).toBe(cachedTsServerCommand);
    expect(cachedCommand).not.toBeNull();
    if (process.platform === "win32") {
      expect(cachedCommand).toMatch(/\.cmd$/);
    } else {
      expect(cachedCommand).not.toMatch(/\.cmd$/);
    }

    const session = await createLspClientSession({
      serverId: "ts-cache-smoke",
      root: tmpDir,
      launch: {
        command: cachedCommand!,
        args: ["--stdio"],
        initializationOptions: { tsserver: { path: bundledTsServerPath } },
      },
      startupTimeoutMs: 15000,
      diagnosticsDebounceMs: 500,
    });

    expect(session.serverId).toBe("ts-cache-smoke");

    await session.openOrChangeFile(path.join(tmpDir, "test.ts"), "typescript", "const x: number = 1;");
    const diagnostics = await session.waitForDiagnostics(path.join(tmpDir, "test.ts"), 5000);
    expect(Array.isArray(diagnostics)).toBe(true);

    await session.stop();
  });

  it("createLspClientSession rejects for non-existent command", { timeout: 10000 }, async () => {
    await expect(
      createLspClientSession({
        serverId: "bad",
        root: os.tmpdir(),
        launch: { command: "nonexistent-lsp-binary-xyz" },
        startupTimeoutMs: 2000,
        diagnosticsDebounceMs: 500,
      }),
    ).rejects.toThrow();
  });
});

function resolveBundledTsServerPath(): string | null {
  const bunPackagesDir = path.join(process.cwd(), "node_modules", ".bun");
  if (!existsSync(bunPackagesDir)) return null;

  for (const entry of readdirSync(bunPackagesDir)) {
    if (!entry.startsWith("typescript@")) continue;
    const candidate = path.join(bunPackagesDir, entry, "node_modules", "typescript", "lib", "tsserver.js");
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
