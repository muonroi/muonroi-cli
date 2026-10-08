/**
 * This file PROBES for a language server; it never provisions one.
 *
 * Test-selection policy, and why:
 *
 * `beforeAll` used to call `lspNpmWhich("typescript-language-server", …)` — the
 * INSTALLING resolver — so on a cold cache the hook reified the package from
 * registry.npmjs.org into the developer's real `~/.muonroi-cli/cache/lsp/`
 * (`MUONROI_CLI_HOME` is pinned per-file, e.g. `npm-cache.test.ts:49-53`, not
 * globally in `src/__test-stubs__/vitest-setup.ts`). Both session tests then
 * early-returned under `process.env.CI`, so a cold CI run paid for a network
 * install and asserted nothing. It also shelled out to
 * `bunx typescript-language-server --version`, a second network install —
 * `typescript-language-server` is not a dependency of this repo.
 *
 * The policy now: the session tests run only when a server is ALREADY warm in
 * the cache, discovered with the non-installing `lspNpmCachedWhich`. What that
 * costs is honest to lose — on a cold machine the old test only "ran" because
 * its own hook had just downloaded the server, i.e. it was measuring a cache it
 * had created. `lspNpmCachedWhich`'s own contract (platform suffix, cache-root
 * isolation) is already covered hermetically, with Arborist stubbed, at
 * `npm-cache.test.ts:84-95` and `:171-181`. What remains unique here — does
 * `createLspClientSession` actually initialise against a real server binary —
 * needs a real binary and cannot be faked, so it is conditional by nature.
 *
 * The `bunx` launch case is gone rather than rewritten: `bunx` is not a launch
 * path any production code takes. `resolveNodeServerLaunch`
 * (`src/lsp/builtins.ts:405-427`) resolves a server from PATH/node_modules or
 * from the npm cache's absolute path, which is what the surviving case drives.
 *
 * Pinned by `src/lsp/__tests__/no-network-install-in-tests.test.ts`.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLspClientSession } from "./client.js";
import { lspNpmCachedWhich } from "./npm-cache.js";

let cachedTsServerAvailable = false;
let cachedTsServerCommand: string | null = null;
let bundledTsServerPath: string | null = null;
let tmpDir = "";

/** Why the real-server cases did not run, printed once so a green run is not mistaken for a verified one. */
let skipReason: string | null = null;

beforeAll(async () => {
  // NON-INSTALLING probe. A cold cache must stay cold: this hook may not reach
  // the network, and it may not write to the real ~/.muonroi-cli.
  try {
    cachedTsServerCommand = await lspNpmCachedWhich("typescript-language-server", "typescript-language-server");
    cachedTsServerAvailable = cachedTsServerCommand !== null;
  } catch (err) {
    // A probe that only reads a directory should not throw; if it does, say so
    // rather than reporting the server as merely absent.
    console.error(
      `[lsp:smoke] lspNpmCachedWhich probe failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    cachedTsServerAvailable = false;
    cachedTsServerCommand = null;
  }

  bundledTsServerPath = resolveBundledTsServerPath();

  if (process.env.CI) skipReason = "CI=1 — real-subprocess LSP cases are not run in CI";
  else if (!cachedTsServerAvailable)
    skipReason =
      "typescript-language-server is not warm in the LSP cache; warm it outside the test run " +
      "(`bun run src/index.ts` → `/lsp setup`) — this test will not install it";
  else if (!bundledTsServerPath) skipReason = "no bundled typescript/lib/tsserver.js under node_modules/.bun";
  if (skipReason) console.warn(`[lsp:smoke] real-server cases SKIPPED: ${skipReason}`);

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
  } catch (err) {
    // Best-effort cleanup: a live tsserver child can still hold a handle on
    // Windows. Logged rather than swallowed so a leaked temp dir is traceable.
    console.error(`[lsp:smoke] temp dir cleanup failed for ${tmpDir}: ${err instanceof Error ? err.message : err}`);
  }
});

describe("LSP smoke test — createLspClientSession", () => {
  it("initializes LSP session with the cached npm binary path", { timeout: 30000 }, async () => {
    if (skipReason) return;

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
