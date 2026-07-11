import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMilestone, createPhase } from "../../../flow/hierarchy.js";
import { setActiveRunId } from "../../../flow/run-manager.js";
import { getIdealHelpText, handleIdealSlash, parseIdealArgs } from "../ideal.js";

const NOOP_CTX: any = {
  cwd: "/tmp",
  tenantId: "t",
  defaultProvider: "anthropic",
  defaultModel: "claude",
};

describe("/ideal slash parser", () => {
  const originalDev = process.env.MUONROI_DEV;
  beforeEach(() => {
    delete process.env.MUONROI_DEV;
  });
  afterEach(() => {
    if (originalDev === undefined) delete process.env.MUONROI_DEV;
    else process.env.MUONROI_DEV = originalDev;
  });

  it("/ideal with no args returns help", () => {
    const r = parseIdealArgs([]);
    expect(r.subcommand).toBe("help");
  });

  it('/ideal "build a CLI for X" -> start with idea set', () => {
    const r = parseIdealArgs(["build a CLI for X"]);
    expect(r.subcommand).toBe("start");
    expect(r.idea).toBe("build a CLI for X");
    expect(r.flags.maxCost).toBe(50);
    expect(r.flags.maxSprints).toBe(8);
    expect(r.flags.doneThreshold).toBe(0.9);
  });

  it("/ideal status -> subcommand=status, no runId", () => {
    const r = parseIdealArgs(["status"]);
    expect(r.subcommand).toBe("status");
    expect(r.runId).toBeUndefined();
  });

  it("/ideal resume abc123 -> subcommand=resume, runId=abc123", () => {
    const r = parseIdealArgs(["resume", "abc123"]);
    expect(r.subcommand).toBe("resume");
    expect(r.runId).toBe("abc123");
  });

  it("/ideal --max-cost 999 idea -> flags.maxCost=999", () => {
    const r = parseIdealArgs(["--max-cost", "999", "todo", "app"]);
    expect(r.subcommand).toBe("start");
    expect(r.flags.maxCost).toBe(999);
    expect(r.idea).toBe("todo app");
  });

  it("/ideal --max-cost 9999 idea -> falls back to help with range error", () => {
    const r = parseIdealArgs(["--max-cost", "9999", "idea"]);
    expect(r.subcommand).toBe("help");
    expect(r.warnings.some((w) => /max-cost|1, 1000|range/i.test(w))).toBe(true);
  });

  it("--done-threshold below 0.7 is clamped with a warning", () => {
    const r = parseIdealArgs(["--done-threshold", "0.5", "idea"]);
    expect(r.flags.doneThreshold).toBe(0.7);
    expect(r.warnings.some((w) => w.includes("clamped"))).toBe(true);
  });

  it("--done-threshold above 1.0 is clamped with a warning", () => {
    const r = parseIdealArgs(["--done-threshold", "1.2", "idea"]);
    expect(r.flags.doneThreshold).toBe(1.0);
    expect(r.warnings.some((w) => w.includes("clamped"))).toBe(true);
  });

  it("MUONROI_DEV=1 enables noCustomerDebate; disabled otherwise", () => {
    expect(parseIdealArgs(["idea"]).flags.noCustomerDebate).toBeUndefined();
    process.env.MUONROI_DEV = "1";
    expect(parseIdealArgs(["idea"]).flags.noCustomerDebate).toBe(true);
  });

  it("--no-customer-debate is NOT a registered flag (does NOT appear in --help)", () => {
    expect(getIdealHelpText().includes("--no-customer-debate")).toBe(false);
    expect(getIdealHelpText().includes("customer-debate")).toBe(false);
  });

  it("--force-council sets forceCouncil=true", () => {
    const r = parseIdealArgs(["--force-council", "build a counter"]);
    expect(r.subcommand).toBe("start");
    expect(r.flags.forceCouncil).toBe(true);
  });

  it("without --force-council, forceCouncil is undefined", () => {
    const r = parseIdealArgs(["build a counter"]);
    expect(r.subcommand).toBe("start");
    expect(r.flags.forceCouncil).toBeUndefined();
  });

  it("--force-council appears in --help text", () => {
    expect(getIdealHelpText().includes("--force-council")).toBe(true);
  });
});

