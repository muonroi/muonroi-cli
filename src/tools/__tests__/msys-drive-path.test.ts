/**
 * An MSYS drive path (`/d/sources/...`) must mean D:\sources\... on win32.
 *
 * ## The incident this exists for (measured live, session 2a116648b48e)
 *
 * A `/ideal resume muc2joffe506` run rooted at D:\sources\CompanyLibs\qa-platform
 * tried to edit the one file it needed and got, from `tool_result/edit_file`:
 *
 *   BLOCKED (write-scope): refused to write
 *   "/d/sources/CompanyLibs/qa-platform/specs/040-sprint1-artifact-store/tests/
 *    test_artifact_store_smoke.py" — it is OUTSIDE the direct...
 *
 * That target IS inside the run root. Measured with node on the host:
 * `path.isAbsolute("/d/...")` is **true** on win32, so `resolvePath` in file.ts
 * passed it through unchanged and `path.resolve` then prefixed the CURRENT drive,
 * producing `D:\d\sources\CompanyLibs\...` — a location that does not exist
 * (`realpathSync` threw ENOENT). Containment then correctly reported "outside the
 * run root": true about the resolved path, and deeply misleading about the cause.
 *
 * The `/d/` spelling is not the model inventing something. The bash tool on
 * Windows is git bash and prints MSYS paths, so the model reads `/d/sources/...`
 * in its own tool output and reuses it. Cost in that one session: exactly 1
 * `edit_file`, then 82 `bash` calls after the model reasonably concluded it must
 * not touch the file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCommitRunRoot } from "../../orchestrator/auto-commit.js";
import { editFile, writeFile } from "../file.js";
import { FileTracker } from "../file-tracker.js";
import { checkWriteScope, normalizeMsysDrivePath, resetWorktreeCache } from "../write-scope.js";

/** The exact path the live run was refused. Used verbatim as the headline fixture. */
const INCIDENT_PATH =
  "/d/sources/CompanyLibs/qa-platform/specs/040-sprint1-artifact-store/tests/test_artifact_store_smoke.py";

describe("normalizeMsysDrivePath — the spelling fix", () => {
  it("rewrites the incident path to the drive-qualified form it means", () => {
    expect(normalizeMsysDrivePath(INCIDENT_PATH, "win32")).toBe(
      "D:\\sources\\CompanyLibs\\qa-platform\\specs\\040-sprint1-artifact-store\\tests\\test_artifact_store_smoke.py",
    );
  });

  it("rewrites a short MSYS drive path and uppercases the letter", () => {
    expect(normalizeMsysDrivePath("/c/Users", "win32")).toBe("C:\\Users");
    expect(normalizeMsysDrivePath("/d/x/y", "win32")).toBe("D:\\x\\y");
    // MSYS spells it lowercase, but an uppercase letter is the same drive and is
    // just as unambiguous.
    expect(normalizeMsysDrivePath("/D/x", "win32")).toBe("D:\\x");
  });

  it("a trailing-slash drive root is the same shape", () => {
    expect(normalizeMsysDrivePath("/d/", "win32")).toBe("D:\\");
  });

  it("leaves POSIX completely alone — there /d/x is an ordinary absolute path", () => {
    expect(normalizeMsysDrivePath(INCIDENT_PATH, "linux")).toBe(INCIDENT_PATH);
    expect(normalizeMsysDrivePath("/d/x", "linux")).toBe("/d/x");
    expect(normalizeMsysDrivePath("/d/x", "darwin")).toBe("/d/x");
  });

  // Each of these was measured on win32 with node before the pattern was written;
  // the measurement is why the shape is excluded.
  it.each([
    // `path.resolve("/tmp/x")` -> "D:\\tmp\\x": also drive-relative, but "tmp" is
    // not a drive letter and rewriting it would invent a T: drive.
    ["/tmp/x"],
    ["/usr/lib"],
    ["/dev/null"],
    // UNC. `path.resolve("//server/share")` -> "\\\\server\\share\\" — already a
    // real, correct absolute path, so there is nothing to fix.
    ["//server/share"],
    ["//server/share/f.txt"],
    // `path.resolve("//d/x")` -> "\\\\d\\x\\": a UNC path whose SERVER is "d",
    // not drive D. The leading double slash is what distinguishes it, which is
    // why the pattern anchors on exactly one.
    ["//d/x"],
    // Multi-character first segment: not a drive letter.
    ["/dd/x"],
    ["/1/x"],
    // Backslash form. `path.resolve("\\d\\x")` -> "D:\\d\\x", i.e. drive-relative
    // too, but MSYS never emits backslashes so this spelling carries no MSYS
    // intent; on win32 a leading backslash legitimately means "root of the
    // current drive".
    ["\\d\\x"],
    // A bare drive letter with no trailing slash. Deliberately NOT rewritten:
    // the shape names no file, so no file tool can have a legitimate target of
    // it, and requiring the trailing slash keeps the matched shape exactly MSYS's
    // own spelling of a drive ROOT prefix.
    ["/d"],
    ["/"],
    [""],
  ])("does not rewrite %j on win32", (input) => {
    expect(normalizeMsysDrivePath(input, "win32")).toBe(input);
  });
});

