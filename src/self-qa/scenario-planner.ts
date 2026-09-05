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
 * Cold agent-mode boot is slow and highly variable — CLAUDE.md records 25-46s+
 * under CPU contention, and the emitted specs in `tests/harness/auto/` carry
 * 120s hook timeouts for exactly this reason. Measured here on 2026-09-05: one
 * spawn published no frame at all within 20s, while others mounted in ~2s.
 */
const MOUNT_TIMEOUT_MS = 60_000;
/** Time allowed for a surface to appear after its opening command. */
const OPEN_TIMEOUT_MS = 15_000;
/** Wall-clock ceiling per scenario; must exceed mount + open or it misfires. */
const SCENARIO_BUDGET_MS = 90_000;

/**
 * The FIRST step of every driven scenario.
 *
 * It replaces a `wait_for({idle:true})`, which was the root cause of every
 * non-smoke `inconclusive` measured on this repo. `wait_for({idle:true})`
 * captures `Date.now()` and requires a NEW idle strictly after that instant
 * (`packages/agent-harness-core/src/driver.ts:301-303`), but a TUI parked at
 * the prompt emits none: instrumented capture on 2026-09-05 counted exactly
 * ONE idle sentinel, at boot. So a leading idle wait blocks for its whole
 * timeout, every time, on a perfectly healthy TUI.
 *
 * Waiting for the composer is the mount guard the harness specs already use
 * (`tests/harness/modal-focus-sweep.spec.ts:105`), and it is what "the UI is
 * ready" actually means — `tests/harness/subagents-modal.spec.ts:30` warns
 * that idle can fire on the empty seq=0 frame BEFORE React mounts.
 */
const MOUNT_GUARD: ScenarioStep = { op: "wait_for", selector: "role=textbox", timeoutMs: MOUNT_TIMEOUT_MS };

/**
 * A `<Semantic id={`row-${i}`}>` is captured by SEMANTIC_RE as the LITERAL
 * source text `row-${i}`, because the planner reads source, not a running
 * render. No node ever carries that id, so `id=row-${i}` is a selector that
 * cannot match by construction.
 *
 * Measured on this repo: `src/ui/agents-modal.tsx:116` produced the scenario
 * `list-subagent-${row.agent.name}`, a guaranteed-permanent timeout. Worse,
 * such scenarios have already been PROMOTED to committed regression specs —
 * `tests/harness/auto/list-msg-${i}.spec.ts`,
 * `tests/harness/auto/list-council-msg-${idx}.spec.ts` and two more — whose
 * only assertion is a vacuous "no error toast", so they pass forever without
 * touching the surface they name.
 */
