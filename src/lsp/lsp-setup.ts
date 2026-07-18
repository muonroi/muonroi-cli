/**
 * src/lsp/lsp-setup.ts
 *
 * "Smart install" pipeline behind the first-run LSP language onboarding card.
 * Pure/DI: every IO (PATH lookup, npm-cache warm, toolchain spawn, project
 * scan) is injectable so the classification + install matrix is unit-testable
 * with mocks. Mirrors the ee-connect controller philosophy: the React side
 * holds only keyboard/render state; all decisions live here.
 *
 * Install matrix (per built-in server):
 *   - npm       — auto-installable NOW via the existing lspNpmWhich warm path
 *                 (typescript, pyright, bash-language-server, yaml-language-server).
 *   - toolchain — needs a language toolchain on PATH; when the toolchain IS
 *                 present we run its one-line install command (gopls via `go`,
 *                 rust-analyzer via `rustup`, csharp-ls via `dotnet`); when it
 *                 is missing we fall back to a copyable manual command.
 *   - manual    — OS-dependent (clangd via apt/brew, jdtls, sourcekit-lsp):
 *                 NEVER auto-run; the card shows the exact command/link.
 *
 * Note on hardcoded names: LSP binary/package/toolchain names are tool
 * identifiers (not model/provider ids) — the Zero Hardcode Rule does not
 * apply. They are kept in ONE named table below.
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { findCommandOnPath, listBuiltInServerMeta } from "./builtins.js";
import { lspNpmCachedWhich, lspNpmWhich } from "./npm-cache.js";
import type { LspBuiltInServerId } from "./types.js";

export type LspInstallKind = "npm" | "toolchain" | "manual";

export interface LspInstallRecipe {
  id: LspBuiltInServerId;
  /** Human-readable language label shown in the picker. */
  label: string;
  kind: LspInstallKind;
  /** Binary whose PATH presence means "already installed". */
  binary: string;
  /** npm kind: package + bin for the lspNpmWhich warm path. */
  npm?: { pkg: string; bin: string };
  /** toolchain kind: required toolchain binary + safe one-line install argv. */
  toolchain?: { bin: string; args: string[] };
  /** Exact command/instruction shown when auto-install is not safe/possible. */
  manualCommand: string;
}

/**
 * Single source of truth for HOW each built-in server installs. The language
 * LIST itself derives from listBuiltInServerMeta() (builtins.ts) — this table
 * only adds install metadata and must stay keyed by the same ids (the
 * controller test enforces 1:1 coverage).
 */
export const LSP_INSTALL_RECIPES: Record<LspBuiltInServerId, LspInstallRecipe> = {
  typescript: {
    id: "typescript",
    label: "TypeScript / JavaScript",
    kind: "npm",
    binary: "typescript-language-server",
    npm: { pkg: "typescript-language-server", bin: "typescript-language-server" },
    manualCommand: "npm install -g typescript-language-server typescript",
  },
  pyright: {
    id: "pyright",
    label: "Python",
    kind: "npm",
    binary: "pyright-langserver",
    npm: { pkg: "pyright", bin: "pyright-langserver" },
    manualCommand: "npm install -g pyright",
  },
  gopls: {
    id: "gopls",
    label: "Go",
    kind: "toolchain",
    binary: "gopls",
    toolchain: { bin: "go", args: ["install", "golang.org/x/tools/gopls@latest"] },
    manualCommand: "go install golang.org/x/tools/gopls@latest",
  },
  "rust-analyzer": {
    id: "rust-analyzer",
    label: "Rust",
    kind: "toolchain",
    binary: "rust-analyzer",
    toolchain: { bin: "rustup", args: ["component", "add", "rust-analyzer"] },
    manualCommand: "rustup component add rust-analyzer",
  },
  "bash-language-server": {
    id: "bash-language-server",
    label: "Bash / Shell",
    kind: "npm",
    binary: "bash-language-server",
    npm: { pkg: "bash-language-server", bin: "bash-language-server" },
    manualCommand: "npm install -g bash-language-server",
  },
  "yaml-language-server": {
    id: "yaml-language-server",
    label: "YAML",
    kind: "npm",
    binary: "yaml-language-server",
    npm: { pkg: "yaml-language-server", bin: "yaml-language-server" },
    manualCommand: "npm install -g yaml-language-server",
  },
  clangd: {
    id: "clangd",
    label: "C / C++",
    kind: "manual",
    binary: "clangd",
    manualCommand: "apt install clangd  (Linux)  ·  brew install llvm  (macOS)",
  },
  jdtls: {
    id: "jdtls",
    label: "Java",
    kind: "manual",
    binary: "jdtls",
    manualCommand: "install Eclipse JDT LS — https://github.com/eclipse-jdtls/eclipse.jdt.ls",
  },
  "csharp-ls": {
    id: "csharp-ls",
    label: "C#",
    kind: "toolchain",
    binary: "csharp-ls",
    toolchain: { bin: "dotnet", args: ["tool", "install", "-g", "csharp-ls"] },
    manualCommand: "dotnet tool install -g csharp-ls",
  },
  "sourcekit-lsp": {
    id: "sourcekit-lsp",
    label: "Swift",
    kind: "manual",
    binary: "sourcekit-lsp",
    manualCommand: "install the Swift toolchain — https://swift.org/install (ships sourcekit-lsp)",
  },
};

