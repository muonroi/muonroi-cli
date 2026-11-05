/**
 * src/cli/flow-metrics-classify.ts
 *
 * Pure classifiers behind `muonroi-cli usage flow-metrics`. Every rule here
 * reads a STRUCTURED field the host recorded (a job's kind/agent/planReview/
 * council/reviewOf binding, a tool's recorded input path, a tool result's
 * success flag, a host-emitted JSON outcome) — never the free-text prompt or
 * description a model wrote. The earlier ad-hoc audit classified delegations
 * with a regex over the prompt text and overcounted (it matched "do not run
 * dotnet" as a build step); these rules cannot make that mistake because they
 * never look at prose.
 *
 * The rules are deliberately explicit constants so a reader can check a
 * number by hand, and so a change to them is a reviewed diff, not drift.
 */

import { workerFailureRecovery } from "../orchestrator/worker-failure-recovery.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

/**
 * Extensions that count as implementation: source code plus the build/project
 * files that make it compile. Data/config/doc formats (.md, .json, .yaml,
 * .txt) are NOT implementation — a worker that only wrote a report or a
 * PLAN.md did not implement anything.
 */
export const IMPLEMENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cs",
  ".csproj",
  ".fs",
  ".fsproj",
  ".vb",
  ".vbproj",
  ".props",
  ".targets",
  ".sln",
  ".slnx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".m",
  ".mm",
  ".rb",
  ".php",
  ".dart",
  ".lua",
  ".sql",
  ".proto",
  ".gradle",
]);

/**
 * Directory segments whose files are never implementation even with a code
 * extension: agent planning/metadata stores, VCS/build output, and scratch
 * areas (a preflight scanner script under `notes/` is investigation tooling,
 * not the deliverable).
 */
export const NON_IMPLEMENTATION_DIRS: ReadonlySet<string> = new Set([
  ".planning",
  ".muonroi-flow",
  ".muonroi-cli",
  ".git",
  "node_modules",
  "bin",
  "obj",
  "dist",
  "notes",
  "scratch",
  "tmp",
  "temp",
]);

/** Directory segments that hold planning artifacts. */
export const PLANNING_DIRS: ReadonlySet<string> = new Set([".planning", ".muonroi-flow"]);

/** Planning artifact basenames (case-insensitive) wherever they live. */
export const PLANNING_BASENAMES: ReadonlySet<string> = new Set([
  "plan.md",
  "roadmap.md",
  "state.md",
  "requirements.md",
  "assessment.md",
  "verify.md",
]);

export type PathKind = "implementation" | "planning" | "other" | "outside-workspace" | "unknown";

/**
 * Normalize a recorded path to forward slashes, a lower-case drive letter and
 * `d:/` form for git-bash `/d/...` paths. Relative paths resolve against cwd.
 */
