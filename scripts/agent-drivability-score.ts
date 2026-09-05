#!/usr/bin/env bun
/**
 * scripts/agent-drivability-score.ts — the Agent-Drivability referee (P1-1).
 *
 * Scores axes A1..A6 of the scorecard in
 * `docs/agent-first/SELF-IMPROVEMENT-PLAN.md` §1.1 from artifacts, and emits
 * JSON (`--json`) plus a readable summary.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS WRITTEN THE WAY IT IS
 * ---------------------------------------------------------------------------
 *
 * §2.2 of the plan says the referee is written by a human precisely because it
 * adjudicates everything else. This file was written by an agent — a weakening
 * the operator accepted for Phase 1. Three properties compensate, and every one
 * of them is checkable by feeding the scorer a known-bad state:
 *
 * 1. **No axis silently emits a number that looks measured.** Every axis
 *    reports `measured`, `measuredBy` (which artifact produced the number),
 *    `confidence`, and — where the axis as written in §1.1 is NOT mechanically
 *    computable — `axisAsStated.mechanical:false` with the reason, plus a
 *    non-null `humanMustJudge` naming what a person still has to decide.
 *    `meetsTarget` is a THREE-valued field: `true`, `false`, or `null` for
 *    "not knowable from the artifacts supplied". A missing artifact never
 *    reads as a pass.
 *
 * 2. **Every axis ships a negative control** (§2.6). {@link NEGATIVE_CONTROLS}
 *    holds, per axis, a deliberately-broken mutation of {@link HEALTHY_FIXTURE}
 *    that the scorer is REQUIRED to fail on. `--self-test` runs all six and
 *    exits non-zero if any known-bad input still scores a pass. An axis whose
 *    score cannot detect a known-bad change is not measuring anything, and this
 *    is the only thing standing between an agent-written referee and a rubber
 *    stamp. The same table is asserted from
 *    `scripts/__tests__/agent-drivability-score.test.ts`.
 *
 * 3. **It cannot go easy on itself.** The referee has ZERO imports from
 *    `src/` or `packages/` (§2.2 names both harness packages as part of the
 *    measurement instrument). Everything it compares against — tool names,
 *    event kinds, the role vocabulary, the selector grammar — is read out of
 *    the LIVE `tui.capabilities` payload and the LIVE `tools/list` response at
 *    measurement time. There is no second copy of the protocol in here that a
 *    sprint could edit to make its own change score well, and no constant this
 *    file could quietly relax.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT MECHANICAL
 * ---------------------------------------------------------------------------
 *
 * | axis | as stated in §1.1 | as scored here |
 * |------|-------------------|----------------|
 * | A1   | NOT mechanical — "0 blind states" is unreachable in principle: you can demonstrate `>= n` blind states, never `= 0`, and the repo has no state enumeration to count against | bounded POSITIVE proxy over the fixed corpus: fraction of corpus steps whose named discriminating field is carryable by the protocol and observed |
 * | A2   | mechanical | terminal-event coverage + silence invariant over a real harness event JSONL |
 * | A3   | mechanical | orphan count across N real start/stop cycles (`process.kill(pid,0)`), plus an Escape probe artifact |
 * | A4   | NOT mechanical — "flows that REQUIRE render_text" is not observable; no referee can tell "needed the scrape" from "used the scrape" | bounded POSITIVE proxy: fraction of corpus decision points whose decision field is reachable through a structured tool (never a scrape tool) |
 * | A5   | mechanical | `check-harness-skips.ts --strict` exit code + scalars, with the `retry: 2` caveat recorded |
 * | A6   | mechanical | `capabilities.tools` must equal `tools/list` EXACTLY, and every field any corpus step references must appear in the payload |
 *
 * A1 and A4 are therefore scored, but their `axisAsStated.mechanical` is
 * `false` and their `humanMustJudge` is never null: **whether the corpus
 * denominator covers the states that matter is a human call.** The proxy is
 * gameable by omission — a corpus that only contains steps which already pass
 * scores 100% and measures nothing — and no code in this file can detect that.
 * That is why `GRADUATION-SCENARIOS.md` may only ever grow, carries at least
 * one step marked `knownFailing`, and why a `knownFailing` step counts as
 * NOT-observed here even before any replay exists.
 *
 * ---------------------------------------------------------------------------
 * TWO-ROW ATTRIBUTION
 * ---------------------------------------------------------------------------
 *
 * Output carries `attribution.prePhase0` (frozen constants transcribed from
 * §1.1's Baseline column, dated 2026-09-04, before Phase 0 touched anything)
 * next to `attribution.postPhase0` (measured by this run), so a later sprint
 * cannot inherit credit for the human's Phase-0 work.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *   bun scripts/agent-drivability-score.ts                  # static: corpus + A5 lint
 *   bun scripts/agent-drivability-score.ts --json
 *   bun scripts/agent-drivability-score.ts --live           # + MCP handshake (A6, A1/A4 nameability)
 *   bun scripts/agent-drivability-score.ts --live --cycles 10   # + A3 orphan count
 *   bun scripts/agent-drivability-score.ts --event-log <path>   # + A2
 *   bun scripts/agent-drivability-score.ts --replay <path>      # upgrade A1/A4 to replayed
 *   bun scripts/agent-drivability-score.ts --escape-log <path>  # + A3 Escape sub-metric
 *   bun scripts/agent-drivability-score.ts --self-test          # prove the negative controls fire
 *
 * Exit codes: 0 = ran (see `meetsTarget` per axis for the verdict);
 *             1 = `--gate` was passed and a baselined axis is `false`;
 *             2 = the scorer itself could not run (bad args, unreadable corpus);
 *             3 = `--self-test` found a negative control the scorer did not fail on.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_CORPUS = resolve(REPO_ROOT, "docs/agent-first/GRADUATION-SCENARIOS.md");
const HARNESS_CONFIG = resolve(REPO_ROOT, "vitest.harness.config.ts");
const SKIP_LINTER = resolve(REPO_ROOT, "scripts/check-harness-skips.ts");

const MODULE = "agent-drivability-score";

// ===========================================================================
// Types
// ===========================================================================

export type AxisId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6";
export type Confidence = "high" | "medium" | "low" | "none";

/** How a step's field is reached and named. Mirrors nothing in `src/` on purpose. */
export type FieldRef =
  | { kind: "node"; selector: string; field: string; via: string }
  | { kind: "event"; eventKind: string; field: string; via: string }
  | { kind: "tool-result"; tool: string; field: string; via: string }
  | { kind: "capability"; field: string; via: string };

export interface CorpusStep {
  /** e.g. "S1.3" — stable across corpus growth. */
  id: string;
  /** Human sentence describing the driver action. */
  action: string;
  /** The MCP tool the driver calls for this step. */
  via: string;
  /** The field that tells the driver THIS STEP SUCCEEDED. Scores A1. */
  discriminatingField: FieldRef;
  /** The field the driver reads to choose its NEXT action. Scores A4. */
  decisionField: FieldRef;
  /** Marked when the step is known to fail today. Counts as NOT observed. */
  knownFailing?: boolean;
  /** Verbatim evidence for `knownFailing`. Required when it is set. */
  knownFailingEvidence?: string;
}

export interface CorpusScenario {
  id: string;
  title: string;
  steps: CorpusStep[];
}

export interface CorpusParseResult {
  path: string;
  ok: boolean;
  scenarios: CorpusScenario[];
  steps: CorpusStep[];
  errors: string[];
}

/** The shape of `tui.capabilities` this referee depends on. Structural, not imported. */
export interface CapabilitiesLike {
  protocol?: string;
  tools?: string[];
  toolsSource?: string;
  eventKinds?: string[];
  roles?: string[];
  customRolePrefix?: string;
  selector?: { fields?: string[]; flags?: string[]; propsPrefix?: string; ops?: string[] };
  [k: string]: unknown;
}

/** One teed harness event line (`{ts, kind, event}` JSONL). */
export interface TeedLine {
  ts: number;
  kind: string;
  event: Record<string, unknown>;
  visualText?: string;
}

export interface SkipLintResult {
  /** Exit code of `check-harness-skips.ts --strict`. */
  strictExit: number;
  totalSpecFiles: number | null;
  skipCount: number | null;
  todoCount: number | null;
  unallowlisted: number | null;
  guards: number | null;
  ran: boolean;
  error?: string;
}

export interface LifecycleResult {
  cycles: number;
  /** pids that were still alive `graceMs` after `tui.stop` returned. */
  orphanPids: number[];
  /** cycles where `tui.start` itself failed — not orphans, but not evidence either. */
  failedStarts: number;
  graceMs: number;
}

/** Artifact for the A3 Escape sub-metric: events captured around an Escape press. */
export interface EscapeProbe {
  /** Epoch ms at which Escape was pressed during a live, in-flight turn. */
  escapePressedAt: number;
  events: TeedLine[];
  /** Window the plan requires a reaction within. Default 5000. */
  windowMs?: number;
}

