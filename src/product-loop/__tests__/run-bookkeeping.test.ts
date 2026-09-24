/**
 * Run bookkeeping: `/ideal status` must be able to account for every number it
 * prints, and `/ideal resume` must name the next step it already knows.
 *
 * All three defects covered here were observed live in
 * `D:\sources\CompanyLibs\qa-platform\.muonroi-flow` (read-only evidence):
 *
 *  - `runs/muc126520fb1/manifest.md` is 14 bytes — `## Manifest` and nothing
 *    else. `status` counted it and printed no row for it.
 *  - the project `state.md` `## Active Run` named that same idea-less run.
 *  - `resume muc126520fb1` said "Manifest missing" and nothing about
 *    `muc2joffe506`, the run it had just enumerated and which WAS resumable.
 *
 * The fixtures below reproduce the real byte shapes, not convenient
 * approximations: an ABSENT manifest and a PRESENT-but-header-only one are
 * different failures, and the live case is the second.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";

vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

import { createRun, getActiveRunId, setActiveRunId } from "../../flow/run-manager.js";
import { claimActiveRunSlot, inspectManifest, readManifest, writeManifest } from "../artifact-io.js";
import { runProductLoop } from "../index.js";

beforeAll(async () => {
  await loadCatalog();
});

/** The exact bytes `createRun` used to leave behind — see the header comment. */
const HEADER_ONLY_MANIFEST = "## Manifest\n\n\n";

async function tmpFlowDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ideal-bookkeeping-"));
}

/** A run whose manifest parses: the healthy shape. */
async function seedHealthyRun(flowDir: string, idea: string): Promise<string> {
  const run = await createRun(flowDir);
  await writeManifest(flowDir, run.id, {
    idea,
    doneThreshold: 0.9,
    createdAt: new Date("2026-09-22T02:42:31.667Z"),
  });
  return run.id;
}

/**
 * A run whose manifest does NOT parse, byte-identical to the live zombie:
 * `## Manifest` + a blank line, no `Idea:` / `DoneThreshold:` / `CreatedAt:`.
 */
async function seedHeaderOnlyRun(flowDir: string): Promise<string> {
  const run = await createRun(flowDir);
  const manifestPath = path.join(flowDir, "runs", run.id, "manifest.md");
  await fs.writeFile(manifestPath, HEADER_ONLY_MANIFEST, "utf8");
  // Pin the fixture to the measured reality: 14 bytes, file PRESENT.
  expect((await fs.stat(manifestPath)).size).toBe(14);
  return run.id;
}

function makeOpts(overrides: Record<string, unknown> = {}): any {
  return {
    flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9 },
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    ...overrides,
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ text: string; result: R }> {
  const chunks: string[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { text: chunks.join(""), result: value as R };
    chunks.push(((value as Record<string, unknown>).content as string) ?? "");
  }
}

// ── Defect 1 — the count and the list must agree ───────────────────────────