describe("the write path, end to end", () => {
  let root: string;
  /** Stands in for D:\sources\CompanyLibs\qa-platform — the run root. */
  let runRoot: string;
  /** A repo OUTSIDE the run root, whose directories really exist. */
  let outsideRepo: string;

  /** Spell an absolute win32 path the way git bash prints it: D:\a\b -> /d/a/b. */
  function toMsys(abs: string): string {
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(abs);
    if (!m) throw new Error(`toMsys: not a drive-qualified win32 path: ${abs}`);
    return `/${m[1].toLowerCase()}/${m[2].split(path.win32.sep).join("/")}`;
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "msys-path-")));
    runRoot = path.join(root, "workspace", "qa-platform");
    mkdirSync(path.join(runRoot, ".git"), { recursive: true });
    mkdirSync(path.join(runRoot, "specs", "tests"), { recursive: true });
    writeFileSync(path.join(runRoot, "specs", "tests", "smoke.py"), "assert True\n");

    outsideRepo = path.join(root, "workspace", "other-repo");
    // A `.git` entry is load-bearing: the fixture lives under tmpdir(), and
    // write-scope.ts:260 allows a temp-dir target that is in NO worktree (scratch
    // files are not work product). Making it a checkout is what keeps this an
    // honest out-of-root target.
    mkdirSync(path.join(outsideRepo, ".git"), { recursive: true });
    mkdirSync(path.join(outsideRepo, "src"), { recursive: true });
    writeFileSync(path.join(outsideRepo, "src", "lib.py"), "y = 1\n");

    resetWorktreeCache();
    delete process.env.MUONROI_WRITE_SCOPE;
    delete process.env.MUONROI_WRITE_SCOPE_ROOTS;
  });

  afterEach(() => {
    setCommitRunRoot(null);
    resetWorktreeCache();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      // Windows: the LSP runtime can still hold a handle on a just-written file
      // (EPERM). The fixture is a mkdtemp dir — leaking it must not fail the
      // assertion it follows.
      console.error(`[msys-drive-path.test] fixture cleanup failed for ${root}: ${(err as Error)?.message}`);
    }
  });

  it.runIf(process.platform === "win32")(
    "REGRESSION: an MSYS-spelled in-root target is edited, not refused",
    async () => {
      setCommitRunRoot(runRoot);
      const real = path.join(runRoot, "specs", "tests", "smoke.py");
      const tracker = new FileTracker();
      tracker.markRead(real, readFileSync(real, "utf-8"), 0);

      const res = await editFile(toMsys(real), "assert True", "assert False", runRoot, tracker);

      expect(res.output).not.toContain("BLOCKED (write-scope)");
      expect(res.success).toBe(true);
      expect(readFileSync(real, "utf-8")).toContain("assert False");
    },
  );

  it.runIf(process.platform === "win32")(
    "REGRESSION: write_file creates the MSYS-spelled target at its real location",
    async () => {
      setCommitRunRoot(runRoot);
      const real = path.join(runRoot, "specs", "tests", "new_smoke.py");

      const res = await writeFile(toMsys(real), "assert 1\n", runRoot, new FileTracker());

      expect(res.success).toBe(true);
      expect(existsSync(real)).toBe(true);
      // The bogus current-drive resolution must NOT have been created.
      expect(existsSync(path.resolve(toMsys(real)))).toBe(false);
    },
  );

  it.runIf(process.platform === "win32")(
    "CONTAINMENT HOLDS: an MSYS-spelled target genuinely outside the run root is still refused",
    async () => {
      setCommitRunRoot(runRoot);
      const victim = path.join(outsideRepo, "src", "lib.py");
      const before = readFileSync(victim, "utf-8");

      const res = await writeFile(toMsys(victim), "pwned\n", runRoot, new FileTracker());

      expect(res.success).toBe(false);
      expect(res.output).toContain("BLOCKED (write-scope)");
      expect(readFileSync(victim, "utf-8")).toBe(before);
    },
  );

  it("a refusal whose target resolves nowhere reports THAT, not cwd drift", () => {
    setCommitRunRoot(runRoot);
    // Nothing along this path exists — not even its top-level directory. That is
    // the signature of a mis-spelled path, which is a different finding from a
    // path that resolves fine and simply sits elsewhere.
    const nowhere = path.join(path.parse(root).root, "muonroi-no-such-top-level-dir", "a", "b.py");

    const v = checkWriteScope(nowhere);

    expect(v.ok).toBe(false);
    expect(v.reason).toBe("unresolvable-target");
  });

  it("a refusal whose target DOES resolve keeps the cwd-drift finding", () => {
    setCommitRunRoot(runRoot);

    const v = checkWriteScope(path.join(outsideRepo, "src", "lib.py"));

    expect(v.ok).toBe(false);
    expect(v.reason).toBe("outside-run-root");
  });

  it("the two refusals read differently to an agent", async () => {
    setCommitRunRoot(runRoot);
    const nowhere = path.join(path.parse(root).root, "muonroi-no-such-top-level-dir", "a", "b.py");

    const unresolvable = await writeFile(nowhere, "x\n", runRoot, new FileTracker());
    const outside = await writeFile(path.join(outsideRepo, "src", "new.py"), "x\n", runRoot, new FileTracker());

    // Shared skeleton, kept from the original message.
    for (const res of [unresolvable, outside]) {
      expect(res.success).toBe(false);
      expect(res.output).toContain("BLOCKED (write-scope)");
      expect(res.output).toContain("Nothing was written");
      expect(res.output).toContain("Resolved target:");
    }
    // The unresolvable one must NOT send the agent chasing a `cd`, and must name
    // the spelling to check.
    expect(unresolvable.output).toContain("does not exist");
    expect(unresolvable.output).not.toContain("`cd`");
    // The genuinely-elsewhere one keeps the cwd-drift guidance that is correct
    // for it.
    expect(outside.output).toContain("`cd`");
    expect(outside.output).not.toContain("does not exist");
  });
});
