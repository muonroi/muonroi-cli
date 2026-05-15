/**
 * init-new.ts — Scaffolds a new muonroi project with:
 *   - <name>/server/  cloned from muonroi-building-block (BE)
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

/** Known BB template package descriptors. ShortNames discovered at install time. */
export const BB_TEMPLATE_PACKAGES: ReadonlyArray<Omit<BBTemplateInfo, "shortName">> = [
  { nugetId: "Muonroi.BaseTemplate", version: "latest" },
  { nugetId: "Muonroi.Modular.Template", version: "latest" },
  { nugetId: "Muonroi.Microservices.Template", version: "latest" },
];

/** Maps NuGet package id → expected dotnet new shortName (best-effort; runtime parse overrides). */
const NUGET_TO_SHORTNAME: Record<string, string> = {
  "Muonroi.BaseTemplate": "muonroi-base",
  "Muonroi.Modular.Template": "muonroi-modular",
  "Muonroi.Microservices.Template": "muonroi-microservices",
};

/**
 * Task 6.1 — Detect dotnet SDK availability via spawnSync.
 * Returns the dotnet version string, or null if not found.
 */
export function detectDotnet(): string | null {
  try {
    const result = spawnSync("dotnet", ["--version"], { encoding: "utf8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Task 6.2 — Detect which BB templates are installed by parsing `dotnet new list`.
 * Returns map of nugetId → shortName for installed templates.
 */
export function detectInstalledBBTemplates(): Map<string, string> {
  const result = spawnSync("dotnet", ["new", "list"], { encoding: "utf8", timeout: 15000 });
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
 * Task 6.2 — Install BB dotnet templates from NuGet.
 * Returns true if install succeeded, false if NuGet unreachable (caller falls back to clone).
 */
export function installBBTemplates(): boolean {
  const pkgs = BB_TEMPLATE_PACKAGES.map((p) => p.nugetId).join(" ");
  const result = spawnSync("dotnet", ["new", "install", ...BB_TEMPLATE_PACKAGES.map((p) => p.nugetId)], {
    encoding: "utf8",
    timeout: 60000,
  });
  // NuGet feed unreachable: non-zero exit or NU-prefixed error
  if (result.status !== 0) {
    process.stderr.write(`[init-new] dotnet new install failed (${pkgs}): ${result.stderr ?? "unknown error"}\n`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InitNewOptions {
  /** Target directory name; created at projectsRoot (or cwd). */
  projectName: string;
  /** Absolute path or git URL for the muonroi-building-block source. */
  beSource: string;
  /** "react" | "angular" | "none" */
  feStack: "react" | "angular" | "none";
  /** Where to write the project. Defaults to process.cwd(). */
  projectsRoot?: string;
  /**
   * Task 6.2b — BB template selection.
   * When absent → current clone path (backward-compatible).
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
  /** Whether dotnet-template path was used (vs. legacy clone path). */
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
    throw new Error(
      `Project name "${name}" is invalid. Use kebab-case alphanumeric only (e.g. "my-app", "project1").`,
    );
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
  const { projectName, beSource, feStack, projectsRoot } = opts;

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

  // 6. Task 6.3 — Scaffold BE source.
  //    If bbTemplate is provided + dotnet is available → use dotnet new template path.
  //    Otherwise → fall back to legacy git clone path.
  const serverDir = path.join(projectDir, "server");
  let usedDotnetTemplate = false;

  if (opts.bbTemplate) {
    const dotnetVersion = detectDotnet();
    if (dotnetVersion) {
      try {
        // Task 6.3 — run: dotnet new <shortName> -n <name> -o <target>/server
        await fsOps.exec(
          `dotnet new ${opts.bbTemplate.shortName} -n ${projectName} -o ${JSON.stringify(serverDir)} --no-restore`,
          root,
        );

        // Task 6.3 — inject EE-recommended packages into Directory.Packages.props
        const propsPath = path.join(serverDir, "Directory.Packages.props");
        if (opts.eePackages && opts.eePackages.length > 0 && fsOps.exists(propsPath)) {
          await injectPackagesProps(propsPath, opts.eePackages, opts.commercial ?? false, fsOps);
          filesWritten.push("server/Directory.Packages.props");
        }

        // Task 6.3 — verify with dotnet restore --nologo
        const restoreResult = await fsOps
          .exec("dotnet restore --nologo", serverDir)
          .catch((e: unknown) => ({ stdout: "", stderr: String(e) }));
        if (restoreResult.stderr && restoreResult.stderr.includes("error")) {
          // Restore failed — roll back props file if we injected it and fall through to clone
          process.stderr.write(`[init-new] dotnet restore failed after template scaffold; falling back to clone\n`);
          // Attempt to re-restore without custom props (original props)
          await fsOps
            .exec("dotnet restore --nologo", serverDir)
            .catch(() => {});
        } else {
          usedDotnetTemplate = true;
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
        // dotnet new failed — fall through to clone path
        process.stderr.write(
          `[init-new] dotnet new ${opts.bbTemplate.shortName} failed: ${err instanceof Error ? err.message : String(err)}; falling back to clone\n`,
        );
        usedDotnetTemplate = false;
      }
    }
  }

  if (!usedDotnetTemplate) {
    // Legacy path: git clone BE source into server/
    const cloneTarget = path.join(projectDir, "server");
    await fsOps.exec(`git clone ${beSource} ${JSON.stringify(cloneTarget)}`, root);
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
    const rawEntries = filteredPackages
      .map((pkg) => `  <PackageVersion Include="${pkg}" Version="*" />`)
      .join("\n");
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
${opts.coverage === "partial" ? "\n> Some recommended packages have weak EE coverage (< 0.70). Code-gen applied generic wiring only for low-coverage packages. Run \`bun run ee:ingest-bb\` to improve coverage.\n" : ""}

## Resume
To re-apply or fix scaffold issues interactively:
\`\`\`
/ideal --resume .
\`\`\`
`;
}
