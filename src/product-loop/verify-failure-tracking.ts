/**
 * src/product-loop/verify-failure-tracking.ts
 *
 * P3.1: computeFailureSignature — pure SHA-256 hash of (stack frames, verify command, file touched).
 * P3.2: load/save helpers for VerifyFailureSignatures persisted to state.md.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VerifyFailureRecord {
  count: number;
  lastSeenAt: string; // ISO
  lastError: string; // truncated to 500 chars
  file: string;
}

export type VerifyFailureSignatures = Record<string, VerifyFailureRecord>;

const SECTION_NAME = "Verify Failure Signatures";

// ── P3.1: computeFailureSignature ────────────────────────────────────────────

/**
 * Stable 16-char hex signature for a verify failure.
 *
 * Algorithm:
 *   1. Extract up to 2 stack-frame lines from errorMessage:
 *      - Lines matching `    at <identifier>` (JS/TS stack frames)
 *      - Lines matching `<path>:<line>:<col>` patterns
 *   2. If fewer than 2 frames found, fall back to the trimmed error message.
 *   3. SHA-256( frames + "|" + verifyCommand + "|" + fileTouched )
 *   4. Return first 16 hex chars.
 *
 * Pure: no async, no I/O. Same input → same output.
 */
export function computeFailureSignature(input: {
  errorMessage: string;
  verifyCommand: string;
  fileTouched: string;
}): string {
  const { errorMessage, verifyCommand, fileTouched } = input;

  const frames = extractStackFrames(errorMessage, 2);
  const dominant = frames.length > 0 ? frames.join("\n") : errorMessage.trim();

  const payload = `${dominant}|${verifyCommand}|${fileTouched}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Extract up to `limit` stack-frame lines from an error string.
 * Recognises:
 *   - JS/TS frames:  "    at FunctionName (file:line:col)"  or  "    at file:line:col"
 *   - Path frames:   "/abs/path/file.ts:42:7"  or  "relative/path.ts:42:7"
 */
function extractStackFrames(errorMessage: string, limit: number): string[] {
  const frames: string[] = [];
  for (const line of errorMessage.split("\n")) {
    if (frames.length >= limit) break;
    const trimmed = line.trim();
    // JS/TS "at ..." frame
    if (/^at\s+\S/.test(trimmed)) {
      frames.push(trimmed);
      continue;
    }
    // path:line:col pattern (absolute or relative)
    if (/^(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/]|\w[\w.-]*[\\/]).*:\d+:\d+/.test(trimmed)) {
      frames.push(trimmed);
    }
  }
  return frames;
}

// ── P3.2: load/save VerifyFailureSignatures ──────────────────────────────────

/**
 * Load the VerifyFailureSignatures map from the `## Verify Failure Signatures`
 * section of state.md. Returns {} on any read/parse error (fail-open).
 */
export async function loadVerifyFailureSignatures(flowDir: string, runId: string): Promise<VerifyFailureSignatures> {
  try {
    const runDir = path.join(flowDir, "runs", runId);
    const stateMap = await readArtifact(runDir, "state.md");
    if (!stateMap) return {};

    const raw = stateMap.sections.get(SECTION_NAME);
    if (!raw || !raw.trim()) return {};

    const parsed = JSON.parse(raw.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as VerifyFailureSignatures;
  } catch {
    return {};
  }
}

/**
 * Persist the VerifyFailureSignatures map into the `## Verify Failure Signatures`
 * section of state.md. Creates or updates the section; other sections are preserved.
 */
export async function saveVerifyFailureSignatures(
  flowDir: string,
  runId: string,
  sigs: VerifyFailureSignatures,
): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
  stateMap.sections.set(SECTION_NAME, JSON.stringify(sigs, null, 2));
  await writeArtifact(runDir, "state.md", stateMap);
}
