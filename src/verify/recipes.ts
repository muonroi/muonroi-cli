import * as fs from "fs";
import * as path from "path";
import type { VerifyRecipe } from "../types/index";
import { mergeSandboxSettings, type SandboxSettings } from "../utils/settings";
import { extractCoverageFromOutput } from "./coverage-parsers.js";
import {
  buildPytestCommand,
  buildPytestInstallCommand,
  buildPythonDepsInstallCommand,
  findPytestTargets,
  type PytestTarget,
} from "./pytest-detect.js";
import { commandIn, fileExistsIn, findMarkedDirectories } from "./workspace-scan.js";

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
  /**
   * The ecosystem of EVERY stack found on disk, deduped, primary first.
   *
   * `recipe.ecosystem` is a single string and names only the primary stack, so on
   * a polyglot repo it is a half-truth: qa-platform reports `node` while half its
   * gates are pytest under `backend/`. This list is the honest answer, always
   * from the disk probe rather than from the recipe (a model-written recipe
   * cannot talk it down), and the verify sub-agent is told about it.
   */
  componentEcosystems: string[];
  availableScripts: string[];
  hasNodeModules: boolean;
  sandboxSettings: SandboxSettings;
  recipe: VerifyRecipe;
}

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  /**
   * npm / yarn / bun workspace globs. Present means the root package's own
   * scripts are the workspace-wide entry point, so its members must not each
   * become a separate component — see `findNodePackageRoots`.
   */
  workspaces?: string[] | { packages?: string[] };
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

/** JS lockfiles, highest precedence first. */
const NODE_LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Python lockfiles, which name a dependency manager rather than a JS runner. */
const PYTHON_LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
  ["Pipfile.lock", "pipenv"],
];

/**
 * The package manager declared by a lockfile in `cwd` ITSELF.
 *
 * Deliberately root-only. Its two production callers ask a root question —
 * `ensureBootstrapCommands` (src/verify/entrypoint.ts) decides whether the
 * sandbox needs a `bun` install, and `detectPythonRecipe` below decides whether
 * the ROOT install line is `uv sync` / `poetry install`. Walking here would make
 * a `backend/uv.lock` produce a root-relative `uv sync`, which fails on a repo
 * with no root Python project. Per-package resolution is
 * {@link detectPackageManagerFor}.
 */
export function detectPackageManager(cwd: string): string | null {
  for (const [file, manager] of [...NODE_LOCKFILES, ...PYTHON_LOCKFILES]) {
    if (fileExists(cwd, file)) return manager;
  }
  return null;
}

/**
 * The package manager for the Node package at `<root>/<dir>`: its OWN lockfile
 * first, then the root's.
 *
 * Root-only resolution is why qa-platform never got an install command for its
 * front end at all — measured on the real tree at ea529904,
 * `detectPackageManager("D:/sources/CompanyLibs/qa-platform")` returns null
 * because the only lockfile is `frontend/package-lock.json`, and
 * `detectNodeRecipe` emits no install command when the manager is null. The
 * root fallback covers the opposite layout: a monorepo with ONE lockfile at the
 * top and no lockfile beside each member.
 */
