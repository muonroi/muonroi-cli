/**
 * init-new.ts — Scaffolds a new muonroi project with:
 *   - <name>/server/  scaffolded via `dotnet new <bbTemplate.shortName>` (BE)
 *   - <name>/client/  scaffolded with React or Angular + SemanticProvider wiring
 *
 * Phase 6 additions:
 *   - detectDotnet(): spawnSync("dotnet", ["--version"]) check (task 6.1)
 *   - detectBBTemplates(): parse `dotnet new list` for 3 template shortNames (task 6.2)
 *   - installBBTemplates(): dotnet new install <pkgs> with NuGet-unreachable fallback (task 6.2)
 *   - bbTemplate / eePackages on InitNewOptions (task 6.2b)
 *   - dotnet-new scaffold path with Directory.Packages.props injection (task 6.3)
 *   - OSS-only package filter, --commercial opt-in (task 6.4)
 *   - EE-INTENT.md generation (task 6.5)
 *
 * Designed for testability: callers inject fs+exec via opts.fs to avoid
 * real I/O in unit tests. Only the smoke test uses real filesystem operations.
 */

import { exec as nodeExec, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(nodeExec);

// ---------------------------------------------------------------------------
// BB detection helper
// ---------------------------------------------------------------------------

/**
 * Detect whether a directory is a muonroi-building-block project.
 * Heuristic: presence of Directory.Build.props + *.sln + any src/Muonroi.* directory.
 * Returns "muonroi-building-block" when matched, undefined otherwise.
 */
export function detectBBFramework(
  dirPath: string,
  fsOps?: { exists: (p: string) => boolean },
): "muonroi-building-block" | undefined {
  const checkExists = fsOps?.exists ?? ((p: string) => existsSync(p));
  const hasBuildProps = checkExists(path.join(dirPath, "Directory.Build.props"));
  if (!hasBuildProps) return undefined;

  // Check for any *.sln file in root
  const hasSlnFile = (() => {
    try {
      return readdirSync(dirPath).some((f) => f.endsWith(".sln"));
    } catch {
      return false;
    }
  })();
  if (!hasSlnFile) return undefined;

  // Check for src/Muonroi.* directory
  const srcPath = path.join(dirPath, "src");
  const hasMuonroiSrc = (() => {
    try {
      return readdirSync(srcPath).some((f) => f.startsWith("Muonroi."));
    } catch {
      return false;
    }
  })();
  if (!hasMuonroiSrc) return undefined;

  return "muonroi-building-block";
}

// ---------------------------------------------------------------------------
// Dotnet detection helpers (task 6.1 + 6.2)
// ---------------------------------------------------------------------------

export interface BBTemplateInfo {
  shortName: string;
  nugetId: string;
  version: string;
}

/**
 * Known BB template package descriptors with pinned versions.
 * Update these constants when bumping to a newer published nupkg version on NuGet.org.
 * `userSettings.bbTemplateVersions` can override at runtime.
 *
 * `minSdkMajor` is the minimum dotnet SDK major version that ships a runtime
 * matching the template's embedded `<TargetFramework>`. Verified from NuGet
 * nuspec target frameworks 2026-05-19:
 *   - Muonroi.BaseTemplate@1.0.0-alpha.3 → group targetFramework="net9.0"
 *   - Muonroi.Modular.Template@1.10.0    → net8 LTS line (no nuspec TFM)
 *   - Muonroi.Microservices.Template@1.10.0 → net8 LTS line (no nuspec TFM)
 * SDK 10 is forward-compatible with net8/9 targets, so users on SDK 10 can
 * install + scaffold all three; the floor is what blocks SDK 7 / 6.
 */
export const BB_TEMPLATE_PACKAGES: ReadonlyArray<Omit<BBTemplateInfo, "shortName"> & { minSdkMajor: number }> = [
  { nugetId: "Muonroi.BaseTemplate", version: "1.0.0-alpha.3", minSdkMajor: 9 },
  { nugetId: "Muonroi.Modular.Template", version: "1.10.0", minSdkMajor: 8 },
  { nugetId: "Muonroi.Microservices.Template", version: "1.10.0", minSdkMajor: 8 },
];

/** Parse "10.0.201" / "8.0.404" → 10 / 8. Returns null on garbage input. */
export function parseDotnetMajor(version: string | null): number | null {
  if (!version) return null;
  const m = version.match(/^(\d+)\./);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Look up the min SDK major for a given nugetId. Returns null if unknown. */
export function getMinSdkMajor(nugetId: string): number | null {
  return BB_TEMPLATE_PACKAGES.find((p) => p.nugetId === nugetId)?.minSdkMajor ?? null;
}

/**
 * Maps NuGet package id → actual `dotnet new` shortName as registered by the
 * published template.json. Verified empirically against NuGet 2026-05-16:
 *   Muonroi.BaseTemplate@1.0.0-alpha.3   → mr-base-sln
 *   Muonroi.Modular.Template@1.10.0       → mr-mod-sln
 *   Muonroi.Microservices.Template@1.10.0 → mr-micro-sln
 *
 * Note: each package also registers ancillary templates (e.g. tenant-service,
 * tenant-site-module). The CLI only consumes the *-sln entry points; the
 * ancillary templates are out-of-scope for /ideal scaffold.
 */
const NUGET_TO_SHORTNAME: Record<string, string> = {
  "Muonroi.BaseTemplate": "mr-base-sln",
  "Muonroi.Modular.Template": "mr-mod-sln",
  "Muonroi.Microservices.Template": "mr-micro-sln",
};

/**
 * Reverse lookup: dotnet shortName → NuGet package id.
 * Used by `src/ee/bb-design.ts` to map an EE recipe's shortName back to
 * the canonical nugetId for `dotnet new install`.
 */
export const SHORTNAME_TO_NUGET: Record<string, string> = Object.fromEntries(
  Object.entries(NUGET_TO_SHORTNAME).map(([k, v]) => [v, k]),
);

/**
 * Windows shells resolve `dotnet` to `dotnet.exe` via PATHEXT lookup, which
 * spawnSync only does when `shell: true` is passed. Without it, the
 * "command not found" branch fires even though `dotnet --version` works
 * fine in a terminal. POSIX shells don't need this flag.
 */
const NEEDS_SHELL = process.platform === "win32";

/**
 * Common dotnet install locations checked as a fallback when `dotnet --version`
 * via PATH fails. Some users have dotnet installed system-wide but the TUI
 * inherits a PATH from a shell where the install dir wasn't added (e.g. a
 * bare cmd.exe launched without the system profile loaded).
 */
const fsExistsSync = existsSync;

/**
 * Walks `root` recursively (depth-limited) to find the most likely "primary"
 * .csproj file — the one a user would target for `dotnet add package`.
 *
 * Empirically verified against published BB templates 2026-05-19 by manually
 * scaffolding into /tmp/muonroi-scaffold-test-851:
 *   mr-micro-sln (Muonroi.Microservices.Template@1.10.0) →
 *     - src/Gateways/<App>.Gateway/<App>.Gateway.csproj         (Sdk="Web")
 *     - src/Services/<App>.Catalog/<App>.Catalog.csproj         (Sdk="Web")
 *     - src/Services/<App>.Core/<App>.Core.csproj
 *     - src/Services/<App>.Data/<App>.Data.csproj
 *   mr-mod-sln (Muonroi.Modular.Template@1.10.0) →
 *     - src/Host/<App>.Host/<App>.Host.csproj                   (Sdk="Web")
 *     - src/Modules/Catalog/<App>.Modules.Catalog.csproj
 *     - src/Modules/Identity/<App>.Modules.Identity.csproj
 *     - src/Shared/<App>.Kernel/<App>.Kernel.csproj
 *     - src/Shared/<App>.Shared/<App>.Shared.csproj
 *
 * Heuristic priority (highest first):
 *   1. Skip noise dirs (bin, obj, .git, node_modules, .vs, .vscode)
 *   2. Exclude test projects (.Tests / .Test / .Specs suffix)
 *   3. Prefer Web SDK csproj (Sdk="Microsoft.NET.Sdk.Web" inside <Project>)
 *   4. Within Web SDK group, prefer paths containing /Gateway/ or /Host/
 *      (entry-project convention)
 *   5. Tie-break by shallowest depth, then alphabetical
 *
 * Returns absolute path or null if no csproj found under root.
 */
export interface FindCsprojFs {
  readdir: (p: string) => Array<{ name: string; isDir: boolean; isFile: boolean }>;
  readFile: (p: string) => string;
}

const defaultFindCsprojFs: FindCsprojFs = {
  readdir: (p: string) =>
    readdirSync(p, { withFileTypes: true, encoding: "utf8" }).map((e) => ({
      name: String(e.name),
      isDir: e.isDirectory(),
      isFile: e.isFile(),
    })),
  readFile: (p: string) => readFileSync(p, "utf8"),
};

export function findPrimaryCsproj(
  root: string,
  maxDepth = 6,
  fsAdapter: FindCsprojFs = defaultFindCsprojFs,
): string | null {
  const skipDirs = new Set(["bin", "obj", ".git", "node_modules", ".vs", ".vscode"]);
  const candidates: Array<{
    absPath: string;
    depth: number;
    isTest: boolean;
    isWebSdk: boolean;
    isEntry: boolean;
  }> = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: ReturnType<FindCsprojFs["readdir"]>;
    try {
      entries = fsAdapter.readdir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDir) {
        if (skipDirs.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile && e.name.endsWith(".csproj")) {
        const stem = e.name.slice(0, -".csproj".length);
        const isTest = /\.(Tests?|Specs)$/i.test(stem);
        const absPath = path.join(dir, e.name);
        let isWebSdk = false;
        try {
          isWebSdk = /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(fsAdapter.readFile(absPath));
        } catch {
          /* unreadable — leave as non-web */
        }
        const isEntry = /[/\\](Gateway|Host)s?[/\\]/i.test(absPath);
        candidates.push({ absPath, depth, isTest, isWebSdk, isEntry });
      }
    }
  }
  walk(root, 0);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.isTest !== b.isTest) return a.isTest ? 1 : -1;
    if (a.isWebSdk !== b.isWebSdk) return a.isWebSdk ? -1 : 1;
    if (a.isEntry !== b.isEntry) return a.isEntry ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.absPath.localeCompare(b.absPath);
  });
  return candidates[0]?.absPath ?? null;
}

