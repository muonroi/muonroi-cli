import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDeliverableReport, conversionTarget, goalRequiresCommit } from "../deliverable-gate.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  });
}

const dirs: string[] = [];
function makeRepo(): { cwd: string; base: string } {
  const cwd = mkdtempSync(join(tmpdir(), "deliverable-gate-"));
  dirs.push(cwd);
  git(cwd, "init", "-q");
  writeFileSync(join(cwd, "README.md"), "# repo\n");
  git(cwd, "add", "-A");
  // Dated two hours back so "commits since the run start" does not count the fixture's own base commit.
  const old = new Date(Date.now() - 7_200_000).toISOString();
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "base"], {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
  });
  return { cwd, base: git(cwd, "rev-parse", "HEAD").trim() };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const COMMIT_GOAL = "Convert the docs. Commit message tiếng Việt theo AGENTS.md";

describe("goalRequiresCommit", () => {
  it("finds a commit request in English and Vietnamese", () => {
    expect(goalRequiresCommit(["Do the work then commit the result."])).toMatch(/commit the result/);
    expect(goalRequiresCommit([COMMIT_GOAL])).toMatch(/Commit message/);
  });
  it("ignores negated, historical and absent mentions", () => {
    expect(goalRequiresCommit(["Do not commit anything."])).toBeNull();
    expect(goalRequiresCommit(["Please don't commit, just edit."])).toBeNull();
    expect(goalRequiresCommit(["Không commit, chỉ sửa file."])).toBeNull();
    expect(goalRequiresCommit(["Look at the last commit for context."])).toBeNull();
    expect(goalRequiresCommit(["Fix the uncommitted changes bug and the commit hooks."])).toBeNull();
    expect(goalRequiresCommit(["Build the feature."])).toBeNull();
  });
});

describe("collectDeliverableReport: commit requirement", () => {
  it("refuses a commit-required goal with 0 commits since the base, naming the reason", () => {
    const { cwd, base } = makeRepo();
    mkdirSync(join(cwd, "out"));
    writeFileSync(join(cwd, "out", "a.md"), "doc\n");
    const r = collectDeliverableReport({ cwd, goalTexts: [COMMIT_GOAL], baseCommit: base, writtenPaths: ["out/a.md"] });
    expect(r.commits?.count).toBe(0);
    expect(r.refusals.join("\n")).toMatch(/0 commits since base commit/);
    expect(r.refusals.join("\n")).toContain("out/a.md");
    expect(r.evidence).toContain("HOST VERDICT");
  });

  it("refuses untracked written deliverables even after an unrelated commit", () => {
    const { cwd, base } = makeRepo();
    writeFileSync(join(cwd, "other.txt"), "x\n");
    git(cwd, "add", "other.txt");
    git(cwd, "commit", "-q", "-m", "other");
    writeFileSync(join(cwd, "a.md"), "doc\n");
    const r = collectDeliverableReport({
      cwd,
      goalTexts: [COMMIT_GOAL],
      baseCommit: base,
      writtenPaths: [join(cwd, "a.md")],
    });
    expect(r.commits?.count).toBe(1);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatch(/untracked: a\.md/);
  });

  it("refuses ignored deliverables whether or not a commit is required", () => {
    const { cwd, base } = makeRepo();
    writeFileSync(join(cwd, ".gitignore"), "/docs\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-q", "-m", "ignore docs");
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "guide.md"), "doc\n");
    const r = collectDeliverableReport({
      cwd,
      goalTexts: ["Write the guide."],
      baseCommit: base,
      writtenPaths: ["docs/guide.md"],
    });
    expect(r.ignored).toEqual(["docs/guide.md"]);
    expect(r.refusals.join("\n")).toMatch(/ignored by git.*docs\/guide\.md/);
  });

  it("allows commits present and every written deliverable tracked and clean", () => {
    const { cwd, base } = makeRepo();
    writeFileSync(join(cwd, "a.md"), "doc\n");
    git(cwd, "add", "a.md");
    git(cwd, "commit", "-q", "-m", "docs");
    const r = collectDeliverableReport({ cwd, goalTexts: [COMMIT_GOAL], baseCommit: base, writtenPaths: ["a.md"] });
    expect(r.commits?.count).toBe(1);
    expect(r.refusals).toEqual([]);
    expect(r.evidence).toContain("no unmet deliverable requirement");
  });

  it("refuses a written tracked file that still has uncommitted edits when a commit is required", () => {
    const { cwd, base } = makeRepo();
    writeFileSync(join(cwd, "a.md"), "v1\n");
    git(cwd, "add", "a.md");
    git(cwd, "commit", "-q", "-m", "docs");
    writeFileSync(join(cwd, "a.md"), "v2\n");
    const r = collectDeliverableReport({ cwd, goalTexts: [COMMIT_GOAL], baseCommit: base, writtenPaths: ["a.md"] });
    expect(r.refusals.join("\n")).toMatch(/uncommitted changes: a\.md/);
  });

  it("does not demand tracking when the goal never asked for a commit", () => {
    const { cwd, base } = makeRepo();
    writeFileSync(join(cwd, "new.md"), "doc\n");
    const r = collectDeliverableReport({
      cwd,
      goalTexts: ["Write new.md"],
      baseCommit: base,
      writtenPaths: ["new.md"],
    });
    expect(r.untracked).toContain("new.md");
    expect(r.refusals).toEqual([]);
  });

  it("falls back to the run start time and finds shell-created untracked files newer than it", () => {
    const { cwd } = makeRepo();
    const start = new Date(Date.now() - 60_000);
    writeFileSync(join(cwd, "made-by-bash.md"), "doc\n");
    writeFileSync(join(cwd, "old.md"), "doc\n");
    utimesSync(join(cwd, "old.md"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const r = collectDeliverableReport({
      cwd,
      goalTexts: [COMMIT_GOAL],
      sinceIso: start.toISOString(),
      writtenPaths: [],
    });
    expect(r.commits?.basis).toMatch(/run start/);
    expect(r.untracked).toEqual(["made-by-bash.md"]);
    expect(r.refusals.join("\n")).toMatch(/0 commits since run start/);
  });

  it("measures nothing and refuses nothing outside a git repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "deliverable-nogit-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "a.md"), "doc\n");
    const r = collectDeliverableReport({ cwd, goalTexts: [COMMIT_GOAL], baseCommit: "abc", writtenPaths: ["a.md"] });
    expect(r.gitAvailable).toBe(false);
    expect(r.refusals).toEqual([]);
    expect(r.evidence).toContain("git: unavailable");
  });

  it("ignores host-owned state trees", () => {
    const { cwd, base } = makeRepo();
    mkdirSync(join(cwd, ".planning"));
    writeFileSync(join(cwd, ".planning", "PLAN.md"), "# plan\n");
    const r = collectDeliverableReport({
      cwd,
      goalTexts: [COMMIT_GOAL],
      baseCommit: base,
      writtenPaths: [".planning/PLAN.md"],
    });
    expect(r.untracked).toEqual([]);
  });
});

