import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lspNpmCachedWhich, lspNpmWhich } from "./npm-cache";

/**
 * npm is unreachable from this file, by construction.
 *
 * Arborist is the ONLY route to the registry here (`lspNpmAdd` -> `reify`), so
 * stubbing it turns an accidental install from "slow, and flaky forever in CI"
 * into a deterministic, visible failure. This is not hypothetical: with the
 * cache pointed at the real home and left partial, the pyright case fell
 * through to `lspNpmAdd` and really did GET registry.npmjs.org (measured 683ms
 * for the 404 case alone).
 */
const { reifyMock, loadVirtualMock } = vi.hoisted(() => ({
  reifyMock: vi.fn(),
  loadVirtualMock: vi.fn(),
}));

vi.mock("@npmcli/arborist", () => ({
  default: class MockArborist {
    loadVirtual = loadVirtualMock;
    reify = reifyMock;
  },
}));

/**
 * Every path this file writes lives under `tmpHome`, never under the real
 * `~/.muonroi-cli`.
 *
 * `MUONROI_CLI_HOME` is the repo-wide convention for this (see
 * src/storage/config.ts, src/usage/ledger.ts, src/chat/channel-manager.ts) and
 * `npm-cache.ts` resolves it lazily per call, so setting it here actually
 * redirects production code. It did not used to: the cache root was a
 * module-level const, this helper wrote fake packages into the REAL
 * ~/.muonroi-cli/cache/lsp/<pkg>, and `afterEach` then `rm -rf`'d them — which
 * deleted the user's genuine pyright install.
 */
let tmpHome: string;
let prevCliHome: string | undefined;

const tempDirs: string[] = [];
let expectedSuffix = "";

beforeAll(() => {
  prevCliHome = process.env.MUONROI_CLI_HOME;
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "muonroi-lsp-npm-cache-"));
  process.env.MUONROI_CLI_HOME = tmpHome;
});

afterAll(() => {
  if (prevCliHome === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = prevCliHome;
  rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => {
      // Refuse to delete anything outside the temp root. This hook previously
      // recursed into the real ~/.muonroi-cli and destroyed live LSP installs,
      // so the guard is the point, not a formality.
      const resolved = path.resolve(dir);
      if (!resolved.startsWith(path.resolve(tmpHome) + path.sep)) {
        throw new Error(`refusing to delete ${resolved}: outside the test temp root ${tmpHome}`);
      }
      return rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }),
  );
});

beforeEach(() => {
  expectedSuffix = process.platform === "win32" ? ".cmd" : "";
  loadVirtualMock.mockReset();
  reifyMock.mockReset();
  loadVirtualMock.mockResolvedValue(undefined);
  reifyMock.mockRejectedValue(new Error("npm is unreachable in unit tests: lspNpmAdd must not be called"));
});

describe("cache root isolation", () => {
  it("resolves the cache root from MUONROI_CLI_HOME, never the real home", async () => {
    const dir = await createFakePackageCache("isolated-bin", { "isolated-bin": "lib/server.js" });
    expect(dir.startsWith(path.resolve(tmpHome))).toBe(true);

    const result = await lspNpmCachedWhich("isolated-bin", "isolated-bin");

    expect(result).not.toBeNull();
    expect(result!.startsWith(path.join(tmpHome, "cache", "lsp"))).toBe(true);
    expect(result!.startsWith(path.join(os.homedir(), ".muonroi-cli"))).toBe(false);
  });
});

