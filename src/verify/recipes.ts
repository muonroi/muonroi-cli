import * as fs from "fs";
import * as path from "path";
import type { VerifyRecipe } from "../types/index";
import { mergeSandboxSettings, type SandboxSettings } from "../utils/settings";
import { extractCoverageFromOutput } from "./coverage-parsers.js";

export { extractCoverageFromOutput };

export type VerifyAppKind =
  | "nextjs"
  | "vite"
  | "astro"
  | "sveltekit"
  | "remix"
  | "cra"
  | "node"
  | "django"
  | "python"
  | "go"
  | "rust"
  | "maven"
  | "gradle"
  | "dotnet"
  | "make"
  | "unknown";

export interface VerifyProjectProfile {
  appKind: VerifyAppKind;
  appLabel: string;
  packageManager: string | null;
  availableScripts: string[];
  hasNodeModules: boolean;
  sandboxSettings: SandboxSettings;
  recipe: VerifyRecipe;
}

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function fileExists(cwd: string, file: string): boolean {
  return fs.existsSync(path.join(cwd, file));
}

function readTextFile(cwd: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, file), "utf8");
  } catch {
    return null;
  }
}

function readPackageJson(cwd: string): PackageJsonLike | null {
  const raw = readTextFile(cwd, "package.json");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PackageJsonLike;
  } catch {
    return null;
  }
}

export function detectPackageManager(cwd: string): string | null {
  const candidates: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["uv.lock", "uv"],
    ["poetry.lock", "poetry"],
    ["Pipfile.lock", "pipenv"],
  ];

  for (const [file, manager] of candidates) {
    if (fileExists(cwd, file)) return manager;
  }

  return null;
}

function dedupe(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)))];
}

export function defaultShellInit(): string[] {
  return ["export DEBIAN_FRONTEND=noninteractive"];
}

const NODE_WEB_APP_KINDS = new Set<VerifyAppKind>(["nextjs", "vite", "astro", "sveltekit", "remix", "cra"]);

export function getNodeWebShellInitCommands(packageManager: string | null, appKind: VerifyAppKind): string[] {
  const commands = [...defaultShellInit()];
  if (!NODE_WEB_APP_KINDS.has(appKind)) {
    return commands;
  }
  if (packageManager === "bun") {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
    commands.push('export BUN_INSTALL="${HOME}/.bun"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
    commands.push('export PATH="${BUN_INSTALL}/bin:$PATH"');
  }
  return commands;
}

export function getNodeWebBootstrapCommands(packageManager: string | null, appKind: VerifyAppKind): string[] {
  if (!NODE_WEB_APP_KINDS.has(appKind)) {
    return [];
  }
  const commands = [
    "apt-get update && apt-get install -y curl unzip ca-certificates git python3 make g++ pkg-config nodejs npm",
  ];
  if (packageManager === "bun") {
    commands.push("curl -fsSL https://bun.sh/install | bash");
  }
  return commands;
}

function parseHostPort(mapping: string): string | null {
  const match = mapping.trim().match(/^(\d+):(\d+)$/);
  return match ? match[1] : null;
}

function inferPortFromCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const flagMatch = command.match(/(?:--port|-p)\s+(\d{2,5})/);
  if (flagMatch) return flagMatch[1];
  const envMatch = command.match(/\bPORT=(\d{2,5})\b/);
  if (envMatch) return envMatch[1];
  return undefined;
}

function parseTargetNames(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z0-9_.-]+):(?:\s|$)/)?.[1])
    .filter((target): target is string => Boolean(target));
}

export function normalizeVerifyAppKind(value: string): VerifyAppKind {
  return (
    [
      "nextjs",
      "vite",
      "astro",
      "sveltekit",
      "remix",
      "cra",
      "node",
      "django",
      "python",
      "go",
      "rust",
      "maven",
      "gradle",
      "dotnet",
      "make",
      "unknown",
    ] as const
  ).includes(value as VerifyAppKind)
    ? (value as VerifyAppKind)
    : "unknown";
}