describe("/ideal slash handler dispatch", () => {
  it("returns __PRODUCT_LOOP__ sentinel for start", async () => {
    const out = await handleIdealSlash(["build a markdown todo CLI"], NOOP_CTX);
    expect(out).toContain("__PRODUCT_LOOP__");
    const json = out.split("__PRODUCT_LOOP__\n")[1]!;
    const payload = JSON.parse(json);
    expect(payload.subcommand).toBe("start");
    expect(payload.idea).toBe("build a markdown todo CLI");
  });

  it("returns __PRODUCT_LOOP__ sentinel for status (no runId)", async () => {
    const out = await handleIdealSlash(["status"], NOOP_CTX);
    expect(out).toContain("__PRODUCT_LOOP__");
    const payload = JSON.parse(out.split("__PRODUCT_LOOP__\n")[1]!);
    expect(payload.subcommand).toBe("status");
    expect(payload.runId).toBeUndefined();
  });

  it("allows resume without runId (auto-detects newest incomplete run — B)", async () => {
    const out = await handleIdealSlash(["resume"], NOOP_CTX);
    expect(out).toContain("__PRODUCT_LOOP__");
    const payload = JSON.parse(out.split("__PRODUCT_LOOP__\n")[1]!);
    expect(payload.subcommand).toBe("resume");
    expect(payload.runId).toBeUndefined();
  });

  it("allows abort without runId (auto-detects newest incomplete run — A/B)", async () => {
    const out = await handleIdealSlash(["abort"], NOOP_CTX);
    expect(out).toContain("__PRODUCT_LOOP__");
    const payload = JSON.parse(out.split("__PRODUCT_LOOP__\n")[1]!);
    expect(payload.subcommand).toBe("abort");
    expect(payload.runId).toBeUndefined();
  });

  it("allows review without runId (defaults to newest run)", async () => {
    const out = await handleIdealSlash(["review"], NOOP_CTX);
    expect(out).toContain("__PRODUCT_LOOP__");
    const payload = JSON.parse(out.split("__PRODUCT_LOOP__\n")[1]!);
    expect(payload.subcommand).toBe("review");
    expect(payload.runId).toBeUndefined();
  });

  it("passes an explicit runId to review", async () => {
    const out = await handleIdealSlash(["review", "abc123"], NOOP_CTX);
    expect(out).toContain("__PRODUCT_LOOP__");
    const payload = JSON.parse(out.split("__PRODUCT_LOOP__\n")[1]!);
    expect(payload.subcommand).toBe("review");
    expect(payload.runId).toBe("abc123");
  });

  it("still refuses ship without runId", async () => {
    const out = await handleIdealSlash(["ship"], NOOP_CTX);
    expect(out.toLowerCase()).toContain("requires a runid");
  });

  it("returns help text for empty args", async () => {
    const out = await handleIdealSlash([], NOOP_CTX);
    expect(out).toContain("/ideal — Product Ideal Loop");
    expect(out).toContain("--max-cost");
  });

  it("propagates clamp warnings into the response", async () => {
    const out = await handleIdealSlash(["--done-threshold", "0.5", "idea"], NOOP_CTX);
    expect(out).toContain("clamped");
    expect(out).toContain("__PRODUCT_LOOP__");
  });

  describe("milestones / phases (read-only index views)", () => {
    let cwd: string;
    const NOW = "2026-07-11T00:00:00.000Z";

    beforeEach(async () => {
      cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ideal-hier-"));
    });
    afterEach(async () => {
      await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("milestones: empty-state message when none exist", async () => {
      const out = await handleIdealSlash(["milestones"], { ...NOOP_CTX, cwd });
      expect(out).toContain("No milestones yet");
    });

    it("milestones: lists milestones + phases + active marker", async () => {
      const flowDir = path.join(cwd, ".muonroi-flow");
      const m = await createMilestone(flowDir, { title: "Todo App", goal: "ship it" }, NOW);
      await createPhase(flowDir, m.id, { title: "MVP", runId: "run-xyz" }, NOW);
      // F8 — the active marker derives from the active run, not a stored pointer.
      await setActiveRunId(flowDir, "run-xyz");
      const out = await handleIdealSlash(["milestones"], { ...NOOP_CTX, cwd });
      expect(out).toContain("m01-todo-app: Todo App");
      expect(out).toContain("← active");
      expect(out).toContain("p01-mvp: MVP");
      expect(out).toContain("run-xyz");
    });

    it("phases: falls back to active milestone (derived from active run) when no id given", async () => {
      const flowDir = path.join(cwd, ".muonroi-flow");
      const m = await createMilestone(flowDir, { title: "App" }, NOW);
      await createPhase(flowDir, m.id, { title: "Scope", runId: "run-scope" }, NOW);
      await setActiveRunId(flowDir, "run-scope");
      const out = await handleIdealSlash(["phases"], { ...NOOP_CTX, cwd });
      expect(out).toContain("Phases of m01-app");
      expect(out).toContain("p01-scope: Scope");
    });

    it("phases: message when no active milestone and no id", async () => {
      const out = await handleIdealSlash(["phases"], { ...NOOP_CTX, cwd });
      expect(out).toContain("No active milestone");
    });

    it("phases: accepts an explicit milestone id", async () => {
      const flowDir = path.join(cwd, ".muonroi-flow");
      const m = await createMilestone(flowDir, { title: "Explicit" }, NOW);
      await createPhase(flowDir, m.id, { title: "One" }, NOW);
      const out = await handleIdealSlash(["phases", m.id], { ...NOOP_CTX, cwd });
      expect(out).toContain("Phases of m01-explicit");
      expect(out).toContain("p01-one: One");
    });

    it("does not emit the __PRODUCT_LOOP__ sentinel for index views", async () => {
      const out = await handleIdealSlash(["milestones"], { ...NOOP_CTX, cwd });
      expect(out).not.toContain("__PRODUCT_LOOP__");
    });
  });

  // Mode C — explicit flag wiring (see .planning/MAINTAIN-MODE.md)
  describe("Mode C flags", () => {
    it("--maintain sets flags.mode=maintain", () => {
      const r = parseIdealArgs(["--maintain", "fix login bug"]);
      expect(r.subcommand).toBe("start");
      expect(r.flags.mode).toBe("maintain");
      expect(r.flags.ghPr).toBeUndefined();
    });

    it("--new sets flags.mode=new", () => {
      const r = parseIdealArgs(["--new", "scaffold microservice"]);
      expect(r.subcommand).toBe("start");
      expect(r.flags.mode).toBe("new");
    });

    it("--maintain + --gh-pr sets both flags", () => {
      const r = parseIdealArgs(["--maintain", "--gh-pr", "fix bug"]);
      expect(r.flags.mode).toBe("maintain");
      expect(r.flags.ghPr).toBe(true);
    });

    it("--gh-pr without --maintain emits warning + drops ghPr semantics", () => {
      const r = parseIdealArgs(["--gh-pr", "build dashboard"]);
      expect(r.flags.mode).toBeUndefined();
      expect(r.flags.ghPr).toBe(true); // parsed, but warning surfaced
      expect(r.warnings.join(" ")).toMatch(/--gh-pr.*Mode C only/);
    });

    it("--maintain + --new are mutually exclusive — maintain wins with a warning", () => {
      const r = parseIdealArgs(["--maintain", "--new", "anything"]);
      expect(r.flags.mode).toBe("maintain");
      expect(r.warnings.join(" ")).toMatch(/--maintain and --new are mutually exclusive/);
    });

    it("no Mode C flags = mode undefined (auto-detect path)", () => {
      const r = parseIdealArgs(["build app"]);
      expect(r.flags.mode).toBeUndefined();
      expect(r.flags.ghPr).toBeUndefined();
    });

    it("help text mentions --maintain / --new / --gh-pr", () => {
      const text = getIdealHelpText();
      expect(text).toContain("--maintain");
      expect(text).toContain("--new");
      expect(text).toContain("--gh-pr");
    });
  });
});
