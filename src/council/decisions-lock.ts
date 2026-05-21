/**
 * src/council/decisions-lock.ts
 *
 * C2: Persist council_summary decisions to .planning/runs/<runId>/decisions.lock.md
 * after council synthesis, and read them back in sprint-runner before implementation.
 *
 * The lock file is pure string formatting — no LLM calls are made here.
 * Values come from the structured councilSummary artifact + ClarifiedSpec.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import type { ClarifiedSpec, DebateStance } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DecisionsLockInput {
  runId: string;
  /** The run directory, typically <flowDir>/runs/<runId> */
  runDir: string;
  spec: ClarifiedSpec;
  /** ISO timestamp from the synthesis step */
  timestamp: string;
  /** Final positions array from debateState.active */
  participants: Array<{ role: string; stance?: DebateStance; position: string }>;
  /** Readable summary from the synthesizer */
  synthesisExcerpt: string;
  /**
   * If the Leader flagged any out-of-stack proposals, list them here
   * so they appear in the REJECTED section of the lock file.
   */
  rejectedProposals?: string[];
}

// ── Stack lock extraction helpers ─────────────────────────────────────────────

/**
 * Known stack values that indicate a committed scaffold target.
 * Extend as new scaffold frameworks are added.
 */
const BB_BACKEND_KEYWORDS = ["muonroi", "basetemplate", "base-template", "building-block", "bb"];
const REACT_FE_KEYWORDS = ["react", "vite-react"];

function _isCommittedBackend(val: string | undefined): boolean {
  if (!val) return false;
  const lower = val.toLowerCase();
  return BB_BACKEND_KEYWORDS.some((kw) => lower.includes(kw));
}

function _isCommittedFrontend(val: string | undefined): boolean {
  if (!val) return false;
  const lower = val.toLowerCase();
  return REACT_FE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Extract stack-related values from the ClarifiedSpec constraints + scope
 * as well as free-text analysis. Returns null when stack is genuinely unknown
 * (greenfield / no scaffold chosen yet).
 */
export interface ExtractedStack {
  backend: string | null;
  frontend: string | null;
  database: string | null;
  license: string | null;
}

export function extractStackFromSpec(spec: ClarifiedSpec): ExtractedStack | null {
  const all = [spec.problemStatement, ...spec.constraints, spec.scope].filter(Boolean).join(" ").toLowerCase();

  const backendMatch =
    all.includes("muonroi.basetemplate") ||
    all.includes("muonroi basetemplate") ||
    all.includes("basetemplate") ||
    all.includes("building-block") ||
    all.includes("mediatр") ||
    all.includes("mediatр")
      ? "Muonroi.BaseTemplate (.NET 9, CQRS/MediatR, MEntity/MRepository pattern)"
      : null;

  const frontendMatch =
    all.includes("react") && (all.includes("vite") || all.includes("css module"))
      ? "React 18 + Vite + plain CSS modules (NO shadcn, NO Radix, NO Tailwind unless explicitly listed)"
      : all.includes("react")
        ? "React 18"
        : null;

  const dbMatch =
    all.includes("postgresql") || all.includes("postgres")
      ? "PostgreSQL"
      : all.includes("sqlite")
        ? "SQLite (default, PostgreSQL upgrade path)"
        : null;

  const licenseMatch = all.includes("muonroi") ? "Muonroi commercial license required" : null;

  // Only return a non-null ExtractedStack when at least one field is committed.
  if (!backendMatch && !frontendMatch && !dbMatch && !licenseMatch) return null;

  return {
    backend: backendMatch,
    frontend: frontendMatch,
    database: dbMatch,
    license: licenseMatch,
  };
}

// ── STACK LOCK section builder (C1) ───────────────────────────────────────────

/**
 * Build the STACK LOCK section for council system prompts.
 *
 * Returns an empty string when the spec has no committed scaffold target
 * (greenfield — no lock should be injected).
 *
 * The returned text is pre-formatted for inclusion directly inside a system
 * prompt. It is intentionally verbose/assertive so the model treats the
 * constraints as hard rails, not suggestions.
 */
export function buildStackLockSection(spec: ClarifiedSpec): string {
  const stack = extractStackFromSpec(spec);
  if (!stack) return "";

  const lines: string[] = ["## STACK LOCK (NON-NEGOTIABLE)"];

  if (stack.backend) {
    lines.push(`- Backend: ${stack.backend}`);
  }
  if (stack.frontend) {
    lines.push(`- Frontend: ${stack.frontend}`);
  }
  if (stack.database) {
    lines.push(`- Database: ${stack.database}`);
  }
  if (stack.license) {
    lines.push(`- License: ${stack.license}`);
  }

  lines.push(
    "",
    "Your debate MUST stay within this stack. You may discuss tradeoffs WITHIN the locked stack " +
      "(e.g. which BB modules to enable, .NET 9 vs .NET 8 within Muonroi compatibility) " +
      "but you MUST NOT propose alternative frameworks. " +
      'Proposals like "use Next.js" or "use shadcn" are out of scope — ' +
      "flag them as scope violations and redirect.",
    "",
  );

  return lines.join("\n");
}

// ── Out-of-stack detector for Leader synthesis ─────────────────────────────────

/**
 * Scan the synthesis text for mentions of out-of-stack technologies.
 * Returns the list of flagged tech names found in the synthesis.
 * Used by Leader synthesis check to mark consensus as partial when drift occurs.
 *
 * Only runs when a committed stack exists in the spec.
 */
const OUT_OF_STACK_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bnext\.?js\b/i, name: "Next.js" },
  { pattern: /\bshadcn\b/i, name: "shadcn" },
  { pattern: /\bradix[\s-]ui\b/i, name: "Radix UI" },
  { pattern: /\btailwind(css)?\b/i, name: "Tailwind CSS" },
  { pattern: /\bnestjs\b|\bnest\.js\b/i, name: "NestJS" },
  { pattern: /\bexpress\.?js\b|\bexpress\s+framework\b/i, name: "Express.js" },
  { pattern: /\bdjango\b/i, name: "Django" },
  { pattern: /\bruby on rails\b|\brails\b/i, name: "Ruby on Rails" },
  { pattern: /\blaravel\b/i, name: "Laravel" },
  { pattern: /\bspring boot\b/i, name: "Spring Boot" },
];

