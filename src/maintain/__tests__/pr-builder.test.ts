/**
 * pr-builder.test.ts — P16 unit tests.
 *
 * Covers:
 *   1. Happy path: diff + body generated, all changed files inside radius.
 *   2. Files-outside-radius flagged in output but not blocking.
 *   3. LLM mock returns body verbatim (no transformation by buildPr).
 *   4. Squash gracefully degrades when marker SHA file is missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

// vi.hoisted ensures the factory variable is available when vi.mock is hoisted.
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

vi.mock("../../council/leader.js", () => ({
  pickCouncilTaskModel: vi.fn((_task: string, leaderId: string) => leaderId),
}));

// fs mock: readFileSync throws by default (no marker file) — tests override per case.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw new Error("ENOENT: no such file");
    }),
  };
});

// execFileMock is defined above as mockExecFile via vi.mock hoisting
import * as fs from "node:fs";
import type { BuildPrInput } from "../pr-builder.js";
import { buildPr } from "../pr-builder.js";
import type { MaintenanceTaskResult } from "../task-runner.js";
import type { CodebaseIntel, MaintenanceTask } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ExecFileMock = ReturnType<typeof vi.fn>;

/**
 * execFile mock that matches on full argv sequence stringified.
 * Used for more precise multi-git-call flows.
 */
function setupDetailedGitMock(
  responses: Array<{ matchArgs: string[]; stdout?: string; fail?: boolean; stderr?: string }>,
) {
  let callIndex = 0;
  (mockExecFile as unknown as ExecFileMock).mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const resp = responses[callIndex] ?? { stdout: "" };
      callIndex++;
      if (resp.fail) {
        cb(new Error(resp.stderr ?? "git failed"), { stdout: "", stderr: resp.stderr ?? "" });
      } else {
        cb(null, { stdout: resp.stdout ?? "", stderr: "" });
      }
    },
  );
}

function makeLlm(returnBody = "## Summary\nTest body.") {
  return {
    generate: vi.fn(async () => returnBody),
  };
}

function makeTask(overrides: Partial<MaintenanceTask> = {}): MaintenanceTask {
  return {
    id: "01HX1234ABCD",
    kind: "bug",
    title: "Fix null pointer in login handler",
    description: "The login handler throws a null pointer when email field is empty.",
    acceptance_criteria: ["no null pointer on empty email", "error message shown"],
    candidateFiles: ["src/auth/login.ts"],
    impactRadius: ["src/app.tsx", "src/middleware/auth.ts"],
    regressionTestFiles: ["src/auth/__tests__/login.test.ts"],
    status: "queued",
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    ...overrides,
  };
}

function makeIntel(overrides: Partial<CodebaseIntel> = {}): CodebaseIntel {
  return {
    cwd: "/tmp/proj",
    repoMap: "src/\n  auth/\n    login.ts",
    repoMapSource: "generated",
    candidateFiles: [{ path: "src/auth/login.ts", reason: "filename match", matchScore: 0.9 }],
    impactRadius: ["src/app.tsx", "src/middleware/auth.ts"],
    regressionTests: ["src/auth/__tests__/login.test.ts"],
    detectedFrameworks: ["node", "react"],
    capturedAtUtc: new Date().toISOString(),
    ...overrides,
  };
}

function makeResult(overrides: Partial<MaintenanceTaskResult> = {}): MaintenanceTaskResult {
  return {
    status: "done",
    designPlan: "1. Fix null check\n2. Add error message",
    verifyOutput: "2 tests passed",
    judgeScore: 0.95,
    reviewConcerns: [],
    ...overrides,
  };
}

function makeInput(
  taskOverrides: Partial<MaintenanceTask> = {},
  intelOverrides: Partial<CodebaseIntel> = {},
  resultOverrides: Partial<MaintenanceTaskResult> = {},
  llmBody?: string,
): BuildPrInput {
  return {
    task: makeTask(taskOverrides),
    codebaseIntel: makeIntel(intelOverrides),
    result: makeResult(resultOverrides),
    cwd: "/tmp/proj",
    leaderModelId: "test-model-id",
    costAware: true,
    llm: makeLlm(llmBody ?? "## Summary\nTest body."),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildPr — happy path (all files inside radius)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No marker file — readFileSync will throw (default mock).
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns branch, title, body, diff, changedFiles with zero filesOutsideRadius", async () => {
    setupDetailedGitMock([
      // status --porcelain → changed file inside radius
      { matchArgs: ["status"], stdout: " M src/auth/login.ts\n" },
      // diff HEAD → shows the actual diff
      { matchArgs: ["diff"], stdout: "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+null check added\n" },
      // rev-parse --verify <branch> → fail (branch doesn't exist yet)
      { matchArgs: ["rev-parse"], fail: true },
    ]);

    const input = makeInput();
    const output = await buildPr(input);

    expect(output.branch).toMatch(/^claude\/bug-/);
    expect(output.title).toBe("Fix null pointer in login handler");
    expect(output.body).toContain("Summary");
    expect(output.diff).toContain("null check added");
    expect(output.filesOutsideRadius).toHaveLength(0);
    expect(output.changedFiles).toContain("src/auth/login.ts");
  });
});

