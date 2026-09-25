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
   * The directory the pytest command must RUN from — pytest's rootdir when a
   * config governs this target, otherwise {@link dir}. Always {@link dir} or an
   * ancestor of it, so a command built from it never escapes the scanned root.
   *
   * This is not the same question as "where is the marker". `testpaths` is
   * honoured only when pytest is invoked FROM the rootdir, so `cd`-ing into the
   * marker directory silently discards the project's own declaration of where
   * its tests live. Measured on `D:\sources\CompanyLibs\qa-platform` (pytest
   * 9.1.1), whose root `pytest.ini` declares `testpaths = specs` while the
   * marker is `backend/conftest.py` — same interpreter, same configfile, same
   * tree, through the floor's own `spawn(shell: true)`:
   *
   *   cd backend && ".venv/Scripts/python.exe" -m pytest   → exit 5, collected 0
   *   "backend/.venv/Scripts/python.exe"      -m pytest    → exit 0, collected 12
   *
   * The `testpaths: specs` header line appears only in the second run, because
   * `_pytest/config/__init__.py::_decide_args` reaches its TESTPATHS branch only
   * `if invocation_dir == rootpath` and otherwise falls back to collecting from
   * the invocation directory — which the root config's `norecursedirs` then
   * prunes to nothing. Exit 5 is `EXIT_NOTESTSCOLLECTED`, so the floor failed a
   * suite that passes.
   */
  runDir: string;
  /**
   * The config file that put the rootdir at {@link runDir}, relative to that
   * directory, or null when no config governs this target — in which case
   * nothing can declare `testpaths` either and the marker directory is right.
   */
  rootdirConfig: string | null;
  /**
   * A venv interpreter that EXISTS on disk, relative to `dir`, or null for the
   * ambient one. Read off disk rather than assumed: the real qa-platform
   * `backend/.venv` is a Windows venv (`Scripts/python.exe`) even though the
   * recipe's own install line says `.venv/bin/pip`, so a hardcoded layout would
   * name a file that is not there.
   */
  pythonBin: string | null;
  /**
   * The same interpreter spelled from {@link runDir} instead of {@link dir} —
   * what the TEST command needs, since that command no longer runs in the marker
   * directory. Null whenever {@link pythonBin} is.
   *
   * Kept as its own field rather than derived at build time because {@link
   * pythonBin} is what the INSTALL commands need: they run in {@link dir}, where
   * the manifest and the venv actually are. Both spellings are relative and
   * contain no `..` — {@link runDir} is {@link dir} or an ancestor — so the
   * emitted commands stay transplantable into the Debian verify sandbox.
   */
  runDirPythonBin: string | null;
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
 * The pytest config file in `dir`, or null — the ONE derivation of "is there a
 * rootdir declaration here", used both to classify a marker and to locate the
 * rootdir a command must run from.
 *
 * Name order matches `_pytest/config/findpaths.py::locate_config`, which probes
 * `pytest.toml`, `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `pyproject.toml`,
 * `tox.ini`, `setup.cfg` in that order, and the section requirement is the same
 * one {@link SECTIONED_CONFIG_FILES} already encodes: a `pyproject.toml` with
 * only `[project]` declares no rootdir.
 */
function findPytestConfigFile(dir: string): string | null {
  for (const file of UNCONDITIONAL_CONFIG_FILES) {
    if (readIfPresent(dir, file) !== null) return file;
  }
  for (const { file, section } of SECTIONED_CONFIG_FILES) {
    const body = readIfPresent(dir, file);
    if (body !== null && section.test(body)) return file;
  }
  return null;
}

/**
 * Where pytest would put its rootdir for a target in `markerDir`, or null when
 * no config governs it.
 *
 * `locate_config` walks `(argpath, *argpath.parents)` — the invocation directory
 * then every parent — and takes the FIRST directory holding a config, so a
 * nearer config shadows an outer one. Measured in a temp tree where the config
 * directory is neither the marker directory nor the tree root: invoked from
 * `cfgdir/backend`, pytest reported `rootdir: …/cfgdir`, i.e. the config's own
 * directory, and collected 0; invoked from `cfgdir`, the same tree reported
 * `testpaths: specs` and collected 1.
 *
 * The walk stops AT `root`. pytest itself would keep going to the filesystem
 * root, but a command is emitted as a path relative to `root` and `cd`-ing above
 * it would take the floor outside the workspace it is verifying. A config above
 * the scanned root therefore degrades to "no config here", which is exactly
 * today's behaviour and no worse.
 */
function findRootdir(root: string, markerDir: string): { abs: string; config: string } | null {
  let current = markerDir;
  for (;;) {
    const config = findPytestConfigFile(current);
    if (config) return { abs: current, config };
    if (current === root) return null;
    const parent = path.dirname(current);
    // Defensive: a `markerDir` outside `root` would never hit `current === root`,
    // so stop at the filesystem root rather than looping forever.
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The strongest pytest marker in `dir`, or null when it is not a pytest root.
 *
 * `config` markers stand alone — they ARE a rootdir declaration. `conftest` and
 * `test-dir` additionally require a Python manifest, so an incidental folder
 * with a `tests/` subdirectory is not mistaken for a project.
 */
function classifyDirectory(dir: string): { marker: string; kind: PytestMarkerKind } | null {
  const config = findPytestConfigFile(dir);
  if (config) return { marker: config, kind: "config" };

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
    const rootdir = findRootdir(root, dir);
    return {
      marker: hit.marker,
      kind: hit.kind,
      // Resolved from the ABSOLUTE paths that are still in hand here, so neither
      // the run directory nor the interpreter path below depends on the process
      // cwd at the time a command is built.
      rootDir: rootdir ? path.relative(root, rootdir.abs) : null,
      rootdirConfig: rootdir?.config ?? null,
      pythonBin,
      runDirPythonBin: pythonBin ? path.relative(rootdir?.abs ?? dir, path.join(dir, pythonBin)) : null,
      pytestDeclared: detectPytestAvailability(dir, pythonBin),
      depsInstall: pythonDepsInstallVerb(dir),
    };
  }).map(({ dir, value }) => {
    const { rootDir, ...rest } = value;
    return { dir, runDir: rootDir ?? dir, ...rest };
  });
}

/**
 * One GATE target per rootdir — which of several targets sharing a `runDir`
 * should actually contribute a pytest command.
 *
 * Every target sharing a `runDir` runs pytest from the SAME directory and so
 * collects the SAME tests; emitting all of them runs one suite N times. Which
 * one survives is not cosmetic, because it decides which INTERPRETER the gate
 * runs under.
 *
 * A target bound to a venv wins. The venv is the environment the project itself
 * declares and provisions, read off disk; the ambient `python` is whatever the
 * host happens to have. Measured on qa-platform: two targets (root `pytest.ini`,
 * ambient; `backend/conftest.py`, `backend/.venv`) both resolve to `runDir: ""`,
 * and `backend/.venv` has pytest plus the FastAPI/SQLAlchemy dependencies
 * installed while a clean checkout's ambient interpreter has neither. The ambient
 * command therefore fails for a reason that has nothing to do with the code under
 * test — a false FAIL, which is the exact failure mode this gate exists to
 * prevent, so it must not be emitted alongside a venv-bound alternative.
 *
 * When several share a `runDir` and NONE has a venv, every candidate builds the
 * BYTE-IDENTICAL command — same ambient `python`, same directory — so the
 * collapse is a pure dedupe and the survivor only decides which marker the
 * evidence cites. The first in {@link findPytestTargets}' existing
 * shallowest-then-alphabetical order wins, which keeps the choice stable across
 * platforms and filesystems instead of following readdir order.
 *
 * Only the GATE collapses. Every target keeps its dependency install
 * ({@link buildPythonDepsInstallCommand}), because the surviving run happens from
 * the rootdir and can collect tests importing from any of the collapsed
 * sub-projects — dropping those would trade a false FAIL for a missing
 * dependency.
 */
export function selectPytestGateTargets(targets: PytestTarget[]): PytestTarget[] {
  const byRunDir = new Map<string, PytestTarget>();
  for (const target of targets) {
    const incumbent = byRunDir.get(target.runDir);
    // Insertion order is the caller's stable order, so an unbeaten incumbent also
    // fixes the output order.
    if (!incumbent) {
      byRunDir.set(target.runDir, target);
      continue;
    }
    if (!incumbent.pythonBin && target.pythonBin) byRunDir.set(target.runDir, target);
  }
  return [...byRunDir.values()];
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
 *
 * The directory is {@link PytestTarget.runDir} — pytest's rootdir — NOT the
 * marker directory, because `testpaths` applies only when pytest is invoked from
 * the rootdir. See {@link PytestTarget.runDir} for the 0-vs-12 measurement. The
 * two are the same directory whenever no config sits above the marker, so a bare
 * `conftest.py` project is unaffected.
 *
 * `-m` still adds the CURRENT directory to `sys.path`, and that current directory
 * is now the rootdir. That is the project's own choice, not a regression: on
 * qa-platform the tests `testpaths` selects carry their own `conftest.py` that
 * puts `backend/` on `sys.path`, and all 12 pass from the root. A project whose
 * imports only resolve from the marker directory declares that by keeping its
 * config there, which keeps `runDir` on the marker directory.
 */
export function buildPytestCommand(target: PytestTarget): string {
  return commandIn(target.runDir, `${quoteInterpreter(target.runDirPythonBin)} -m pytest`);
}

/**
 * The command that makes {@link buildPytestCommand} launchable when pytest is
 * not already declared or installed. Uses `<python> -m pip` so the install
 * lands in the SAME interpreter the test command will run.
 *
 * Runs in the MARKER directory, not {@link PytestTarget.runDir}: the venv being
 * installed into is the marker directory's own. Only the test command moves up to
 * the rootdir, and only because `testpaths` is resolved there.
 */
export function buildPytestInstallCommand(target: PytestTarget): string {
  return commandIn(target.dir, `${quoteInterpreter(target.pythonBin)} -m pip install pytest`);
}

/**
 * Install this target's own declared dependencies, in its own interpreter, from
 * its own directory — the MARKER directory, where the manifest actually is, not
 * {@link PytestTarget.runDir} — or null when it declares none.
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