function pickPackageScript(packageManager: string | null, scripts: Record<string, string>, body: string): string {
  const entry = Object.entries(scripts).find(([, scriptBody]) => scriptBody === body)?.[0];
  if (!entry) return body;
  const runner =
    packageManager === "pnpm"
      ? "pnpm"
      : packageManager === "bun"
        ? "bun"
        : packageManager === "yarn"
          ? "yarn"
          : "npm run";
  return runner === "yarn" ? `yarn ${entry}` : runner === "bun" ? `bun run ${entry}` : `${runner} ${entry}`;
}

function detectMakeRecipe(cwd: string): VerifyRecipe | null {
  const makefile = readTextFile(cwd, "Makefile");
  if (!makefile) return null;
  const targets = parseTargetNames(makefile);
  const has = (names: string[]) => names.find((name) => targets.includes(name));
  const install = has(["install", "setup", "bootstrap"]);
  const build = has(["build", "compile"]);
  const test = has(["test", "check"]);
  const run = has(["run", "start", "serve", "dev"]);

  return {
    ecosystem: "make",
    appKind: "make",
    appLabel: "Makefile-driven project",
    shellInitCommands: defaultShellInit(),
    bootstrapCommands: [],
    installCommands: install ? [`make ${install}`] : [],
    buildCommands: build ? [`make ${build}`] : [],
    testCommands: test ? [`make ${test}`] : [],
    startCommand: run ? `make ${run}` : undefined,
    smokeKind: "none",
    evidence: ["Detected Makefile", `Targets: ${targets.join(", ") || "(none)"}`],
    notes: [],
  };
}

function detectNodeRecipe(_cwd: string, pkg: PackageJsonLike, packageManager: string | null): VerifyRecipe {
  const scripts = pkg.scripts ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  let appKind: VerifyAppKind = "node";
  let appLabel = "Node.js app";
  let defaultPort: string | undefined;

  if (deps.next) {
    appKind = "nextjs";
    appLabel = "Next.js";
    defaultPort = "3000";
  } else if (deps["@sveltejs/kit"]) {
    appKind = "sveltekit";
    appLabel = "SvelteKit";
    defaultPort = "5173";
  } else if (deps.astro) {
    appKind = "astro";
    appLabel = "Astro";
    defaultPort = "4321";
  } else if (deps["@remix-run/dev"] || deps["@remix-run/react"]) {
    appKind = "remix";
    appLabel = "Remix";
    defaultPort = "3000";
  } else if (deps["react-scripts"]) {
    appKind = "cra";
    appLabel = "Create React App";
    defaultPort = "3000";
  } else if (deps.vite) {
    appKind = "vite";
    appLabel = "Vite";
    defaultPort = "5173";
  }

  const install = packageManager
    ? packageManager === "pnpm"
      ? "pnpm install"
      : packageManager === "bun"
        ? "bun install"
        : packageManager === "yarn"
          ? "yarn install"
          : "npm install"
    : undefined;
  const startCommand = scripts.dev ?? scripts.start;
  const startPort = inferPortFromCommand(startCommand) ?? defaultPort;
  const smokeKind: VerifyRecipe["smokeKind"] = startCommand && startPort ? "http" : "none";

  return {
    ecosystem: "node",
    appKind,
    appLabel,
    shellInitCommands: getNodeWebShellInitCommands(packageManager, appKind),
    bootstrapCommands: getNodeWebBootstrapCommands(packageManager, appKind),
    installCommands: dedupe([install]),
    buildCommands: dedupe(
      [scripts.build, scripts.typecheck].map((script) => script && pickPackageScript(packageManager, scripts, script)),
    ),
    testCommands: dedupe(
      ["test", "check", "lint"]
        .filter((name) => scripts[name])
        .map((name) => pickPackageScript(packageManager, scripts, scripts[name]!)),
    ),
    startCommand: startCommand ? pickPackageScript(packageManager, scripts, startCommand) : undefined,
    startPort,
    smokeKind,
    evidence: ["Detected package.json", `Scripts: ${Object.keys(scripts).join(", ") || "(none)"}`],
    notes: [],
  };
}

