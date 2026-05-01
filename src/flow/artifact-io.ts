/**
 * Read/write .muonroi-flow/ top-level files via atomic-rename.
 *
 * All reads parse heading-delimited markdown via parseSections.
 * All writes serialize via serializeSections then atomicWriteText.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import type { SectionMap } from "./parser.js";
import { parseSections, serializeSections } from "./parser.js";

/**
 * Read a .muonroi-flow/ file and parse it into a SectionMap.
 * Returns null if the file does not exist (ENOENT).
 */
export async function readArtifact(flowDir: string, filename: string): Promise<SectionMap | null> {
  const filePath = path.join(flowDir, filename);
  try {
    const content = await fs.readFile(filePath, "utf8");
    return parseSections(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write a SectionMap to a .muonroi-flow/ file using atomic-rename.
 */
export async function writeArtifact(
  flowDir: string,
  filename: string,
  map: SectionMap,
  order?: string[],
): Promise<void> {
  const filePath = path.join(flowDir, filename);
  const content = serializeSections(map, order);
  await atomicWriteText(filePath, content);
}
