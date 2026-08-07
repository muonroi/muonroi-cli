/**
 * `.planning/PLAN.md` as data. The planner emits this exact shape and the phase
 * executor reads it back, so the format is a contract between them — a phase
 * carries its OWN acceptance criteria and verify command, which is what lets the
 * executor gate each phase independently instead of flattening every step into
 * one prompt the way the old runExecution did.
 */

export interface PlanPhase {
  /** `P0`, `P1`, … — ordering is the array order, not the number. */
  id: string;
  title: string;
  steps: string[];
  files: string[];
  acceptance: string[];
  /** Shell command that proves this phase; empty string when the plan gives none. */
  verify: string;
  done: boolean;
}

/**
 * Phase heading: `## P0 — Title`.
 *
 * The separator accepts an em dash (U+2014, what `renderPlanMarkdown` emits), an
 * en dash (U+2013) or a plain hyphen. It used to require U+2014 exactly, so a
 * hand-edited PLAN.md typed with `-` parsed as ZERO phases — and `runPlanExecution`
 * then returned `reason: "plan complete"` having run nothing at all. A dash
 * variant is not a reason to silently declare a plan finished.
 */
const PHASE_RE = /^##\s+(P\d+)\s*[—–-]\s*(.+)$/;
const BULLET_RE = /^-\s*(.*)$/;

function section(lines: string[], heading: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith(`**${heading}:**`)) {
      inside = true;
      const inline = line.slice(`**${heading}:**`.length).trim();
      if (inline) out.push(inline);
      continue;
    }
    if (inside) {
      // Blank line ends the section.
      if (!line.trim()) break;

      // Next section heading ends the section.
      if (line.trim().startsWith("**")) break;

      // Try to match a bullet (allows empty content after dash).
      const m = BULLET_RE.exec(line.trim());
      if (m) {
        out.push(m[1]);
        continue;
      }

      // Non-bullet, non-blank line ends the section.
      break;
    }
  }
  return out;
}

export function renderPlanMarkdown(topic: string, phases: PlanPhase[]): string {
  const blocks = phases.map((p) => {
    // Guard: verify must be a single line (no embedded newlines).
    if (p.verify.includes("\n") || p.verify.includes("\r")) {
      throw new Error(`[plan-artifact] phase ${p.id}: verify command cannot contain newlines`);
    }
    return [
      `## ${p.id} — ${p.title}`,
      "",
      `**Files:**`,
      ...p.files.map((f) => `- ${f}`),
      "",
      `**Steps:**`,
      ...p.steps.map((s) => `- ${s}`),
      "",
      `**Acceptance:**`,
      ...p.acceptance.map((a) => `- ${a}`),
      "",
      `**Verify:** ${p.verify}`,
      "",
      `**Status:** ${p.done ? "done" : "pending"}`,
    ].join("\n");
  });
  return [`# PLAN — ${topic}`, "", ...blocks].join("\n\n").trimEnd() + "\n";
}

export function parsePlanMarkdown(body: string): PlanPhase[] {
  const lines = body.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (PHASE_RE.test(line)) starts.push(i);
  });
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    const block = lines.slice(start, end);
    const head = PHASE_RE.exec(block[0]);
    const statusLine = block.find((l) => l.startsWith("**Status:**")) ?? "";
    const verifyLine = block.find((l) => l.startsWith("**Verify:**")) ?? "";
    return {
      id: head?.[1] ?? "",
      title: head?.[2]?.trim() ?? "",
      steps: section(block, "Steps"),
      files: section(block, "Files"),
      acceptance: section(block, "Acceptance"),
      verify: verifyLine.slice("**Verify:**".length).trim(),
      done: statusLine.slice("**Status:**".length).trim() === "done",
    };
  });
}

export function markPhaseDone(body: string, phaseId: string): string {
  const lines = body.split(/\r?\n/);
  let inPhase = false;
  let changed = false;
  const out = lines.map((line) => {
    const head = PHASE_RE.exec(line);
    if (head) inPhase = head[1] === phaseId;
    if (inPhase && line.startsWith("**Status:**")) {
      inPhase = false;
      changed = true;
      return "**Status:** done";
    }
    return line;
  });
  return changed ? out.join("\n") : body;
}

export function nextPendingPhase(body: string): PlanPhase | null {
  return parsePlanMarkdown(body).find((p) => !p.done) ?? null;
}
