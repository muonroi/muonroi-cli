/**
 * Progress signals behind the `/ideal` autopilot's no-progress rule: the working
 * tree fingerprint must move on any real edit/create/delete/commit and must NOT
 * move when only host-owned state is rewritten (STATE.md is re-synced every turn,
 * so counting it would make every turn look like progress).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delegationCounts, workspaceFingerprint } from "../ideal-autopilot-signals.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autopilot-signals-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
const put = (rel: string, text: string, mtimeSeconds?: number) => {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  if (mtimeSeconds !== undefined) utimesSync(full, mtimeSeconds, mtimeSeconds);
};

describe.each([
  ["a git repository", true],
  ["a plain directory", false],
] as const)("workspaceFingerprint in %s", (_name, useGit) => {
  beforeEach(() => {
    put("src/a.ts", "export const a = 1;\n", 1_700_000_000);
    if (useGit) {
      git("init", "-q");
      git("add", "-A");
      git("commit", "-q", "-m", "init");
    }
  });

  it("is stable when nothing changed", async () => {
    expect(await workspaceFingerprint(dir)).toBe(await workspaceFingerprint(dir));
  });

  it("moves on an edit, a new file and a delete", async () => {
    const base = await workspaceFingerprint(dir);
    put("src/a.ts", "export const a = 2;\n", 1_700_000_100);
    const edited = await workspaceFingerprint(dir);
    expect(edited).not.toBe(base);
    put("src/b.ts", "export const b = 1;\n");
    const created = await workspaceFingerprint(dir);
    expect(created).not.toBe(edited);
    rmSync(join(dir, "src/b.ts"));
    expect(await workspaceFingerprint(dir)).not.toBe(created);
  });

  it("ignores what the host and FLOW rewrite every turn", async () => {
    const base = await workspaceFingerprint(dir);
    put(".planning/STATE.md", "turn 1", 1_700_000_200);
    put(".muonroi-flow/planning/STATE.md", "turn 1");
    put(".muonroi-cli/delegations/x.json", "{}");
    put(".planning/STATE.md", "turn 2 with more text", 1_700_000_300);
    expect(await workspaceFingerprint(dir)).toBe(base);
  });
});

it("a commit moves the git fingerprint even though the tree is clean afterwards", async () => {
  put("src/a.ts", "x\n", 1_700_000_000);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const before = await workspaceFingerprint(dir);
  put("src/a.ts", "y\n", 1_700_000_100);
  git("add", "-A");
  git("commit", "-q", "-m", "two");
  expect(await workspaceFingerprint(dir)).not.toBe(before);
});

describe("delegationCounts", () => {
  it("counts started and terminal jobs", () => {
    const job = (status: "running" | "complete" | "error" | "cancelled") => ({
      id: status,
      agent: "general",
      description: "d",
      status,
      startedAt: "2026-11-09T10:00:00.000Z",
    });
    expect(delegationCounts([job("running"), job("complete"), job("error"), job("cancelled")])).toEqual({
      started: 4,
      finished: 3,
    });
    expect(delegationCounts([])).toEqual({ started: 0, finished: 0 });
  });
});
