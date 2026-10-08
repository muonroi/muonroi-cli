/**
 * Pytest detection for projects that do NOT keep their tests in a root `tests/`.
 *
 * Why this exists — run `muc2joffe506` on `D:\sources\CompanyLibs\qa-platform`,
 * both sprints, $1.405 for zero progress:
 *
 *   {"sprintN":1,"pass":false,"score":0,"verify":"UNKNOWN",
 *    "failedCondition":"engineering_floor","reason":"no_test_commands",...}
 *   {"sprintN":2, ... same, "verify":"ERROR"}
 *
 * The project HAS a pytest setup (`backend/conftest.py`). Detection missed it
 * twice over:
 *
 * 1. `inferFallbackRecipe` short-circuits on a root `package.json`
 *    (`if (pkg) return detectNodeRecipe(...)`), so on this repo — whose root
 *    package.json declares only a `verify` script — the Python detector was
 *    never reached at all. Measured against the real repo before the fix:
 *      {"ecosystem":"node","testCommands":[],"buildCommands":[]}
 * 2. Even when reached, `detectPythonRecipe` keyed tests on
 *    `fileExists(cwd, "tests")` — one directory name, at the repo root only.
 *
 * The marker set below is pytest's own, from
 * docs.pytest.org/en/stable/reference/customize.html ("Finding the rootdir" +
 * "Configuration file formats"), not invented here.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPytestCommand,
  buildPytestInstallCommand,
  buildPythonDepsInstallCommand,
  findPytestTargets,
} from "../pytest-detect.js";
import { inferVerifyProjectProfile } from "../recipes.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(cwd: string, rel: string, body = ""): void {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * The REAL `qa-platform` layout, copied from disk rather than tidied up.
 *
 * Verified against `D:\sources\CompanyLibs\qa-platform` (read-only):
 *   - root `package.json` with ONE script, `verify`
 *   - `frontend/package.json` scripts: dev, build, start, lint — no `test`
 *   - `backend/conftest.py` + `backend/requirements.txt` (pytest NOT listed)
 *   - NO `tests/` directory at the repo root
 *   - `specs/040-sprint1-artifact-store/tests/conftest.py` — a decoy: it holds
 *     the only real test file but carries no Python manifest of its own
 */
function realQaPlatformLayout(cwd: string): void {
  write(
    cwd,
    "package.json",
    JSON.stringify({ name: "qa-platform", private: true, scripts: { verify: "cd frontend && npx tsc --noEmit" } }),
  );
  write(
    cwd,
    "frontend/package.json",
    JSON.stringify({
      name: "frontend",
      scripts: { dev: "next dev", build: "next build", start: "next start", lint: "eslint" },
    }),
  );
  write(cwd, "backend/conftest.py", "import sys\nfrom pathlib import Path\n");
  write(cwd, "backend/requirements.txt", "fastapi==0.115.0\nuvicorn[standard]==0.30.6\n");
  write(cwd, "backend/main.py", "app = 1\n");
  write(cwd, "specs/040-sprint1-artifact-store/tests/conftest.py", "");
  write(cwd, "specs/040-sprint1-artifact-store/tests/test_artifact_store_smoke.py", "def test_x(): pass\n");
}

/**
 * qa-platform's OTHER shape: a root `pytest.ini` whose `testpaths` points at a
 * directory OUTSIDE the marker directory.
 *
 * Copied from `D:\sources\CompanyLibs\qa-platform/pytest.ini` (read-only):
 *   testpaths = specs          — the real tests live under `specs/<slice>/tests`
 *   norecursedirs = app …      — backend/app holds PRODUCTION code named
 *                                test_case.py, so collecting from backend/
 *                                yields nothing at all
 * plus `backend/conftest.py` + `backend/requirements.txt` as the marker.
 */
function qaPlatformTestpathsLayout(cwd: string): void {
  write(cwd, "pytest.ini", "[pytest]\ntestpaths = specs\nnorecursedirs = app alembic node_modules .venv\n");
  write(cwd, "backend/conftest.py", "import sys\n");
  write(cwd, "backend/requirements.txt", "fastapi==0.115.0\npytest\n");
  // Production code whose filenames match pytest's `test_*.py` glob — the reason
  // the real project excludes `app` and the reason collecting from `backend/`
  // finds zero tests rather than a few.
  write(cwd, "backend/app/test_case.py", "class TestCase:\n    pass\n");
  write(cwd, "specs/040-artifact-store/tests/test_artifact_store_smoke.py", "def test_save(): assert True\n");
}

