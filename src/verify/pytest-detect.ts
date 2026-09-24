/**
 * Where does pytest actually live in this repository?
 *
 * `detectPythonRecipe` used to answer that with `fileExists(cwd, "tests")` — one
 * directory name, at the repo root only (src/verify/recipes.ts:323 and :340 at
 * 9c156e01). Every project that keeps its tests under a sub-project, or marks
 * them the way pytest itself documents, was reported as having no tests at all,
 * and the engineering floor then failed the sprint with `no_test_commands`. Run
 * `muc2joffe506` on qa-platform burned $1.405 across two sprints that way.
 *
 * Two independent assumptions are dropped here:
 *
 *   1. ONE MARKER → the set pytest documents. `pytest.toml`/`.pytest.toml` and
 *      `pytest.ini`/`.pytest.ini` always mark a rootdir; `pyproject.toml`,
 *      `tox.ini` and `setup.cfg` mark one only when they carry pytest's own
 *      section. Source: docs.pytest.org/en/stable/reference/customize.html,
 *      "Finding the rootdir" + "Configuration file formats". `conftest.py` is
 *      added as pytest's per-directory collection/plugin file, and
 *      `tests`/`test` is kept as the naming convention it always was.
 *
 *   2. THE REPO ROOT → a bounded walk. A polyglot repo keeps each stack in a
 *      sub-directory and the recipe already knows it: qa-platform's own
 *      installCommands say `cd frontend && npm ci` and `cd <abs>/backend &&
 *      python3 -m venv .venv`. Commands emitted from these targets use the same
 *      `cd <dir> && …` shape.
 *
 * The walk itself lives in `./workspace-scan.js` — shared with every other
 * detector so they cannot disagree about how deep to look or what to skip.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  commandIn,
  fileExistsIn,
  findMarkedDirectories,
  isDirectory,
  safeReaddir,
  toPosixPath,
} from "./workspace-scan.js";

/**
 * How strongly a directory is proven to be a pytest root.
 *
 * `config` is a literal rootdir declaration and `conftest` is pytest's own
 * collection file — both are unambiguous pytest evidence. `test-dir` is only a
 * naming convention, so it does not prove pytest over stdlib `unittest`;
 * callers that must choose a runner read this field rather than guessing.
 */
export type PytestMarkerKind = "config" | "conftest" | "test-dir";

export interface PytestTarget {
  /** Directory holding the marker, relative to the scanned root ("" = root). */
  dir: string;
  /** The file or directory that proved it, for `evidence`. */
  marker: string;
  kind: PytestMarkerKind;
  /**
   * A venv interpreter that EXISTS on disk, relative to `dir`, or null for the
   * ambient one. Read off disk rather than assumed: the real qa-platform
   * `backend/.venv` is a Windows venv (`Scripts/python.exe`) even though the
   * recipe's own install line says `.venv/bin/pip`, so a hardcoded layout would
   * name a file that is not there.
   */
  pythonBin: string | null;
  /**
   * Is pytest provably obtainable — declared in a manifest in this directory,
   * or already installed in the detected venv? False means a pytest command
   * cannot be assumed to launch, which callers must resolve (install it, and
   * say so) rather than ignore.
   */
  pytestDeclared: boolean;
  /**
   * The `pip` verb that installs THIS directory's declared dependencies, or
   * null when it declares none. See {@link buildPythonDepsInstallCommand}.
   */
  depsInstall: string | null;
}

/** Config files that mark a rootdir unconditionally, highest precedence first. */
const UNCONDITIONAL_CONFIG_FILES = ["pytest.toml", ".pytest.toml", "pytest.ini", ".pytest.ini"] as const;

/** Config files that mark a rootdir only when they carry pytest's section. */
const SECTIONED_CONFIG_FILES: ReadonlyArray<{ file: string; section: RegExp }> = [
  // `[tool.pytest.ini_options]` is the documented table; `[tool.pytest]` also matches.
  { file: "pyproject.toml", section: /^\s*\[tool\.pytest(?:\.ini_options)?\]/m },
  { file: "tox.ini", section: /^\s*\[pytest\]/m },
  { file: "setup.cfg", section: /^\s*\[tool:pytest\]/m },
];

