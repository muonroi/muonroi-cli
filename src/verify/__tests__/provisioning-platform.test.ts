/**
 * A stored provisioning command that names a path which CANNOT EXIST on this
 * platform is stale garbage, not knowledge the disk scan lacks.
 *
 * `mergeStoredVerifyRecipe` defers to a stored provisioning list outright
 * (`../recipe-merge.ts`, the `provisioning` helper) and that rule is correct —
 * `npm ci` then `npm install` is one operation run twice. But deference is owed
 * to a record that knows something the scan cannot see, NOT to one asserting an
 * impossibility about the host it is running on.
 *
 * The measured case (`D:\sources\CompanyLibs\qa-platform`, READ-ONLY — nothing
 * here touches it). `fixtures/qa-platform-environment.json:12-15` is a
 * byte-for-byte copy of the record that was authoritative for every run, and its
 * second install entry is:
 *
 *     cd /d/sources/CompanyLibs/qa-platform/backend && python3 -m venv .venv \
 *       && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt
 *
 * Every sprint re-ran it, `python3 -m venv .venv` RE-CREATED the existing venv on
 * the host's bare `python3` (3.14), the compiled cp312 wheel vanished, and pytest
 * exited 2 with `ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'`.
 *
 * ## The two invariants, and why only these two
 *
 * A false positive silently discards real operator knowledge, which is worse than
 * the bug being fixed. So an entry is rejected only on a DOCUMENTED platform
 * invariant, never on a hunch — and never on a filesystem existence check, since
 * an install command legitimately names paths it is about to create (this very
 * line creates `.venv` before using it). Platform SHAPE is the signal; existence
 * is not.
 *
 * 1. **A venv `bin/` path on win32.** CPython's `venv` resolves its script
 *    directory through `sysconfig.get_path("scripts", scheme="venv")`
 *    (`Lib/venv/__init__.py:102-107`, used at `:175`
 *    `binpath = self._venv_path(env_dir, 'scripts')`), and
 *    `Lib/sysconfig/__init__.py:104-105` aliases that scheme per platform:
 *
 *        if os.name == 'nt':
 *            _INSTALL_SCHEMES['venv'] = _INSTALL_SCHEMES['nt_venv']
 *        else:
 *            _INSTALL_SCHEMES['venv'] = _INSTALL_SCHEMES['posix_venv']
 *
 *    `nt_venv` is `'scripts': '{base}/Scripts'` (`:98`); `posix_venv` is
 *    `'scripts': '{base}/bin'` (`:88`). The `nt_venv` dict has no `bin` key at
 *    all, and `:76-78` records that downstream distributors are asked to leave
 *    the `*_venv` schemes unchanged — so this is a stable documented invariant,
 *    not an implementation accident. Confirmed on this host:
 *
 *        python3 -m venv --without-pip .venv
 *        → Include  Lib  Scripts  .gitignore  pyvenv.cfg      (no `bin`)
 *
 * 2. **An MSYS/absolute-POSIX drive path on win32.** The floor spawns through
 *    `spawn(command, {shell: true})`, which is cmd.exe. Measured on this host:
 *
 *        cd /d/sources/CompanyLibs/qa-platform/backend && echo ARRIVED
 *          → exit 1, "The syntax of the command is incorrect."
 *        cd /c/Windows && echo ARRIVED
 *          → exit 1, "The system cannot find the path specified."
 *
 *    (`cd` reads the leading `/d` as its own drive-switch flag.) The sibling
 *    forward-slash-splitting measurement is recorded at `../pytest-detect.ts:432-446`.
 *
 * Both invariants are win32-only. The SAME commands are correct on linux, so the
 * predicate takes the platform as an argument and is never allowed to read
 * `process.platform` itself.
 */

import { describe, expect, it } from "vitest";
import type { VerifyRecipe } from "../../types/index.js";
import { findImpossibleProvisioning } from "../provisioning-platform.js";
import { mergeStoredVerifyRecipe } from "../recipe-merge.js";

/** The exact second install entry from the real qa-platform record. */
const IMPOSSIBLE_INSTALL =
  "cd /d/sources/CompanyLibs/qa-platform/backend && python3 -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt";