/**
 * Can the ambient `python` import pytest? Gates the one test that EXECUTES the
 * emitted command.
 *
 * Resolved once, at module scope, so the gate can be an `it.skipIf` — a reported
 * SKIP when no interpreter is available, rather than a test body that returns
 * early and reports a green it did not earn.
 */
const HAS_AMBIENT_PYTEST = spawnSync("python", ["-c", "import pytest"], { encoding: "utf8" }).status === 0;

describe("findPytestTargets — pytest's own marker set", () => {
  it("finds a sub-project by conftest.py — the qa-platform backend case", () => {
    const cwd = makeTempDir("muonroi-pytest-conftest-");
    realQaPlatformLayout(cwd);

    const targets = findPytestTargets(cwd);

    expect(targets.map((t) => t.dir)).toContain("backend");
    expect(targets.find((t) => t.dir === "backend")?.marker).toContain("conftest.py");
  });

  it.each([
    ["pytest.ini", "[pytest]\nminversion = 6.0\n"],
    [".pytest.ini", "[pytest]\n"],
    ["pytest.toml", "[pytest]\n"],
    [".pytest.toml", "[pytest]\n"],
  ])("treats %s as an unconditional rootdir marker", (file, body) => {
    const cwd = makeTempDir("muonroi-pytest-cfg-");
    write(cwd, file, body);

    const targets = findPytestTargets(cwd);

    expect(targets).toHaveLength(1);
    expect(targets[0].dir).toBe("");
    expect(targets[0].marker).toBe(file);
  });

  it.each([
    ["pyproject.toml", "[tool.pytest.ini_options]\nminversion = '6.0'\n"],
    ["pyproject.toml", "[tool.pytest]\n"],
    ["tox.ini", "[pytest]\naddopts = -ra\n"],
    ["setup.cfg", "[tool:pytest]\naddopts = -ra\n"],
  ])("treats %s as a marker ONLY when it carries pytest's section", (file, body) => {
    const cwd = makeTempDir("muonroi-pytest-section-");
    write(cwd, file, body);

    expect(findPytestTargets(cwd).map((t) => t.dir)).toContain("");
  });

  it("does NOT treat a pyproject.toml without a pytest section as a pytest project", () => {
    const cwd = makeTempDir("muonroi-pytest-nosection-");
    write(cwd, "pyproject.toml", "[project]\nname = 'x'\n[tool.ruff]\nline-length = 100\n");

    expect(findPytestTargets(cwd)).toEqual([]);
  });

  it("does NOT treat a tox.ini without a [pytest] section as a pytest project", () => {
    const cwd = makeTempDir("muonroi-pytest-tox-");
    write(cwd, "tox.ini", "[tox]\nenvlist = py311\n");

    expect(findPytestTargets(cwd)).toEqual([]);
  });

  it("rejects a tests/ directory that carries no Python manifest — the specs/ decoy", () => {
    // Copied from the real repo: specs/040-sprint1-artifact-store/ holds only
    // MIGRATION.md and tests/. Treating every `tests` dir as a project root
    // would make this a verification target and run pytest in a docs folder.
    const cwd = makeTempDir("muonroi-pytest-decoy-");
    write(cwd, "specs/040-sprint1-artifact-store/MIGRATION.md", "# notes\n");
    write(cwd, "specs/040-sprint1-artifact-store/tests/test_smoke.py", "def test_x(): pass\n");

    expect(findPytestTargets(cwd).map((t) => t.dir)).not.toContain(path.join("specs", "040-sprint1-artifact-store"));
  });

  it("accepts a tests/ directory when a Python manifest proves a project root", () => {
    const cwd = makeTempDir("muonroi-pytest-testdir-");
    write(cwd, "requirements.txt", "flask\n");
    write(cwd, "tests/test_a.py", "def test_a(): pass\n");

    expect(findPytestTargets(cwd).map((t) => t.dir)).toContain("");
  });

  it("does not descend into node_modules, build output or a venv", () => {
    const cwd = makeTempDir("muonroi-pytest-skip-");
    for (const dir of ["node_modules", "dist", "build", "__pycache__", ".venv", "venv"]) {
      write(cwd, `${dir}/pkg/conftest.py`, "");
      write(cwd, `${dir}/pkg/requirements.txt`, "");
    }

    expect(findPytestTargets(cwd)).toEqual([]);
  });

  it("picks the venv interpreter that is actually on disk — POSIX layout", () => {
    const cwd = makeTempDir("muonroi-pytest-venv-posix-");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "");
    write(cwd, "backend/.venv/bin/python", "");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    expect(target?.pythonBin).toBe(path.join(".venv", "bin", "python"));
  });

  it("picks the venv interpreter that is actually on disk — Windows layout", () => {
    // The real qa-platform backend/.venv is a WINDOWS venv (Scripts/, Lib/,
    // pyvenv.cfg) even though the recipe's own install line says
    // `.venv/bin/pip`. A hardcoded bin/ path would name a file that is not
    // there, so the layout is read off disk instead.
    const cwd = makeTempDir("muonroi-pytest-venv-win-");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "");
    write(cwd, "backend/.venv/Scripts/python.exe", "");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    expect(target?.pythonBin).toBe(path.join(".venv", "Scripts", "python.exe"));
  });

  it("QUOTES the interpreter so cmd.exe does not read it as flags", () => {
    // Measured through the floor's real spawn(shell:true) on Windows: an
    // UNQUOTED relative path with forward slashes does not launch at all —
    //   cd backend && .venv/Scripts/python.exe --version
    //   → '.venv' is not recognized as an internal or external command   exit 1
    // Quoted, the same path runs (exit 0, "Python 3.14.5"), and quoting is
    // portable to POSIX sh. A gate command that cannot start is exactly the
    // failure this detector exists to avoid.
    const cwd = makeTempDir("muonroi-pytest-quote-");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "");
    write(cwd, "backend/.venv/Scripts/python.exe", "");

    const cmd = inferVerifyProjectProfile(cwd).recipe.testCommands.find((c) => c.includes("pytest"));

    expect(cmd).toBe('cd backend && ".venv/Scripts/python.exe" -m pytest');
  });

  it("falls back to the ambient interpreter when no venv exists", () => {
    const cwd = makeTempDir("muonroi-pytest-novenv-");
    write(cwd, "pytest.ini", "[pytest]\n");

    expect(findPytestTargets(cwd)[0].pythonBin).toBeNull();
  });

  it("reports whether pytest is a declared dependency", () => {
    const declared = makeTempDir("muonroi-pytest-declared-");
    write(declared, "requirements.txt", "fastapi\npytest==8.0.0\n");
    write(declared, "tests/test_a.py", "");
    expect(findPytestTargets(declared)[0].pytestDeclared).toBe(true);

    // The real backend/requirements.txt does NOT list pytest.
    const undeclared = makeTempDir("muonroi-pytest-undeclared-");
    write(undeclared, "requirements.txt", "fastapi==0.115.0\nuvicorn[standard]==0.30.6\n");
    write(undeclared, "tests/test_a.py", "");
    expect(findPytestTargets(undeclared)[0].pytestDeclared).toBe(false);
  });
});

