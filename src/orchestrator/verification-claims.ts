/**
 * src/orchestrator/verification-claims.ts
 *
 * Host check for one cheap-to-fabricate, high-impact claim: "the tests / the
 * build ran (and passed)". A final answer (main turn or worker result) is
 * scanned for such claims, and each one is checked against the verification
 * commands the host actually RECORDED — bash test/build commands, native
 * `verification_run`, and `run_gate` — instead of trusting a contract line
 * ("never claim a test ran when it didn't", agent-operating-contract #P15).
 *
 * Outcome source (adapter): outcomes are derived from the recorded tool-call /
 * tool-result pairs of the conversation plus `[host-verification]` records a
 * worker result carries up to its orchestrator. git-safety.ts keeps only FAILED
 * verification commands for the push gate, so it cannot answer "did a passing
 * run happen"; when a session-wide pass/fail ledger lands there, swap
 * `recordVerifications`/`recordedVerifications` for it — callers do not change.
 *
 * Pure except for the process-scoped session ledger at the bottom. Designed for
 * LOW false positives: quoted/code text, questions, conditional, future,
 * negated and attributed ("the worker reported …") sentences never count.
 */

import { createHash } from "node:crypto";
import { canonicalizeBashCommand } from "./tool-args-hash.js";

export type VerificationKind = "test" | "build";

/** One verification command the host saw complete, with its observed outcome. */
export interface RecordedVerification {
  /** Stable identity (toolCallId or record digest) so re-scans do not duplicate. */
  id: string;
  tool: string;
  kind: VerificationKind;
  /** Canonical command (bash), runner+files (verification_run) or gate command. */
  command: string;
  passed: boolean;
  /** Who ran it, when it did not run in this conversation (e.g. "worker <jobId>"). */
  source?: string;
}

export interface VerificationClaim {
  kind: VerificationKind;
  /** "pass": the text asserts success; "ran": it only asserts the command ran. */
  polarity: "pass" | "ran";
  /** The sentence that carries the claim (trimmed, ≤160 chars). */
  text: string;
}

export interface UnsupportedVerificationClaim extends VerificationClaim {
  reason: string;
}

const MAX_COMMAND_CHARS = 160;
const MAX_CLAIM_CHARS = 160;
const MAX_UNSUPPORTED = 3;

// ── Command classification ────────────────────────────────────────────────────

const TEST_COMMAND_RE = new RegExp(
  [
    String.raw`(?:^|[\s;&|(])(?:(?:npx|bunx|pnpx|bun\s+x|pnpm\s+exec|yarn)\s+)?(?:vitest|jest|mocha|ava|pytest|py\.test|rspec|phpunit|karma)\b`,
    String.raw`\b(?:playwright\s+test|cypress\s+run)\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?\b`,
    String.raw`\b(?:go|cargo|dotnet|mvn|gradle|gradlew|deno|mix|swift)\s+test\b`,
    String.raw`\bnode\s+--test\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest)\b`,
    String.raw`\bctest\b`,
  ].join("|"),
  "i",
);

const BUILD_COMMAND_RE = new RegExp(
  [
    String.raw`(?:^|[\s;&|(])(?:(?:npx|bunx|pnpx|bun\s+x|pnpm\s+exec)\s+)?tsc\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|type-check|compile)\b`,
    String.raw`\b(?:cargo|go)\s+(?:build|check|vet)\b`,
    String.raw`\bdotnet\s+build\b`,
    String.raw`\bmsbuild\b`,
    String.raw`\bmvn\s+(?:compile|package|install|verify)\b`,
    String.raw`\bgradlew?\s+(?:build|assemble|compileJava)\b`,
    String.raw`\b(?:vite|next|bun)\s+build\b`,
  ].join("|"),
  "i",
);

/** Verification kinds a shell command runs (a chained `test && build` is both). */
export function classifyVerificationCommand(command: string): VerificationKind[] {
  const canonical = canonicalizeBashCommand(command);
  const kinds: VerificationKind[] = [];
  if (TEST_COMMAND_RE.test(canonical)) kinds.push("test");
  if (BUILD_COMMAND_RE.test(canonical)) kinds.push("build");
  return kinds;
}

