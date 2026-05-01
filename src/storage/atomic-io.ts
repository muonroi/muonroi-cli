import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Atomically write a JSON value to filePath using .tmp + rename pattern.
 * Pitfall 9 mitigation: a Ctrl+C between write and rename leaves no dangling state.
 *
 * Steps: serialize → ensure parent dir → write to filePath + ".tmp" → rename .tmp → filePath.
 * On serialize failure, .tmp is never created. On rename failure, .tmp is cleaned up.
 */
export async function atomicWriteJSON(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (err) {
    throw new Error(`atomicWriteJSON: failed to serialize value for ${filePath}: ${(err as Error).message}`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, serialized, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up the .tmp if rename failed mid-flight
    await fs.unlink(tmpPath).catch(() => {
      /* ignore */
    });
    throw err;
  }
}

/**
 * Atomically write plain text content to filePath using .tmp + rename pattern.
 * Same durability guarantees as atomicWriteJSON but without JSON serialization.
 */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {
      /* ignore */
    });
    throw err;
  }
}

/**
 * Read a JSON file and parse it. Returns null if file is absent (ENOENT).
 * Throws if the file exists but contains invalid JSON.
 */
export async function atomicReadJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
