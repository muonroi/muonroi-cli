/**
 * src/tools/native-tools.ts
 *
 * NATIVE in-process builtins for the capabilities that muonroi-tools previously
 * exposed only via a self-spawned MCP subprocess: ee_feedback, ee_write,
 * usage_forensics, lsp_query, setup_guide, and selfverify_* (start/status/
 * result/list/cancel). EE health is ee_query(action="health") in registry.ts.
 *
 * Why native: muonroi-tools is THIS CLI. Self-spawning a 137MB CLI as an MCP
 * server per turn cold-started ~2-3.5s and overran the build deadline (and a
 * seed-time bug once persisted a vitest-worker command that crashed on launch).
 * For the CLI's OWN inner agent these tools should run in-process — no subprocess,
 * no MCP round-trip, no cold-start. The muonroi-tools MCP server (tools-server.ts)
 * stays for EXTERNAL agents (Claude Code etc.). `ee_query` is already native
 * (registry.ts) and is intentionally NOT duplicated here.
 *
 * Each tool reuses the SAME core the MCP server wraps (ee/search, cli/cost-
 * forensics, lsp/runtime, the shared self-verify JobManager), so behaviour is
 * identical across the two surfaces.
 */

import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { FORENSICS_TOOL_DESCRIPTION } from "../cli/forensics-diagnostics.js";
import { isConcreteEEProject, NativeEEContext } from "../ee/native-context.js";
import { deriveNoiseReason, hintScopeOf } from "../ee/noise-reason.js";
import { resolveEERepository } from "../ee/project-identity.js";
import type { PendingRecall } from "../ee/recall-ledger.js";
import { LSP_TOOL_OPERATIONS, LspError } from "../lsp/types.js";
import { getSelfVerifyJobManager } from "../mcp/self-verify-runner.js";
import { SETUP_GUIDE_TEXT } from "../mcp/setup-guide-text.js";
import { beginBoundedWorkerWait, endBoundedWorkerWait } from "../orchestrator/interactive-pause.js";
import { detectLanguage } from "../pil/layer15-context-scan.js";
import { validateSelfVerifyRequest } from "../self-qa/validate-request.js";
import { integrationHealth } from "../utils/integration-health.js";
import { logger, redactSecrets } from "../utils/logger.js";
import { hasSemanticHarness } from "../utils/semantic-harness.js";
import { runVerificationTests, VERIFICATION_RUNNERS } from "./verification-run.js";

/** Map a thrown error to the LspError tagged-union shape. */
function mapLspError(e: unknown): LspError {
  if (e instanceof LspError) return e;
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    return new LspError((e as any).kind, (e as any).message);
  }
  return new LspError("unknown", e instanceof Error ? e.message : String(e));
}

function lspErrLine(e: unknown): string {
  const err = mapLspError(e);
  return JSON.stringify({ error: err.kind, message: err.message });
}

/** The native tool names this module registers — used by the MCP-twin dedup. */
export const NATIVE_MUONROI_TOOL_NAMES = [
  "integration_status",
  "ee_feedback",
  "ee_write",
  "usage_forensics",
  "lsp_query",
  "wait_for_diagnostics",
  "impact_of_change",
  "lsp_mutation_preview",
  "setup_guide",
  "verification_run",
  "selfverify_start",
  "selfverify_status",
  "selfverify_result",
  "selfverify_list",
  "selfverify_cancel",
] as const;

/** Upper bound of the selfverify_result host wait (agentic runs take minutes). */
const SELFVERIFY_RESULT_MAX_WAIT_MS = 600_000;

const json = (data: unknown): string => JSON.stringify(data);
const errLine = (error: string, message: string): string => `ERROR ${error}: ${message}`;

export interface NativeToolOpts {
  /** Workspace cwd for lsp_query. Defaults to process.cwd(). */
  cwd?: string;
  getCwd?: () => string;
  eeContext?: NativeEEContext;
}

/**
 * Add the native muonroi-tools builtins to `tools`. Mutates and returns it.
 */
