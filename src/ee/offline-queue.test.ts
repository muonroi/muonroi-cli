/**
 * Unit + integration tests for offline-queue module.
 *
 * Tests cover all 10 behaviors:
 *  1. enqueue() creates queue directory lazily
 *  2. enqueue() writes correct JSON content
 *  3. enqueue() enforces 100-entry cap by deleting oldest
 *  4. getQueueDir() returns correct path
 *  5. drainQueue() replays entries in FIFO order
 *  6. drainQueue() stops on failure, leaves remaining entries
 *  7. drainQueue() handles non-existent queue directory
 *  8. drainQueue() discards corrupt JSON files
 *  9. Filename format matches /^\d+-[a-z0-9]{4}\.json$/
 * 10. drainQueue() is fire-and-forget (returns void)
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStubEEServer } from "../__test-stubs__/ee-server.js";
import {
  drainQueue,
  drainQueueAsync,
  enqueue,
  getQueueDir,
} from "./offline-queue.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  // Create isolated temp directory for each test
  const base = path.join(os.tmpdir(), "queue-test-");
  // Use a unique timestamp+random suffix
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  tmpDir = base + suffix;
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: get the ee-offline-queue dir inside tmpDir.
 */
function queueDir(): string {
  return getQueueDir(tmpDir);
}

/**
 * Helper: write N pre-populated queue files with sequential timestamps.
 */
async function populateQueue(count: number, startTs = 1000): Promise<string[]> {
  const dir = queueDir();
  await mkdir(dir, { recursive: true });
  const filenames: string[] = [];
  for (let i = 0; i < count; i++) {
    const ts = startTs + i;
    const filename = `${ts}-test.json`;
    const entry = {
      endpoint: "/api/feedback",
      body: { i },
      enqueuedAt: ts,
    };
    await writeFile(path.join(dir, filename), JSON.stringify(entry), "utf8");
    filenames.push(filename);
  }
  return filenames;
}

// ─── Test 1: enqueue() creates queue directory lazily ─────────────────────────

describe("enqueue()", () => {
  it("creates the queue directory lazily on first call", async () => {
    // Queue dir should NOT exist before enqueue
    const dir = queueDir();
    const files = await readdir(dir).catch(() => null);
    expect(files).toBeNull(); // dir does not exist yet

    // Call enqueue — should create dir
    await enqueue(
      { endpoint: "/api/feedback", body: { test: 1 }, enqueuedAt: 1000 },
      tmpDir,
    );

    // Dir should now exist
    const filesAfter = await readdir(dir);
    expect(Array.isArray(filesAfter)).toBe(true);
  });

  // ─── Test 9: Filename format ───────────────────────────────────────────────

  it("creates exactly 1 file with correct filename pattern after one enqueue", async () => {
    await enqueue(
      { endpoint: "/api/feedback", body: { test: 1 }, enqueuedAt: 1000 },
      tmpDir,
    );

    const files = await readdir(queueDir());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-[a-z0-9]{4}\.json$/);
  });

  // ─── Test 2: enqueue() writes correct JSON content ────────────────────────

  it("writes correct JSON content matching the input entry", async () => {
    const entry = {
      endpoint: "/api/feedback",
      body: { test: 1 },
      enqueuedAt: 1000,
    };
    await enqueue(entry, tmpDir);

    const dir = queueDir();
    const files = await readdir(dir);
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(dir, files[0]), "utf8"),
    );
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual(entry);
  });

  // ─── Test 3: enqueue() enforces 100-entry cap ─────────────────────────────

  it("enforces 100-entry cap: deletes oldest when queue is at capacity", async () => {
    // Pre-populate with exactly 100 files
    const existing = await populateQueue(100, 1000);
    const oldestFile = existing[0]; // timestamp 1000-test.json

    // Enqueue one more entry
    await enqueue(
      {
        endpoint: "/api/feedback",
        body: { new: true },
        enqueuedAt: 99999,
      },
      tmpDir,
    );

    const files = await readdir(queueDir());

    // Should still have exactly 100 files
    expect(files).toHaveLength(100);

    // Oldest file should be gone
    expect(files).not.toContain(oldestFile);

    // New file should exist (it has a fresh timestamp prefix via makeFilename())
    const newFiles = files.filter((f) => !existing.includes(f));
    expect(newFiles).toHaveLength(1);
  });
});

// ─── Test 4: getQueueDir() returns correct path ───────────────────────────────

describe("getQueueDir()", () => {
  it("returns path under os.homedir() when no override given", () => {
    const result = getQueueDir();
    expect(result).toBe(
      path.join(os.homedir(), ".muonroi-cli", "ee-offline-queue"),
    );
  });

  it("returns path under homeOverride when provided", () => {
    const result = getQueueDir("/tmp/test");
    expect(result).toBe(
      path.join("/tmp/test", ".muonroi-cli", "ee-offline-queue"),
    );
  });
});

// ─── Test 5: drainQueue() replays entries in FIFO order ───────────────────────

