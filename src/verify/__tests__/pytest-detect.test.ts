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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPytestTargets } from "../pytest-detect.js";
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
