import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../__test-stubs__/cleanup";
import { __resetGitPromptStatusCache, formatGitPromptStatus, gitPromptStatus } from "../git-prompt-status.js";
import { buildSystemPromptParts, resetStaticPrefixCache } from "../prompts.js";

describe("formatGitPromptStatus", () => {
  it("renders branch, short HEAD and dirty count from porcelain v2", () => {
    const out = [
      "# branch.oid 0123456789abcdef0123456789abcdef01234567",
      "# branch.head feat/x",
      "# branch.upstream origin/feat/x",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "? new.txt",
    ].join("\n");
    expect(formatGitPromptStatus(out)).toBe("- Git: branch feat/x @ 0123456; 2 dirty files");
  });

  it("handles a repository with no commits and a clean tree", () => {
    expect(formatGitPromptStatus("# branch.oid (initial)\n# branch.head main\n")).toBe(
      "- Git: branch main @ (no commits); 0 dirty files",
    );
  });

  it("returns empty for output without branch headers", () => {
    expect(formatGitPromptStatus("")).toBe("");
  });
});

describe("gitPromptStatus + dynamic suffix", () => {
  let repo: string;
  let plain: string;
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    __resetGitPromptStatusCache();
    resetStaticPrefixCache();
    repo = mkdtempSync(join(tmpdir(), "git-prompt-"));
    plain = mkdtempSync(join(tmpdir(), "git-prompt-plain-"));
    git("init", "-q", "-b", "topic");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "b.txt"), "b\n");
  });
  afterEach(() => {
    bestEffortRemoveSync(repo, "git-prompt-status.test.ts");
    bestEffortRemoveSync(plain, "git-prompt-status.test.ts");
  });

  it("reports the real branch / HEAD / dirty count inside a repo", () => {
    const head = git("rev-parse", "--short=7", "HEAD").stdout.trim();
    expect(gitPromptStatus(repo)).toBe(`- Git: branch topic @ ${head}; 1 dirty file`);
  });

  it("is absent outside a git repository", () => {
    expect(gitPromptStatus(plain)).toBe("");
  });

  it("lands in the dynamic suffix only — the static prefix carries no git state", () => {
    const parts = buildSystemPromptParts(repo, "agent", "off", null, [], undefined, undefined, null, {});
    expect(parts.dynamicSuffix).toContain("- Git: branch topic @");
    expect(parts.staticPrefix).not.toContain("- Git: branch");
    const outside = buildSystemPromptParts(plain, "agent", "off", null, [], undefined, undefined, null, {});
    expect(outside.dynamicSuffix).not.toContain("- Git:");
  });
});
