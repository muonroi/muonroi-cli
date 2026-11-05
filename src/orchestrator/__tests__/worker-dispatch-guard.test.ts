import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterScopedWorkerTools } from "../../tools/worker-write-scope.js";
import {
  detectCommandRequirements,
  findWriteOverlap,
  formatWriteOverlapRefusal,
  isWriteCapable,
  workerCommandCapabilityError,
} from "../worker-dispatch-guard.js";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const originalCliHome = process.env.MUONROI_CLI_HOME;
afterEach(() => {
  if (originalCliHome === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = originalCliHome;
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("child_process");
});

const REVIEW = { jobId: "impl-job", resultVersion: "v1" };

describe("detectCommandRequirements", () => {
  // Phrasings taken from session 4edc02516a92 delegation prompts.
  it.each([
    ["Run all commands from cwd D:\\repo\\src.", "command"],
    ["Run: dotnet build src/samples/Sample.csproj --nologo -v q", "command"],
    ["Run `dotnet pack src/X/X.csproj --nologo -v q` and report exit code.", "command"],
    ["Fix the compile error, then run build and test and report raw evidence.", "command"],
    ["You may READ and RUN commands but MUST NOT modify anything.", "command"],
    [
      "E. Kiểm chứng (chạy theo thứ tự, dừng nếu lỗi):\n   1. `cd src && dotnet build X.csproj --nologo -v q`",
      "command",
    ],
    ["Verify your own build with `dotnet build src/X/X.csproj --nologo -v q` from `src/`.", "command"],
    ["Then run the tests and report counts.", "tests"],
  ])("detects an explicit run directive: %s", (text, kind) => {
    expect(detectCommandRequirements(text)[0]?.kind).toBe(kind);
  });

  it.each([
    "Do NOT run `dotnet build` or `dotnet test` — other workers are editing sibling files.",
    "KHÔNG chạy `dotnet test` trên cả solution.",
    "Không chạy lệnh build/test/dotnet nào (bạn không có shell).",
    "Confirm the README documents `npm test` and `dotnet build`.",
    "The previous worker ran `dotnet build` and reported CS0246.",
    "The documented run command is real.",
    "If you run low, deliver (1)-(4) with tests first.",
    "BUILD/TEST COMMANDS (run from `D:\\repo\\src`):",
    'Write the command instead, e.g. "chạy `dotnet test tests/X.Tests`".',
    "`git check-ignore` must be run on `docs/X.md` before the corpus is complete.",
    "Explain how to run the test suite in the README.",
    "Nếu `dotnet test` cả solution chạy, đếm assembly và tổng test.",
    'Re-run a root-by-root `grep -rn "Bearer" src docs` to get your own count.',
    "Check compatibility with `System.Text.Json` serialization.",
  ])("does not treat a mention, prohibition or description as a directive: %s", (text) => {
    expect(detectCommandRequirements(text)).toEqual([]);
  });
});

describe("workerCommandCapabilityError", () => {
  it("refuses a writeScope worker asked to run a build gate and names an execution-capable route", () => {
    const error = workerCommandCapabilityError({
      agent: "general",
      description: "Build + test gate TCIS.MCP.Docs",
      prompt: "Run the clean build first, then run `dotnet test X.sln --no-build`.",
      writeScope: ["src/X/"],
    });
    expect(error).toMatch(/^worker_capability_refused:/);
    expect(error).toContain("agent=general with writeScope");
    expect(error).toContain("no shell");
    expect(error).toContain("agent=verify without writeScope/reviewOf");
  });

  it("refuses a reviewOf verify worker asked to run a non-test command", () => {
    const error = workerCommandCapabilityError({
      agent: "verify",
      description: "Verify RepositoryLocator fix by build+run",
      prompt: "(1) Does the sample compile? Run: dotnet build src/samples/Sample.csproj --nologo -v q",
      reviewOf: REVIEW,
    });
    expect(error).toMatch(/^worker_capability_refused:/);
    expect(error).toContain("agent=verify with reviewOf");
    expect(error).toContain("verification_run");
    expect(error).toContain("agent=verify without reviewOf");
  });

  it("does not refuse a read-only review that only mentions commands", () => {
    expect(
      workerCommandCapabilityError({
        agent: "verify",
        description: "Independent review",
        prompt:
          "Read-only review. Do NOT run dotnet build or dotnet test. Confirm the README documents `dotnet test` and quote the gate expression.",
        reviewOf: REVIEW,
      }),
    ).toBeUndefined();
  });

  it("lets a reviewOf worker run existing JS/Python tests through verification_run", () => {
    for (const prompt of [
      "Run the tests for the changed module and report the result.",
      "Run `src/foo.test.ts` with verification_run.",
      "Run `tests/test_scanner.py` and report pass/fail.",
    ])
      expect(workerCommandCapabilityError({ agent: "verify", description: "Review", prompt, reviewOf: REVIEW })).toBe(
        undefined,
      );
  });

  it("never refuses execution-capable grants (unscoped general/verify)", () => {
    for (const agent of ["general", "verify"])
      expect(
        workerCommandCapabilityError({ agent, description: "Gate", prompt: "Run `dotnet build X.sln --nologo`." }),
      ).toBeUndefined();
  });

  it("refuses a scoped edit that would need the shell to write outside its scope (no scoped command capability)", () => {
    // Option A was rejected: build/test runners execute project-controlled code
    // the scoped worker can author, so the scoped grant keeps no shell at all.
    const bash = { execute: vi.fn() };
    const read_file = { execute: vi.fn() };
    const tools = filterScopedWorkerTools({ bash, read_file } as Record<string, unknown>, { bash, read_file });
    expect(Object.keys(tools)).toEqual(["read_file"]);
    expect(
      workerCommandCapabilityError({
        agent: "general",
        description: "Write generated file",
        prompt: "Run `node -e \"require('fs').writeFileSync('../outside.txt','x')\"` to generate the fixture.",
        writeScope: ["src/a.ts"],
      }),
    ).toMatch(/^worker_capability_refused:/);
  });
});

describe("findWriteOverlap", () => {
  it("detects scoped overlap (recursive dir vs file inside it) and ignores disjoint scopes", () => {
    const cwd = tempDir("muonroi-overlap-");
    const running = [
      {
        id: "steady-ivory-panda",
        agent: "general",
        cwd,
        writeScope: ["src/Docs/"],
        writeScopeTargets: [path.join(fs.realpathSync(cwd), "src", "Docs")],
      },
    ];
    expect(findWriteOverlap({ agent: "general", cwd, writeScope: ["src/Docs/Engine.cs"] }, running)).toMatchObject({
      jobId: "steady-ivory-panda",
      runningScoped: true,
    });
    expect(findWriteOverlap({ agent: "general", cwd, writeScope: ["src/Other/"] }, running)).toBeUndefined();
    expect(findWriteOverlap({ agent: "general", cwd, writeScope: ["src/DocsExtra/"] }, running)).toBeUndefined();
  });

  it("treats an unscoped writer as covering the whole workspace", () => {
    const cwd = tempDir("muonroi-overlap-");
    const running = [{ id: "steady-ivory-panda", agent: "general", cwd }];
    const next = { agent: "general", cwd };
    const overlap = findWriteOverlap(next, running);
    expect(overlap).toMatchObject({ jobId: "steady-ivory-panda", runningScoped: false });
    expect(formatWriteOverlapRefusal(next, overlap!)).toContain("both are unscoped");
    expect(findWriteOverlap({ agent: "general", cwd, writeScope: ["src/a.ts"] }, running)).toBeDefined();
  });

  it("ignores read-only work: explore, reviewOf, council, and writeScope []", () => {
    const cwd = tempDir("muonroi-overlap-");
    const running = [
      { id: "r1", agent: "explore", cwd },
      { id: "r2", agent: "verify", cwd, reviewOf: REVIEW },
      { id: "r3", agent: "council", cwd, kind: "council" },
      { id: "r4", agent: "general", cwd, writeScope: [] },
    ];
    expect(running.every((job) => !isWriteCapable(job))).toBe(true);
    expect(findWriteOverlap({ agent: "general", cwd }, running)).toBeUndefined();
    expect(findWriteOverlap({ agent: "explore", cwd }, [{ id: "w", agent: "general", cwd }])).toBeUndefined();
  });
});

async function importDelegations(home: string, spawnMock: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  process.env.MUONROI_CLI_HOME = path.join(home, ".muonroi-cli");
  const cpActual = await vi.importActual<typeof import("child_process")>("child_process");
  vi.doMock("child_process", () => ({ ...cpActual, spawn: spawnMock }));
  return import("../delegations.js");
}

const OPTIONS = { model: "fixture", sandboxMode: "off" as const, maxToolRounds: 2, maxTokens: 100 };

describe("DelegationManager dispatch guards", () => {
  // A live PID keeps the first job "running" through reconcile().
  const liveSpawn = () => vi.fn(() => ({ pid: process.pid, unref: vi.fn(), once: vi.fn() }));

  it("refuses a capability-mismatched dispatch before any record or process is created", async () => {
    const home = tempDir("muonroi-guard-home-");
    const cwd = tempDir("muonroi-guard-cwd-");
    fs.mkdirSync(path.join(cwd, "src"));
    const spawnMock = liveSpawn();
    const mod = await importDelegations(home, spawnMock);
    const manager = new mod.DelegationManager(
      () => cwd,
      () => "owner",
    );
    const result = await manager.startTask(
      {
        agent: "general",
        description: "Build + test gate",
        prompt: "Run the clean build first.",
        writeScope: ["src/"],
      },
      OPTIONS,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^worker_capability_refused:/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a second unscoped writer while the first runs, naming the running jobId", async () => {
    const home = tempDir("muonroi-guard-home-");
    const cwd = tempDir("muonroi-guard-cwd-");
    const spawnMock = liveSpawn();
    const mod = await importDelegations(home, spawnMock);
    const manager = new mod.DelegationManager(
      () => cwd,
      () => "owner",
    );
    const first = await manager.startTask(
      { agent: "general", description: "Wave 2: Docs engine + unit tests", prompt: "Implement the docs engine." },
      OPTIONS,
    );
    expect(first.success).toBe(true);
    const firstId = first.delegation!.id;
    const second = await manager.startTask(
      { agent: "general", description: "Wave 2: implement docs engine", prompt: "Implement the docs engine." },
      OPTIONS,
    );
    expect(second.success).toBe(false);
    expect(second.output).toMatch(/^worker_write_overlap_refused:/);
    expect(second.output).toContain(`jobId=${firstId}`);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Read-only research still runs alongside the writer.
    const explore = await manager.start({ agent: "explore", description: "Inspect", prompt: "Inspect" }, OPTIONS);
    expect(explore.success).toBe(true);
  });

  it("refuses overlapping writeScopes, admits disjoint ones, and re-admits after the first job ends", async () => {
    const home = tempDir("muonroi-guard-home-");
    const cwd = tempDir("muonroi-guard-cwd-");
    fs.mkdirSync(path.join(cwd, "src", "Docs"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    const spawnMock = liveSpawn();
    const mod = await importDelegations(home, spawnMock);
    const manager = new mod.DelegationManager(
      () => cwd,
      () => "owner",
    );
    const first = await manager.startTask(
      { agent: "general", description: "Docs engine", prompt: "Implement.", writeScope: ["src/Docs/"] },
      OPTIONS,
    );
    expect(first.success).toBe(true);
    const firstId = first.delegation!.id;

    const overlapping = await manager.startTask(
      { agent: "general", description: "Docs engine again", prompt: "Implement.", writeScope: ["src/Docs/Engine.cs"] },
      OPTIONS,
    );
    expect(overlapping.success).toBe(false);
    expect(overlapping.output).toContain(`jobId=${firstId}`);
    expect(overlapping.output).toContain("writeScope overlaps");

    const unscoped = await manager.startTask(
      { agent: "verify", description: "Build gate", prompt: "Run `dotnet build X.sln --nologo`." },
      OPTIONS,
    );
    expect(unscoped.success).toBe(false);
    expect(unscoped.output).toContain("unscoped (legacy shared) writer may write anywhere");

    const disjoint = await manager.startTask(
      { agent: "general", description: "Tests", prompt: "Write tests.", writeScope: ["tests/"] },
      OPTIONS,
    );
    expect(disjoint.success).toBe(true);

    const review = await manager.startTask(
      { agent: "general", description: "Read-only", prompt: "Read.", writeScope: [] },
      OPTIONS,
    );
    expect(review.success).toBe(true);

    await mod.completeDelegation(
      path.join(
        home,
        ".muonroi-cli",
        "delegations",
        fs.readdirSync(path.join(home, ".muonroi-cli", "delegations"))[0]!,
        `${firstId}.json`,
      ),
      "DONE",
    );
    const retry = await manager.startTask(
      { agent: "general", description: "Docs engine again", prompt: "Implement.", writeScope: ["src/Docs/Engine.cs"] },
      OPTIONS,
    );
    expect(retry.success).toBe(true);
  });

  it("serializes parallel dispatches so only one of two concurrent unscoped writers starts", async () => {
    const home = tempDir("muonroi-guard-home-");
    const cwd = tempDir("muonroi-guard-cwd-");
    const spawnMock = liveSpawn();
    const mod = await importDelegations(home, spawnMock);
    const manager = new mod.DelegationManager(
      () => cwd,
      () => "owner",
    );
    const results = await Promise.all(
      [1, 2].map((n) => manager.startTask({ agent: "general", description: `W${n}`, prompt: "Edit." }, OPTIONS)),
    );
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => !r.success)[0]?.output).toMatch(/^worker_write_overlap_refused:/);
  });
});
