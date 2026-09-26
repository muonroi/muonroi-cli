/**
 * Gap (c) root cause: `src/hooks/index.ts`'s `executeEventHooks` only ever
 * dispatched PreToolUse/PostToolUse/PostToolUseFailure to the Experience
 * Engine HTTP client — every other event (SessionStart included) fell through
 * to "allow by default" and NEVER ran the user's configured command hook.
 * `command-runner.ts` is the real command executor that was missing.
 *
 * These tests spawn real short-lived processes (no network, no model calls).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStartHookInput } from "../types.js";

describe("hooks/command-runner — runCommandHooksForEvent", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-hooks-cr-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  let runCommandHooksForEvent: typeof import("../command-runner.js").runCommandHooksForEvent;

  function writeUserHooks(hooksConfig: unknown) {
    const dir = path.join(tmpHome, ".muonroi-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "user-settings.json"), JSON.stringify({ hooks: hooksConfig }));
  }

  beforeEach(async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    const mod = await import("../command-runner.js");
    runCommandHooksForEvent = mod.runCommandHooksForEvent;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  const cwd = os.tmpdir();

  it("returns no context when no hook is configured for the event", async () => {
    const input: SessionStartHookInput = { hook_event_name: "SessionStart", source: "startup", cwd };
    const result = await runCommandHooksForEvent("SessionStart", input);
    expect(result.additionalContexts).toEqual([]);
    expect(result.results).toEqual([]);
  });

  it("a plain-text stdout (no JSON contract) becomes additionalContext verbatim", async () => {
    writeUserHooks({ SessionStart: [{ hooks: [{ type: "command", command: "echo hello-from-briefing" }] }] });
    const input: SessionStartHookInput = { hook_event_name: "SessionStart", source: "startup", cwd };
    const result = await runCommandHooksForEvent("SessionStart", input);
    expect(result.additionalContexts).toEqual(["hello-from-briefing"]);
    expect(result.results[0]?.outcome).toBe("success");
  });

  it("a JSON stdout matching HookOutput is parsed and its additionalContext used", async () => {
    const script = 'node -e "console.log(JSON.stringify({additionalContext: \\"from-json\\"}))"';
    writeUserHooks({ SessionStart: [{ hooks: [{ type: "command", command: script }] }] });
    const input: SessionStartHookInput = { hook_event_name: "SessionStart", source: "startup", cwd };
    const result = await runCommandHooksForEvent("SessionStart", input);
    expect(result.additionalContexts).toEqual(["from-json"]);
  });

  it("matches on the SessionStart `source` matcher (resume vs startup)", async () => {
    writeUserHooks({
      SessionStart: [
        { matcher: "resume", hooks: [{ type: "command", command: "echo resumed" }] },
        { matcher: "startup", hooks: [{ type: "command", command: "echo booted" }] },
      ],
    });
    const startupInput: SessionStartHookInput = { hook_event_name: "SessionStart", source: "startup", cwd };
    const resumeInput: SessionStartHookInput = { hook_event_name: "SessionStart", source: "resume", cwd };
    expect((await runCommandHooksForEvent("SessionStart", startupInput, "startup")).additionalContexts).toEqual([
      "booted",
    ]);
    expect((await runCommandHooksForEvent("SessionStart", resumeInput, "resume")).additionalContexts).toEqual([
      "resumed",
    ]);
  });

  it("the hook input JSON (including cwd) is piped to the command's stdin — a hook can self-scope on it", async () => {
    // `cat | sed 's/^/X/'` echoes stdin back to stdout with a prefix that
    // breaks JSON parsing, so the round-tripped payload is treated as plain
    // text and becomes additionalContext verbatim — proving a hook script CAN
    // read the piped JSON (e.g. to decide whether to act at all for this cwd).
    writeUserHooks({ SessionStart: [{ hooks: [{ type: "command", command: "cat | sed 's/^/X/'" }] }] });
    const input: SessionStartHookInput = { hook_event_name: "SessionStart", source: "startup", cwd, session_id: "s1" };
    const result = await runCommandHooksForEvent("SessionStart", input);
    expect(result.additionalContexts[0]).toContain(`"cwd":"${cwd}"`);
  });

  it("a non-zero exit yields no additionalContext but still records the result", async () => {
    writeUserHooks({ SessionStart: [{ hooks: [{ type: "command", command: "exit 1" }] }] });
    const input: SessionStartHookInput = { hook_event_name: "SessionStart", source: "startup", cwd };
    const result = await runCommandHooksForEvent("SessionStart", input);
    expect(result.additionalContexts).toEqual([]);
    expect(result.results[0]?.outcome).toBe("non_blocking_error");
    expect(result.results[0]?.exitCode).toBe(1);
  });

  it("a slow hook is killed at its configured timeout and contributes no context", async () => {
    writeUserHooks({
      SessionStart: [{ hooks: [{ type: "command", command: "sleep 5 && echo too-late", timeout: 200 }] }],
    });
    const input: SessionStartHookInput = { hook_event_name: "SessionStart", source: "startup", cwd };
    const result = await runCommandHooksForEvent("SessionStart", input);
    expect(result.additionalContexts).toEqual([]);
    expect(result.results[0]?.outcome).toBe("non_blocking_error");
  }, 10_000);
});
