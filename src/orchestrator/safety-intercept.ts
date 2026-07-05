/**
 * safety-intercept.ts — pure decision helpers for the tool-engine safety-block
 * interceptor (tool-engine.ts). Extracted so the block-parse and the
 * permission-mode policy are unit-testable in isolation from the giant
 * executeToolEngine generator.
 *
 * Flow context: bash.execute / registry precheck emit a tool result whose text
 * starts with `BLOCKED (<kind>): <reason>`. The tool-engine joins output+error,
 * parses it here, and decides whether to auto-block, auto-allow (yolo), or show
 * the safety-override askcard via deps.askSafetyOverride.
 */

import type { PermissionMode } from "../utils/permission-mode.js";
import type { SafetyBlockKind } from "./safety-askcard.js";

export interface ParsedSafetyBlock {
  kind: SafetyBlockKind;
  reason: string;
}

/**
 * Parse a joined tool-result text into a safety block, or null when the text
 * is not a BLOCKED marker.
 *
 * Tolerant of leading whitespace: when bash.execute returns `{error: "BLOCKED
 * (...)"}` with no `output`, the joined text is the raw marker — but a result
 * shape that carries an empty-string `output` produces a leading "\n" before
 * the marker, which an anchored `/^BLOCKED/` would miss and silently drop the
 * askcard (hard-stop with no prompt). Stripping leading whitespace first makes
 * the parse robust to both shapes while still requiring the marker at the head
 * of the (trimmed) text — so a command whose normal output merely mentions
 * "BLOCKED (...)" mid-stream is not mistaken for a real block.
 */
export function parseSafetyBlock(outputText: string): ParsedSafetyBlock | null {
  if (typeof outputText !== "string") return null;
  const match = outputText.replace(/^\s+/, "").match(/^BLOCKED \(([^)]+)\):\s*(.*)/);
  if (!match) return null;
  return { kind: match[1] as SafetyBlockKind, reason: match[2] ?? "" };
}

/**
 * Whether a parsed block should be auto-allowed (allow-once) without showing
 * the askcard, given the active permission mode.
 *
 * Policy (confirmed with the user):
 *   - `yolo` auto-allows lower-severity blocks (`git-safety`, `dangerous`) so
 *     the "don't ask me" mode actually stops asking for routine guardrails.
 *   - `catastrophic` ALWAYS shows the askcard, even in yolo — an irreversible
 *     destroyer (rm -rf /dev, mkfs, sudo …) must never run unattended.
 *   - `empty-bash` is handled separately (auto-block, no card) and never
 *     reaches this policy.
 *   - `safe` / `auto-edit` always show the card for any real block.
 */
export function shouldAutoAllowYolo(kind: SafetyBlockKind, mode: PermissionMode): boolean {
  if (mode !== "yolo") return false;
  if (kind === "catastrophic") return false;
  if (kind === "empty-bash") return false;
  return true;
}