export function normalizePath(p: string, cwd: string): string {
  const fix = (s: string): string => {
    let out = s.replace(/\\/g, "/").replace(/\/+/g, "/");
    const bash = /^\/([a-zA-Z])\//.exec(out);
    if (bash) out = `${bash[1]!.toLowerCase()}:/${out.slice(3)}`;
    if (/^[a-zA-Z]:/.test(out)) out = out[0]!.toLowerCase() + out.slice(1);
    return out.replace(/\/$/, "");
  };
  const base = fix(cwd);
  const raw = fix(p.trim());
  const absolute = /^[a-z]:\//.test(raw) || raw.startsWith("/");
  const joined = absolute ? raw : `${base}/${raw.replace(/^\.\//, "")}`;
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "." || seg === "") {
      if (parts.length === 0) parts.push("");
      continue;
    }
    if (seg === ".." && parts.length > 1) parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function isWithin(child: string, parent: string): boolean {
  const caseless = /^[a-z]:\//.test(parent);
  const c = caseless ? child.toLowerCase() : child;
  const p = caseless ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Classify one written path. `implExtensions` narrows the implementation set
 * (e.g. `[".cs"]` to ask "when was the first C# file written?").
 */
export function classifyPath(rawPath: string | undefined, cwd: string, implExtensions?: ReadonlySet<string>): PathKind {
  if (!rawPath?.trim()) return "unknown";
  const full = normalizePath(rawPath, cwd);
  const root = normalizePath(cwd, cwd);
  if (!isWithin(full, root)) return "outside-workspace";
  const rel = full.slice(root.length).replace(/^\//, "");
  const segments = rel.split("/");
  const basename = (segments[segments.length - 1] ?? "").toLowerCase();
  const dirs = segments.slice(0, -1).map((s) => s.toLowerCase());
  if (dirs.some((d) => PLANNING_DIRS.has(d)) || PLANNING_BASENAMES.has(basename)) return "planning";
  if (dirs.some((d) => NON_IMPLEMENTATION_DIRS.has(d))) return "other";
  const dot = basename.lastIndexOf(".");
  const ext = dot > 0 ? basename.slice(dot) : "";
  return (implExtensions ?? IMPLEMENTATION_EXTENSIONS).has(ext) ? "implementation" : "other";
}

/** The input key a write/edit tool records its target under. */
export function writeTargetOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "filePath"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Tools whose recorded input names the single file they mutate. */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

// ---------------------------------------------------------------------------
// Delegation purpose
// ---------------------------------------------------------------------------

export type DelegationPurpose =
  | "implementation"
  | "plan-edit"
  | "council"
  | "plan-review"
  | "review"
  | "preflight"
  | "impl-support"
  | "other";

export const DELEGATION_PURPOSES: readonly DelegationPurpose[] = [
  "implementation",
  "impl-support",
  "plan-edit",
  "council",
  "plan-review",
  "review",
  "preflight",
  "other",
];

/** The structured slice of a stored delegation the purpose rules read. */
export interface PurposeInput {
  agent: string;
  kind?: string;
  startedAt: string;
  hasCouncil: boolean;
  hasPlanReview: boolean;
  hasPlanRevalidation: boolean;
  hasReviewOf: boolean;
  /** Successful writes this job made, already path-classified. */
  successfulWriteKinds: PathKind[];
}

/**
 * First matching rule wins:
 *  1. council       — job kind is "council" or it carries a council brief.
 *  2. plan-review   — job is bound to a plan review (planReview) or is a
 *                     host plan revalidation (planRevalidation).
 *  3. review        — job reviews another job (reviewOf/hostReview) or was
 *                     dispatched as the read-only `verify` agent.
 *  4. implementation — job made >=1 SUCCESSFUL write to an implementation path.
 *  5. plan-edit     — job made >=1 successful write to a planning artifact.
 *  6. preflight     — none of the above, started before the session's first
 *                     implementation write (or the session never wrote one):
 *                     probes, surveys, scanner scripts, reports.
 *  7. impl-support  — none of the above, started at/after the first
 *                     implementation write: build/test gates, diagnostics.
 *  8. other         — startedAt is unparseable, so the phase is unknown.
 */
export function classifyDelegationPurpose(
  job: PurposeInput,
  firstImplementationWriteAt: string | null,
): DelegationPurpose {
  if (job.kind === "council" || job.hasCouncil) return "council";
  if (job.hasPlanReview || job.hasPlanRevalidation) return "plan-review";
  if (job.hasReviewOf || job.agent === "verify") return "review";
  if (job.successfulWriteKinds.includes("implementation")) return "implementation";
  if (job.successfulWriteKinds.includes("planning")) return "plan-edit";
  const started = Date.parse(job.startedAt);
  if (!Number.isFinite(started)) return "other";
  if (firstImplementationWriteAt === null) return "preflight";
  const first = Date.parse(firstImplementationWriteAt);
  return started < first ? "preflight" : "impl-support";
}

// ---------------------------------------------------------------------------
// Worker failure
// ---------------------------------------------------------------------------

export type FailureCategory =
  | "cancelled"
  | "rate-limited"
  | "missing-final-answer"
  | "output-limit"
  | "model-message-schema"
  | `provider-http-${number}`
  | "unclassified";

/**
 * Category of a non-complete job. Reuses the host's own terminal-marker
 * classification (`workerFailureRecovery`), adds the cancelled/rate-limited
 * states the job record carries, and the provider HTTP status the sub-agent
 * runner flattens into its `Task failed: HTTP <code>` marker.
 */
export function classifyWorkerFailure(job: {
  status: string;
  error?: string;
  failureKind?: string;
}): FailureCategory | null {
  if (job.status === "complete" || job.status === "running") return null;
  if (job.status === "cancelled") return "cancelled";
  if (job.failureKind === "rate-limited") return "rate-limited";
  const symptom = workerFailureRecovery({ error: job.error }).symptom;
  if (symptom !== "unclassified") return symptom as FailureCategory;
  const error = job.error ?? "";
  const marker = error.lastIndexOf("Task failed:");
  if (marker >= 0) {
    const status = /^HTTP (\d{3})\b/.exec(error.slice(marker + "Task failed:".length).trim());
    if (status) return `provider-http-${Number(status[1])}`;
  }
  return "unclassified";
}

// ---------------------------------------------------------------------------
// Orchestrator tool calls
// ---------------------------------------------------------------------------

/**
 * Tools that move no work forward on their own: delegation mail handling,
 * ledger/context upkeep, capability lookups and status reads. The audit
 * question is "how much of the orchestrator's loop is spent on these".
 */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  "delegation_read",
  "delegation_ack",
  "delegation_list",
  "delegation_send",
  "delegation_accept",
  "delegation_cancel",
  "context_load",
  "worker_models",
  "worker_capabilities",
  "flow_status",
  "todo_write",
  "retrieve_tool_result",
  "compact",
]);

