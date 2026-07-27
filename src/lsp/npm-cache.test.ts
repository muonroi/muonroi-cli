import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lspNpmCachedWhich, lspNpmWhich } from "./npm-cache";

const tempDirs: string[] = [];
let expectedSuffix = "";

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

beforeEach(() => {
  expectedSuffix = process.platform === "win32" ? ".cmd" : "";
});

describe("lspNpmWhich", () => {
  it("resolves a single binary from a pre-populated cache", async () => {
    const dir = await createFakePackageCache("fake-server", { "fake-server": "lib/cli.js" });
    const result = await lspNpmWhich("fake-server");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `fake-server${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
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
  });

  // The pyright shape: the bin named after the package is the batch CLI, and the
  // language server is a DIFFERENT bin. Picking by package name launched the CLI
  // with --stdio (exit 4, "pyright --help for usage"), so Python LSP never
  // started for anyone relying on auto-install.
  it("prefers the caller's binary over the one named after the package", async () => {
    const dir = await createFakePackageCache("pyright", {
      pyright: "index.js",
      "pyright-langserver": "langserver.index.js",
    });

    const result = await lspNpmWhich("pyright", "pyright-langserver");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `pyright-langserver${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
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
  });

  it("returns null when the package cannot be installed", async () => {
    const result = await lspNpmWhich("@nonexistent-scope/totally-fake-package-that-does-not-exist-12345");
    expect(result).toBeNull();
  });
});

describe("lspNpmCachedWhich", () => {
  it("returns the cached binary path with the platform suffix", async () => {
    const dir = await createFakePackageCache("cached-bin", { "cached-bin": "lib/server.js" });

    const result = await lspNpmCachedWhich("cached-bin", "cached-bin");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", `cached-bin${expectedSuffix}`));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
  });
});

async function createFakePackageCache(pkg: string, binEntries: Record<string, string>): Promise<string> {
  const cacheRoot = path.join(os.homedir(), ".muonroi-cli", "cache", "lsp", pkg);
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
