/**
 * The same `/d/...` blindness at the path inputs the WRITE path did not cover.
 *
 * `src/tools/__tests__/msys-drive-path.test.ts` owns the normaliser's shape and
 * the write path (`write_file` / `edit_file` via `resolvePath`). This file covers
 * the three OTHER tool surfaces that take a path from the model and were still
 * reading an MSYS spelling as a current-drive-relative path.
 *
 * ## Why each one matters, measured on win32 before the fix
 *
 * With `process.cwd()` on D: and the fixture under `C:\Users\...\Temp`:
 *
 *   - `BashTool.setCwd("/c/Users/.../msys-probe-X")` threw
 *     `setCwd: path does not exist` for a directory that DOES exist —
 *     `path.isAbsolute` is true for that spelling on win32, so the guard passed
 *     it through and `existsSync` then tested `D:\c\Users\...`. The tool cwd is
 *     the anchor every later relative path in the session resolves against.
 *   - `executeGrep({pattern:"MSYS_NEEDLE", path:"/c/Users/.../msys-probe-X"})`
 *     returned `{success:true, output:"No matches found.\n(Some paths were
 *     inaccessible and skipped)"}` while the same search under the native
 *     spelling returned `Found 1 matches`. A search root that does not exist
 *     reads to the model as "this code is not here" — a wrong answer that
 *     announces nothing.
 *   - `buildScreenshotPath(cwd, "/c/Users/.../shots/s.png")` returned that MSYS
 *     string VERBATIM, created `D:\c\Users\phila\AppData\Local\Temp\...\shots`,
 *     and did NOT create the real directory. Not a loud failure: a screenshot
 *     lands somewhere nobody looks and the tool reports success.
 *
 * POSIX is pinned at every site: there `/d/x` is an ordinary absolute path and
 * `normalizeMsysDrivePath` is identity, so a native absolute path and a relative
 * path must behave exactly as they did before.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../bash.js";
import { buildScreenshotPath } from "../computer.js";
import { executeGrep } from "../grep.js";

const WIN32 = process.platform === "win32";

/** Spell an absolute win32 path the way git bash prints it: D:\a\b -> /d/a/b. */
function toMsys(abs: string): string {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(abs);
  if (!m) throw new Error(`toMsys: not a drive-qualified win32 path: ${abs}`);
  return `/${m[1].toLowerCase()}/${m[2].split(path.win32.sep).join("/")}`;
}

/**
 * The tree the PRE-FIX code creates when it resolves an MSYS spelling against the
 * current drive: `<cwd drive>:\<msys letter>\...`. Its top-level directory is a
 * single-letter folder at the drive root that nothing else owns. Returned so the
 * suite can remove exactly what it caused and nothing else.
 */
function bogusTopLevelFor(msysPath: string): string {
  return path.join(path.parse(process.cwd()).root, msysPath.split("/")[1] ?? "");
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "msys-sites-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (err) {
    // Windows can still hold a handle on a just-written fixture file (EPERM).
    // The fixture is a mkdtemp dir the OS reclaims; leaking it must not fail the
    // assertion it follows.
    console.error(`[msys-drive-path-sites] fixture cleanup failed for ${root}: ${(err as Error)?.message}`);
  }
});

describe("bash setCwd — the tool cwd every later relative path resolves against", () => {
  it.runIf(WIN32)("REGRESSION: an MSYS-spelled REAL directory is accepted and lands on the drive it names", () => {
    const real = path.join(root, "workspace");
    mkdirSync(real, { recursive: true });
    const bash = new BashTool(root);

    bash.setCwd(toMsys(real));

    expect(bash.getCwd()).toBe(real);
  });

  it.runIf(WIN32)("the existence check still rejects an MSYS spelling of a directory that does NOT exist", () => {
    const missing = path.join(root, "no-such-dir");
    const bash = new BashTool(root);

    // The refusal must name the resolved location, not the spelling, so the
    // reader is not sent looking for a drive-relative path that was never used.
    expect(() => bash.setCwd(toMsys(missing))).toThrow(`setCwd: path does not exist: ${missing}`);
    expect(bash.getCwd()).toBe(root);
  });

  it("a native absolute directory is still accepted verbatim on every platform", () => {
    const real = path.join(root, "workspace");
    mkdirSync(real, { recursive: true });
    const bash = new BashTool(root);

    bash.setCwd(real);

    expect(bash.getCwd()).toBe(real);
  });

  it("a RELATIVE path is still refused on every platform", () => {
    const bash = new BashTool(root);

    expect(() => bash.setCwd(path.join("some", "relative", "dir"))).toThrow(/setCwd: path must be absolute/);
    expect(bash.getCwd()).toBe(root);
  });

  it.runIf(!WIN32)("on POSIX a /d/... spelling stays an ordinary absolute path — not a drive", () => {
    const bash = new BashTool(root);

    // Unchanged behaviour: nothing exists at the filesystem root under that
    // name, so the SAME existence check refuses it. It is not reinterpreted as
    // drive D.
    expect(() => bash.setCwd("/d/muonroi-no-such-top-level-dir")).toThrow(
      "setCwd: path does not exist: /d/muonroi-no-such-top-level-dir",
    );
  });
});

