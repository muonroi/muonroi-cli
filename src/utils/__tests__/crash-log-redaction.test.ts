/**
 * Durable-sink redaction: `~/.muonroi-cli/crash.log`.
 *
 * `appendCrashLog` is fed a raw `err.stack || err.message` from the process-level
 * `uncaughtException` / `unhandledRejection` handlers (src/index.ts). A provider
 * auth failure is exactly the error class that reaches an uncaught handler, and
 * its message can embed the header or key it was rejected for — the same shape
 * that previously leaked verbatim once `serializeError` started reporting real
 * messages.
 *
 * This sink also bypasses `redactor.installGlobalPatches()`: it writes with
 * `fs.appendFileSync`, never through `console.*`.
 *
 * HOME is redirected to a temp dir — the user's real `~/.muonroi-cli` is never
 * touched. Credentials are assembled AT RUNTIME so check-secrets.mjs stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCrashLog } from "../crash-log.js";

function fakeProviderKey(): string {
  return ["sk", "proj"].join("-") + "-" + "cr4shl0g" + "Z".repeat(26);
}

describe("appendCrashLog — crash.log never persists a credential verbatim", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-crashlog-redact-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[crash-log.test] temp dir cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  function readCrashLog(): string {
    const p = path.join(os.homedir(), ".muonroi-cli", "crash.log");
    // Guard the redirect itself: if homedir() did not follow the env override we
    // would be asserting against the USER's real crash.log.
    expect(p.startsWith(tmpDir)).toBe(true);
    return fs.readFileSync(p, "utf8");
  }

  it("strips a key out of an UNCAUGHT stack while keeping the frames", () => {
    const key = fakeProviderKey();
    const err = new Error(`401 Unauthorized: invalid api key ${key}`);
    err.stack = `${err.message}\n    at streamText (src/providers/openai-compatible.ts:60:24)\n    at processMessage (src/orchestrator/message-processor.ts:977:11)`;

    appendCrashLog("UNCAUGHT", err.stack);

    const persisted = readCrashLog();
    expect(persisted).not.toContain(key);
    expect(persisted).toContain("[REDACTED_API_KEY]");
    // The whole point of crash.log is the cause + the frames.
    expect(persisted).toContain("401 Unauthorized: invalid api key");
    expect(persisted).toContain("src/providers/openai-compatible.ts:60:24");
    expect(persisted).toContain("src/orchestrator/message-processor.ts:977:11");
    expect(persisted).toContain("UNCAUGHT");
  });

  it("strips an Authorization header out of a REJECTION message", () => {
    const bearer = "b" + "earertoken" + "9".repeat(24);

    appendCrashLog("REJECTION", `fetch failed for POST /v1/chat/completions (Authorization: Bearer ${bearer})`);

    const persisted = readCrashLog();
    expect(persisted).not.toContain(bearer);
    expect(persisted).toContain("REJECTION");
    expect(persisted).toContain("fetch failed for POST /v1/chat/completions");
  });

  it("appends rather than truncating, so earlier crash records survive", () => {
    appendCrashLog("FREEZE_DIAG", "event loop blocked 304500ms");
    appendCrashLog("SIGNAL_REGISTER", "cannot listen for SIGBREAK");

    const persisted = readCrashLog();
    expect(persisted).toContain("event loop blocked 304500ms");
    expect(persisted).toContain("cannot listen for SIGBREAK");
  });
});