/** The real record's install list, verbatim (`fixtures/qa-platform-environment.json:12-15`). */
const QA_PLATFORM_INSTALL = ["cd frontend && npm ci", IMPOSSIBLE_INSTALL];

/** What the live disk derivation yields on that same tree, on win32. */
const DERIVED_INSTALL = [
  "cd frontend && npm install",
  'cd backend && ".venv/Scripts/python.exe" -m pip install -r requirements.txt',
];

const derived: VerifyRecipe = {
  ecosystem: "node",
  appKind: "nextjs",
  appLabel: "Next.js",
  shellInitCommands: [],
  bootstrapCommands: ["apt-get install -y nodejs"],
  installCommands: DERIVED_INSTALL,
  buildCommands: ["npm run build"],
  testCommands: ["npm run test"],
  smokeKind: "none",
  evidence: [],
  notes: [],
};

function stored(over: Partial<VerifyRecipe> = {}): VerifyRecipe {
  return { ...derived, installCommands: [], bootstrapCommands: [], ...over };
}

describe("an impossible stored provisioning command does not suppress the derivation", () => {
  it("HEADLINE: the real qa-platform install list falls through to derived on win32", () => {
    const merged = mergeStoredVerifyRecipe(stored({ installCommands: QA_PLATFORM_INSTALL }), derived, "win32");

    // Dropping only the impossible ENTRY is not enough: `cd frontend && npm ci`
    // would still make the list non-empty, the whole derivation would still be
    // discarded, and the Windows-correct pip line would still never run. A list
    // containing an impossibility is not a trustworthy witness for its own rest.
    expect(merged.installCommands).toEqual(DERIVED_INSTALL);
    expect(merged.installCommands).not.toContain(IMPOSSIBLE_INSTALL);
    expect(merged.installCommands).toContain(
      'cd backend && ".venv/Scripts/python.exe" -m pip install -r requirements.txt',
    );
  });

  it("says so in `notes`, naming the command and the invariant it violates", () => {
    const merged = mergeStoredVerifyRecipe(stored({ installCommands: QA_PLATFORM_INSTALL }), derived, "win32");

    // A silent drop would reproduce the defect class this whole area exists to
    // kill: a signal reporting something other than what it measured. `notes` is
    // the unioned audit trail (`../recipe-merge.ts:71`).
    const note = merged.notes.find((n) => n.includes(IMPOSSIBLE_INSTALL));
    expect(note).toBeDefined();
    expect(note).toMatch(/installCommands/);
    expect(note).toMatch(/win32/);
    expect(note).toMatch(/Scripts/);
  });

  it("rejects on the MSYS drive path alone, with no venv `bin/` in the command", () => {
    const msysOnly = "cd /d/sources/CompanyLibs/qa-platform && npm ci";
    const merged = mergeStoredVerifyRecipe(stored({ installCommands: [msysOnly] }), derived, "win32");

    expect(merged.installCommands).toEqual(DERIVED_INSTALL);
    expect(merged.notes.some((n) => n.includes(msysOnly))).toBe(true);
  });

  it("rejects on a venv `bin/` path alone, with no MSYS path in the command", () => {
    const binOnly = "cd backend && .venv/bin/pip install -r requirements.txt";
    const merged = mergeStoredVerifyRecipe(stored({ installCommands: [binOnly] }), derived, "win32");

    expect(merged.installCommands).toEqual(DERIVED_INSTALL);
    expect(merged.notes.some((n) => n.includes(binOnly))).toBe(true);
  });

  it("applies to `bootstrapCommands` too, not just `installCommands`", () => {
    const merged = mergeStoredVerifyRecipe(
      stored({ bootstrapCommands: ["apt-get update", IMPOSSIBLE_INSTALL] }),
      derived,
      "win32",
    );

    expect(merged.bootstrapCommands).toEqual(["apt-get install -y nodejs"]);
    expect(merged.bootstrapCommands).not.toContain("apt-get update");
    expect(merged.notes.some((n) => n.includes(IMPOSSIBLE_INSTALL) && n.includes("bootstrapCommands"))).toBe(true);
  });
});

