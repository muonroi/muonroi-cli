import { existsSync, readFileSync } from "node:fs";
import { planningArtifact } from "./paths.js";
import { readState } from "./workflow-engine.js";

export interface GateContextInput {
  cwd: string;
  conversationDigest?: string | null;
  brainData?: unknown;
}

export interface GateContextBundle {
  conversationDigest: string;
  eeContext: string;
  priorPlan: string;
  projectHints: string;
  totalChars: number;
}

function cap(text: string, max: number): string {
  const t = (text ?? "").trim();
  if (t.length <= max) return t;
  const suffix = "…[truncated]";
  const keep = Math.max(0, max - suffix.length);
  return `${t.slice(0, keep)}${suffix}`;
}

/** Render EE recall (BrainData shape from layer1's pilContext fetch) into a compact block. */
function formatEeContext(brainData: unknown): string {
  if (!brainData || typeof brainData !== "object") return "";
  const b = brainData as Record<string, unknown>;
  const principles = Array.isArray(b.t0_principles) ? (b.t0_principles as unknown[]).map(String) : [];
  const patterns = Array.isArray(b.t2_patterns) ? (b.t2_patterns as unknown[]).map(String) : [];
  const rules = Array.isArray(b.t1_rules) ? (b.t1_rules as unknown[]).map(String) : [];
  const lines = [
    ...principles.slice(0, 3).map((p) => `- principle: ${p}`),
    ...rules.slice(0, 3).map((r) => `- rule: ${r}`),
    ...patterns.slice(0, 3).map((p) => `- pattern: ${p}`),
  ];
  return cap(lines.join("\n"), 600);
}

function readPriorPlan(cwd: string): string {
  const p = planningArtifact(cwd, "PLAN.md");
  if (!existsSync(p)) return "";
  let phase = "";
  try {
    phase = readState(cwd).phase ?? "";
  } catch (err) {
    console.error(`[pil-gate] readState for prior-plan phase failed: ${(err as Error).message}`);
  }
  const body = cap(readFileSync(p, "utf8"), 800);
  return phase ? `phase: ${phase}\n${body}` : body;
}

export function buildGateContextBundle(input: GateContextInput): GateContextBundle {
  const conversationDigest = cap(input.conversationDigest ?? "", 1200);
  let eeContext = "";
  try {
    eeContext = formatEeContext(input.brainData);
  } catch (err) {
    console.error(`[pil-gate] formatEeContext failed: ${(err as Error).message}`);
  }
  let priorPlan = "";
  try {
    priorPlan = readPriorPlan(input.cwd);
  } catch (err) {
    console.error(`[pil-gate] readPriorPlan failed: ${(err as Error).message}`);
  }
  // projectHints intentionally left "" in v1: the discovery ProjectContext scan is
  // directory-level only (REPO_DEEP_MAP §src/pil) and produces mislead-prone
  // substring matches. Hedged hints are the producer's job, not asserted here.
  const projectHints = "";
  const totalChars = conversationDigest.length + eeContext.length + priorPlan.length + projectHints.length;
  return { conversationDigest, eeContext, priorPlan, projectHints, totalChars };
}
