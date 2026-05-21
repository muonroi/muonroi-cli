/**
 * scenario-planner.ts — M1 of Self-QA.
 *
 * Reads `git diff` against a base ref + scans the source tree for
 * `<Semantic id="..." role="..." ...>` wrappers, then emits Scenario[]
 * describing how to drive the TUI to exercise the touched UI surface.
 *
 * Heuristic-based (no LLM call). Each scenario is tied to a small number
 * of semantic IDs so judge.ts can assert on exactly those.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Expectation, Scenario, ScenarioStep, SemanticHit } from "./types.js";

export type PlannerOptions = {
  /** Git ref to diff against. Default: HEAD~1. */
  baseRef?: string;
  /** Repo root. Default: process.cwd(). */
  cwd?: string;
  /** Cap scenarios produced. Default: 8. */
  maxScenarios?: number;
  /** Force include these files even if not in diff. */
  extraFiles?: string[];
  /** Override the diff list (for tests / dry-runs). */
  diffFilesOverride?: string[];
};

const SEMANTIC_RE = /<Semantic\s+([^>]*?)id\s*=\s*(?:"([^"]+)"|\{`([^`]+)`\}|\{['"]([^'"]+)['"]\})([^>]*)>/g;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|\{`([^`]+)`\}|\{(true|false)\})/g;

/**
 * Plan scenarios from a git diff window.
 */
export function planScenarios(opts: PlannerOptions = {}): Scenario[] {
  const cwd = opts.cwd ?? process.cwd();
  const baseRef = opts.baseRef ?? "HEAD~1";
  const maxScenarios = opts.maxScenarios ?? 8;

  const changedFiles = opts.diffFilesOverride ?? collectChangedFiles({ cwd, baseRef });

  const allFiles = [...new Set([...changedFiles, ...(opts.extraFiles ?? [])])];
  const tsxFiles = allFiles.filter((f) => f.endsWith(".tsx"));

  const hits: SemanticHit[] = [];
  for (const file of tsxFiles) {
    try {
      const src = readFileSync(resolve(cwd, file), "utf8");
      hits.push(...extractSemanticHits(src, file));
    } catch {
      // file deleted or unreadable — skip
    }
  }

  return buildScenariosFromHits(hits, allFiles, maxScenarios);
}

/**
 * Get the list of files touched by `git diff <baseRef>`.
 * Returns repo-relative POSIX-style paths.
 */
export function collectChangedFiles(args: { cwd: string; baseRef: string }): string[] {
  try {
    const out = execSync(`git diff --name-only ${args.baseRef} --`, {
      cwd: args.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Extract every `<Semantic id="..." role="..." ...>` occurrence from a source file.
 */
export function extractSemanticHits(src: string, file: string): SemanticHit[] {
  const hits: SemanticHit[] = [];
  // Reset lastIndex because we use the regex literal as stateful.
  const re = new RegExp(SEMANTIC_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const id = m[2] ?? m[3] ?? m[4];
    if (!id) continue;
    const attrChunk = `${m[1] ?? ""} ${m[5] ?? ""}`;
    const attrs = parseAttrs(attrChunk);
    const line = src.slice(0, m.index).split("\n").length;
    hits.push({
      id,
      role: typeof attrs.role === "string" ? attrs.role : "region",
      name: typeof attrs.name === "string" ? attrs.name : undefined,
      isModal: attrs.isModal === "true" || attrs.isModal === true,
      file,
      line,
    });
  }
  return hits;
}

function parseAttrs(chunk: string): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  const re = new RegExp(ATTR_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const key = m[1];
    if (!key) continue;
    const v = m[2] ?? m[3] ?? m[4];
    if (v === "true") out[key] = true;
    else if (v === "false") out[key] = false;
    else out[key] = v;
  }
  // `isModal` may appear without `={true}` in JSX (boolean shorthand). Detect.
  if (/\bisModal\b(?!\s*=)/.test(chunk)) out["isModal"] = true;
  return out;
}

function buildScenariosFromHits(hits: SemanticHit[], allFiles: string[], maxScenarios: number): Scenario[] {
  if (hits.length === 0) {
    // Smoke fallback: at minimum verify the CLI boots and reaches idle.
    return [
      {
        id: "smoke-boot",
        description: "CLI boots and reaches idle within budget",
        derivedFrom: { files: allFiles, semanticIds: [] },
        steps: [{ op: "wait_for", idle: true, timeoutMs: 15_000 }],
        expectations: [{ kind: "idleReached", withinMs: 15_000 }, { kind: "noErrorToast" }],
        budgetMs: 15_000,
      },
    ];
  }

  // Group by ID — sometimes a Semantic appears multiple times; prefer the most
  // specific (modal > dialog > textbox > rest).
  const byId = new Map<string, SemanticHit>();
  for (const h of hits) {
    const existing = byId.get(h.id);
    if (!existing || rolePriority(h.role) > rolePriority(existing.role)) {
      byId.set(h.id, h);
    }
  }

  const scenarios: Scenario[] = [];
  for (const hit of byId.values()) {
    const scn = scenarioForHit(hit, allFiles);
    if (scn) scenarios.push(scn);
    if (scenarios.length >= maxScenarios) break;
  }

  // Always include a baseline smoke check first.
  scenarios.unshift({
    id: "smoke-boot",
    description: "CLI boots and reaches idle within budget",
    derivedFrom: { files: allFiles, semanticIds: [] },
    steps: [{ op: "wait_for", idle: true, timeoutMs: 15_000 }],
    expectations: [{ kind: "idleReached", withinMs: 15_000 }, { kind: "noErrorToast" }],
    budgetMs: 15_000,
  });

  return scenarios.slice(0, maxScenarios);
}

function rolePriority(role: string): number {
  switch (role) {
    case "dialog":
      return 5;
    case "menu":
      return 4;
    case "textbox":
      return 3;
    case "listbox":
    case "listitem":
      return 2;
    case "button":
    case "checkbox":
      return 2;
    default:
      return 1;
  }
}

function scenarioForHit(hit: SemanticHit, allFiles: string[]): Scenario | null {
  const baseSteps: ScenarioStep[] = [{ op: "wait_for", idle: true, timeoutMs: 10_000 }];
  const baseExpect: Expectation[] = [{ kind: "noErrorToast" }];
  const derivedFrom = { files: allFiles, semanticIds: [hit.id] };

  switch (hit.role) {
    case "textbox":
      return {
        id: `textbox-${hit.id}`,
        description: `Type into textbox '${hit.id}' and verify value is recorded`,
        derivedFrom,
        steps: [
          ...baseSteps,
          { op: "focus", selector: `id=${hit.id}` },
          { op: "type", text: "self-qa probe" },
          { op: "wait_for", idle: true, timeoutMs: 3_000 },
        ],
        expectations: [
          ...baseExpect,
          { kind: "selectorPresent", selector: `id=${hit.id}` },
          { kind: "idleReached", withinMs: 5_000 },
        ],
        budgetMs: 20_000,
      };

    case "button":
      return {
        id: `button-${hit.id}`,
        description: `Activate button '${hit.id}' and confirm no error`,
        derivedFrom,
        steps: [
          ...baseSteps,
          { op: "focus", selector: `id=${hit.id}` },
          { op: "press", key: "Enter" },
          { op: "wait_for", idle: true, timeoutMs: 3_000 },
        ],
        expectations: [...baseExpect, { kind: "idleReached", withinMs: 5_000 }],
        budgetMs: 15_000,
      };

    case "dialog": {
      const isModalCard = hit.isModal === true || hit.id.includes("askcard") || hit.id.includes("modal");
      return {
        id: `dialog-${hit.id}`,
        description: `Open dialog '${hit.id}' and dismiss with Escape`,
        derivedFrom,
        steps: [
          ...baseSteps,
          { op: "wait_for", selector: `id=${hit.id}`, timeoutMs: 5_000 },
          ...(isModalCard ? [{ op: "press" as const, key: "Escape" }] : []),
          { op: "wait_for", idle: true, timeoutMs: 3_000 },
        ],
        expectations: [...baseExpect, { kind: "selectorPresent", selector: `id=${hit.id}` }],
        budgetMs: 15_000,
      };
    }

    case "menu":
      return {
        id: `menu-${hit.id}`,
        description: `Open menu '${hit.id}' and navigate first item`,
        derivedFrom,
        steps: [
          ...baseSteps,
          { op: "wait_for", selector: `id=${hit.id}`, timeoutMs: 3_000 },
          { op: "press_sequence", keys: ["Down", "Enter"] },
          { op: "wait_for", idle: true, timeoutMs: 3_000 },
        ],
        expectations: [...baseExpect, { kind: "idleReached", withinMs: 5_000 }],
        budgetMs: 12_000,
      };

    case "listbox":
    case "listitem":
      return {
        id: `list-${hit.id}`,
        description: `Navigate list around '${hit.id}'`,
        derivedFrom,
        steps: [
          ...baseSteps,
          { op: "press_sequence", keys: ["Down", "Down", "Up"] },
          { op: "wait_for", idle: true, timeoutMs: 3_000 },
        ],
        expectations: [...baseExpect],
        budgetMs: 10_000,
      };

    case "statusbar":
    case "log":
    case "region":
    case "toast":
      return {
        id: `passive-${hit.id}`,
        description: `Verify passive surface '${hit.id}' renders without error`,
        derivedFrom,
        steps: [...baseSteps, { op: "wait_for", selector: `id=${hit.id}`, timeoutMs: 5_000 }],
        expectations: [...baseExpect, { kind: "selectorPresent", selector: `id=${hit.id}` }],
        budgetMs: 8_000,
      };

    default:
      return null;
  }
}
