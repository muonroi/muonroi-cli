import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let cwd: string;
let dir: string;
let mod: typeof import("../delegations.js");
let prevCliHome: string | undefined;
const children: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-owner-"));
  cwd = path.join(home, "project");
  fs.mkdirSync(cwd);
  dir = path.join(
    home,
    ".muonroi-cli",
    "delegations",
    `project-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  // delegations.ts resolves its root through the repo-wide `MUONROI_CLI_HOME ??
  // homedir()/.muonroi-cli` convention, and vitest-setup.ts pins that var
  // suite-wide — so the homedir mock alone no longer redirects it. Point the var
  // at this test's temp home; the mock stays as belt-and-braces.
  prevCliHome = process.env.MUONROI_CLI_HOME;
  process.env.MUONROI_CLI_HOME = path.join(home, ".muonroi-cli");
  const actual = await vi.importActual<typeof import("os")>("os");
  vi.doMock("os", () => ({ ...actual, default: { ...actual, homedir: () => home } }));
  vi.resetModules();
  mod = await import("../delegations.js");
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  if (prevCliHome === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = prevCliHome;
  vi.doUnmock("os");
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function seed(overrides: Record<string, unknown> = {}) {
  const record = {
    id: "probe",
    agent: "explore",
    description: "Inspect",
    prompt: "Inspect",
    cwd,
    model: "test-model",
    sandboxMode: "off",
    maxToolRounds: 2,
    maxTokens: 100,
    status: "complete",
    startedAt: new Date().toISOString(),
    outputPath: path.join(dir, "probe.md"),
    parentSessionId: "main-a",
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "probe.json"), JSON.stringify(record));
  if (record.status === "complete") fs.writeFileSync(record.outputPath, "Owned completed fixture output");
  return path.join(dir, "probe.json");
}

describe("parent-owned delegations", () => {
  it("only the mounted live owner controller can renew/poll/decide worker approvals", async () => {
    const owner = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    expect(await owner.pollApprovals()).toEqual([]);
    owner.setApprovalController(true);
    const digest = (owner as any).approvalControllerDigest;
    const view = {
      id: "request",
      jobId: "probe",
      ownerId: "main-a",
      toolName: "write_file",
      toolCallId: "actual-call",
      inputDigest: "input-digest",
      preview: "redacted preview",
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    };
    const job = seed({
      status: "running",
      pid: process.pid,
      approvalController: { digest, pid: process.pid, expiresAt: new Date(Date.now() + 5000).toISOString() },
      approvals: [{ ...view, state: "pending", controllerDigest: digest, createdAt: new Date().toISOString() }],
    });
    expect(await owner.pollApprovals()).toEqual([view]);
    const other = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    other.setApprovalController(true);
    expect(await other.pollApprovals()).toEqual([]);
    await expect(other.decideApproval(view, true)).rejects.toThrow(/foreign/);
    await owner.decideApproval(view, false);
    expect((await mod.loadDelegation(job)).approvals?.[0]?.state).toBe("denied");
    owner.setApprovalController(false);
    await expect(owner.decideApproval(view, true)).rejects.toThrow(/live owning TUI/);
  });

  it("poll does not revive an expired approval controller lease", async () => {
    const owner = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    owner.setApprovalController(true);
    const job = seed({
      status: "running",
      pid: process.pid,
      approvalController: {
        digest: (owner as any).approvalControllerDigest,
        pid: process.pid,
        expiresAt: new Date(0).toISOString(),
      },
    });
    expect(await owner.pollApprovals()).toEqual([]);
    expect((await mod.loadDelegation(job)).approvalController?.expiresAt).toBe(new Date(0).toISOString());
  });
  it("another session cannot consume the owner's notification", async () => {
    const job = seed();
    const other = new mod.DelegationManager(
      () => cwd,
      () => "main-b",
    );
    const owner = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    expect(await other.consumeNotifications()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(job, "utf8")).notifiedAt).toBeUndefined();
    expect(await owner.consumeNotifications()).toHaveLength(1);
  });

  it("concurrent polls notify the owner once", async () => {
    seed();
    const owner = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    const results = await Promise.all([owner.consumeNotifications(), owner.consumeNotifications()]);
    expect(results.flat()).toHaveLength(1);
  });

  it("legacy records remain inspectable but a session does not claim their notification", async () => {
    seed({ parentSessionId: undefined });
    const owner = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    expect(await owner.consumeNotifications()).toEqual([]);
    expect(await owner.list()).toHaveLength(1);
  });

  it("does not expose other sessions' jobs through list/read", async () => {
    seed();
    const other = new mod.DelegationManager(
      () => cwd,
      () => "main-b",
    );
    expect(await other.list()).toEqual([]);
    expect(await other.read("probe")).toContain("not found");
  });

  it("reconciles a dead PID into a durable error instead of running forever", async () => {
    const job = seed({ status: "running", pid: 2147483000 });
    const owner = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    expect((await owner.list())[0]?.status).toBe("error");
    expect((await mod.loadDelegation(job)).error).toContain("exited");
    expect(await owner.consumeNotifications()).toHaveLength(1);
  });

  it("ignores late completion after cancellation", async () => {
    const job = seed({ status: "running", pid: 2147483000 });
    await mod.failDelegation(job, "Cancelled by user.");
    await mod.completeDelegation(job, "late success");
    expect((await mod.loadDelegation(job)).status).toBe("error");
    expect(fs.readFileSync(path.join(dir, "probe.md"), "utf8")).not.toContain("late success");
  });

  it("does not permit another session to kill an owned worker", async () => {
    seed({ status: "running", pid: 2147483000 });
    const other = new mod.DelegationManager(
      () => cwd,
      () => "main-b",
    );
    const result = await other.kill("probe");
    expect(result.success).toBe(false);
    expect(result.output).toContain("another session");
  });

  it("waits for an actual worker process to terminate before acknowledging kill", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const job = seed({ status: "running", pid: child.pid });
    const owner = new mod.DelegationManager(
      () => cwd,
      () => "main-a",
    );
    const result = await owner.kill("probe");
    expect(result.success).toBe(true);
    await exited;
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect((await mod.loadDelegation(job)).status).toBe("cancelled");
  }, 15_000);
});
