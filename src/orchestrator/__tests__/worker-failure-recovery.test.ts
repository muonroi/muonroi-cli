import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DelegationManager,
  failDelegation,
  loadDelegation,
  type StoredDelegation,
  saveDelegationToolResult,
} from "../delegations.js";

let root: string;
let cwd: string;
let jobPath: string;
let manager: DelegationManager;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-recovery-"));
  cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  const scope = `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`;
  const dir = path.join(root, "delegations", scope);
  fs.mkdirSync(dir, { recursive: true });
  jobPath = path.join(dir, "failed-worker.json");
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      id: "failed-worker",
      agent: "general",
      description: "Edit fixture",
      prompt: "Edit once",
      cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath: path.join(dir, "failed-worker.md"),
      parentSessionId: "owner",
      model: "fixture",
      sandboxMode: "off",
      maxToolRounds: 3,
      maxTokens: 100,
    } satisfies StoredDelegation),
  );
  vi.stubEnv("MUONROI_CLI_HOME", root);
  manager = new DelegationManager(
    () => cwd,
    () => "owner",
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

it("hands off failed-after-edit evidence without replay, accepting or rewriting saved captures", async () => {
  const file = path.join(cwd, "fixture.txt");
  fs.writeFileSync(file, "edited once");
  await saveDelegationToolResult(jobPath, "edit-1", "edit_file", { path: file }, { success: true, output: "edited" });
  // An error result can also have partial effects; metadata must not claim rollback.
  await saveDelegationToolResult(
    jobPath,
    "edit-2",
    "edit_file",
    { path: file },
    { success: false, error: "interrupted" },
  );
  await failDelegation(
    jobPath,
    "worker_incomplete: no final answer was produced\nLast action: Edit file",
    "Everything is done.",
  );
  const record = await loadDelegation(jobPath);
  expect(record.status).toBe("error");
  expect(record.summary).not.toContain("Everything is done");
  expect((record as any).failureRecovery).toMatchObject({
    symptom: "missing-final-answer",
    rootCause: "not-established",
    capturedToolCalls: 2,
    mutationToolCalls: 2,
  });
  expect(record.acceptance).toBeUndefined();
  const saved = fs.readFileSync(record.outputPath, "utf8");
  const result = await manager.read("failed-worker");
  expect(result).toContain("Do not replay");
  expect(result).toContain("current files");
  expect(result).toContain("edit-2");
  expect(result).toContain(record.resultVersion!);
  expect(result).toContain("Acceptance: unverified");
  expect(fs.readFileSync(file, "utf8")).toBe("edited once");
  expect(fs.readFileSync(record.outputPath, "utf8")).toBe(saved);
  const artifact = record.toolArtifacts![0]!;
  const raw = fs.readFileSync(path.join(jobPath.replace(/\.json$/, ".tools"), artifact.fileName));
  expect(createHash("sha256").update(raw).digest("hex")).toBe(artifact.digest);
});

it("does not turn schema symptoms or later success into a proven prompt-length cause", async () => {
  await failDelegation(jobPath, "Task failed: Invalid prompt: The messages do not match the ModelMessage[] schema");
  expect(((await loadDelegation(jobPath)) as any).failureRecovery).toMatchObject({
    symptom: "model-message-schema",
    rootCause: "not-established",
  });
  expect(await manager.read("failed-worker")).toContain("does not establish prompt length");
});

it("does not classify quoted research as the terminal error or Access denied as proof of a lock holder", async () => {
  await failDelegation(
    jobPath,
    "Research: Invalid prompt: The messages do not match the ModelMessage[] schema\n\nTask failed: Access to the path 'Microsoft.SourceLink.GitHub.dll' is denied",
  );
  expect(((await loadDelegation(jobPath)) as any).failureRecovery.symptom).toBe("unclassified");
  expect(await manager.read("failed-worker")).toContain("does not identify a lock holder");
});

it("adds recovery guidance on legacy reads without changing the old result version", async () => {
  await failDelegation(jobPath, "worker_incomplete: no final answer was produced");
  const record = await loadDelegation(jobPath);
  delete (record as any).failureRecovery;
  fs.writeFileSync(jobPath, JSON.stringify(record));
  const before = fs.readFileSync(record.outputPath, "utf8");
  expect(await manager.read("failed-worker")).toContain("Do not replay");
  expect((await loadDelegation(jobPath)).resultVersion).toBe(record.resultVersion);
  expect(fs.readFileSync(record.outputPath, "utf8")).toBe(before);
});
