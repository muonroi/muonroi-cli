/**
 * Wiring test: `executeEventHooks("SessionStart", …)` must actually dispatch
 * to the real command executor (command-runner.ts). Before gap (c)'s fix,
 * SessionStart fell through this function's default branch ("all other
 * events: allow by default") and never ran a configured command hook at all
 * — see command-runner.test.ts's header comment for the full root cause.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStartHookInput } from "../types.js";

describe("hooks/index — executeEventHooks(SessionStart) wiring", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-hooks-idx-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  let executeEventHooks: typeof import("../index.js").executeEventHooks;

  beforeEach(async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    fs.mkdirSync(path.join(tmpHome, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".muonroi-cli", "user-settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo session-briefing-output" }] }] },
      }),
    );
    vi.resetModules();
    const mod = await import("../index.js");
    executeEventHooks = mod.executeEventHooks;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  it("runs the configured SessionStart command hook and returns its output as additionalContexts", async () => {
    const input: SessionStartHookInput = {
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: os.tmpdir(),
    };
    const result = await executeEventHooks(input, os.tmpdir());
    expect(result.additionalContexts).toEqual(["session-briefing-output"]);
    expect(result.blocked).toBe(false);
  });

  it("never throws and returns empty when nothing is configured", async () => {
    fs.writeFileSync(path.join(tmpHome, ".muonroi-cli", "user-settings.json"), JSON.stringify({}));
    const input: SessionStartHookInput = { hook_event_name: "SessionStart", source: "resume", cwd: os.tmpdir() };
    const result = await executeEventHooks(input, os.tmpdir());
    expect(result.additionalContexts).toEqual([]);
  });
});