function detectPythonRecipe(cwd: string): VerifyRecipe | null {
  const pyproject = readTextFile(cwd, "pyproject.toml");
  const requirements = readTextFile(cwd, "requirements.txt");
  const managePy = fileExists(cwd, "manage.py");
  if (!pyproject && !requirements && !managePy && !fileExists(cwd, "setup.py")) {
    return null;
  }

  const lower = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  const packageManager = detectPackageManager(cwd);
  const isDjango = managePy || lower.includes("django");
  const isFastApi = lower.includes("fastapi") || lower.includes("uvicorn");

  let install = "pip install -r requirements.txt";
  if (packageManager === "uv") install = "uv sync";
  else if (packageManager === "poetry") install = "poetry install";
  else if (packageManager === "pipenv") install = "pipenv install";
  else if (pyproject && !requirements) install = "pip install -e .";

  if (isDjango) {
    return {
      ecosystem: "python",
      appKind: "django",
      appLabel: "Django app",
      shellInitCommands: defaultShellInit(),
      bootstrapCommands: [],
      installCommands: [install],
      buildCommands: [],
      testCommands: ["python manage.py test"],
      startCommand: "python manage.py runserver 0.0.0.0:8000",
      startPort: "8000",
      smokeKind: "http",
      evidence: ["Detected manage.py", pyproject ? "Detected pyproject.toml" : undefined].filter(Boolean) as string[],
      notes: [],
    };
  }

  if (isFastApi) {
    const appModule = fileExists(cwd, "main.py") ? "main:app" : fileExists(cwd, "app.py") ? "app:app" : "main:app";
    return {
      ecosystem: "python",
      appKind: "python",
      appLabel: "Python web app",
      shellInitCommands: defaultShellInit(),
      bootstrapCommands: [],
      installCommands: [install],
      buildCommands: [],
      testCommands: fileExists(cwd, "tests") ? ["pytest"] : [],
      startCommand: `uvicorn ${appModule} --host 0.0.0.0 --port 8000`,
      startPort: "8000",
      smokeKind: "http",
      evidence: ["Detected Python project", "Detected FastAPI/Uvicorn dependency"],
      notes: [],
    };
  }

  return {
    ecosystem: "python",
    appKind: "python",
    appLabel: "Python project",
    shellInitCommands: defaultShellInit(),
    bootstrapCommands: [],
    installCommands: [install],
    buildCommands: [],
    testCommands: fileExists(cwd, "tests") ? ["pytest"] : ["python -m unittest discover"],
    smokeKind: "none",
    evidence: ["Detected Python project"],
    notes: [],
  };
}

function detectGoRecipe(cwd: string): VerifyRecipe | null {
  if (!fileExists(cwd, "go.mod")) return null;
  return {
    ecosystem: "go",
    appKind: "go",
    appLabel: "Go project",
    shellInitCommands: defaultShellInit(),
    bootstrapCommands: [],
    installCommands: [],
    buildCommands: ["go build ./..."],
    testCommands: ["go test ./..."],
    startCommand: fileExists(cwd, "main.go") ? "go run ." : undefined,
    smokeKind: "none",
    evidence: ["Detected go.mod"],
    notes: [],
  };
}

function detectRustRecipe(cwd: string): VerifyRecipe | null {
  if (!fileExists(cwd, "Cargo.toml")) return null;
  return {
    ecosystem: "rust",
    appKind: "rust",
    appLabel: "Rust project",
    shellInitCommands: defaultShellInit(),
    bootstrapCommands: [],
    installCommands: [],
    buildCommands: ["cargo build"],
    testCommands: ["cargo test"],
    startCommand: fileExists(cwd, path.join("src", "main.rs")) ? "cargo run" : undefined,
    smokeKind: "none",
    evidence: ["Detected Cargo.toml"],
    notes: [],
  };
}