describe("the deference rule itself survives", () => {
  it("a stored list with no impossible entry still wins outright on win32", () => {
    // The anti-conflict reason is unchanged: `npm ci` and `npm install` are two
    // spellings of ONE operation and running the second rewrites the lockfile.
    const ok = ["cd frontend && npm ci", 'cd backend && ".venv/Scripts/python.exe" -m pip install -r requirements.txt'];
    const merged = mergeStoredVerifyRecipe(stored({ installCommands: ok }), derived, "win32");

    expect(merged.installCommands).toEqual(ok);
    expect(merged.installCommands).not.toContain("cd frontend && npm install");
    expect(merged.notes).toEqual([]);
  });

  it("the SAME POSIX list is NOT rejected on linux — `bin/` is correct there", () => {
    const merged = mergeStoredVerifyRecipe(stored({ installCommands: QA_PLATFORM_INSTALL }), derived, "linux");

    expect(merged.installCommands).toEqual(QA_PLATFORM_INSTALL);
    expect(merged.installCommands).toContain(IMPOSSIBLE_INSTALL);
    expect(merged.notes).toEqual([]);
  });

  it("an empty stored list is still a hole the derivation fills", () => {
    const merged = mergeStoredVerifyRecipe(stored({ installCommands: [] }), derived, "win32");

    expect(merged.installCommands).toEqual(DERIVED_INSTALL);
    // Nothing was REJECTED, so nothing is reported — an empty list is a hole,
    // not a bad witness.
    expect(merged.notes).toEqual([]);
  });

  it("does not mutate either input", () => {
    const s = stored({ installCommands: QA_PLATFORM_INSTALL });
    const snapshot = JSON.stringify({ s, derived });
    mergeStoredVerifyRecipe(s, derived, "win32");
    expect(JSON.stringify({ s, derived })).toBe(snapshot);
  });
});

/**
 * The predicate directly. A FALSE POSITIVE here silently discards real operator
 * knowledge, which is worse than the bug being fixed, so the non-matches below
 * matter more than the matches.
 */
describe("findImpossibleProvisioning is narrow", () => {
  it("names every invariant a single command violates", () => {
    const [hit] = findImpossibleProvisioning([IMPOSSIBLE_INSTALL], "win32");
    expect(hit?.command).toBe(IMPOSSIBLE_INSTALL);
    // The qa-platform line violates BOTH: the MSYS drive path and the venv `bin/`.
    expect(hit?.invariants).toHaveLength(2);
  });

  it.each([
    // A `/`-separated path segment is not a drive root: `/bin/` is three letters.
    'cd backend && ".venv/Scripts/python.exe" -m pip install -r requirements.txt',
    // A URL's `//host/…` must not read as a drive root.
    "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs",
    // `sed`'s `s/a/b/` delimiters are single characters between slashes.
    "sed -i 's/a/b/' package.json && npm ci",
    // A redirect to a POSIX device path is not a drive root either.
    "npm ci 2>/dev/null",
    // A `/x/` preceded by a BACKSLASH is not a drive root. This one guards the
    // regex spelling itself: the negated-character-class form of this invariant is
    // rewritten by `biome check --write` into a version that DOES match here, so
    // the boundary is stated positively instead. See `../provisioning-platform.ts`.
    "cd foo\\/c/bar && npm ci",
    // The segment test is exactly `venv`/`.venv`, so a longer name does not match.
    "cd backend && myvenv/bin/pip install -r requirements.txt",
    // The CORRECT win32 spelling, which must never be rejected.
    "cd backend && .venv/Scripts/pip install -r requirements.txt",
    // Plain provisioning with no paths at all.
    "cd frontend && npm ci",
    "apt-get update && apt-get install -y python3 python3-venv",
  ])("does not reject %s on win32", (command) => {
    expect(findImpossibleProvisioning([command], "win32")).toEqual([]);
  });

  it("is win32-only — every invariant is inert on linux and darwin", () => {
    expect(findImpossibleProvisioning(QA_PLATFORM_INSTALL, "linux")).toEqual([]);
    expect(findImpossibleProvisioning(QA_PLATFORM_INSTALL, "darwin")).toEqual([]);
  });

  it("ignores blank entries rather than reporting them", () => {
    expect(findImpossibleProvisioning(["", "   "], "win32")).toEqual([]);
  });

  it("matches a backslash-spelled venv bin path too", () => {
    expect(findImpossibleProvisioning(["cd backend && .venv\\bin\\pip install -r r.txt"], "win32")).toHaveLength(1);
  });
});