const INTERPOLATED_ID_RE = /\$\{|`/;

/**
 * How to bring a surface on screen.
 *
 * Provenance — every entry is copied from machinery that already proves it,
 * NOT invented here:
 *   - the ten slash-command modals are the CASES table of
 *     `tests/harness/modal-focus-sweep.spec.ts:68-97`, an active spec that
 *     opens each one and asserts on it;
 *   - `subagent-editor` adds `C-a`, the "new subagent" binding at
 *     `src/ui/use-app-logic.tsx:7291` (`key.name === "a" && key.ctrl` →
 *     `openSubagentEditor(null)`). `Enter` is NOT used: it needs
 *     `row?.kind === "agent"`, so it does nothing in a profile with no
 *     configured subagents.
 *
 * A surface absent from this table and not enclosed by one that is present is
 * reported as `skipped`, never driven — see `Scenario.reachable`.
 */
const SURFACE_OPENERS: Record<string, ScenarioStep[]> = {
  "model-picker": slashOpener("/model", "model-picker"),
  "session-picker": slashOpener("/resume", "session-picker"),
  "mcp-modal": slashOpener("/mcp", "mcp-modal"),
  "subagents-modal": slashOpener("/agents", "subagents-modal"),
  "schedule-modal": slashOpener("/schedule", "schedule-modal"),
  "connect-modal": slashOpener("/remote-control", "connect-modal"),
  "sandbox-picker": slashOpener("/sandbox", "sandbox-picker"),
  "wallet-picker": slashOpener("/wallet", "wallet-picker"),
  "ee-connect-card": slashOpener("/ee setup", "ee-connect-card"),
  "lsp-setup-card": slashOpener("/lsp setup", "lsp-setup-card"),
  "subagent-editor": [
    ...slashOpener("/agents", "subagents-modal"),
    { op: "press", key: "C-a" },
    { op: "wait_for", selector: "id=subagent-editor", timeoutMs: OPEN_TIMEOUT_MS },
  ],
};

/**
 * Surfaces that are on screen as soon as the TUI mounts, so the mount guard is
 * their whole opener. Taken from CLAUDE.md § "Add semantic instrumentation",
 * which lists these as permanently wired: `composer` (PromptBox textarea),
 * `status` (StatusBar) and `log` (messages scrollbox). Everything else in that
 * list is conditional (`slash-menu` needs a keystroke, `msg-{i}` needs a turn).
 */
const ALWAYS_PRESENT = new Set(["composer", "status", "log"]);

function slashOpener(command: string, rootId: string): ScenarioStep[] {
  return [
    { op: "type", text: command },
    { op: "press", key: "Enter" },
    { op: "wait_for", selector: `id=${rootId}`, timeoutMs: OPEN_TIMEOUT_MS },
  ];
}

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
  if (/\bisModal\b(?!\s*=)/.test(chunk)) out.isModal = true;
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
        steps: [{ op: "wait_for", idle: true, timeoutMs: MOUNT_TIMEOUT_MS }],
        expectations: [{ kind: "idleReached", withinMs: MOUNT_TIMEOUT_MS }, { kind: "noErrorToast" }],
        budgetMs: SCENARIO_BUDGET_MS,
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
    const scn = scenarioForHit(hit, allFiles, hits);
    if (scn) scenarios.push(scn);
    if (scenarios.length >= maxScenarios) break;
  }

  // Always include a baseline smoke check first.
  scenarios.unshift({
    id: "smoke-boot",
    description: "CLI boots and reaches idle within budget",
    derivedFrom: { files: allFiles, semanticIds: [] },
    steps: [{ op: "wait_for", idle: true, timeoutMs: MOUNT_TIMEOUT_MS }],
    expectations: [{ kind: "idleReached", withinMs: MOUNT_TIMEOUT_MS }, { kind: "noErrorToast" }],
    budgetMs: SCENARIO_BUDGET_MS,
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

/**
 * Decide how (or whether) a surface can be brought on screen.
 *
 * Containment is inferred by source order: the nearest PRECEDING `isModal`
 * hit in the same file. That is a heuristic — it reads line numbers, not the
 * JSX tree — but it fails in the safe direction: a wrong answer yields a skip
 * or a visibly failing scenario, never a false pass.
 */
function resolveOpener(
  hit: SemanticHit,
  allHits: SemanticHit[],
): { kind: "ready"; steps: ScenarioStep[] } | { kind: "unreachable"; reason: string } {
  const direct = SURFACE_OPENERS[hit.id];
  if (direct) return { kind: "ready", steps: direct };

  if (hit.isModal) {
    return { kind: "unreachable", reason: `no registered opener for modal '${hit.id}'` };
  }

  const enclosing = allHits.filter((h) => h.file === hit.file && h.isModal === true && h.line <= hit.line).pop();
  if (!enclosing) {
    // "Top-level in the source text" does NOT mean "on screen after mount".
    // Measured 2026-09-05: assuming it does made `council-phases` and
    // `council-status` (both top-level in `src/ui/app.tsx`, both rendered only
    // DURING a council debate) fail with "matched 0 nodes" — a red gate for
    // surfaces that were simply not supposed to be there yet. Reading source
    // cannot distinguish always-rendered from conditionally-rendered, so
    // coverage is DECLARED rather than assumed: anything not listed here and
    // not reachable through a registered opener is reported as skipped.
    if (ALWAYS_PRESENT.has(hit.id)) return { kind: "ready", steps: [] };
    return { kind: "unreachable", reason: `no registered opener for top-level surface '${hit.id}'` };
  }

  const viaParent = SURFACE_OPENERS[enclosing.id];
  if (viaParent) return { kind: "ready", steps: viaParent };
  return { kind: "unreachable", reason: `enclosing modal '${enclosing.id}' has no registered opener` };
}

function unreachable(id: string, description: string, derivedFrom: Scenario["derivedFrom"], reason: string): Scenario {
  return {
    id,
    description,
    derivedFrom,
    steps: [],
    expectations: [],
    budgetMs: 0,
    reachable: false,
    unreachableReason: reason,
  };
}

function scenarioForHit(hit: SemanticHit, allFiles: string[], allHits: SemanticHit[]): Scenario | null {
  const baseExpect: Expectation[] = [{ kind: "noErrorToast" }];
  const derivedFrom = { files: allFiles, semanticIds: [hit.id] };
  const prefix = scenarioPrefix(hit.role);
  if (!prefix) return null;
  const id = `${prefix}-${hit.id}`;

  if (INTERPOLATED_ID_RE.test(hit.id)) {
    return unreachable(
      id,
      `Surface '${hit.id}' is rendered with an interpolated id`,
      derivedFrom,
      `id '${hit.id}' is a template literal in source — no runtime node can ever carry it, so 'id=${hit.id}' cannot match`,
    );
  }

  const opener = resolveOpener(hit, allHits);
  if (opener.kind === "unreachable") {
    return unreachable(id, `Surface '${hit.id}' could not be reached`, derivedFrom, opener.reason);
  }

  // Every driven scenario has the same skeleton: mount, open the surface, wait
  // for it, then assert it is really there. `selectorPresent` on the final
  // frame is the assertion that carries the weight — it is what turns "the
  // wait expired" into a reported failure rather than a silent nothing.
  //
  // Deliberately NOT asserted: a typed value landing in the field. Measured
  // 2026-09-05 driving `/agents` → `C-a` → type: `subagent-editor-name.value`
  // stayed `""`, so the harness `type` op does not reach that field. Asserting
  // it would make this gate permanently red for a reason the gate cannot fix.
  const open: ScenarioStep[] = [MOUNT_GUARD, ...opener.steps];
  // The opener's final step may already wait for this very selector (a modal
  // root is its own opener target); waiting twice is harmless but noisy.
  const last = opener.steps[opener.steps.length - 1];
  const alreadySettled = last?.op === "wait_for" && last.selector === `id=${hit.id}`;
  const settle: ScenarioStep = { op: "wait_for", selector: `id=${hit.id}`, timeoutMs: OPEN_TIMEOUT_MS };
  /** The initial settle, omitted when the opener already waited for this id. */
  const settleOnce: ScenarioStep[] = alreadySettled ? [] : [settle];
  const present: Expectation = { kind: "selectorPresent", selector: `id=${hit.id}` };

  switch (hit.role) {
    case "textbox":
      return {
        id,
        description: `Reach textbox '${hit.id}' and confirm it renders`,
        derivedFrom,
        steps: [...open, ...settleOnce, { op: "type", text: "self-qa probe" }],
        expectations: [...baseExpect, present],
        budgetMs: SCENARIO_BUDGET_MS,
      };

    case "button":
      return {
        id,
        description: `Reach button '${hit.id}' and confirm it renders`,
        derivedFrom,
        steps: [...open, ...settleOnce],
        expectations: [...baseExpect, present],
        budgetMs: SCENARIO_BUDGET_MS,
      };

    case "dialog":
      return {
        id,
        description: `Open dialog '${hit.id}' and confirm it renders`,
        derivedFrom,
        steps: [...open, ...settleOnce],
        expectations: [...baseExpect, present],
        budgetMs: SCENARIO_BUDGET_MS,
      };

    case "menu":
      return {
        id,
        description: `Open menu '${hit.id}' and confirm it renders`,
        derivedFrom,
        steps: [...open, ...settleOnce],
        expectations: [...baseExpect, present],
        budgetMs: SCENARIO_BUDGET_MS,
      };

    case "listbox":
    case "listitem":
      return {
        id,
        description: `Navigate list '${hit.id}' and confirm it survives`,
        derivedFrom,
        // The list must still be on screen AFTER the key sequence: that is what
        // makes this more than the old "no error toast", which passed whether or
        // not the list existed.
        steps: [...open, ...settleOnce, { op: "press_sequence", keys: ["Down", "Down", "Up"] }, settle],
        expectations: [...baseExpect, present],
        budgetMs: SCENARIO_BUDGET_MS,
      };

    case "statusbar":
    case "log":
    case "region":
    case "toast":
      return {
        id,
        description: `Verify passive surface '${hit.id}' renders without error`,
        derivedFrom,
        steps: [...open, ...settleOnce],
        expectations: [...baseExpect, present],
        budgetMs: SCENARIO_BUDGET_MS,
      };

    default:
      return null;
  }
}

function scenarioPrefix(role: string): string | null {
  switch (role) {
    case "textbox":
      return "textbox";
    case "button":
      return "button";
    case "dialog":
      return "dialog";
    case "menu":
      return "menu";
    case "listbox":
    case "listitem":
      return "list";
    case "statusbar":
    case "log":
    case "region":
    case "toast":
      return "passive";
    default:
      return null;
  }
}