function getDotnetFallbackPaths(): string[] {
  if (process.platform !== "win32") return ["/usr/local/share/dotnet/dotnet", "/usr/share/dotnet/dotnet"];
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return [
    "C:\\Program Files\\dotnet\\dotnet.exe",
    "C:\\Program Files (x86)\\dotnet\\dotnet.exe",
    ...(home ? [path.join(home, ".dotnet", "dotnet.exe")] : []),
  ];
}

/**
 * Last-resolved absolute path to dotnet, when PATH-based lookup failed and we
 * had to fall back. Set by detectDotnet on success-via-fallback so callers
 * (installBBTemplates, `dotnet new`, `dotnet add package`, etc.) can re-use
 * the same binary instead of re-discovering on every spawn.
 */
let _resolvedDotnetPath: string | null = null;

/** Diagnostic — last spawn attempt result, for surfacing in errors. */
let _lastDotnetDetectDiagnostic: string = "";

/**
 * Task 6.1 — Detect dotnet SDK availability via spawnSync.
 * Returns the dotnet version string, or null if not found.
 *
 * Strategy:
 *   1. Try `dotnet --version` via PATH (with shell:true on Windows).
 *   2. If that fails, walk common install locations and call them directly
 *      by absolute path. If any one returns version, remember it for reuse.
 *   3. On total failure, populate _lastDotnetDetectDiagnostic so the
 *      "SDK not found" error can show the user *why* (status, stderr).
 */
