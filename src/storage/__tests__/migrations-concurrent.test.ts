/**
 * Several processes opening the SAME fresh DB at once must all come up on the
 * latest schema — none may replay a migration another already committed.
 *
 * Regression for: tests/integration/headless-exit-code.test.ts spawned three
 * CLIs that share one fresh DB (the inherited MUONROI_CLI_HOME pin); the
 * version was read outside a DEFERRED transaction, two children both saw
 * version 0, and the loser died on "SQLiteError: duplicate column name:
 * pil_active" (v3) with no answer on stdout — 2 of 6 concurrent runs.
 *
 * Real `bun` children (the product runtime, bun:sqlite) because the race is
 * between processes, which an in-process fake cannot interleave.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const MODULE = "migrations-concurrent.test";
const DB_MODULE = resolve("src/storage/db.ts").replace(/\\/g, "/");
const CHILDREN = 6;
const CHILD_TIMEOUT_MS = 60_000;

/** Opens the DB (runs migrations) and prints the resulting user_version. */
const CHILD_SCRIPT = `
const { getDatabase } = await import(${JSON.stringify(DB_MODULE)});
const db = getDatabase();
console.log("VERSION=" + db.pragma("user_version", { simple: true }));
db.close();
`;

type ChildResult = { code: number | null; stdout: string; stderr: string; error?: string };

function openDbInChild(home: string): Promise<ChildResult> {
  return new Promise((res) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("bun", ["-e", CHILD_SCRIPT], {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MUONROI_CLI_HOME: home },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      res({ code: null, stdout, stderr, error: `timeout after ${CHILD_TIMEOUT_MS}ms` });
    }, CHILD_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[${MODULE}] spawning bun failed: ${err.message}`);
      res({ code: null, stdout, stderr, error: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

describe("applyMigrations under concurrent processes", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch (err) {
        console.error(`[${MODULE}] temp dir cleanup failed (${root}): ${(err as Error).message}`);
      }
    }
  });

  it(`${CHILDREN} processes opening one fresh DB all reach the latest version`, async () => {
    const home = mkdtempSync(join(tmpdir(), "muonroi-migrate-race-"));
    roots.push(home);
    const results = await Promise.all(Array.from({ length: CHILDREN }, () => openDbInChild(home)));
    const versions = results.map((r) => r.stdout.match(/VERSION=(\d+)/)?.[1] ?? null);
    for (const [i, r] of results.entries()) {
      expect(r.error ?? null, `child ${i} did not run; stderr:\n${r.stderr}`).toBeNull();
      expect(r.code, `child ${i} exited ${r.code}; stderr:\n${r.stderr}`).toBe(0);
    }
    expect(new Set(versions).size, `versions: ${versions.join(",")}`).toBe(1);
    expect(versions[0]).not.toBeNull();
  }, 120_000);
});