/** Directory names that are a test tree by convention alone. */
const TEST_DIR_NAMES = ["tests", "test"] as const;

/**
 * Files that prove a directory is a Python PROJECT root rather than an
 * incidental folder that happens to contain a `tests` directory. Required for
 * the weak `test-dir` marker, which would otherwise make a target of
 * `specs/040-sprint1-artifact-store/` — a real qa-platform directory holding
 * only `MIGRATION.md` and `tests/`.
 */
const PYTHON_MANIFESTS = ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile"] as const;

function readIfPresent(dir: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8");
  } catch {
    // Absent or unreadable is the same answer here — "this marker does not
    // apply" — and is the expected case for most probes, so it is not an error.
    return null;
  }
}

/** Candidate venv interpreters, in the order a layout is probed on disk. */
const VENV_INTERPRETERS: ReadonlyArray<readonly string[]> = [
  [".venv", "bin", "python"],
  [".venv", "Scripts", "python.exe"],
  ["venv", "bin", "python"],
  ["venv", "Scripts", "python.exe"],
];

function findVenvInterpreter(dir: string): string | null {
  for (const parts of VENV_INTERPRETERS) {
    const rel = path.join(...parts);
    try {
      if (fs.existsSync(path.join(dir, rel))) return rel;
    } catch {
      // An unreadable candidate is not a match; keep probing the rest.
    }
  }
  return null;
}