/** Artifact for upgrading A1/A4 from declared to replayed. */
export interface ReplayResult {
  /** Corpus step id → whether the named field was actually present in structured output. */
  observed: Record<string, { discriminating: boolean; decision: boolean; note?: string }>;
  corpusPath?: string;
  runBy?: string;
  model?: string;
}

export interface ScoreInputs {
  corpus: CorpusParseResult;
  capabilities: CapabilitiesLike | null;
  toolsList: string[] | null;
  eventLog: TeedLine[] | null;
  eventLogPath: string | null;
  skipLint: SkipLintResult | null;
  harnessRetry: number | null;
  lifecycle: LifecycleResult | null;
  escape: EscapeProbe | null;
  replay: ReplayResult | null;
  /** Silence budget for A2's "no turn goes quiet" invariant. */
  maxSilenceMs: number;
}

export interface AxisResult {
  axis: AxisId;
  name: string;
  /** Did THIS RUN produce its number mechanically (no human judgement in the loop)? */
  mechanical: boolean;
  /** Is the axis AS WRITTEN in §1.1 mechanically computable at all? */
  axisAsStated: { mechanical: boolean; why: string };
  /** Did this invocation have the artifacts it needs? */
  measured: boolean;
  /** Which artifact produced the number. Never omitted when `measured`. */
  measuredBy: string;
  score: number | null;
  unit: string;
  target: string;
  /** true / false / null = "not knowable from the artifacts supplied". */
  meetsTarget: boolean | null;
  confidence: Confidence;
  /** Non-null iff a human still has to judge something for this axis to mean anything. */
  humanMustJudge: string | null;
  detail: Record<string, unknown>;
  notes: string[];
}

export interface Scorecard {
  generatedAt: string;
  referee: string;
  corpusPath: string;
  axes: Record<AxisId, AxisResult>;
  attribution: {
    prePhase0: Record<AxisId, { score: number | null; unit: string; meetsTarget: boolean | null; source: string }>;
    postPhase0: Record<AxisId, { score: number | null; unit: string; meetsTarget: boolean | null; measuredBy: string }>;
  };
  summary: {
    meets: AxisId[];
    fails: AxisId[];
    unknown: AxisId[];
    mechanicalAsStated: AxisId[];
    needsHumanJudgement: AxisId[];
  };
}

// ===========================================================================
// Frozen pre-Phase-0 baseline (§1.1 Baseline column, measured 2026-09-04)
//
// These are CONSTANTS, transcribed verbatim from the committed plan before
// Phase 0 changed a line. They exist so a later sprint cannot present the
// human's Phase-0 work as its own delta. Editing them is editing the referee
// (§2.2) — a sprint that does so is rejected by definition.
// ===========================================================================

export const PRE_PHASE0_BASELINE: Record<
  AxisId,
  { score: number | null; unit: string; meetsTarget: boolean | null; source: string }
> = {
  A1: {
    score: null,
    unit: "fraction of corpus steps",
    meetsTarget: null,
    source: "§1.1 — not baselined: the scenario corpus did not exist (P1-3)",
  },
  A2: {
    score: null,
    unit: "fraction of turns with a substantive terminal event",
    meetsTarget: false,
    source: "§1.1 — 'not enforced': no spec asserted the invariant, so no turn was checked",
  },
  A3: {
    score: 8,
    unit: "orphaned child processes",
    meetsTarget: false,
    source:
      "§1.1 — 8/8 TUIs survived tui.stop in one session; Escape never reached the abort path (use-app-logic.tsx:3847)",
  },
  A4: {
    score: null,
    unit: "fraction of corpus decision points",
    meetsTarget: null,
    source: "§1.1 — not baselined: the scenario corpus did not exist (P1-3)",
  },
  A5: {
    score: 1,
    unit: "unallowlisted skip/todo sites",
    meetsTarget: false,
    source: "§1.1 — 1 unallowlisted (tests/harness/gsd-pil-gate.spec.ts:389); lint:harness-skips:strict exited 1",
  },
  A6: {
    score: 14 / 21,
    unit: "fraction of registered tools advertised in the capabilities payload",
    meetsTarget: false,
    source:
      "§1.1 — 14 advertised FEATURES strings vs 21 registered tools; 0 selector/role/event-kind/semantic-id information",
  },
};

// ===========================================================================
// Corpus parsing
//
// The corpus is a markdown document for humans with one fenced ```json block
// per scenario carrying the machine-readable steps. The fenced block is
// AUTHORITATIVE: prose that disagrees with it is a doc bug, not a score.
// ===========================================================================

const FENCE_RE = /```json\s+([\s\S]*?)```/g;

const VALID_FIELD_KINDS = new Set(["node", "event", "tool-result", "capability"]);

export function parseCorpus(path: string): CorpusParseResult {
  const out: CorpusParseResult = { path, ok: false, scenarios: [], steps: [], errors: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[${MODULE}] corpus read failed (${path}): ${message}`);
    out.errors.push(`corpus unreadable: ${message}`);
    return out;
  }
  return parseCorpusText(raw, path);
}

/** Split out so tests and negative controls can feed corpus text directly. */
export function parseCorpusText(raw: string, path = "<inline>"): CorpusParseResult {
  const out: CorpusParseResult = { path, ok: false, scenarios: [], steps: [], errors: [] };
  const seenStepIds = new Set<string>();
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = FENCE_RE.exec(raw);
  while (m !== null) {
    const body = m[1] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      console.error(`[${MODULE}] corpus JSON block parse failed: ${message}`);
      out.errors.push(`unparseable json block: ${message}`);
      m = FENCE_RE.exec(raw);
      continue;
    }
    const rec = parsed as Partial<CorpusScenario>;
    if (typeof rec?.id !== "string" || !Array.isArray(rec.steps)) {
      // Not a scenario block (the doc may carry other json examples) — skip it
      // silently rather than counting a doc illustration as a broken scenario.
      m = FENCE_RE.exec(raw);
      continue;
    }
    const scenario: CorpusScenario = {
      id: rec.id,
      title: typeof rec.title === "string" ? rec.title : rec.id,
      steps: [],
    };
    for (const s of rec.steps as CorpusStep[]) {
      const problems = validateStep(s, scenario.id);
      if (problems.length > 0) {
        out.errors.push(...problems);
        continue;
      }
      if (seenStepIds.has(s.id)) {
        out.errors.push(`duplicate step id ${s.id}`);
        continue;
      }
      seenStepIds.add(s.id);
      scenario.steps.push(s);
      out.steps.push(s);
    }
    out.scenarios.push(scenario);
    m = FENCE_RE.exec(raw);
  }
  if (out.scenarios.length === 0) out.errors.push("corpus contains no scenario blocks");
  out.ok = out.errors.length === 0 && out.steps.length > 0;
  return out;
}

function validateStep(s: CorpusStep, scenarioId: string): string[] {
  const problems: string[] = [];
  const where = `${scenarioId}/${s?.id ?? "<no id>"}`;
  if (typeof s?.id !== "string" || s.id.length === 0) problems.push(`${where}: missing step id`);
  if (typeof s?.action !== "string") problems.push(`${where}: missing action`);
  if (typeof s?.via !== "string") problems.push(`${where}: missing via`);
  for (const key of ["discriminatingField", "decisionField"] as const) {
    const f = s?.[key] as FieldRef | undefined;
    if (!f || typeof f !== "object") {
      problems.push(`${where}: missing ${key}`);
      continue;
    }
    if (!VALID_FIELD_KINDS.has(f.kind)) problems.push(`${where}: ${key}.kind '${String(f.kind)}' is not a field kind`);
    if (typeof f.field !== "string" || f.field.length === 0) problems.push(`${where}: ${key}.field must be a name`);
    if (typeof f.via !== "string" || f.via.length === 0) problems.push(`${where}: ${key}.via must name a tool`);
  }
  if (s?.knownFailing === true && typeof s.knownFailingEvidence !== "string") {
    problems.push(`${where}: knownFailing requires knownFailingEvidence (verbatim observation)`);
  }
  return problems;
}

// ===========================================================================
// Nameability — can the protocol, as the LIVE payload describes it, carry
// the field this step names? Everything below is derived from the payload:
// no constant in this file encodes a role, an event kind or a selector field.
// ===========================================================================

/**
 * Tools that hand the driver a rendered picture of the screen rather than a
 * named field. A decision that can only be made through one of these is
 * scrape-dependent — that is A4's whole subject. Identified structurally
 * (render/visual/cell/quality), not from a hand-list that could drift as
 * tools are added.
 */
export function isScrapeTool(tool: string): boolean {
  const short = tool.startsWith("tui.") ? tool.slice(4) : tool;
  return /^(render_|snapshot_visual$|cell$|visual_quality$)/.test(short);
}

export interface NameabilityVerdict {
  nameable: boolean;
  reason: string;
}

export function isNameable(ref: FieldRef, cap: CapabilitiesLike | null): NameabilityVerdict {
  if (!cap) return { nameable: false, reason: "no capabilities payload supplied — nameability unknowable" };
  const tools = new Set(cap.tools ?? []);
  if (tools.size === 0) return { nameable: false, reason: "capabilities payload advertises no tools" };
  if (!tools.has(ref.via)) return { nameable: false, reason: `via '${ref.via}' is not an advertised tool` };

  switch (ref.kind) {
    case "node": {
      const fields = new Set(cap.selector?.fields ?? []);
      const flags = new Set(cap.selector?.flags ?? []);
      const propsPrefix = cap.selector?.propsPrefix ?? "props.";
      const ok = fields.has(ref.field) || flags.has(ref.field) || ref.field.startsWith(propsPrefix);
      if (!ok) {
        return {
          nameable: false,
          reason: `node field '${ref.field}' is neither a selector field (${[...fields].join("|")}), a flag (${[...flags].join("|")}), nor ${propsPrefix}*`,
        };
      }
      const roleTerm = /(?:^|\s)role=([A-Za-z0-9_-]+)/.exec(ref.selector ?? "");
      if (roleTerm) {
        const role = roleTerm[1] ?? "";
        const roles = new Set(cap.roles ?? []);
        const prefix = cap.customRolePrefix ?? "x-";
        if (!roles.has(role) && !role.startsWith(prefix)) {
          return {
            nameable: false,
            reason: `selector names role '${role}', which the payload's role vocabulary does not contain`,
          };
        }
      }
      return { nameable: true, reason: "selector field is in the advertised grammar" };
    }
    case "event": {
      const kinds = new Set(cap.eventKinds ?? []);
      if (!kinds.has(ref.eventKind)) {
        return { nameable: false, reason: `event kind '${ref.eventKind}' is not in the advertised eventKinds` };
      }
      return { nameable: true, reason: "event kind is advertised" };
    }
    case "tool-result": {
      if (!tools.has(ref.tool)) return { nameable: false, reason: `tool '${ref.tool}' is not advertised` };
      return { nameable: true, reason: "tool is advertised" };
    }
    case "capability": {
      if (!(ref.field in cap)) return { nameable: false, reason: `capabilities payload has no '${ref.field}' key` };
      return { nameable: true, reason: "field present in the capabilities payload" };
    }
    default:
      return { nameable: false, reason: "unknown field kind" };
  }
}

