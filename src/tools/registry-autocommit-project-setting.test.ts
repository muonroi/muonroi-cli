/**
 * Gap (b): a project's `.muonroi-cli/settings.json` `{"autoCommit": false}`
 * must also stop a raw `git commit` / `git push` reached through the bash
 * tool, not just the CLI's own end-of-turn auto-commit and `git_commit` tool
 * — otherwise a model just routes around the setting. Wired into
 * registry.ts's pre-execution git-safety gate (same `_prefixBlock("git-safety", …)`
 * plumbing the existing push/staging guards use — see registry-git-safety.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { clearBashOutputCache } from "./bash-output-cache.js";
import { __resetGitSafetyState } from "./git-safety.js";
import { createBuiltinTools } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown, extra?: { toolCallId?: string }) => Promise<unknown> | unknown;
}

async function runBash(tools: Record<string, unknown>, command: string): Promise<string> {
  const t = tools.bash as ToolWithExecute;
  if (!t?.execute) throw new Error("bash tool has no execute");
  const out = await t.execute({ command, timeout: 10_000 });
  return typeof out === "string" ? out : JSON.stringify(out);
}

describe("gap (b) — autoCommit: false blocks a manual git commit/push via the bash tool", () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    clearBashOutputCache();
    (globalThis as { __muonroiBashRepeatState?: Map<string, unknown> }).__muonroiBashRepeatState = new Map();
    __resetGitSafetyState();
    dir = mkdtempSync(join(os.tmpdir(), "gs-autocommit-setting-"));
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks `git commit` (pre-execution, no real commit attempted) when the project disables autoCommit", async () => {
    mkdirSync(join(dir, ".muonroi-cli"), { recursive: true });
    writeFileSync(join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ autoCommit: false }));
    process.chdir(dir);

    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "GS-AC1" });
    const out = await runBash(tools, 'git commit -m "test"');

    expect(out).toMatch(/^BLOCKED \(git-safety\):/);
    expect(out).toMatch(/autoCommit.*false/);
    // Proves the commit never ran — a real attempt in a non-repo tmpdir would
    // fail with git's own "not a git repository" error instead.
    expect(out).not.toMatch(/not a git repository|fatal:/i);
  });

  it("blocks `git push` the same way", async () => {
    mkdirSync(join(dir, ".muonroi-cli"), { recursive: true });
    writeFileSync(join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ autoCommit: false }));
    process.chdir(dir);

    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "GS-AC2" });
    const out = await runBash(tools, "git push origin main");

    expect(out).toMatch(/^BLOCKED \(git-safety\):/);
  });

  it("does NOT block when the project setting is absent (default behavior unchanged)", async () => {
    process.chdir(dir);
    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "GS-AC3" });
    const out = await runBash(tools, 'git commit -m "test"');

    // Falls through to the git error (not a repo) rather than our block —
    // proves the gate did not fire.
    expect(out).not.toMatch(/^BLOCKED \(git-safety\):.*autoCommit/);
  });

  it("does NOT block a read-only git command (e.g. `git log`) even when autoCommit is false", async () => {
    mkdirSync(join(dir, ".muonroi-cli"), { recursive: true });
    writeFileSync(join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ autoCommit: false }));
    process.chdir(dir);

    const bash = new BashTool(dir);
    const tools = createBuiltinTools(bash, "agent", { sessionId: "GS-AC4" });
    const out = await runBash(tools, "git log --oneline -5");

    expect(out).not.toMatch(/^BLOCKED \(git-safety\):.*autoCommit/);
  });
});
