/**
 * src/tools/native-tools.ts
 *
 * NATIVE in-process builtins for the capabilities that muonroi-tools previously
 * exposed only via a self-spawned MCP subprocess: ee_health, ee_feedback,
 * usage_forensics, lsp_query, setup_guide, and selfverify_* (start/status/
 * result/list/cancel).
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
import { LSP_TOOL_OPERATIONS } from "../lsp/types.js";
import { getSelfVerifyJobManager } from "../mcp/self-verify-runner.js";
import { SETUP_GUIDE_TEXT } from "../mcp/setup-guide-text.js";

/** The native tool names this module registers — used by the MCP-twin dedup. */
export const NATIVE_MUONROI_TOOL_NAMES = [
  "ee_health",
  "ee_feedback",
  "ee_write",
  "usage_forensics",
  "lsp_query",
  "setup_guide",
  "selfverify_start",
  "selfverify_status",
  "selfverify_result",
  "selfverify_list",
  "selfverify_cancel",
] as const;

const json = (data: unknown): string => JSON.stringify(data);
const errLine = (error: string, message: string): string => `ERROR ${error}: ${message}`;

export interface NativeToolOpts {
  /** Workspace cwd for lsp_query. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Add the native muonroi-tools builtins to `tools`. Mutates and returns it.
 */
export function registerNativeMuonroiTools(tools: ToolSet, opts: NativeToolOpts = {}): ToolSet {
  // ── Experience Engine: health + feedback (ee_query is already native) ──────
  tools.ee_health = dynamicTool({
    description: "Check Experience Engine server reachability (returns {ok, status}).",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => {
      try {
        const { healthEE } = await import("../ee/search.js");
        return json(await healthEE());
      } catch (e) {
        return errLine("ee_unavailable", e instanceof Error ? e.message : String(e));
      }
    },
  });

  tools.ee_feedback = dynamicTool({
    description:
      "Rate an Experience Engine recall entry so the brain keeps what helped and prunes the rest. Call after " +
      "acting on an ee_query result — once per `[id col]` you used or judged. verdict: 'followed' (you changed " +
      "your approach because of it), 'ignored' (topical but did not apply this time), 'noise' (wrong by category — " +
      "REQUIRES reason: wrong_repo | wrong_language | wrong_task | stale_rule). id may be a short prefix.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        id: { type: "string", description: "Entry id (short prefix accepted)" },
        collection: { type: "string", description: "EE collection the entry came from" },
        verdict: { type: "string", enum: ["followed", "ignored", "noise"] },
        reason: { type: "string", enum: ["wrong_repo", "wrong_language", "wrong_task", "stale_rule"] },
      },
      required: ["id", "collection", "verdict"],
    }),
    execute: async (input: any) => {
      const id = typeof input?.id === "string" ? input.id.trim() : "";
      const collection = typeof input?.collection === "string" ? input.collection.trim() : "";
      const verdict = input?.verdict;
      const reason = input?.reason;
      if (!id || !collection || !verdict) {
        return errLine("invalid_args", "ee_feedback requires id, collection, and verdict");
      }
      if (verdict === "noise" && !reason) {
        return errLine(
          "reason_required",
          "verdict 'noise' requires reason: wrong_repo | wrong_language | wrong_task | stale_rule",
        );
      }
      try {
        const { feedbackEE } = await import("../ee/search.js");
        const { sessionRecallLedger } = await import("../ee/recall-ledger.js");
        const result = await feedbackEE(id, collection, verdict, reason);
        if (!result.ok) return errLine("feedback_failed", result.error ?? "feedback POST failed");
        const clearedId = result.resolvedId ?? id;
        sessionRecallLedger.clear(clearedId);
        sessionRecallLedger.clear(id);
        return json({
          ok: true,
          id: clearedId,
          verdict: result.verdict,
          ...(result.reason ? { reason: result.reason } : {}),
          pendingRemaining: sessionRecallLedger.pendingCount(),
        });
      } catch (e) {
        return errLine("feedback_failed", e instanceof Error ? e.message : String(e));
      }
    },
  });

  tools.ee_write = dynamicTool({
    description:
      "Save a NEW lesson to the Experience Engine brain so you and future sessions recall it. Call this the MOMENT " +
      "you hit a mistake / error / dead-end and find the working fix: record the pitfall AND the fix in one concise, " +
      "generalizable lesson (1-3 sentences — what to do or avoid next time, NOT a play-by-play of this turn). The " +
      "lesson is embedded immediately and becomes recallable via ee_query in THIS and future sessions. Use ee_query " +
      "first when unsure if a lesson already exists. collection defaults to experience-behavioral (use " +
      "experience-principles only for a broad, project-independent principle).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        lesson: {
          type: "string",
          description: "The lesson: the mistake/pitfall AND the fix, concise and generalizable.",
        },
        title: { type: "string", description: "Optional short title (<=120 chars)." },
        collection: {
          type: "string",
          enum: ["experience-behavioral", "experience-principles"],
          description: "Target tier; default experience-behavioral.",
        },
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
      try {
        const { writeExperienceEE } = await import("../ee/search.js");
        const path = await import("node:path");
        const cwd = opts.cwd ?? process.cwd();
        // confidence 0.65 (above the import default 0.6): an agent-asserted lesson
        // is deliberate but unproven — the ee_feedback loop then tunes it.
        const result = await writeExperienceEE(text, {
          collection,
          title,
          projectSlug: path.basename(cwd),
          confidence: 0.65,
        });
        if (!result.ok) return errLine("write_failed", result.error ?? "import-memory POST failed");
        return json({ ok: true, id: result.id, collection, recallable: "now — same session via ee_query" });
      } catch (e) {
        return errLine("write_failed", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── Self-diagnostics: usage_forensics ─────────────────────────────────────
  tools.usage_forensics = dynamicTool({
    description:
      "Per-session token-cost forensics by session-id prefix: peak input, cache-hit ratio, per-event breakdown.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { prefix: { type: "string", description: "Session id prefix (1-100 chars)" } },
      required: ["prefix"],
    }),
    execute: async (input: any) => {
      const prefix = typeof input?.prefix === "string" ? input.prefix.trim() : "";
      if (!prefix) return errLine("invalid_args", "usage_forensics requires a non-empty prefix");
      try {
        const { resolveSessionIds, collectCostForensics } = await import("../cli/cost-forensics.js");
        const ids = await resolveSessionIds(prefix);
        if (ids.length === 0) return errLine("not_found", `no session matches prefix '${prefix}'`);
        if (ids.length > 1) return errLine("ambiguous", `prefix '${prefix}' matched ${ids.length} sessions`);
        return json(await collectCostForensics(ids[0]!));
      } catch (e) {
        return errLine("db_error", e instanceof Error ? e.message : String(e));
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

  // ── Onboarding: setup_guide ───────────────────────────────────────────────
  tools.setup_guide = dynamicTool({
    description:
      "Returns the up-to-date setup / install / first-run / MCP wiring / verify guide for muonroi-cli. Call this " +
      "when the user asks how to set up, install, or get started — instead of guessing, reading files, or shelling commands.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => SETUP_GUIDE_TEXT,
  });

  // ── Self-QA harness: selfverify_* (shared JobManager, in-process) ──────────
  tools.selfverify_start = dynamicTool({
    description:
      "Start a self-verify run (mode=tier1 heuristic, or mode=agentic LLM-driven). Returns {runId} immediately; " +
      "poll selfverify_status, then selfverify_result.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["tier1", "agentic"] },
        since: { type: "string" },
        max: { type: "number" },
        emit: { type: "boolean" },
        out: { type: "string" },
        goal: { type: "string" },
        llm: { type: "string" },
        turns: { type: "number" },
      },
      required: ["mode"],
    }),
    execute: async (input: any) => {
      const jm = getSelfVerifyJobManager();
      if (input?.mode === "agentic") {
        if (!input?.goal || !input?.llm) return errLine("invalid_args", "agentic mode requires both goal and llm");
        const { getModelInfo } = await import("../models/registry.js");
        if (!getModelInfo(input.llm)) return errLine("unknown_model", `llm '${input.llm}' is not in catalog.json`);
        return json({ runId: jm.start({ kind: "agentic", goal: input.goal, llm: input.llm, turns: input.turns }) });
      }
      return json({
        runId: jm.start({ kind: "tier1", since: input?.since, max: input?.max, emit: input?.emit, out: input?.out }),
      });
    },
  });

  tools.selfverify_status = dynamicTool({
    description: "Get status + log tail of a self-verify run.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    }),
    execute: async (input: any) => {
      const job = getSelfVerifyJobManager().status(input?.runId);
      if (!job) return errLine("not_found", `runId ${input?.runId} not found`);
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
    description: "Fetch the full report of a completed self-verify run.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    }),
    execute: async (input: any) => {
      const job = getSelfVerifyJobManager().status(input?.runId);
      if (!job) return errLine("not_found", `runId ${input?.runId} not found`);
      if (job.status === "running") return errLine("still_running", "run not finished; poll selfverify_status first");
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
