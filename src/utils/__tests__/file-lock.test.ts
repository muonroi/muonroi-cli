import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
    const other = `${tmpFile}.other`;
    const start = Date.now();
    await Promise.all([
      withFileLock(tmpFile, async () => {
        await new Promise((r) => setTimeout(r, 50));
      }),
      withFileLock(other, async () => {
        await new Promise((r) => setTimeout(r, 50));
      }),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(90);
  });

  it("respects retry timeout", async () => {
    await fs.writeFile(`${tmpFile}.lock`, "manual");
    let acquired = false;
    const release = setTimeout(() => fs.unlink(`${tmpFile}.lock`).catch(() => {}), 50);
    await withFileLock(tmpFile, async () => {
      acquired = true;
    });
    clearTimeout(release);
    expect(acquired).toBe(true);
  });
});