export function registerNativeMuonroiTools(tools: ToolSet, opts: NativeToolOpts = {}): ToolSet {
  tools.integration_status = dynamicTool({
    description:
      "Read recent persisted integration checks. Connection, executed tools and toolchain failures are separate facts, not a global readiness certification. Optional failures do not block unrelated work.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { hours: { type: "integer", minimum: 1, maximum: 168 } },
      additionalProperties: false,
    }),
    execute: async (input: any) => json(integrationHealth(input?.hours ?? 24)),
  });
  const eeContext = opts.eeContext ?? new NativeEEContext(crypto.randomUUID(), opts.cwd ?? process.cwd());
  const alignEE = () => eeContext.alignCwd(opts.getCwd?.() ?? opts.cwd ?? process.cwd());
  tools.verification_run = dynamicTool({
    description:
      "Run explicit existing runnable local test files without shell commands or dependency downloads. Markdown/document content checks use read_file/grep, not this runner. runner=auto selects a single installed Vitest/Jest/Mocha, or pytest for Python files using .venv. Multiple JS runners require explicit selection. runner=node runs JavaScript node:test files. No arbitrary package scripts; use bash for other repo workflows/builds. Returns runner, command, cwd, exit and output. Tests can write fixtures/cache; this does not require a source-edit plan.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        cwd: { type: "string" },
        files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
        timeoutMs: { type: "number", minimum: 100, maximum: 300000 },
        runner: { type: "string", enum: [...VERIFICATION_RUNNERS] },
      },
      required: ["files"],
      additionalProperties: false,
    }),
    execute: async (input: any, context) => {
      try {
        return json(
          await runVerificationTests(
            input?.cwd ?? opts.cwd ?? process.cwd(),
            input?.files,
            input?.timeoutMs,
            context.abortSignal,
            input?.runner,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[verification-run] Invalid workspace or runner: ${message}`);
        return errLine("verification_failed", message);
      }
    },
  });
  // ── Experience Engine: feedback + write (ee_query, incl. action=health, lives in registry.ts) ──
  // ee_health is no longer a standalone tool: measured 25 calls lifetime, all
  // 2026-10-16..19 and none after (muonroi.db tool_calls), while its schema rode
  // every model step. tool-engine drops an mcp_muonroi-tools__ee_health twin
  // when native ee_query is present.

  // Noise reason from facts, not model judgment: the hint's stored scope (when
  // the recall/injection response carried it) vs this task's project/language.
  const deriveFeedbackReason = (requested: unknown, pending: PendingRecall | undefined) => {
    const known = ["wrong_repo", "wrong_language", "wrong_task", "stale_rule"] as const;
    const asked = known.find((r) => r === requested);
    const scope = eeContext.scope();
    const repo = resolveEERepository(scope.cwd);
    const derivation = deriveNoiseReason(asked, pending ? hintScopeOf(pending) : undefined, {
      project: scope.project ?? repo?.project,
      lang: detectLanguage(repo?.root ?? scope.cwd),
    });
    if (derivation.derived)
      logger.file("info", "ee", "ee_feedback noise reason derived by host", {
        requested: asked ?? null,
        reason: derivation.reason,
        basis: derivation.basis,
      });
    return derivation;
  };

  tools.ee_feedback = dynamicTool({
    description:
      "Rate a recalled/injected `[id col]` hint after acting on it. verdict: followed (it changed your approach), " +
      "ignored (topical, did not apply), noise (wrong here). For noise the host derives wrong_repo/wrong_language " +
      "from the hint's stored scope; give reason only for stale_rule or wrong_task. id may be a short prefix.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        id: { type: "string" },
        collection: { type: "string" },
        verdict: { type: "string", enum: ["followed", "ignored", "noise"] },
        reason: { type: "string", enum: ["wrong_repo", "wrong_language", "wrong_task", "stale_rule"] },
      },
      required: ["id", "collection", "verdict"],
    }),
    execute: async (input: any) => {
      const id = typeof input?.id === "string" ? input.id.trim() : "";
      const collection = typeof input?.collection === "string" ? input.collection.trim() : "";
      const verdict = input?.verdict;
      if (!id || !collection || !verdict) {
        return errLine("invalid_args", "ee_feedback requires id, collection, and verdict");
      }
      try {
        const { feedbackEE } = await import("../ee/search.js");
        const { sessionRecallLedger } = await import("../ee/recall-ledger.js");
        alignEE();
        const derivation =
          verdict === "noise" ? deriveFeedbackReason(input?.reason, sessionRecallLedger.find(id, collection)) : null;
        const reason = derivation?.reason ?? (verdict === "noise" ? undefined : input?.reason);
        if (verdict === "noise" && !reason) {
          return errLine(
            "reason_required",
            "the host found no scope mismatch for this hint (its stored scope is unknown or matches this session's project/language); pass reason stale_rule (outdated API/version) or wrong_task",
          );
        }
        const result = await feedbackEE(id, collection, verdict, reason, eeContext.feedbackScope(id, collection));
        // A queued result (brain unreachable → durably enqueued) counts as success:
        // the agent has discharged its rating, so clear the ledger regardless. This
        // is what stops the mandatory-rating gate from looping while the brain is
        // down — the previous "return early, don't clear" path re-nagged every turn.
        if (!result.ok) return errLine("feedback_failed", result.error ?? "feedback POST failed");
        const clearedId = result.resolvedId ?? id;
        sessionRecallLedger.clear(clearedId);
        sessionRecallLedger.clear(id);
        return json({
          ok: true,
          id: clearedId,
          verdict: result.verdict,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(derivation?.derived ? { reasonSource: "host", basis: derivation.basis } : {}),
          ...(result.queued ? { queued: true } : {}),
          pendingRemaining: sessionRecallLedger.pendingCount(),
        });
      } catch (e) {
        logger.file("warn", "ee", "Native EE feedback failed", { error: e instanceof Error ? e.message : String(e) });
        return errLine("feedback_failed", e instanceof Error ? e.message : String(e));
      }
    },
  });

  tools.ee_write = dynamicTool({
    description:
      "Save a new lesson once you have found the fix for a mistake or dead-end: the pitfall and the fix in 1-3 " +
      "generalizable sentences (not a log of this turn). Recallable at once via ee_query. Project scope is taken " +
      "from this task's verified recall scope; experience-principles is for project-independent principles.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        lesson: { type: "string" },
        title: { type: "string", description: "<=120 chars" },
        project: { type: "string", description: "Concrete EE project slug" },
        collection: { type: "string", enum: ["experience-behavioral", "experience-principles"] },
      },
      required: ["lesson"],
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const lesson = typeof input?.lesson === "string" ? input.lesson.trim() : "";
      if (lesson.length < 12) {
        return errLine("invalid_args", "ee_write requires a non-empty, substantive lesson (>=12 chars)");
      }
      // Cap oversized bodies (EE import-quality rule: bare points >1500 chars are
      // status-dumps, not lessons).
      const text = lesson.length > 1500 ? `${lesson.slice(0, 1497)}...` : lesson;
      const collection =
        input?.collection === "experience-principles" ? "experience-principles" : "experience-behavioral";
      const title =
        typeof input?.title === "string" && input.title.trim() ? input.title.trim().slice(0, 120) : undefined;
      alignEE();
      if (input?.project !== undefined && !isConcreteEEProject(input.project))
        return errLine(
          "invalid_scope",
          "project must be a concrete EE slug; discover it with ee_query(action=projects)",
        );
      const project =
        input?.project ?? (collection === "experience-principles" ? undefined : eeContext.scope().project);
      if (collection !== "experience-principles" && !project)
        return "[ee_project_required] Resolve this task's project with native ee_query({query: ..., cwd: ...}) first, or pass ee_write's explicit project. No lesson was written; folder names are not authoritative project slugs.";
      try {
        const { writeExperienceEE } = await import("../ee/search.js");
        // confidence 0.65 (above the import default 0.6): an agent-asserted lesson
        // is deliberate but unproven — the ee_feedback loop then tunes it.
        const result = await writeExperienceEE(text, {
          collection,
          title,
          projectSlug: project,
          confidence: 0.65,
        });
        if (!result.ok) return errLine("write_failed", result.error ?? "import-memory POST failed");
        return json({
          ok: true,
          id: result.id,
          collection,
          project: project ?? null,
          recallable: "now — same session via ee_query",
        });
      } catch (e) {
        logger.file("warn", "ee", "Native EE lesson write failed", {
          error: e instanceof Error ? e.message : String(e),
        });
        return errLine("write_failed", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── Self-diagnostics: usage_forensics ─────────────────────────────────────
  tools.usage_forensics = dynamicTool({
    description: FORENSICS_TOOL_DESCRIPTION,
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        prefix: { type: "string", minLength: 1, maxLength: 100, description: "Session id prefix" },
        until: {
          type: "string",
          description: "Snapshot cutoff timestamp. Reuse returned snapshot.until for later pages.",
        },
        usage_offset: { type: "integer", minimum: 0 },
        error_offset: { type: "integer", minimum: 0 },
        measurement_offset: { type: "integer", minimum: 0 },
      },
      required: ["prefix"],
    }),
    execute: async (input: any) => {
      const prefix = typeof input?.prefix === "string" ? input.prefix.trim() : "";
      if (!prefix || prefix.length > 100)
        return errLine("invalid_args", "usage_forensics requires a prefix of 1-100 characters");
      const offsets = [input.usage_offset, input.error_offset, input.measurement_offset];
      if (offsets.some((x) => x !== undefined && (!Number.isSafeInteger(x) || x < 0)))
        return errLine("invalid_args", "Offsets must be non-negative integers");
      if (input.until !== undefined && (typeof input.until !== "string" || !Number.isFinite(Date.parse(input.until))))
        return errLine("invalid_args", "until must be a valid timestamp");
      try {
        const { resolveSessionIds, collectCostForensics } = await import("../cli/cost-forensics.js");
        const ids = await resolveSessionIds(prefix);
        if (ids.length === 0) return errLine("not_found", `no session matches prefix '${prefix}'`);
        if (ids.length > 1) return errLine("ambiguous", `prefix '${prefix}' matched ${ids.length} sessions`);
        return json(
          await collectCostForensics(ids[0]!, {
            until: input.until,
            usageOffset: input.usage_offset ?? 0,
            errorOffset: input.error_offset,
            measurementOffset: input.measurement_offset,
          }),
        );
      } catch (e) {
        logger.file("warn", "storage", "Native usage_forensics failed", { error: e });
        return errLine("db_error", redactSecrets(e instanceof Error ? e.message : String(e)));
      }
    },
  });

  // ── Code intelligence: lsp_query ──────────────────────────────────────────
  tools.lsp_query = dynamicTool({
    description:
      "Semantic code intelligence via language servers. operation is one of: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls. " +
      "filePath: absolute, or relative to the workspace root. line/character: 1-based — required for position-based ops; omit for documentSymbol; use query (not position) for workspaceSymbol. Returns {success, output}.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        operation: { type: "string", enum: [...LSP_TOOL_OPERATIONS] },
        filePath: { type: "string", description: "Absolute or workspace-relative path" },
        line: { type: "number", description: "1-based line (position ops)" },
        character: { type: "number", description: "1-based character (position ops)" },
        query: { type: "string", description: "Symbol query (workspaceSymbol)" },
      },
      required: ["operation", "filePath"],
    }),
    execute: async (input: any) => {
      const cwd = opts.cwd ?? process.cwd();
      try {
        const { queryLsp, isLspToolEnabled } = await import("../lsp/runtime.js");
        if (!(await isLspToolEnabled(cwd))) {
          return errLine("lsp_disabled", "LSP tool is disabled in settings (lsp.enabled / lsp.tool)");
        }
        return json(await queryLsp(cwd, input));
      } catch (e) {
        return errLine("lsp_error", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── Sprint 1: readiness contract tools ─────────────────────────────────────
  tools.wait_for_diagnostics = dynamicTool({
    description:
      "Wait for LSP diagnostics on a file, with timeout clamping (default 1500ms, max 5000ms). " +
      "Returns { diagnostics: LspDiagnostic[], lspStatus: 'ok'|'partial'|'unavailable', clean: boolean, metadata: { tokenBudgetUsed } }. " +
      "clean=true means zero error-level diagnostics; assess completeness with lspStatus. Text/config/log search can use grep directly without this prerequisite.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute or workspace-relative path" },
        timeout: { type: "number", description: "Timeout in ms (default 1500, max 5000)", optional: true },
      },
      required: ["filePath"],
    }),
    execute: async (input: any): Promise<string> => {
      const cwd = opts.cwd ?? process.cwd();
      try {
        const { getOrCreateManager } = await import("../lsp/runtime.js");
        return json(await getOrCreateManager(cwd).waitForDiagnostics(input.filePath, input.timeout ?? 1500));
      } catch (e) {
        return lspErrLine(e);
      }
    },
  });

  tools.impact_of_change = dynamicTool({
    description:
      "Analyse impact of a change: returns { references, diagnostics, referencesComplete, safeToRename, clean, " +
      "suggestedGuard, degraded, lspStatus, metadata }. Use for semantic change impact, independently of text search. " +
      "safeToRename is true only when refs are complete and the union is clean.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute or workspace-relative path" },
        query: { type: "string", description: "Optional symbol query", optional: true },
      },
      required: ["filePath"],
    }),
    execute: async (input: any): Promise<string> => {
      const cwd = opts.cwd ?? process.cwd();
      const { getOrCreateManager } = await import("../lsp/runtime.js");
      return json(await getOrCreateManager(cwd).impactOfChange(input.filePath, input.query));
    },
  });

  tools.lsp_mutation_preview = dynamicTool({
    description:
      "Preview a mutation (stub — no real edits). Returns { op: 'allowlist', dryRunResult: { proposedEdits: [], " +
      "tokenEstimate: 0 }, schemaVersion: '1.0' }. MUTATION_TOOLS gating applies; no apply path in Sprint 1. This does not validate a real edit. For a concrete textual replacement preview use edit_file(dry_run=true) when exposed; applying uses normal edit guards.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        filePath: { type: "string", description: "File path" },
        change: { type: "string", description: "Change specification (stub)" },
      },
      required: ["filePath", "change"],
    }),
    execute: async (input: any): Promise<string> => {
      const cwd = opts.cwd ?? process.cwd();
      const { getOrCreateManager } = await import("../lsp/runtime.js");
      return json(await getOrCreateManager(cwd).lspMutationPreview(input.filePath, input.change));
    },
  });

  // ── Onboarding: setup_guide ───────────────────────────────────────────────
  tools.setup_guide = dynamicTool({
    description:
      "Returns the up-to-date setup / install / first-run / MCP wiring / verify guide for muonroi-cli. Call this " +
      "when the user asks how to set up, install, or get started — instead of guessing, reading files, or shelling commands.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => SETUP_GUIDE_TEXT,
  });

  // ── Self-QA harness: selfverify_* (shared JobManager, in-process) ──────────
  // Registered only where a Semantic harness exists (utils/semantic-harness.ts):
  // self-verify drives this CLI's TUI over `<Semantic>` IDs found in the
  // workspace, so elsewhere it can never produce a scenario and the five tools
  // (plus the prompt routing that names them) would be dead weight per call.
  if (!hasSemanticHarness(opts.getCwd?.() ?? opts.cwd ?? process.cwd())) return tools;
  tools.selfverify_start = dynamicTool({
    description:
      "Start a self-verify run (mode=tier1 heuristic, or mode=agentic LLM-driven). Returns {runId} immediately and runs in the background; " +
      "a completion notice arrives at your next step when it finishes. Keep working meanwhile; when you need the report, call selfverify_result — it waits for completion itself. Do not poll selfverify_status.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["tier1", "agentic"] },
        since: { type: "string" },
        cwd: { type: "string", description: "Workspace under test. Defaults to the calling shell cwd." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Exact task-owned files relative to cwd; skips whole-worktree diff selection.",
        },
        max: { type: "number" },
        emit: { type: "boolean" },
        out: { type: "string" },
        goal: { type: "string" },
        llm: { type: "string" },
        turns: { type: "number" },
        mockLlmDir: {
          type: "string",
          description:
            "Omit for bundled offline fixtures. 'none' enables real provider calls only in agentic mode; invalid in tier1.",
        },
      },
      required: ["mode"],
    }),
    execute: async (input: any) => {
      const invalid = validateSelfVerifyRequest(input ?? {});
      if (invalid) return errLine("invalid_args", invalid);
      const jm = getSelfVerifyJobManager();
      if (input?.mode === "agentic") {
        if (!input?.goal || !input?.llm) return errLine("invalid_args", "agentic mode requires both goal and llm");
        const { getModelInfo } = await import("../models/registry.js");
        if (!getModelInfo(input.llm)) return errLine("unknown_model", `llm '${input.llm}' is not in catalog.json`);
        return json({
          runId: jm.start({
            kind: "agentic",
            cwd: input.cwd ?? opts.cwd ?? process.cwd(),
            goal: input.goal,
            llm: input.llm,
            turns: input.turns,
            mockLlmDir: input.mockLlmDir,
          }),
        });
      }
      return json({
        runId: jm.start({
          kind: "tier1",
          cwd: input?.cwd ?? opts.cwd ?? process.cwd(),
          files: input?.files,
          mockLlmDir: input?.mockLlmDir,
          since: input?.since,
          max: input?.max,
          emit: input?.emit,
          out: input?.out,
        }),
      });
    },
  });

  tools.selfverify_status = dynamicTool({
    description: "Get status + log tail of a self-verify run (for diagnosis; completion is notified, do not poll).",
    inputSchema: jsonSchema({
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    }),
    execute: async (input: any) => {
      const job = getSelfVerifyJobManager().status(input?.runId);
      if (!job) return errLine("not_found", `runId ${input?.runId} not found`);
      getSelfVerifyJobManager().markReported(job.runId);
      const summary =
        job.report && job.kind === "tier1" && "summary" in job.report
          ? job.report.summary
          : job.report && job.kind === "agentic" && "verdict" in job.report
            ? { verdict: job.report.verdict }
            : null;
      return json({
        runId: job.runId,
        status: job.status,
        kind: job.kind,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
        logTail: job.logBuffer.slice(-40),
        summary,
        error: job.error,
      });
    },
  });

  tools.selfverify_result = dynamicTool({
    description:
      "Full report of a self-verify run. If the run is still going, the host waits for it to finish (bounded by waitMs, default 10 min) — no polling needed.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        runId: { type: "string" },
        waitMs: { type: "integer", minimum: 0, maximum: SELFVERIFY_RESULT_MAX_WAIT_MS },
      },
      required: ["runId"],
    }),
    execute: async (input: any, context) => {
      const jm = getSelfVerifyJobManager();
      let job = jm.status(input?.runId);
      if (!job) return errLine("not_found", `runId ${input?.runId} not found`);
      if (job.status === "running") {
        const waitMs = Math.min(
          SELFVERIFY_RESULT_MAX_WAIT_MS,
          Number.isSafeInteger(input?.waitMs) && input.waitMs >= 0 ? input.waitMs : SELFVERIFY_RESULT_MAX_WAIT_MS,
        );
        // Host I/O wait: pauses the idle/stall watchdogs, keeps the hard turn deadline.
        beginBoundedWorkerWait();
        try {
          job = (await jm.waitFor(job.runId, context?.abortSignal, waitMs)) ?? job;
        } finally {
          endBoundedWorkerWait();
        }
      }
      if (job.status === "running")
        return errLine("still_running", `run not finished after waiting; call selfverify_result again later`);
      jm.markReported(job.runId);
      if (job.status === "error") return errLine("run_error", job.error ?? "unknown error");
      if (job.status === "cancelled") return errLine("cancelled", "run was cancelled");
      return json(job.report ?? {});
    },
  });

  tools.selfverify_list = dynamicTool({
    description: "List recent self-verify runs.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () =>
      json(
        getSelfVerifyJobManager()
          .list()
          .map((j) => ({
            runId: j.runId,
            kind: j.kind,
            status: j.status,
            elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
          })),
      ),
  });

  tools.selfverify_cancel = dynamicTool({
    description: "Cancel a running self-verify run (best-effort).",
    inputSchema: jsonSchema({
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    }),
    execute: async (input: any) => json({ cancelled: getSelfVerifyJobManager().cancel(input?.runId) }),
  });

  return tools;
}