describe("/ideal status — every counted run is accounted for", () => {
  it("lists the unparseable run WITH a reason, and counts exactly what it printed", async () => {
    const flowDir = await tmpFlowDir();
    const goodId = await seedHealthyRun(flowDir, "port the architecture to a new project");
    const brokenId = await seedHeaderOnlyRun(flowDir);

    const { text } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "status" })));

    // The header count must equal the number of run rows actually printed.
    const header = text.match(/Active runs \((\d+)\):/);
    expect(header).not.toBeNull();
    const rows = text.split("\n").filter((l) => /^ {2}\S/.test(l));
    expect(rows).toHaveLength(Number(header![1]));
    expect(rows).toHaveLength(2);

    // The broken run is LISTED, not silently dropped, and says why.
    const brokenRow = rows.find((l) => l.includes(brokenId));
    expect(brokenRow).toBeDefined();
    expect(brokenRow).toMatch(/unreadable/i);
    expect(brokenRow).toMatch(/Manifest/);

    expect(rows.find((l) => l.includes(goodId))).toContain("port the architecture");
  });

  it("lists a run created but never given an idea, naming that as the reason", async () => {
    const flowDir = await tmpFlowDir();
    const skeleton = await createRun(flowDir); // createRun alone: no Idea yet

    const { text } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "status" })));

    expect(text).toContain("Active runs (1):");
    const row = text.split("\n").find((l) => l.includes(skeleton.id));
    expect(row).toMatch(/never given an idea|no 'Idea:'/i);
  });

  it("flags when the project's Active Run points at a run status cannot use", async () => {
    const flowDir = await tmpFlowDir();
    await seedHealthyRun(flowDir, "the run that actually works");
    const brokenId = await seedHeaderOnlyRun(flowDir);
    await setActiveRunId(flowDir, brokenId);

    const { text } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "status" })));

    expect(text).toMatch(/Active Run/);
    expect(text).toContain(brokenId);
  });

  it("ignores stray files in runs/ so the count means run directories", async () => {
    const flowDir = await tmpFlowDir();
    await seedHealthyRun(flowDir, "only real run");
    await fs.writeFile(path.join(flowDir, "runs", ".DS_Store"), "junk", "utf8");

    const { text } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "status" })));

    expect(text).toContain("Active runs (1):");
    expect(text).not.toContain(".DS_Store");
  });

  // No-regression pin: two healthy runs must render exactly as they do today.
  it("two healthy runs print exactly as before (pinned)", async () => {
    const flowDir = await tmpFlowDir();
    const a = await seedHealthyRun(flowDir, "first idea");
    const b = await seedHealthyRun(flowDir, "second idea");

    const { text } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "status" })));

    expect(text).toBe(
      [
        "Active runs (2):",
        `  ${a}  first idea  sprints=0  aborted=false`,
        `  ${b}  second idea  sprints=0  aborted=false`,
        "",
      ].join("\n"),
    );
    expect(text).not.toMatch(/unreadable/i);
  });
});

// ── Defect 2 — a run with no idea must not hold `## Active Run` ─────────────