describe("drainQueueAsync()", () => {
  it("replays entries in FIFO order and deletes them after success", async () => {
    // Pre-populate 3 entries with distinct timestamps
    await populateQueue(3, 1000);

    const stub = await startStubEEServer({ feedback: () => {} });

    try {
      await drainQueueAsync(
        fetch,
        { "Content-Type": "application/json" },
        `http://127.0.0.1:${stub.port}`,
        tmpDir,
      );

      // 3 requests received in order
      expect(stub.calls.feedback).toHaveLength(3);
      expect(stub.calls.feedback[0].enqueuedAt ?? stub.calls.feedback[0].i).toBeDefined();

      // FIFO: first enqueued (ts=1000) should come first
      const receivedEnqueuedAts = stub.calls.feedback.map((b: any) => b.enqueuedAt ?? b.i);
      expect(receivedEnqueuedAts[0]).toBeLessThan(receivedEnqueuedAts[1]);
      expect(receivedEnqueuedAts[1]).toBeLessThan(receivedEnqueuedAts[2]);

      // All files deleted after successful replay
      const remainingFiles = await readdir(queueDir()).catch(() => []);
      expect(remainingFiles).toHaveLength(0);
    } finally {
      await stub.stop();
    }
  });

  // ─── Test 6: drainQueue() stops on failure, leaves remaining ──────────────

  it("stops on 2nd entry failure and leaves 2nd + 3rd entries on disk", async () => {
    await populateQueue(3, 1000);

    let callCount = 0;
    const stub = await startStubEEServer({
      feedback: () => {
        callCount++;
      },
    });

    // Override the server to return 500 on 2nd call
    // We'll track calls and use a custom stub that serves 500 on 2nd request
    await stub.stop();

    // Build a minimal stub that returns 500 on 2nd POST to /api/feedback
    const { createServer } = await import("node:http");
    let reqCount = 0;
    const customServer = createServer((req, res) => {
      if (req.url === "/api/feedback" && req.method === "POST") {
        reqCount++;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          if (reqCount === 2) {
            res.writeHead(500);
            res.end("error");
          } else {
            res.writeHead(200);
            res.end("ok");
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) =>
      customServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = customServer.address();
    const port =
      typeof addr === "object" && addr ? (addr as { port: number }).port : 0;

    try {
      await drainQueueAsync(
        fetch,
        { "Content-Type": "application/json" },
        `http://127.0.0.1:${port}`,
        tmpDir,
      );

      // 1st success, 2nd failure → should have made 2 requests total
      expect(reqCount).toBe(2);

      // 2nd and 3rd files remain on disk (1st was deleted on success)
      const remainingFiles = await readdir(queueDir());
      expect(remainingFiles).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    }
  });

  // ─── Test 7: drainQueue() handles non-existent queue directory ────────────

  it("returns cleanly when queue directory does not exist", async () => {
    // No queue dir created — just call drainQueueAsync with a fresh tmpDir
    await expect(
      drainQueueAsync(
        fetch,
        { "Content-Type": "application/json" },
        "http://127.0.0.1:9999",
        tmpDir,
      ),
    ).resolves.toBeUndefined();
  });

  // ─── Test 8: drainQueue() discards corrupt JSON files ─────────────────────

  it("discards corrupt JSON files and replays valid entries after them", async () => {
    const dir = queueDir();
    await mkdir(dir, { recursive: true });

    // Write corrupt file first (older timestamp)
    const corruptFile = "1000-bad1.json";
    await writeFile(path.join(dir, corruptFile), "NOT VALID JSON {{{{", "utf8");

    // Write valid entry after (newer timestamp)
    const validEntry = {
      endpoint: "/api/feedback",
      body: { valid: true },
      enqueuedAt: 2000,
    };
    await writeFile(
      path.join(dir, "2000-good.json"),
      JSON.stringify(validEntry),
      "utf8",
    );

    const stub = await startStubEEServer({ feedback: () => {} });

    try {
      await drainQueueAsync(
        fetch,
        { "Content-Type": "application/json" },
        `http://127.0.0.1:${stub.port}`,
        tmpDir,
      );

      // Corrupt file should be deleted
      const remaining = await readdir(dir);
      expect(remaining).not.toContain(corruptFile);

      // Valid entry should have been replayed
      expect(stub.calls.feedback).toHaveLength(1);
      expect(stub.calls.feedback[0]).toEqual(validEntry.body);

      // Valid file should be deleted after replay
      expect(remaining).toHaveLength(0);
    } finally {
      await stub.stop();
    }
  });
});

// ─── Test 10: drainQueue() is fire-and-forget ─────────────────────────────────

describe("drainQueue() fire-and-forget wrapper", () => {
  it("returns void (undefined), not a Promise", () => {
    // Call drainQueue (the fire-and-forget wrapper) — should return undefined immediately
    const result = drainQueue(
      fetch,
      { "Content-Type": "application/json" },
      "http://127.0.0.1:9999",
      tmpDir,
    );

    // drainQueue() must return void (undefined), not a Promise
    expect(result).toBeUndefined();
  });
});
