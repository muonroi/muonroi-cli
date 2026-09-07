/**
 * Containment for agent file writes — see src/tools/write-scope.ts.
 *
 * The fixture reproduces the SHAPE of both production escapes on a throwaway
 * temp tree: a parent git checkout with a nested LINKED worktree, a run pinned
 * to the nested worktree, and a `cd` out of it followed by a write.
 *
 * Real `git worktree add` is not used: it needs a git binary, a commit, and is
 * slow. What the guard actually reads is the `.git` entry shape — a DIRECTORY
 * for a normal checkout, a FILE containing `gitdir: ...` for a linked worktree
 * (verified on the real tree: `.wt-sprint/.git` is a 62-byte file holding
 * `gitdir: D:/sources/Core/muonroi-cli/.git/worktrees/-wt-sprint`). Those two
 * shapes are created directly.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCommitRunRoot } from "../../orchestrator/auto-commit.js";
import { editFile, writeFile } from "../file.js";
import { FileTracker } from "../file-tracker.js";
import { checkWriteScope, describeCwdDrift, resetWorktreeCache } from "../write-scope.js";

let root: string;
/** Parent repo (`.git` DIRECTORY) — stands in for D:\sources\Core\muonroi-cli. */
let parentRepo: string;
/** Nested linked worktree (`.git` FILE) — stands in for `<repo>/.wt-sprint`. */
let nestedWorktree: string;
/** A sibling repo next to the parent — stands in for D:\sources\Core\<other>. */
let siblingRepo: string;

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "write-scope-")));

  parentRepo = path.join(root, "workspace", "parent-repo");
  mkdirSync(path.join(parentRepo, ".git"), { recursive: true });
  mkdirSync(path.join(parentRepo, "src", "headless"), { recursive: true });
  writeFileSync(path.join(parentRepo, "src", "headless", "output.ts"), "export const control = 1;\n");

  nestedWorktree = path.join(parentRepo, ".wt-sprint");
  mkdirSync(path.join(nestedWorktree, "src"), { recursive: true });
  writeFileSync(path.join(nestedWorktree, ".git"), `gitdir: ${parentRepo}/.git/worktrees/-wt-sprint\n`);
  writeFileSync(path.join(nestedWorktree, "src", "sprint.ts"), "export const x = 1;\n");

  siblingRepo = path.join(root, "workspace", "sibling-repo");
  mkdirSync(path.join(siblingRepo, ".git"), { recursive: true });
  mkdirSync(path.join(siblingRepo, "src"), { recursive: true });
  writeFileSync(path.join(siblingRepo, "src", "lib.ts"), "export const y = 1;\n");

  resetWorktreeCache();
  setEnv("MUONROI_WRITE_SCOPE", undefined);
  setEnv("MUONROI_WRITE_SCOPE_ROOTS", undefined);
});

afterEach(() => {
  setCommitRunRoot(null);
  resetWorktreeCache();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    // Windows: writeFile() hands the file to the LSP runtime, which can still
    // hold a handle when the test ends (EPERM). The fixture is a mkdtemp dir —
    // leaking it is harmless and must not fail the assertion it follows.
    console.error(`[write-scope.test] fixture cleanup failed for ${root}: ${(err as Error)?.message}`);
  }
});

/** A tracker that has already "read" `abs`, so the read-before-write gate passes. */
function trackerHavingRead(abs: string): FileTracker {
  const t = new FileTracker();
  t.markRead(abs, readFileSync(abs, "utf-8"), 0);
  return t;
}