describe("createRun / Active Run ordering", () => {
  it("writes the manifest with the directory, recording when it was created", async () => {
    const flowDir = await tmpFlowDir();
    const run = await createRun(flowDir);

    const raw = await fs.readFile(path.join(flowDir, "runs", run.id, "manifest.md"), "utf8");
    // The directory never exists with a manifest that says nothing at all.
    expect(raw).toMatch(/^## Manifest\n\nCreatedAt: \d{4}-\d{2}-\d{2}T/);

    const inspection = await inspectManifest(flowDir, run.id);
    expect(inspection.createdAt).toBeInstanceOf(Date);
    expect(inspection.defect?.code).toBe("no_idea");
    // …and it is still NOT a usable product-run manifest.
    expect(await readManifest(flowDir, run.id)).toBeNull();
  });

  it("readManifest rejects a manifest with fields but no Idea (type says idea: string)", async () => {
    const flowDir = await tmpFlowDir();
    const run = await createRun(flowDir);
    await fs.writeFile(
      path.join(flowDir, "runs", run.id, "manifest.md"),
      "## Manifest\n\nDoneThreshold: 0.9\nCreatedAt: 2026-09-22T02:42:31.667Z\n",
      "utf8",
    );
    expect(await readManifest(flowDir, run.id)).toBeNull();
  });

  it("claimActiveRunSlot takes the slot from an idea-less holder", async () => {
    const flowDir = await tmpFlowDir();
    const zombie = await seedHeaderOnlyRun(flowDir);
    await setActiveRunId(flowDir, zombie);

    const real = await seedHealthyRun(flowDir, "a real run");
    await claimActiveRunSlot(flowDir, real);

    expect(await getActiveRunId(flowDir)).toBe(real);
    // Nothing of the user's is deleted — the zombie directory survives.
    await expect(fs.stat(path.join(flowDir, "runs", zombie))).resolves.toBeDefined();
  });

  it("claimActiveRunSlot never steals the slot from another usable run", async () => {
    const flowDir = await tmpFlowDir();
    const first = await seedHealthyRun(flowDir, "the run in focus");
    await setActiveRunId(flowDir, first);

    const second = await seedHealthyRun(flowDir, "a later run");
    await claimActiveRunSlot(flowDir, second);

    expect(await getActiveRunId(flowDir)).toBe(first);
  });

  it("claims a vacant slot", async () => {
    const flowDir = await tmpFlowDir();
    const run = await seedHealthyRun(flowDir, "sole run");
    await claimActiveRunSlot(flowDir, run);
    expect(await getActiveRunId(flowDir)).toBe(run);
  });
});

// ── Defect 3 — `Manifest missing` must name the next step ───────────────────

describe("/ideal resume — a failure names what the user can do", () => {
  it("names the resumable run when the requested one has no usable manifest", async () => {
    const flowDir = await tmpFlowDir();
    const resumable = await seedHealthyRun(flowDir, "the run that can be resumed");
    const brokenId = await seedHeaderOnlyRun(flowDir);

    const { text, result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId: brokenId })));

    expect(result.success).toBe(false);
    expect(result.reason).toBe("manifest_missing");
    // The reason is stated…
    expect(text).toContain(brokenId);
    expect(text).toMatch(/Manifest/);
    // …and so is the run the command already knew was resumable.
    expect(text).toContain(resumable);
    expect(text).toContain("the run that can be resumed");
  });

  it("says so plainly when nothing else is resumable — never guesses a run", async () => {
    const flowDir = await tmpFlowDir();
    const brokenId = await seedHeaderOnlyRun(flowDir);

    const { text, result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId: brokenId })));

    expect(result.reason).toBe("manifest_missing");
    expect(text).toMatch(/no other run is resumable|No resumable run/i);
    // It must not have picked a run for the user.
    expect(result.runId).toBe(brokenId);
  });

  it("names the resumable runs when the requested run id does not exist", async () => {
    const flowDir = await tmpFlowDir();
    const resumable = await seedHealthyRun(flowDir, "still resumable");

    const { text, result } = await drain(
      runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId: "muc0deadbeef" })),
    );

    expect(result.reason).toBe("not_found");
    expect(text).toContain("muc0deadbeef");
    expect(text).toContain(resumable);
  });

  it("review: does not say 'No runs to review' over run directories it skipped", async () => {
    const flowDir = await tmpFlowDir();
    const brokenId = await seedHeaderOnlyRun(flowDir);

    const { text, result } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "review" })));

    expect(result.reason).toBe("no_runs");
    expect(text).toContain(brokenId);
    expect(text).toMatch(/cannot be read/i);
  });

  it("review: names the real problem instead of 'Run not found' for a run that exists", async () => {
    const flowDir = await tmpFlowDir();
    const brokenId = await seedHeaderOnlyRun(flowDir);

    const { text } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "review", runId: brokenId })));

    expect(text).not.toContain("Run not found");
    expect(text).toContain(brokenId);
    expect(text).toMatch(/Manifest/);
  });

  it("an aborted run is not offered as the alternative", async () => {
    const flowDir = await tmpFlowDir();
    const aborted = await createRun(flowDir);
    await writeManifest(flowDir, aborted.id, {
      idea: "abandoned idea",
      doneThreshold: 0.9,
      createdAt: new Date(),
      aborted: true,
    });
    const brokenId = await seedHeaderOnlyRun(flowDir);

    const { text } = await drain(runProductLoop(makeOpts({ flowDir, subcommand: "resume", runId: brokenId })));

    expect(text).not.toContain(aborted.id);
    expect(text).toMatch(/no other run is resumable|No resumable run/i);
  });
});
