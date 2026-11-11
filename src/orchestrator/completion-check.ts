/**
 * src/orchestrator/completion-check.ts
 *
 * Host-checked completion status for the orchestrator's final answer.
 *
 * The root goal is pinned and `root_status="complete"` is refused while
 * open_items remain or FLOW implementation verification is not recorded_pass
 * (working-context.ts) — but only when the model calls context_load. The false
 * "done" in session 4edc02516a92 lived in free text (seq 680), which no gate
 * read. This module reads the FINAL TEXT: when it asserts the whole task is done
 * while the host's own ledger says otherwise, the caller appends a visible
 * footer and records it. The model's text is never rewritten.
 */

import { findAssertedSentence } from "./verification-claims.js";
import type { RootCompletionFacts, WorkingContextState } from "./working-context.js";

const COMPLETION_PATTERNS: readonly RegExp[] = [
  /\b(?:all|everything)\s+(?:is\s+|has\s+been\s+)?(?:now\s+)?(?:fully\s+)?(?:done|complete|completed|finished)\b/i,
  /\b(?:the\s+)?(?:whole\s+|entire\s+)?(?:task|work|job|implementation|feature|migration|refactor)\s+(?:is\s+|has\s+been\s+)?(?:now\s+)?(?:fully\s+)?(?:done|complete|completed|finished)\b/i,
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:now\s+)?(?:fully\s+)?(?:completed|finished)\s+(?:the\s+(?:whole\s+|entire\s+)?task|all\b|everything\b)/i,
  /\bfully\s+(?:implemented|done|complete)\b/i,
  /\b(?:task|work)\s+complete\b/i,
  /^\s*(?:all\s+)?done[.!]?\s*$/i,
  /(?:đã\s+)?(?:hoàn thành|hoàn tất|xong)\s+(?:hết|toàn bộ|tất cả|nhiệm vụ|công việc|task)/i,
  /(?:tất cả|mọi thứ|toàn bộ)\s+(?:đều\s+)?(?:đã\s+)?(?:xong|hoàn thành|hoàn tất)/i,
];

/** The asserted whole-task completion sentence in `text`, or null. */
export function findCompletionClaim(text: string): string | null {
  return findAssertedSentence(text, COMPLETION_PATTERNS);
}

/**
 * Subjects of the not-completed items of the LATEST todo_write call in a
 * model-message history ([] when the model never kept a todo list). The todo
 * list is a host-visible ledger that exists without any context_load call.
 */
export function latestOpenTodos(messages: readonly unknown[]): string[] {
  let latest: unknown;
  for (const raw of messages) {
    const content = (raw as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<{ type?: string; toolName?: string; input?: unknown }>) {
      if (part?.type === "tool-call" && part.toolName === "todo_write") latest = part.input;
    }
  }
  const input = typeof latest === "string" ? safeParse(latest) : latest;
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return [];
  return todos
    .filter(
      (t): t is { subject: string; status?: unknown } =>
        !!t && typeof (t as { subject?: unknown }).subject === "string",
    )
    .filter((t) => t.status !== "completed" && t.subject.trim())
    .map((t) => t.subject.trim());
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`[completion-check] unparseable todo_write input: ${(err as Error).message}`);
    return null;
  }
}

export interface CompletionCheck {
  claim: string;
  rootGoal: string;
  openItems: string[];
  /** Not-completed items of the latest todo_write list. */
  openTodos: string[];
  implementationVerification: RootCompletionFacts["implementationVerification"] | null;
  declaredPlanScope: string | null;
}

/**
 * Host verdict on a final answer: non-null only when the text claims the whole
 * task is done AND the host ledger has a reason it is not — open items on an
 * open pinned root goal, or a native FLOW plan whose implementation
 * verification is not recorded_pass.
 */
export function checkCompletionClaim(
  text: string,
  state: Pick<WorkingContextState, "root_goal" | "root_status" | "open_items"> | null,
  facts: RootCompletionFacts | null,
  openTodos: readonly string[] = [],
): CompletionCheck | null {
  const openRoot = state && state.root_goal && state.root_status === "open" ? state : null;
  const openItems = openRoot ? openRoot.open_items.filter((item) => item.trim()) : [];
  const unverified = facts && facts.implementationVerification !== "recorded_pass" ? facts : null;
  if (!openItems.length && !unverified && !openTodos.length) return null;
  const claim = findCompletionClaim(text);
  if (!claim) return null;
  return {
    claim,
    rootGoal: openRoot?.root_goal ?? "",
    openItems,
    openTodos: [...openTodos],
    implementationVerification: unverified?.implementationVerification ?? null,
    declaredPlanScope: unverified?.declaredPlanScope ?? null,
  };
}

const MAX_ITEMS_SHOWN = 8;

/** Visible footer for a failed completion check (appended, never replacing the answer). */
export function buildCompletionFooter(check: CompletionCheck): string {
  const lines: string[] = [];
  if (check.openItems.length) {
    const shown = check.openItems.slice(0, MAX_ITEMS_SHOWN).map((item) => `>   - ${item}`);
    if (check.openItems.length > MAX_ITEMS_SHOWN)
      shown.push(`>   - … ${check.openItems.length - MAX_ITEMS_SHOWN} more`);
    lines.push(`> Root goal "${check.rootGoal}" still has ${check.openItems.length} open item(s):`, ...shown);
  }
  if (check.openTodos.length) {
    const shown = check.openTodos.slice(0, MAX_ITEMS_SHOWN).map((item) => `>   - ${item}`);
    if (check.openTodos.length > MAX_ITEMS_SHOWN)
      shown.push(`>   - … ${check.openTodos.length - MAX_ITEMS_SHOWN} more`);
    lines.push(`> The todo list still has ${check.openTodos.length} unfinished item(s):`, ...shown);
  }
  if (check.implementationVerification)
    lines.push(
      `> FLOW plan "${check.declaredPlanScope ?? "(untitled PLAN.md)"}": implementation verification is ${check.implementationVerification}, not recorded_pass.`,
    );
  return `\n\n> ⚠ Host completion check: this answer says the task is done, but the host ledger disagrees.\n${lines.join("\n")}\n> Treat the task as NOT complete until these are closed.`;
}