export function detectDotnet(): string | null {
  _resolvedDotnetPath = null;
  let pathDiag = "";
  try {
    const result = spawnSync("dotnet", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      shell: NEEDS_SHELL,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    pathDiag =
      `PATH lookup: status=${result.status} ` +
      `stderr=${(result.stderr ?? "").trim().slice(0, 120) || "(empty)"} ` +
      `error=${result.error?.message ?? "(none)"}`;
  } catch (err) {
    pathDiag = `PATH lookup threw: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Fallback — try absolute paths
  const fallbackTries: string[] = [];
  for (const candidate of getDotnetFallbackPaths()) {
    if (!fsExistsSync(candidate)) {
      fallbackTries.push(`${candidate}: not present`);
      continue;
    }
    try {
      const result = spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        shell: false,
      });
      if (result.status === 0 && result.stdout) {
        _resolvedDotnetPath = candidate;
        _lastDotnetDetectDiagnostic = `${pathDiag} | fallback: ${candidate} ok`;
        return result.stdout.trim();
      }
      fallbackTries.push(`${candidate}: status=${result.status}`);
    } catch (err) {
      fallbackTries.push(`${candidate}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  _lastDotnetDetectDiagnostic = `${pathDiag} | fallbacks: ${fallbackTries.join("; ")}`;
  return null;
}

/** Returns the absolute dotnet path discovered via fallback, or "dotnet" for normal PATH use. */
export function getDotnetCommand(): string {
  return _resolvedDotnetPath ?? "dotnet";
}

/**
 * Whether to wrap spawnSync in a shell. We need shell:true on Windows ONLY when
 * relying on PATHEXT resolution of the literal "dotnet". When we have an
 * absolute resolved path (e.g. "C:\\Program Files\\dotnet\\dotnet.exe"), shell:true
 * triggers a quoting bug — cmd.exe splits the path at the first space and
 * fails with "'C:\\Program' is not recognized". Use shell:false in that case.
 */
function dotnetSpawnShell(): boolean {
  return NEEDS_SHELL && _resolvedDotnetPath === null;
}

/** Test-only / diagnostic accessor. */
export function getDotnetDiagnostic(): string {
  return _lastDotnetDetectDiagnostic;
}

/**
 * HEAD-check the NuGet flatcontainer index for a package id. Manually verified
 * 2026-05-19 against Muonroi.Ui.Engine.Mvc (404) vs Muonroi.AspNetCore (200):
 * each HEAD returns in 250-400ms vs the 5-10s timeout `dotnet add package`
 * suffers when a 404 is discovered mid-resolution.
 *
 * On any error (DNS, abort, offline) → returns true so the dotnet command
 * runs and reports the real error. Pre-validation is an optimization, not a
 * gate.
 */
export async function isPackageOnNuGet(pkgId: string, timeoutMs = 3000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `https://api.nuget.org/v3-flatcontainer/${pkgId.toLowerCase()}/index.json`;
    const res = await fetch(url, { method: "HEAD", signal: ctl.signal });
    return res.ok;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Task 6.2 — Detect which BB templates are installed by parsing `dotnet new list`.
 * Returns map of nugetId → shortName for installed templates.
 */
export function detectInstalledBBTemplates(): Map<string, string> {
  const result = spawnSync(getDotnetCommand(), ["new", "list"], {
    encoding: "utf8",
    timeout: 15000,
    shell: dotnetSpawnShell(),
  });
  const installed = new Map<string, string>();
  if (result.status !== 0 || !result.stdout) return installed;

  const lines = result.stdout.split("\n");
  for (const [nugetId, expectedShort] of Object.entries(NUGET_TO_SHORTNAME)) {
    // Match by known shortName or NuGet id in the output
    const found = lines.some(
      (l) => l.toLowerCase().includes(expectedShort.toLowerCase()) || l.toLowerCase().includes(nugetId.toLowerCase()),
    );
    if (found) {
      installed.set(nugetId, expectedShort);
    }
  }
  return installed;
}

/**
 * Task 6.2 — Install BB dotnet templates from NuGet with pinned versions.
 * Returns true if install succeeded, false if NuGet unreachable.
 *
 * When `nugetIds` is provided, installs ONLY those packages (selective install
 * triggered by EE-driven BB design — Plan 23-01b). When omitted, installs all
 * `BB_TEMPLATE_PACKAGES` (back-compat for legacy callers and tests).
 *
 * Each package is installed individually as `Pkg@version` (canonical separator
 * since dotnet 8; `::` is deprecated in dotnet 9+) so a single failure (e.g.
 * one version yanked) does not abort the whole batch.
 *
 * Exit code 106 ("template package already installed") is treated as success —
 * the package being available is what we need, regardless of whether this call
 * installed it or it was already there.
 */
export function installBBTemplates(nugetIds?: string[]): boolean {
  const targets =
    nugetIds && nugetIds.length > 0
      ? BB_TEMPLATE_PACKAGES.filter((p) => nugetIds.includes(p.nugetId))
      : BB_TEMPLATE_PACKAGES;
  let allOk = true;
  for (const pkg of targets) {
    const ref = pkg.version === "latest" ? pkg.nugetId : `${pkg.nugetId}@${pkg.version}`;
    const result = spawnSync(getDotnetCommand(), ["new", "install", ref], {
      encoding: "utf8",
      timeout: 60000,
      shell: dotnetSpawnShell(),
    });
    // Plan 23-fix: `dotnet new install` can print warnings about stale template
    // paths (e.g. `Failed to scan D:\Personal\Project\Foo`) and STILL succeed,
    // yet exit non-zero on some SDK builds. Treat any of the following as success:
    //   - status === 0
    //   - status === 106 (legacy "already installed" code)
    //   - stdout contains "is already installed"
    //   - stdout contains "Success:" (canonical success marker emitted before
    //     the per-template summary table — present even when scan warnings fire)
    const stdout = result.stdout ?? "";
    const success =
      result.status === 0 ||
      result.status === 106 ||
      stdout.includes("is already installed") ||
      stdout.includes("Success:");
    if (!success) {
      process.stderr.write(`[init-new] dotnet new install failed (${ref}): ${result.stderr ?? "unknown error"}\n`);
      allOk = false;
    }
  }
  return allOk;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InitNewOptions {
  /** Target directory name; created at projectsRoot (or cwd). */
  projectName: string;
  /** "react" | "angular" | "none" */
  feStack: "react" | "angular" | "none";
  /** Where to write the project. Defaults to process.cwd(). */
  projectsRoot?: string;
  /**
   * Task 6.2b / Plan 23-01b — BB template selection.
   * When absent → FE-only project (BE scaffold skipped entirely).
   * When provided → `dotnet new <shortName>` runs against the chosen template;
   * the template is auto-installed from NuGet if not already present.
   */
  bbTemplate?: BBTemplateInfo;
  /**
   * Task 6.2b — EE-recommended packages to inject into Directory.Packages.props.
   * OSS-only by default; commercial packages require explicit --commercial flag.
   */
  eePackages?: string[];
  /**
   * Task 6.4 — Allow commercial BB packages in the scaffold.
   * Defaults to false (OSS-only).
   */
  commercial?: boolean;
  /** Optional override: inject filesystem operations for testability. */
  fs?: {
    mkdir: (p: string) => Promise<void>;
    writeFile: (p: string, content: string) => Promise<void>;
    exec: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
    exists: (p: string) => boolean;
  };
  /**
   * Diagnostic log callback. When provided, replaces direct `process.stderr.write`
   * which would bleed into the OpenTUI render buffer and corrupt the screen.
   * Called once per warning/non-fatal error. Receives a single line (no trailing newline).
   */
  onLog?: (line: string) => void;
  /**
   * Per-package progress callback during the `dotnet add package` loop. Lets the
   * TUI update its "running" step with the current package index/name instead of
   * appearing frozen for ~15s while 9 sequential NuGet lookups happen.
   */
  onPackageProgress?: (info: {
    index: number;
    total: number;
    pkgId: string;
    status: "start" | "ok" | "fail";
    error?: string;
  }) => void;
  /**
   * Plan 23-fix — Template-missing hook. Called BEFORE auto-installing a missing
   * BB template. Lets the TUI ask the user: install automatically, wait for
   * manual install + retry detection, or cancel. When omitted, auto-install
   * fires immediately (legacy behaviour).
   *
   * Return values:
   *   "install" — run `dotnet new install <pkg>@<version>` then re-check
   *   "wait-manual" — pause; caller re-checks `detectInstalledBBTemplates()`
   *                   and re-invokes the hook until it returns "install" or
   *                   "cancel". The hook implementation owns the wait loop.
   *   "cancel" — abort scaffold; throw a clear "template not installed" error.
   */
  onTemplateMissing?: (info: {
    shortName: string;
    nugetId: string;
    version: string;
  }) => Promise<"install" | "wait-manual" | "cancel">;
  /** Plan 23-fix — Progress callback during `dotnet new install`. */
  onTemplateInstallProgress?: (info: { status: "start" | "ok" | "fail"; message?: string }) => void;
}

export interface InitNewResult {
  projectDir: string;
  /** Relative paths of files written (relative to projectDir). */
  files: string[];
  /** Whether the dotnet-template path ran successfully (false for FE-only projects). */
  usedDotnetTemplate?: boolean;
  /** Non-fatal warnings collected during scaffold (template install, package add, restore errors). */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

function validateProjectName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error("Project name cannot be empty.");
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Project name "${name}" contains path traversal characters. Use a simple name like "my-app".`);
  }
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(`Project name "${name}" is invalid. Use kebab-case alphanumeric only (e.g. "my-app", "project1").`);
  }
}

/**
 * Convert a kebab-case (or snake_case) project name to a .NET-style
 * PascalCase assembly/namespace prefix. Used for `dotnet new -n` so the
 * generated .csproj, .sln, and `namespace` declarations follow .NET
 * conventions, while the outer workspace folder + package.json keep the
 * user's kebab name.
 *
 * Example: "todo-app" → "TodoApp", "my_cool-svc" → "MyCoolSvc"
 */
export function toDotNetAssemblyName(kebab: string): string {
  return kebab
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function rootPackageJson(projectName: string, hasClient: boolean): string {
  const workspaces = hasClient ? '["server", "client"]' : '["server"]';
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      private: true,
      workspaces: JSON.parse(workspaces),
      scripts: {
        dev: "bun run --filter='*' dev",
        build: "bun run --filter='*' build",
        test: "bun run --filter='*' test",
      },
    },
    null,
    2,
  );
}

function reactClientPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: `${projectName}-client`,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "vite",
        build: "vite build",
        test: "vitest run",
      },
      dependencies: {
        react: "^18.3.0",
        "react-dom": "^18.3.0",
        "@muonroi/agent-harness-react": "^0.1.0",
      },
      devDependencies: {
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        "@vitejs/plugin-react": "^4.3.0",
        vite: "^5.4.0",
        vitest: "^2.0.0",
      },
    },
    null,
    2,
  );
}

function reactViteConfig(): string {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __MUONROI_HARNESS__: JSON.stringify(process.env.NODE_ENV !== "production"),
  },
});
`;
}

function reactIndexHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function reactMainTsx(): string {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SemanticProvider, Semantic } from "@muonroi/agent-harness-react";
import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/app.css";

const registry = createSemanticRegistry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SemanticProvider registry={registry}>
      <ErrorBoundary>
        <Semantic id="root" role="region" name="App root">
          {/* Your application components go here */}
          <h1>Hello from ${"{projectName}"}</h1>
        </Semantic>
      </ErrorBoundary>
    </SemanticProvider>
  </StrictMode>,
);
`;
}

function reactTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        types: ["vite/client"],
      },
      include: ["src"],
    },
    null,
    2,
  );
}

function reactEnvExample(): string {
  return `# Copy to .env.local and edit. NEVER commit .env.local.
VITE_API_BASE=http://localhost:5000
`;
}

function reactGitignore(): string {
  return `node_modules/
dist/
.env
.env.local
.env.*.local
*.log
.vite/
coverage/
`;
}

function reactReadme(projectName: string): string {
  return `# ${projectName} — client

React + Vite + TypeScript (strict) frontend wired to the agent harness via
\`@muonroi/agent-harness-react\`.

## Setup

\`\`\`bash
bun install
cp .env.example .env.local   # then edit VITE_API_BASE
bun run dev
\`\`\`

## Layout

- \`src/api/\`        — typed HTTP client + DTO types (mirror server contracts)
- \`src/components/\` — reusable UI (ErrorBoundary, Toast)
- \`src/styles/\`     — tokens + global reset
- \`src/main.tsx\`    — bootstrap (do NOT remove SemanticProvider)

## Conventions

- Every async view has loading / empty / error states.
- No inline \`style={{...}}\` — use CSS modules or tokens from \`styles/app.css\`.
- API base lives in \`import.meta.env.VITE_API_BASE\`. Never hardcode URLs.
- Wrap user-visible regions with \`<Semantic id role name>\` so harness specs can target them.
`;
}

function reactApiClient(): string {
  return `/**
 * Typed HTTP client. Reads API base from \`VITE_API_BASE\` env var.
 * Never hardcode URLs in components — import this client.
 */

const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

if (!API_BASE) {
  // Surfaces during dev if VITE_API_BASE is missing from .env.local.
  console.warn("[api] VITE_API_BASE is empty — set it in .env.local");
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  token?: string | null;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = opts.token ?? (typeof localStorage !== "undefined" ? localStorage.getItem("access_token") : null);
  if (token) headers.Authorization = \`Bearer \${token}\`;

  const res = await fetch(\`\${API_BASE}\${path}\`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, body, \`HTTP \${res.status} on \${opts.method ?? "GET"} \${path}\`);
  }
  return body as T;
}
`;
}

function reactApiTypes(): string {
  return `/**
 * API request/response DTOs. Mirror server-side contracts here so the
 * compiler catches contract drift early. Replace the placeholder once
 * you generate domain types.
 */
export interface Envelope<T> {
  result: T;
  error?: string | null;
}

// EXAMPLE — delete or replace with your real DTOs.
// export interface TodoDto {
//   id: string;
//   title: string;
//   isCompleted: boolean;
//   createdAt: string;
// }
export {};
`;
}

function reactErrorBoundary(): string {
  return `import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Root-level error boundary. Catches uncaught render/effect errors and
 * shows a fallback instead of an unmounted blank page. Logs to console
 * for dev; replace the logger with your telemetry sink in prod.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error);
      return (
        <div role="alert" style={{ padding: "1rem", color: "var(--color-error, #b91c1c)" }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
`;
}

function reactAppCss(): string {
  return `:root {
  --color-bg: #ffffff;
  --color-fg: #111827;
  --color-muted: #6b7280;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-border: #e5e7eb;
  --color-error: #b91c1c;
  --color-success: #15803d;
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --radius: 0.5rem;
  --font-stack: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0b1220;
    --color-fg: #f3f4f6;
    --color-muted: #9ca3af;
    --color-border: #1f2937;
  }
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: var(--font-stack);
  line-height: 1.5;
}
button { font: inherit; cursor: pointer; }
input, textarea, select { font: inherit; }
a { color: var(--color-primary); }
`;
}

function angularClientPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: `${projectName}-client`,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "ng serve",
        build: "ng build",
        test: "ng test --watch=false",
      },
      dependencies: {
        "@angular/core": "^18.0.0",
        "@angular/common": "^18.0.0",
        "@angular/platform-browser": "^18.0.0",
        "@muonroi/agent-harness-angular": "^0.1.0",
      },
      devDependencies: {
        "@angular/cli": "^18.0.0",
        "@angular/compiler-cli": "^18.0.0",
        typescript: "^5.4.0",
      },
    },
    null,
    2,
  );
}

