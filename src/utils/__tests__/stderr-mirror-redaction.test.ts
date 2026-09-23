/**
 * Durable-sink redaction: `~/.muonroi-cli/tui-stderr.log`.
 *
 * This mirror is ON BY DEFAULT and tees every `process.stderr.write` to a 1 MB
 * file. `redactor.installGlobalPatches()` (src/index.ts) scrubs `console.*`, but
 * this tee sits BELOW that patch on `process.stderr.write` itself — anything
 * reaching stderr without going through console was landing in the file
 * unfiltered.
 *
 * The test drives the REAL patched `process.stderr.write` and reads the bytes
 * back off disk. It also pins the module's core safety property: the terminal
 * still receives the original, unredacted chunk.
 *
 * Credentials are assembled AT RUNTIME so `.husky/pre-commit`'s check-secrets.mjs
 * stays meaningful.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetStderrMirrorForTests,
  installStderrMirror,
  isStderrMirrorInstalled,
  restoreStderrMirror,
  stderrMirrorPath,
} from "../stderr-mirror.js";

function fakeProviderKey(): string {
  return ["sk", "proj"].join("-") + "-" + "n0treal" + "K".repeat(26);
}

describe("stderr-mirror — durable copy is redacted, terminal copy is not", () => {
  let tmpDir: string;
  let logFile: string;
  let originalEnvFile: string | undefined;
  /** What the real `process.stderr.write` received, captured beneath the tee. */
  let terminalBytes: string[];
  let realWrite: typeof process.stderr.write;

  beforeEach(() => {
    __resetStderrMirrorForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-stderr-mirror-redact-"));
    logFile = path.join(tmpDir, "tui-stderr.log");
    originalEnvFile = process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
    process.env.MUONROI_TUI_STDERR_MIRROR_FILE = logFile;

    // Swap in a capture sink FIRST, so installStderrMirror() wraps this one and
    // we can prove the pass-through chunk is untouched without spamming the
    // test runner's own stderr.
    terminalBytes = [];
    realWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    // biome-ignore lint/suspicious/noExplicitAny: matching Writable.write's overloads
    (process.stderr as any).write = (chunk: any): boolean => {
      terminalBytes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    };
  });

  afterEach(() => {
    restoreStderrMirror();
    // biome-ignore lint/suspicious/noExplicitAny: restoring the captured original
    (process.stderr as any).write = realWrite;
    __resetStderrMirrorForTests();
    if (originalEnvFile === undefined) delete process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
    else process.env.MUONROI_TUI_STDERR_MIRROR_FILE = originalEnvFile;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[stderr-mirror.test] temp dir cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  it("strips a provider key from the persisted mirror while keeping the diagnostic", () => {
    const key = fakeProviderKey();
    expect(stderrMirrorPath()).toBe(logFile);

    installStderrMirror();
    expect(isStderrMirrorInstalled()).toBe(true);

    // A direct process.stderr.write — the exact path that bypasses the
    // console.* redactor patch.
    process.stderr.write(`[visible-retry] provider rejected key ${key} — retrying once\n`);
    restoreStderrMirror();

    const persisted = fs.readFileSync(logFile, "utf8");

    expect(persisted).not.toContain(key);
    expect(persisted).toContain("[REDACTED_API_KEY]");
    // Redaction that destroys the surrounding context is also a failure.
    expect(persisted).toContain("[visible-retry] provider rejected key");
    expect(persisted).toContain("retrying once");
  });

  it("redacts a bare JWT and an x-api-key header out of the persisted mirror", () => {
    const jwt = ["eyJ", "hbGciOiJIUzI1NiJ9"].join("") + ".eyJzdWIiOiJtdW9ucm9pIn0.c2lnLWJ5dGVzLWhlcmU";
    const opaque = "op" + "aque" + "0".repeat(26);

    installStderrMirror();
    process.stderr.write(`oauth refresh failed (${jwt}); fallback used x-api-key: ${opaque}\n`);
    restoreStderrMirror();

    const persisted = fs.readFileSync(logFile, "utf8");

    expect(persisted).not.toContain(jwt);
    expect(persisted).not.toContain(opaque);
    expect(persisted).toContain("[REDACTED_JWT]");
    expect(persisted).toContain("oauth refresh failed");
    expect(persisted).toContain("fallback used");
  });

  it("forwards the ORIGINAL bytes to the terminal — the mirror must not alter output", () => {
    const key = fakeProviderKey();
    const line = `provider rejected key ${key}\n`;

    installStderrMirror();
    process.stderr.write(line);
    restoreStderrMirror();

    // The whole module rests on the terminal seeing byte-identical output; a
    // redaction applied to the pass-through would corrupt OpenTUI's framebuffer
    // accounting and silently change what the user sees.
    expect(terminalBytes.join("")).toBe(line);
    expect(fs.readFileSync(logFile, "utf8")).not.toContain(key);
  });
});