export interface LspInstallStatus {
  id: LspBuiltInServerId;
  label: string;
  status: "installed" | "failed" | "manual";
  /** Short human detail ("already on PATH", spawn stderr tail, …). */
  detail?: string;
  /** For status "manual": the exact command the user should copy/run. */
  command?: string;
}

export interface LspSetupDeps {
  /** PATH-only binary resolution. */
  which(bin: string): Promise<string | null>;
  /** Run a safe toolchain install command (never apt/brew/curl-pipe). */
  spawnInstall(cmd: string, args: string[]): Promise<{ ok: boolean; detail: string }>;
  /** Warm an npm package into the LSP cache (installs on first use). */
  warmNpm(pkg: string, bin: string): Promise<string | null>;
  /** Non-installing probe of the npm LSP cache. */
  cachedNpm(pkg: string, bin: string): Promise<string | null>;
}

/** Already-resolvable check: PATH first, then the warm npm cache (no install). */
export async function isLspServerInstalled(id: LspBuiltInServerId, deps: LspSetupDeps): Promise<boolean> {
  const recipe = LSP_INSTALL_RECIPES[id];
  try {
    if (await deps.which(recipe.binary)) return true;
    if (recipe.npm) return (await deps.cachedNpm(recipe.npm.pkg, recipe.npm.bin)) !== null;
    return false;
  } catch {
    return false;
  }
}

/**
 * Install ONE server per the matrix above. NEVER throws — every outcome
 * resolves to a status object the card can render.
 */
export async function installLspServer(id: LspBuiltInServerId, deps: LspSetupDeps): Promise<LspInstallStatus> {
  const recipe = LSP_INSTALL_RECIPES[id];
  const base = { id, label: recipe.label };
  try {
    if (await deps.which(recipe.binary)) {
      return { ...base, status: "installed", detail: "already on PATH" };
    }
    if (recipe.kind === "npm" && recipe.npm) {
      if (await deps.cachedNpm(recipe.npm.pkg, recipe.npm.bin)) {
        return { ...base, status: "installed", detail: "already in the npm cache" };
      }
      const resolved = await deps.warmNpm(recipe.npm.pkg, recipe.npm.bin);
      return resolved
        ? { ...base, status: "installed", detail: `installed to npm cache` }
        : { ...base, status: "failed", detail: `npm install of ${recipe.npm.pkg} failed` };
    }
    if (recipe.kind === "toolchain" && recipe.toolchain) {
      const toolchain = await deps.which(recipe.toolchain.bin);
      if (!toolchain) {
        return {
          ...base,
          status: "manual",
          detail: `${recipe.toolchain.bin} not found on PATH`,
          command: recipe.manualCommand,
        };
      }
      const result = await deps.spawnInstall(recipe.toolchain.bin, recipe.toolchain.args);
      return result.ok
        ? { ...base, status: "installed", detail: result.detail || "installed via toolchain" }
        : { ...base, status: "failed", detail: result.detail, command: recipe.manualCommand };
    }
    // manual — OS-dependent package manager or SDK download; never auto-run.
    return { ...base, status: "manual", command: recipe.manualCommand };
  } catch (err) {
    return { ...base, status: "failed", detail: (err as Error)?.message ?? String(err) };
  }
}