describe("grep search root — an empty result is the most dangerous wrong answer", () => {
  const NEEDLE = "MSYS_NEEDLE_SENTINEL";

  function seed(): string {
    const pkg = path.join(root, "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "a.txt"), `${NEEDLE} here\n`);
    return pkg;
  }

  it.runIf(WIN32)("REGRESSION: an MSYS-spelled search root finds the same matches as the native spelling", async () => {
    const pkg = seed();

    const native = await executeGrep({ pattern: NEEDLE, path: pkg }, root);
    const msys = await executeGrep({ pattern: NEEDLE, path: toMsys(pkg) }, root);

    // The control: the native spelling really does find it.
    expect(native.output).toContain("Found 1 matches");
    // Before the fix this was `No matches found.` — success:true, zero matches,
    // no hint that the search root never resolved.
    expect(msys.output).toContain("Found 1 matches");
    expect(msys.output).toContain(NEEDLE);
    expect(msys.output).not.toContain("No matches found.");
  });

  it.runIf(WIN32)("an MSYS-spelled single FILE target is searched, not silently skipped", async () => {
    const file = path.join(seed(), "a.txt");

    const res = await executeGrep({ pattern: NEEDLE, path: toMsys(file) }, root);

    expect(res.output).toContain("Found 1 matches");
  });

  it("a native absolute search root and a relative one still work on every platform", async () => {
    const pkg = seed();

    const abs = await executeGrep({ pattern: NEEDLE, path: pkg }, root);
    const rel = await executeGrep({ pattern: NEEDLE, path: "pkg" }, root);

    expect(abs.output).toContain("Found 1 matches");
    expect(rel.output).toContain("Found 1 matches");
  });

  it("a genuinely absent needle still reports no matches — the normalisation invents nothing", async () => {
    seed();

    const res = await executeGrep({ pattern: "MSYS_NEEDLE_THAT_IS_NOT_THERE", path: root }, root);

    expect(res.success).toBe(true);
    expect(res.output).toContain("No matches found.");
  });
});

describe("computer screenshot output path", () => {
  /** Single-letter root dirs this suite may have caused; removed only if it created them. */
  const bogusRoots = new Map<string, boolean>();

  function noteBogus(msysPath: string): string {
    const top = bogusTopLevelFor(msysPath);
    if (!bogusRoots.has(top)) bogusRoots.set(top, existsSync(top));
    return top;
  }

  beforeAll(() => {
    bogusRoots.clear();
  });

  afterAll(() => {
    // The pre-fix code creates `<cwd drive>:\<letter>\...`. Remove it ONLY when
    // this suite observed it absent beforehand, so a real directory that happens
    // to share the name is never touched.
    for (const [top, existedBefore] of bogusRoots) {
      if (existedBefore || !existsSync(top)) continue;
      try {
        rmSync(top, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch (err) {
        console.error(`[msys-drive-path-sites] could not remove stray tree ${top}: ${(err as Error)?.message}`);
      }
    }
    bogusRoots.clear();
  });

  it.runIf(WIN32)("REGRESSION: an MSYS-spelled output path resolves to the drive it names", () => {
    const want = path.join(root, "shots", "s.png");
    const spelled = toMsys(want);
    const bogus = noteBogus(spelled);

    const got = buildScreenshotPath(root, spelled);

    // Before the fix `got` was the MSYS string verbatim — not even run through
    // `resolve` — and the directory that got created was the bogus one.
    expect(got).toBe(want);
    expect(existsSync(path.dirname(want))).toBe(true);
    expect(existsSync(path.join(bogus, ...spelled.split("/").slice(2, -1)))).toBe(false);
  });

  it("a native absolute output path and a relative one still resolve as before", () => {
    const want = path.join(root, "shots", "native.png");

    expect(buildScreenshotPath(root, want)).toBe(want);
    expect(buildScreenshotPath(root, path.join("shots", "rel.png"))).toBe(path.join(root, "shots", "rel.png"));
  });

  it("the default artifact path is untouched by the normalisation", () => {
    const got = buildScreenshotPath(root);

    expect(path.isAbsolute(got)).toBe(true);
    expect(got.startsWith(root)).toBe(true);
  });
});
