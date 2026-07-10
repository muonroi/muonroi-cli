/**
 * state-document.ts — Native replacement for gsd-core/bin/lib/state-document.cjs
 *
 * STATE.md Document Module — pure transforms for STATE.md text.
 * This module does not read the filesystem and does not own persistence or locking.
 */

export interface StateDocumentModule {
  stateExtractField: (content: string, fieldName: string) => string | null;
  stateReplaceField: (content: string, fieldName: string, newValue: string) => string;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTableSeparatorRow(firstCell: string): boolean {
  return /^[\s\-:]+$/.test(firstCell.trim());
}

function tableRowPattern(escapedFieldName: string): RegExp {
  return new RegExp(`^(\\|[ \\t]*)(${escapedFieldName})([ \\t]*\\|[ \\t]*)([^|\\n]*?)([ \\t]*\\|[ \\t]*)$`, "im");
}

/**
 * Extract a field value from STATE.md content.
 * Supports bold inline (**FieldName:** value), plain line-start (FieldName: value),
 * and pipe-table (| FieldName | value |) formats.
 */
export function stateExtractField(content: string, fieldName: string): string | null {
  const escaped = escapeRegex(fieldName);

  // Bold inline: **FieldName:** value
  const boldPattern = new RegExp(`\\*\\*${escaped}:\\*\\*[ \\t]*(.+)`, "i");
  const boldMatch = content.match(boldPattern);
  if (boldMatch) return boldMatch[1].trim();

  // Plain line-start: FieldName: value
  const plainPattern = new RegExp(`^${escaped}:[ \\t]*(.+)`, "im");
  const plainMatch = content.match(plainPattern);
  if (plainMatch) return plainMatch[1].trim();

  // Pipe-table: | FieldName | value |
  const tableMatch = content.match(tableRowPattern(escaped));
  if (tableMatch && !isTableSeparatorRow(tableMatch[2])) return tableMatch[4].trim();

  return null;
}

/**
 * Replace a field value in STATE.md content.
 * Returns null if the field is not found in any known format.
 */
export function stateReplaceField(content: string, fieldName: string, newValue: string): string | null {
  const escaped = escapeRegex(fieldName);

  // Bold inline: **FieldName:** value
  const boldPattern = new RegExp(`(\\*\\*${escaped}:\\*\\*\\s*)(.*)`, "i");
  if (boldPattern.test(content)) {
    return content.replace(boldPattern, (_match, prefix) => `${prefix}${newValue}`);
  }

  // Plain line-start: FieldName: value
  const plainPattern = new RegExp(`(^${escaped}:\\s*)(.*)`, "im");
  if (plainPattern.test(content)) {
    return content.replace(plainPattern, (_match, prefix) => `${prefix}${newValue}`);
  }

  // Pipe-table: | FieldName | value |
  const tblPat = tableRowPattern(escaped);
  const tblMatch = content.match(tblPat);
  if (tblMatch && !isTableSeparatorRow(tblMatch[2])) {
    return content.replace(
      tblPat,
      (_m, leadPipe, fieldCell, midPipe, _oldVal, trailPipe) =>
        `${leadPipe}${fieldCell}${midPipe}${newValue}${trailPipe}`,
    );
  }

  return null;
}

/**
 * Replace a field with a primary name, falling back to an alternate field name.
 */
export function stateReplaceFieldWithFallback(
  content: string,
  primary: string,
  fallback: string | undefined,
  value: string,
): string {
  const result = stateReplaceField(content, primary, value);
  if (result) return result;
  if (fallback) {
    const fbResult = stateReplaceField(content, fallback, value);
    if (fbResult) return fbResult;
  }
  return content;
}

/** Normalize a status string to a canonical value. */
export function normalizeStateStatus(status: string, pausedAt?: string): string {
  const statusLower = (status || "").toLowerCase();
  if (statusLower.includes("paused") || statusLower.includes("stopped") || pausedAt) {
    return "paused";
  }
  if (statusLower.includes("executing") || statusLower.includes("in progress")) {
    return "executing";
  }
  if (statusLower.includes("planning") || statusLower.includes("ready to plan")) {
    return "planning";
  }
  if (statusLower.includes("discussing")) return "discussing";
  if (statusLower.includes("verif")) return "verifying";
  if (statusLower.includes("complete") || statusLower.includes("done")) return "completed";
  if (statusLower.includes("ready to execute")) return "executing";
  return status || "unknown";
}

/** Compute progress percentage from plan and phase counts. */
export function computeProgressPercent(
  completedPlans: number | null,
  totalPlans: number | null,
  completedPhases: number | null,
  totalPhases: number | null,
): number | null {
  const hasPlanData = totalPlans !== null && totalPlans > 0 && completedPlans !== null;
  const hasPhaseData = totalPhases !== null && totalPhases > 0 && completedPhases !== null;
  if (!hasPlanData && !hasPhaseData) return null;

  const planFraction = hasPlanData ? (completedPlans ?? 0) / (totalPlans ?? 1) : 1;
  const phaseFraction = hasPhaseData ? (completedPhases ?? 0) / (totalPhases ?? 1) : 1;
  return Math.min(100, Math.round(Math.min(planFraction, phaseFraction) * 100));
}

/**
 * KNOWN_TEMPLATE_DEFAULTS — per-field table of handler-written values.
 * A value in this list is safe to overwrite on the next handler call.
 */
export const KNOWN_TEMPLATE_DEFAULTS: Record<string, string[]> = {
  "Resume File": ["None"],
  Status: [
    "Ready to execute",
    "Phase complete — ready for verification",
    "Ready to plan",
    "Defining requirements",
    "Planning complete",
    "Executing",
    "In progress",
    "Planning",
    "Verifying",
    "Completed",
    "Done",
    "Active",
    "Paused",
    "unknown",
  ],
  "Last Activity": [],
  "Last activity": [],
};

/**
 * Regex patterns matching handler-generated Status values with variable components.
 */
export const KNOWN_STATUS_PATTERNS: RegExp[] = [
  /^Executing Phase\s+\d+/i,
  /^Planning Phase\s+\d+/i,
  /^Phase\s+\d+\s+complete/i,
  /^Verifying Phase\s+\d+/i,
  /^Phase complete/i,
  /^Complete\s*[✓✔✅☑]?\s*$/i,
];

/** Check if a value is a known template default (handler may overwrite it). */
export function isStateTemplateDefault(field: string, value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const v = (typeof value === "string" ? value : `${value}`).trim();
  if (v === "") return true;

  const defaults = KNOWN_TEMPLATE_DEFAULTS[field];
  const matched = defaults ? defaults.some((d) => d.toLowerCase() === v.toLowerCase()) : false;
  if (matched) return true;

  const fieldLower = field.toLowerCase();
  if (fieldLower === "status" && KNOWN_STATUS_PATTERNS.some((p) => p.test(v))) return true;
  if (fieldLower === "last activity" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return true;

  return false;
}
