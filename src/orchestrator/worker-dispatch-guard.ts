/**
 * Dispatch-time guards for native workers (host-enforced, not prompt prose).
 *
 * 1. Capability: a worker whose effective tool grant has no command runner must
 *    not be dispatched with a task that explicitly tells it to run commands.
 *    Measured in session 4edc02516a92: writeScope workers (lively-white-falcon,
 *    calm-ivory-fox, quiet-copper-panda, ...) and reviewOf verify workers
 *    (brisk-indigo-lynx, lively-teal-wolf, ...) were asked to run dotnet
 *    build/test/pack or git diff, and each reported "no shell" as a blocker.
 * 2. Overlap: a new write-capable dispatch must not share write paths with a
 *    RUNNING write-capable job (same session 02:07Z steady-ivory-panda and 02:16Z
 *    steady-indigo-heron, both unscoped, both writing src/src/TCIS.MCP.Docs/).
 *
 * Why no scoped command capability: build/test runners execute project-controlled
 * code (MSBuild targets, npm scripts, conftest.py, test bodies) that a scoped
 * worker can author inside its own writeScope, so a command allowlist does not
 * bound file effects without an OS sandbox (WORKER_ISOLATION_CAPABILITIES.osSandbox
 * is false; BashTool's sandboxMode is ignored).
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { SCOPED_WORKER_TOOL_NAMES } from "../tools/worker-write-scope.js";
import type { TaskRequest } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { REVIEW_TOOL_NAMES } from "./orchestration-policy.js";

/** Worker agents that run in ask mode (read-only); mirrors stream-runner childMode. */
export const ASK_MODE_WORKER_AGENTS: ReadonlySet<string> = new Set(["explore", "verify-detect"]);

export interface CommandRequirement {
  kind: "command" | "tests";
  /** Bounded excerpt of the instruction that triggered detection. */
  evidence: string;
}