describe("conversion deliverable fidelity through the report", () => {
  const SOURCE = `<html><body><h1>Tenant guide</h1><p>The tenant_id column identifies every tenant row across all of the services.</p>
<p>Use the <code>List&lt;Tenant&gt;</code> type when you enumerate tenants from the repository layer.</p></body></html>`;

  it("finds the source in the goal, probes the written markdown and refuses on escape residue", () => {
    const { cwd, base } = makeRepo();
    writeFileSync(join(cwd, "doc.html"), SOURCE);
    writeFileSync(
      join(cwd, "out.md"),
      "# Tenant guide\n\nThe tenant\\_id column identifies every tenant row across all of the services.\n\nUse the `List&lt;Tenant&gt;` type when you enumerate tenants from the repository layer.\n",
    );
    const r = collectDeliverableReport({
      cwd,
      goalTexts: ["Convert doc.html into markdown docs"],
      baseCommit: base,
      writtenPaths: ["out.md"],
    });
    expect(r.fidelity?.source).toBe("doc.html");
    const text = r.refusals.join("\n");
    expect(text).toContain("fidelity probe");
    expect(text).toContain("\\_");
    expect(text).toContain("&lt;");
    expect(r.evidence).toContain("fidelity probe: FAIL");
  });

  it("does not probe a non-conversion goal that merely mentions a source file", () => {
    const { cwd } = makeRepo();
    writeFileSync(join(cwd, "doc.html"), SOURCE);
    writeFileSync(join(cwd, "summary.md"), "short summary\n");
    expect(conversionTarget(cwd, ["Summarise doc.html"], [join(cwd, "summary.md")])).toBeNull();
    expect(conversionTarget(cwd, ["Convert doc.html to markdown"], [join(cwd, "summary.md")])?.source).toBe(
      join(cwd, "doc.html"),
    );
  });
});