function detectJavaRecipe(cwd: string): VerifyRecipe | null {
  if (fileExists(cwd, "pom.xml")) {
    return {
      ecosystem: "java",
      appKind: "maven",
      appLabel: "Maven project",
      shellInitCommands: defaultShellInit(),
      bootstrapCommands: [],
      installCommands: [],
      buildCommands: ["mvn package"],
      testCommands: ["mvn test"],
      smokeKind: "none",
      evidence: ["Detected pom.xml"],
      notes: [],
    };
  }

  if (fileExists(cwd, "build.gradle") || fileExists(cwd, "build.gradle.kts")) {
    const gradle = fileExists(cwd, "gradlew") ? "./gradlew" : "gradle";
    return {
      ecosystem: "java",
      appKind: "gradle",
      appLabel: "Gradle project",
      shellInitCommands: defaultShellInit(),
      bootstrapCommands: [],
      installCommands: [],
      buildCommands: [`${gradle} build`],
      testCommands: [`${gradle} test`],
      smokeKind: "none",
      evidence: ["Detected Gradle build file"],
      notes: [],
    };
  }

  return null;
}

// Scan cwd (one level deep) for .csproj/.sln/Directory.Build.props — covers
// both root-level and src/-nested layouts produced by Muonroi.BaseTemplate /
// Muonroi.Microservices.Template / Muonroi.Modular.Template.
function findDotnetMarkers(cwd: string): { sln: string | null; csproj: string | null; bbProps: boolean } {
  let sln: string | null = null;
  let csproj: string | null = null;
  let bbProps = false;
  try {
    const visit = (dir: string, depth: number): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "bin" || entry.name === "obj")
          continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
          if (!sln && entry.name.endsWith(".sln")) sln = path.relative(cwd, full) || entry.name;
          if (!csproj && entry.name.endsWith(".csproj")) csproj = path.relative(cwd, full) || entry.name;
          if (entry.name === "Directory.Build.props") bbProps = true;
        } else if (entry.isDirectory() && depth < 2) {
          visit(full, depth + 1);
        }
      }
    };
    visit(cwd, 0);
  } catch {
    /* fail-open */
  }
  return { sln, csproj, bbProps };
}

function detectDotnetRecipe(cwd: string): VerifyRecipe | null {
  const { sln, csproj, bbProps } = findDotnetMarkers(cwd);
  if (!sln && !csproj) return null;

  // Target the .sln when present (covers the whole solution); fall back to the
  // single .csproj when only one project exists.
  const target = sln ? `"${sln}"` : csproj ? `"${csproj}"` : "";
  const evidence: string[] = [];
  if (sln) evidence.push(`Detected .NET solution: ${sln}`);
  if (csproj) evidence.push(`Detected .NET project: ${csproj}`);
  if (bbProps) evidence.push("Detected Directory.Build.props (Muonroi BB ecosystem marker)");

  const notes: string[] = [];
  if (bbProps) {
    notes.push(
      "Muonroi BB project — run `pwsh scripts/check-modular-boundaries.ps1` after build if the script is present.",
    );
  }

  return {
    ecosystem: "dotnet",
    appKind: "dotnet",
    appLabel: bbProps ? ".NET (Muonroi BB)" : ".NET project",
    shellInitCommands: defaultShellInit(),
    bootstrapCommands: [],
    installCommands: [`dotnet restore ${target}`.trim()],
    buildCommands: [`dotnet build ${target} --no-restore`.trim()],
    testCommands: [`dotnet test ${target} --no-build --nologo`.trim()],
    smokeKind: "none",
    evidence,
    notes,
  };
}

function detectFallbackRecipe(cwd: string): VerifyRecipe {
  const makeRecipe = detectMakeRecipe(cwd);
  if (makeRecipe) return makeRecipe;
  return {
    ecosystem: "unknown",
    appKind: "unknown",
    appLabel: "Unknown project type",
    shellInitCommands: defaultShellInit(),
    bootstrapCommands: [],
    installCommands: [],
    buildCommands: [],
    testCommands: [],
    smokeKind: "none",
    evidence: ["No known app metadata detected"],
    notes: ["The verify sub-agent should inspect the repo directly and derive commands from the codebase."],
  };
}

