import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSubagentDebug } from "../stream-runner.js";

/**
 * G1 — "Task failed: No output generated" — was named in the code, given the
 * MUONROI_DEBUG_SUBAGENT=1 flag, and never diagnosed. The reason was the sink:
 * the diagnostic wrote to stderr, but under the MCP harness the TUI is a child
 * whose stderr nobody reads (opentui-spawn.ts consumes only the fd3/named-pipe
 * stream), so every line went into a pipe no one drains. Whoever turned the
 * flag on saw nothing.
 *
 * MUONROI_SUBAGENT_DEBUG_LOG gives it a destination that survives, mirroring
 * council/llm.ts's working MUONROI_COUNCIL_DEBUG_LOG.
 */
describe("writeSubagentDebug", () => {
  let logPath: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logPath = join(mkdtempSync(join(tmpdir(), "subagent-dbg-")), "d.log");
    delete process.env.MUONROI_SUBAGENT_DEBUG_LOG;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MUONROI_SUBAGENT_DEBUG_LOG;
  });

  it("writes to the file when MUONROI_SUBAGENT_DEBUG_LOG is set", () => {
    process.env.MUONROI_SUBAGENT_DEBUG_LOG = logPath;

    writeSubagentDebug(true, "catch: name=AI_NoOutputGeneratedError statusCode=400");

    expect(readFileSync(logPath, "utf8")).toBe("[subagent] catch: name=AI_NoOutputGeneratedError statusCode=400\n");
    // Must not double-report to a stderr nobody reads.
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("appends rather than truncating, so a whole run accumulates", () => {
    process.env.MUONROI_SUBAGENT_DEBUG_LOG = logPath;
    writeSubagentDebug(true, "first");
    writeSubagentDebug(true, "second");
    expect(readFileSync(logPath, "utf8")).toBe("[subagent] first\n[subagent] second\n");
  });

  it("falls back to stderr when no path is configured", () => {
    writeSubagentDebug(true, "hello");
    expect(stderrSpy).toHaveBeenCalledWith("[subagent] hello\n");
  });

  it("stays silent when the flag is off — zero cost by default", () => {
    process.env.MUONROI_SUBAGENT_DEBUG_LOG = logPath;
    writeSubagentDebug(false, "nope");
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(() => readFileSync(logPath, "utf8")).toThrow(); // file never created
  });

  it("never throws when the log path is unwritable — diagnostics must not become the failure", () => {
    process.env.MUONROI_SUBAGENT_DEBUG_LOG = join(logPath, "no", "such", "dir", "x.log");
    expect(() => writeSubagentDebug(true, "boom")).not.toThrow();
    // …and it says why, on stderr, rather than dropping the line silently.
    const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written).toContain("debug-log append failed");
    expect(written).toContain("[subagent] boom");
  });
});
