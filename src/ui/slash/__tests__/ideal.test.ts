import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("refuses resume without runId", async () => {
    const out = await handleIdealSlash(["resume"], NOOP_CTX);
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
});
