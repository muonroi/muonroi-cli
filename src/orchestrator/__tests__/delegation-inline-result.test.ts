import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeDelegation,
  DEFAULT_INLINE_RESULT_CHARS,
  DelegationManager,
  INLINE_RESULT_BEGIN,
  INLINE_RESULT_END,
  inlineResultChars,
  pageResultText,
  type StoredDelegation,
  withoutInlineResults,
} from "../delegations.js";

/**
 * Session 4edc02516a92: 88 of 720 orchestrator tool steps were a lone full
 * delegation_read, 69 of them right after a completion notice that carried only
 * a one-line summary. The notice now carries the saved result itself.
 */
describe("completion notice carries the saved result", () => {
  let home: string;
  let cwd: string;
  let dir: string;
  let manager: DelegationManager;

  const writeJob = (id: string, extra: Partial<StoredDelegation> = {}) => {
    const jobPath = path.join(dir, `${id}.json`);
    const record: StoredDelegation = {
      id,
      agent: "general",
      description: "Implement the parser",
      prompt: "Implement the parser",
      cwd,
      model: "fixture",
      sandboxMode: "off",
      maxToolRounds: 2,
      maxTokens: 100,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath: path.join(dir, `${id}.md`),
      parentSessionId: "owner",
      ...extra,
    };
    fs.writeFileSync(jobPath, JSON.stringify(record));
    return jobPath;
  };
  const stored = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as StoredDelegation;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-inline-"));
    cwd = path.join(home, "workspace");
    dir = path.join(home, "delegations", `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    vi.stubEnv("MUONROI_CLI_HOME", home);
    manager = new DelegationManager(
      () => cwd,
      () => "owner",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("inlines a small result whole and marks it delivered, so the ACK works without a read", async () => {
    const jobPath = writeJob("small-worker");
    await completeDelegation(jobPath, "RESULT-SENTINEL: parser.ts:10 implemented; tests 3/3 passed.");
    const delivered: string[] = [];
    const notices = await manager.consumeNotifications((n) => {
      delivered.push(n.message);
    });
    expect(notices).toHaveLength(1);
    const notice = notices[0]!.message;
    expect(notice).toContain("RESULT-SENTINEL: parser.ts:10 implemented");
    expect(notice).toContain("no delegation_read needed");
    expect(notice).not.toContain('delegation_read("small-worker")');
    expect(notice).toContain(INLINE_RESULT_BEGIN);
    expect(notice).toContain("end of result");
    expect(delivered).toEqual([notice]);

    const record = stored(jobPath);
    expect(record.deliveredVersion).toBe(record.resultVersion);
    const ack = await manager.acknowledge("small-worker", record.resultVersion!);
    expect(ack.success).toBe(true);
  });

  it("inlines only the first part of a large result and names the exact next page", async () => {
    vi.stubEnv("MUONROI_DELEGATION_INLINE_RESULT_CHARS", "300");
    const jobPath = writeJob("large-worker");
    const body = `HEAD-${"a".repeat(400)}-TAIL-SENTINEL`;
    await completeDelegation(jobPath, body);
    const [notice] = await manager.consumeNotifications(() => undefined);
    expect(notice!.message).toContain("HEAD-");
    expect(notice!.message).not.toContain("TAIL-SENTINEL");
    expect(notice!.message).toContain('next page: delegation_read({"id":"large-worker","offset":300,"maxChars":300})');

    const saved = fs.readFileSync(stored(jobPath).outputPath, "utf8");
    const rest = await manager.readResult("large-worker", true, { offset: 300, maxChars: 24_000 });
    expect(rest.success).toBe(true);
    expect(rest.output).toContain("TAIL-SENTINEL");
    expect(rest.output).toContain(`[result chars 300-${saved.length} of ${saved.length}; end of result]`);
    // The page is exactly the saved text after the inlined first part.
    const page = rest.output ?? "";
    expect(page.slice(page.indexOf("]\n", page.indexOf("[result chars")) + 2)).toBe(saved.slice(300));
    expect(stored(jobPath).deliveredVersion).toBe(stored(jobPath).resultVersion);
  });

  it("keeps the explicit read for plan-review councils (dossier + read marker) and failed jobs", async () => {
    const reviewPath = writeJob("plan-council", {
      agent: "council",
      kind: "council",
      planReview: {} as StoredDelegation["planReview"],
    });
    await completeDelegation(reviewPath, "Review done.\nPLAN-REVIEW-BODY");
    const [notice] = await manager.consumeNotifications(() => undefined);
    expect(notice!.message).not.toContain("PLAN-REVIEW-BODY");
    expect(notice!.message).toContain('delegation_read("plan-council")');
  });

  it("can be disabled with MUONROI_DELEGATION_INLINE_RESULT_CHARS=0", async () => {
    vi.stubEnv("MUONROI_DELEGATION_INLINE_RESULT_CHARS", "0");
    const jobPath = writeJob("disabled-worker");
    await completeDelegation(jobPath, "Done.\nHIDDEN-BODY");
    const [notice] = await manager.consumeNotifications(() => undefined);
    expect(notice!.message).not.toContain("HIDDEN-BODY");
    expect(notice!.message).toContain('delegation_read("disabled-worker")');
  });

  it("an unpaged delegation_read still returns the whole result (no behavior change)", async () => {
    const jobPath = writeJob("full-worker");
    await completeDelegation(jobPath, "FULL-BODY-1\nFULL-BODY-2");
    const read = await manager.readResult("full-worker");
    expect(read.output).toContain("FULL-BODY-1\nFULL-BODY-2");
    expect(read.output).not.toContain("[result chars");
    expect(stored(jobPath).deliveredVersion).toBe(stored(jobPath).resultVersion);
  });
});

describe("inline result helpers", () => {
  it("inlineResultChars defaults, clamps and disables", () => {
    expect(inlineResultChars({})).toBe(DEFAULT_INLINE_RESULT_CHARS);
    expect(inlineResultChars({ MUONROI_DELEGATION_INLINE_RESULT_CHARS: "0" })).toBe(0);
    expect(inlineResultChars({ MUONROI_DELEGATION_INLINE_RESULT_CHARS: "-5" })).toBe(0);
    expect(inlineResultChars({ MUONROI_DELEGATION_INLINE_RESULT_CHARS: "999999" })).toBe(48_000);
    expect(inlineResultChars({ MUONROI_DELEGATION_INLINE_RESULT_CHARS: "abc" })).toBe(DEFAULT_INLINE_RESULT_CHARS);
  });

  it("pageResultText reports the window and clamps the next-page maxChars to the tool schema", () => {
    expect(pageResultText("j", "abcdef", 2, 2)).toBe(
      '[result chars 2-4 of 6; next page: delegation_read({"id":"j","offset":4,"maxChars":256})]\ncd',
    );
    expect(pageResultText("j", "abcdef", 4)).toBe("[result chars 4-6 of 6; end of result]\nef");
    expect(pageResultText("j", "abc", 99, 10)).toBe("[result chars 3-3 of 3; end of result]\n");
    const big = pageResultText("j", "x".repeat(60_000), 0, 48_000);
    expect(big).toContain('"maxChars":24000');
  });

  it("withoutInlineResults collapses the body but keeps the reference and ACK lines", () => {
    const notice = [
      "Background agent complete: `w`",
      "jobId=w",
      "resultVersion=v1",
      INLINE_RESULT_BEGIN,
      "BODY",
      INLINE_RESULT_END,
      "After processing this result, call delegation_ack with its jobId and resultVersion.",
    ].join("\n");
    const collapsed = withoutInlineResults(notice);
    expect(collapsed).not.toContain("BODY");
    expect(collapsed).toContain("resultVersion=v1");
    expect(collapsed).toContain("delegation_ack");
    expect(collapsed).toContain("[result delivered inline in the completion notice above]");
    expect(withoutInlineResults("no markers")).toBe("no markers");
  });
});
