/**
 * A stored `environment.json` must not hide what is on disk.
 *
 * Every recipe-detection improvement reaches `profile.recipe` through
 * `inferVerifyProjectProfile`, and that function used to collapse a stored
 * manifest and the live disk derivation with `??` — the stored record REPLACED
 * the derivation wholesale. Since `prepareVerifyRun` writes the manifest once
 * and never refreshes it, a record written on day one was authoritative forever.
 *
 * Measured on the real tree (`D:\sources\CompanyLibs\qa-platform`, READ-ONLY —
 * nothing here touches it): `.muonroi-cli/environment.json`, written
 * 2026-09-23 21:29, carries `testCommands: []`, `buildCommands: ["npm run verify"]`
 * and `ecosystem: "node-python-docker"`, while the live derivation on the same
 * tree yields `{build: ["cd frontend && npm run build"],
 * test: ["npm run test", "cd backend && \".venv/Scripts/python.exe\" -m pytest"]}`.
 *
 * `fixtures/qa-platform-environment.json` is a byte-for-byte copy of that file.
 * `qaPlatformShape()` reproduces the same tree shape as
 * `./polyglot-recipe.test.ts` does.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerifyRecipe } from "../../types/index.js";
import { mergeStoredVerifyRecipe } from "../recipe-merge.js";
import { inferVerifyProjectProfile } from "../recipes.js";

const QA_PLATFORM_MANIFEST = fs.readFileSync(path.join(__dirname, "fixtures", "qa-platform-environment.json"), "utf8");

const made: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stored-manifest-merge-"));
  made.push(dir);
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf8");
}

afterEach(() => {
  while (made.length) {
    const dir = made.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** The real qa-platform shape: root `verify` script, Next.js front end, FastAPI back end. */