export function detectOutOfStackProposals(synthesisText: string, spec: ClarifiedSpec): string[] {
  const stack = extractStackFromSpec(spec);
  if (!stack) return []; // No committed stack — nothing to enforce

  const found: string[] = [];
  for (const { pattern, name } of OUT_OF_STACK_PATTERNS) {
    if (pattern.test(synthesisText)) {
      found.push(name);
    }
  }
  return found;
}

// ── C2: Write decisions.lock.md ───────────────────────────────────────────────

/**
 * Render the decisions.lock.md content from structured inputs.
 * Pure string formatting — no I/O or LLM calls.
 */
export function renderDecisionsLock(input: DecisionsLockInput): string {
  const stack = extractStackFromSpec(input.spec);

  const stackSection = stack
    ? [
        "## Stack",
        stack.backend ? `- Backend: ${stack.backend}` : null,
        stack.frontend ? `- Frontend: ${stack.frontend}` : null,
        stack.database ? `- Database: ${stack.database}` : null,
        stack.license ? `- License: ${stack.license}` : null,
      ]
        .filter((l) => l !== null)
        .join("\n")
    : "## Stack\n_(Greenfield — no scaffold target committed)_";

  // Architecture decisions from synthesis excerpt
  const archSection = input.synthesisExcerpt.trim()
    ? `## Architecture Decisions\n${input.synthesisExcerpt
        .split(/\n+/)
        .filter((l) => l.trim().length > 0)
        .slice(0, 10)
        .map((l) => (l.startsWith("-") ? l : `- ${l}`))
        .join("\n")}`
    : "## Architecture Decisions\n_(No synthesis excerpt provided)_";

  // Per-role sections
  const costController = input.participants.find(
    (p) => p.role === "verify" || p.stance?.name?.toLowerCase().includes("cost"),
  );
  const skeptic = input.participants.find(
    (p) => p.stance?.name?.toLowerCase().includes("skeptic") || p.stance?.name?.toLowerCase().includes("risk"),
  );
  const architect = input.participants.find(
    (p) => p.role === "implement" || p.stance?.name?.toLowerCase().includes("architect"),
  );

  function roleSection(heading: string, p: { position: string } | undefined): string {
    if (!p?.position?.trim()) {
      return `## ${heading}\n_(No position recorded)_`;
    }
    const bullets = p.position
      .split(/\n+/)
      .filter((l) => l.trim().length > 0)
      .slice(0, 5)
      .map((l) => (l.startsWith("-") ? l : `- ${l}`))
      .join("\n");
    return `## ${heading}\n${bullets}`;
  }

  const rejectedSection =
    input.rejectedProposals && input.rejectedProposals.length > 0
      ? `## Out-of-stack proposals (REJECTED)\n${input.rejectedProposals.map((r) => `- ${r}`).join("\n")}`
      : "## Out-of-stack proposals (REJECTED)\n_(None flagged)_";

  return [
    `# Locked Decisions — Run ${input.runId}`,
    `> Generated from council_summary at ${input.timestamp}`,
    "",
    stackSection,
    "",
    archSection,
    "",
    roleSection("Tradeoffs (Cost-Controller)", costController),
    "",
    roleSection("Risks (Skeptic)", skeptic),
    "",
    roleSection("Architecture (Architect)", architect),
    "",
    rejectedSection,
    "",
  ].join("\n");
}

/**
 * Write decisions.lock.md to the run directory.
 * Fails gracefully — returns false on error, true on success.
 * Caller (council index) is responsible for error logging.
 */
export async function writeDecisionsLock(input: DecisionsLockInput): Promise<boolean> {
  try {
    const content = renderDecisionsLock(input);
    const filePath = path.join(input.runDir, "decisions.lock.md");
    await atomicWriteText(filePath, content);
    return true;
  } catch {
    return false;
  }
}

// ── C2: Read decisions.lock.md ────────────────────────────────────────────────

/**
 * Read decisions.lock.md from the run directory.
 * Returns null when the file does not exist (no lock file = no-op pass-through).
 */
export async function readDecisionsLock(runDir: string): Promise<string | null> {
  const filePath = path.join(runDir, "decisions.lock.md");
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null; // Fail-open — missing lock file is not an error
  }
}

/**
 * Prepend the decisions lock content to an implementation prompt.
 * Returns the original prompt unchanged if lockContent is null/empty.
 */
export function prependDecisionsLock(prompt: string, lockContent: string | null): string {
  if (!lockContent?.trim()) return prompt;
  return (
    `## Locked decisions you MUST follow\n\n` +
    `${lockContent.trim()}\n\n` +
    `---\n\n` +
    `## Sprint task\n\n` +
    `${prompt}`
  );
}