function angularMainTs(): string {
  return `import { bootstrapApplication } from "@angular/platform-browser";
import { ErrorHandler } from "@angular/core";
import { provideHttpClient } from "@angular/common/http";
import { AppComponent } from "./app/app.component";
import { AppErrorHandler } from "./app/error-handler";
import "./styles.css";

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    { provide: ErrorHandler, useClass: AppErrorHandler },
  ],
}).catch((err) => console.error(err));
`;
}

function angularAppComponentTs(projectName: string): string {
  return `import { Component } from "@angular/core";
import { SemanticDirective } from "@muonroi/agent-harness-angular";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [SemanticDirective],
  template: \`
    <div muonroiSemantic id="root" role="region" name="App root">
      <!-- Your application components go here -->
      <h1>Hello from ${projectName}</h1>
    </div>
  \`,
})
export class AppComponent {}
`;
}

function angularTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        lib: ["ES2022", "dom"],
        strict: true,
        noImplicitOverride: true,
        noPropertyAccessFromIndexSignature: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: false,
        moduleResolution: "bundler",
      },
    },
    null,
    2,
  );
}

function angularEnvironmentTs(): string {
  return `/**
 * Build-time environment config. Angular CLI swaps this file with
 * \`environment.prod.ts\` when building for production via fileReplacements
 * in angular.json. Never hardcode API URLs in components — import this.
 */
export const environment = {
  production: false,
  apiBase: "http://localhost:5000",
};
`;
}