// ===========================================================================
// A1 — Named-state coverage (bounded positive proxy)
// ===========================================================================

export function scoreA1(inputs: ScoreInputs): AxisResult {
  const steps = inputs.corpus.steps;
  const axisAsStated = {
    mechanical: false,
    why:
      "A1 as written ('0 blind states') is unreachable in principle: a blind state can be demonstrated (>= n) " +
      "but never counted to zero over an unbounded state space, and this repo has no state enumeration to count " +
      "against. Scored here as the bounded positive proxy §1.1 defines: named discriminating field per corpus step.",
  };
  const humanMustJudge =
    "Whether the corpus denominator covers the states that matter. The proxy is gameable by OMISSION — a corpus " +
    "of only-passing steps scores 100% and measures nothing — and no code here can detect that. Read " +
    "GRADUATION-SCENARIOS.md and decide whether the steps are the ones a real driver hits.";

  const base: AxisResult = {
    axis: "A1",
    name: "Named-state coverage",
    mechanical: true,
    axisAsStated,
    measured: false,
    measuredBy: "none",
    score: null,
    unit: "fraction of corpus steps whose discriminating field is named and observed",
    target: "1.0 over the fixed corpus",
    meetsTarget: null,
    confidence: "none",
    humanMustJudge,
    detail: {},
    notes: [],
  };

  if (!inputs.corpus.ok || steps.length === 0) {
    base.notes.push(`corpus unusable: ${inputs.corpus.errors.join("; ") || "no steps"}`);
    base.meetsTarget = false;
    base.detail = { corpusErrors: inputs.corpus.errors };
    return base;
  }

  if (!inputs.capabilities && !inputs.replay) {
    // Without the live payload, nameability is unknowable — every step would
    // read as "not nameable" and the axis would emit a confident 0 that is an
    // artefact of the missing artifact, not a finding. Report unmeasured.
    base.notes.push(
      "no live capabilities payload (--live) and no replay: nameability is unknowable, so no number is emitted. " +
        "A missing artifact is not a score of 0 and is not a pass.",
    );
    return base;
  }

  const perStep = steps.map((s) => {
    const verdict = isNameable(s.discriminatingField, inputs.capabilities);
    const replayed = inputs.replay?.observed?.[s.id];
    const observed = replayed ? replayed.discriminating : verdict.nameable && s.knownFailing !== true;
    return {
      id: s.id,
      nameable: verdict.nameable,
      reason: verdict.reason,
      knownFailing: s.knownFailing === true,
      observed,
      source: replayed ? "replay" : "corpus-declaration",
    };
  });

  const nameable = perStep.filter((p) => p.nameable).length;
  const observed = perStep.filter((p) => p.observed).length;
  const usedReplay = perStep.some((p) => p.source === "replay");

  base.measured = true;
  base.measuredBy = usedReplay ? "replay transcript + corpus" : "corpus declaration + live capabilities";
  base.score = observed / perStep.length;
  base.confidence = usedReplay ? "high" : inputs.capabilities ? "low" : "none";
  base.detail = {
    steps: perStep.length,
    nameable,
    nameableRate: nameable / perStep.length,
    observed,
    knownFailing: perStep.filter((p) => p.knownFailing).map((p) => p.id),
    notNameable: perStep.filter((p) => !p.nameable).map((p) => ({ id: p.id, reason: p.reason })),
  };

  if (base.score < 1) {
    // A score below 1 is a DEFINITE fail even when only declared: a step whose
    // field the protocol cannot carry, or that is known to fail today, is a
    // blind state whether or not anyone replayed it.
    base.meetsTarget = false;
  } else if (usedReplay) {
    base.meetsTarget = true;
  } else {
    base.meetsTarget = null;
    base.notes.push(
      "score is DECLARED, not replayed: every step names a field the protocol can carry, but no run has demonstrated " +
        "the field actually appears. Pass --replay <path> to upgrade. meetsTarget stays null on purpose.",
    );
  }
  if (!inputs.capabilities) {
    base.notes.push(
      "no live capabilities payload: nameability could not be checked against the real protocol (--live).",
    );
  }
  if (inputs.harnessRetry === null) base.notes.push("harness retry setting unread");
  return base;
}

// ===========================================================================
// A2 — Terminal-state coverage
// ===========================================================================

/**
 * Kinds that end a turn, per §1.1. `askcard-open` and `askcard-answered` are
 * BOTH terminal-ish on purpose — §1.1 is explicit that "exactly one terminal
 * event" is falsified by normal operation and that an implementer told to
 * satisfy it will suppress events.
 */
export const TERMINAL_KINDS: readonly string[] = [
  "llm-done",
  "sprint-halt",
  "askcard-open",
  "askcard-answered",
  "askcard-cancel",
  "toast",
];

/** Kinds that open a turn. A turn also opens at the first event in the log. */
export const TURN_OPENING_KINDS: readonly string[] = ["route-decision", "sprint-stage", "council-step"];

/**
 * A terminal event only counts when it CARRIES something. §2.6's stated attack
 * on A2 is "emit a synthetic terminal event unconditionally from a wrapper" —
 * a content-free stub would turn the axis green while leaving the wedge exactly
 * as invisible. A stub carries no field beyond its own routing keys.
 */
export function isSubstantiveTerminal(line: TeedLine): boolean {
  if (!TERMINAL_KINDS.includes(line.kind)) return false;
  const ev = line.event ?? {};
  const ROUTING_KEYS = new Set(["t", "kind"]);
  const payloadKeys = Object.keys(ev).filter((k) => !ROUTING_KEYS.has(k));
  const meaningful = payloadKeys.filter((k) => {
    const v = (ev as Record<string, unknown>)[k];
    return v !== null && v !== undefined && v !== "";
  });
  if (meaningful.length === 0) return false;
  // A toast that does not say what KIND of thing happened cannot discharge
  // "the turn announced its outcome" — it is decoration, not accountability.
  if (line.kind === "toast" && !("level" in ev)) return false;
  return true;
}

export interface TurnWindow {
  startTs: number;
  endTs: number;
  openedBy: string;
  terminal: string | null;
  substantive: boolean;
  /** Longest UNEXPLAINED quiet stretch inside the turn. Scores the invariant. */
  maxGapMs: number;
  /** Longest quiet stretch that `askcard-open` already accounted for. Reported, never scored. */
  explainedGapMs: number;
  eventCount: number;
}

