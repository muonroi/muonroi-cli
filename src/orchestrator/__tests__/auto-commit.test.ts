import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LspDiagnostic, LspDiagnosticFile } from "../../lsp/types.js";
import {
  blockingErrorsForFile,
  buildFileListSubject,
  isAutoCommitEnabled,
  isCliArtifactPath,
  isCommitGateEnabled,
  isExcludedPath,
  isSensitivePath,
  parsePorcelainPaths,
  pathsForCommitGate,
  splitCommitMessage,
} from "../auto-commit.js";

function diag(severity: number | undefined): LspDiagnostic {
  return {
    message: "x",
    severity,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  } as LspDiagnostic;
}
function diagFile(filePath: string, severities: Array<number | undefined>): LspDiagnosticFile {
  return { filePath, serverId: "ts", diagnostics: severities.map(diag) };
}

describe("auto-commit pure helpers", () => {
  it("parses porcelain output incl. rename + quoted paths", () => {
    const out = ' M src/a.ts\n?? new file.txt\nR  old.ts -> src/b.ts\nA  "with space.ts"\n';
    const set = parsePorcelainPaths(out);
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("new file.txt")).toBe(true);
    // rename keeps ONLY the new path
    expect(set.has("src/b.ts")).toBe(true);
    expect(set.has("old.ts")).toBe(false);
    // quoted path with a space is unquoted
    expect(set.has("with space.ts")).toBe(true);
  });

  it("flags sensitive paths and lets normal source through", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath("config/app.key")).toBe(true);
    expect(isSensitivePath("certs/server.pem")).toBe(true);
    expect(isSensitivePath("src/db-secret.ts")).toBe(true);
    // .muonroi-cli/ is categorized as a CLI artifact (excluded), not a "secret".
    expect(isSensitivePath(".muonroi-cli/state.json")).toBe(false);
    expect(isExcludedPath(".muonroi-cli/state.json")).toBe(true);
    expect(isSensitivePath("src/index.ts")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
  });

  it("excludes CLI-generated artifacts + build junk (the 11-file-leak fix)", () => {
    expect(isCliArtifactPath(".muonroi-flow/state.md")).toBe(true);
    expect(isCliArtifactPath(".muonroi-flow/runs/abc/manifest.md")).toBe(true);
    expect(isCliArtifactPath(".muonroi-cli/session.db")).toBe(true);
    expect(isCliArtifactPath(".muonroi-harness-roots.json")).toBe(true);
    expect(isCliArtifactPath("node_modules/x/index.js")).toBe(true);
    expect(isCliArtifactPath("dist/bundle.js")).toBe(true);
    expect(isCliArtifactPath("debug.log")).toBe(true);
    expect(isCliArtifactPath("src/greeting.txt")).toBe(false);
    // isExcludedPath unions secrets + artifacts
    expect(isExcludedPath(".env")).toBe(true);
    expect(isExcludedPath(".muonroi-flow/state.md")).toBe(true);
    expect(isExcludedPath("greeting.txt")).toBe(false);
  });

  it("backstop subject lists files + stays bounded (never the raw prompt)", () => {
    expect(buildFileListSubject(["src/a.ts", "src/b.ts"])).toBe("chore: update 2 file(s) — a.ts, b.ts");
    expect(buildFileListSubject(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])).toContain("+2 more");
    expect(buildFileListSubject(Array.from({ length: 20 }, (_, i) => `file${i}.ts`)).length).toBeLessThanOrEqual(72);
  });

  it("splits an agent-authored message: subject <=72, body kept, attribution deduped", () => {
    expect(splitCommitMessage("feat: add X\r\n\r\nbody line")).toEqual({ subject: "feat: add X", body: "body line" });
    expect(splitCommitMessage("x".repeat(200)).subject.length).toBeLessThanOrEqual(72);
    // an attribution the agent already added is dropped (we append exactly one)
    expect(splitCommitMessage("feat: y\nCoding by - Muonroi-CLI")).toEqual({ subject: "feat: y", body: "" });
  });

  it("is disabled under the unit-test runner so the suite never commits", () => {
    // VITEST is set while this runs → must be false regardless of MUONROI_AUTO_COMMIT.
    expect(isAutoCommitEnabled()).toBe(false);
  });
});