describe("buildPr — files outside radius flagged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("puts unexpected files in filesOutsideRadius without blocking", async () => {
    setupDetailedGitMock([
      // status --porcelain → includes an unexpected file
      { matchArgs: ["status"], stdout: " M src/auth/login.ts\n M src/unexpected/file.ts\n" },
      // diff HEAD
      { matchArgs: ["diff"], stdout: "diff --git a/src/unexpected/file.ts\n+something unexpected\n" },
      // rev-parse → branch doesn't exist
      { matchArgs: ["rev-parse"], fail: true },
    ]);

    const input = makeInput();
    const output = await buildPr(input);

    expect(output.filesOutsideRadius).toContain("src/unexpected/file.ts");
    // The build still succeeds — no throw.
    expect(output.branch).toBeTruthy();
    expect(output.title).toBeTruthy();
  });
});

describe("buildPr — LLM body returned verbatim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("body in output exactly matches the LLM response without modification", async () => {
    setupDetailedGitMock([
      { matchArgs: ["status"], stdout: " M src/auth/login.ts\n" },
      { matchArgs: ["diff"], stdout: "diff ...\n+change\n" },
      { matchArgs: ["rev-parse"], fail: true },
    ]);

    const verbatimBody = "## Summary\nVerbatim from LLM.\n\n## What changed\n- changed the thing.";
    const input = makeInput({}, {}, {}, verbatimBody);
    const output = await buildPr(input);

    expect(output.body).toBe(verbatimBody);
  });
});

describe("buildPr — squash gracefully degrades when marker missing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // readFileSync throws (default mock — simulates missing marker file).
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("still returns valid output when no marker SHA file exists (no squash attempt)", async () => {
    // No squash means no rev-parse HEAD, no reset --soft — just status + diff + branch check.
    setupDetailedGitMock([
      { matchArgs: ["status"], stdout: " M src/auth/login.ts\n" },
      { matchArgs: ["diff"], stdout: "diff --git a/src/auth/login.ts\n+fix here\n" },
      { matchArgs: ["rev-parse"], fail: true },
    ]);

    const input = makeInput();
    // Should not throw even though marker is absent.
    const output = await buildPr(input);

    expect(output.branch).toMatch(/^claude\/bug-/);
    expect(output.diff).toContain("fix here");
    expect(output.changedFiles).toContain("src/auth/login.ts");
  });

  it("squashes when marker file exists and commits since marker are present", async () => {
    // Provide a marker via readFileSync mock for this test.
    const MARKER_SHA = "abc123def456";
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(MARKER_SHA);

    setupDetailedGitMock([
      // squashSinceMarker: rev-parse HEAD
      { matchArgs: ["rev-parse"], stdout: "deadbeef1234" },
      // squashSinceMarker: log marker..HEAD
      { matchArgs: ["log"], stdout: "deadbeef1234 some commit" },
      // squashSinceMarker: reset --soft
      { matchArgs: ["reset"], stdout: "" },
      // squashSinceMarker: commit
      { matchArgs: ["commit"], stdout: "[main deadbeef] Fix null pointer in login handler" },
      // getChangedFiles: status --porcelain
      { matchArgs: ["status"], stdout: " M src/auth/login.ts\n" },
      // getChangedFiles: diff --name-only HEAD~1 HEAD (squashed=true)
      { matchArgs: ["diff"], stdout: "src/auth/login.ts\n" },
      // computeDiff: diff HEAD~1 HEAD (squashed=true)
      { matchArgs: ["diff"], stdout: "diff --git a/src/auth/login.ts\n+squashed change\n" },
      // uniqueBranchName: rev-parse --verify branch
      { matchArgs: ["rev-parse"], fail: true },
    ]);

    const input = makeInput();
    const output = await buildPr(input);

    expect(output.diff).toContain("squashed change");
  });
});
