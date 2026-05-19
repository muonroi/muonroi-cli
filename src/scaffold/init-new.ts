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
import { existsSync, readdirSync } from "node:fs";
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

/** Test-only / diagnostic accessor. */
export function getDotnetDiagnostic(): string {
  return _lastDotnetDetectDiagnostic;
}

/**
 * Task 6.2 — Detect which BB templates are installed by parsing `dotnet new list`.
 * Returns map of nugetId → shortName for installed templates.
 */
export function detectInstalledBBTemplates(): Map<string, string> {
  const result = spawnSync(getDotnetCommand(), ["new", "list"], {
    encoding: "utf8",
    timeout: 15000,
    shell: NEEDS_SHELL,
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
      shell: NEEDS_SHELL,
    });
    const alreadyInstalled = result.status === 106 || (result.stdout ?? "").includes("is already installed");
    if (result.status !== 0 && !alreadyInstalled) {
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
}

export interface InitNewResult {
  projectDir: string;
  /** Relative paths of files written (relative to projectDir). */
  files: string[];
  /** Whether the dotnet-template path ran successfully (false for FE-only projects). */
  usedDotnetTemplate?: boolean;
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

const registry = createSemanticRegistry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SemanticProvider registry={registry}>
      <Semantic id="root" role="region" name="App root">
        {/* Your application components go here */}
        <h1>Hello from ${"{projectName}"}</h1>
      </Semantic>
    </SemanticProvider>
  </StrictMode>,
);
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
import { AppComponent } from "./app/app.component";

bootstrapApplication(AppComponent).catch(console.error);
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
        experimentalDecorators: true,
        emitDecoratorMetadata: false,
        moduleResolution: "bundler",
      },
    },
    null,
    2,
  );
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

  // Helper to write and track.
  async function write(relPath: string, content: string) {
    await fsOps.writeFile(path.join(projectDir, relPath), content);
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
    {
      const installed = detectInstalledBBTemplates();
      if (!installed.has(opts.bbTemplate.nugetId)) {
        const ok = installBBTemplates([opts.bbTemplate.nugetId]);
        if (!ok) {
          process.stderr.write(`[init-new] failed to install ${opts.bbTemplate.nugetId} from NuGet\n`);
          // fall through to throw below (no clone fallback)
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
        await fsOps.exec(
          `${dotnetCmd} new ${opts.bbTemplate.shortName} -n ${projectName} -o ${JSON.stringify(serverDir)}`,
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
          process.stderr.write(`[init-new] dotnet restore reported errors; continuing best-effort\n`);
        } else {
          usedDotnetTemplate = true;
        }

        // Plan 23-01b — add each EE-recommended package via `dotnet add package`.
        // Single-package failures are logged but do NOT abort the scaffold.
        for (const pkgId of opts.eePackages ?? []) {
          try {
            await fsOps.exec(`${dotnetCmd} add package ${pkgId}`, serverDir);
            filesWritten.push(`server/${path.basename(serverDir)}/<csproj-updated-${pkgId}>`);
          } catch (e) {
            process.stderr.write(
              `[init-new] dotnet add package ${pkgId} failed: ${e instanceof Error ? e.message : String(e)}\n`,
            );
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
        process.stderr.write(
          `[init-new] dotnet new ${opts.bbTemplate.shortName} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        usedDotnetTemplate = false;
      }
    }
  }

  if (!usedDotnetTemplate) {
    if (opts.bbTemplate) {
      const dotnetVersion = detectDotnet() ?? "(not detected)";
      const required = getMinSdkMajor(opts.bbTemplate.nugetId);
      const hint =
        required !== null
          ? `→ Template ${opts.bbTemplate.shortName} requires SDK ${required}.0+; you have ${dotnetVersion}.\n` +
            `  If NuGet feed is configured (run \`dotnet nuget list source\`), retry; otherwise:\n` +
            `    dotnet new install ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}`
          : `→ Try installing the template manually:\n` +
            `    dotnet new install ${opts.bbTemplate.nugetId}@${opts.bbTemplate.version}`;
      throw new Error(`Scaffold failed: dotnet template ${opts.bbTemplate.shortName} could not be applied.\n${hint}`);
    }
    // No bbTemplate provided → FE-only project, skip BE scaffold entirely.
  }

  // 7. Scaffold FE client.
  if (feStack === "react") {
    await write("client/package.json", reactClientPackageJson(projectName));
    await write("client/vite.config.ts", reactViteConfig());
    await write("client/index.html", reactIndexHtml(projectName));
    await write("client/src/main.tsx", reactMainTsx());
  } else if (feStack === "angular") {
    await write("client/package.json", angularClientPackageJson(projectName));
    await write("client/tsconfig.json", angularTsConfig());
    await write("client/src/main.ts", angularMainTs());
    await write("client/src/app/app.component.ts", angularAppComponentTs(projectName));
  }

  return { projectDir, files: filesWritten, usedDotnetTemplate };
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