// A bash command that exited 0 can still have failed when its output was piped
// (`vitest run | tail -20` reports tail's exit status). Positive failure counts
// in the output override the exit status — never the other way round.
const OUTPUT_FAILURE_RE =
  /\b[1-9]\d*\s+(?:failed|failing|failures?)\b|\bTests?:\s+[1-9]\d*\s+failed\b|\berror TS\d{3,5}\b|\bBuild FAILED\b|\bnpm ERR!|^\s*FAIL\s/im;
// The tool refused or deferred: the command did not (yet) run.
const NOT_RUN_RE =
  /\bBLOCKED\b|\brefus(?:ed|ing)\b|\bnot executed\b|\bdid not execute\b|\bNo command executed\b|\bpermission_required\b|\bapproval\b.*\bdenied\b|\brunning in (?:the )?background\b|\bbackground (?:process|job) (?:started|id)\b/i;

function shortCommand(command: string): string {
  const c = command.replace(/\s+/g, " ").trim();
  return c.length <= MAX_COMMAND_CHARS ? c : `${c.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/**
 * Observed outcome of ONE completed tool call, or [] when the call is not a
 * test/build run or did not actually run. `output` is the tool result text the
 * model saw (bash: "ERROR: …" on failure; verification_run: JSON ToolResult;
 * run_gate: "gate <id> `<cmd>` passed|failed …").
 */
export function outcomesFromToolCall(
  id: string,
  toolName: string,
  input: unknown,
  output: string,
): RecordedVerification[] {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const kinds = command ? classifyVerificationCommand(command) : [];
    if (!kinds.length || NOT_RUN_RE.test(output.slice(0, 400))) return [];
    const passed = !output.startsWith("ERROR:") && !OUTPUT_FAILURE_RE.test(output);
    return kinds.map((kind) => ({
      id: `${id}:${kind}`,
      tool: toolName,
      kind,
      command: shortCommand(canonicalizeBashCommand(command)),
      passed,
    }));
  }
  if (toolName === "verification_run") {
    let parsed: { success?: unknown; output?: unknown } | null = null;
    try {
      parsed = JSON.parse(output) as { success?: unknown; output?: unknown };
    } catch (err) {
      // An "ERROR verification_failed: …" line is a refusal: nothing ran.
      if (!/^ERROR\b/.test(output))
        console.error(`[verification-claims] unparseable verification_run result: ${(err as Error).message}`);
      return [];
    }
    const text = typeof parsed?.output === "string" ? parsed.output : "";
    // Only a launched runner reports `exit=`; validation refusals do not.
    if (!/\bexit=/.test(text)) return [];
    const files = Array.isArray(args.files) ? args.files.filter((f) => typeof f === "string").join(" ") : "";
    return [
      {
        id: `${id}:test`,
        tool: toolName,
        kind: "test",
        command: shortCommand(`verification_run ${typeof args.runner === "string" ? args.runner : "auto"} ${files}`),
        passed: parsed?.success === true,
      },
    ];
  }
  if (toolName === "run_gate") {
    const head = /^gate (\S+) `([^`]*)` (passed|failed|timed out|did not complete)/.exec(output);
    if (!head) return [];
    const [, gateId = "", command = "", verdict = ""] = head;
    if (verdict === "did not complete") return [];
    const kinds = classifyVerificationCommand(command);
    if (!kinds.length) kinds.push(/test/i.test(gateId) ? "test" : "build");
    const passed = verdict === "passed" && !/^zero tests executed/m.test(output);
    return kinds.map((kind) => ({
      id: `${id}:${kind}`,
      tool: toolName,
      kind,
      command: shortCommand(command || gateId),
      passed,
    }));
  }
  return [];
}

// ── Host verification records (worker → orchestrator) ─────────────────────────

/** Marker of a host-written verification record inside a worker result. */
export const HOST_VERIFICATION_TAG = "[host-verification]";

/** One-line record a worker result carries so its orchestrator can ground later claims. */
export function formatHostVerificationRecord(source: string, outcomes: readonly RecordedVerification[]): string {
  if (!outcomes.length) return "";
  return `${HOST_VERIFICATION_TAG} ${JSON.stringify({
    v: 1,
    source,
    outcomes: outcomes.map(({ tool, kind, command, passed }) => ({ tool, kind, command, passed })),
  })}`;
}

const HOST_RECORD_RE = /\[host-verification\] (\{[^\n]*\})/g;

/** Parse every host verification record embedded in `text` (worker results, notices). */
export function parseHostVerificationRecords(text: string): RecordedVerification[] {
  const out: RecordedVerification[] = [];
  for (const m of text.matchAll(HOST_RECORD_RE)) {
    const raw = m[1]!;
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; source?: unknown; outcomes?: unknown };
      if (parsed.v !== 1 || !Array.isArray(parsed.outcomes)) continue;
      const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
      parsed.outcomes.forEach((o: Record<string, unknown>, i: number) => {
        if ((o?.kind !== "test" && o?.kind !== "build") || typeof o.passed !== "boolean") return;
        out.push({
          id: `host:${digest}:${i}`,
          tool: typeof o.tool === "string" ? o.tool : "unknown",
          kind: o.kind,
          command: typeof o.command === "string" ? shortCommand(o.command) : "",
          passed: o.passed,
          ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
        });
      });
    } catch (err) {
      console.error(`[verification-claims] malformed host verification record: ${(err as Error).message}`);
    }
  }
  return out;
}