function angularEnvironmentProdTs(): string {
  return `export const environment = {
  production: true,
  // Replaced at build time; set via your deploy pipeline.
  apiBase: "",
};
`;
}

function angularApiServiceTs(): string {
  return `import { Injectable, inject } from "@angular/core";
import { HttpClient, HttpErrorResponse, HttpHeaders } from "@angular/common/http";
import { Observable, catchError, throwError } from "rxjs";
import { environment } from "../environments/environment";

/**
 * Typed HTTP client wrapper. Reads API base from environment.apiBase.
 * Components must call methods on this service, never inject HttpClient
 * directly, so URL configuration stays centralized.
 */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);

  private headers(): HttpHeaders {
    let h = new HttpHeaders({ "Content-Type": "application/json" });
    const token =
      typeof localStorage !== "undefined" ? localStorage.getItem("access_token") : null;
    if (token) h = h.set("Authorization", \`Bearer \${token}\`);
    return h;
  }

  private wrap<T>(obs: Observable<T>): Observable<T> {
    return obs.pipe(
      catchError((err: HttpErrorResponse) =>
        throwError(() => new ApiError(err.status, err.error, err.message)),
      ),
    );
  }

  get<T>(path: string): Observable<T> {
    return this.wrap(this.http.get<T>(\`\${environment.apiBase}\${path}\`, { headers: this.headers() }));
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.wrap(
      this.http.post<T>(\`\${environment.apiBase}\${path}\`, body, { headers: this.headers() }),
    );
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.wrap(
      this.http.put<T>(\`\${environment.apiBase}\${path}\`, body, { headers: this.headers() }),
    );
  }

  delete<T>(path: string): Observable<T> {
    return this.wrap(
      this.http.delete<T>(\`\${environment.apiBase}\${path}\`, { headers: this.headers() }),
    );
  }
}
`;
}

function angularErrorHandlerTs(): string {
  return `import { ErrorHandler, Injectable } from "@angular/core";

/**
 * Root error handler. Replace the console sink with your telemetry
 * provider in prod. Angular wires this via providers: [{ provide:
 * ErrorHandler, useClass: AppErrorHandler }].
 */
@Injectable({ providedIn: "root" })
export class AppErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error("[AppErrorHandler]", error);
  }
}
`;
}

function angularStylesCss(): string {
  return `:root {
  --color-bg: #ffffff;
  --color-fg: #111827;
  --color-muted: #6b7280;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-border: #e5e7eb;
  --color-error: #b91c1c;
  --color-success: #15803d;
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --radius: 0.5rem;
  --font-stack: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0b1220;
    --color-fg: #f3f4f6;
    --color-muted: #9ca3af;
    --color-border: #1f2937;
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: var(--font-stack);
  line-height: 1.5;
}
button { font: inherit; cursor: pointer; }
input, textarea, select { font: inherit; }
a { color: var(--color-primary); }
`;
}

function angularGitignore(): string {
  return `node_modules/
dist/
.angular/
.env
.env.local
*.log
coverage/
`;
}

function angularReadme(projectName: string): string {
  return `# ${projectName} — client

Angular (standalone components) + agent harness via \`@muonroi/agent-harness-angular\`.

## Setup

\`\`\`bash
bun install
bun run dev
\`\`\`

Edit \`src/environments/environment.ts\` to point \`apiBase\` at your backend.

## Layout

- \`src/api/\`          — \`ApiService\` (typed HTTP) + DTO types
- \`src/environments/\` — env config (dev + prod). \`apiBase\` is the only URL knob.
- \`src/app/\`          — components. Do NOT remove \`muonroiSemantic\` attributes.

## Conventions

- Every async view has loading / empty / error states.
- API URLs come from \`environment.apiBase\`. Never hardcode.
- Wrap user-visible regions with \`[muonroiSemantic]\` so harness specs can target them.
- AppErrorHandler is wired via providers — extend it instead of console.error.
`;
}

function angularApiTypes(): string {
  return `/**
 * API request/response DTOs. Mirror server-side contracts here so the
 * compiler catches contract drift early.
 */
export interface Envelope<T> {
  result: T;
  error?: string | null;
}
export {};
`;
}

// ---------------------------------------------------------------------------
// Main scaffolder
// ---------------------------------------------------------------------------

