import Arborist from "@npmcli/arborist";
import { access, mkdir, readdir, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";

const CACHE_ROOT = path.join(os.homedir(), ".muonroi-cli", "cache", "lsp");
const locks = new Map<string, Promise<unknown>>();

function packageDir(pkg: string): string {
  const sanitized =
    process.platform === "win32"
      ? Array.from(pkg, (ch) => (/[<>:"|?*]/.test(ch) || ch.charCodeAt(0) < 32 ? "_" : ch)).join("")
      : pkg;
  return path.join(CACHE_ROOT, sanitized);
}

/**
 * Absolute path to a language-server binary in the cache, installing the package
 * on first use.
 *
 * `preferredBin` is the binary the CALLER needs, which is not always the one
 * named after the package: `pyright` ships both `pyright` (the batch CLI) and
 * `pyright-langserver` (the LSP server). Choosing by package name alone launched
 * the CLI with `--stdio`, which exits 4 with "pyright --help for usage" — so
 * Python LSP never started for anyone relying on auto-install.
 */
export async function lspNpmWhich(pkg: string, preferredBin?: string): Promise<string | null> {
  const dir = packageDir(pkg);
  const binDir = path.join(dir, "node_modules", ".bin");

  const pick = async (): Promise<string | undefined> => {
    const files = await readdir(binDir).catch((): string[] => []);
    if (files.length === 0) return undefined;
    // The caller's choice wins whenever the package actually ships it. Match the
    // extension-less shim: Windows also lists .cmd/.ps1 wrappers for each bin.
    if (preferredBin && files.includes(preferredBin)) return preferredBin;
    if (files.length === 1) return files[0];

    const pkgJsonPath = path.join(dir, "node_modules", pkg, "package.json");
    const pkgJson = await readJsonSafe<{ bin?: string | Record<string, string> }>(pkgJsonPath);
    if (pkgJson?.bin) {
      const unscoped = pkg.startsWith("@") ? pkg.split("/")[1]! : pkg;
      const bin = pkgJson.bin;
      if (typeof bin === "string") return unscoped;
      const keys = Object.keys(bin);
      if (keys.length === 1) return keys[0];
      if (preferredBin && bin[preferredBin]) return preferredBin;
      return bin[unscoped] ? unscoped : keys[0];
    }
    return files[0];
  };

  const bin = await pick();
  if (bin) return path.join(binDir, bin);

  try {
    await rm(path.join(dir, "package-lock.json"), { force: true });
    await lspNpmAdd(pkg);
  } catch (err) {
    console.error(
      `[lsp:npm-cache] auto-install of "${pkg}" into ${dir} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const resolved = await pick();
  if (!resolved) return null;
  return path.join(binDir, resolved);
}

export async function lspNpmAdd(pkg: string): Promise<string> {
  return withPackageLock(pkg, async () => {
    const dir = packageDir(pkg);
    await mkdir(dir, { recursive: true });

    const arborist = new Arborist({
      path: dir,
      binLinks: true,
      progress: false,
      savePrefix: "",
      ignoreScripts: true,
    } as ConstructorParameters<typeof Arborist>[0]);

    const tree = await arborist.loadVirtual().catch(() => undefined);
    if (tree) {
      const first = tree.edgesOut.values().next().value?.to;
      if (first?.path) return first.path as string;
    }

    const result = await arborist.reify({
      add: [pkg],
      save: true,
      saveType: "prod" as const,
    });

    const first = result.edgesOut.values().next().value?.to;
    if (!first?.path) throw new Error(`Failed to install ${pkg}`);
    return first.path as string;
  });
}

async function readJsonSafe<T>(filePath: string): Promise<T | undefined> {
  try {
    await access(filePath);
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function withPackageLock<T>(pkg: string, fn: () => Promise<T>): Promise<T> {
  const key = `lsp-install:${pkg}`;
  while (locks.has(key)) {
    await locks.get(key)!.catch(() => {});
  }
  const task = fn();
  locks.set(key, task);
  try {
    return await task;
  } finally {
    if (locks.get(key) === task) {
      locks.delete(key);
    }
  }
}