export function segmentTurns(lines: TeedLine[]): TurnWindow[] {
  const turns: TurnWindow[] = [];
  let current: { startTs: number; openedBy: string; events: TeedLine[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const evs = current.events;
    const terminalLine = evs.find((e) => isSubstantiveTerminal(e)) ?? evs.find((e) => TERMINAL_KINDS.includes(e.kind));
    // Silence is only a defect when the driver cannot NAME the state it is in.
    // The interval that opens with `askcard-open` is an announced human wait —
    // the driver has the question, the option count and the default index — so
    // counting it as a silence violation would score correct behaviour as a
    // wedge, and an implementer told to fix it would start emitting keep-alive
    // noise. Every other gap counts.
    let maxGap = 0;
    let explainedGap = 0;
    for (let i = 1; i < evs.length; i++) {
      const gap = (evs[i]?.ts ?? 0) - (evs[i - 1]?.ts ?? 0);
      if (evs[i - 1]?.kind === "askcard-open") {
        if (gap > explainedGap) explainedGap = gap;
        continue;
      }
      if (gap > maxGap) maxGap = gap;
    }
    turns.push({
      explainedGapMs: explainedGap,
      startTs: current.startTs,
      endTs: evs[evs.length - 1]?.ts ?? current.startTs,
      openedBy: current.openedBy,
      terminal: terminalLine ? terminalLine.kind : null,
      substantive: terminalLine ? isSubstantiveTerminal(terminalLine) : false,
      maxGapMs: maxGap,
      eventCount: evs.length,
    });
    current = null;
  };
  for (const line of lines) {
    if (current === null) {
      current = {
        startTs: line.ts,
        openedBy: TURN_OPENING_KINDS.includes(line.kind) ? line.kind : "first-event",
        events: [],
      };
    } else if (TURN_OPENING_KINDS.includes(line.kind)) {
      flush();
      current = { startTs: line.ts, openedBy: line.kind, events: [] };
    }
    current.events.push(line);
    // A substantive terminal closes the turn it lands in.
    if (isSubstantiveTerminal(line) && line.kind !== "askcard-open") flush();
  }
  flush();
  return turns;
}

export function scoreA2(inputs: ScoreInputs): AxisResult {
  const base: AxisResult = {
    axis: "A2",
    name: "Terminal-state coverage",
    mechanical: true,
    axisAsStated: {
      mechanical: true,
      why: "Every turn's events are recorded in the harness JSONL sink, so 'did this turn announce an outcome' is a fact about a file.",
    },
    measured: false,
    measuredBy: "none",
    score: null,
    unit: "fraction of turns closing with a substantive terminal event",
    target: "1.0, and 0 silence windows over the budget",
    meetsTarget: null,
    confidence: "none",
    humanMustJudge: null,
    detail: {},
    notes: [],
  };

  const lines = inputs.eventLog;
  if (!lines) {
    base.notes.push(
      "no event log supplied (--event-log <path>; the resolved path is reported by tui.capabilities.eventLogPath). " +
        "A2 is unmeasured, NOT passing.",
    );
    return base;
  }
  if (lines.length === 0) {
    base.measured = true;
    base.measuredBy = "harness event JSONL (empty)";
    base.score = null;
    base.meetsTarget = false;
    base.notes.push(
      "event log is empty: a run that emitted no events at all is the exact blindness A2 exists to catch.",
    );
    base.detail = { lines: 0 };
    return base;
  }

  const turns = segmentTurns(lines);
  const closed = turns.filter((t) => t.terminal !== null && t.substantive).length;
  const stubTerminals = turns.filter((t) => t.terminal !== null && !t.substantive);
  const silent = turns.filter((t) => t.maxGapMs > inputs.maxSilenceMs);

  base.measured = true;
  base.measuredBy = `harness event JSONL${inputs.eventLogPath ? ` (${inputs.eventLogPath})` : ""}`;
  base.score = turns.length === 0 ? 0 : closed / turns.length;
  base.confidence = turns.length >= 3 ? "high" : "medium";
  base.detail = {
    lines: lines.length,
    turns: turns.length,
    closedSubstantively: closed,
    stubTerminals: stubTerminals.length,
    silenceViolations: silent.length,
    maxSilenceMs: inputs.maxSilenceMs,
    windows: turns,
  };
  base.meetsTarget = base.score === 1 && silent.length === 0 && stubTerminals.length === 0;
  if (stubTerminals.length > 0) {
    base.notes.push(
      `${stubTerminals.length} turn(s) closed on a CONTENT-FREE terminal event. A payload-less terminal satisfies ` +
        "the letter of the invariant and none of its purpose (§2.6) — it does not count.",
    );
  }
  if (silent.length > 0) {
    base.notes.push(
      `${silent.length} turn(s) went quiet for longer than ${inputs.maxSilenceMs}ms with no event of any kind.`,
    );
  }
  if (turns.length < 3) base.notes.push("fewer than 3 turns in the log — confidence capped at medium.");
  return base;
}

// ===========================================================================
// A3 — Lifecycle integrity
// ===========================================================================

export function scoreA3(inputs: ScoreInputs): AxisResult {
  const base: AxisResult = {
    axis: "A3",
    name: "Lifecycle integrity",
    mechanical: true,
    axisAsStated: {
      mechanical: true,
      why: "tui.start returns a pid, so process.kill(pid, 0) after tui.stop is a decisive orphan test; Escape is observable as a toast or sprint-halt within a bounded window.",
    },
    measured: false,
    measuredBy: "none",
    score: null,
    unit: "orphaned child processes across N stop cycles",
    target: "0 orphans; Escape aborts or emits a toast within 5s",
    meetsTarget: null,
    confidence: "none",
    humanMustJudge: null,
    detail: {},
    notes: [],
  };

  const lc = inputs.lifecycle;
  let orphanVerdict: boolean | null = null;
  if (lc) {
    base.measured = true;
    base.measuredBy = `${lc.cycles} live tui.start/tui.stop cycles, pid liveness via process.kill(pid,0)`;
    base.score = lc.orphanPids.length;
    orphanVerdict = lc.orphanPids.length === 0;
    base.confidence = lc.cycles >= 10 ? "high" : lc.cycles >= 3 ? "medium" : "low";
    if (lc.failedStarts > 0) {
      base.notes.push(
        `${lc.failedStarts} cycle(s) failed to start — those cycles are evidence about nothing and are excluded.`,
      );
    }
  } else {
    base.notes.push("no lifecycle cycles run (--cycles N). Orphan count unmeasured, NOT zero.");
  }

  let escapeVerdict: boolean | null = null;
  if (inputs.escape) {
    const windowMs = inputs.escape.windowMs ?? 5000;
    const reacted = inputs.escape.events.filter(
      (e) =>
        (e.kind === "toast" || e.kind === "sprint-halt") &&
        e.ts >= inputs.escape!.escapePressedAt &&
        e.ts - inputs.escape!.escapePressedAt <= windowMs,
    );
    escapeVerdict = reacted.length > 0;
    base.detail = { ...base.detail, escapeWindowMs: windowMs, escapeReactions: reacted.map((r) => r.kind) };
    if (!escapeVerdict) {
      base.notes.push(`Escape produced no toast and no sprint-halt within ${windowMs}ms of the press.`);
    }
  } else {
    base.notes.push("no Escape probe supplied (--escape-log <path>). The Escape half of A3 is unmeasured.");
  }

  base.detail = {
    ...base.detail,
    cycles: lc?.cycles ?? 0,
    orphanPids: lc?.orphanPids ?? [],
    failedStarts: lc?.failedStarts ?? 0,
    graceMs: lc?.graceMs ?? null,
    orphanVerdict,
    escapeVerdict,
  };

  if (orphanVerdict === false || escapeVerdict === false) base.meetsTarget = false;
  else if (orphanVerdict === true && escapeVerdict === true) base.meetsTarget = true;
  else base.meetsTarget = null;
  return base;
}

// ===========================================================================
// A4 — Decision-field coverage (bounded positive proxy)
// ===========================================================================

export function scoreA4(inputs: ScoreInputs): AxisResult {
  const steps = inputs.corpus.steps;
  const axisAsStated = {
    mechanical: false,
    why:
      "A4 as written ('flows that REQUIRE render_text') is not observable: no referee can distinguish 'the driver " +
      "needed the scrape' from 'the driver used the scrape', and the only static proxy — counting render_text call " +
      "sites — is polluted by visual-capture.spec.ts, which legitimately tests the visual API. Scored here as the " +
      "positive assertion §1.1 restates: the decision field EXISTS in structured output, never 'the scrape did not happen'.",
  };
  const humanMustJudge =
    "Whether each corpus step's declared decisionField is really the field a driver would need to choose its next " +
    "action. A step can name an easy field instead of the load-bearing one and score 100% while a real driver is " +
    "still stuck. That judgement is not automatable; it is why the corpus may only grow.";

  const base: AxisResult = {
    axis: "A4",
    name: "Decision-field coverage",
    mechanical: true,
    axisAsStated,
    measured: false,
    measuredBy: "none",
    score: null,
    unit: "fraction of corpus decision points reachable through structured output",
    target: "1.0 over the fixed corpus",
    meetsTarget: null,
    confidence: "none",
    humanMustJudge,
    detail: {},
    notes: [],
  };

  if (!inputs.corpus.ok || steps.length === 0) {
    base.notes.push(`corpus unusable: ${inputs.corpus.errors.join("; ") || "no steps"}`);
    base.meetsTarget = false;
    base.detail = { corpusErrors: inputs.corpus.errors };
    return base;
  }

  if (!inputs.capabilities && !inputs.replay) {
    base.notes.push(
      "no live capabilities payload (--live) and no replay: field reachability is unknowable, so no number is emitted. " +
        "A missing artifact is not a score of 0 and is not a pass.",
    );
    return base;
  }

  const perStep = steps.map((s) => {
    const ref = s.decisionField;
    const scrape = isScrapeTool(ref.via);
    const verdict = isNameable(ref, inputs.capabilities);
    const replayed = inputs.replay?.observed?.[s.id];
    const structured = !scrape && verdict.nameable;
    const observed = replayed ? replayed.decision && !scrape : structured && s.knownFailing !== true;
    return {
      id: s.id,
      via: ref.via,
      scrapeDependent: scrape,
      nameable: verdict.nameable,
      reason: verdict.reason,
      observed,
      knownFailing: s.knownFailing === true,
      source: replayed ? "replay" : "corpus-declaration",
    };
  });

  const scrapeDependent = perStep.filter((p) => p.scrapeDependent);
  const observed = perStep.filter((p) => p.observed).length;
  const usedReplay = perStep.some((p) => p.source === "replay");

  base.measured = true;
  base.measuredBy = usedReplay ? "replay transcript + corpus" : "corpus declaration + live capabilities";
  base.score = observed / perStep.length;
  base.confidence = usedReplay ? "high" : inputs.capabilities ? "low" : "none";
  base.detail = {
    steps: perStep.length,
    observed,
    scrapeDependent: scrapeDependent.map((p) => ({ id: p.id, via: p.via })),
    notStructured: perStep
      .filter((p) => !p.observed)
      .map((p) => ({
        id: p.id,
        reason: p.scrapeDependent
          ? `decision reachable only via scrape tool ${p.via}`
          : !p.nameable
            ? p.reason
            : p.knownFailing
              ? "step is marked knownFailing in the corpus — its decision field is not reachable today"
              : "not observed in the replay transcript",
      })),
  };

  if (base.score < 1) base.meetsTarget = false;
  else if (usedReplay) base.meetsTarget = true;
  else {
    base.meetsTarget = null;
    base.notes.push(
      "score is DECLARED, not replayed. Pass --replay <path> to upgrade; meetsTarget stays null on purpose.",
    );
  }
  if (scrapeDependent.length > 0) {
    base.notes.push(
      `${scrapeDependent.length} decision point(s) reachable only through a scrape tool — that is exactly what A4 counts against.`,
    );
  }
  if (!inputs.capabilities) base.notes.push("no live capabilities payload (--live): field nameability unchecked.");
  return base;
}

// ===========================================================================
// A5 — Harness determinism
// ===========================================================================

export function scoreA5(inputs: ScoreInputs): AxisResult {
  const base: AxisResult = {
    axis: "A5",
    name: "Harness determinism",
    mechanical: true,
    axisAsStated: {
      mechanical: true,
      why: "The strict linter's exit code and its printed scalars are a machine fact.",
    },
    measured: false,
    measuredBy: "none",
    score: null,
    unit: "unallowlisted skip/todo sites (0 = pass)",
    target: "lint:harness-skips:strict exits 0; unallowlisted = 0",
    meetsTarget: null,
    confidence: "none",
    humanMustJudge: null,
    detail: {},
    notes: [],
  };

  const lint = inputs.skipLint;
  if (!lint?.ran) {
    base.notes.push(`skip linter did not run${lint?.error ? `: ${lint.error}` : ""}. A5 unmeasured, NOT passing.`);
    base.detail = { error: lint?.error ?? "not run" };
    return base;
  }

  base.measured = true;
  base.measuredBy = "scripts/check-harness-skips.ts --strict (exit code + printed scalars)";
  base.score = lint.unallowlisted;
  base.meetsTarget = lint.strictExit === 0 && lint.unallowlisted === 0;
  base.detail = {
    strictExit: lint.strictExit,
    specFiles: lint.totalSpecFiles,
    skip: lint.skipCount,
    todo: lint.todoCount,
    unallowlisted: lint.unallowlisted,
    skipIfGuards: lint.guards,
    harnessRetry: inputs.harnessRetry,
  };

  // The honest caveat, stated every run rather than buried once in a doc.
  if (inputs.harnessRetry !== null && inputs.harnessRetry > 0) {
    base.confidence = "medium";
    base.notes.push(
      `vitest.harness.config.ts sets retry: ${inputs.harnessRetry}, so "the harness is green" tolerates a flake that ` +
        "passes on attempt 2 or 3. WHAT THAT DOES TO A5: as measured here A5 gates REGRESSION ONLY, never improvement " +
        "— a spec fixed for real and a spec that got lucky are indistinguishable to this run. To let A5 gate an " +
        "improvement, the axis-defining specs must be run at retry:0 and that result supplied separately (§5.3).",
    );
  } else if (inputs.harnessRetry === 0) {
    base.confidence = "high";
    base.notes.push(
      "harness retry is 0: a green harness means deterministic, so A5 can gate improvement as well as regression.",
    );
  } else {
    base.confidence = "medium";
    base.notes.push("could not read the harness retry setting — treat A5 as regression-only until confirmed.");
  }
  if (lint.guards !== null && lint.guards > 0) {
    base.notes.push(
      `${lint.guards} .skipIf guard(s) are exempt from the ratio by policy. They are reported by the linter but do ` +
        "not affect this score; whether the CI-disabled ones are acceptable coverage is a human policy call (§2.7).",
    );
  }
  return base;
}

// ===========================================================================
// A6 — Self-description
// ===========================================================================

export function scoreA6(inputs: ScoreInputs): AxisResult {
  const base: AxisResult = {
    axis: "A6",
    name: "Self-description",
    mechanical: true,
    axisAsStated: {
      mechanical: true,
      why: "A static diff: the advertised tool list against tools/list, and every field any scenario references against the payload's keys.",
    },
    measured: false,
    measuredBy: "none",
    score: null,
    unit: "fraction of required self-description checks satisfied",
    target: "capabilities.tools == tools/list exactly, and every referenced field present",
    meetsTarget: null,
    confidence: "none",
    humanMustJudge: null,
    detail: {},
    notes: [],
  };

  const cap = inputs.capabilities;
  const advertised = inputs.toolsList;
  if (!cap || !advertised) {
    base.notes.push(
      "no live MCP handshake (--live): A6 needs both tui.capabilities and tools/list. Unmeasured, NOT passing.",
    );
    return base;
  }

  const capTools = [...(cap.tools ?? [])].sort();
  const listTools = [...advertised].sort();
  const missingFromCap = listTools.filter((t) => !capTools.includes(t));
  const extraInCap = capTools.filter((t) => !listTools.includes(t));
  const toolsParity = missingFromCap.length === 0 && extraInCap.length === 0 && capTools.length > 0;

  // Every field any corpus step references must be describable from the payload.
  const refs: { stepId: string; which: string; ref: FieldRef }[] = [];
  for (const s of inputs.corpus.steps) {
    refs.push({ stepId: s.id, which: "discriminatingField", ref: s.discriminatingField });
    refs.push({ stepId: s.id, which: "decisionField", ref: s.decisionField });
  }
  const unsatisfied = refs.map((r) => ({ ...r, verdict: isNameable(r.ref, cap) })).filter((r) => !r.verdict.nameable);

  // Every tool a step calls must be advertised.
  const usedTools = [...new Set(inputs.corpus.steps.map((s) => s.via))];
  const unadvertisedTools = usedTools.filter((t) => !capTools.includes(t));

  const checks = [
    { name: "tools-parity", ok: toolsParity },
    { name: "referenced-fields-describable", ok: unsatisfied.length === 0 && refs.length > 0 },
    { name: "step-tools-advertised", ok: unadvertisedTools.length === 0 },
    { name: "toolsSource-is-registrar", ok: cap.toolsSource === "registrar" },
  ];
  const passed = checks.filter((c) => c.ok).length;

  base.measured = true;
  base.measuredBy = "live MCP handshake: tools/list vs tui.capabilities, diffed against the corpus assertion set";
  base.score = passed / checks.length;
  base.confidence = "high";
  base.meetsTarget = passed === checks.length;
  base.detail = {
    protocol: cap.protocol ?? null,
    toolsInCapabilities: capTools.length,
    toolsInList: listTools.length,
    missingFromCapabilities: missingFromCap,
    advertisedButNotRegistered: extraInCap,
    eventKinds: (cap.eventKinds ?? []).length,
    roles: (cap.roles ?? []).length,
    referencedFields: refs.length,
    unsatisfiedReferences: unsatisfied.map((u) => ({ step: u.stepId, which: u.which, reason: u.verdict.reason })),
    unadvertisedStepTools: unadvertisedTools,
    checks,
  };
  if (!toolsParity) {
    base.notes.push(
      `tools/list and tui.capabilities.tools disagree (missing from capabilities: ${missingFromCap.join(", ") || "none"}; ` +
        `advertised but not registered: ${extraInCap.join(", ") || "none"}). A capabilities-only agent cannot discover ` +
        "the difference, which is the whole failure A6 exists to catch.",
    );
  }
  if (refs.length === 0)
    base.notes.push("the corpus references no fields — A6's second check has an empty denominator.");
  return base;
}

// ===========================================================================
// Assembly
// ===========================================================================

export function scoreAll(inputs: ScoreInputs): Scorecard {
  const axes: Record<AxisId, AxisResult> = {
    A1: scoreA1(inputs),
    A2: scoreA2(inputs),
    A3: scoreA3(inputs),
    A4: scoreA4(inputs),
    A5: scoreA5(inputs),
    A6: scoreA6(inputs),
  };
  const ids = Object.keys(axes) as AxisId[];
  const postPhase0 = {} as Scorecard["attribution"]["postPhase0"];
  for (const id of ids) {
    const a = axes[id];
    postPhase0[id] = { score: a.score, unit: a.unit, meetsTarget: a.meetsTarget, measuredBy: a.measuredBy };
  }
  return {
    generatedAt: new Date().toISOString(),
    referee: "scripts/agent-drivability-score.ts",
    corpusPath: inputs.corpus.path,
    axes,
    attribution: { prePhase0: PRE_PHASE0_BASELINE, postPhase0 },
    summary: {
      meets: ids.filter((i) => axes[i].meetsTarget === true),
      fails: ids.filter((i) => axes[i].meetsTarget === false),
      unknown: ids.filter((i) => axes[i].meetsTarget === null),
      mechanicalAsStated: ids.filter((i) => axes[i].axisAsStated.mechanical),
      needsHumanJudgement: ids.filter((i) => axes[i].humanMustJudge !== null),
    },
  };
}

export function renderSummary(card: Scorecard): string {
  const L: string[] = [];
  const bar = "─".repeat(78);
  L.push(bar);
  L.push("Agent-Drivability Scorecard");
  L.push(`referee: ${card.referee}   corpus: ${card.corpusPath}`);
  L.push(`generated: ${card.generatedAt}`);
  L.push(bar);
  for (const id of Object.keys(card.axes) as AxisId[]) {
    const a = card.axes[id];
    const verdict = a.meetsTarget === true ? "MEETS" : a.meetsTarget === false ? "FAILS" : "UNKNOWN";
    const score = a.score === null ? "—" : Number.isInteger(a.score) ? String(a.score) : a.score.toFixed(3);
    L.push(`${a.axis}  ${a.name}`);
    L.push(`    verdict     ${verdict}   score ${score} (${a.unit})`);
    L.push(`    measured    ${a.measured ? "yes" : "NO"} via ${a.measuredBy}   confidence ${a.confidence}`);
    L.push(
      `    mechanical  this run: ${a.mechanical ? "yes" : "no"}   axis as stated in §1.1: ${a.axisAsStated.mechanical ? "yes" : "NO"}`,
    );
    if (!a.axisAsStated.mechanical) L.push(`                ${wrap(a.axisAsStated.why, 16)}`);
    if (a.humanMustJudge) L.push(`    HUMAN MUST JUDGE: ${wrap(a.humanMustJudge, 22)}`);
    for (const n of a.notes) L.push(`    note        ${wrap(n, 16)}`);
    L.push("");
  }
  L.push(bar);
  L.push(`meets:   ${card.summary.meets.join(", ") || "(none)"}`);
  L.push(`fails:   ${card.summary.fails.join(", ") || "(none)"}`);
  L.push(`unknown: ${card.summary.unknown.join(", ") || "(none)"}  ← missing artifacts never read as a pass`);
  L.push(bar);
  L.push("Attribution (pre-Phase-0 → post-Phase-0)");
  for (const id of Object.keys(card.axes) as AxisId[]) {
    const pre = card.attribution.prePhase0[id];
    const post = card.attribution.postPhase0[id];
    const f = (v: number | null) => (v === null ? "not baselined" : Number.isInteger(v) ? String(v) : v.toFixed(3));
    L.push(`  ${id}  ${f(pre.score)}  →  ${f(post.score)}   [pre: ${pre.source}]`);
  }
  L.push(bar);
  return L.join("\n");
}

function wrap(text: string, indent: number): string {
  const width = 78 - indent;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join(`\n${" ".repeat(indent)}`);
}

// ===========================================================================
// Collectors — real artifacts. Kept separate from the scorers so every axis
// can be driven from a fixture in a test.
// ===========================================================================

export function readEventLog(path: string): TeedLine[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[${MODULE}] event log read failed (${path}): ${message}`);
    return null;
  }
  const out: TeedLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as TeedLine;
      if (typeof rec?.ts === "number" && typeof rec?.kind === "string") out.push(rec);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      console.error(`[${MODULE}] event log line skipped (${path}): ${message}`);
    }
  }
  return out;
}

export function readHarnessRetry(path = HARNESS_CONFIG): number | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const m = /^\s*retry:\s*(\d+)/m.exec(raw);
    return m ? Number(m[1]) : null;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[${MODULE}] harness config read failed (${path}): ${message}`);
    return null;
  }
}

