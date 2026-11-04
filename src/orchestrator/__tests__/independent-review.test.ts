import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "../../tools/file.js";
import { runVerificationTests } from "../../tools/verification-run.js";
import type { DelegationAcceptanceInput, ReviewToolEvidence } from "../../types/index.js";
import { delegationResultForDisplay } from "../../ui/utils/delegation-display.js";
import {
  completeDelegation,
  DelegationManager,
  failDelegation,
  loadDelegation,
  readReviewArtifact,
  type StoredDelegation,
  saveDelegationToolResult,
} from "../delegations.js";
import { sourceFingerprint } from "../review-evidence.js";

vi.mock("child_process", async (original) => {
  const actual = await original<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) =>
      (args[1] as string[])?.includes("--background-task-file")
        ? Object.assign(new EventEmitter(), { pid: process.pid, unref() {} })
        : actual.spawn(...args),
    ),
  };
});
let home: string, cwd: string, dir: string, manager: DelegationManager;
const job = (id: string) => path.join(dir, `${id}.json`);
const read = (id: string): StoredDelegation => JSON.parse(fs.readFileSync(job(id), "utf8"));
const save = (id: string, edit: (r: StoredDelegation) => void) => {
  const r = read(id);
  edit(r);
  fs.writeFileSync(job(id), JSON.stringify(r));
};
const options = {
  model: "fixture-model",
  sandboxMode: "off" as const,
  maxToolRounds: 3,
  maxTokens: 500,
  permissionMode: "yolo" as const,
};
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "independent-review-"));
  cwd = path.join(home, "workspace");
  fs.mkdirSync(cwd);
  vi.stubEnv("MUONROI_CLI_HOME", home);
  vi.stubEnv("MUONROI_BACKGROUND_CHILD", "0");
  dir = path.join(home, "delegations", `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "value.cjs"), "module.exports=2;");
  fs.writeFileSync(
    path.join(cwd, "value.test.cjs"),
    "require('node:test').test('value is two',()=>require('node:assert/strict').equal(require('./value.cjs'),2));",
  );
  const target: StoredDelegation = {
    id: "implementation",
    agent: "general",
    kind: "task",
    description: "Implement value",
    prompt: "Only the assigned source",
    cwd,
    model: "fixture-model",
    sandboxMode: "off",
    maxToolRounds: 3,
    maxTokens: 500,
    status: "running",
    startedAt: new Date().toISOString(),
    outputPath: path.join(dir, "implementation.md"),
    parentSessionId: "owner",
  };
  fs.writeFileSync(job(target.id), JSON.stringify(target));
  await completeDelegation(job(target.id), "Implemented value.cjs; review independently.");
  manager = new DelegationManager(
    () => cwd,
    () => "owner",
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
async function review(evidence: boolean | "static" = true): Promise<DelegationAcceptanceInput> {
  const target = read("implementation");
  const started = await manager.startTask(
    {
      agent: "verify",
      description: "Independent verification",
      prompt: "Inspect and test source; no implementation history",
      modelId: "fixture-model",
      reviewOf: { jobId: target.id, resultVersion: target.resultVersion! },
    },
    options,
  );
  expect(started.success).toBe(true);
  const id = started.delegation!.id;
  const actual = await runVerificationTests(cwd, ["value.test.cjs"], 10000, undefined, "node");
  expect(actual.success).toBe(true);
  const proof: ReviewToolEvidence[] = [
    {
      tool: "verification_run",
      success: actual.success,
      scope: "workspace",
      input: { files: ["value.test.cjs"], runner: "node" },
      outputDigest: createHash("sha256").update(actual.output!).digest("hex"),
      completedAt: new Date().toISOString(),
    },
  ];
  await completeDelegation(
    job(id),
    JSON.stringify({ verdict: "pass", evidence: ["value.test.cjs exit=0"] }),
    undefined,
    evidence === "static"
      ? [{ ...proof[0]!, tool: "read_file", input: { file_path: "value.cjs" } }]
      : evidence
        ? proof
        : [],
  );
  await manager.read("implementation");
  await manager.read(id);
  return {
    jobId: target.id,
    resultVersion: target.resultVersion!,
    reviewJobId: id,
    reviewResultVersion: read(id).resultVersion!,
  };
}
describe("independent version-bound acceptance", () => {
  it("persists explicit scoped dispatch and exposes the effective paths without accepting work", async () => {
    const result = await manager.startTask(
      { agent: "general", description: "Edit A/B", prompt: "Scoped task", writeScope: ["A/", "B.md"] },
      options,
    );
    expect(result.success).toBe(true);
    const record = read(result.delegation!.id);
    expect(record.writeScope).toEqual(["A/", "B.md"]);
    expect(record.writeScopeVersion).toBe(1);
    expect(record.writeScopeBinding?.root).toBe(fs.realpathSync(cwd));
    expect(result.output).toContain("isolation=native-files-only");
    expect((await manager.list()).find((r) => r.id === record.id)).toMatchObject({
      writeScope: ["A/", "B.md"],
      writeScopeVersion: 1,
    });
    expect(record.acceptance).toBeUndefined();
    expect(
      (
        await manager.startTask(
          { agent: "general", description: "Invalid", prompt: "Must not launch", writeScope: ["../outside/"] },
          options,
        )
      ).success,
    ).toBe(false);
    expect(
      (
        await manager.startTask(
          { agent: "verify", description: "No bootstrap", prompt: "Must not launch", writeScope: [] },
          options,
        )
      ).success,
    ).toBe(false);
    expect(
      (
        await manager.startTask(
          {
            agent: "general",
            description: "No MCP bypass",
            prompt: "Must not launch",
            writeScope: [],
            allowedMcpTools: ["mcp_fixture__write"],
          },
          options,
        )
      ).success,
    ).toBe(false);
  });
  it.each([
    false,
    true,
  ])("reviews a Markdown deliverable statically; rejected runner veto=%s", async (rejectedRunner) => {
    const file = "evaluation-report.md";
    fs.writeFileSync(path.join(cwd, file), "# Runtime report\n\n## 1. Evidence\nVerified document content.\n");
    save("implementation", (record) => {
      record.status = "running";
      record.description = "Write evaluation-report.md";
      record.prompt = "Produce the requested Markdown report";
    });
    await completeDelegation(
      job("implementation"),
      "Wrote evaluation-report.md; independently review document content.",
    );
    const target = read("implementation");
    const started = await manager.startTask(
      {
        agent: "verify",
        description: "Review report",
        prompt: "Read and check document only",
        reviewOf: { jobId: target.id, resultVersion: target.resultVersion! },
      },
      options,
    );
    expect(started.success).toBe(true);
    const actual = readFile(file, cwd);
    expect(actual.success).toBe(true);
    expect(actual.output).toContain("# Runtime report");
    const evidence: ReviewToolEvidence[] = [
      {
        tool: "read_file",
        success: actual.success,
        scope: "workspace",
        resolvedPaths: [path.join(cwd, file)],
        input: { file_path: file },
        outputDigest: createHash("sha256").update(actual.output).digest("hex"),
        completedAt: new Date().toISOString(),
      },
    ];
    if (rejectedRunner) {
      const invalid = await runVerificationTests(cwd, [file], 10000, undefined, "auto");
      expect(invalid.success).toBe(false);
      expect(invalid.output).toContain("Invalid test file");
      evidence.push({
        ...evidence[0]!,
        tool: "verification_run",
        success: false,
        input: { files: [file] },
        outputDigest: createHash("sha256").update(invalid.output!).digest("hex"),
      });
    }
    const id = started.delegation!.id;
    await completeDelegation(
      job(id),
      JSON.stringify({
        verdict: "pass",
        evidence: ["read_file confirms the requested document content; no executable test claim"],
      }),
      undefined,
      evidence,
    );
    await manager.read(target.id);
    const raw = await manager.read(id);
    expect(raw).toContain('"toolEvidence"');
    expect(raw).toContain("Host review evidence sha256=");
    expect(delegationResultForDisplay(raw)).not.toContain('"toolEvidence"');
    expect(delegationResultForDisplay(raw)).toContain('"verdict":"pass"');
    const accepted = await manager.accept({
      jobId: target.id,
      resultVersion: target.resultVersion!,
      reviewJobId: id,
      reviewResultVersion: read(id).resultVersion!,
    });
    expect(accepted.success).toBe(!rejectedRunner);
    if (rejectedRunner) expect(accepted.output).toContain("failed_verification_evidence");
    else expect(read(target.id).acceptance?.reviewLevel).toBe("static");
  });
  it("inherits the owned reviewed job cwd when omitted and refuses an explicit mismatch", async () => {
    const child = path.join(cwd, "probe2");
    fs.mkdirSync(child);
    save("implementation", (r) => {
      r.cwd = child;
    });
    const target = read("implementation"),
      request = {
        agent: "verify",
        description: "Review nested probe",
        prompt: "Inspect recorded output",
        reviewOf: { jobId: target.id, resultVersion: target.resultVersion! },
      };
    const result = await manager.startTask(request, options);
    expect(result.success).toBe(true);
    expect(read(result.delegation!.id).cwd).toBe(child);
    const mismatch = await manager.startTask({ ...request, cwd }, options);
    expect(mismatch.success).toBe(false);
    expect(mismatch.output).toContain("review_workspace_mismatch");
    expect(mismatch.output).toContain(child);
    expect(mismatch.output).toContain("Omit cwd");
  });
  it("accepts real node test evidence after a fresh verify job and survives restart", async () => {
    fs.writeFileSync(path.join(cwd, "value.cjs"), "module.exports=1;");
    expect((await runVerificationTests(cwd, ["value.test.cjs"], 10000, undefined, "node")).success).toBe(false);
    fs.writeFileSync(path.join(cwd, "value.cjs"), "module.exports=2;");
    const input = await review();
    expect(read(input.reviewJobId).hostReview?.contextId).toBeTruthy();
    expect(read("implementation").acceptance).toBeUndefined();
    expect(
      (
        await new DelegationManager(
          () => cwd,
          () => "owner",
        ).accept(input)
      ).success,
    ).toBe(true);
    expect(read("implementation").acceptance).toMatchObject({ ...input, reviewLevel: "executed" });
    expect(await manager.read("implementation")).toContain("Acceptance: accepted");
    expect((await manager.accept(input)).success).toBe(false);
  });
  it("accepts static host inspection explicitly without claiming executed tests", async () => {
    const input = await review("static");
    expect((await manager.accept(input)).success).toBe(true);
    expect(read(input.jobId).acceptance?.reviewLevel).toBe("static");
  });
  it("ACK alone cannot accept; prose and missing actual evidence are refused", async () => {
    const input = await review(false);
    await manager.acknowledge(input.jobId, input.resultVersion);
    expect(read(input.jobId).acceptance).toBeUndefined();
    expect((await manager.accept(input)).success).toBe(false);
  });
  it.each([
    "self",
    "foreign",
    "stale-target",
    "stale-review",
    "tamper-target",
    "tamper-review",
    "undelivered",
    "cancelled",
    "verdict",
    "binding",
    "source",
    "council",
    "failed-evidence",
    "helper",
  ])("refuses %s without acceptance", async (control) => {
    const input = await review();
    if (control === "self") input.reviewJobId = input.jobId;
    if (control === "foreign")
      manager = new DelegationManager(
        () => cwd,
        () => "other-owner",
      );
    if (control === "stale-target") input.resultVersion = "stale";
    if (control === "stale-review") input.reviewResultVersion = "stale";
    if (control === "tamper-target") fs.appendFileSync(read(input.jobId).outputPath, "tampered");
    if (control === "tamper-review") fs.appendFileSync(read(input.reviewJobId).outputPath, "tampered");
    if (control === "undelivered")
      save(input.reviewJobId, (r) => {
        delete r.deliveredVersion;
      });
    if (control === "cancelled")
      save(input.reviewJobId, (r) => {
        r.status = "cancelled";
      });
    if (control === "verdict")
      save(input.reviewJobId, (r) => {
        delete r.hostReview!.verdict;
      });
    if (control === "binding")
      save(input.reviewJobId, (r) => {
        r.reviewOf!.resultVersion = "stale";
      });
    if (control === "source") fs.appendFileSync(path.join(cwd, "value.cjs"), "// changed");
    if (control === "council")
      save(input.jobId, (r) => {
        r.kind = "council";
      });
    if (control === "failed-evidence")
      save(input.reviewJobId, (r) => {
        r.hostReview!.toolEvidence![0]!.success = false;
      });
    if (control === "helper") vi.stubEnv("MUONROI_BACKGROUND_CHILD", "1");
    expect((await manager.accept(input)).success).toBe(false);
    expect(read(input.jobId).acceptance).toBeUndefined();
  });
  it("refuses review dispatch of a foreign, stale or unsuccessful target", async () => {
    const req = {
      agent: "verify",
      description: "Review",
      prompt: "Tests",
      reviewOf: { jobId: "implementation", resultVersion: "stale" },
    };
    expect((await manager.startTask(req, options)).success).toBe(false);
    req.reviewOf.resultVersion = read("implementation").resultVersion!;
    save("implementation", (r) => {
      r.status = "error";
    });
    expect((await manager.startTask(req, options)).success).toBe(false);
  });
  it("rejects source repair performed as a test side effect", async () => {
    const target = read("implementation");
    const started = await manager.startTask(
      {
        agent: "verify",
        description: "Review",
        prompt: "Test",
        reviewOf: { jobId: target.id, resultVersion: target.resultVersion! },
      },
      options,
    );
    fs.writeFileSync(
      path.join(cwd, "repair.test.cjs"),
      "require('node:fs').writeFileSync('value.cjs','module.exports=3;'); require('node:test').test('repair',()=>{});",
    );
    expect((await runVerificationTests(cwd, ["repair.test.cjs"], 10000, undefined, "node")).success).toBe(true);
    await expect(
      completeDelegation(job(started.delegation!.id), JSON.stringify({ verdict: "pass", evidence: ["repaired"] })),
    ).rejects.toThrow(/modified source/);
    expect(read(started.delegation!.id).status).toBe("running");
  });
  it("invalidates displayed acceptance when the saved review is tampered after acceptance", async () => {
    const input = await review();
    expect((await manager.accept(input)).success).toBe(true);
    fs.appendFileSync(read(input.reviewJobId).outputPath, "tampered after acceptance");
    expect(await manager.read(input.jobId)).toContain("Acceptance: stale-source-or-evidence");
  });
  it("invalidates displayed acceptance after source changes", async () => {
    const input = await review();
    expect((await manager.accept(input)).success).toBe(true);
    fs.appendFileSync(path.join(cwd, "value.cjs"), "// changed after acceptance");
    expect(await manager.read(input.jobId)).toContain("Acceptance: stale-source");
  });
});
describe("source snapshot coverage", () => {
  it("hashes tracked dist files and nonignored untracked tests", async () => {
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    fs.mkdirSync(path.join(cwd, "dist"));
    fs.writeFileSync(path.join(cwd, "dist", "source.js"), "before");
    fs.writeFileSync(path.join(cwd, ".gitignore"), "dist/\n");
    execFileSync("git", ["-C", cwd, "add", "-f", "dist/source.js"], { stdio: "ignore" });
    const before = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "dist", "source.js"), "after");
    expect(await sourceFingerprint(cwd)).not.toBe(before);
    const second = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "extra.test.cjs"), "new source");
    expect(await sourceFingerprint(cwd)).not.toBe(second);
  });
  it("does not bless an empty Git manifest inside an ignored nested workspace", async () => {
    execFileSync("git", ["init", home], { stdio: "ignore" });
    fs.writeFileSync(path.join(home, ".gitignore"), "workspace/\n");
    const before = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "value.cjs"), "changed");
    expect(await sourceFingerprint(cwd)).not.toBe(before);
  });
  it("uses a complete Git manifest beyond 117k tracked entries without the nongit file cap", async () => {
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    const oid = execFileSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], {
      input: "stable\n",
      encoding: "utf8",
    }).trim();
    const manifest = Array.from(
      { length: 117001 },
      (_, index) => `100644 ${oid}\tinput-${String(index).padStart(6, "0")}.txt\n`,
    ).join("");
    execFileSync("git", ["-C", cwd, "update-index", "--index-info"], { input: manifest, maxBuffer: 32 * 1024 * 1024 });
    const first = await sourceFingerprint(cwd);
    expect(first).toHaveLength(64);
    fs.writeFileSync(path.join(cwd, "value.cjs"), "large checkout dirty change");
    expect(await sourceFingerprint(cwd)).not.toBe(first);
  }, 60000);
  it("fails closed when Git hides working changes with assume-unchanged flags", async () => {
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "add", "value.cjs"]);
    execFileSync("git", ["-C", cwd, "update-index", "--assume-unchanged", "value.cjs"]);
    await expect(sourceFingerprint(cwd)).rejects.toThrow(/assume-unchanged/);
  });
  it.each([
    false,
    true,
  ])("supports sparse absent/present paths including combined assume-unchanged=%s", async (combined) => {
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "add", "value.cjs", "value.test.cjs"]);
    execFileSync("git", ["-C", cwd, "update-index", "--skip-worktree", "value.cjs", "value.test.cjs"]);
    if (combined) execFileSync("git", ["-C", cwd, "update-index", "--assume-unchanged", "value.cjs", "value.test.cjs"]);
    fs.unlinkSync(path.join(cwd, "value.test.cjs"));
    const before = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "value.cjs"), "present skipped path changed");
    expect(await sourceFingerprint(cwd)).not.toBe(before);
    const absent = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "value.test.cjs"), "materialized sparse source");
    expect(await sourceFingerprint(cwd)).not.toBe(absent);
  });
  it("ignored nested source identity excludes unrelated ancestor Git metadata", async () => {
    execFileSync("git", ["init", home], { stdio: "ignore" });
    fs.writeFileSync(path.join(home, ".gitignore"), "workspace/\n");
    const before = await sourceFingerprint(cwd);
    execFileSync("git", ["-C", home, "config", "user.name", "Unrelated parent metadata change"]);
    expect(await sourceFingerprint(cwd)).toBe(before);
  });
  it("hashes regular Windows representations of tracked symlinks and their absence", async () => {
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    const oid = execFileSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], {
      input: "value.cjs",
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", cwd, "update-index", "--index-info"], { input: `120000 ${oid}\trepresented-link\n` });
    fs.writeFileSync(path.join(cwd, "represented-link"), "value.cjs");
    const before = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "represented-link"), "different-target-text");
    expect(await sourceFingerprint(cwd)).not.toBe(before);
    fs.unlinkSync(path.join(cwd, "represented-link"));
    expect(await sourceFingerprint(cwd)).not.toBe(before);
  });
  it("captures initialized in-root Git subtrees and distinguishes empty/absent unknown gitlinks", async () => {
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    const nested = path.join(cwd, "module");
    fs.mkdirSync(nested);
    execFileSync("git", ["init", nested], { stdio: "ignore" });
    fs.writeFileSync(path.join(nested, "nested.cjs"), "original nested source");
    execFileSync("git", ["-C", nested, "add", "nested.cjs"]);
    execFileSync(
      "git",
      ["-C", nested, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"],
      { stdio: "ignore" },
    );
    const oid = execFileSync("git", ["-C", nested, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", cwd, "update-index", "--index-info"], {
      input: `160000 ${oid}\tmodule\n160000 ${oid}\tempty-module\n`,
    });
    fs.mkdirSync(path.join(cwd, "empty-module"));
    execFileSync("git", ["-C", cwd, "update-index", "--skip-worktree", "module"]);
    const before = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(nested, "nested.cjs"), "dirty one");
    const dirty = await sourceFingerprint(cwd);
    expect(dirty).not.toBe(before);
    fs.writeFileSync(path.join(nested, "nested.cjs"), "dirty two");
    expect(await sourceFingerprint(cwd)).not.toBe(dirty);
    fs.writeFileSync(path.join(cwd, "empty-module", "unknown.cjs"), "uninitialized mutable source");
    await expect(sourceFingerprint(cwd)).rejects.toThrow(/Nonempty uninitialized gitlink/);
    fs.rmSync(path.join(cwd, "empty-module"), { recursive: true, force: true });
    expect(await sourceFingerprint(cwd)).toHaveLength(64);
  });
  it("hashes native in-root file symlink targets and refuses external or directory links", async () => {
    const link = path.join(cwd, "native-link.cjs");
    fs.symlinkSync(path.join(cwd, "value.cjs"), link, "file");
    const before = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "value.cjs"), "changed target bytes");
    expect(await sourceFingerprint(cwd)).not.toBe(before);
    fs.unlinkSync(link);
    const external = path.join(home, "outside.cjs");
    fs.writeFileSync(external, "outside source");
    fs.symlinkSync(external, link, "file");
    await expect(sourceFingerprint(cwd)).rejects.toThrow(/External source symlink/);
    fs.unlinkSync(link);
    fs.symlinkSync(cwd, path.join(cwd, "loop"), process.platform === "win32" ? "junction" : "dir");
    await expect(sourceFingerprint(cwd)).rejects.toThrow(/unsupported entry/);
  });
  it("captures an untracked embedded Git root instead of losing its mutable source", async () => {
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    const nested = path.join(cwd, "embedded");
    fs.mkdirSync(nested);
    execFileSync("git", ["init", nested], { stdio: "ignore" });
    fs.writeFileSync(path.join(nested, "source.cjs"), "before");
    const before = await sourceFingerprint(cwd);
    fs.writeFileSync(path.join(nested, "source.cjs"), "after");
    expect(await sourceFingerprint(cwd)).not.toBe(before);
  });
  it("streams a 36MiB input within the shared budget and detects changed tail bytes", async () => {
    const file = path.join(cwd, "large.source");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 36 * 1024 * 1024);
    const before = await sourceFingerprint(cwd);
    const fd = fs.openSync(file, "r+");
    try {
      fs.writeSync(fd, "changed tail", 36 * 1024 * 1024 - 12);
    } finally {
      fs.closeSync(fd);
    }
    expect(await sourceFingerprint(cwd)).not.toBe(before);
  });
  it("fails closed on an oversized source file", async () => {
    fs.writeFileSync(path.join(cwd, "big.source"), "");
    fs.truncateSync(path.join(cwd, "big.source"), 256 * 1024 * 1024 + 1);
    await expect(sourceFingerprint(cwd)).rejects.toThrow(/limit/);
  });
});

describe("durable council lifecycle", () => {
  it("starts a dedicated infrastructure job without widening ordinary delegate", async () => {
    const brief = {
      topic: "Architecture tradeoff",
      reason: "Need advice",
      context: "Bounded source facts",
      outputContract: "Advice with evidence and limits",
    };
    expect(
      (await manager.start({ agent: "council", description: "No widening", prompt: "No ordinary council" }, options))
        .success,
    ).toBe(false);
    const started = await manager.startCouncil(brief, options);
    expect(started.success).toBe(true);
    const id = started.delegation!.id;
    expect(read(id)).toMatchObject({
      kind: "council",
      council: brief,
      status: "running",
      executionRole: "infrastructure",
      parentSessionId: "owner",
    });
    await completeDelegation(job(id), "Independent advice only");
    expect(read(id).acknowledgedVersion).toBeUndefined();
    expect(await manager.read(id)).toContain("Independent advice only");
    expect((await manager.acknowledge(id, read(id).resultVersion!)).success).toBe(true);
    expect(read(id).acceptance).toBeUndefined();
  });
  it.each([
    false,
    true,
  ])("persists council failure/cancellation rather than success (cancelled=%s)", async (cancelled) => {
    const started = await manager.startCouncil(
      { topic: "Topic", reason: "Reason", context: "", outputContract: "Advice" },
      options,
    );
    const id = started.delegation!.id;
    await failDelegation(job(id), cancelled ? "Cancelled by owner" : "Council returned empty synthesis", "", {
      cancelled,
    });
    expect(read(id).status).toBe(cancelled ? "cancelled" : "error");
    expect((await manager.waitResult(id)).success).toBe(false);
  });
  it("host foreground wait returns delivered current version and evidence, never a launch receipt", async () => {
    const target = read("implementation");
    expect((await manager.waitResult(target.id)).output).toContain(`resultVersion=${target.resultVersion}`);
    const started = await manager.startTask(
      { agent: "general", description: "Foreground durable", prompt: "Bounded work" },
      options,
    );
    const id = started.delegation!.id;
    const completion = new Promise<void>((resolve) =>
      setTimeout(() => {
        completeDelegation(job(id), "Real terminal output").then(resolve);
      }, 150),
    );
    const result = await manager.waitResult(id);
    await completion;
    expect(result.success).toBe(true);
    expect(result.output).toContain("Real terminal output");
    expect(result.output).toContain("Delivery: delivered");
    expect(read(id).deliveredVersion).toBe(read(id).resultVersion);
    expect(read(id).acceptance).toBeUndefined();
  });
});

describe("durable owner-bound raw tool artifacts", () => {
  async function rawJob(failed = false) {
    const started = await manager.startTask(
      { agent: "general", description: "Evidence", prompt: "Read source" },
      options,
    );
    const id = started.delegation!.id;
    await saveDelegationToolResult(
      job(id),
      "raw-read",
      "read_file",
      { file_path: "value.cjs" },
      `HEAD-${"raw source\n".repeat(3000)}-UNIQUE_RAW_TAIL`,
    );
    if (failed) await failDelegation(job(id), "Fixture worker failed after its read");
    else await completeDelegation(job(id), "Read artifact available; no reasoning inherited");
    return id;
  }
  it.each([false, true])("survives child exit/restart and pages full raw results for failed=%s", async (failed) => {
    const id = await rawJob(failed);
    const record = read(id);
    const restarted = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    const first = await restarted.readToolArtifact(id, "raw-read", record.resultVersion, 0, 24000);
    expect(first.success).toBe(true);
    expect(first.output).toContain("nextOffset=24000");
    expect(first.output).not.toContain("UNIQUE_RAW_TAIL");
    const last = await restarted.readToolArtifact(id, "raw-read", record.resultVersion, 24000, 24000);
    expect(last.success).toBe(true);
    expect(last.output).toContain("UNIQUE_RAW_TAIL");
    expect(last.output).toContain(`resultVersion=${record.resultVersion}`);
  });
  it.each([
    "foreign",
    "stale",
    "missing",
    "manifest",
    "payload",
  ])("refuses %s raw artifact without arbitrary file access", async (control) => {
    const id = await rawJob();
    const record = read(id);
    if (control === "foreign")
      manager = new DelegationManager(
        () => cwd,
        () => "other-owner",
      );
    if (control === "manifest")
      save(id, (r) => {
        r.toolArtifacts![0]!.fileName = "../../value.cjs";
      });
    if (control === "payload")
      fs.appendFileSync(
        path.join(job(id).replace(/\.json$/, ".tools"), record.toolArtifacts![0]!.fileName),
        "tampered",
      );
    expect(
      (
        await manager.readToolArtifact(
          id,
          control === "missing" ? "missing-tool" : "raw-read",
          control === "stale" ? "old-version" : record.resultVersion,
        )
      ).success,
    ).toBe(false);
  });

  async function reviewer() {
    const id = await rawJob();
    const target = read(id);
    const binding = { jobId: id, resultVersion: target.resultVersion! };
    const started = await manager.startTask(
      {
        agent: "verify",
        description: "Verify raw recorded output",
        prompt: "Corroborate only the saved tool result",
        reviewOf: binding,
      },
      options,
    );
    expect(started.success).toBe(true);
    return { target, binding, reviewId: started.delegation!.id };
  }
  it("gives only the assigned host manifest and pages peer evidence outside the project", async () => {
    const { target, binding, reviewId } = await reviewer();
    const manifest = await readReviewArtifact(job(reviewId), binding);
    expect(manifest.success).toBe(true);
    expect(manifest.output).toContain('"toolCallId":"raw-read"');
    expect(manifest.output).not.toContain("Read artifact available; no reasoning inherited");
    const result = await readReviewArtifact(job(reviewId), binding, "raw-read", 24000, 24000);
    expect(result.success).toBe(true);
    expect(result.output).toContain("UNIQUE_RAW_TAIL");
    expect(result.artifact).toMatchObject({
      jobId: target.id,
      resultVersion: binding.resultVersion,
      toolCallId: "raw-read",
      offset: 24000,
    });
  });
  it.each([
    "foreign-owner",
    "foreign-job",
    "stale",
    "digest-as-id",
    "tampered",
    "workspace",
    "traversal",
  ])("rejects %s during peer artifact review", async (control) => {
    const { target, binding, reviewId } = await reviewer();
    if (control === "foreign-owner")
      save(reviewId, (r) => {
        r.parentSessionId = "other";
      });
    if (control === "workspace")
      save(reviewId, (r) => {
        r.cwd = home;
      });
    if (control === "tampered")
      fs.appendFileSync(
        path.join(job(target.id).replace(/\.json$/, ".tools"), target.toolArtifacts![0]!.fileName),
        "tamper",
      );
    const result = await readReviewArtifact(
      job(reviewId),
      control === "foreign-job"
        ? { ...binding, jobId: "implementation" }
        : control === "stale"
          ? { ...binding, resultVersion: "old" }
          : control === "traversal"
            ? { ...binding, jobId: "../implementation" }
            : binding,
      control === "digest-as-id" ? target.resultVersion : "raw-read",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("artifact_refused");
  });
  it("accepts fully read peer output as artifact corroboration, never as executed tests", async () => {
    const { target, binding, reviewId } = await reviewer();
    const evidence: ReviewToolEvidence[] = [];
    for (const offset of [0, 24000]) {
      const result = await readReviewArtifact(job(reviewId), binding, "raw-read", offset, 24000);
      expect(result.success).toBe(true);
      evidence.push({
        tool: "retrieve_tool_result",
        success: true,
        scope: "worker-artifact",
        artifact: result.artifact,
        input: { tool_call_id: "raw-read" },
        outputDigest: createHash("sha256").update(result.output).digest("hex"),
        completedAt: new Date().toISOString(),
      });
    }
    await completeDelegation(
      job(reviewId),
      JSON.stringify({ verdict: "pass", evidence: ["Full saved output corroborated; no tests executed"] }),
      undefined,
      evidence.slice(0, 1),
    );
    await manager.read(target.id);
    await manager.read(reviewId);
    let input = {
      jobId: target.id,
      resultVersion: target.resultVersion!,
      reviewJobId: reviewId,
      reviewResultVersion: read(reviewId).resultVersion!,
    };
    expect((await manager.accept(input)).success).toBe(false);
    save(reviewId, (r) => {
      r.status = "running";
    });
    await completeDelegation(
      job(reviewId),
      JSON.stringify({ verdict: "pass", evidence: ["Full saved output corroborated; no tests executed"] }),
      undefined,
      evidence,
    );
    await manager.read(reviewId);
    input = { ...input, reviewResultVersion: read(reviewId).resultVersion! };
    expect((await manager.accept(input)).success).toBe(true);
    expect(read(target.id).acceptance?.reviewLevel).toBe("artifact");
    expect(await manager.read(target.id)).toContain("Acceptance: accepted");
    fs.appendFileSync(
      path.join(job(target.id).replace(/\.json$/, ".tools"), target.toolArtifacts![0]!.fileName),
      "tamper",
    );
    expect(await manager.read(target.id)).toContain("Acceptance: stale-source-or-evidence");
  });
});