describe("lspNpmWhich", () => {
  it("resolves a single binary from a pre-populated cache", async () => {
    const dir = await createFakePackageCache("fake-server", { "fake-server": "lib/cli.js" });
    const result = await lspNpmWhich("fake-server");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `fake-server${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(reifyMock).not.toHaveBeenCalled();
  });

  it("resolves the correct binary from a multi-binary package", async () => {
    const dir = await createFakePackageCache("multi-bin", {
      "multi-bin": "lib/main.js",
      "multi-bin-helper": "lib/helper.js",
    });
    const result = await lspNpmWhich("multi-bin");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `multi-bin${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(reifyMock).not.toHaveBeenCalled();
  });

  // The pyright shape: the bin named after the package is the batch CLI, and the
  // language server is a DIFFERENT bin. Picking by package name launched the CLI
  // with --stdio (exit 4, "pyright --help for usage"), so Python LSP never
  // started for anyone relying on auto-install.
  //
  // The REAL package name is deliberate — that is what makes this documentation
  // of pyright's actual bin layout. It is safe because the cache root is
  // redirected to `tmpHome`; nothing here can reach the user's own install.
  it("prefers the caller's binary over the one named after the package", async () => {
    const dir = await createFakePackageCache("pyright", {
      pyright: "index.js",
      "pyright-langserver": "langserver.index.js",
    });

    const result = await lspNpmWhich("pyright", "pyright-langserver");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `pyright-langserver${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    // The fake cache must be FOUND, not reinstalled: a fall-through to
    // lspNpmAdd here is what used to download pyright from npm mid-test.
    expect(reifyMock).not.toHaveBeenCalled();
  });

  it("falls back to the package-named binary when the caller asks for one that is absent", async () => {
    const dir = await createFakePackageCache("multi-bin", {
      "multi-bin": "lib/main.js",
      "multi-bin-helper": "lib/helper.js",
    });

    const result = await lspNpmWhich("multi-bin", "not-shipped");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `multi-bin${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(reifyMock).not.toHaveBeenCalled();
  });

  it("returns null when the package cannot be installed", async () => {
    tempDirs.push(path.join(tmpHome, "cache", "lsp", "@nonexistent-scope"));

    const result = await lspNpmWhich("@nonexistent-scope/totally-fake-package-that-does-not-exist-12345");

    expect(result).toBeNull();
    // This case is the one that SHOULD reach the install path — stubbed, so the
    // failure is local instead of a registry round-trip.
    expect(reifyMock).toHaveBeenCalled();
  });
});

describe("lspNpmCachedWhich", () => {
  it("returns the cached binary path with the platform suffix", async () => {
    const dir = await createFakePackageCache("cached-bin", { "cached-bin": "lib/server.js" });

    const result = await lspNpmCachedWhich("cached-bin", "cached-bin");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `cached-bin${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(reifyMock).not.toHaveBeenCalled();
  });
});

async function createFakePackageCache(pkg: string, binEntries: Record<string, string>): Promise<string> {
  const cacheRoot = path.join(tmpHome, "cache", "lsp", pkg);
  tempDirs.push(cacheRoot);

  const binDir = path.join(cacheRoot, "node_modules", ".bin");
  const pkgDir = path.join(cacheRoot, "node_modules", pkg);
  await mkdir(binDir, { recursive: true });
  await mkdir(pkgDir, { recursive: true });

  for (const [name, target] of Object.entries(binEntries)) {
    const targetPath = path.join(pkgDir, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "#!/usr/bin/env node\n", { mode: 0o755 });

    const linkPath = path.join(binDir, name);
    const windowsLinkPath = `${linkPath}.cmd`;
    const { symlink } = await import("fs/promises");
    await symlink(path.relative(binDir, targetPath), linkPath).catch(() => {
      // Fallback: write a stub file if symlinks fail (Windows)
      return writeFile(linkPath, `#!/bin/sh\nnode "${targetPath}" "$@"\n`, { mode: 0o755 });
    });
    if (process.platform === "win32") {
      await writeFile(windowsLinkPath, `@echo off\r\nnode "${targetPath}" %*\r\n`);
    }
  }

  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkg,
      bin: Object.keys(binEntries).length === 1 ? Object.values(binEntries)[0] : binEntries,
    }),
  );

  return cacheRoot;
}
