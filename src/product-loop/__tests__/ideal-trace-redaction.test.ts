/**
 * Durable-sink redaction: the `MUONROI_IDEAL_TRACE` JSONL breadcrumb file.
 *
 * `idealTrace`'s `extra` is an untyped `Record<string, unknown>` and real call
 * sites put a raw caught message in it — `idealTrace("council.postDebate.threw",
 * { err: (err as Error)?.message })` at src/council/index.ts:2837, :2940, :3017 —
 * alongside the post-debate `answer`. The file is written synchronously so the
 * last line survives a kill, which also means it survives long after the run.
 *
 * Credentials are assembled AT RUNTIME so `.husky/pre-commit`'s check-secrets.mjs
 * stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idealTrace, isIdealTraceEnabled } from "../ideal-trace.js";

function fakeProviderKey(): string {
  return ["sk", "proj"].join("-") + "-" + "1d34ltr4c3" + "R".repeat(24);
}

describe("idealTrace — the trace file never persists a credential verbatim", () => {
  let tmpDir: string;
  let traceFile: string;
  const savedFlag = process.env.MUONROI_IDEAL_TRACE;
  /** idealTrace also mirrors each line to stderr; keep it out of the runner output. */
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-idealtrace-redact-"));
    traceFile = path.join(tmpDir, "ideal-trace.jsonl");
    process.env.MUONROI_IDEAL_TRACE = traceFile;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (savedFlag === undefined) delete process.env.MUONROI_IDEAL_TRACE;
    else process.env.MUONROI_IDEAL_TRACE = savedFlag;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      console.error(`[ideal-trace.test] temp dir cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  it("strips a key out of the err field while keeping the marker", () => {
    const key = fakeProviderKey();
    expect(isIdealTraceEnabled()).toBe(true);

    idealTrace("council.postDebate.threw", {
      sessionId: "sess-trace-1",
      err: `401 Unauthorized: invalid api key ${key}`,
    });

    const persisted = fs.readFileSync(traceFile, "utf8");
    expect(persisted).not.toContain(key);

    // The marker IS the diagnostic — the trailing marker names the hang.
    const rec = JSON.parse(persisted.trim()) as { marker: string; sessionId: string; err: string };
    expect(rec.marker).toBe("council.postDebate.threw");
    expect(rec.sessionId).toBe("sess-trace-1");
    expect(rec.err).toContain("401 Unauthorized: invalid api key");
    expect(rec.err).toContain("[REDACTED_API_KEY]");
  });

  it("keeps every appended line valid JSON", () => {
    const key = fakeProviderKey();

    idealTrace("council.persist.before", { sessionId: "s", answer: `use ${key}` });
    idealTrace("council.persist.after", { sessionId: "s", ok: true });

    const lines = fs.readFileSync(traceFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.join("\n")).not.toContain(key);
  });

  it("writes nothing when the flag is unset", () => {
    delete process.env.MUONROI_IDEAL_TRACE;
    expect(isIdealTraceEnabled()).toBe(false);

    idealTrace("council.persist.before", { err: fakeProviderKey() });

    expect(fs.existsSync(traceFile)).toBe(false);
  });
});
