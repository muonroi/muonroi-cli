/**
 * src/product-loop/verify-failure-tracking.ts
 *
 * P3.1: computeFailureSignature — pure SHA-256 hash of (stack frames, verify command, file touched).
 * P3.2: load/save helpers for VerifyFailureSignatures persisted to state.md.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { getDefaultEEClient } from "../ee/intercept.js";
import { buildScope } from "../ee/scope.js";
import { getTenantId } from "../ee/tenant.js";
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

// ── P3.4: pushFailureToEE ────────────────────────────────────────────────────

/**
 * Fire-and-forget push of a repeating verify failure pattern to the EE
 * judge-worker. Called exactly ONCE per signature crossing the threshold (count=3).
 *
 * Uses the default EE client (posttool is already fire-and-forget — errors
 * are swallowed inside client.posttool).
 */
export async function pushFailureToEE(input: {
  signature: string;
  count: number;
  lastError: string;
  fileTouched: string;
  verifyCommand: string;
  runId: string;
  cwd: string;
}): Promise<void> {
  const client = getDefaultEEClient();
  const tenantId = getTenantId();
  const scope = await buildScope({ cwd: input.cwd });

  await client.posttool({
    toolName: "ideal_verify_fail",
    toolInput: {
      signature: input.signature,
      count: input.count,
      lastError: input.lastError,
      fileTouched: input.fileTouched,
      verifyCommand: input.verifyCommand,
    },
    outcome: {
      success: false,
      verifyResult: "fail",
      error: input.lastError.slice(0, 500),
    },
    cwd: input.cwd,
    tenantId,
    scope,
  });
}

// ── P3.3 helper: recordVerifyFailureAndMaybePush ─────────────────────────────

const PUSH_THRESHOLD = 3;

/**
 * Increment the failure counter for the given verify failure and, if the count
 * just crossed PUSH_THRESHOLD for the first time, push to EE.
 *
 * Extracted as a standalone helper so sprint-runner can call it after the
 * verify step without needing deep mocking of the surrounding context in tests.
 *
 * Returns the updated signatures map (already persisted).
 */
export async function recordVerifyFailureAndMaybePush(input: {
  flowDir: string;
  runId: string;
  cwd: string;
  errorMessage: string;
  verifyCommand: string;
  fileTouched: string;
}): Promise<VerifyFailureSignatures> {
  const { flowDir, runId, cwd, errorMessage, verifyCommand, fileTouched } = input;

  const sigs = await loadVerifyFailureSignatures(flowDir, runId);
  const sig = computeFailureSignature({ errorMessage, verifyCommand, fileTouched });
  const existing = sigs[sig];
  const prevCount = existing?.count ?? 0;

  sigs[sig] = {
    count: prevCount + 1,
    lastSeenAt: new Date().toISOString(),
    lastError: errorMessage.slice(0, 500),
    file: fileTouched,
  };

  await saveVerifyFailureSignatures(flowDir, runId, sigs);

  // Push to EE exactly once — only when the count transitions from <3 to 3.
  if (prevCount < PUSH_THRESHOLD && sigs[sig].count >= PUSH_THRESHOLD) {
    await pushFailureToEE({
      signature: sig,
      count: sigs[sig].count,
      lastError: sigs[sig].lastError,
      fileTouched,
      verifyCommand,
      runId,
      cwd,
    });
  }

  return sigs;
}
