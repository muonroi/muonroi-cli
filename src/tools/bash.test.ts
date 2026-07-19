import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BashTool } from "./bash";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("BashTool non-sandbox behavior", () => {
  it("translates POSIX-style absolute paths in cd when shell is POSIX", async () => {
    if (process.platform !== "win32") return;
    const root = makeTempDir("muonroi-bash-cdposix-");
    // Pretend the configured shell is bash (forces POSIX path translation in cd handler).
    const bash = new BashTool(root, { shellSettings: { kind: "bash" } });
    if (!bash.getResolvedShell().isPosix) return; // skip if no bash on this Windows host

    const driveLetter = root.match(/^([A-Za-z]):/)?.[1]?.toLowerCase();
    if (!driveLetter) return;
    const posixPath = `/${driveLetter}${root.slice(2).replace(/\\/g, "/")}`;
    const result = await bash.execute(`cd ${posixPath}`);
    expect(result.success).toBe(true);
    expect(bash.getCwd()).toBe(root);
  });

  it("strips trailing backslash from quoted cd target on Windows (E1 regression)", async () => {
    if (process.platform !== "win32") return;
    const root = makeTempDir("muonroi-bash-trailbs-");
    const bash = new BashTool(os.tmpdir());
    // Simulate: cd "C:\foo\bar\" && pwd  — the trailing \" is mis-parsed as
    // escaped quote, leaving the path as "C:\foo\bar\". After the fix the
    // trailing backslash is stripped and the directory resolves correctly.
    const result = await bash.execute(`cd "${root}\\"`);
    expect(result.success).toBe(true);
    expect(bash.getCwd()).toBe(root);
  });

  it("splits `cd <dir> && <cmd>` and runs <cmd> in the new cwd (session 127140a47b56 regression)", async () => {
    const root = makeTempDir("muonroi-bash-cdchain-");
    const bash = new BashTool(os.tmpdir());
    const echoCmd = process.platform === "win32" ? "echo split-ok" : "echo split-ok";
    const quoted = process.platform === "win32" ? `"${root}"` : root;
    const result = await bash.execute(`cd ${quoted} && ${echoCmd}`);
    expect(result.success).toBe(true);
    expect(result.output ?? "").toContain("split-ok");
    expect(bash.getCwd()).toBe(root);
  });

  it("respects `&&` short-circuit: failed cd does NOT run the chained command", async () => {
    const bash = new BashTool(os.tmpdir());
    const result = await bash.execute(`cd /this/path/does/not/exist && echo should-not-run`);
    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/Cannot change directory/);
    expect(result.output ?? "").not.toContain("should-not-run");
  });

  it("respects `||` short-circuit: failed cd DOES run the chained command", async () => {
    const start = os.tmpdir();
    const bash = new BashTool(start);
    const result = await bash.execute(`cd /this/path/does/not/exist || echo fallback-ran`);
    expect(result.success).toBe(true);
    expect(result.output ?? "").toContain("fallback-ran");
    expect(bash.getCwd()).toBe(start); // cwd unchanged after failed cd
  });

  it("strips cmd.exe DOS flag `/d` from `cd /d <path> && <cmd>` (session 7dcf8fd7d6a4 regression)", async () => {
    const root = makeTempDir("muonroi-bash-cddosflag-");
    const bash = new BashTool(os.tmpdir());
    const quoted = process.platform === "win32" ? `"${root}"` : root;
    const result = await bash.execute(`cd /d ${quoted} && echo dos-flag-ok`);
    expect(result.success).toBe(true);
    expect(result.output ?? "").toContain("dos-flag-ok");
    expect(bash.getCwd()).toBe(root);
  });

  it("respects `;` separator: runs remainder regardless of cd outcome", async () => {
    const root = makeTempDir("muonroi-bash-cdsemicolon-");
    const bash = new BashTool(os.tmpdir());
    const quoted = process.platform === "win32" ? `"${root}"` : root;
    const result = await bash.execute(`cd ${quoted} ; echo always-runs`);
    expect(result.success).toBe(true);
    expect(result.output ?? "").toContain("always-runs");
    expect(bash.getCwd()).toBe(root);
  });
});

// Exit-code semantics: a benign non-zero exit (pipe truncation, grep/diff/test
// boolean answers, timeouts) must not masquerade as a broken command. These run
// under a POSIX shell only — cmd/pwsh speak different syntax.
describe("BashTool exit-code reporting", () => {
  const bash = new BashTool(process.cwd(), { shellSettings: { kind: "bash" } });
  const posix = bash.getResolvedShell().isPosix;

  it("treats SIGPIPE 141 with output as success (| head truncation is benign)", async () => {
    if (!posix) return;
    const r = await bash.execute("set -o pipefail; seq 1 200000 | head -3");
    expect(r.success).toBe(true);
    expect(r.output ?? "").toContain("1");
    expect(r.output ?? "").toMatch(/SIGPIPE/);
  });

  it("keeps a benign non-zero exit (grep no-match) as failure but annotates the code", async () => {
    if (!posix) return;
    const r = await bash.execute("printf 'a\\nb\\n' | grep -c 'zzznope'");
    expect(r.success).toBe(false);
    // The count '0' IS the answer — the model must still see it, plus the code.
    expect(r.error ?? "").toContain("0");
    expect(r.error ?? "").toMatch(/\[exit code 1\]/);
  });

  it("labels a timeout kill instead of presenting the echoed output as an error", async () => {
    if (!posix) return;
    const r = await bash.execute("echo partial; sleep 5", 1000);
    expect(r.success).toBe(false);
    expect(r.error ?? "").toMatch(/timed out after 1000ms/);
  });

  it("still reports a genuine command failure as a failure", async () => {
    if (!posix) return;
    const r = await bash.execute("echo working; false");
    expect(r.success).toBe(false);
    expect(r.error ?? "").toMatch(/\[exit code 1\]/);
  });
});
