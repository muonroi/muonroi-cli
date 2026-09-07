/**
 * headless-exit-code.test.ts — spawn-based regression net for the headless
 * process exit code.
 *
 * ## Why this file exists
 *
 * `tests/integration/headless-golden.test.ts` is named "integration" but calls
 * `createHeadlessJsonlEmitter` directly, in-process. An emitter has no exit
 * code, so that file — and every other test in the repo — is structurally
 * incapable of observing one:
 *
 *     rg -l "exitCode" src/headless src/__tests__ tests   ->  (no matches)
 *
 * The exit code is only observable from OUTSIDE the process, so this file
 * spawns the real CLI as a subprocess and reads `$?`.
 *
 * ## What it pins, and what it deliberately does NOT
 *
 * It pins ONE direction only: **a headless turn that produced an answer must
 * exit 0.** Each row proves the turn really answered by asserting a sentinel
 * that the mock fixture put on stdout, so "exit 0" can never pass vacuously on
 * a run that silently did nothing.
 *
 * It says NOTHING about what a turn that produced no answer should exit. That
 * direction is intentionally left unpinned: a test that encoded it would be
 * asserting a design decision this file has no standing to make, and would
 * pre-empt whoever implements it.
 *
 * The rows mirror the outcome matrix in `scripts/agent-drivability-score.ts`
 * (axis A7, rows R1/R2/R5). The referee is the measuring instrument and is
 * deliberately NOT imported — it must not share a module with the thing it
 * measures — so the spawn recipe is transcribed here instead.
 *
 * The third row is the anti-gaming one: a turn that emits BOTH an answer and an
 * error still exits 0. Without it, "any error reported => exit 1" would look
 * like a valid fix.
 *
 * ## Cost
 *
 * All three subprocesses are spawned once, in parallel, from a single
 * `beforeAll`; the `it()` blocks only assert over the captured results. Each
 * child gets its own HOME and its own working directory, so the runs cannot
 * observe each other's session DB or settings — which is also what keeps them
 * cheap (a child pointed at a real HOME pays for settings, the EE bridge and
 * session persistence).
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MODULE = "headless-exit-code.test";

/** Repo entry point — the same one `package.json`'s `dev` script runs. */
const ENTRY = resolve("src/index.ts");
/** Fixture dirs consumed by `--mock-llm` (see `loadMockModelFromDir`). */
const FIXTURES = resolve("tests/integration/fixtures/headless-exit-code");

/** Generous: covers a cold `bun` transpile of the whole entry graph. */
const SPAWN_TIMEOUT_MS = 120_000;

type Row = {
  id: string;
  label: string;
  /** Subdirectory of {@link FIXTURES} handed to `--mock-llm`. */
  fixture: string;
  format: "json" | "text";
  /**
   * Text the fixture puts on stdout. Asserting it is what stops `exit === 0`
   * from passing vacuously: it proves the turn actually produced an answer,
   * which is the precondition the exit code is being checked against.
   */
  sentinel: string;
};

const ROWS: readonly Row[] = [
  {
    id: "R1",
    label: "--format json, a turn that answers",
    fixture: "answered",
    format: "json",
    sentinel: "PONG",
  },
  {
    id: "R2",
    label: "--format text, a turn that answers",
    fixture: "answered",
    format: "text",
    sentinel: "PONG",
  },
  {
    id: "R5",
    label: "--format json, a turn that answers AND reports an error",
    fixture: "answered-with-error",
    format: "json",
    sentinel: "PARTIAL ANSWER OK",
  },
];

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set only when the child could not be spawned or timed out. */
  error?: string;
};

function runHeadless(row: Row, home: string, childCwd: string): Promise<RunResult> {
  const argv = [
    "run",
    ENTRY,
    "-p",
    "Reply PONG",
    "--format",
    row.format,
    "--mock-llm",
    join(FIXTURES, row.fixture),
    // The child runs in a scratch dir: pointed at the repo it would scan this
    // (large) tree during discovery, which is slow and highly variable.
    "-d",
    childCwd,
    // A literal key so no credential is read from disk or the environment. The
    // mock model is installed by --mock-llm, so nothing is ever sent anywhere.
    "-k",
    "FAKE",
  ];

  return new Promise<RunResult>((res) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn("bun", argv, {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Isolate the child from the developer's real profile: its own settings,
        // its own session DB. Without this the runs are neither hermetic nor fast.
        HOME: home,
        USERPROFILE: home,
      },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      res({ code: null, stdout, stderr, error: `timeout after ${SPAWN_TIMEOUT_MS}ms` });
    }, SPAWN_TIMEOUT_MS);

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[${MODULE}] row ${row.id}: spawning bun failed: ${err?.message}`, {
        argv,
        stack: err?.stack?.split("\n").slice(0, 3),
      });
      res({ code: null, stdout, stderr, error: err?.message ?? String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

describe("headless exit code — a turn that answered exits 0", () => {
  const results = new Map<string, RunResult>();
  let root: string | null = null;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "muonroi-headless-exit-"));
    const settled = await Promise.all(
      ROWS.map(async (row) => {
        const home = join(root as string, `${row.id}-home`);
        const childCwd = join(root as string, `${row.id}-cwd`);
        mkdirSync(home, { recursive: true });
        mkdirSync(childCwd, { recursive: true });
        return [row.id, await runHeadless(row, home, childCwd)] as const;
      }),
    );
    for (const [id, r] of settled) results.set(id, r);
  }, 180_000);

  afterAll(() => {
    if (!root) return;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err) {
      // Non-fatal: a leaked temp dir must not fail the suite. Still logged so a
      // machine that leaks one every run is diagnosable.
      console.error(
        `[${MODULE}] temp dir cleanup failed (${root}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  for (const row of ROWS) {
    it(`${row.id} — ${row.label}`, () => {
      const r = results.get(row.id);
      expect(r, `row ${row.id} never ran`).toBeDefined();
      const res = r as RunResult;

      // Surface the child's own diagnostics when something went wrong, so a
      // failure here is debuggable without re-running by hand.
      expect(res.error ?? null, `row ${row.id} did not execute; stderr:\n${res.stderr}`).toBeNull();

      // Precondition: the turn really produced an answer. Without this the exit
      // assertion below could pass on a run that did nothing at all.
      expect(
        res.stdout.includes(row.sentinel),
        `row ${row.id}: expected the answer sentinel ${JSON.stringify(row.sentinel)} on stdout.\n` +
          `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      ).toBe(true);

      // The claim under test. Nothing is asserted about a turn that produces no
      // answer — see the header comment.
      expect(
        res.code,
        `row ${row.id}: the turn answered (${JSON.stringify(row.sentinel)} was on stdout) but the process exited ` +
          `${res.code}. A headless turn that produced an answer must exit 0.\nstderr:\n${res.stderr}`,
      ).toBe(0);
    });
  }
});
