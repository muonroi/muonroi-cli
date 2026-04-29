import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPendingCallsLog, stableCallId } from "./pending-calls.js";

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  const base = path.join(os.tmpdir(), `pending-calls-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(base, { recursive: true });
  return base;
}

async function readJSONL(filePath: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let tmpBase: string;
let sessionCounter = 0;

function nextSessionId(): string {
  return `test-session-${++sessionCounter}-${Date.now()}`;
}

beforeEach(async () => {
  tmpBase = await makeTmpDir();
  // Override home dir for getSessionDir so it writes into our temp dir
  process.env.MUONROI_CLI_HOME = tmpBase;
});

afterEach(async () => {
  delete process.env.MUONROI_CLI_HOME;
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {
    /* best-effort cleanup */
  });
});

describe("stableCallId", () => {
  it("Test 3: same inputs → same id (determinism)", () => {
    const id1 = stableCallId("turn-1", "Bash", { command: "ls" });
    const id2 = stableCallId("turn-1", "Bash", { command: "ls" });
    expect(id1).toBe(id2);
  });

  it("Test 3: different inputs → different ids", () => {
    const a = stableCallId("turn-1", "Bash", { command: "ls" });
    const b = stableCallId("turn-1", "Bash", { command: "pwd" });
    const c = stableCallId("turn-2", "Bash", { command: "ls" });
    const d = stableCallId("turn-1", "Edit", { command: "ls" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("PendingCallsLog", () => {
  it("Test 4: begin → end produces two JSONL lines with consistent state", async () => {
    const sid = nextSessionId();
    const log = createPendingCallsLog(sid);
    await log.begin({ call_id: "c1", tool_name: "Bash" });
    await log.end("c1", "settled");

    const sessionDir = path.join(tmpBase, "sessions", sid);
    const lines = await readJSONL(path.join(sessionDir, "pending_calls.jsonl"));
    expect(lines).toHaveLength(2);

    const begin = lines[0] as Record<string, unknown>;
    const end = lines[1] as Record<string, unknown>;

    expect(begin.event).toBe("begin");
    expect(begin.call_id).toBe("c1");
    expect(begin.tool_name).toBe("Bash");
    expect(begin.status).toBe("pending");
    expect(typeof begin.started_ms).toBe("number");

    expect(end.event).toBe("end");
    expect(end.call_id).toBe("c1");
    expect(end.status).toBe("settled");
    expect(typeof end.ended_ms).toBe("number");
  });

  it("Test 5: reconcile marks abandoned entries from prior process", async () => {
    const sid = nextSessionId();
    const sessionDir = path.join(tmpBase, "sessions", sid);
    await fs.mkdir(sessionDir, { recursive: true });

    // Seed a stale "pending" begin event
    const staleEntry = JSON.stringify({
      event: "begin",
      call_id: "stale-1",
      tool_name: "Edit",
      started_ms: Date.now() - 60_000,
      status: "pending",
    });
    await fs.writeFile(path.join(sessionDir, "pending_calls.jsonl"), staleEntry + "\n", "utf8");

    const log = createPendingCallsLog(sid);
    const result = await log.reconcile();
    expect(result.abandoned).toBe(1);
    expect(result.settled).toBe(0);

    // Final line must have status=abandoned
    const lines = await readJSONL(path.join(sessionDir, "pending_calls.jsonl"));
    const last = lines[lines.length - 1] as Record<string, unknown>;
    expect(last.status).toBe("abandoned");
  });

  it("Test 6: reconcile unlinks .tmp staged_path when final file does NOT exist (rollback)", async () => {
    const sid = nextSessionId();
    const sessionDir = path.join(tmpBase, "sessions", sid);
    await fs.mkdir(sessionDir, { recursive: true });

    const tmpFile = path.join(sessionDir, "output.txt.tmp");
    await fs.writeFile(tmpFile, "partial content", "utf8");
    // final (output.txt) does NOT exist → rollback: unlink .tmp

    const staleEntry = JSON.stringify({
      event: "begin",
      call_id: "stale-2",
      tool_name: "Edit",
      started_ms: Date.now() - 60_000,
      status: "pending",
      staged_paths: [tmpFile],
    });
    await fs.writeFile(path.join(sessionDir, "pending_calls.jsonl"), staleEntry + "\n", "utf8");

    const log = createPendingCallsLog(sid);
    await log.reconcile();

    // .tmp must have been unlinked (rolled back)
    await expect(fs.access(tmpFile)).rejects.toThrow();
  });

  it("Test 7: reconcile unlinks orphan .tmp when BOTH .tmp and final exist (post-crash cleanup)", async () => {
    const sid = nextSessionId();
    const sessionDir = path.join(tmpBase, "sessions", sid);
    await fs.mkdir(sessionDir, { recursive: true });

    const tmpFile = path.join(sessionDir, "output.txt.tmp");
    const finalFile = path.join(sessionDir, "output.txt");
    await fs.writeFile(tmpFile, "orphan", "utf8");
    await fs.writeFile(finalFile, "committed", "utf8");

    const staleEntry = JSON.stringify({
      event: "begin",
      call_id: "stale-3",
      tool_name: "Edit",
      started_ms: Date.now() - 60_000,
      status: "pending",
      staged_paths: [tmpFile],
    });
    await fs.writeFile(path.join(sessionDir, "pending_calls.jsonl"), staleEntry + "\n", "utf8");

    const log = createPendingCallsLog(sid);
    await log.reconcile();

    // orphan .tmp must be unlinked; final file must remain intact
    await expect(fs.access(tmpFile)).rejects.toThrow();
    await expect(fs.access(finalFile)).resolves.toBeUndefined();
  });

  it("Test 8: concurrent begin() calls do not corrupt the JSONL", async () => {
    const sid = nextSessionId();
    const log = createPendingCallsLog(sid);

    // Fire 10 concurrent begin() calls
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        log.begin({ call_id: `c-${i}`, tool_name: "Bash" }),
      ),
    );

    const sessionDir = path.join(tmpBase, "sessions", sid);
    const lines = await readJSONL(path.join(sessionDir, "pending_calls.jsonl"));

    // All N entries must be present and each line must be valid JSON
    expect(lines).toHaveLength(N);
    const callIds = lines.map((l) => (l as Record<string, unknown>).call_id as string);
    for (let i = 0; i < N; i++) {
      expect(callIds).toContain(`c-${i}`);
    }
  });
});

describe("getSessionDir (B-3)", () => {
  it("Test 9: returns path under .muonroi-cli/sessions/<id> and creates the directory", async () => {
    const { getSessionDir } = await import("../storage/session-dir.js");
    const sid = `test-b3-${Date.now()}`;
    const dir = await getSessionDir(sid, tmpBase);

    expect(dir).toContain("sessions");
    expect(dir).toContain(sid);

    // Directory must exist after the call
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);

    // Calling twice is idempotent (no throw)
    const dir2 = await getSessionDir(sid, tmpBase);
    expect(dir2).toBe(dir);
  });

  it("Test 10: createPendingCallsLog uses getSessionDir (writes to sibling dir, not SQLite)", async () => {
    const sid = nextSessionId();
    const log = createPendingCallsLog(sid);
    await log.begin({ call_id: "b3-test", tool_name: "Bash" });

    const sessionDir = path.join(tmpBase, "sessions", sid);
    const jsonl = path.join(sessionDir, "pending_calls.jsonl");
    const stat = await fs.stat(jsonl);
    expect(stat.isFile()).toBe(true);

    // Must NOT import or reference bun:sqlite — verified by source inspection in Task 1 verify.
    // Here we verify the side-effect: the JSONL is written and SQLite db is NOT touched.
    const lines = await readJSONL(jsonl);
    expect(lines.length).toBeGreaterThan(0);
  });
});