const W = "[\\p{L}\\p{N}_]";
// Imperative run verbs. "chạy" covers Vietnamese prompts measured in the same session.
const RUN_VERB = new RegExp(`(?<!${W}|-)(?:re-?run|run|execute|exec|invoke|chạy)(?!${W}|-)`, "giu");
// Objects must sit in the same clause as the verb (no sentence or comma boundary).
const COMMAND_OBJECT = new RegExp(
  `^[^\\n.;!?,]{0,60}?(?<!${W})(?:build|compile|commands?|pack|lint|gate|script|scanner|lệnh)(?!${W})`,
  "iu",
);
const TESTS_OBJECT = new RegExp(`^[^\\n.;!?,]{0,60}?(?<!${W})(?:tests?|test\\s+suite|suite|kiểm\\s+thử)(?!${W})`, "iu");
const CODE_SPAN = /^([^\n.;!?,]{0,80}?)`([^`\n]+)`/u;
const COLON_COMMAND = /^\s*:\s*\S/u;
/** "run from `dir`": the code span is a location, not a command. */
const LOCATION_LEAD = new RegExp(`(?<!${W})(?:from|in|inside|under|at|against|on|từ|trong|tại)\\s*$`, "iu");
/** "run command" (noun compound), "run low/out" (idiom): no command object follows. */
const NOT_AN_OBJECT = new RegExp(`^\\s+(?:command|configuration|low|out|into|over|across)(?!${W})`, "iu");
/** Code spans every scoped/review grant already satisfies with native read_file/grep. */
const NATIVE_READ_COMMAND = /^\s*(?:grep|rg|cat|head|tail|type)(?:\s|$)/iu;
// Clause-local markers that turn "run" into a prohibition, a past fact, a noun
// or a description rather than an instruction to this worker.
const NEGATED = new RegExp(
  `(?<!${W})(?:not|never|don'?t|doesn'?t|mustn'?t|shouldn'?t|can'?t|cannot|without|avoid|no\\s+need\\s+to|instead\\s+of|không|đừng|cấm|chớ|chưa|đã)(?!${W})`,
  "iu",
);
const NON_DIRECTIVE_PREFIX = new RegExp(
  `(?<!${W})(?:how\\s+to|whether\\s+to|be|was|were|been|already|the|a|an|this|that|last|previous|prior|each|every|dry|test|ci|first|next|its|their|(?:if|when|nếu|khi)(?:\\s+(?:you|có|bạn))?)\\s*$`,
  "iu",
);
/** Files verification_run can execute (see src/tools/verification-run.ts). */
const VERIFICATION_RUNNABLE =
  /\.(?:test|spec)\.[cm]?[jt]sx?\b|(?:^|[\s/\\`])(?:test_[\w.-]+|[\w.-]+_test)\.py\b|verification_run/iu;

function clauseBefore(text: string, index: number): string {
  const head = text.slice(Math.max(0, index - 120), index);
  const cut = Math.max(...[...".;!?\n,"].map((c) => head.lastIndexOf(c)));
  return head.slice(cut + 1);
}

function lineAt(text: string, index: number): string {
  const end = text.indexOf("\n", index);
  return text.slice(index, end < 0 ? undefined : end);
}

/** A code span shaped like a command line (flags or chaining), not a type/path name. */
const COMMAND_LINE_SPAN = /\s--?[A-Za-z]|&&|\|\s/u;
/** "Verify/check ... with `cmd --flag`": a verification instruction naming a command line. */
const VERIFY_WITH = new RegExp(
  `(?<!${W})(?:verify|check|confirm|validate|kiểm\\s+chứng|xác\\s+minh)(?!${W})[^\\n.;!?]{0,80}?(?<!${W})(?:with|using|via|bằng)\\s+\`([^\`\\n]+)\``,
  "giu",
);
/** "<run directive> ...:" followed by a list item that is a code span. */
const LIST_ITEM_SPAN = /^\s*(?:[-*]|\d+[.)])?\s*`([^`\n]+)`/u;

function directiveBlocked(text: string, index: number): boolean {
  const clause = clauseBefore(text, index);
  // A quoted example (e.g. "run `x`") is text to write, not an instruction.
  return NEGATED.test(clause) || NON_DIRECTIVE_PREFIX.test(clause) || /["“„«]\s*$/u.test(clause);
}

function listedCommand(rest: string): string | undefined {
  const lineEnd = rest.indexOf("\n");
  if (lineEnd < 0 || !/:\s*$/u.test(rest.slice(0, lineEnd))) return undefined;
  const next = rest
    .slice(lineEnd + 1)
    .split("\n")
    .find((line) => line.trim());
  return next ? LIST_ITEM_SPAN.exec(next)?.[1] : undefined;
}

/**
 * Conservative detector for an explicit instruction to execute commands.
 * Matches an imperative run verb whose same-clause object is a code span, a
 * `Run: <cmd>` line, a build/test/command noun, or a "run ...:" line followed
 * by a listed code span; plus "verify ... with `cmd --flag`". Skips
 * prohibitions ("do not run"), past facts ("was run", "đã chạy"), nouns ("the
 * last run", "run command"), conditionals ("if you run"), locations ("run from
 * `dir`"), quoted examples and descriptions ("how to run"). Mentioning a
 * command without a directive (e.g. "confirm README documents `npm test`")
 * never matches. Spans that native grep/read_file already cover are ignored.
 */
export function detectCommandRequirements(text: string): CommandRequirement[] {
  const hits: CommandRequirement[] = [];
  for (const match of text.matchAll(RUN_VERB)) {
    const index = match.index ?? 0;
    if (directiveBlocked(text, index)) continue;
    const rest = text.slice(index + match[0].length);
    if (NOT_AN_OBJECT.test(rest)) continue;
    const span = CODE_SPAN.exec(rest);
    const commandSpan = (span && !LOCATION_LEAD.test(span[1] ?? "") ? span[2] : undefined) ?? listedCommand(rest);
    if (commandSpan !== undefined && NATIVE_READ_COMMAND.test(commandSpan)) continue;
    const kind: CommandRequirement["kind"] | undefined =
      COLON_COMMAND.test(rest) || commandSpan !== undefined || COMMAND_OBJECT.test(rest)
        ? "command"
        : TESTS_OBJECT.test(rest)
          ? "tests"
          : undefined;
    if (!kind) continue;
    const listed = commandSpan !== undefined && !lineAt(text, index).includes(commandSpan) ? ` → ${commandSpan}` : "";
    hits.push({ kind, evidence: `${lineAt(text, index).trim()}${listed}`.slice(0, 160) });
  }
  for (const match of text.matchAll(VERIFY_WITH)) {
    const index = match.index ?? 0;
    const command = match[1] ?? "";
    if (!COMMAND_LINE_SPAN.test(command) || NATIVE_READ_COMMAND.test(command) || directiveBlocked(text, index))
      continue;
    hits.push({ kind: "command", evidence: lineAt(text, index).trim().slice(0, 160) });
  }
  return hits;
}

/**
 * Refuse a dispatch whose task explicitly requires command execution that the
 * requested worker's effective grant cannot perform. Returns undefined when the
 * grant can run it or the task has no explicit run directive.
 */
export function workerCommandCapabilityError(request: TaskRequest): string | undefined {
  const scoped = request.writeScope !== undefined;
  if (!scoped && !request.reviewOf) return undefined;
  const hits = detectCommandRequirements(`${request.description ?? ""}\n${request.prompt ?? ""}`).filter(
    (hit) =>
      // A reviewOf worker has verification_run for existing JS/TS/Python test
      // files, so generic "run the tests" or a runnable test file is not refused.
      scoped || (hit.kind === "command" && !VERIFICATION_RUNNABLE.test(hit.evidence)),
  );
  const hit = hits[0];
  if (!hit) return undefined;
  const grant = scoped
    ? `agent=${request.agent} with writeScope receives native file tools only (${SCOPED_WORKER_TOOL_NAMES.join(", ")}); no shell, MCP, LSP or verification_run`
    : `agent=${request.agent} with reviewOf receives the static review toolset only (${REVIEW_TOOL_NAMES.join(", ")}); verification_run executes existing JS/TS/Python test files only and there is no shell`;
  const route = scoped
    ? "Keep the edit in this scoped worker without the run instruction, then dispatch the command step separately to an execution-capable worker: task agent=verify without writeScope/reviewOf (build/test), or agent=general without writeScope (legacy shared execution, not isolated)."
    : "Dispatch the command step to task agent=verify without reviewOf (execution-capable), then use reviewOf for static acceptance of that saved result.";
  logger.file("warn", "orchestrator", "Worker dispatch refused: task requires commands the grant cannot run", {
    agent: request.agent,
    scoped,
    reviewOf: request.reviewOf?.jobId,
    evidence: hit.evidence,
  });
  return `worker_capability_refused: the task explicitly requires running commands ("${hit.evidence}") but ${grant}. No worker was started. ${route} If this worker must not run anything, remove the run instruction or state it as a prohibition ("do not run ...").`;
}

/** Records/requests the overlap guard reasons about. */
export interface WriterLike {
  id?: string;
  agent: string;
  cwd: string;
  kind?: string;
  reviewOf?: unknown;
  planReview?: unknown;
  planRevalidation?: unknown;
  writeScope?: string[];
  /** Canonical absolute targets, index-aligned with writeScope. */
  writeScopeTargets?: string[];
}

/** True when the worker can change workspace files (native writes or shell). */
export function isWriteCapable(job: WriterLike): boolean {
  if (job.kind === "council" || job.reviewOf || job.planReview || job.planRevalidation) return false;
  if (ASK_MODE_WORKER_AGENTS.has(job.agent)) return false;
  return !(Array.isArray(job.writeScope) && job.writeScope.length === 0);
}

interface FootprintEntry {
  target: string;
  recursive: boolean;
}

function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch (err) {
    // A deleted/unreadable workspace still bounds the job lexically; never drop it.
    logger.file("warn", "orchestrator", "Overlap guard could not canonicalize cwd; using lexical path", {
      cwd,
      error: err instanceof Error ? err.message : String(err),
    });
    return path.resolve(cwd);
  }
}

/** Unscoped writers (legacy shared execution) may write anywhere under cwd. */
function footprint(job: WriterLike): FootprintEntry[] {
  if (job.writeScope === undefined) return [{ target: canonicalCwd(job.cwd), recursive: true }];
  const root = canonicalCwd(job.cwd);
  return job.writeScope.map((raw, i) => ({
    target: job.writeScopeTargets?.[i] ?? path.resolve(root, raw),
    recursive: /[\\/]$/.test(raw),
  }));
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function entriesOverlap(a: FootprintEntry, b: FootprintEntry): boolean {
  if (path.relative(a.target, b.target) === "") return true;
  return (a.recursive && inside(a.target, b.target)) || (b.recursive && inside(b.target, a.target));
}

export interface WriteOverlap {
  jobId: string;
  agent: string;
  runningScoped: boolean;
}

/** First RUNNING write-capable job whose write footprint intersects the new dispatch. */
export function findWriteOverlap(next: WriterLike, running: readonly WriterLike[]): WriteOverlap | undefined {
  if (!isWriteCapable(next)) return undefined;
  const mine = footprint(next);
  for (const job of running) {
    if (!job.id || !isWriteCapable(job)) continue;
    const theirs = footprint(job);
    if (mine.some((a) => theirs.some((b) => entriesOverlap(a, b))))
      return { jobId: job.id, agent: job.agent, runningScoped: job.writeScope !== undefined };
  }
  return undefined;
}

export function formatWriteOverlapRefusal(next: WriterLike, overlap: WriteOverlap): string {
  const nextScoped = next.writeScope !== undefined;
  const reason =
    nextScoped && overlap.runningScoped
      ? "its writeScope overlaps the running job's writeScope"
      : !nextScoped && !overlap.runningScoped
        ? "both are unscoped (legacy shared) writers in the same workspace"
        : "an unscoped (legacy shared) writer may write anywhere in the workspace, so it overlaps every other writer there";
  return `worker_write_overlap_refused: running jobId=${overlap.jobId} (agent=${overlap.agent}) is a write-capable worker and ${reason}. No worker was started. Wait for jobId=${overlap.jobId} to finish, delegation_kill it, instruct it with delegation_send({id:"${overlap.jobId}", ...}) (a scoped job can be narrowed with writeScope), or dispatch with a disjoint writeScope.`;
}
