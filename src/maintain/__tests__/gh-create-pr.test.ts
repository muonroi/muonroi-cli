/**
 * gh-create-pr.test.ts — P16 unit tests.
 *
 * Covers:
 *   1. ok=true with URL parsed from gh stdout.
 *   2. gh not installed → ok=false with clear reason.
 *   3. gh not authed → ok=false with auth error message.
 *   4. git push fails → ok=false with push error.
 *   5. branch name with invalid chars → ok=false immediately (no git/gh calls).
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

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import type { GhCreatePrInput } from "../gh-create-pr.js";
// execFileMock alias → mockExecFile defined above via vi.mock hoisting
import { ghCreatePr } from "../gh-create-pr.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ExecFileMock = ReturnType<typeof vi.fn>;

/**
 * Sets up a sequence of execFile responses in call order.
 * Each entry matches the next invocation.
 */
function setupSequence(responses: Array<{ stdout?: string; fail?: boolean; stderr?: string }>) {
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
        const err = new Error(resp.stderr ?? "command failed");
        (err as unknown as Record<string, unknown>).stderr = resp.stderr ?? "";
        (err as unknown as Record<string, unknown>).stdout = "";
        cb(err, { stdout: "", stderr: resp.stderr ?? "" });
      } else {
        cb(null, { stdout: resp.stdout ?? "", stderr: "" });
      }
    },
  );
}

function makeInput(overrides: Partial<GhCreatePrInput> = {}): GhCreatePrInput {
  return {
    branch: "claude/bug-01hx1234",
    title: "Fix null pointer in login handler",
    body: "## Summary\nFix the null pointer.",
    cwd: "/tmp/proj",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ghCreatePr — happy path (ok=true with URL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok=true and the PR URL on full success", async () => {
    setupSequence([
      { stdout: "gh version 2.x.x" }, // gh --version
      { stdout: "Logged in to github.com as user" }, // gh auth status
      { fail: true }, // git rev-parse --verify branch (doesn't exist)
      { stdout: "" }, // git checkout -b
      { stdout: "" }, // git push -u origin
      { stdout: "main" }, // gh repo view --json ...
      { stdout: "https://github.com/owner/repo/pull/42\n" }, // gh pr create
    ]);

    const input = makeInput();
    const output = await ghCreatePr(input);

    expect(output.ok).toBe(true);
    expect(output.url).toBe("https://github.com/owner/repo/pull/42");
  });
});

describe("ghCreatePr — gh not installed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok=false with 'not installed' message when gh --version fails", async () => {
    setupSequence([
      { fail: true, stderr: "command not found: gh" }, // gh --version
    ]);

    const output = await ghCreatePr(makeInput());

    expect(output.ok).toBe(false);
    expect(output.reason).toMatch(/not installed/i);
  });
});

describe("ghCreatePr — gh not authed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok=false with 'not authenticated' when gh auth status fails", async () => {
    setupSequence([
      { stdout: "gh version 2.x.x" }, // gh --version
      { fail: true, stderr: "You are not logged into any GitHub hosts" }, // gh auth status
    ]);

    const output = await ghCreatePr(makeInput());

    expect(output.ok).toBe(false);
    expect(output.reason).toMatch(/not authenticated/i);
  });
});

describe("ghCreatePr — git push fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok=false with push failure reason when git push -u origin fails", async () => {
    setupSequence([
      { stdout: "gh version 2.x.x" }, // gh --version
      { stdout: "Logged in to github.com" }, // gh auth status
      { fail: true }, // git rev-parse --verify (branch doesn't exist)
      { stdout: "" }, // git checkout -b
      { fail: true, stderr: "remote: Permission denied" }, // git push -u origin
    ]);

    const output = await ghCreatePr(makeInput());

    expect(output.ok).toBe(false);
    expect(output.reason).toMatch(/push failed/i);
    expect(output.reason).toContain("Permission denied");
  });
});

describe("ghCreatePr — invalid branch name rejected immediately", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok=false without calling any child_process when branch has invalid chars", async () => {
    const output = await ghCreatePr(makeInput({ branch: "claude/bug; rm -rf /" }));

    expect(output.ok).toBe(false);
    expect(output.reason).toMatch(/invalid characters/i);
    // execFile should NOT have been called at all.
    expect(mockExecFile as unknown as ExecFileMock).not.toHaveBeenCalled();
  });

  it("rejects branch names with shell metacharacters", async () => {
    const output = await ghCreatePr(makeInput({ branch: "feature/$(evil)" }));
    expect(output.ok).toBe(false);
    expect(output.reason).toMatch(/invalid characters/i);
    expect(mockExecFile as unknown as ExecFileMock).not.toHaveBeenCalled();
  });
});
