import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectChangedFiles, extractSemanticHits, planScenarios } from "../scenario-planner.js";

describe("scenario-planner", () => {
  describe("extractSemanticHits", () => {
    it("extracts id+role from simple Semantic", () => {
      const src = `<Semantic id="composer" role="textbox" name="Prompt">`;
      const hits = extractSemanticHits(src, "x.tsx");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        id: "composer",
        role: "textbox",
        name: "Prompt",
        file: "x.tsx",
      });
    });

    it("detects isModal boolean shorthand", () => {
      const src = `<Semantic id="modal-x" role="dialog" name="X" isModal>`;
      const hits = extractSemanticHits(src, "y.tsx");
      expect(hits[0]?.isModal).toBe(true);
    });

    it("extracts template-literal ids", () => {
      const src = '<Semantic id={`ideal-phase-cost`} role="listitem">';
      const hits = extractSemanticHits(src, "z.tsx");
      expect(hits[0]?.id).toBe("ideal-phase-cost");
    });

    it("records line numbers", () => {
      const src = `\n\n<Semantic id="a" role="region">\n`;
      const hits = extractSemanticHits(src, "f.tsx");
      expect(hits[0]?.line).toBe(3);
    });

    it("handles multiple hits in one file", () => {
      const src = `
        <Semantic id="one" role="textbox">
        <Semantic id="two" role="button">
      `;
      const hits = extractSemanticHits(src, "f.tsx");
      expect(hits.map((h) => h.id)).toEqual(["one", "two"]);
    });
  });

  describe("planScenarios", () => {
    it("returns smoke-boot only when no files changed", () => {
      const scn = planScenarios({ diffFilesOverride: [] });
      expect(scn).toHaveLength(1);
      expect(scn[0]?.id).toBe("smoke-boot");
    });

    it("includes smoke-boot first when scenarios derived from hits", () => {
      // Use this very test file as a probe — it has no Semantic but we can
      // exercise the path by passing extraFiles pointing at a real UI file.
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/components/halt-recovery-card.tsx"],
      });
      expect(scn[0]?.id).toBe("smoke-boot");
      // halt-recovery-card has 1 Semantic (id=ideal-halt-card role=dialog)
      const ids = scn.map((s) => s.id);
      expect(ids.some((id) => id.startsWith("dialog-ideal-halt-card"))).toBe(true);
    });

    it("respects maxScenarios cap", () => {
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/components/init-new-form-card.tsx"],
        maxScenarios: 2,
      });
      expect(scn.length).toBeLessThanOrEqual(2);
    });

    it("textbox scenario types probe text and asserts idle", () => {
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/agents-modal.tsx"],
        maxScenarios: 6,
      });
      const textboxScn = scn.find((s) => s.id.startsWith("textbox-"));
      expect(textboxScn).toBeDefined();
      const typeStep = textboxScn?.steps.find((s) => s.op === "type");
      expect(typeStep).toMatchObject({ op: "type" });
    });

    // The wiring that lets the judge say "the child never became ready" instead
    // of blaming the change under test. Without `guard: true` on the mount wait,
    // a transient boot failure is reported as a failed assertion — see
    // ScenarioRun.mounted and judge.ts.
    it("marks the mount wait as the readiness gate on every driven surface scenario", () => {
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/agents-modal.tsx"],
        maxScenarios: 8,
      }).filter((s) => s.reachable !== false && s.id !== "smoke-boot");

      expect(scn.length).toBeGreaterThan(0);
      for (const s of scn) {
        const guards = s.steps.filter((step) => step.op === "wait_for" && step.guard === true);
        expect(guards, `${s.id} must have exactly one readiness gate`).toHaveLength(1);
        expect(guards[0]).toMatchObject({ op: "wait_for", selector: "role=textbox" });
      }
    });

    // smoke-boot's readiness condition IS its assertion (it waits for idle and
    // then asserts idleReached), so marking it as a gate would excuse a genuine
    // "the CLI did not boot" as un-driveable.
    it("does NOT mark smoke-boot's idle wait as a readiness gate", () => {
      const smoke = planScenarios({ diffFilesOverride: [], maxScenarios: 4 }).find((s) => s.id === "smoke-boot");
      expect(smoke).toBeDefined();
      expect(smoke?.steps.some((step) => step.op === "wait_for" && step.guard === true)).toBe(false);
    });
  });

  describe("collectChangedFiles (round 13: union of committed + working-tree diff)", () => {
    let repo: string;

    function git(args: string[]): string {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} (cwd=${repo}) failed:\n${r.stdout}\n${r.stderr}`);
      }
      return (r.stdout || "").trim();
    }

    function commitFile(path: string, content: string, message: string): string {
      const full = join(repo, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
      git(["add", "."]);
      git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
      return git(["rev-parse", "HEAD"]);
    }

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "scenario-planner-ccf-"));
      git(["init", "--quiet"]);
    });

    afterEach(() => {
      try {
        spawnSync("rm", ["-rf", repo]);
      } catch {
        // ignore
      }
    });

    it("a COMMITTED UI change that a later, uncommitted checkout reverts in the working tree is still reported (was the HIGH: single-operand diff alone missed it)", () => {
      // The file must already exist AT baseSha (plain, no Semantic) so
      // `git checkout baseSha -- <path>` below has something to restore —
      // reverting a file that was only ADDED after baseSha isn't a valid
      // checkout target (nothing to check out FROM), so the interesting
      // case is a later commit MODIFYING an existing file.
      const baseSha = commitFile("src/ui/reverted.tsx", "// plain, no semantic wrapper yet\n", "base ui file");
      commitFile(
        "src/ui/reverted.tsx",
        '<Semantic id="x" role="button">\n',
        "commit the UI change (adds a Semantic wrapper)",
      );

      // Uncommitted revert: the working tree now matches baseSha again for
      // this file, so the OLD single-operand `git diff <base> --` no longer
      // sees it — but the commit that will actually be pushed still does.
      git(["checkout", baseSha, "--", "src/ui/reverted.tsx"]);

      const changed = collectChangedFiles({ cwd: repo, baseRef: baseSha });
      expect(changed).toContain("src/ui/reverted.tsx");
    });

    it("an UNCOMMITTED UI change (no commit at all) is still reported — no regression for local, interactive self-verify use", () => {
      const baseSha = commitFile("base.txt", "v1\n", "base");
      mkdirSync(join(repo, "src", "ui"), { recursive: true });
      writeFileSync(join(repo, "src", "ui", "uncommitted.tsx"), '<Semantic id="y" role="button">\n');
      git(["add", "."]); // staged but not committed — still part of the working tree

      const changed = collectChangedFiles({ cwd: repo, baseRef: baseSha });
      expect(changed).toContain("src/ui/uncommitted.tsx");
    });

    it("a bare TREE base (e.g. the empty tree) works for the union, not just a commit", () => {
      commitFile("base.txt", "v1\n", "base");
      commitFile("src/ui/committed.tsx", '<Semantic id="z" role="button">\n', "add ui file");
      const emptyTreeSha = execSync("git hash-object -t tree /dev/null", { cwd: repo, encoding: "utf8" }).trim();

      const changed = collectChangedFiles({ cwd: repo, baseRef: emptyTreeSha });
      expect(changed).toContain("src/ui/committed.tsx");
      expect(changed).toContain("base.txt");
    });

    it("untracked files are still excluded from both halves of the union, exactly as before", () => {
      const baseSha = commitFile("base.txt", "v1\n", "base");
      mkdirSync(join(repo, "src", "ui"), { recursive: true });
      writeFileSync(join(repo, "src", "ui", "untracked.tsx"), '<Semantic id="w" role="button">\n'); // never `git add`ed

      const changed = collectChangedFiles({ cwd: repo, baseRef: baseSha });
      expect(changed).not.toContain("src/ui/untracked.tsx");
    });
  });
});