describe("G1 commit quality gate", () => {
  it("commit gate is disabled under the unit-test runner (specs commit fixtures freely)", () => {
    // Mirrors isAutoCommitEnabled — VITEST is set, so the gate must be off here.
    expect(isCommitGateEnabled()).toBe(false);
  });

  describe("blockingErrorsForFile — errors-only + per-file scope", () => {
    it("returns severity-1 (error) diagnostics for the staged file", () => {
      const abs = resolve("foo.ts");
      const errs = blockingErrorsForFile([diagFile("foo.ts", [1, 1])], abs);
      expect(errs).toHaveLength(2);
    });

    it("treats a missing severity as an error (LSP default is 1)", () => {
      const abs = resolve("foo.ts");
      expect(blockingErrorsForFile([diagFile("foo.ts", [undefined])], abs)).toHaveLength(1);
    });

    it("ignores warnings/infos (severity >= 2) — they never block a commit", () => {
      const abs = resolve("foo.ts");
      expect(blockingErrorsForFile([diagFile("foo.ts", [2, 3, 4])], abs)).toHaveLength(0);
    });

    it("ignores errors reported against a DIFFERENT file (cross-file breakage doesn't block)", () => {
      const abs = resolve("foo.ts");
      // An error on other.ts must not block a commit of foo.ts.
      expect(blockingErrorsForFile([diagFile("other.ts", [1, 1])], abs)).toHaveLength(0);
    });

    it("mixes: keeps only this file's errors out of a multi-file, multi-severity set", () => {
      const abs = resolve("foo.ts");
      const errs = blockingErrorsForFile([diagFile("foo.ts", [1, 2, 3]), diagFile("bar.ts", [1, 1])], abs);
      expect(errs).toHaveLength(1); // only foo.ts's single severity-1
    });

    it("empty diagnostics → no blockers (non-source / no-LSP-server files pass)", () => {
      expect(blockingErrorsForFile([], resolve("README.md"))).toEqual([]);
    });
  });
});

describe("pathsForCommitGate — bash `git commit` gate path set (real git)", () => {
  let dir: string;
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "commit-gate-"));
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.t"]);
    g(["config", "user.name", "t"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns only the already-staged set for a plain `git commit`", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    g(["add", "a.ts"]); // b.ts left untracked
    const paths = await pathsForCommitGate(dir, { broadAdd: false, commitAll: false });
    expect(paths).toEqual(["a.ts"]);
  });

  it("adds tracked modifications that `git commit -a` will auto-stage", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    g(["add", "a.ts"]);
    g(["commit", "-qm", "init", "--no-verify"]); // temp fixture repo — hook-free by design
    writeFileSync(join(dir, "a.ts"), "export const a = 99;\n"); // modify tracked, NOT re-staged

    // plain commit sees nothing staged; commit -a includes the modification.
    expect(await pathsForCommitGate(dir, { broadAdd: false, commitAll: false })).toEqual([]);
    expect(await pathsForCommitGate(dir, { broadAdd: false, commitAll: true })).toContain("a.ts");
  });

  it("includes the whole working tree for a chained broad `git add -A` (add not yet run)", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n"); // untracked
    writeFileSync(join(dir, "c.ts"), "export const c = 3;\n"); // untracked
    // Nothing staged at pre-exec time → plain set is empty…
    expect(await pathsForCommitGate(dir, { broadAdd: false, commitAll: false })).toEqual([]);
    // …but `git add -A` would stage both, so the broad path enumerates them.
    const broad = await pathsForCommitGate(dir, { broadAdd: true, commitAll: false });
    expect(broad).toContain("a.ts");
    expect(broad).toContain("c.ts");
  });
});
