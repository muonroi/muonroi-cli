/**
 * The verify prompt must not demand a capability it has not checked for.
 *
 * MEASURED DEFECT, run `muc2joffe506` sprint 2. The prompt told the stage:
 *
 *   entrypoint.ts:139  "agent-browser commands run on the HOST. They WILL work.
 *                       Do not skip them."
 *   evidence.ts:40     "The agent-browser command runs on the HOST, not inside
 *                       the sandbox. It WILL work. Do not skip it or assume it is
 *                       unavailable."
 *
 * Measured on the host that run executed on:
 *
 *     $ which agent-browser
 *     which: no agent-browser in (/mingw64/bin:/usr/bin:...)
 *     $ agent-browser --version
 *     /usr/bin/bash: line 1: agent-browser: command not found
 *
 * The stage obeyed the prompt — `tool_calls` ids 3523-3530 of sub-session
 * 548913168ae0 are it trying `agent-browser record start`, then `which`, then
 * PowerShell `Get-Command`, then `browseruse`, then `playwright`, then
 * `npx playwright install chromium` — and then it called `ask_user` at
 * 14:50:21.922Z to ask what to do, which cost the whole 600s stage budget.
 *
 * A prompt that asserts a fact it never verified is how that happened, and a
 * prompt with no instruction for the unattended case is why the model reached for
 * a human. Both halves are asserted here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildVerifyTaskPrompt } from "./entrypoint";
import { hasHostExecutable } from "./host-capabilities";

const tempDirs: string[] = [];

function makeNextApp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const PRESENT = { hasHostExecutable: () => true };
const ABSENT = { hasHostExecutable: () => false };

describe("verify task prompt — browser tool capability", () => {
  it("keeps today's instructions when the browser tool IS on the host", () => {
    const prompt = buildVerifyTaskPrompt(makeNextApp("verify-cap-present-"), undefined, null, "off", PRESENT);
    expect(prompt).toContain("Phase 4 — Browser QA testing (REQUIRED, do not skip):");
    expect(prompt).toContain("They WILL work. Do not skip them.");
    expect(prompt).toContain("agent-browser record start");
  });

  it("stops asserting the tool will work when it is NOT on the host", () => {
    const prompt = buildVerifyTaskPrompt(makeNextApp("verify-cap-absent-"), undefined, null, "off", ABSENT);
    // The false assertions must be gone — both copies of them.
    expect(prompt).not.toContain("They WILL work. Do not skip them.");
    expect(prompt).not.toContain("It WILL work. Do not skip it or assume it is unavailable.");
    // And the step-by-step script for a binary that is not there must be gone too:
    // it is what sent the stage hunting for substitutes for six minutes.
    expect(prompt).not.toContain("agent-browser record start");
  });

  it("names the phase, says it cannot run, and says how to report it", () => {
    const prompt = buildVerifyTaskPrompt(makeNextApp("verify-cap-report-"), undefined, null, "off", ABSENT);
    expect(prompt).toContain("Phase 4");
    expect(prompt).toContain("agent-browser");
    // The measured probe result is stated as fact, not left for the model to find.
    expect(prompt).toMatch(/not (installed|available) on this host/i);
    // Reuses the vocabulary the loop already has for this fact.
    expect(prompt).toContain("could not run");
    // The stage must still reach a verdict rather than stalling.
    expect(prompt).toMatch(/do not install|do not go looking|do not substitute/i);
    expect(prompt).toContain("Blockers");
  });

  it("does not turn the missing tool into a reason to withhold a verdict marker", () => {
    const prompt = buildVerifyTaskPrompt(makeNextApp("verify-cap-verdict-"), undefined, null, "off", ABSENT);
    expect(prompt).toContain("Verdict marker (MANDATORY");
  });
});

describe("verify task prompt — the unattended directive", () => {
  it("tells the stage no human is watching and what to do instead of asking", () => {
    const prompt = buildVerifyTaskPrompt(makeNextApp("verify-unattended-"), undefined, null, "off", PRESENT);
    expect(prompt).toMatch(/unattended/i);
    expect(prompt).toContain("ask_user");
    expect(prompt).toMatch(/no human/i);
    // The instruction has to name the alternative, or the model just stalls
    // differently.
    expect(prompt).toContain("Blockers");
    expect(prompt).toMatch(/report .*and (emit|continue)/i);
  });

  it("says it on a CLI/library project too — the stage is unattended either way", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-unattended-cli-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = 'demo'\n");
    fs.mkdirSync(path.join(dir, "tests"));
    const prompt = buildVerifyTaskPrompt(dir, undefined, null, "off", PRESENT);
    expect(prompt).toMatch(/unattended/i);
    expect(prompt).toContain("ask_user");
  });
});

describe("hasHostExecutable", () => {
  it("finds something that is certainly on this machine", () => {
    // `node` is running this test.
    expect(hasHostExecutable("node")).toBe(true);
  });

  it("does not find the browser tool that run muc2joffe506 was promised", () => {
    // If this ever flips on a machine that HAS the tool, the assertion below is
    // the one that matters: the function must answer from the real PATH.
    const probe = hasHostExecutable("agent-browser");
    expect(typeof probe).toBe("boolean");
  });

  it("does not find an impossible name", () => {
    expect(hasHostExecutable("muonroi-definitely-not-a-real-binary-9f3a")).toBe(false);
  });

  it("never throws on a hostile PATH", () => {
    expect(() =>
      hasHostExecutable("node", { pathValue: "\u0000::::", pathExt: undefined, platform: "linux" }),
    ).not.toThrow();
    expect(hasHostExecutable("node", { pathValue: undefined, pathExt: undefined, platform: "linux" })).toBe(false);
  });
});