describe("the escape this guard exists for", () => {
  it("REPRODUCTION: a run pinned to the nested worktree writes into the parent repo when unguarded", async () => {
    // MUONROI_WRITE_SCOPE=0 restores the exact pre-fix behaviour: BashTool's cwd
    // has drifted to the parent repo via `cd`, and a RELATIVE edit_file path now
    // resolves there. This is escape #2, verbatim in shape.
    setEnv("MUONROI_WRITE_SCOPE", "0");
    setCommitRunRoot(nestedWorktree);
    const driftedCwd = parentRepo; // what `cd <parent>` left in BashTool.cwd
    const victim = path.join(parentRepo, "src", "headless", "output.ts");

    const res = await editFile(
      "src/headless/output.ts",
      "export const control = 1;",
      "export const control = 999;",
      driftedCwd,
      trackerHavingRead(victim),
    );

    expect(res.success).toBe(true);
    // The control file was mutated OUTSIDE the run's directory.
    expect(readFileSync(victim, "utf-8")).toContain("999");
  });

  it("CONTAINED: the same edit is refused, loudly, with the guard on", async () => {
    setCommitRunRoot(nestedWorktree);
    const victim = path.join(parentRepo, "src", "headless", "output.ts");
    const before = readFileSync(victim, "utf-8");

    const res = await editFile(
      "src/headless/output.ts",
      "export const control = 1;",
      "export const control = 999;",
      parentRepo,
      trackerHavingRead(victim),
    );

    expect(res.success).toBe(false);
    expect(res.output).toContain("BLOCKED (write-scope)");
    expect(res.output).toContain("Nothing was written");
    expect(res.output).toContain(nestedWorktree);
    // Loud, not silent: the message names the resolved target too.
    expect(res.output).toContain(victim);
    expect(readFileSync(victim, "utf-8")).toBe(before);
  });

  it("CONTAINED: write_file cannot create a new file outside the run root either", async () => {
    setCommitRunRoot(nestedWorktree);
    const victim = path.join(parentRepo, "src", "headless", "output.test.ts");

    const res = await writeFile("src/headless/output.test.ts", "// +65 lines\n", parentRepo, new FileTracker());

    expect(res.success).toBe(false);
    expect(res.output).toContain("BLOCKED (write-scope)");
    expect(existsSync(victim)).toBe(false);
  });

  it("CONTAINED: an ABSOLUTE path bypasses the tool cwd but not the guard", async () => {
    setCommitRunRoot(nestedWorktree);
    const victim = path.join(parentRepo, "src", "headless", "output.ts");

    // cwd is the run root here — the escape is entirely in the argument.
    const res = await writeFile(victim, "pwned\n", nestedWorktree, trackerHavingRead(victim));

    expect(res.success).toBe(false);
    expect(res.output).toContain("BLOCKED (write-scope)");
    expect(readFileSync(victim, "utf-8")).not.toContain("pwned");
  });

  it("CONTAINED: a relative ../ traversal is refused", async () => {
    setCommitRunRoot(nestedWorktree);
    // From <worktree>/src, "../.." reaches the PARENT repo.
    const res = await writeFile(
      "../../src/headless/evil.ts",
      "x\n",
      path.join(nestedWorktree, "src"),
      new FileTracker(),
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("BLOCKED (write-scope)");
    expect(existsSync(path.join(parentRepo, "src", "headless", "evil.ts"))).toBe(false);
  });
});

describe("ordinary use keeps working", () => {
  it("a write in the run root itself is allowed", async () => {
    setCommitRunRoot(nestedWorktree);
    const res = await writeFile("src/new.ts", "export const n = 1;\n", nestedWorktree, new FileTracker());
    expect(res.success).toBe(true);
    expect(existsSync(path.join(nestedWorktree, "src", "new.ts"))).toBe(true);
  });

  it("`cd` into a SUB-directory of the run root keeps writes working and raises no warning", async () => {
    setCommitRunRoot(nestedWorktree);
    const sub = path.join(nestedWorktree, "src");
    expect(describeCwdDrift(sub)).toBeNull();
    const res = await writeFile("deep/nested.ts", "export const d = 1;\n", sub, new FileTracker());
    expect(res.success).toBe(true);
    expect(existsSync(path.join(sub, "deep", "nested.ts"))).toBe(true);
  });

  it("an ordinary unpinned session writing inside its own repo is unaffected", async () => {
    // No `-d`, no worktree: run root is just the repo the user launched in.
    setCommitRunRoot(parentRepo);
    const res = await writeFile(
      "src/headless/output.ts",
      "export const control = 2;\n",
      parentRepo,
      trackerHavingRead(path.join(parentRepo, "src", "headless", "output.ts")),
    );
    expect(res.success).toBe(true);
  });

  it("CROSS-REPO: launched at the ecosystem root (not a git repo), sibling repos are writable", async () => {
    // This is the real workspace shape: D:\sources\Core is NOT a git repository
    // (`git rev-parse --show-toplevel` -> "fatal: not a git repository"), so every
    // sibling repo is a child of the run root and cross-repo work is unaffected.
    const workspace = path.join(root, "workspace");
    expect(existsSync(path.join(workspace, ".git"))).toBe(false);
    setCommitRunRoot(workspace);

    const a = await writeFile(
      "sibling-repo/src/lib.ts",
      "export const y = 2;\n",
      workspace,
      trackerHavingRead(path.join(siblingRepo, "src", "lib.ts")),
    );
    expect(a.success).toBe(true);

    const b = await writeFile("parent-repo/src/headless/new.ts", "x\n", workspace, new FileTracker());
    expect(b.success).toBe(true);
    // …and no drift warning for moving between them.
    expect(describeCwdDrift(siblingRepo)).toBeNull();
  });

  it("CROSS-REPO: launched inside one repo, a sibling is refused until opted in", async () => {
    setCommitRunRoot(parentRepo);
    const target = path.join(siblingRepo, "src", "lib.ts");

    const refused = await writeFile(target, "z\n", parentRepo, trackerHavingRead(target));
    expect(refused.success).toBe(false);
    expect(refused.output).toContain("BLOCKED (write-scope)");

    // MUONROI_WRITE_SCOPE_ROOTS mirrors MUONROI_HARNESS_EXTRA_ROOTS.
    setEnv("MUONROI_WRITE_SCOPE_ROOTS", siblingRepo);
    const allowed = await writeFile(target, "z\n", parentRepo, trackerHavingRead(target));
    expect(allowed.success).toBe(true);
  });

  it("the OS temp dir is always writable (scratch files are not work product)", async () => {
    setCommitRunRoot(nestedWorktree);
    const scratch = path.join(root, "scratch.txt"); // root is under tmpdir()
    const res = await writeFile(scratch, "tmp\n", nestedWorktree, new FileTracker());
    expect(res.success).toBe(true);
  });

  it("MUONROI_WRITE_SCOPE=0 is the user escape hatch", async () => {
    setCommitRunRoot(nestedWorktree);
    setEnv("MUONROI_WRITE_SCOPE", "0");
    const target = path.join(parentRepo, "src", "headless", "output.ts");
    const res = await writeFile(target, "bypassed\n", nestedWorktree, trackerHavingRead(target));
    expect(res.success).toBe(true);
  });
});

describe("repo identity (the nested-worktree case containment alone misses)", () => {
  it("from the parent repo, writing INTO the nested linked worktree is refused", async () => {
    // Path containment would allow this — .wt-sprint is *inside* the run root —
    // but it is a different worktree, owning different history. This is escape
    // #1/#2 in reverse, and it is what protects a nested experiment worktree.
    setCommitRunRoot(parentRepo);
    const target = path.join(nestedWorktree, "src", "sprint.ts");
    const res = await writeFile(target, "clobbered\n", parentRepo, trackerHavingRead(target));
    expect(res.success).toBe(false);
    expect(res.output).toContain("DIFFERENT git worktree");
    expect(readFileSync(target, "utf-8")).not.toContain("clobbered");
  });

  it("an outside-run-root refusal still reports the target's real worktree", () => {
    // The refusal LOG prints this field; reporting "<none>" for a path plainly
    // inside a checkout would be a lie in the one record an operator reads.
    setCommitRunRoot(nestedWorktree);
    const v = checkWriteScope(path.join(parentRepo, "src", "headless", "output.ts"));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("outside-run-root");
    expect(v.runWorktree).toBe(nestedWorktree);
    expect(v.targetWorktree).toBe(parentRepo);
  });

  it("verdict fields report both worktrees for a foreign-worktree refusal", () => {
    setCommitRunRoot(parentRepo);
    const v = checkWriteScope(path.join(nestedWorktree, "src", "sprint.ts"));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("foreign-worktree");
    expect(v.runWorktree).toBe(parentRepo);
    expect(v.targetWorktree).toBe(nestedWorktree);
  });
});

describe("cd drift is warned about, not refused", () => {
  it("warns when the cwd leaves the run root", () => {
    setCommitRunRoot(nestedWorktree);
    const warning = describeCwdDrift(parentRepo);
    expect(warning).toContain("WARNING (write-scope)");
    expect(warning).toContain("will be REFUSED");
    expect(warning).toContain(nestedWorktree);
  });

  it("warns when the cwd enters a different worktree that is still inside the run root", () => {
    setCommitRunRoot(parentRepo);
    expect(describeCwdDrift(nestedWorktree)).toContain("DIFFERENT git worktree");
  });

  it("says nothing when the guard is off", () => {
    setCommitRunRoot(nestedWorktree);
    setEnv("MUONROI_WRITE_SCOPE", "0");
    expect(describeCwdDrift(parentRepo)).toBeNull();
  });
});
