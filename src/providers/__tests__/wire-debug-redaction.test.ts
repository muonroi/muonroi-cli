/**
 * Durable-sink redaction: `~/.muonroi-cli/llm-wire.log` (or
 * `$MUONROI_DEBUG_LLM_WIRE_PATH`).
 *
 * `wireDebug.logError` persists `err.message`, `err.url` and the first 4000 chars
 * of the provider's raw `responseBody` verbatim. An auth rejection is exactly the
 * error this flag gets enabled for: several OpenAI-compatible gateways echo the
 * submitted key back in the 401 body, and a Gemini-style URL carries the key as a
 * query parameter.
 *
 * `ENABLED` and `LOG_FILE` are module-level consts read at import time, so the env
 * is set BEFORE a dynamic import and the module registry is reset per test.
 *
 * Credentials are assembled AT RUNTIME so check-secrets.mjs stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function fakeProviderKey(): string {
  return ["sk", "proj"].join("-") + "-" + "w1red3bug" + "Q".repeat(26);
}

async function loadWireDebug(logFile: string) {
  process.env.MUONROI_DEBUG_LLM_WIRE = "1";
  process.env.MUONROI_DEBUG_LLM_WIRE_PATH = logFile;
  vi.resetModules();
  return (await import("../wire-debug.js")).wireDebug;
}

describe("wireDebug — llm-wire.log never persists a credential verbatim", () => {
  let tmpDir: string;
  let logFile: string;
  const savedEnabled = process.env.MUONROI_DEBUG_LLM_WIRE;
  const savedPath = process.env.MUONROI_DEBUG_LLM_WIRE_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-wiredebug-redact-"));
    logFile = path.join(tmpDir, "llm-wire.log");
  });

  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.MUONROI_DEBUG_LLM_WIRE;
    else process.env.MUONROI_DEBUG_LLM_WIRE = savedEnabled;
    if (savedPath === undefined) delete process.env.MUONROI_DEBUG_LLM_WIRE_PATH;
    else process.env.MUONROI_DEBUG_LLM_WIRE_PATH = savedPath;
    vi.resetModules();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      console.error(`[wire-debug.test] temp dir cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  it("strips the key from a 401 responseBody that echoes it back", async () => {
    const key = fakeProviderKey();
    const wireDebug = await loadWireDebug(logFile);

    const err = Object.assign(new Error(`Unauthorized: invalid api key ${key}`), {
      statusCode: 401,
      url: "https://api.deepseek.com/v1/chat/completions",
      responseBody: JSON.stringify({ error: { message: `Incorrect API key provided: ${key}`, code: 401 } }),
    });
    wireDebug.logError("deepseek", err);

    const persisted = fs.readFileSync(logFile, "utf8");

    expect(persisted).not.toContain(key);
    expect(persisted).toContain("[REDACTED_API_KEY]");
    // Everything this flag exists to capture must survive.
    const rec = JSON.parse(persisted.trim()) as {
      label: string;
      data: { providerId: string; statusCode: number; url: string; message: string; responseBody: string };
    };
    expect(rec.label).toBe("error");
    expect(rec.data.providerId).toBe("deepseek");
    expect(rec.data.statusCode).toBe(401);
    expect(rec.data.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(rec.data.message).toContain("Unauthorized: invalid api key");
    expect(rec.data.responseBody).toContain("Incorrect API key provided");
  });

  it("strips a key carried as a URL query parameter", async () => {
    const gkey = "AIzaSy" + "n0tAreal" + "G".repeat(30);
    const wireDebug = await loadWireDebug(logFile);

    wireDebug.logError(
      "google",
      Object.assign(new Error("400 Bad Request"), {
        url: `https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent?key=${gkey}`,
        statusCode: 400,
      }),
    );

    const persisted = fs.readFileSync(logFile, "utf8");
    expect(persisted).not.toContain(gkey);
    expect(persisted).toContain("generativelanguage.googleapis.com");
    expect(persisted).toContain("400 Bad Request");
  });

  it("keeps every line valid JSON after redaction", async () => {
    const key = fakeProviderKey();
    const wireDebug = await loadWireDebug(logFile);

    wireDebug.logError("deepseek", Object.assign(new Error(`rejected ${key}`), { statusCode: 401 }));
    wireDebug.logChunk("deepseek", "text-delta", { textChars: 12 });

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    // A value class that swallowed a closing quote would make this throw — the
    // failure mode that turns a redaction into a corrupt evidence file.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(fs.readFileSync(logFile, "utf8")).not.toContain(key);
  });

  it("writes nothing at all when the flag is off", async () => {
    delete process.env.MUONROI_DEBUG_LLM_WIRE;
    process.env.MUONROI_DEBUG_LLM_WIRE_PATH = logFile;
    vi.resetModules();
    const { wireDebug } = await import("../wire-debug.js");

    wireDebug.logError("deepseek", new Error(`rejected ${fakeProviderKey()}`));

    expect(fs.existsSync(logFile)).toBe(false);
  });
});
