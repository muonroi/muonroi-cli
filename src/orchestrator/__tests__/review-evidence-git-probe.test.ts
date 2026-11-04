import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planReviewBinding } from "../../workflow/async-plan-review.js";
import { planningArtifact } from "../../workflow/paths.js";
import { sourceFingerprint } from "../review-evidence.js";

let root: string;
const git = (args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
const indexHash = () =>
  existsSync(join(root, ".git", "index"))
    ? createHash("sha256")
        .update(readFileSync(join(root, ".git", "index")))
        .digest("hex")
    : null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "snapshot-git-probe-"));
  vi.stubEnv("MUONROI_FLOW_NATIVE", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("source snapshot Git probe", () => {
  it("retains native command, status and stderr for a checkout that Git refuses", async () => {
    writeFileSync(join(root, ".git"), "invalid git marker\n");
    let native: Error & { status?: number; stderr?: Buffer };
    try {
      git(["rev-parse", "--show-toplevel"]);
      throw new Error("Expected invalid marker failure");
    } catch (error) {
      native = error as typeof native;
    }
    expect(native.status).not.toBeUndefined();
    expect(native.stderr?.toString()).toContain("invalid gitfile format");
    await expect(sourceFingerprint(root)).rejects.toThrow(`status=${native.status}`);
    await expect(sourceFingerprint(root)).rejects.toThrow("invalid gitfile format");
    await expect(sourceFingerprint(root)).rejects.toThrow("git rev-parse --show-toplevel");
  });

  it("hashes changed untracked source without staging or modifying the index", async () => {
    git(["init", "-q"]);
    writeFileSync(join(root, "tracked.ts"), "export const stable = true;");
    git(["add", "tracked.ts"]);
    const index = indexHash();
    writeFileSync(join(root, "untracked.ts"), "export const value = 1;");
    const before = await sourceFingerprint(root);
    writeFileSync(join(root, "untracked.ts"), "export const value = 2;");
    expect(await sourceFingerprint(root)).not.toBe(before);
    expect(indexHash()).toBe(index);
    expect(git(["ls-files", "--", "untracked.ts"]).trim()).toBe("");
  });

  it("binds an ignored PLAN directly while leaving Git source fingerprint and index intact", async () => {
    git(["init", "-q"]);
    const plan = planningArtifact(root, "PLAN.md");
    mkdirSync(dirname(plan), { recursive: true });
    writeFileSync(plan, "# Original plan\n");
    writeFileSync(join(root, ".gitignore"), `${relative(root, dirname(plan)).replaceAll("\\", "/")}/\n`);
    git(["add", ".gitignore"]);
    const index = indexHash();
    expect(git(["check-ignore", "--", relative(root, plan)]).trim()).not.toBe("");
    const beforeSource = await sourceFingerprint(root),
      beforePlan = planReviewBinding(root, { depth: "standard", revisionCycle: 0 });
    writeFileSync(plan, "# Revised ignored plan\n");
    expect(await sourceFingerprint(root)).toBe(beforeSource);
    expect(planReviewBinding(root, beforePlan).inputsDigest).not.toBe(beforePlan.inputsDigest);
    expect(indexHash()).toBe(index);
    expect(git(["ls-files", "--", relative(root, plan)]).trim()).toBe("");
  });

  it("still fingerprints an actual nongit workspace", async () => {
    writeFileSync(join(root, "source.ts"), "export const value = 1;");
    const before = await sourceFingerprint(root);
    writeFileSync(join(root, "source.ts"), "export const value = 2;");
    expect(await sourceFingerprint(root)).not.toBe(before);
  });
});
