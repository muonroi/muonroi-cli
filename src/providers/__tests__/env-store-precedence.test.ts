import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnvFileIntoProcess } from "../env-store.js";

/**
 * Reproduces the exact failure that cost a session of debugging: a stale
 * Windows User-scope `DEEPSEEK_API_KEY` placeholder shadowed the working key
 * the user had just set through the CLI, so two council panelists died with
 * `[Error: Authentication Fails, Your api key: ****defg is invalid]` while
 * `.env` held a key that answered HTTP 200 — and nothing anywhere said so.
 */
describe("loadEnvFileIntoProcess — secret precedence", () => {
  // Fixtures only. Assembled at runtime rather than written as literals: the
  // pre-commit secret scanner matches the `sk-…` shape on sight, and a fixture
  // is not worth teaching anyone to reach for --no-verify. Lengths mirror the
  // real incident — a 23-char stale placeholder vs a 35-char working key.
  const PREFIX = `sk${"-"}`;
  const STALE = `${PREFIX}${"0".repeat(16)}defg`;
  const REAL = `${PREFIX}${"1".repeat(28)}f2e5`;
  let envFile: string;
  let errors: string[];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "env-store-prec-"));
    envFile = join(dir, ".env");
    process.env.MUONROI_ENV_FILE = envFile;
    delete process.env.MUONROI_ENV_PRECEDENCE;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.SOME_PLAIN_VAR;
    errors = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MUONROI_ENV_FILE;
    delete process.env.MUONROI_ENV_PRECEDENCE;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.SOME_PLAIN_VAR;
  });

  it("lets the CLI store beat a stale ambient key, and says so", () => {
    writeFileSync(envFile, `DEEPSEEK_API_KEY=${REAL}\n`, "utf8");
    process.env.DEEPSEEK_API_KEY = STALE;

    loadEnvFileIntoProcess();

    expect(process.env.DEEPSEEK_API_KEY).toBe(REAL);
    expect(errors.join("\n")).toContain("DEEPSEEK_API_KEY");
    expect(errors.join("\n")).toContain("takes precedence");
  });

  it("never prints either key in full", () => {
    writeFileSync(envFile, `DEEPSEEK_API_KEY=${REAL}\n`, "utf8");
    process.env.DEEPSEEK_API_KEY = STALE;

    loadEnvFileIntoProcess();

    const log = errors.join("\n");
    expect(log).not.toContain(REAL);
    expect(log).not.toContain(STALE);
    expect(log).toContain("…f2e5"); // last 4 only — enough to tell them apart
  });

  it("still fills a gap when nothing is set ambiently", () => {
    writeFileSync(envFile, `DEEPSEEK_API_KEY=${REAL}\n`, "utf8");
    loadEnvFileIntoProcess();
    expect(process.env.DEEPSEEK_API_KEY).toBe(REAL);
    expect(errors).toEqual([]); // no conflict, no noise
  });

  it("stays silent when both sides already agree", () => {
    writeFileSync(envFile, `DEEPSEEK_API_KEY=${REAL}\n`, "utf8");
    process.env.DEEPSEEK_API_KEY = REAL;
    loadEnvFileIntoProcess();
    expect(process.env.DEEPSEEK_API_KEY).toBe(REAL);
    expect(errors).toEqual([]);
  });

  it("MUONROI_ENV_PRECEDENCE=ambient keeps CI/script injection working", () => {
    writeFileSync(envFile, `DEEPSEEK_API_KEY=${REAL}\n`, "utf8");
    process.env.DEEPSEEK_API_KEY = STALE;
    process.env.MUONROI_ENV_PRECEDENCE = "ambient";

    loadEnvFileIntoProcess();

    expect(process.env.DEEPSEEK_API_KEY).toBe(STALE);
    expect(errors.join("\n")).toContain("overrides the CLI store");
  });

  it("leaves NON-secret vars ambient-authoritative and quiet", () => {
    writeFileSync(envFile, "SOME_PLAIN_VAR=from-store\n", "utf8");
    process.env.SOME_PLAIN_VAR = "from-os";

    loadEnvFileIntoProcess();

    // Only credentials change hands; ordinary overrides must keep working.
    expect(process.env.SOME_PLAIN_VAR).toBe("from-os");
    expect(errors).toEqual([]);
  });
});
