import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "../types/index.js";
import {
  appendCheapModelPlaybook,
  CHEAP_MODEL_PLAYBOOK,
  cheapModelShellLine,
  injectCheapModelPlaybook,
  injectCheapModelShellDirective,
  shouldInjectCheapModelPlaybook,
} from "./cheap-model-playbook.js";

const baseInfo = {
  id: "x",
  name: "x",
  description: "",
  provider: "x",
  contextWindow: 100_000,
} as const;

function info(tier: ModelInfo["tier"]): ModelInfo {
  return { ...baseInfo, tier } as unknown as ModelInfo;
}

describe("shouldInjectCheapModelPlaybook", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK;
    delete process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK;
    else process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = savedEnv;
  });

  it("fires on fast tier", () => {
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(true);
  });

  it("does NOT fire on balanced tier", () => {
    expect(shouldInjectCheapModelPlaybook(info("balanced"))).toBe(false);
  });

  it("does NOT fire on premium tier", () => {
    expect(shouldInjectCheapModelPlaybook(info("premium"))).toBe(false);
  });

  it("does NOT fire when modelInfo is undefined", () => {
    expect(shouldInjectCheapModelPlaybook(undefined)).toBe(false);
  });

  it("does NOT fire when tier is absent on ModelInfo", () => {
    const noTier = { ...baseInfo } as unknown as ModelInfo;
    expect(shouldInjectCheapModelPlaybook(noTier)).toBe(false);
  });

  it("env override disables for fast tier", () => {
    process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = "1";
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(false);
  });

  it("env override with non-'1' value does not disable", () => {
    process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = "0";
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(true);
    process.env.MUONROI_DISABLE_CHEAP_MODEL_PLAYBOOK = "true";
    expect(shouldInjectCheapModelPlaybook(info("fast"))).toBe(true);
  });
});

describe("injectCheapModelPlaybook", () => {
  it("PREPENDS the playbook so it lands at the front of attention", () => {
    const out = injectCheapModelPlaybook("You are an agent.");
    expect(out).toBe(`${CHEAP_MODEL_PLAYBOOK}You are an agent.`);
    // Primacy property — system prompt now opens with the CRITICAL marker.
    expect(out.startsWith("[CRITICAL TOOL-USE RULES")).toBe(true);
  });

  it("is idempotent — passing already-prefixed prompt returns it unchanged", () => {
    const once = injectCheapModelPlaybook("Sys.");
    const twice = injectCheapModelPlaybook(once);
    expect(twice).toBe(once);
  });

  it("playbook content mentions the four key tool steering rules", () => {
    expect(CHEAP_MODEL_PLAYBOOK).toContain("bash_output_get");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/task\(agent="explore"\)/);
    expect(CHEAP_MODEL_PLAYBOOK).toContain("grep");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/ERROR/);
  });

  it("rule 1 wording now applies to every bash call (not just retries)", () => {
    // Live forensics showed cheap models rationalized that the first call
    // isn't a re-run, so the "NEVER re-run" wording let them skip the rule.
    // The new wording explicitly says EVERY bash call.
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/EVERY bash call/i);
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/do NOT pipe.*tail/i);
  });

  it("steers fix QUALITY: root-cause over masking (rule 5) and read real failure logs (rule 6)", () => {
    // Grounded in a live observation (gpt-5.4-mini self-fixing a failing CI
    // workflow): the cheap model masked the failure with `continue-on-error:
    // true` instead of guarding the missing-secret root cause, and never read
    // the actual run log. These two rules steer fast-tier models away from
    // symptom-masking and toward evidence-first root-cause fixes.
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/root cause/i);
    expect(CHEAP_MODEL_PLAYBOOK).toContain("continue-on-error");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/CONDITIONAL|skip when absent/i);
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/failure (log|output)|run log/i);
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/before .*hypothesi/i);
  });

  it("playbook stays short (under 1800 chars) to preserve attention budget", () => {
    // Bumped 1500 → 1600 (rules 5/6 fix-quality) → 1800 (rule 1 file-viewing
    // clause, A1: kills the observed read_file+sed double-read). Still a tight
    // prelude; primacy placement matters more than absolute length.
    expect(CHEAP_MODEL_PLAYBOOK.length).toBeLessThan(1800);
  });

  it("deprecated appendCheapModelPlaybook alias still works (now actually prepends)", () => {
    const out = appendCheapModelPlaybook("Sys.");
    expect(out).toBe(`${CHEAP_MODEL_PLAYBOOK}Sys.`);
  });

  it("steers file-VIEWING to read_file, not a redundant bash sed/cat (A1 anti-redundancy)", () => {
    // Live observation (workbook run 3308b3d02e11): gpt-5.4-mini read the same
    // lines TWICE — once via read_file(60-95), once via `sed -n '60,95p'`. The
    // ENVIRONMENT block legitimises sed as "POSIX-OK" while the playbook only
    // forbade PIPING output. The missing rule: viewing a file is read_file's
    // job; bash_output_get is for COMMAND output, not files.
    expect(CHEAP_MODEL_PLAYBOOK).toContain("read_file");
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/never[\s`]*sed|do NOT[\s`]*sed/i);
    expect(CHEAP_MODEL_PLAYBOOK).toMatch(/COMMAND output/i);
  });
});