function inferFallbackRecipe(cwd: string, pkg: PackageJsonLike | null, packageManager: string | null): VerifyRecipe {
  if (pkg) return detectNodeRecipe(cwd, pkg, packageManager);
  return (
    detectPythonRecipe(cwd) ??
    detectGoRecipe(cwd) ??
    detectRustRecipe(cwd) ??
    detectJavaRecipe(cwd) ??
    detectDotnetRecipe(cwd) ??
    detectFallbackRecipe(cwd)
  );
}

export function normalizeVerifyRecipe(value: unknown): VerifyRecipe | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const asStrings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
      : [];
  const ecosystem = typeof raw.ecosystem === "string" ? raw.ecosystem.trim() : "";
  const appKind = typeof raw.appKind === "string" ? raw.appKind.trim() : "";
  const appLabel = typeof raw.appLabel === "string" ? raw.appLabel.trim() : "";
  const smokeKind =
    raw.smokeKind === "http" || raw.smokeKind === "cli" || raw.smokeKind === "none" ? raw.smokeKind : "none";
  if (!ecosystem || !appKind || !appLabel) return null;
  return {
    ecosystem,
    appKind,
    appLabel,
    shellInitCommands: asStrings(raw.shellInitCommands),
    bootstrapCommands: asStrings(raw.bootstrapCommands),
    installCommands: asStrings(raw.installCommands),
    buildCommands: asStrings(raw.buildCommands),
    testCommands: asStrings(raw.testCommands),
    startCommand: typeof raw.startCommand === "string" && raw.startCommand.trim() ? raw.startCommand.trim() : undefined,
    startPort: typeof raw.startPort === "string" && raw.startPort.trim() ? raw.startPort.trim() : undefined,
    smokeKind,
    smokeTarget: typeof raw.smokeTarget === "string" && raw.smokeTarget.trim() ? raw.smokeTarget.trim() : undefined,
    evidence: asStrings(raw.evidence),
    notes: asStrings(raw.notes),
    coverage: typeof raw.coverage === "number" ? raw.coverage : null,
  };
}

export function inferVerifySmokeUrl(settings?: SandboxSettings): string | null {
  const ports = settings?.ports ?? [];
  if (ports.length !== 1) return null;
  const hostPort = parseHostPort(ports[0]);
  return hostPort ? `http://127.0.0.1:${hostPort}` : null;
}

export function inferVerifyProjectProfile(
  cwd: string,
  baseSettings: SandboxSettings = {},
  recipeOverride?: VerifyRecipe | null,
): VerifyProjectProfile {
  const pkg = readPackageJson(cwd);
  const packageManager = detectPackageManager(cwd);
  const recipe = recipeOverride ?? inferFallbackRecipe(cwd, pkg, packageManager);
  const inferredDefaults: SandboxSettings =
    recipe.smokeKind === "http" && recipe.startPort ? { ports: [`${recipe.startPort}:${recipe.startPort}`] } : {};
  const sandboxSettings = mergeSandboxSettings(inferredDefaults, baseSettings);
  const smokeUrl = inferVerifySmokeUrl(sandboxSettings);

  const recipeWithRuntime: VerifyRecipe = {
    ...recipe,
    smokeTarget: recipe.smokeKind === "http" ? (smokeUrl ?? recipe.smokeTarget) : undefined,
  };

  if (!fs.existsSync(path.join(cwd, "node_modules")) && recipeWithRuntime.ecosystem === "node") {
    recipeWithRuntime.notes = dedupe([
      ...recipeWithRuntime.notes,
      "Host dependencies are not installed in node_modules. Verification may be limited unless a Shuru checkpoint already contains the needed runtime dependencies.",
    ]);
  }

  return {
    appKind: normalizeVerifyAppKind(recipeWithRuntime.appKind),
    appLabel: recipeWithRuntime.appLabel,
    packageManager,
    availableScripts: Object.keys(pkg?.scripts ?? {}),
    hasNodeModules: fs.existsSync(path.join(cwd, "node_modules")),
    sandboxSettings,
    recipe: recipeWithRuntime,
  };
}