function qaPlatformShape(): string {
  const dir = tmp();
  write(
    dir,
    "package.json",
    JSON.stringify({
      name: "qa-platform",
      private: true,
      scripts: { verify: "cd frontend && npx tsc --noEmit && npx next build --webpack" },
    }),
  );
  write(
    dir,
    "frontend/package.json",
    JSON.stringify({
      name: "frontend",
      private: true,
      scripts: { dev: "next dev", build: "next build --webpack", start: "next start", lint: "eslint" },
      dependencies: { next: "16.3.4", react: "19.2.8" },
      devDependencies: { typescript: "^5" },
    }),
  );
  write(dir, "frontend/package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
  write(dir, "backend/conftest.py", "import sys\n");
  write(dir, "backend/requirements.txt", "fastapi==0.115.0\nuvicorn==0.30.0\n");
  return dir;
}

/** The stored record, loaded the way `loadVerifyEnvironment` loads it. */
function storedQaPlatformRecipe(cwd: string): VerifyRecipe {
  write(cwd, ".muonroi-cli/environment.json", QA_PLATFORM_MANIFEST);
  // Deliberately NOT `loadVerifyEnvironment` — this suite is about what
  // `inferVerifyProjectProfile` does with an override, and the loader has its own
  // coverage in `../environment.test.ts`.
  const raw = JSON.parse(QA_PLATFORM_MANIFEST) as { recipe: VerifyRecipe };
  return { ...raw.recipe, evidence: raw.recipe.evidence ?? [], notes: raw.recipe.notes ?? [] };
}

describe("a stored manifest no longer hides the disk", () => {
  it("carries the derived test commands even though the record names none", () => {
    const cwd = qaPlatformShape();
    const stored = storedQaPlatformRecipe(cwd);
    expect(stored.testCommands).toEqual([]);

    const recipe = inferVerifyProjectProfile(cwd, {}, stored).recipe;

    expect(recipe.testCommands.some((c) => /^cd backend && .*-m pytest$/.test(c))).toBe(true);
    expect(recipe.testCommands.length).toBeGreaterThan(0);
  });

  it("carries the derived sub-directory build gate alongside the record's own", () => {
    const cwd = qaPlatformShape();
    const recipe = inferVerifyProjectProfile(cwd, {}, storedQaPlatformRecipe(cwd)).recipe;

    // The record's build gate is `npm run verify` — a ROOT script the detector
    // never emits (it only picks `build`/`typecheck`). Both must run.
    expect(recipe.buildCommands).toContain("npm run verify");
    expect(recipe.buildCommands).toContain("cd frontend && npm run build");
  });

  it("stamps who contributed the test commands", () => {
    const cwd = qaPlatformShape();
    const recipe = inferVerifyProjectProfile(cwd, {}, storedQaPlatformRecipe(cwd)).recipe;
    // Nothing was asserted by the record, so the whole set is disk-derived.
    expect(recipe.testCommandsSource).toBe("disk-derived");
  });
});

describe("a stored manifest never loses what only it knows", () => {
  it("keeps a test command no detector can derive", () => {
    const cwd = qaPlatformShape();
    const stored: VerifyRecipe = {
      ...storedQaPlatformRecipe(cwd),
      testCommands: ["node scripts/contract-smoke.mjs --suite=billing"],
    };

    const recipe = inferVerifyProjectProfile(cwd, {}, stored).recipe;

    expect(recipe.testCommands).toContain("node scripts/contract-smoke.mjs --suite=billing");
    expect(recipe.testCommands.some((c) => /^cd backend && .*-m pytest$/.test(c))).toBe(true);
    // The record's own command keeps its position — a merge must not re-order a
    // set someone else ordered (`composeRecipe`'s primary-stack-first rule).
    expect(recipe.testCommands[0]).toBe("node scripts/contract-smoke.mjs --suite=billing");
    expect(recipe.testCommandsSource).toBe("both");
  });

  it("does not append a competing bootstrap step", () => {
    const cwd = qaPlatformShape();
    const stored = storedQaPlatformRecipe(cwd);

    const recipe = inferVerifyProjectProfile(cwd, {}, stored).recipe;

    // Provisioning is not a gate: `npm ci` and `npm install` are two spellings of
    // ONE operation, and running the second after the first rewrites the lockfile.
    // The record's apt/nodesource sequence must not be joined by a second,
    // differently-sourced node install. Every entry in it is platform-possible, so
    // this deference holds on every platform.
    expect(recipe.bootstrapCommands).toEqual(stored.bootstrapCommands);
  });

  it("but DEFERS ONLY while the record is possible on this host", () => {
    // This record's second install command is
    //   cd /d/sources/… && python3 -m venv .venv && .venv/bin/pip install …
    // which names an MSYS drive path and a POSIX venv `bin/` layout. On win32 both
    // are impossible (see `../provisioning-platform.ts`), so the record is not a
    // trustworthy witness for this host and the whole field falls through to the
    // live derivation — including the derived line that actually works here.
    // On POSIX the same command is correct, and deference is unchanged.
    const cwd = qaPlatformShape();
    const stored = storedQaPlatformRecipe(cwd);
    const recipe = inferVerifyProjectProfile(cwd, {}, stored).recipe;

    if (process.platform === "win32") {
      expect(recipe.installCommands).not.toEqual(stored.installCommands);
      expect(recipe.installCommands).toContain("cd frontend && npm install");
      expect(recipe.installCommands.some((c) => c.includes(".venv/bin/"))).toBe(false);
      // Never a silent drop — `notes` is the audit trail.
      expect(recipe.notes.some((n) => n.includes("installCommands") && n.includes(".venv/bin/pip"))).toBe(true);
    } else {
      expect(recipe.installCommands).toEqual(stored.installCommands);
      expect(recipe.installCommands).not.toContain("cd frontend && npm install");
    }
  });

  it("keeps the record's scalars: ecosystem, appKind, start command, smoke kind", () => {
    const cwd = qaPlatformShape();
    const stored = storedQaPlatformRecipe(cwd);

    const recipe = inferVerifyProjectProfile(cwd, {}, stored).recipe;

    expect(recipe.ecosystem).toBe("node-python-docker");
    expect(recipe.appKind).toBe("fullstack-web-app");
    expect(recipe.appLabel).toBe("qa-platform");
    expect(recipe.startCommand).toBe("docker compose up -d");
    expect(recipe.startPort).toBe("9090");
    expect(recipe.smokeKind).toBe("http");
    // Every note the record carries survives — it is the audit trail.
    for (const note of stored.notes) expect(recipe.notes).toContain(note);
  });
});

describe("mergeStoredVerifyRecipe field policy", () => {
  const derived: VerifyRecipe = {
    ecosystem: "node",
    appKind: "nextjs",
    appLabel: "Next.js",
    shellInitCommands: ["export DERIVED=1"],
    bootstrapCommands: ["apt-get install -y nodejs"],
    installCommands: ["npm install"],
    buildCommands: ["npm run build"],
    testCommands: ["npm run test"],
    startCommand: "npm run dev",
    startPort: "3000",
    smokeKind: "http",
    smokeTarget: "http://127.0.0.1:3000",
    evidence: ["Detected package.json"],
    notes: [],
  };

  it("returns the derivation untouched when there is no stored record", () => {
    expect(mergeStoredVerifyRecipe(null, derived)).toBe(derived);
    expect(mergeStoredVerifyRecipe(undefined, derived)).toBe(derived);
  });

  it("treats `unknown` as the absence value for ecosystem and appKind", () => {
    const stored: VerifyRecipe = {
      ...derived,
      ecosystem: "unknown",
      appKind: "unknown",
      appLabel: "Unrecognized project",
      shellInitCommands: [],
      bootstrapCommands: [],
      installCommands: [],
      buildCommands: [],
      testCommands: [],
      startCommand: undefined,
      startPort: undefined,
      smokeKind: "none",
      smokeTarget: undefined,
      evidence: [],
    };

    const merged = mergeStoredVerifyRecipe(stored, derived);
    expect(merged.ecosystem).toBe("node");
    expect(merged.appKind).toBe("nextjs");
    // An empty provisioning list is a hole the derivation fills.
    expect(merged.installCommands).toEqual(["npm install"]);
    expect(merged.bootstrapCommands).toEqual(["apt-get install -y nodejs"]);
    // Optional scalars: `undefined` is a hole.
    expect(merged.startCommand).toBe("npm run dev");
    expect(merged.startPort).toBe("3000");
    expect(merged.smokeTarget).toBe("http://127.0.0.1:3000");
  });

  it("keeps a record that deliberately says `smokeKind: none`", () => {
    // `smokeKind` is non-optional, so "none" is a VALUE ("do not smoke"), not a
    // hole. Overriding it would start an HTTP probe the record refused.
    const stored: VerifyRecipe = { ...derived, smokeKind: "none", smokeTarget: undefined };
    expect(mergeStoredVerifyRecipe(stored, derived).smokeKind).toBe("none");
  });

  it("unions shell init, which is what the sandbox layer already does", () => {
    const stored: VerifyRecipe = { ...derived, shellInitCommands: ['export PATH="/usr/local/bin:$PATH"'] };
    expect(mergeStoredVerifyRecipe(stored, derived).shellInitCommands).toEqual([
      'export PATH="/usr/local/bin:$PATH"',
      "export DERIVED=1",
    ]);
  });

  it("does not mutate either input", () => {
    const stored: VerifyRecipe = { ...derived, testCommands: ["npm run e2e"] };
    const snapshot = JSON.stringify({ stored, derived });
    mergeStoredVerifyRecipe(stored, derived);
    expect(JSON.stringify({ stored, derived })).toBe(snapshot);
  });
});