describe("recipe testCommands — the run muc2joffe506 regression", () => {
  it("ACCEPTANCE: the real qa-platform layout yields a test command targeting the backend", () => {
    const cwd = makeTempDir("muonroi-qa-platform-real-");
    realQaPlatformLayout(cwd);

    const recipe = inferVerifyProjectProfile(cwd).recipe;

    // Before the fix this was [] — `reason: "no_test_commands"`, score 0.
    expect(recipe.testCommands.length).toBeGreaterThan(0);
    const pytestCmd = recipe.testCommands.find((c) => c.includes("pytest"));
    expect(pytestCmd).toBeDefined();
    // Runs where the ecosystem lives, the same shape installCommands use.
    expect(pytestCmd).toContain("cd backend");
    // `-m` form: documented to add the current directory to sys.path, which is
    // the whole reason backend/conftest.py exists in the real project.
    expect(pytestCmd).toContain("-m pytest");
  });

  it("ACCEPTANCE: the acceptance tree (no ROOT package.json) also targets the backend", () => {
    // Same real structure minus the root package.json, so the Python detector
    // is entered directly rather than through the polyglot augmentation.
    const cwd = makeTempDir("muonroi-qa-platform-nopkg-");
    write(cwd, "frontend/package.json", JSON.stringify({ scripts: { dev: "next dev", build: "next build" } }));
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "fastapi==0.115.0\n");

    const recipe = inferVerifyProjectProfile(cwd).recipe;

    const pytestCmd = recipe.testCommands.find((c) => c.includes("pytest"));
    expect(pytestCmd).toBeDefined();
    expect(pytestCmd).toContain("cd backend");
  });

  it("keeps a genuine absence empty so the floor still fails — no papering over", () => {
    // A Python project with a manifest and NO test markers anywhere. This must
    // stay [] so the done-gate reports `no_test_commands`, which is the floor
    // doing its job. `python -m unittest discover` is NOT an acceptable filler:
    // measured on this machine (Python 3.14.5) it exits 5 / "NO TESTS RAN",
    // which would turn an honest absence into a `verify_FAIL`.
    const cwd = makeTempDir("muonroi-pytest-absent-");
    write(cwd, "requirements.txt", "fastapi==0.115.0\nuvicorn==0.30.6\n");
    write(cwd, "main.py", "app = 1\n");

    const recipe = inferVerifyProjectProfile(cwd).recipe;

    expect(findPytestTargets(cwd)).toEqual([]);
    expect(recipe.testCommands).toEqual([]);
  });

  it("keeps a genuine absence empty for a plain Node project too", () => {
    const cwd = makeTempDir("muonroi-node-absent-");
    write(cwd, "package.json", JSON.stringify({ name: "x", scripts: { build: "tsc" } }));

    expect(inferVerifyProjectProfile(cwd).recipe.testCommands).toEqual([]);
  });

  it("ACCEPTANCE: a root config's testpaths is not defeated by cd-ing into the marker directory", () => {
    // Measured on the REAL D:\sources\CompanyLibs\qa-platform (pytest 9.1.1),
    // through the floor's own spawn(shell:true), same interpreter both times:
    //
    //   cd backend && ".venv/Scripts/python.exe" -m pytest   → exit 5, collected 0
    //   "backend/.venv/Scripts/python.exe"      -m pytest    → exit 0, collected 12
    //
    // The `testpaths: specs` header line appears ONLY in the second run, because
    // pytest consults testpaths only when invocation_dir == rootpath
    // (_pytest/config/__init__.py `_decide_args`). The root pytest.ini puts the
    // rootdir at the repo root, so the `cd backend` defeated the project's own
    // declaration of where its tests are, and exit 5 failed the gate.
    const cwd = makeTempDir("muonroi-pytest-testpaths-");
    qaPlatformTestpathsLayout(cwd);
    write(cwd, "backend/.venv/Scripts/python.exe", "");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    // Runs from the rootdir (here the repo root, so no `cd` at all), and the
    // interpreter is re-spelled from there — still quoted, because an unquoted
    // multi-segment path is split by cmd.exe at the first `/` exactly as the
    // single-segment one was: measured on the real repo,
    //   backend/.venv/Scripts/python.exe -m pytest
    //   → 'backend' is not recognized as an internal or external command, exit 1
    expect(buildPytestCommand(target!)).toBe('"backend/.venv/Scripts/python.exe" -m pytest');
    expect(target!.runDir).toBe("");
  });

  it.skipIf(!HAS_AMBIENT_PYTEST)(
    "ACCEPTANCE: the emitted command actually collects the testpaths tests (executed)",
    () => {
      // No venv in the fixture, so the emitted interpreter is the ambient `python`
      // and the command is really runnable here. This is the same rootdir/testpaths
      // mechanism as the venv case, executed rather than asserted:
      //   before → `cd backend && python -m pytest`  exit 5, "no tests ran"
      //   after  → `python -m pytest`                exit 0, "1 passed"
      const cwd = makeTempDir("muonroi-pytest-exec-");
      qaPlatformTestpathsLayout(cwd);

      const target = findPytestTargets(cwd).find((t) => t.dir === "backend");
      const command = buildPytestCommand(target!);
      expect(command).toBe("python -m pytest");

      const run = spawnSync(command, { cwd, shell: true, encoding: "utf8" });

      expect(run.stdout).toContain("testpaths: specs");
      expect(run.stdout).toMatch(/1 passed/);
      expect(run.status).toBe(0);
    },
  );

  it("keeps the INSTALL commands in the marker directory when the test command moves up", () => {
    // `requirements.txt` lives in the marker directory, not the rootdir, and the
    // venv it installs into is `backend/.venv`. Moving these up alongside the
    // test command would name a file that is not there — the failure
    // src/verify/recipes.ts:488-493 already documents for the root-relative
    // install line.
    const cwd = makeTempDir("muonroi-pytest-installdir-");
    qaPlatformTestpathsLayout(cwd);
    write(cwd, "backend/.venv/Scripts/python.exe", "");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    expect(buildPythonDepsInstallCommand(target!)).toBe(
      'cd backend && ".venv/Scripts/python.exe" -m pip install -r requirements.txt',
    );
    expect(buildPytestInstallCommand(target!)).toBe('cd backend && ".venv/Scripts/python.exe" -m pip install pytest');
  });

  it("PIN: a bare conftest.py with NO config anywhere still runs in the marker directory", () => {
    // Nothing declares a rootdir, so nothing can declare testpaths either, and
    // pytest collects from where it is invoked. `conftest.py` saying "tests are
    // collected from here" is the whole signal — this is the unchanged case.
    const cwd = makeTempDir("muonroi-pytest-noconfig-");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "fastapi\n");
    write(cwd, "backend/.venv/Scripts/python.exe", "");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    expect(target!.runDir).toBe("backend");
    expect(buildPytestCommand(target!)).toBe('cd backend && ".venv/Scripts/python.exe" -m pytest');
  });

  it("runs in the marker directory when the config is AT the marker — the nearest config wins", () => {
    // pytest's rootdir is the FIRST config found walking up from the invocation
    // directory (_pytest/config/findpaths.py `locate_config` iterates
    // `(argpath, *argpath.parents)`), so an inner config shadows an outer one and
    // the marker directory IS the rootdir.
    const cwd = makeTempDir("muonroi-pytest-innercfg-");
    write(cwd, "pytest.ini", "[pytest]\ntestpaths = specs\n");
    write(cwd, "specs/tests/test_outer.py", "def test_o(): pass\n");
    write(cwd, "backend/pytest.ini", "[pytest]\n");
    write(cwd, "backend/requirements.txt", "fastapi\n");
    write(cwd, "backend/.venv/Scripts/python.exe", "");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    expect(target!.runDir).toBe("backend");
    expect(buildPytestCommand(target!)).toBe('cd backend && ".venv/Scripts/python.exe" -m pytest');
  });

  it("treats a pyproject.toml with [tool.pytest.ini_options] above the marker as the rootdir", () => {
    const cwd = makeTempDir("muonroi-pytest-pyprojcfg-");
    write(cwd, "pyproject.toml", "[project]\nname = 'x'\n[tool.pytest.ini_options]\ntestpaths = ['specs']\n");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "fastapi\n");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    expect(target!.runDir).toBe("");
    expect(target!.rootdirConfig).toBe("pyproject.toml");
  });

  it("does NOT treat a pyproject.toml with only [project] above the marker as the rootdir", () => {
    // Same distinction SECTIONED_CONFIG_FILES already draws for detection: a
    // pyproject without pytest's table declares no rootdir, so there is no
    // testpaths to honour and the marker directory stays correct.
    const cwd = makeTempDir("muonroi-pytest-pyprojnosec-");
    write(cwd, "pyproject.toml", "[project]\nname = 'x'\n[tool.ruff]\nline-length = 100\n");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "fastapi\n");

    const target = findPytestTargets(cwd).find((t) => t.dir === "backend");

    expect(target!.runDir).toBe("backend");
    expect(target!.rootdirConfig).toBeNull();
  });

  it("collapses targets sharing a rootdir onto the VENV interpreter, not the ambient one", () => {
    // Both targets resolve to the same runDir, so both would run pytest from the
    // same directory and collect the same tests. Which survives decides which
    // INTERPRETER the gate runs under, and the ambient one is a latent false
    // FAIL: on qa-platform `backend/.venv` has pytest and the FastAPI deps
    // installed, while a clean checkout's ambient `python` has neither, so that
    // command fails for a reason that has nothing to do with the code.
    const cwd = makeTempDir("muonroi-pytest-collapse-venv-");
    qaPlatformTestpathsLayout(cwd);
    write(cwd, "backend/.venv/Scripts/python.exe", "");

    const pytestCommands = inferVerifyProjectProfile(cwd).recipe.testCommands.filter((c) => c.includes("pytest"));

    expect(pytestCommands).toEqual(['"backend/.venv/Scripts/python.exe" -m pytest']);
    // The root `pytest.ini` target is a real target and is still DETECTED — it is
    // only its duplicate gate command that is folded away.
    expect(findPytestTargets(cwd).map((t) => t.dir)).toEqual(["", "backend"]);
  });

  it("still emits the ambient command when the only target has no venv", () => {
    // A project that declares a config and provisions no venv must still get a
    // runnable gate — collapsing must not be able to leave zero commands.
    const cwd = makeTempDir("muonroi-pytest-collapse-ambient-");
    write(cwd, "pytest.ini", "[pytest]\ntestpaths = tests\n");
    write(cwd, "requirements.txt", "pytest\n");
    write(cwd, "tests/test_a.py", "def test_a(): pass\n");

    const pytestCommands = inferVerifyProjectProfile(cwd).recipe.testCommands.filter((c) => c.includes("pytest"));

    expect(pytestCommands).toEqual(["python -m pytest"]);
  });

  it("dedupes to ONE stable command when several share a rootdir and NONE has a venv", () => {
    // Every candidate here builds the BYTE-IDENTICAL command — same ambient
    // `python`, same directory — so the collapse is a pure dedupe and the choice
    // only decides which marker the evidence cites. `findPytestTargets`' existing
    // shallowest-then-alphabetical order makes that stable across platforms
    // rather than dependent on readdir order, so the root config wins.
    const cwd = makeTempDir("muonroi-pytest-collapse-novenv-");
    write(cwd, "pytest.ini", "[pytest]\ntestpaths = specs\n");
    write(cwd, "specs/tests/test_a.py", "def test_a(): pass\n");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "pytest\n");
    write(cwd, "worker/conftest.py", "");
    write(cwd, "worker/requirements.txt", "pytest\n");

    const recipe = inferVerifyProjectProfile(cwd).recipe;

    expect(findPytestTargets(cwd).map((t) => t.dir)).toEqual(["", "backend", "worker"]);
    expect(recipe.testCommands.filter((c) => c.includes("pytest"))).toEqual(["python -m pytest"]);
    expect(recipe.evidence.some((line) => line.includes("pytest.ini"))).toBe(true);
  });

  it("keeps EVERY target's dependency install even when its gate command was folded away", () => {
    // The surviving run happens from the rootdir and can collect tests importing
    // from ANY of the collapsed sub-projects, so all their manifests still have
    // to be installed. Only the duplicate GATE is dropped, never the environment
    // preparation — that would trade a false FAIL for a missing dependency.
    const cwd = makeTempDir("muonroi-pytest-collapse-deps-");
    write(cwd, "pytest.ini", "[pytest]\ntestpaths = specs\n");
    write(cwd, "specs/tests/test_a.py", "def test_a(): pass\n");
    write(cwd, "backend/conftest.py", "");
    write(cwd, "backend/requirements.txt", "pytest\n");
    write(cwd, "backend/.venv/Scripts/python.exe", "");
    write(cwd, "worker/conftest.py", "");
    write(cwd, "worker/requirements.txt", "pytest\n");

    const recipe = inferVerifyProjectProfile(cwd).recipe;

    expect(recipe.testCommands.filter((c) => c.includes("pytest"))).toEqual([
      '"backend/.venv/Scripts/python.exe" -m pytest',
    ]);
    expect(recipe.installCommands).toContain(
      'cd backend && ".venv/Scripts/python.exe" -m pip install -r requirements.txt',
    );
    // worker's gate was folded away; its dependencies are still installed.
    expect(recipe.installCommands).toContain("cd worker && python -m pip install -r requirements.txt");
  });

  it("does not disturb a Node project that declares its own test script", () => {
    const cwd = makeTempDir("muonroi-node-hastests-");
    write(cwd, "package.json", JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
    write(cwd, "package-lock.json", "{}");

    const recipe = inferVerifyProjectProfile(cwd).recipe;

    expect(recipe.ecosystem).toBe("node");
    expect(recipe.testCommands).toEqual(["npm run test"]);
  });

  it("names the missing pytest dependency in notes rather than emitting a command that cannot launch", () => {
    const cwd = makeTempDir("muonroi-pytest-note-");
    realQaPlatformLayout(cwd);

    const recipe = inferVerifyProjectProfile(cwd).recipe;

    // pytest is in no manifest and no venv: the recipe must say so AND provide
    // it, or the test command fails at import time and a floor failure becomes
    // a verify failure.
    expect(recipe.notes.join("\n")).toMatch(/pytest/i);
    expect(recipe.installCommands.some((c) => /pip install.*pytest/.test(c))).toBe(true);
  });
});