/** Is pytest declared in a manifest here, or already installed in the venv? */
function detectPytestAvailability(dir: string, pythonBin: string | null): boolean {
  for (const manifest of PYTHON_MANIFESTS) {
    const body = readIfPresent(dir, manifest);
    if (body && /(?:^|[\s"'[=,])pytest\b/im.test(body)) return true;
  }
  if (pythonBin) {
    // `<venv>/lib/python3.x/site-packages/pytest` (POSIX) or
    // `<venv>/Lib/site-packages/pytest` (Windows).
    const venvRoot = path.join(dir, pythonBin.split(path.sep)[0]);
    for (const libDir of ["Lib", "lib"]) {
      const base = path.join(venvRoot, libDir);
      if (!isDirectory(base)) continue;
      const candidates = [base, ...safeReaddir(base).map((n) => path.join(base, n))];
      for (const candidate of candidates) {
        if (isDirectory(path.join(candidate, "site-packages", "pytest"))) return true;
      }
    }
  }
  return false;
}

function hasPythonManifest(dir: string): boolean {
  return PYTHON_MANIFESTS.some((m) => fileExistsIn(dir, m));
}

/**
 * The strongest pytest marker in `dir`, or null when it is not a pytest root.
 *
 * `config` markers stand alone — they ARE a rootdir declaration. `conftest` and
 * `test-dir` additionally require a Python manifest, so an incidental folder
 * with a `tests/` subdirectory is not mistaken for a project.
 */
function classifyDirectory(dir: string): { marker: string; kind: PytestMarkerKind } | null {
  for (const file of UNCONDITIONAL_CONFIG_FILES) {
    if (readIfPresent(dir, file) !== null) return { marker: file, kind: "config" };
  }
  for (const { file, section } of SECTIONED_CONFIG_FILES) {
    const body = readIfPresent(dir, file);
    if (body !== null && section.test(body)) return { marker: file, kind: "config" };
  }

  const manifest = hasPythonManifest(dir);
  if (!manifest) return null;

  if (fs.existsSync(path.join(dir, "conftest.py"))) return { marker: "conftest.py", kind: "conftest" };
  for (const name of TEST_DIR_NAMES) {
    if (isDirectory(path.join(dir, name))) return { marker: `${name}/`, kind: "test-dir" };
  }
  return null;
}

/**
 * Every directory under `root` that pytest would treat as a root, shallowest
 * first then alphabetical so the result is stable across platforms and
 * filesystems. Depth bound and skip list come from `./workspace-scan.js`.
 *
 * Never throws: recipe inference runs on arbitrary user trees, and an
 * unreadable directory must degrade to "no target here" rather than take down
 * the whole verification recipe.
 */
export function findPytestTargets(root: string): PytestTarget[] {
  return findMarkedDirectories(root, (dir) => {
    const hit = classifyDirectory(dir);
    if (!hit) return null;
    const pythonBin = findVenvInterpreter(dir);
    return {
      marker: hit.marker,
      kind: hit.kind,
      pythonBin,
      pytestDeclared: detectPytestAvailability(dir, pythonBin),
      depsInstall: pythonDepsInstallVerb(dir),
    };
  }).map(({ dir, value }) => ({ dir, ...value }));
}

/**
 * How this directory's own Python dependencies are installed, or null when it
 * declares none.
 *
 * Needed because a sub-project's manifest is NOT reachable from the repository
 * root: qa-platform's only `requirements.txt` is `backend/requirements.txt`, so
 * the root-relative `pip install -r requirements.txt` the recipe used to emit
 * names a file that does not exist, while the FastAPI/SQLAlchemy imports
 * `backend/conftest.py` triggers need it installed or every test errors on
 * collection.
 */
function pythonDepsInstallVerb(dir: string): string | null {
  if (fileExistsIn(dir, "requirements.txt")) return "-m pip install -r requirements.txt";
  if (fileExistsIn(dir, "pyproject.toml") || fileExistsIn(dir, "setup.py")) return "-m pip install -e .";
  return null;
}

/**
 * The pytest invocation for a target, as a command the floor can run verbatim.
 *
 * `<python> -m pytest` rather than a bare `pytest`: the module form is
 * documented to add the current directory to `sys.path`
 * (docs.pytest.org/en/stable/explanation/pythonpath.html), which is exactly
 * what a project whose code sits at the package root with no installed
 * distribution needs — qa-platform's `backend/conftest.py` exists solely to
 * patch `sys.path` for that reason. A bare `pytest` console script also only
 * exists if the environment installed one, while the interpreter always does.
 *
 * Prefixed with `cd <dir> &&` for a sub-project, the same shape the recipe's
 * own installCommands already use.
 */
export function buildPytestCommand(target: PytestTarget): string {
  return commandIn(target.dir, `${quoteInterpreter(target.pythonBin)} -m pytest`);
}

/**
 * The command that makes {@link buildPytestCommand} launchable when pytest is
 * not already declared or installed. Uses `<python> -m pip` so the install
 * lands in the SAME interpreter the test command will run.
 */
export function buildPytestInstallCommand(target: PytestTarget): string {
  return commandIn(target.dir, `${quoteInterpreter(target.pythonBin)} -m pip install pytest`);
}

/**
 * Install this target's own declared dependencies, in its own interpreter, from
 * its own directory — or null when it declares none.
 *
 * Only emitted for a SUB-directory target: a root target's manifest is already
 * covered by the recipe's root-level install line, and emitting both would run
 * the same install twice.
 */
export function buildPythonDepsInstallCommand(target: PytestTarget): string | null {
  if (!target.dir || !target.depsInstall) return null;
  return commandIn(target.dir, `${quoteInterpreter(target.pythonBin)} ${target.depsInstall}`);
}

/**
 * A relative interpreter path must be QUOTED, or cmd.exe never launches it.
 *
 * Measured through the floor's own `spawn(command, {shell: true})` on Windows:
 *
 *   cd backend && .venv/Scripts/python.exe --version
 *     → '.venv' is not recognized as an internal or external command   exit 1
 *   cd backend && ".venv/Scripts/python.exe" --version
 *     → Python 3.14.5                                                  exit 0
 *
 * cmd.exe splits the unquoted token at the first `/` and reads `/Scripts` as a
 * flag. Quoting fixes it and is portable — POSIX `sh` treats the quotes the same
 * way — so forward slashes are kept for the Debian sandbox's benefit.
 * `./.venv/...` does NOT work (measured: `'.' is not recognized`).
 *
 * The bare ambient `python` is left unquoted: it is a PATH lookup, not a path.
 */
function quoteInterpreter(pythonBin: string | null): string {
  return pythonBin ? `"${toPosixPath(pythonBin)}"` : "python";
}