/** Tools that hand work to a worker job. */
export const DISPATCH_TOOLS: ReadonlySet<string> = new Set(["task", "delegate"]);

// ---------------------------------------------------------------------------
// flow_plan_review outcomes
// ---------------------------------------------------------------------------

export type PlanReviewOutcome = "dispatched" | "completed" | "refused" | "unparsed";

export interface PlanReviewCallOutcome {
  action: string;
  outcome: PlanReviewOutcome;
  /** For refusals: the host's reason token, e.g. `stale_plan_review`. */
  reason?: string;
  /** For completed rounds: the recorded review verdict (pass/revise/block). */
  verdict?: string;
  /** For completed rounds: whether the host marked the plan verified. */
  planVerified?: boolean;
}

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch (err) {
    // Non-JSON payload (e.g. the host's duplicate-call stub) is a legitimate
    // "unparsed" outcome, reported as such by the caller — not an error.
    logger.debug("cli", "flow-metrics: non-JSON tool payload", {
      error: err instanceof Error ? err.message : String(err),
      head: text.slice(0, 80),
    });
    return null;
  }
}

/**
 * Classify one flow_plan_review call from its recorded args and the host's
 * JSON result (the tool wraps its payload as `{success, output: "<json>"}`).
 */
export function classifyPlanReviewCall(argsJson: string | null, outputJson: string | null): PlanReviewCallOutcome {
  const args = parseJsonObject(argsJson);
  const action = typeof args?.action === "string" ? args.action : "unknown";
  const wrapper = parseJsonObject(outputJson);
  const inner = parseJsonObject(wrapper?.output) ?? null;
  if (!inner) return { action, outcome: "unparsed" };
  if (typeof inner.completedJobId === "string") {
    const review = inner.review as { verdict?: unknown } | undefined;
    return {
      action,
      outcome: "completed",
      verdict: typeof review?.verdict === "string" ? review.verdict : undefined,
      planVerified: inner.planVerified === true,
    };
  }
  if (inner.pending === true) return { action, outcome: "dispatched" };
  if (inner.ok === false) {
    const message = typeof inner.message === "string" ? inner.message : "";
    const receipt = inner.receipt as { output?: unknown } | undefined;
    const receiptText = typeof receipt?.output === "string" ? receipt.output : "";
    const token = /^([a-z][a-z_]+):/.exec(message) ?? /^([a-z][a-z_]+):/.exec(receiptText);
    const reason = token?.[1] ?? (typeof inner.code === "string" ? inner.code : "refused");
    return { action, outcome: "refused", reason };
  }
  return { action, outcome: "unparsed" };
}
