/**
 * .quick-codex-flow/ -> .muonroi-flow/ migration.
 *
 * Detects legacy QC flow directory and migrates it one-shot to the new format.
 * Original .quick-codex-flow/ is NOT deleted after migration.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import type { SectionMap } from "./parser.js";
import { parseSections, serializeSections } from "./parser.js";
import { ensureFlowDir } from "./scaffold.js";

/** QC top-level file -> muonroi-flow file mapping */
const TOP_LEVEL_MAP: Record<string, string> = {
  "STATE.md": "state.md",
  "PROJECT-ROADMAP.md": "roadmap.md",
  "BACKLOG.md": "backlog.md",
};

/** QC run section heading -> target file in runs/<id>/ */
const SECTION_TO_FILE: Record<string, string> = {
  "Delivery Roadmap": "roadmap.md",
  "Delegation State": "delegations.md",
  "Gray Area Register": "gray-areas.md",
};

/** Sections that go into runs/<id>/state.md */
const _STATE_SECTIONS = new Set(["Resume Digest", "Compact-Safe Summary", "Experience Snapshot", "Workflow State"]);

/** Sections that go into the top-level decisions.md */
const DECISIONS_SECTIONS = new Set(["Decision Register"]);

/**
 * Detect whether a legacy .quick-codex-flow/ directory exists.
 */
export async function detectLegacyFlow(cwd: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(cwd, ".quick-codex-flow"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Migrate .quick-codex-flow/ to .muonroi-flow/.
 *
 * - Top-level: STATE.md -> state.md, PROJECT-ROADMAP.md -> roadmap.md, BACKLOG.md -> backlog.md
 * - Run files (non-top-level .md): split by heading into per-aspect files
 * - Decision Register sections -> appended to decisions.md
 * - Unknown sections -> preserved in runs/<id>/state.md
 * - Original .quick-codex-flow/ is NOT deleted
 */
export async function migrateQuickCodexFlow(cwd: string): Promise<{ runsCreated: number; filesCopied: number }> {
  const qcDir = path.join(cwd, ".quick-codex-flow");
  const flowDir = await ensureFlowDir(cwd);

  let runsCreated = 0;
  let filesCopied = 0;

  // 1. Copy top-level files with renames
  for (const [qcName, flowName] of Object.entries(TOP_LEVEL_MAP)) {
    const srcPath = path.join(qcDir, qcName);
    try {
      const content = await fs.readFile(srcPath, "utf8");
      await atomicWriteText(path.join(flowDir, flowName), content);
      filesCopied++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Missing top-level file is OK — skip
    }
  }

  // 2. Find and split run files (non-top-level .md files)
  const topLevelNames = new Set(Object.keys(TOP_LEVEL_MAP));
  const entries = await fs.readdir(qcDir);
  const runFiles = entries.filter((e) => e.endsWith(".md") && !topLevelNames.has(e));

  // Accumulate decisions from all run files
  let decisionsContent = "";

  for (const runFile of runFiles) {
    const content = await fs.readFile(path.join(qcDir, runFile), "utf8");
    const parsed = parseSections(content);

    // Derive run ID from filename slug (lowercase, dashes, no extension)
    const runId = runFile
      .replace(/\.md$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const runDir = path.join(flowDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });

    // Buckets for per-file sections
    const roadmapSections = new Map<string, string>();
    const delegationsSections = new Map<string, string>();
    const grayAreasSections = new Map<string, string>();
    const stateSections = new Map<string, string>();

    for (const [heading, body] of parsed.sections) {
      if (SECTION_TO_FILE[heading] === "roadmap.md") {
        roadmapSections.set(heading, body);
      } else if (SECTION_TO_FILE[heading] === "delegations.md") {
        delegationsSections.set(heading, body);
      } else if (SECTION_TO_FILE[heading] === "gray-areas.md") {
        grayAreasSections.set(heading, body);
      } else if (DECISIONS_SECTIONS.has(heading)) {
        decisionsContent += `## ${heading}\n\n${body}\n\n`;
      } else {
        // STATE_SECTIONS + unknown sections -> state.md (tolerant)
        stateSections.set(heading, body);
      }
    }

    // Write per-aspect files
    const writeMap = async (filePath: string, sections: Map<string, string>) => {
      const map: SectionMap = { preamble: "", sections };
      await atomicWriteText(filePath, serializeSections(map));
    };

    await writeMap(path.join(runDir, "roadmap.md"), roadmapSections);
    await writeMap(path.join(runDir, "state.md"), stateSections);
    await writeMap(path.join(runDir, "delegations.md"), delegationsSections);
    await writeMap(path.join(runDir, "gray-areas.md"), grayAreasSections);

    runsCreated++;
    filesCopied += 4;
  }

  // 3. Append decisions to top-level decisions.md
  if (decisionsContent) {
    const existingDecisions = await fs.readFile(path.join(flowDir, "decisions.md"), "utf8").catch(() => "");
    await atomicWriteText(path.join(flowDir, "decisions.md"), existingDecisions + decisionsContent);
  }

  return { runsCreated, filesCopied };
}
