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
  const actual = await vi.importActual<typeof import("os")>("os");
  vi.doMock("os", () => ({ ...actual, default: { ...actual, homedir: () => home } }));
  vi.resetModules();
  mod = await import("../delegations.js");
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
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
  return path.join(dir, "probe.json");
}

describe("parent-owned delegations", () => {
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
    expect((await mod.loadDelegation(job)).status).toBe("error");
  }, 15_000);
});