export async function initNewProject(opts: InitNewOptions): Promise<InitNewResult> {
  const { projectName, feStack, projectsRoot } = opts;

  // 1. Validate project name.
  validateProjectName(projectName);

  // 2. Resolve project directory.
  const root = projectsRoot ?? process.cwd();
  const projectDir = path.join(root, projectName);

  // Inject or use real fs/exec.
  const fsOps = opts.fs ?? {
    mkdir: (p: string) => fsMkdir(p, { recursive: true }),
    writeFile: (p: string, content: string) => fsWriteFile(p, content, "utf-8"),
    exec: (cmd: string, cwd: string) => execAsync(cmd, { cwd }),
    exists: (p: string) => existsSync(p),
  };

  // 3. Refuse if projectDir already exists.
  if (fsOps.exists(projectDir)) {
    throw new Error(`Project directory already exists: ${projectDir}`);
  }

  const hasClient = feStack !== "none";
  const filesWritten: string[] = [];
  const warnings: string[] = [];
  const logWarn = (line: string): void => {
    warnings.push(line);
    opts.onLog?.(line);
  };

  // Helper to write and track. Ensures parent dir exists so nested paths
  // (client/src/api/, client/src/components/, client/src/styles/,
  // client/src/environments/) don't ENOENT when the step-4 mkdir list misses
  // them. fsOps.mkdir defaults to recursive; idempotent on existing dirs.
  async function write(relPath: string, content: string) {
    const full = path.join(projectDir, relPath);
    await fsOps.mkdir(path.dirname(full));
    await fsOps.writeFile(full, content);
    filesWritten.push(relPath);
  }

  // 4. Create project directories.
  await fsOps.mkdir(projectDir);
  await fsOps.mkdir(path.join(projectDir, "server"));
  if (hasClient) {
    await fsOps.mkdir(path.join(projectDir, "client"));
    await fsOps.mkdir(path.join(projectDir, "client", "src"));
    if (feStack === "angular") {
      await fsOps.mkdir(path.join(projectDir, "client", "src", "app"));
    }
  }

  // 5. Write root package.json.
  await write("package.json", rootPackageJson(projectName, hasClient));

  // 6. Task 6.3 / Plan 23-01b — Scaffold BE source via `dotnet new <bbTemplate>`.
  //    Auto-installs the BB template from NuGet when not already present
  //    (selective: only the chosen template, via `installBBTemplates([nugetId])`).
  //    After scaffold + restore, runs `dotnet add package <id>` for each
  //    EE-recommended package so .csproj <PackageReference> entries are added
  //    by the SDK (Directory.Packages.props still pins versions when present).
  //    The legacy git-clone fallback has been retired (Plan 23-01b).
  const serverDir = path.join(projectDir, "server");
  let usedDotnetTemplate = false;

  if (opts.bbTemplate) {
    const dotnetVersion = detectDotnet();
    if (!dotnetVersion) {
      const diag = getDotnetDiagnostic();
      throw new Error(
        `Scaffold failed: .NET SDK not found on PATH.\n` +
          `→ Install .NET SDK 8.0 or 9.0 from https://dotnet.microsoft.com/download\n` +
          `  (BB template ${opts.bbTemplate.shortName} requires SDK ${getMinSdkMajor(opts.bbTemplate.nugetId) ?? 8}+)\n` +
          (diag ? `  diagnostic: ${diag}` : ""),
      );
    }
    // Plan 23-XX — SDK version compatibility pre-flight.
    const sdkMajor = parseDotnetMajor(dotnetVersion);
    const required = getMinSdkMajor(opts.bbTemplate.nugetId);
    if (sdkMajor !== null && required !== null && sdkMajor < required) {
      throw new Error(
        `Scaffold failed: .NET SDK ${dotnetVersion} is too old.\n` +
          `→ Template ${opts.bbTemplate.shortName} (${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}) requires SDK ${required}.0+ runtime.\n` +
          `  Install SDK ${required}.0 from https://dotnet.microsoft.com/download/dotnet/${required}.0\n` +
          `  Alternatively, pick a different template via the manual menu (Esc → select another template).`,
      );
    }
    // Plan 23-01b — auto-install the chosen BB template from NuGet if missing.
    // Plan 23-fix — when `onTemplateMissing` hook is provided, prompt the user
    // before running `dotnet new install`. Hook can also signal that the user
    // will install manually (we re-poll detection) or cancel outright.
    {
      let installed = detectInstalledBBTemplates();
      if (!installed.has(opts.bbTemplate.nugetId)) {
        let decision: "install" | "wait-manual" | "cancel" = "install";
        if (opts.onTemplateMissing) {
          decision = await opts.onTemplateMissing({
            shortName: opts.bbTemplate.shortName,
            nugetId: opts.bbTemplate.nugetId,
            version: opts.bbTemplate.version,
          });
        }
        if (decision === "cancel") {
          throw new Error(
            `Scaffold cancelled: template ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version} is not installed.\n` +
              `→ Install manually then retry:\n` +
              `    dotnet new install ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}`,
          );
        }
        if (decision === "wait-manual") {
          // The UI is responsible for re-invoking init-new once the user
          // signals install complete. Re-check detection one more time in case
          // the hook implementation already waited; if still missing, bail out
          // with the manual-install hint.
          installed = detectInstalledBBTemplates();
          if (!installed.has(opts.bbTemplate.nugetId)) {
            throw new Error(
              `Scaffold paused: template ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version} still not installed after manual wait.\n` +
                `→ Run:\n` +
                `    dotnet new install ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}\n` +
                `  then press Retry.`,
            );
          }
        } else {
          // decision === "install" — run auto-install.
          opts.onTemplateInstallProgress?.({
            status: "start",
            message: `dotnet new install ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}`,
          });
          const ok = installBBTemplates([opts.bbTemplate.nugetId]);
          if (!ok) {
            opts.onTemplateInstallProgress?.({ status: "fail", message: "dotnet new install returned an error" });
            logWarn(`[init-new] failed to install ${opts.bbTemplate.nugetId} from NuGet`);
            // fall through to throw below (no clone fallback)
          } else {
            opts.onTemplateInstallProgress?.({ status: "ok" });
            // Re-check after install. Some `dotnet new install` runs print
            // warnings and return non-zero even though the template registered
            // successfully — `installBBTemplates` would have reported false but
            // the post-install detection is the source of truth.
            installed = detectInstalledBBTemplates();
            if (installed.has(opts.bbTemplate.nugetId)) {
              logWarn(`[init-new] template ${opts.bbTemplate.nugetId} now installed (post-install detection)`);
            }
          }
        }
      }

      try {
        // Task 6.3 — run: dotnet new <shortName> -n <name> -o <target>/server
        // NOTE: do NOT pass --no-restore here. BB custom templates (e.g.
        // mr-micro-sln) reject unknown flags with
        //   '--no-restore' is not a valid option
        // breaking the scaffold. We do an explicit `dotnet restore` below
        // anyway, so the template's auto-restore is harmless duplication.
        const dotnetCmd = getDotnetCommand() === "dotnet" ? "dotnet" : JSON.stringify(getDotnetCommand());
        // .NET assembly + namespace name must be PascalCase. Outer folder /
        // package.json keep the kebab project name. C# cannot have dashes in
        // namespaces, so a kebab here produces snake_case namespaces (bug).
        const dotnetAssemblyName = toDotNetAssemblyName(projectName);
        await fsOps.exec(
          `${dotnetCmd} new ${opts.bbTemplate.shortName} -n ${dotnetAssemblyName} -o ${JSON.stringify(serverDir)}`,
          root,
        );

        // Task 6.3 — inject EE-recommended packages into Directory.Packages.props
        // (pins versions; `dotnet add package` below adds the <PackageReference>
        // entries to the .csproj without overriding those pins).
        const propsPath = path.join(serverDir, "Directory.Packages.props");
        if (opts.eePackages && opts.eePackages.length > 0 && fsOps.exists(propsPath)) {
          await injectPackagesProps(propsPath, opts.eePackages, opts.commercial ?? false, fsOps);
          filesWritten.push("server/Directory.Packages.props");
        }

        // Task 6.3 — verify with dotnet restore --nologo
        const restoreResult = await fsOps
          .exec(`${dotnetCmd} restore --nologo`, serverDir)
          .catch((e: unknown) => ({ stdout: "", stderr: String(e) }));
        if (restoreResult.stderr && restoreResult.stderr.includes("error")) {
          logWarn(`[init-new] dotnet restore reported errors; continuing best-effort`);
        } else {
          usedDotnetTemplate = true;
        }

        // Plan 23-01b — add each EE-recommended package via `dotnet add package`.
        // BB solution templates (mr-micro-sln, mr-modular-sln) create nested
        // structures under server/ — no .csproj sits directly in serverDir, so
        // `dotnet add package` from serverDir fails with "Could not find any
        // project". Discover the primary csproj first; skip the loop with a
        // single warning if none is found instead of spamming N failures.
        const targetCsproj = findPrimaryCsproj(serverDir);
        if (!targetCsproj && (opts.eePackages?.length ?? 0) > 0) {
          logWarn(
            `[init-new] no .csproj found under ${serverDir} — skipping ${opts.eePackages?.length ?? 0} dotnet add package call(s). ` +
              `Packages were still pinned in Directory.Packages.props if present.`,
          );
        }
        // Single-package failures are logged but do NOT abort the scaffold.
        if (targetCsproj) {
          // Pre-validate against NuGet flatcontainer. Some EE-recommended
          // packages (e.g. Muonroi.Ui.Engine.Mvc as of 2026-05-19) exist
          // locally in source repos but haven't been published. A HEAD
          // request takes <500ms vs a 5-10s timeout if dotnet add discovers
          // the 404 itself. Verified manually: response time ~250-400ms,
          // reliable 404 detection.
          const pkgList = opts.eePackages ?? [];
          const validatedList: string[] = [];
          for (const pkgId of pkgList) {
            const available = await isPackageOnNuGet(pkgId);
            if (available) {
              validatedList.push(pkgId);
            } else {
              logWarn(
                `[init-new] package ${pkgId} not found on nuget.org — skipping (publish or use local nupkg source to include)`,
              );
            }
          }
          for (let i = 0; i < validatedList.length; i++) {
            const pkgId = validatedList[i]!;
            opts.onPackageProgress?.({ index: i + 1, total: validatedList.length, pkgId, status: "start" });
            try {
              // `--prerelease` is required because Muonroi.* packages currently
              // ship only alpha versions on NuGet (manually verified 2026-05-19
              // against Muonroi.AspNetCore@1.0.0-alpha.14, Muonroi.Governance@
              // 1.0.0-alpha.14). Without the flag, dotnet errors:
              //   "There are no stable versions available, 1.0.0-alpha.14 is
              //    the best available. Consider adding the --prerelease option"
              await fsOps.exec(
                `${dotnetCmd} add ${JSON.stringify(targetCsproj)} package ${pkgId} --prerelease`,
                serverDir,
              );
              filesWritten.push(path.relative(root, targetCsproj));
              opts.onPackageProgress?.({ index: i + 1, total: validatedList.length, pkgId, status: "ok" });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logWarn(`[init-new] dotnet add package ${pkgId} failed: ${msg}`);
              opts.onPackageProgress?.({
                index: i + 1,
                total: validatedList.length,
                pkgId,
                status: "fail",
                error: msg,
              });
            }
          }
        }

        // Task 6.5 — Emit EE-INTENT.md
        const eePackageList = opts.eePackages ?? [];
        // Compute coverage: partial if any package not in eePackages list
        const coverage = eePackageList.length > 0 ? "full" : "partial";
        await write(
          "server/EE-INTENT.md",
          buildEEIntentMd({
            projectName,
            template: opts.bbTemplate,
            eePackages: eePackageList,
            coverage,
          }),
        );
      } catch (err) {
        logWarn(
          `[init-new] dotnet new ${opts.bbTemplate.shortName} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        usedDotnetTemplate = false;
      }
    }
  }

  if (!usedDotnetTemplate) {
    if (opts.bbTemplate) {
      const dotnetVersion = detectDotnet() ?? "(not detected)";
      const sdkMajor = parseDotnetMajor(dotnetVersion);
      const required = getMinSdkMajor(opts.bbTemplate.nugetId);
      const installed = detectInstalledBBTemplates();
      const templateInstalled = installed.has(opts.bbTemplate.nugetId);
      const sdkTooOld = sdkMajor !== null && required !== null && sdkMajor < required;
      // Plan 23-fix — distinguish the three real failure modes instead of
      // unconditionally claiming the SDK is too old. The original bug surfaced
      // on a machine running SDK 9.0.313 against a template requiring 9.0:
      // the message said "requires SDK 9.0+; you have 9.0.313" which is
      // self-contradictory.
      let hint: string;
      if (sdkTooOld) {
        hint =
          `→ Template ${opts.bbTemplate.shortName} requires .NET SDK ${required}.0+; you have ${dotnetVersion}.\n` +
          `  Install SDK ${required}.0 from https://dotnet.microsoft.com/download/dotnet/${required}.0`;
      } else if (!templateInstalled) {
        hint =
          `→ Template ${opts.bbTemplate.shortName} (${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}) is not installed.\n` +
          `  Install it manually then press Retry:\n` +
          `    dotnet new install ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}\n` +
          `  Verify NuGet feeds with: dotnet nuget list source`;
      } else {
        // Template is installed and SDK is new enough — the `dotnet new`
        // invocation itself failed for another reason. Most common causes:
        // restore conflict, locked output dir, project name collision.
        hint =
          `→ Template ${opts.bbTemplate.shortName} is installed but \`dotnet new\` failed.\n` +
          `  Common causes: existing files in target dir, restore conflict, or assembly-name collision.\n` +
          `  Run manually to see the underlying error:\n` +
          `    dotnet new ${opts.bbTemplate.shortName} -n <Name> -o <dir>`;
      }
      throw new Error(`Scaffold failed: dotnet template ${opts.bbTemplate.shortName} could not be applied.\n${hint}`);
    }
    // No bbTemplate provided → FE-only project, skip BE scaffold entirely.
  }

  // 7. Scaffold FE client.
  if (feStack === "react") {
    await write("client/package.json", reactClientPackageJson(projectName));
    await write("client/vite.config.ts", reactViteConfig());
    await write("client/tsconfig.json", reactTsConfig());
    await write("client/.env.example", reactEnvExample());
    await write("client/.gitignore", reactGitignore());
    await write("client/README.md", reactReadme(projectName));
    await write("client/index.html", reactIndexHtml(projectName));
    await write("client/src/main.tsx", reactMainTsx());
    await write("client/src/api/client.ts", reactApiClient());
    await write("client/src/api/types.ts", reactApiTypes());
    await write("client/src/components/ErrorBoundary.tsx", reactErrorBoundary());
    await write("client/src/styles/app.css", reactAppCss());
  } else if (feStack === "angular") {
    await write("client/package.json", angularClientPackageJson(projectName));
    await write("client/tsconfig.json", angularTsConfig());
    await write("client/.gitignore", angularGitignore());
    await write("client/README.md", angularReadme(projectName));
    await write("client/src/styles.css", angularStylesCss());
    await write("client/src/environments/environment.ts", angularEnvironmentTs());
    await write("client/src/environments/environment.prod.ts", angularEnvironmentProdTs());
    await write("client/src/api/api.service.ts", angularApiServiceTs());
    await write("client/src/api/types.ts", angularApiTypes());
    await write("client/src/app/error-handler.ts", angularErrorHandlerTs());
    await write("client/src/main.ts", angularMainTs());
    await write("client/src/app/app.component.ts", angularAppComponentTs(projectName));
  }

  return { projectDir, files: filesWritten, usedDotnetTemplate, warnings: warnings.length > 0 ? warnings : undefined };
}

// ---------------------------------------------------------------------------
// Task 6.3 — Directory.Packages.props injection helper
// Task 6.4 — OSS-only filter (commercial packages excluded unless flag set)
// ---------------------------------------------------------------------------

/** Commercial BB package ids — excluded unless opts.commercial is true. */
const COMMERCIAL_PACKAGE_PREFIXES = [
  "Muonroi.RuleEngine.CEP",
  "Muonroi.Governance.Commercial",
  "Muonroi.Infrastructure.Commercial",
];

function isCommercialPackage(pkgId: string): boolean {
  return COMMERCIAL_PACKAGE_PREFIXES.some((prefix) => pkgId.startsWith(prefix));
}

async function injectPackagesProps(
  propsPath: string,
  eePackages: string[],
  commercial: boolean,
  fsOps: {
    writeFile: (p: string, content: string) => Promise<void>;
    exists: (p: string) => boolean;
  },
): Promise<void> {
  // Task 6.4 — filter out commercial packages unless flag is set
  const filteredPackages = eePackages.filter((pkg) => commercial || !isCommercialPackage(pkg));
  if (filteredPackages.length === 0) return;

  // Read current props content
  let propsContent: string;
  try {
    const { readFileSync } = await import("node:fs");
    propsContent = readFileSync(propsPath, "utf-8");
  } catch {
    propsContent = buildMinimalPackagesProps();
  }

  // Use fast-xml-parser for safe XML round-trip (task 6.2c / 6.11)
  // Dynamically import so tests can stub it
  let updatedContent = propsContent;
  try {
    const { XMLParser, XMLBuilder } = await import("fast-xml-parser");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      isArray: (name) => name === "PackageVersion",
    });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      format: true,
      indentBy: "  ",
    });

    const parsed = parser.parse(propsContent) as {
      Project?: {
        PropertyGroup?: unknown;
        ItemGroup?: {
          PackageVersion?: Array<{ "@_Include": string; "@_Version": string }>;
        };
      };
    };

    const project = parsed.Project ?? {};
    const itemGroup = project.ItemGroup ?? {};
    const existing: Array<{ "@_Include": string; "@_Version": string }> = itemGroup.PackageVersion ?? [];
    const existingIds = new Set(existing.map((pv) => pv["@_Include"]));

    // Add missing EE-recommended packages
    for (const pkg of filteredPackages) {
      if (!existingIds.has(pkg)) {
        existing.push({ "@_Include": pkg, "@_Version": "*" });
      }
    }
    itemGroup.PackageVersion = existing;
    project.ItemGroup = itemGroup;
    parsed.Project = project;
    updatedContent = builder.build(parsed) as string;
  } catch {
    // fast-xml-parser not available or parse failed — append raw entries as comment
    const rawEntries = filteredPackages.map((pkg) => `  <PackageVersion Include="${pkg}" Version="*" />`).join("\n");
    updatedContent = propsContent.replace(
      "</Project>",
      `  <!-- muonroi-cli:injected:ee-packages -->\n${rawEntries}\n  <!-- /muonroi-cli:injected:ee-packages -->\n</Project>`,
    );
  }

  await fsOps.writeFile(propsPath, updatedContent);
}

