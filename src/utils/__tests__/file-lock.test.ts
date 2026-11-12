import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportCleanupFailure } from "../../__test-stubs__/cleanup";
import { withFileLock } from "../file-lock.js";

describe("withFileLock", () => {
  let tmpFile: string;
  beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `lock-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    tmpFile = path.join(dir, "target.json");
  });

  it("runs the callback and returns its value", async () => {
    const result = await withFileLock(tmpFile, async () => 42);
    expect(result).toBe(42);
  });

  it("removes lockfile after callback completes", async () => {
    await withFileLock(tmpFile, async () => {});
    await expect(fs.stat(`${tmpFile}.lock`)).rejects.toThrow();
  });

  it("removes lockfile even if callback throws", async () => {
    await expect(
      withFileLock(tmpFile, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(`${tmpFile}.lock`)).rejects.toThrow();
  });

  it("serializes concurrent callers on same path", async () => {
    const order: number[] = [];
    const p1 = withFileLock(tmpFile, async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    });
    const p2 = withFileLock(tmpFile, async () => {
      order.push(3);
      order.push(4);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("different paths do NOT block each other", async () => {
    // Prove overlap directly instead of timing it: the first holder does not
    // release until the second holder is INSIDE its own lock. If different
    // paths blocked each other this would deadlock until the retry timeout.
    // (A wall-clock bound of <90ms flaked at exactly 90ms on a loaded machine
    // once acquisition also writes the holder pid.)
    const other = `${tmpFile}.other`;
    let secondEntered!: () => void;
    const secondInside = new Promise<void>((r) => {
      secondEntered = r;
    });
    let overlapped = false;
    await Promise.all([
      withFileLock(tmpFile, async () => {
        await secondInside;
        overlapped = true;
      }),
      withFileLock(other, async () => {
        secondEntered();
      }),
    ]);
    expect(overlapped).toBe(true);
  });

  describe("dead-owner reclaim", () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const c of children.splice(0)) c.kill("SIGKILL");
    });

    /** Spawn a real process; resolves once it is running. */
    async function spawnLive(): Promise<ChildProcess> {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      return child;
    }

    /** A pid that provably belonged to a process which has exited. */
    async function deadPid(): Promise<number> {
      const child = await spawnLive();
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await exited;
      return child.pid as number;
    }

    it("reclaims a lock whose recorded owner process is dead, then runs fn", async () => {
      const pid = await deadPid();
      await fs.writeFile(`${tmpFile}.lock`, String(pid));
      let ran = false;
      await withFileLock(
        tmpFile,
        async () => {
          ran = true;
        },
        { timeoutMs: 500 },
      );
      expect(ran).toBe(true);
      await expect(fs.stat(`${tmpFile}.lock`)).rejects.toThrow();
      const leftovers = (await fs.readdir(path.dirname(tmpFile))).filter((f) => f.includes(".reclaim-"));
      expect(leftovers).toEqual([]);
    });

    it("does NOT break a lock held by a live process", async () => {
      const live = await spawnLive();
      await fs.writeFile(`${tmpFile}.lock`, String(live.pid));
      let ran = false;
      await expect(
        withFileLock(
          tmpFile,
          async () => {
            ran = true;
          },
          { timeoutMs: 200 },
        ),
      ).rejects.toThrow(/timed out waiting for .*\(held by pid \d+/);
      expect(ran).toBe(false);
      expect(await fs.readFile(`${tmpFile}.lock`, "utf8")).toBe(String(live.pid));
    });

    it("does NOT break a lock whose pid is this process (another in-flight holder)", async () => {
      await fs.writeFile(`${tmpFile}.lock`, String(process.pid));
      await expect(withFileLock(tmpFile, async () => {}, { timeoutMs: 150 })).rejects.toThrow(/timed out/);
      expect(await fs.readFile(`${tmpFile}.lock`, "utf8")).toBe(String(process.pid));
    });

    it.each([
      "manual",
      "",
      "0",
      "-5",
      "123abc",
      "99999999999999999999",
    ])("leaves a lock with unparsable content %j untouched and times out", async (content) => {
      await fs.writeFile(`${tmpFile}.lock`, content);
      await expect(withFileLock(tmpFile, async () => {}, { timeoutMs: 150 })).rejects.toThrow(/timed out/);
      expect(await fs.readFile(`${tmpFile}.lock`, "utf8")).toBe(content);
    });

    it("lets exactly one of several concurrent waiters reclaim, all of them run serialized", async () => {
      const pid = await deadPid();
      await fs.writeFile(`${tmpFile}.lock`, String(pid));
      let inside = 0;
      let maxInside = 0;
      let ran = 0;
      await Promise.all(
        Array.from({ length: 5 }, () =>
          withFileLock(
            tmpFile,
            async () => {
              inside += 1;
              maxInside = Math.max(maxInside, inside);
              await new Promise((r) => setTimeout(r, 10));
              inside -= 1;
              ran += 1;
            },
            { timeoutMs: 2000 },
          ),
        ),
      );
      expect(ran).toBe(5);
      expect(maxInside).toBe(1);
    });
  });

  it("respects retry timeout", async () => {
    await fs.writeFile(`${tmpFile}.lock`, "manual");
    let acquired = false;
    // The unlink IS the mechanism under test: if it fails, `withFileLock` never
    // acquires and line 72 reports "expected false to be true" with no cause.
    // Swallowing it silently is exactly what made that failure unreadable.
    const release = setTimeout(
      () =>
        fs
          .unlink(`${tmpFile}.lock`)
          .catch((err) => reportCleanupFailure("file-lock retry-timeout release", `${tmpFile}.lock`, err)),
      50,
    );
    await withFileLock(tmpFile, async () => {
      acquired = true;
    });
    clearTimeout(release);
    expect(acquired).toBe(true);
  });
});