/** Sequential install of the picked set (npm cache + toolchains dislike concurrency). */
export async function installLspServers(
  ids: readonly LspBuiltInServerId[],
  deps: LspSetupDeps,
): Promise<LspInstallStatus[]> {
  const statuses: LspInstallStatus[] = [];
  for (const id of ids) {
    statuses.push(await installLspServer(id, deps));
  }
  return statuses;
}

// ---------------------------------------------------------------------------
// Project language detection — pre-selects the picker.
// ---------------------------------------------------------------------------

const DETECT_SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"]);
const DETECT_MAX_ENTRIES = 400;
const DETECT_MAX_DEPTH = 2;

/**
 * Scan `cwd` (shallow, capped) for the built-in servers' file extensions and
 * root markers. Root markers are matched at the top level only, with the
 * generic ".git" marker excluded (it appears in most definitions and would
 * select everything). Fail-open: any FS error yields fewer detections, never
 * a throw.
 */
export async function detectProjectLanguages(cwd: string): Promise<LspBuiltInServerId[]> {
  const meta = listBuiltInServerMeta();
  const byExtension = new Map<string, LspBuiltInServerId>();
  for (const server of meta) {
    for (const extension of server.extensions) byExtension.set(extension.toLowerCase(), server.id);
  }

  const detected = new Set<LspBuiltInServerId>();
  let seen = 0;

  const rootEntries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  const rootNames = new Set(rootEntries.map((entry) => entry.name));
  for (const server of meta) {
    if (server.rootMarkers.some((marker) => marker !== ".git" && rootNames.has(marker))) {
      detected.add(server.id);
    }
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > DETECT_MAX_DEPTH || seen >= DETECT_MAX_ENTRIES) return;
    const entries = depth === 0 ? rootEntries : await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (seen >= DETECT_MAX_ENTRIES) return;
      seen += 1;
      if (entry.name.startsWith(".") || DETECT_SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      const id = byExtension.get(path.extname(entry.name).toLowerCase());
      if (id) detected.add(id);
    }
  };
  await walk(cwd, 0);

  // Preserve the canonical builtin order for a stable picker pre-selection.
  return meta.map((server) => server.id).filter((id) => detected.has(id));
}

// ---------------------------------------------------------------------------
// Production dependency wiring
// ---------------------------------------------------------------------------

const SPAWN_INSTALL_TIMEOUT_MS = 180_000;

function spawnInstallCommand(cmd: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ok, detail });
    };
    try {
      const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-400);
      });
      const timer = setTimeout(() => {
        child.kill();
        settle(false, `timed out after ${SPAWN_INSTALL_TIMEOUT_MS / 1000}s`);
      }, SPAWN_INSTALL_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        settle(false, err.message);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) settle(true, `${cmd} ${args.join(" ")}`);
        else settle(false, stderrTail.trim().split("\n").at(-1) || `exit code ${code}`);
      });
    } catch (err) {
      settle(false, (err as Error)?.message ?? String(err));
    }
  });
}

export function defaultLspSetupDeps(): LspSetupDeps {
  return {
    which: findCommandOnPath,
    spawnInstall: spawnInstallCommand,
    warmNpm: (pkg, bin) => lspNpmWhich(pkg, bin),
    cachedNpm: (pkg, bin) => lspNpmCachedWhich(pkg, bin),
  };
}
