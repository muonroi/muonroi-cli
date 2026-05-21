/**
 * agentic-context.ts — Tier 2 of Self-QA.
 *
 * Compresses LiveFrame + event tail into a compact prompt block the outer
 * LLM can consume per turn. The whole point of Tier 2: outer LLM SEES what
 * the TUI returned after its last input and decides the next step.
 *
 * Token budget per turn ≈ 2–4 KB (≈ 600–1200 tokens) by default. This keeps
 * a 20-turn agentic loop under ~25K tokens of context churn — affordable
 * with DeepSeek/SiliconFlow Flash tier.
 */

import type { LiveEvent, LiveFrame, UINode } from "@muonroi/agent-harness-core/protocol";
import { encodeDelta } from "./delta-encoder.js";

export type AgenticContextOptions = {
  /** Cap on event tail items included (most recent first). Default 12. */
  maxEvents?: number;
  /** Cap on chars of the rendered prompt block. Default 4_000. */
  maxChars?: number;
  /** Include the raw subtree for these node ids verbatim (always shown). */
  pinIds?: string[];
};

export type AgenticContextBlock = {
  /** Markdown-formatted block for the outer LLM. */
  prompt: string;
  /** Estimated token count (~chars / 4). */
  estimatedTokens: number;
  /** True if compression had to drop content to stay within budget. */
  truncated: boolean;
};

export function buildAgenticContext(
  prev: LiveFrame | null,
  next: LiveFrame | null,
  eventTail: LiveEvent[],
  opts: AgenticContextOptions = {},
): AgenticContextBlock {
  const maxEvents = opts.maxEvents ?? 12;
  const maxChars = opts.maxChars ?? 4_000;
  const pinIds = new Set(opts.pinIds ?? []);

  const parts: string[] = [];

  // ── 1. Frame summary ────────────────────────────────────────────────────
  if (next) {
    parts.push("### Current UI state");
    parts.push(renderFrameSummary(next, pinIds));
    if (prev) {
      const delta = encodeDelta(prev, next);
      const deltaLines: string[] = [];
      if (delta.added.length > 0) {
        deltaLines.push(`+ added: ${delta.added.map((n) => idAndRole(n)).join(", ")}`);
      }
      if (delta.removed.length > 0) {
        deltaLines.push(`- removed: ${delta.removed.join(", ")}`);
      }
      if (delta.changed.length > 0) {
        deltaLines.push(
          `~ changed: ${delta.changed.map((c) => `${c.id}{${Object.keys(c.fields).join(",")}}`).join(", ")}`,
        );
      }
      if (delta.focusChanged) {
        deltaLines.push(`focus: ${delta.focusChanged.from ?? "∅"} → ${delta.focusChanged.to ?? "∅"}`);
      }
      if (delta.modalsChanged) {
        deltaLines.push(`modals: [${delta.modalsChanged.from.join(",")}] → [${delta.modalsChanged.to.join(",")}]`);
      }
      if (deltaLines.length > 0) {
        parts.push("\n### Changed since last turn");
        parts.push(deltaLines.join("\n"));
      }
    }
  } else {
    parts.push("### Current UI state\n(no frame captured yet)");
  }

  // ── 2. Pinned subtrees (e.g. askcard) ──────────────────────────────────
  if (next && pinIds.size > 0) {
    const pinnedDumps: string[] = [];
    for (const id of pinIds) {
      const node = findNode(next.nodes, id);
      if (node) pinnedDumps.push(renderNodeSubtree(node));
    }
    if (pinnedDumps.length > 0) {
      parts.push("\n### Pinned nodes");
      parts.push(pinnedDumps.join("\n\n"));
    }
  }

  // ── 3. Event tail ──────────────────────────────────────────────────────
  if (eventTail.length > 0) {
    parts.push("\n### Recent events (newest first)");
    const tail = eventTail.slice(-maxEvents).reverse();
    parts.push(tail.map(renderEvent).join("\n"));
  }

  // ── 4. Cap to budget ────────────────────────────────────────────────────
  const full = parts.join("\n");
  let truncated = false;
  let prompt = full;
  if (full.length > maxChars) {
    prompt = `${full.slice(0, maxChars - 100)}\n\n[…truncated ${full.length - maxChars + 100} chars]`;
    truncated = true;
  }

  return {
    prompt,
    estimatedTokens: Math.ceil(prompt.length / 4),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderFrameSummary(frame: LiveFrame, pinIds: Set<string>): string {
  const lines: string[] = [];
  lines.push(`seq=${frame.seq} focus=${frame.focus ?? "∅"} modals=[${(frame.modals ?? []).join(",")}]`);
  lines.push("nodes:");
  const visit = (node: UINode, depth: number): void => {
    if (depth > 4) return; // cap tree depth shown
    if (node.hidden) return;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${idAndRole(node)}${attrSummary(node)}`);
    if (!pinIds.has(node.id) && node.children) {
      for (const c of node.children) visit(c, depth + 1);
    }
  };
  for (const n of frame.nodes) visit(n, 0);
  return lines.join("\n");
}

function renderNodeSubtree(node: UINode): string {
  const out: string[] = [];
  const visit = (n: UINode, depth: number): void => {
    if (depth > 6) return;
    const indent = "  ".repeat(depth);
    out.push(`${indent}- ${idAndRole(n)}${attrSummary(n)}`);
    if (n.children) for (const c of n.children) visit(c, depth + 1);
  };
  visit(node, 0);
  return out.join("\n");
}

function idAndRole(n: UINode): string {
  return `[${n.role}] id=${n.id}${n.name ? ` name=${JSON.stringify(n.name)}` : ""}`;
}

function attrSummary(n: UINode): string {
  const flags: string[] = [];
  if (n.focus) flags.push("focus");
  if (n.selected) flags.push("selected");
  if (n.disabled) flags.push("disabled");
  if (n.isModal) flags.push("modal");
  if (n.state) flags.push(`state=${n.state}`);
  if (n.value !== undefined) flags.push(`value=${JSON.stringify(n.value).slice(0, 60)}`);
  return flags.length > 0 ? ` <${flags.join(" ")}>` : "";
}

function renderEvent(e: LiveEvent): string {
  if (e.t !== "event") return `· ${JSON.stringify(e)}`;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous event union
  const ev = e as any;
  switch (ev.kind) {
    case "toast":
      return `· toast(${ev.level}): ${truncate(ev.text, 80)}`;
    case "askcard-open":
      return `· askcard-open: q="${truncate(ev.question, 80)}" options=${ev.optionCount}`;
    case "askcard-answered":
      return `· askcard-answered: kind=${ev.answerKind} text=${truncate(ev.answerText ?? "", 50)}`;
    case "askcard-cancel":
      return `· askcard-cancel: q=${ev.questionId}`;
    case "route-decision":
      return `· route-decision: ${ev.path} complexity=${ev.complexity}`;
    case "council-step":
      return `· council-step: ${ev.phaseKind} → ${ev.state}`;
    case "sprint-halt":
      return `· sprint-halt: reason=${ev.reason}`;
    case "sprint-stage":
      return `· sprint-stage: #${ev.sprintIndex} ${ev.stage}`;
    case "llm-done":
      return `· llm-done: chars=${ev.totalChars} reason=${ev.finishReason}`;
    case "ee-timeout":
      return `· ee-timeout: ${ev.source} (${ev.elapsedMs}ms)`;
    case "ee-error":
      return `· ee-error: ${ev.source} ${ev.name}`;
    case "disconnect":
      return `· disconnect: ${ev.reason}`;
    default:
      return `· ${ev.kind}`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function findNode(nodes: UINode[], id: string): UINode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}
