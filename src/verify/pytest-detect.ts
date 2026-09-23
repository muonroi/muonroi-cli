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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BUILD_OUTPUT_DIRS } from "../product-loop/language-registry.js";

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

/**
 * Virtualenv directory names that carry no dot, so the dot-prefix skip below
 * does not already cover them. A venv vendors thousands of installed packages
 * and their conftest.py files; collecting from one is never right.
 */
const VENV_DIR_NAMES = new Set(["venv", "env", "site-packages"]);

/**
 * How deep to look. Matches the existing bound in `findDotnetMarkers`
 * (src/verify/recipes.ts, `depth < 2`), which covers a root-level layout, a
 * one-level split like `backend/` + `frontend/`, and a two-level monorepo like
 * `packages/api/` — without walking a whole tree on every recipe inference.
 */
const MAX_DEPTH = 2;

function readIfPresent(dir: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8");
  } catch {
    // Absent or unreadable is the same answer here — "this marker does not
    // apply" — and is the expected case for most probes, so it is not an error.
    return null;
  }
}

function isDirectory(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function skipDir(name: string): boolean {
  // Dot-prefixed covers `.venv`, `.git`, `.pytest_cache`, `.tox`, `.mypy_cache`.
  return name.startsWith(".") || BUILD_OUTPUT_DIRS.has(name) || VENV_DIR_NAMES.has(name);
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

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function hasPythonManifest(dir: string): boolean {
  return PYTHON_MANIFESTS.some((m) => {
    try {
      return fs.existsSync(path.join(dir, m));
    } catch {
      return false;
    }
  });
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
 * Every directory under `root` (bounded, see {@link MAX_DEPTH}) that pytest
 * would treat as a root, shallowest first then alphabetical so the result is
 * stable across platforms and filesystems.
 *
 * Never throws: recipe inference runs on arbitrary user trees, and an
 * unreadable directory must degrade to "no target here" rather than take down
 * the whole verification recipe.
 */
export function findPytestTargets(root: string): PytestTarget[] {
  const found: Array<PytestTarget & { depth: number }> = [];

  const visit = (dir: string, depth: number): void => {
    const hit = classifyDirectory(dir);
    if (hit) {
      const pythonBin = findVenvInterpreter(dir);
      found.push({
        dir: path.relative(root, dir),
        marker: hit.marker,
        kind: hit.kind,
        pythonBin,
        pytestDeclared: detectPytestAvailability(dir, pythonBin),
        depth,
      });
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of safeReaddir(dir).sort()) {
      if (skipDir(name)) continue;
      const full = path.join(dir, name);
      if (isDirectory(full)) visit(full, depth + 1);
    }
  };

  try {
    visit(root, 0);
  } catch {
    // Defensive: `visit` already swallows per-directory failures, so reaching
    // here means the root itself was unusable. Callers get an empty list, which
    // yields `testCommands: []` — an honest "no tests found", not a crash.
    return [];
  }

  return found
    .sort((a, b) => a.depth - b.depth || a.dir.localeCompare(b.dir))
    .map(({ depth: _depth, ...target }) => target);
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
  const python = target.pythonBin ? toPosixPath(target.pythonBin) : "python";
  const run = `${python} -m pytest`;
  return target.dir ? `cd ${toPosixPath(target.dir)} && ${run}` : run;
}

/**
 * The command that makes {@link buildPytestCommand} launchable when pytest is
 * not already declared or installed. Uses `<python> -m pip` so the install
 * lands in the SAME interpreter the test command will run.
 */
export function buildPytestInstallCommand(target: PytestTarget): string {
  const python = target.pythonBin ? toPosixPath(target.pythonBin) : "python";
  const install = `${python} -m pip install pytest`;
  return target.dir ? `cd ${toPosixPath(target.dir)} && ${install}` : install;
}

/**
 * Emitted commands run in a shell, and on Windows `path.join` yields
 * backslashes that a POSIX shell reads as escapes. The recipe's own
 * installCommands are POSIX (`cd frontend && npm ci`, `.venv/bin/pip`) and the
 * sandbox is Debian, so commands are normalised to forward slashes — which
 * cmd.exe and PowerShell also accept.
 */
function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}