describe("cheapModelShellLine (A2 — front-loaded env/shell directive)", () => {
  it("POSIX bash: demands POSIX commands, forbids PowerShell/cmd, names the OS", () => {
    const line = cheapModelShellLine("bash", "win32");
    expect(line).toMatch(/POSIX/);
    expect(line).toMatch(/Windows/);
    expect(line).toMatch(/NEVER|do not|don't/i);
    expect(line).toMatch(/PowerShell|cmd/);
    // single line — front-loaded primacy, token-frugal
    expect(line).not.toContain("\n");
  });

  it("WSL is treated as POSIX too", () => {
    expect(cheapModelShellLine("wsl", "win32")).toMatch(/POSIX/);
  });

  it("PowerShell: demands cmdlets, forbids POSIX grep/sed/awk", () => {
    const line = cheapModelShellLine("powershell", "win32");
    expect(line).toMatch(/PowerShell|cmdlet/i);
    expect(line).toMatch(/Select-String|Get-ChildItem/);
    expect(line).toMatch(/NEVER|do not|don't/i);
    expect(line).toMatch(/grep|sed|awk|POSIX/);
  });

  it("cmd.exe: demands cmd syntax, forbids POSIX and PowerShell", () => {
    const line = cheapModelShellLine("cmd", "win32");
    expect(line).toMatch(/cmd/i);
    expect(line).toMatch(/dir|type|copy/);
    expect(line).toMatch(/NEVER|do not|don't/i);
  });

  it("maps platform to a human OS name", () => {
    expect(cheapModelShellLine("bash", "linux")).toMatch(/Linux/);
    expect(cheapModelShellLine("bash", "darwin")).toMatch(/macOS/);
  });

  it("auto/unknown kind stays conservative — does not assert a syntax it cannot confirm", () => {
    const line = cheapModelShellLine("auto", "win32");
    // Must NOT claim a definite POSIX/PowerShell/cmd syntax when undetermined.
    expect(line).toMatch(/confirm|ENVIRONMENT/i);
  });
});

describe("injectCheapModelShellDirective (A2 wiring)", () => {
  it("prepends the shell line at the very front, ahead of the playbook", () => {
    const line = cheapModelShellLine("powershell", "win32");
    const sys = injectCheapModelShellDirective("Body.", line);
    expect(sys.startsWith(line)).toBe(true);
    expect(sys).toContain("Body.");
  });

  it("is idempotent — re-injecting the same directive does not double-stack", () => {
    const line = cheapModelShellLine("bash", "linux");
    const once = injectCheapModelShellDirective("Body.", line);
    const twice = injectCheapModelShellDirective(once, line);
    expect(twice).toBe(once);
  });
});