export function detectPackageManagerFor(root: string, dir: string): string | null {
  const here = path.join(root, dir);
  for (const [file, manager] of NODE_LOCKFILES) {
    if (fileExists(here, file)) return manager;
  }
  if (!dir) return null;
  for (const [file, manager] of NODE_LOCKFILES) {
    if (fileExists(root, file)) return manager;
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

const NODE_ECOSYSTEMS = new Set(["node", "nodejs", "npm", "bun", "yarn", "pnpm"]);
const PYTHON_ECOSYSTEMS = new Set(["python", "django", "fastapi"]);
const GO_ECOSYSTEMS = new Set(["go", "golang"]);
const RUST_ECOSYSTEMS = new Set(["rust", "cargo"]);

/**
 * The sandbox provisioning an ecosystem label implies.
 *
 * Lives here, beside the detectors, rather than in `src/verify/entrypoint.ts`
 * where it started: `composeRecipe` needs it so a polyglot repo's SECOND stack
 * gets a toolchain too. `ensureBootstrapCommands` returns early once a recipe
 * carries any bootstrap command at all (to preserve a model- or
 * manifest-supplied one), and a composed recipe already carries the primary
 * stack's — so by the time it ran, the sibling stack's toolchain could no longer
 * be added. Measured on the qa-platform shape: bootstrap was the single node apt
 * line, which installs `python3` but neither `python3-pip` nor `python3-venv`,
 * so the recipe's own `cd backend && python -m pip install pytest` had nothing
 * to run with.
 */
export function inferBootstrapFromEcosystem(
  ecosystem: string,
  packageManager: string | null,
): { bootstrap: string[]; shellInit: string[] } {
  const eco = ecosystem.toLowerCase();

  if (
    NODE_ECOSYSTEMS.has(eco) ||
    eco.includes("node") ||
    eco.includes("next") ||
    eco.includes("react") ||
    eco.includes("vite")
  ) {
    const bootstrap = [
      "apt-get update && apt-get install -y curl unzip ca-certificates git python3 make g++ pkg-config nodejs npm",
    ];
    const shellInit = [...defaultShellInit()];
    if (packageManager === "bun") {
      bootstrap.push("curl -fsSL https://bun.sh/install | bash");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
      shellInit.push('export BUN_INSTALL="${HOME}/.bun"');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
      shellInit.push('export PATH="${BUN_INSTALL}/bin:$PATH"');
    }
    return { bootstrap, shellInit };
  }

  if (PYTHON_ECOSYSTEMS.has(eco) || eco.includes("python") || eco.includes("django") || eco.includes("flask")) {
    return {
      bootstrap: ["apt-get update && apt-get install -y python3 python3-pip python3-venv ca-certificates git"],
      shellInit: defaultShellInit(),
    };
  }

  if (GO_ECOSYSTEMS.has(eco) || eco.includes("go")) {
    return {
      bootstrap: ["apt-get update && apt-get install -y golang ca-certificates git"],
      shellInit: defaultShellInit(),
    };
  }

  if (RUST_ECOSYSTEMS.has(eco) || eco.includes("rust")) {
    return {
      bootstrap: [
        "apt-get update && apt-get install -y curl ca-certificates git build-essential && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
      ],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
      shellInit: [...defaultShellInit(), 'export PATH="${HOME}/.cargo/bin:$PATH"'],
    };
  }

  return { bootstrap: [], shellInit: [] };
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

/**
 * What a set of discovered pytest targets contributes to a recipe.
 *
 * Kept as one function so the Python branch and the polyglot augmentation below
 * cannot drift into emitting differently-shaped commands for the same repo.
 */
interface PytestContribution {
  testCommands: string[];
  installCommands: string[];
  evidence: string[];
  notes: string[];
}

/**
 * Turn discovered targets into commands.
 *
 * A target whose pytest is NOT provably available gets an install command as
 * well as a note. Emitting the test command alone would be the worse failure:
 * `python -m pytest` with no pytest installed exits before collecting anything,
 * so an honest `no_test_commands` floor failure would become a `verify_FAIL`
 * that blames the project's tests for a missing dependency. qa-platform is
 * exactly this case — `backend/requirements.txt` does not list pytest and
 * `backend/.venv` has no pytest in site-packages, yet `backend/conftest.py`
 * exists and the repo's own `.pytest_cache` proves pytest is what runs here.
 */
function contributionFromPytestTargets(targets: PytestTarget[]): PytestContribution {
  const contribution: PytestContribution = { testCommands: [], installCommands: [], evidence: [], notes: [] };
  for (const target of targets) {
    const where = target.dir || "the repository root";
    contribution.testCommands.push(buildPytestCommand(target));
    contribution.evidence.push(`Detected pytest in ${where} via ${target.marker}`);
    // A sub-project's own manifest is not reachable from the repository root, so
    // its dependencies are installed from its own directory, in its own
    // interpreter — BEFORE pytest, so a manifest that already pins pytest
    // satisfies it and the fallback install below is a no-op.
    const deps = buildPythonDepsInstallCommand(target);
    if (deps) contribution.installCommands.push(deps);
    if (!target.pytestDeclared) {
      contribution.installCommands.push(buildPytestInstallCommand(target));
      contribution.notes.push(
        `pytest is not declared in a manifest under ${where} and is not installed in a venv there, ` +
          `so the recipe installs it before running tests. If this project runs its tests another way, ` +
          `replace the generated pytest command.`,
      );
    }
  }
  return contribution;
}

function detectPythonRecipe(cwd: string): VerifyRecipe | null {
  const pyproject = readTextFile(cwd, "pyproject.toml");
  const requirements = readTextFile(cwd, "requirements.txt");
  const managePy = fileExists(cwd, "manage.py");
  // Root manifests are not the only proof of a Python project: qa-platform keeps
  // its whole backend (requirements.txt + conftest.py) under `backend/` and has
  // no Python manifest at the root at all, so a root-only check reported "not a
  // Python project" and the recipe lost its tests. A discovered pytest target
  // anywhere in the bounded search is equally good evidence.
  const pytestTargets = findPytestTargets(cwd);
  if (!pyproject && !requirements && !managePy && !fileExists(cwd, "setup.py") && pytestTargets.length === 0) {
    return null;
  }
  const pytest = contributionFromPytestTargets(pytestTargets);

  const lower = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  const packageManager = detectPackageManager(cwd);
  const isDjango = managePy || lower.includes("django");
  const isFastApi = lower.includes("fastapi") || lower.includes("uvicorn");

  let install: string | undefined = "pip install -r requirements.txt";
  if (packageManager === "uv") install = "uv sync";
  else if (packageManager === "poetry") install = "poetry install";
  else if (packageManager === "pipenv") install = "pipenv install";
  else if (pyproject && !requirements) install = "pip install -e .";
  // A root-relative install is only runnable when the ROOT actually declares
  // dependencies. qa-platform's only manifest is `backend/requirements.txt`, and
  // the recipe reached this function solely because a pytest target was
  // discovered under `backend/`; emitting `pip install -r requirements.txt` there
  // names a file that does not exist, and the floor would fail on the install
  // before it ever ran a test. The per-target install in
  // `contributionFromPytestTargets` covers that case instead.
  if (!pyproject && !requirements && !fileExists(cwd, "setup.py") && !fileExists(cwd, "Pipfile")) install = undefined;

  if (isDjango) {
    return {
      ecosystem: "python",
      appKind: "django",
      appLabel: "Django app",
      shellInitCommands: defaultShellInit(),
      bootstrapCommands: [],
      installCommands: dedupe([install]),
      buildCommands: [],
      // Left alone deliberately: `manage.py test` is Django's own runner, always
      // present and always launchable, so there is no gap here for pytest
      // discovery to fill and no evidence on hand that a Django project wants a
      // second, competing test command.
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
      installCommands: dedupe([install, ...pytest.installCommands]),
      buildCommands: [],
      testCommands: pytest.testCommands,
      startCommand: `uvicorn ${appModule} --host 0.0.0.0 --port 8000`,
      startPort: "8000",
      smokeKind: "http",
      evidence: ["Detected Python project", "Detected FastAPI/Uvicorn dependency", ...pytest.evidence],
      notes: pytest.notes,
    };
  }

  return {
    ecosystem: "python",
    appKind: "python",
    appLabel: "Python project",
    shellInitCommands: defaultShellInit(),
    bootstrapCommands: [],
    installCommands: dedupe([install, ...pytest.installCommands]),
    buildCommands: [],
    // Was `["python -m unittest discover"]` whenever no root `tests/` existed —
    // a command emitted for a project with no discoverable tests at all. That is
    // papering over a genuine absence, and it does not even fail quietly:
    // measured on this machine (Python 3.14.5) an empty discover run prints
    // "NO TESTS RAN" and exits 5, so the floor reported `verify_FAIL` — blaming
    // the project's tests — instead of the truthful `no_test_commands`.
    // (Before Python 3.12 the same run exits 0, which is worse still: a floor
    // that PASSES on zero executed tests.) An honest empty list lets the
    // engineering floor do its job.
    testCommands: pytest.testCommands,
    smokeKind: "none",
    evidence: ["Detected Python project", ...pytest.evidence],
    notes: pytest.notes,
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

/** One stack found in the repository, and where it lives relative to the root. */
interface RecipeComponent {
  /** Directory relative to the repository root; "" is the root itself. */
  dir: string;
  recipe: VerifyRecipe;
}

/**
 * Re-point every command in a sub-directory's recipe at that directory.
 *
 * Uses the one shared `cd <dir> && …` shape (`commandIn`), so a relocated
 * `cargo test` and the shipped pytest path emit identically-structured commands
 * to the verify floor's `spawn(command, {shell: true})`.
 */
function relocate(recipe: VerifyRecipe, dir: string): VerifyRecipe {
  if (!dir) return recipe;
  const at = (commands: string[]): string[] => commands.map((command) => commandIn(dir, command));
  return {
    ...recipe,
    installCommands: at(recipe.installCommands),
    buildCommands: at(recipe.buildCommands),
    testCommands: at(recipe.testCommands),
    startCommand: recipe.startCommand ? commandIn(dir, recipe.startCommand) : undefined,
    evidence: recipe.evidence.map((line) => `${line} (in ${dir})`),
  };
}

/**
 * Every Node package in the bounded scan.
 *
 * NOT pruned at a claimed directory, because a root `package.json` does not
 * imply it builds or tests its sub-packages: qa-platform's root declares the
 * single script `verify` and nothing else, so pruning would lose
 * `frontend/package.json`'s `build` — the missing build gate this exists to
 * close. A declared workspace IS pruned: there the root's own `build`/`test`
 * scripts are the workspace-wide entry point (muonroi-cli itself declares
 * `workspaces: ["packages/*"]`), so per-member components would duplicate work
 * the root command already does.
 */
function findNodePackageRoots(cwd: string): Array<{ dir: string; pkg: PackageJsonLike }> {
  const rootPkg = readPackageJson(cwd);
  const declaresWorkspaces = Boolean(
    rootPkg &&
      (Array.isArray(rootPkg.workspaces)
        ? rootPkg.workspaces.length > 0
        : Array.isArray(rootPkg.workspaces?.packages) && rootPkg.workspaces.packages.length > 0),
  );
  if (declaresWorkspaces || fileExists(cwd, "pnpm-workspace.yaml")) {
    return rootPkg ? [{ dir: "", pkg: rootPkg }] : [];
  }
  return findMarkedDirectories(cwd, (dir) => readPackageJson(dir)).map(({ dir, value }) => ({ dir, pkg: value }));
}

/**
 * Every Cargo root in the bounded scan, PRUNED at each claim.
 *
 * `cargo test` at a workspace root already runs every member, so descending into
 * `crates/*` would emit a second, redundant test command per crate. Verified
 * against the real `D:/sources/Core/claw-code-parity`, whose only Cargo.toml is
 * `rust/Cargo.toml` (`[workspace] members = ["crates/*"]`) and which the
 * root-only detector reported as `ecosystem: "unknown"` / TRUSTED false at
 * ea529904 — a CB-3 `no_recipe` halt on a repo with a real Rust test suite.
 */
function findCargoRoots(cwd: string): string[] {
  return findMarkedDirectories(cwd, (dir) => (fileExistsIn(dir, "Cargo.toml") ? true : null), {
    pruneClaimed: true,
  }).map(({ dir }) => dir);
}

/**
 * Every stack this repository really has, in a fixed precedence order.
 *
 * Replaces the `if (pkg) return detectNodeRecipe(...)` short-circuit, which made
 * a root `package.json` hide every other detector: qa-platform's root package
 * declares one `verify` script, so the whole FastAPI backend under `backend/`
 * was invisible and the deterministic profile came back
 * `{ecosystem:"node", testCommands:[], buildCommands:[]}` (measured on the real
 * tree at ea529904).
 *
 * Order matters — it decides which component is PRIMARY (see
 * {@link composeRecipe}) — and reproduces the previous chain's precedence
 * (python before go before rust before java before dotnet) so no single-stack
 * repo changes hands.
 *
 * Which detectors got a bounded scan, and which did not:
 *  - node, python, rust, dotnet — scan sub-directories. Each is exercised
 *    against a real tree on this machine (qa-platform, claw-code-parity,
 *    storyflow).
 *  - go, java (maven/gradle) — ROOT ONLY, unchanged. There is no Go, Maven or
 *    Gradle tree anywhere under `D:/sources`, and no `go`/`mvn`/`gradle` on
 *    PATH, so the sub-directory command shape cannot be exercised: a Gradle
 *    subproject has no `./gradlew` of its own, and a Maven child module needs
 *    its parent installed first. Guessing `cd <dir> && …` for those would be
 *    inventing a command shape. They are still promoted from the old
 *    short-circuit to real components, so a root `pom.xml` is no longer hidden
 *    by a root `package.json`.
 *  - Makefile — deliberately NOT a component. A Makefile is very often an
 *    auxiliary task runner in a Node or Python repo (docker, deploy), so
 *    `make test` there is not the project's gate. It keeps its existing
 *    last-resort position in {@link detectFallbackRecipe}.
 */
function detectRecipeComponents(cwd: string): RecipeComponent[] {
  const components: RecipeComponent[] = [];

  for (const { dir, pkg } of findNodePackageRoots(cwd)) {
    const packageManager = detectPackageManagerFor(cwd, dir);
    components.push({ dir, recipe: relocate(detectNodeRecipe(path.join(cwd, dir), pkg, packageManager), dir) });
  }

  // Already sub-directory aware internally (`findPytestTargets`), so it is asked
  // about the root once rather than re-walked per directory here.
  const python = detectPythonRecipe(cwd);
  if (python) components.push({ dir: "", recipe: python });

  const go = detectGoRecipe(cwd);
  if (go) components.push({ dir: "", recipe: go });

  for (const dir of findCargoRoots(cwd)) {
    const rust = detectRustRecipe(path.join(cwd, dir));
    if (rust) components.push({ dir, recipe: relocate(rust, dir) });
  }

  const java = detectJavaRecipe(cwd);
  if (java) components.push({ dir: "", recipe: java });

  // Already scans depth 2 via `findDotnetMarkers`, and targets the .sln, so its
  // commands are correct run from the root.
  const dotnet = detectDotnetRecipe(cwd);
  if (dotnet) components.push({ dir: "", recipe: dotnet });

  return components;
}

/**
 * Why the composed recipe still carries ONE `ecosystem` string.
 *
 * It cannot honestly describe a polyglot repo, and this note says so in the
 * recipe itself rather than letting the label pass for the whole truth. The
 * label is consumed by two SINGLE-CHOICE dispatches, and both take the primary
 * component's answer:
 *  - `inferBootstrapFromEcosystem` (src/verify/entrypoint.ts) — mitigated:
 *    `ensureBootstrapCommands` unions over {@link detectComponentEcosystems}
 *    instead of reading this field.
 *  - `resolveFloorEcosystem` (src/product-loop/verify-floor.ts) →
 *    `extractCoverageFromOutput` — NOT mitigated. The floor resolves one grammar
 *    per RUN and threads it into every command, so pytest-cov output from a
 *    node-primary repo parses as Istanbul and yields null: an honest
 *    "unmeasured", which blocks nothing.
 */
const POLYGLOT_LABEL_NOTE =
  "This repository has more than one stack. `ecosystem` names only the primary one, so a " +
  "coverage figure is measured for the primary stack's test output only; the other stacks' " +
  "commands still run and still gate the sprint.";

/**
 * Fold the components into the one recipe shape the pipeline consumes.
 *
 * Commands are unioned in component order so the primary stack's gates run
 * first. `ecosystem` / `appKind` / `appLabel` / `startCommand` / `smokeKind` come
 * from the PRIMARY component — no relabelling, because those fields key runtime
 * provisioning and the smoke check, and a repo whose primary stack is Node must
 * keep behaving like one.
 */
function composeRecipe(cwd: string, components: RecipeComponent[]): VerifyRecipe {
  const primary = components[0]!.recipe;
  const recipes = components.map(({ recipe }) => recipe);
  const roster = components
    .map(({ dir, recipe }) => `${recipe.appLabel} in ${dir || "the repository root"}`)
    .join("; ");
  // Each component's toolchain, from the component's OWN bootstrap when it emits
  // one (a Next.js package does) and otherwise from its ecosystem label. Without
  // this the sandbox only ever gets the primary stack's runtime — see
  // `inferBootstrapFromEcosystem`.
  const provisioning = components.map(({ dir, recipe }) =>
    recipe.bootstrapCommands.length > 0
      ? { bootstrap: recipe.bootstrapCommands, shellInit: recipe.shellInitCommands }
      : inferBootstrapFromEcosystem(recipe.ecosystem, detectPackageManagerFor(cwd, dir) ?? detectPackageManager(cwd)),
  );
  return {
    ...primary,
    shellInitCommands: dedupe([
      ...recipes.flatMap((r) => r.shellInitCommands),
      ...provisioning.flatMap((p) => p.shellInit),
    ]),
    bootstrapCommands: dedupe(provisioning.flatMap((p) => p.bootstrap)),
    installCommands: dedupe(recipes.flatMap((r) => r.installCommands)),
    buildCommands: dedupe(recipes.flatMap((r) => r.buildCommands)),
    testCommands: dedupe(recipes.flatMap((r) => r.testCommands)),
    evidence: dedupe([`Detected ${components.length} sub-projects: ${roster}`, ...recipes.flatMap((r) => r.evidence)]),
    notes: dedupe([...recipes.flatMap((r) => r.notes), POLYGLOT_LABEL_NOTE]),
  };
}

function recipeFromComponents(cwd: string, components: RecipeComponent[]): VerifyRecipe {
  if (components.length === 0) return detectFallbackRecipe(cwd);
  // A single-stack repository takes its component's recipe verbatim, so nothing
  // about a plain root-level Node / .NET / Python repo changes shape.
  return components.length === 1 ? components[0]!.recipe : composeRecipe(cwd, components);
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
    // The ONLY producer of this field in the whole pipeline, and it is a number
    // the MODEL chose to type into its recipe JSON — so it is stamped as an
    // assertion, not a measurement. `null` here means "the model said nothing",
    // which is NOT the same as zero; the distinction is enforced in
    // `src/product-loop/coverage-signal.ts`. The deterministic verify floor
    // overwrites both fields when it actually measures coverage.
    coverage: typeof raw.coverage === "number" ? raw.coverage : null,
    coverageSource: typeof raw.coverage === "number" ? "model-asserted" : null,
  };
}

/**
 * The package manager of the shallowest Node sub-package that declares a
 * lockfile, or null. Only consulted when the root declares none.
 */
function nearestSubPackageManager(cwd: string, components: RecipeComponent[]): string | null {
  for (const { dir } of components) {
    if (!dir) continue;
    const manager = detectPackageManagerFor(cwd, dir);
    if (manager) return manager;
  }
  return null;
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
  // Scanned ONCE and reused for the recipe, the package manager and the
  // ecosystem roster below — each of those used to probe the disk again.
  const components = detectRecipeComponents(cwd);
  // The ROOT lockfile first, then the nearest sub-package's. Root-only is why
  // qa-platform reported `packageManager: null` to the verify sub-agent while
  // `frontend/package-lock.json` sat one directory down.
  const packageManager = detectPackageManager(cwd) ?? nearestSubPackageManager(cwd, components);
  const recipe = recipeOverride ?? recipeFromComponents(cwd, components);
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
    componentEcosystems: dedupe(components.map(({ recipe: component }) => component.ecosystem)),
    availableScripts: Object.keys(pkg?.scripts ?? {}),
    hasNodeModules: fs.existsSync(path.join(cwd, "node_modules")),
    sandboxSettings,
    recipe: recipeWithRuntime,
  };
}

/**
 * Decides whether a deterministically-inferred recipe is trustworthy enough to
 * hand to the sprint-1 verify gate INSTEAD of a null (which trips CB-3's
 * "Recovery options" halt). It is trusted ONLY when the profiler recognized the
 * ecosystem (`appKind !== "unknown"`) AND found at least one real test command —
 * i.e. there is something concrete to verify against.
 *
 * This is the exact boundary `Orchestrator.detectVerifyRecipe` applies to its
 * `inferVerifyProjectProfile(cwd)` fallback. Exported so the gate seam is
 * covered by one unit test over the REAL predicate rather than a copy that can
 * silently drift from production.
 */
export function shouldTrustDeterministicRecipe(recipe: Pick<VerifyRecipe, "appKind" | "testCommands">): boolean {
  return recipe.appKind !== "unknown" && recipe.testCommands.length > 0;
}