// ── Conversation scan ─────────────────────────────────────────────────────────

type MessageLike = { role?: string; content?: unknown };
type Part = { type?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown };

function toolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return "";
  const o = output as { type?: string; value?: unknown };
  if (typeof o.value === "string") return o.value;
  if (o.value !== undefined) return JSON.stringify(o.value);
  return JSON.stringify(output);
}

/**
 * Chronological verification outcomes recorded in a model-message history:
 * tool-call/tool-result pairs of bash / verification_run / run_gate, plus
 * `[host-verification]` records in any message text (worker results reach the
 * orchestrator as tool results or system notices).
 */
export function outcomesFromMessages(messages: readonly unknown[]): RecordedVerification[] {
  const calls = new Map<string, { toolName: string; input: unknown }>();
  const out: RecordedVerification[] = [];
  for (const raw of messages) {
    const message = raw as MessageLike;
    if (!message || typeof message !== "object") continue;
    if (typeof message.content === "string") {
      if (message.content.includes(HOST_VERIFICATION_TAG)) out.push(...parseHostVerificationRecords(message.content));
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Part[]) {
      if (part?.type === "tool-call" && part.toolCallId && part.toolName) {
        calls.set(part.toolCallId, { toolName: part.toolName, input: part.input });
      } else if (part?.type === "tool-result" && part.toolCallId) {
        const text = toolResultText(part.output);
        const call = calls.get(part.toolCallId);
        const toolName = part.toolName ?? call?.toolName ?? "";
        out.push(...outcomesFromToolCall(part.toolCallId, toolName, call?.input, text));
        if (text.includes(HOST_VERIFICATION_TAG)) out.push(...parseHostVerificationRecords(text));
      } else if (part?.type === "text" && typeof (part as { text?: unknown }).text === "string") {
        const text = (part as { text: string }).text;
        if (text.includes(HOST_VERIFICATION_TAG)) out.push(...parseHostVerificationRecords(text));
      }
    }
  }
  return out;
}

// ── Claim detection ───────────────────────────────────────────────────────────