function buildMinimalPackagesProps(): string {
  return `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
  </ItemGroup>
</Project>`;
}

// ---------------------------------------------------------------------------
// Task 6.5 — EE-INTENT.md builder
// ---------------------------------------------------------------------------

interface EEIntentMdOpts {
  projectName: string;
  template: BBTemplateInfo;
  eePackages: string[];
  coverage: "full" | "partial";
}

function buildEEIntentMd(opts: EEIntentMdOpts): string {
  const date = new Date().toISOString().slice(0, 10);
  const packageList = opts.eePackages.length > 0 ? opts.eePackages.map((p) => `- ${p}`).join("\n") : "_(none)_";
  return `# EE-INTENT.md

Generated by muonroi-cli on ${date}.

## Project
**Name:** ${opts.projectName}

## Template
**Package:** ${opts.template.nugetId}
**Short name:** ${opts.template.shortName}
**Version:** ${opts.template.version}

## EE-Recommended Packages
${packageList}

## Coverage
**Status:** ${opts.coverage}
${opts.coverage === "partial" ? "\n> Some recommended packages have weak EE coverage (< 0.70). Code-gen applied generic wiring only for low-coverage packages. Run `bun run ee:ingest-bb` to improve coverage.\n" : ""}

## Resume
To re-apply or fix scaffold issues interactively:
\`\`\`
/ideal --resume .
\`\`\`
`;
}