export async function runSkipLint(): Promise<SkipLintResult> {
  const result: SkipLintResult = {
    strictExit: -1,
    totalSpecFiles: null,
    skipCount: null,
    todoCount: null,
    unallowlisted: null,
    guards: null,
    ran: false,
  };
  if (!existsSync(SKIP_LINTER)) {
    result.error = `linter missing at ${SKIP_LINTER}`;
    console.error(`[${MODULE}] skip lint not run: ${result.error}`);
    return result;
  }
  const out = await runCommand("bun", [SKIP_LINTER, "--strict"], REPO_ROOT, 120_000);
  if (out.error) {
    result.error = out.error;
    console.error(`[${MODULE}] skip lint spawn failed: ${out.error}`);
    return result;
  }
  const text = `${out.stdout}\n${out.stderr}`;
  const num = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  result.strictExit = out.code ?? -1;
  result.totalSpecFiles = num(/Total spec files:\s*(\d+)/);
  result.skipCount = num(/\.skip count:\s*(\d+)/);
  result.todoCount = num(/\.todo count:\s*(\d+)/);
  result.unallowlisted = num(/Unallowlisted hits:\s*(\d+)/);
  result.guards = num(/\.skipIf guards:\s*(\d+)/);
  result.ran = result.totalSpecFiles !== null;
  if (!result.ran) result.error = "linter produced no parseable report";
  return result;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((res) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      res({ code: null, stdout, stderr, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[${MODULE}] spawn ${cmd} failed: ${err?.message}`);
      res({ code: null, stdout, stderr, error: err?.message ?? String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

// --- Live MCP driver client (stdio JSON-RPC). No SDK dependency on purpose:
// --- the referee must not share a client library with the thing it measures.

interface McpClient {
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  listTools: () => Promise<string[]>;
  close: () => void;
}

async function connectDriver(env: Record<string, string> = {}): Promise<McpClient> {
  const child = spawn("bun", ["run", "src/index.ts", "mcp-driver"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg.id;
        if (typeof id === "number" && pending.has(id)) {
          pending.get(id)?.(msg);
          pending.delete(id);
        }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        console.error(`[${MODULE}] mcp-driver emitted a non-JSON stdout line: ${message}`);
      }
    }
  });
  child.stderr?.on("data", () => {
    /* mcp-driver logs progress on stderr; noise, not signal for the referee */
  });
  child.on("error", (err: Error) => {
    console.error(`[${MODULE}] mcp-driver spawn error: ${err?.message}`);
  });

  let nextId = 0;
  const send = (method: string, params: unknown, timeoutMs = 180_000): Promise<Record<string, unknown>> =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, res);
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });

  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agent-drivability-score", version: "1" },
  });
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  return {
    call: async (name, args = {}) => {
      const r = await send("tools/call", { name, arguments: args });
      const result = r.result as { content?: { text?: string }[] } | undefined;
      return result?.content?.[0]?.text ?? JSON.stringify(r.error ?? null);
    },
    listTools: async () => {
      const r = await send("tools/list", {});
      const result = r.result as { tools?: { name: string }[] } | undefined;
      return (result?.tools ?? []).map((t) => t.name);
    },
    close: () => {
      child.kill();
    },
  };
}

export interface LiveCollectResult {
  capabilities: CapabilitiesLike | null;
  toolsList: string[] | null;
  lifecycle: LifecycleResult | null;
  error?: string;
}

export async function collectLive(opts: {
  cycles: number;
  mockLlmDir: string;
  cwd: string;
  graceMs: number;
}): Promise<LiveCollectResult> {
  const out: LiveCollectResult = { capabilities: null, toolsList: null, lifecycle: null };
  let client: McpClient | null = null;
  try {
    client = await connectDriver();
    out.toolsList = await client.listTools();
    const capText = await client.call("tui.capabilities");
    out.capabilities = JSON.parse(capText) as CapabilitiesLike;

    if (opts.cycles > 0) {
      const orphanPids: number[] = [];
      let failedStarts = 0;
      for (let i = 0; i < opts.cycles; i++) {
        const startText = await client.call("tui.start", {
          args: ["--agent-mode"],
          cwd: opts.cwd,
          mockLlmDir: opts.mockLlmDir,
        });
        let pid: number | undefined;
        try {
          pid = (JSON.parse(startText) as { pid?: number }).pid;
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          console.error(`[${MODULE}] cycle ${i}: tui.start returned unparseable payload: ${message}`);
        }
        if (typeof pid !== "number") {
          failedStarts++;
          console.error(`[${MODULE}] cycle ${i}: tui.start did not yield a pid (${startText.slice(0, 200)})`);
          // Still attempt a stop so the next cycle is not blocked by already_started.
          await client.call("tui.stop").catch((err: unknown) => {
            console.error(
              `[${MODULE}] cycle ${i}: recovery tui.stop failed: ${(err as Error)?.message ?? String(err)}`,
            );
            return "";
          });
          continue;
        }
        await client.call("tui.stop");
        await new Promise((r) => setTimeout(r, opts.graceMs));
        try {
          process.kill(pid, 0);
          orphanPids.push(pid);
          // Do not leak the orphan the referee just proved exists.
          try {
            process.kill(pid, "SIGKILL");
          } catch (err) {
            console.error(`[${MODULE}] could not reap orphan pid ${pid}: ${(err as Error)?.message ?? String(err)}`);
          }
        } catch {
          // ESRCH — the child is gone, which is the pass condition. Nothing to
          // log: absence of the process IS the measurement, not an error.
        }
      }
      out.lifecycle = { cycles: opts.cycles, orphanPids, failedStarts, graceMs: opts.graceMs };
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[${MODULE}] live collection failed: ${message}`);
    out.error = message;
  } finally {
    client?.close();
  }
  return out;
}

// ===========================================================================
// §2.6 NEGATIVE CONTROLS — one per axis, each REQUIRED to make the scorer fail
// ===========================================================================

/** A minimal, healthy set of artifacts. Shapes transcribed from real runs. */
export const HEALTHY_CAPABILITIES: CapabilitiesLike = {
  protocol: "0.4.0",
  toolsSource: "registrar",
  tools: [
    "tui.capabilities",
    "tui.cell",
    "tui.changes_since",
    "tui.count",
    "tui.expect",
    "tui.focus",
    "tui.last_event",
    "tui.press",
    "tui.press_sequence",
    "tui.query",
    "tui.query_all",
    "tui.render_text",
    "tui.render_visual",
    "tui.snapshot",
    "tui.snapshot_visual",
    "tui.start",
    "tui.stop",
    "tui.type",
    "tui.visual_quality",
    "tui.wait_for",
    "tui.wait_for_event",
  ],
  eventKinds: ["askcard-open", "askcard-answered", "llm-done", "route-decision", "toast", "usage", "sprint-halt"],
  roles: ["textbox", "statusbar", "dialog", "button", "listitem", "log", "status"],
  customRolePrefix: "x-",
  selector: {
    fields: ["id", "role", "name", "value", "state"],
    flags: ["focus", "selected", "disabled"],
    propsPrefix: "props.",
    ops: ["*=", "~=", "^=", "="],
  },
  eventLogPath: null,
};

const HEALTHY_CORPUS_TEXT = `
\`\`\`json
{
  "id": "H1",
  "title": "healthy fixture",
  "steps": [
    {
      "id": "H1.1",
      "action": "start the TUI and wait for the composer",
      "via": "tui.wait_for",
      "discriminatingField": { "kind": "node", "selector": "id=composer role=textbox", "field": "role", "via": "tui.query" },
      "decisionField": { "kind": "node", "selector": "id=composer", "field": "focus", "via": "tui.query" }
    },
    {
      "id": "H1.2",
      "action": "answer the askcard",
      "via": "tui.last_event",
      "discriminatingField": { "kind": "event", "eventKind": "askcard-open", "field": "question", "via": "tui.last_event" },
      "decisionField": { "kind": "node", "selector": "role=button", "field": "selected", "via": "tui.query_all" }
    }
  ]
}
\`\`\`
`;

const HEALTHY_EVENT_LOG: TeedLine[] = [
  { ts: 1_000, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
  {
    ts: 1_400,
    kind: "askcard-open",
    event: { t: "event", kind: "askcard-open", question: "What do you want to build?", optionCount: 5 },
  },
  {
    ts: 2_600,
    kind: "askcard-answered",
    event: { t: "event", kind: "askcard-answered", answerKind: "choice", answerText: "A simple todo CRUD app" },
  },
  { ts: 3_000, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
  {
    ts: 3_200,
    kind: "usage",
    event: { t: "event", kind: "usage", source: "message", inputTokens: 10, outputTokens: 10 },
  },
  {
    ts: 3_400,
    kind: "llm-done",
    event: { t: "event", kind: "llm-done", correlationId: "c1", totalChars: 882, finishReason: "stop" },
  },
];

export function healthyInputs(): ScoreInputs {
  return {
    corpus: parseCorpusText(HEALTHY_CORPUS_TEXT, "<healthy-fixture>"),
    capabilities: structuredClone(HEALTHY_CAPABILITIES),
    toolsList: [...(HEALTHY_CAPABILITIES.tools ?? [])],
    eventLog: structuredClone(HEALTHY_EVENT_LOG),
    eventLogPath: "<healthy-fixture>",
    skipLint: {
      strictExit: 0,
      totalSpecFiles: 67,
      skipCount: 4,
      todoCount: 4,
      unallowlisted: 0,
      guards: 11,
      ran: true,
    },
    harnessRetry: 0,
    lifecycle: { cycles: 10, orphanPids: [], failedStarts: 0, graceMs: 1500 },
    escape: {
      escapePressedAt: 10_000,
      events: [{ ts: 11_200, kind: "toast", event: { t: "event", kind: "toast", level: "warn", text: "interrupted" } }],
    },
    replay: {
      observed: {
        "H1.1": { discriminating: true, decision: true },
        "H1.2": { discriminating: true, decision: true },
      },
    },
    maxSilenceMs: 120_000,
  };
}

export interface NegativeControl {
  axis: AxisId;
  name: string;
  /** What the broken fixture models — a real failure mode, not a typo. */
  models: string;
  mutate: (healthy: ScoreInputs) => ScoreInputs;
}

/**
 * One deliberately-broken fixture per axis. `--self-test` asserts that the
 * healthy fixture MEETS every axis and that each mutation makes its own axis
 * report `meetsTarget === false`. If any mutation still passes, that axis is
 * measuring nothing and the referee says so with a non-zero exit.
 */
export const NEGATIVE_CONTROLS: NegativeControl[] = [
  {
    axis: "A1",
    name: "corpus step names a state the protocol cannot carry",
    models:
      "a blind state: the driver is told to look for a discriminating field that no event kind delivers, so it can " +
      "never tell waiting from working from hung at that step.",
    mutate: (h) => {
      const c = structuredClone(h);
      const step = c.corpus.steps[0];
      if (step) {
        step.discriminatingField = {
          kind: "event",
          eventKind: "no-such-event-kind",
          field: "question",
          via: "tui.last_event",
        };
      }
      // The replay must not paper over it either: a replay claiming the field
      // was observed while the protocol cannot carry it is exactly the kind of
      // agent-reported "success" §2.1 discards.
      delete c.replay?.observed["H1.1"];
      return c;
    },
  },
  {
    axis: "A2",
    name: "a turn ends with no terminal event, and a synthetic stub tries to cover another",
    models:
      "the wedge itself (a turn that stops emitting and never announces an outcome) PLUS §2.6's named attack: an " +
      "unconditional content-free terminal event emitted from a wrapper to turn the spec green.",
    mutate: (h) => {
      const c = structuredClone(h);
      c.eventLog = [
        { ts: 1_000, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
        { ts: 1_200, kind: "usage", event: { t: "event", kind: "usage", source: "title", inputTokens: 10 } },
        // turn 1 never terminates
        { ts: 900_000, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
        // turn 2 "terminates" on a payload-free stub
        { ts: 900_100, kind: "llm-done", event: { t: "event", kind: "llm-done" } },
      ];
      return c;
    },
  },
  {
    axis: "A3",
    name: "tui.stop returns ok but the child survives",
    models: "the measured pre-Phase-0 defect: 8/8 TUIs survived tui.stop while the tool unconditionally reported 'ok'.",
    mutate: (h) => {
      const c = structuredClone(h);
      c.lifecycle = {
        cycles: 10,
        orphanPids: [4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008],
        failedStarts: 0,
        graceMs: 1500,
      };
      return c;
    },
  },
  {
    axis: "A4",
    name: "a decision point is reachable only by scraping the screen",
    models:
      "a flow that forces the driver to read rendered text to choose its next action — the failure A4 names, expressed " +
      "positively as 'the decision field is not in structured output'.",
    mutate: (h) => {
      const c = structuredClone(h);
      const step = c.corpus.steps[1] ?? c.corpus.steps[0];
      if (step) step.decisionField = { kind: "node", selector: "id=log", field: "value", via: "tui.render_text" };
      delete c.replay?.observed[step?.id ?? ""];
      return c;
    },
  },
  {
    axis: "A5",
    name: "a skip is added without an allowlist entry",
    models:
      "green-by-deletion (§2.5): coverage removed by a skip rather than a fix, which the strict linter must reject.",
    mutate: (h) => {
      const c = structuredClone(h);
      c.skipLint = {
        strictExit: 1,
        totalSpecFiles: 67,
        skipCount: 5,
        todoCount: 4,
        unallowlisted: 1,
        guards: 11,
        ran: true,
      };
      return c;
    },
  },
  {
    axis: "A6",
    name: "a registered tool is missing from the capabilities payload",
    models:
      "the measured pre-Phase-0 defect (14 advertised strings vs 21 registered tools) and §2.5's extension: removing a " +
      "tool from the payload must never read as an improvement.",
    mutate: (h) => {
      const c = structuredClone(h);
      c.capabilities = {
        ...c.capabilities,
        tools: (c.capabilities?.tools ?? []).filter((t) => t !== "tui.last_event"),
      };
      return c;
    },
  },
];

export interface SelfTestRow {
  axis: AxisId;
  control: string;
  healthyMeets: boolean | null;
  healthyScore: number | null;
  brokenMeets: boolean | null;
  brokenScore: number | null;
  /** true when the healthy fixture passes AND the broken fixture is caught. */
  ok: boolean;
}

export function runSelfTest(): { rows: SelfTestRow[]; ok: boolean } {
  const healthy = healthyInputs();
  const healthyCard = scoreAll(healthy);
  const rows: SelfTestRow[] = [];
  for (const nc of NEGATIVE_CONTROLS) {
    const broken = scoreAll(nc.mutate(healthyInputs()));
    const healthyMeets = healthyCard.axes[nc.axis].meetsTarget;
    const brokenMeets = broken.axes[nc.axis].meetsTarget;
    rows.push({
      axis: nc.axis,
      control: nc.name,
      healthyMeets,
      healthyScore: healthyCard.axes[nc.axis].score,
      brokenMeets,
      brokenScore: broken.axes[nc.axis].score,
      ok: healthyMeets === true && brokenMeets === false,
    });
  }
  return { rows, ok: rows.every((r) => r.ok) };
}

// ===========================================================================
// CLI
// ===========================================================================

interface Args {
  json: boolean;
  live: boolean;
  cycles: number;
  corpus: string;
  eventLog: string | null;
  escapeLog: string | null;
  replay: string | null;
  maxSilenceMs: number;
  selfTest: boolean;
  gate: boolean;
  graceMs: number;
  mockLlmDir: string;
  childCwd: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    json: false,
    live: false,
    cycles: 0,
    corpus: DEFAULT_CORPUS,
    eventLog: null,
    escapeLog: null,
    replay: null,
    maxSilenceMs: 120_000,
    selfTest: false,
    gate: false,
    graceMs: 1500,
    mockLlmDir: resolve(REPO_ROOT, "tests/harness/fixtures/llm"),
    childCwd: REPO_ROOT,
  };
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        a.json = true;
        break;
      case "--live":
        a.live = true;
        break;
      case "--self-test":
        a.selfTest = true;
        break;
      case "--gate":
        a.gate = true;
        break;
      case "--cycles":
        a.cycles = Math.max(0, Number(argv[++i] ?? 0) || 0);
        a.live = a.live || a.cycles > 0;
        break;
      case "--corpus":
        a.corpus = abs(argv[++i] ?? DEFAULT_CORPUS);
        break;
      case "--event-log":
        a.eventLog = abs(argv[++i] ?? "");
        break;
      case "--escape-log":
        a.escapeLog = abs(argv[++i] ?? "");
        break;
      case "--replay":
        a.replay = abs(argv[++i] ?? "");
        break;
      case "--max-silence-ms":
        a.maxSilenceMs = Math.max(1, Number(argv[++i] ?? 0) || 120_000);
        break;
      case "--grace-ms":
        a.graceMs = Math.max(0, Number(argv[++i] ?? 0) || 1500);
        break;
      case "--mock-llm-dir":
        a.mockLlmDir = abs(argv[++i] ?? a.mockLlmDir);
        break;
      case "--child-cwd":
        a.childCwd = abs(argv[++i] ?? a.childCwd);
        break;
      default:
        throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return a;
}

function readJsonFile<T>(path: string, what: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[${MODULE}] ${what} read failed (${path}): ${message}`);
    return null;
  }
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[${MODULE}] argument parse failed: ${message}`);
    return 2;
  }

  if (args.selfTest) {
    const { rows, ok } = runSelfTest();
    if (args.json) {
      console.log(JSON.stringify({ selfTest: rows, ok }, null, 2));
    } else {
      console.log("─".repeat(78));
      console.log("§2.6 negative controls — each broken fixture MUST make its axis fail");
      console.log("─".repeat(78));
      const fmt = (v: number | null) => (v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(3));
      for (const r of rows) {
        console.log(
          `${r.ok ? "PASS" : "FAIL"}  ${r.axis}  healthy=${String(r.healthyMeets)}(score ${fmt(r.healthyScore)}) ` +
            `→ broken=${String(r.brokenMeets)}(score ${fmt(r.brokenScore)})`,
        );
        console.log(`          control: ${r.control}`);
      }
      console.log("─".repeat(78));
      console.log(
        ok
          ? "✔ every axis detects its known-bad state"
          : "✘ an axis did NOT detect its known-bad state — that axis measures nothing",
      );
    }
    return ok ? 0 : 3;
  }

  const corpus = parseCorpus(args.corpus);

  let capabilities: CapabilitiesLike | null = null;
  let toolsList: string[] | null = null;
  let lifecycle: LifecycleResult | null = null;
  if (args.live) {
    const live = await collectLive({
      cycles: args.cycles,
      mockLlmDir: args.mockLlmDir,
      cwd: args.childCwd,
      graceMs: args.graceMs,
    });
    capabilities = live.capabilities;
    toolsList = live.toolsList;
    lifecycle = live.lifecycle;
  }

  const eventLog = args.eventLog ? readEventLog(args.eventLog) : null;
  const escapeProbe = args.escapeLog ? readJsonFile<EscapeProbe>(args.escapeLog, "escape probe") : null;
  const replay = args.replay ? readJsonFile<ReplayResult>(args.replay, "replay transcript") : null;

  const inputs: ScoreInputs = {
    corpus,
    capabilities,
    toolsList,
    eventLog,
    eventLogPath: args.eventLog,
    skipLint: await runSkipLint(),
    harnessRetry: readHarnessRetry(),
    lifecycle,
    escape: escapeProbe,
    replay,
    maxSilenceMs: args.maxSilenceMs,
  };

  const card = scoreAll(inputs);
  if (args.json) console.log(JSON.stringify(card, null, 2));
  else console.log(renderSummary(card));

  if (args.gate && card.summary.fails.length > 0) return 1;
  return 0;
}

// Only run the CLI when executed directly — importing this module from a test
// must not spawn processes.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch (err) {
    console.error(`[${MODULE}] could not resolve entry path: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`[${MODULE}] fatal: ${(err as Error)?.message ?? String(err)}`);
      process.exit(2);
    },
  );
}
