import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bestEffortRemoveSync } from "../../__test-stubs__/cleanup";
import {
  __resetGitPromptStatusCache,
  formatGitPromptStatus,
  gitPromptStatus,
  refreshGitPromptStatus,
} from "../git-prompt-status.js";
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
    // The suite default is off (vitest-setup.ts); this file is the probe's own coverage.
    vi.stubEnv("MUONROI_PROMPT_GIT_STATUS", "1");
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
  afterEach(async () => {
    // Let any background probe exit first: on Windows a running git pins its cwd.
    await Promise.all([refreshGitPromptStatus(repo), refreshGitPromptStatus(plain)]);
    vi.unstubAllEnvs();
    bestEffortRemoveSync(repo, "git-prompt-status.test.ts");
    bestEffortRemoveSync(plain, "git-prompt-status.test.ts");
  });

  it("reports the real branch / HEAD / dirty count inside a repo", async () => {
    const head = git("rev-parse", "--short=7", "HEAD").stdout.trim();
    expect(await refreshGitPromptStatus(repo)).toBe(`- Git: branch topic @ ${head}; 1 dirty file`);
    expect(gitPromptStatus(repo)).toBe(`- Git: branch topic @ ${head}; 1 dirty file`);
  });

  it("is absent outside a git repository", async () => {
    expect(await refreshGitPromptStatus(plain)).toBe("");
    expect(gitPromptStatus(plain)).toBe("");
  });

  // Session c2fda568be6b: 867 synchronous probes timed out on the prompt path,
  // each freezing the event loop for 1.5s. The prompt builder must only read.
  it("never blocks the caller: a cold cache returns empty now and fills in the background", async () => {
    const head = git("rev-parse", "--short=7", "HEAD").stdout.trim();
    expect(gitPromptStatus(repo)).toBe("");
    await refreshGitPromptStatus(repo); // joins the refresh the call above started
    expect(gitPromptStatus(repo)).toBe(`- Git: branch topic @ ${head}; 1 dirty file`);
  });

  it("lands in the dynamic suffix only — the static prefix carries no git state", async () => {
    await refreshGitPromptStatus(repo);
    await refreshGitPromptStatus(plain);
    const parts = buildSystemPromptParts(repo, "agent", "off", null, [], undefined, undefined, null, {});
    expect(parts.dynamicSuffix).toContain("- Git: branch topic @");
    expect(parts.staticPrefix).not.toContain("- Git: branch");
    const outside = buildSystemPromptParts(plain, "agent", "off", null, [], undefined, undefined, null, {});
    expect(outside.dynamicSuffix).not.toContain("- Git:");
  });
});