interface ClaimPattern {
  kind: VerificationKind;
  polarity: "pass" | "ran";
  re: RegExp;
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  // ── test, pass ──
  {
    kind: "test",
    polarity: "pass",
    re: /\b(?:all\s+(?:the\s+)?)?(?:\d+\s+)?(?:unit\s+|integration\s+|e2e\s+|harness\s+)?tests?\s+(?:(?:are|were|now|all|still|have|has|do|did)\s+){0,3}(?:pass(?:ed|es|ing)?|green|succeed(?:ed|s)?)\b/i,
  },
  {
    kind: "test",
    polarity: "pass",
    re: /\b(?:test\s+suite|suite|specs?)\s+(?:(?:is|are|was|were|now|all)\s+){0,2}(?:pass(?:ed|es|ing)?|green)\b/i,
  },
  { kind: "test", polarity: "pass", re: /\b\d+\s*\/\s*\d+\s+(?:tests?\s+|specs?\s+)?pass(?:ed|ing)?\b/i },
  { kind: "test", polarity: "pass", re: /\bpass(?:ed|es)?\s+all\s+(?:the\s+)?(?:tests|specs)\b/i },
  {
    kind: "test",
    polarity: "pass",
    re: /(?:tất cả|toàn bộ|các)?\s*(?:unit\s*)?test\s+(?:(?:đều|đã|vẫn)\s+)*(?:pass|xanh|thành công)/i,
  },
  // ── test, ran ──
  {
    kind: "test",
    polarity: "ran",
    re: /\b(?:i|we)\s+(?:have\s+)?(?:ran|run|executed|re-?ran)\s+(?:the\s+|all\s+(?:the\s+)?)?(?:unit\s+|full\s+)?(?:tests?|test\s+suite|specs?)\b/i,
  },
  {
    kind: "test",
    polarity: "ran",
    re: /\b(?:tests?|test\s+suite)\s+(?:was|were|have\s+been|has\s+been)\s+(?:run|executed)\b/i,
  },
  { kind: "test", polarity: "ran", re: /đã\s+chạy\s+(?:lại\s+)?(?:các\s+|toàn bộ\s+|hết\s+)?(?:unit\s*)?test/i },
  // ── build, pass ──
  {
    kind: "build",
    polarity: "pass",
    re: /\bbuild\s+(?:(?:is|was|now|still)\s+){0,2}(?:succeed(?:ed|s)?|successful|pass(?:ed|es|ing)?|green|clean)\b/i,
  },
  {
    kind: "build",
    polarity: "pass",
    re: /\b(?:built|compiles?|compiled)\s+(?:successfully|cleanly|without\s+errors?)\b/i,
  },
  {
    kind: "build",
    polarity: "pass",
    re: /\b(?:typecheck|type-check|tsc)\s+(?:(?:is|was|now)\s+)?(?:pass(?:es|ed)?|clean|green)\b/i,
  },
  {
    kind: "build",
    polarity: "pass",
    re: /\b(?:tsc|typecheck|build)\b[^.\n]{0,30}?\b(?:0|zero|no)\s+(?:type\s+)?errors?\b/i,
  },
  { kind: "build", polarity: "pass", re: /\bbuild\s+(?:đã\s+)?(?:thành công|pass|xanh)|biên dịch\s+thành công/i },
  // ── build, ran ──
  {
    kind: "build",
    polarity: "ran",
    re: /\b(?:i|we)\s+(?:have\s+)?(?:ran|run|executed)\s+(?:the\s+)?(?:build|tsc|typecheck)\b/i,
  },
  { kind: "build", polarity: "ran", re: /đã\s+chạy\s+(?:lại\s+)?build\b/i },
];

