import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";

const MAX_MEMORY_BYTES = 2048;

/**
 * Returns the absolute path to a role's memory file.
 */
export function roleMemoryPath(flowDir: string, runId: string, slot: string): string {
  return path.join(flowDir, "runs", runId, "memory", `${slot}.md`);
}

/**
 * Read the full memory for a role slot. Returns "" if missing.
 */
export async function readRoleMemory(flowDir: string, runId: string, slot: string): Promise<string> {
  const filePath = roleMemoryPath(flowDir, runId, slot);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Append a sprint block to a role's memory with a 2KB hard cap.
 * Truncates oldest blocks first when exceeding the cap.
 */
export async function appendRoleMemory(
  flowDir: string,
  runId: string,
  slot: string,
  sprintN: number,
  content: string,
): Promise<void> {
  const filePath = roleMemoryPath(flowDir, runId, slot);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const block = `### Sprint ${sprintN}\n${content.trim()}\n`;
  let newContent = existing ? `${existing.trim()}\n\n${block}` : block;

  // Truncation logic: oldest-first truncation
  if (Buffer.byteLength(newContent) > MAX_MEMORY_BYTES) {
    const matches = [...newContent.matchAll(/^### Sprint \d+/gm)];
    let found = false;
    for (const match of matches) {
      const startIdx = match.index!;
      const sliced = newContent.slice(startIdx);
      if (Buffer.byteLength(sliced) <= MAX_MEMORY_BYTES) {
        newContent = sliced;
        found = true;
        break;
      }
    }
    
    // If even the last block is too big, just keep the last block (best effort)
    if (!found && matches.length > 0) {
      newContent = newContent.slice(matches[matches.length - 1].index!);
    }
  }

  // Ensure directory exists (atomicWriteText does this, but good to be explicit for clarity)
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteText(filePath, newContent);
}
