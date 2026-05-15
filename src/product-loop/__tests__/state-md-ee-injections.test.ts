/**
 * P1.5 — state.md EE Injections section.
 *
 * Verifies that buildPriorContext writes an "EE Injections (Layer 3)" section
 * to state.md based on interaction_logs rows for the run, and that the fallback
 * text is rendered when there are 0 rows.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Static mocks (must precede dynamic imports) ───────────────────────────────

// Mock selectEEInjectionsForRun so we don't need a real SQLite DB.
// The mock is re-configured per-test via mockReturnValue.
vi.mock("../../storage/interaction-log.js", () => ({
  selectEEInjectionsForRun: vi.fn(() => []),
  logInteraction: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import type { CouncilLLM } from "../../council/types.js";
import type { EEInjectionRow } from "../../storage/interaction-log.js";
import { selectEEInjectionsForRun } from "../../storage/interaction-log.js";
import { writeManifest } from "../artifact-io.js";
import { buildPriorContext } from "../cross-run-memory.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStubLLM(): CouncilLLM {
  return {
    generate: vi.fn().mockRejectedValue(new Error("should not be called")),
    debate: vi.fn(),
    research: vi.fn(),
    generateObject: vi.fn(),
  } as unknown as CouncilLLM;
}

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ee-injections-"));
}

async function seedRun(flowDir: string, runId: string, idea: string): Promise<void> {
  await writeManifest(flowDir, runId, {
    idea,
    capUsd: 50,
    maxSprints: 8,
    doneThreshold: 0.9,
    createdAt: new Date(),
  });
}

function makePilRow(overrides: Partial<EEInjectionRow> = {}): EEInjectionRow {
  return {
    session_id: "run-fixture",
    event_subtype: "injected",
    duration_ms: null,
    metadata_json: JSON.stringify({ principleCount: 3, behavioralCount: 2 }),
    created_at: "2026-05-15T10:00:00.000Z",
    ...overrides,
  };
}

function makeExtractRow(overrides: Partial<EEInjectionRow> = {}): EEInjectionRow {
  return {
    session_id: "run-fixture",
    event_subtype: "extract",
    duration_ms: 420,
    metadata_json: JSON.stringify({ ok: true, stored: 5, mistakes: 1 }),
    created_at: "2026-05-15T10:05:00.000Z",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildPriorContext — state.md EE Injections section (P1.5)", () => {
  let flowDir: string;
  const RUN_ID = "run-fixture";

  beforeEach(async () => {
    flowDir = await makeTmpDir();
    vi.mocked(selectEEInjectionsForRun).mockReturnValue([]);
  });

  it("Test 1: section header is 'EE Injections (Layer 3)' when rows present", async () => {
    await seedRun(flowDir, "prior-run", "pdf translator extension");

    vi.mocked(selectEEInjectionsForRun).mockReturnValue([makePilRow(), makeExtractRow()]);

    await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "pdf translator extension v2",
      leaderModelId: "unused",
      llm: makeStubLLM(),
    });

    const stateFile = path.join(flowDir, "runs", RUN_ID, "state.md");
    const state = await fs.readFile(stateFile, "utf8");

    expect(state).toContain("EE Injections (Layer 3)");
  });

  it("Test 2: state.md contains runId in the sqlite audit command", async () => {
    vi.mocked(selectEEInjectionsForRun).mockReturnValue([makePilRow()]);

    await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "some idea",
      leaderModelId: "unused",
      llm: makeStubLLM(),
    });

    const stateFile = path.join(flowDir, "runs", RUN_ID, "state.md");
    const state = await fs.readFile(stateFile, "utf8");

    expect(state).toContain(RUN_ID);
    expect(state).toContain("sqlite3");
    expect(state).toContain("ee_injection");
  });

  it("Test 3: PIL injection count is correct", async () => {
    const pilRows = [makePilRow(), makePilRow({ created_at: "2026-05-15T10:01:00.000Z" })];
    vi.mocked(selectEEInjectionsForRun).mockReturnValue(pilRows);

    await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "some idea",
      leaderModelId: "unused",
      llm: makeStubLLM(),
    });

    const stateFile = path.join(flowDir, "runs", RUN_ID, "state.md");
    const state = await fs.readFile(stateFile, "utf8");

    expect(state).toContain("PIL Layer 3 hits this run:** 2");
  });

  it("Test 4: extract count is correct and includes durationMs from row", async () => {
    vi.mocked(selectEEInjectionsForRun).mockReturnValue([makeExtractRow({ duration_ms: 999 })]);

    await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "some idea",
      leaderModelId: "unused",
      llm: makeStubLLM(),
    });

    const stateFile = path.join(flowDir, "runs", RUN_ID, "state.md");
    const state = await fs.readFile(stateFile, "utf8");

    expect(state).toContain("Extracts this run:** 1");
    expect(state).toContain("durationMs=999");
  });

  it("Test 5 (negative): 0 rows renders the no-injections fallback string", async () => {
    vi.mocked(selectEEInjectionsForRun).mockReturnValue([]);

    await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "some idea",
      leaderModelId: "unused",
      llm: makeStubLLM(),
    });

    const stateFile = path.join(flowDir, "runs", RUN_ID, "state.md");
    const state = await fs.readFile(stateFile, "utf8");

    expect(state).toContain("no EE injections recorded yet");
    expect(state).toContain("PIL Layer 3 fires on the next LLM call");
  });

  it("Test 6: LLM generate is never called (leader synthesis removed in P1.5)", async () => {
    const llm = makeStubLLM();
    vi.mocked(selectEEInjectionsForRun).mockReturnValue([makePilRow()]);

    await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "some idea",
      leaderModelId: "unused",
      llm,
    });

    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("Test 7: digest is always empty string (leader synthesis removed)", async () => {
    vi.mocked(selectEEInjectionsForRun).mockReturnValue([makePilRow(), makeExtractRow()]);

    const result = await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "some idea",
      leaderModelId: "unused",
      llm: makeStubLLM(),
    });

    expect(result.digest).toBe("");
  });

  it("Test 8: prior runs scanned count appears in state.md", async () => {
    // Seed a qualifying prior run so runs.length > 0
    await seedRun(flowDir, "prior-matching", "pdf translator extension");
    vi.mocked(selectEEInjectionsForRun).mockReturnValue([makePilRow()]);

    const result = await buildPriorContext({
      flowDir,
      runId: RUN_ID,
      idea: "pdf translator extension v2",
      leaderModelId: "unused",
      llm: makeStubLLM(),
    });

    expect(result.runs.length).toBe(1);

    const stateFile = path.join(flowDir, "runs", RUN_ID, "state.md");
    const state = await fs.readFile(stateFile, "utf8");
    expect(state).toContain("Prior runs scanned:** 1");
  });
});
