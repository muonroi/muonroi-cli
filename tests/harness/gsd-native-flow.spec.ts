import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planningArtifact } from "../../src/gsd/paths.js";
import { type HarnessContext, spawnHarness } from "./helpers.js";

/**
 * GSD native bootstrap E2E — verifies the turn-sync path in
 * message-processor actually creates the `.planning/` workspace in a
 * greenfield cwd when MUONROI_GSD_NATIVE=1.
 *
 * The full plan→review→execute→verify→ship TOOL lifecycle is covered by
 * unit tests (src/gsd/__tests__/plan-council.test.ts etc.) which invoke the
 * dynamicTool execute functions directly. Driving those tool calls through
 * the agent loop here is blocked by the mock-llm layer yielding text-only
 * (no tool-call emission) — that's a mock-infra concern, not a regression.
 *
 * What this spec adds over gsd-native.spec.ts (smoke): it dispatches a real
 * non-chitchat prompt and asserts the workspace artifacts land on disk.
 */
describe("gsd-native greenfield bootstrap", () => {
  let ctx: HarnessContext;
  let greenfield: string;

  beforeAll(async () => {
    greenfield = mkdtempSync(join(tmpdir(), "gsd-flow-"));
    ctx = await spawnHarness({
      cwd: greenfield,
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
      env: {
        MUONROI_GSD_NATIVE: "1",
        MUONROI_TEST_NO_KEYCHAIN: "1",
      },
      idleTimeoutMs: 30_000,
    });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 60_000);

  afterAll(() => {
    ctx?.cleanup();
    // Best-effort: on Windows the spawned child + gsd-tools subprocesses can
    // briefly hold the temp cwd (EBUSY) — same guard helpers.ts uses for
    // tempHome. The OS reclaims the temp dir later; failure here is not a
    // regression of the behavior under test.
    if (greenfield) {
      try {
        rmSync(greenfield, { recursive: true, force: true });
      } catch {
        /* best-effort — EBUSY on Windows when child handles linger */
      }
    }
  });

  it("bootstraps .planning/STATE.md + config.json on first non-chitchat turn", async () => {
    // A non-chitchat prompt that won't be gated out by PIL — the turn-sync
    // hook (message-processor.ts) calls ensureHost + syncWorkflowContext,
    // which must create the workspace even before any gsd_* tool is called.
    ctx.driver.type("build a small counter app in src/");
    ctx.driver.press("Enter");

    // Wait for the turn to settle (mock-llm returns fast).
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });

    // Path is resolved via planningArtifact, not hardcoded ".planning/": the
    // GSD state tree cut over to the folded `.muonroi-flow/planning/` location
    // for fresh projects (src/gsd/paths.ts planningRoot). Using the helper keeps
    // this spec tracking the canonical location instead of the legacy split dir.
    const statePath = planningArtifact(greenfield, "STATE.md");
    const configPath = planningArtifact(greenfield, "config.json");
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);

    // STATE.md must carry the muonroi task-level extension fields.
    const state = readFileSync(statePath, "utf8");
    expect(state).toContain("Phase");
    expect(state).toContain("Depth");
    expect(state).toContain("Workflow Kind");

    // config.json must be valid JSON (created by gsd-tools config-ensure-section
    // and/or config-bridge — both are acceptable bootstrap sources). The
    // gsd-tools path owns the schema when it runs first; config-bridge only
    // writes when the file is absent.
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toBeTypeOf("object");
    expect(Object.keys(config).length).toBeGreaterThan(0);
  }, 60_000);

  it("second turn does not corrupt STATE.md (read path is stable)", async () => {
    const statePath = planningArtifact(greenfield, "STATE.md");
    const before = readFileSync(statePath, "utf8");

    ctx.driver.type("what does the counter do?");
    ctx.driver.press("Enter");
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });

    // STATE.md may be re-written by turn-sync (depth refresh) but must remain
    // valid markdown with the extension table intact — no truncation/corruption.
    const after = readFileSync(statePath, "utf8");
    expect(after).toContain("Phase");
    expect(after).toContain("Depth");
    expect(after.length).toBeGreaterThan(50);
    // Phase field should still be a known value (turn-sync must not blank it).
    expect(/\|\s*Phase\s*\|\s*\S+/.test(after)).toBe(true);
    // Smoke: the prompt itself didn't leak into STATE.
    expect(after).not.toContain("what does the counter do");
    void before;
  }, 60_000);
});