// Before the claim in the same sentence: the claim is conditional, future,
// instructed, expected or attributed — not the author asserting a fact.
const NON_ASSERTIVE_RE =
  /\b(?:if|once|when|whether|unless|until|before|should|would|could|might|may|will|must|need(?:s|ed)?\s+to|make\s+sure|ensure|verify\s+that|check\s+(?:that|whether|if)|expect(?:s|ed)?|to\s+confirm|so\s+that|try\s+to|let'?s|please|reported|reports|claims|claimed|says|said|stated|according\s+to)\b|(?:^|\s)(?:nếu|khi|sẽ|cần|phải|hãy|để|liệu|báo cáo|theo)(?=\s|$)/i;
// Negation before the claim in the same sentence: "not all tests pass".
const NEGATION_RE =
  /\b(?:not|no\s+longer|never|cannot|can't|didn't|did\s+not|don't|doesn't|haven't|hasn't|have\s+not|has\s+not|without|unable|fail(?:s|ed|ing)?)\b|n't\b|(?:^|\s)(?:chưa|không|chẳng)(?=\s|$)/i;

/** Remove text the author did not assert: code, block quotes and quoted strings. */
function stripNonAssertedText(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?(?:```|$)/g, "\n")
      .replace(/`[^`\n]*`/g, " ")
      .replace(/^\s*>.*$/gm, "")
      .replace(/"[^"\n]{0,240}"|“[^”\n]{0,240}”/g, " ")
      // Single quotes only as delimiters, never apostrophes ("worker's", "it's").
      .replace(/(^|[\s(])'[^'\n]{1,240}'(?=[\s.,;:)!?]|$)/gm, "$1 ")
  );
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * First sentence of `text` that ASSERTS one of `patterns` (same quote / code /
 * question / conditional / negation / attribution filters as the test-claim
 * detector), or null.
 */
export function findAssertedSentence(text: string, patterns: readonly RegExp[]): string | null {
  if (!text) return null;
  for (const sentence of sentencesOf(stripNonAssertedText(text))) {
    if (sentence.endsWith("?")) continue;
    for (const re of patterns) {
      const m = re.exec(sentence);
      if (!m) continue;
      const before = sentence.slice(0, m.index);
      if (NON_ASSERTIVE_RE.test(before) || NEGATION_RE.test(before)) continue;
      const t = sentence.replace(/\s+/g, " ");
      return t.length <= MAX_CLAIM_CHARS ? t : `${t.slice(0, MAX_CLAIM_CHARS - 1)}…`;
    }
  }
  return null;
}

/** Test/build claims the text asserts as fact (deduped by kind + polarity). */
export function findVerificationClaims(text: string): VerificationClaim[] {
  if (!text) return [];
  const out: VerificationClaim[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(stripNonAssertedText(text))) {
    if (sentence.endsWith("?")) continue;
    for (const { kind, polarity, re } of CLAIM_PATTERNS) {
      const m = re.exec(sentence);
      if (!m) continue;
      const before = sentence.slice(0, m.index);
      if (NON_ASSERTIVE_RE.test(before) || NEGATION_RE.test(before)) continue;
      const key = `${kind}:${polarity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = sentence.replace(/\s+/g, " ");
      out.push({ kind, polarity, text: t.length <= MAX_CLAIM_CHARS ? t : `${t.slice(0, MAX_CLAIM_CHARS - 1)}…` });
    }
  }
  // A pass claim already implies the run; keep the stronger one per kind.
  return out.filter((c) => c.polarity === "pass" || !out.some((o) => o.kind === c.kind && o.polarity === "pass"));
}

/**
 * Claims in `text` that the recorded outcomes do not support. A "ran" claim
 * needs any recorded run of its kind; a "pass" claim needs the LATEST recorded
 * run of its kind to have passed. `outcomes` must be chronological.
 */
export function checkVerificationClaims(
  text: string,
  outcomes: readonly RecordedVerification[],
): UnsupportedVerificationClaim[] {
  const unsupported: UnsupportedVerificationClaim[] = [];
  for (const claim of findVerificationClaims(text)) {
    const ofKind = outcomes.filter((o) => o.kind === claim.kind);
    const latest = ofKind[ofKind.length - 1];
    if (!latest) {
      unsupported.push({
        ...claim,
        reason: `no ${claim.kind} command ran in the recorded tool calls (bash, verification_run, run_gate)`,
      });
    } else if (claim.polarity === "pass" && !latest.passed) {
      unsupported.push({
        ...claim,
        reason: `the latest recorded ${claim.kind} run failed: ${latest.command}${latest.source ? ` (${latest.source})` : ""}`,
      });
    }
    if (unsupported.length >= MAX_UNSUPPORTED) break;
  }
  return unsupported;
}

/** Advisory footnote (main turn). Returns "" for no claims. */
export function buildVerificationFootnote(claims: readonly UnsupportedVerificationClaim[]): string {
  if (!claims.length) return "";
  const list = claims.map((c) => `"${c.text}" — ${c.reason}`).join("; ");
  return `\n\n> ⚠ Host verification check: ${list}. Treat as unverified until a recorded run supports it.`;
}

// ── Session ledger (adapter) ──────────────────────────────────────────────────

const MAX_LEDGER = 200;

declare global {
  // eslint-disable-next-line no-var
  var __muonroiVerificationLedger: Map<string, RecordedVerification[]> | undefined;
}

function ledger(): Map<string, RecordedVerification[]> {
  globalThis.__muonroiVerificationLedger ??= new Map();
  return globalThis.__muonroiVerificationLedger;
}

/**
 * Append outcomes (deduped by id, order kept) to the session ledger and return
 * the session's chronological outcomes. Survives compaction, which drops the
 * tool messages the outcomes were derived from.
 */
export function recordVerifications(
  sessionKey: string,
  outcomes: readonly RecordedVerification[],
): RecordedVerification[] {
  const list = ledger().get(sessionKey) ?? [];
  const ids = new Set(list.map((o) => o.id));
  for (const o of outcomes) {
    if (ids.has(o.id)) continue;
    ids.add(o.id);
    list.push(o);
  }
  const bounded = list.slice(-MAX_LEDGER);
  ledger().set(sessionKey, bounded);
  return bounded;
}

export function recordedVerifications(sessionKey: string): RecordedVerification[] {
  return [...(ledger().get(sessionKey) ?? [])];
}

/** Test helper. */
export function __resetVerificationLedger(): void {
  globalThis.__muonroiVerificationLedger = new Map();
}
