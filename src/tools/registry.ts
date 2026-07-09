/**
 * Built-in AI SDK tool definitions for use when MCP servers are unavailable.
 *
 * These wrap the existing tool implementations (bash, file, grep) as proper
 * AI SDK tools using dynamicTool() + jsonSchema(), ensuring correct JSON Schema
 * is sent to the API for all providers (including DeepSeek, Gemini, etc.).
 */

import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { registerGsdWorkflowTools } from "../gsd/workflow-tools.js";
import { canonicalizeBashCommand } from "../orchestrator/tool-args-hash.js";
import { analyzeImageFromSource, askVisionProxy, listCachedImages } from "../providers/mcp-vision-bridge.js";
import { needsVisionProxy } from "../providers/vision-proxy.js";
import type { AgentMode, TaskRequest, ToolResult } from "../types/index.js";
import { loadMcpServers } from "../utils/settings.js";
import type { BashTool } from "./bash.js";
import { type BashSliceMode, getBashRun, sliceBashOutput } from "./bash-output-cache.js";
import { editFile, readFile, readFiles, writeFile } from "./file.js";
import { FileTracker } from "./file-tracker.js";
import {
  analyzeGitCommand,
  checkPushGate,
  checkSensitiveStaging,
  commitBlockedMessage,
  pushBlockedMessage,
  recordCommandOutcome,
  stagingWarning,
} from "./git-safety.js";
import { executeGrep } from "./grep.js";
import { registerNativeMuonroiTools } from "./native-tools.js";
import { registerNativeResearchTools } from "./research.js";
import { VISION_TOOL_NAMES } from "./vision-gate.js";

interface ToolRegistryOpts {
  runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDelegation?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  readDelegation?: (id: string) => Promise<ToolResult>;
  listDelegations?: () => Promise<ToolResult>;
  killDelegation?: (id: string) => Promise<ToolResult>;
  modelId?: string;
  /** L1 model depth tier — gates gsd_plan_review registration. */
  depthTier?: "quick" | "standard" | "heavy";
  consultParentSession?: (question: string) => Promise<string>;
  /**
   * When false, the 3 vision-proxy tools (analyze_image, ask_vision_proxy,
   * list_vision_cache) are omitted even for vision-proxy models. Used by the
   * orchestrator to drop them on pure-text turns with no image involvement
   * (see src/tools/vision-gate.ts). Defaults to true (include them) so every
   * other caller keeps its current behaviour. todo_write is never affected.
   */
  includeVisionTools?: boolean;
  /**
   * Phase 4R: session id used to key the bash canonical-repeat detector
   * state across multiple createBuiltinTools() rebuilds within the same
   * agent session. When omitted, each registry instance gets its own
   * isolated state (legacy per-closure behaviour).
   */
  sessionId?: string;
  runDebate?: (topic: string) => Promise<string>;
}

/**
 * Phase 4R: session-scoped bash repeat detector state.
 *
 * Previously the `lastBashCanonical` / `lastBashRunId` lived in the closure
 * of `createBuiltinTools()`. Every askcard answer / sub-agent invocation
 * rebuilds the tool registry, wiping that state and letting cheap models
 * re-run identical `grep` calls across turns (baseline session
 * `77cd2e11c6a5` did this 9 times in a row).
 *
 * We now key the state by sessionId on a process-global Map so the detector
 * sees identical canonical commands no matter how many times the registry
 * is rebuilt within the same session. When no sessionId is provided we
 * synthesise a unique fallback key per registry instance, preserving the
 * legacy per-closure semantics for callers that haven't been wired yet.
 */
interface BashRepeatEntry {
  lastCanonical: string | null;
  lastRunId: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __muonroiBashRepeatState: Map<string, BashRepeatEntry> | undefined;
  // eslint-disable-next-line no-var
  var __muonroiSafetyApproved: Map<string, { kind: "once" | "session"; command: string }> | undefined;
}

function getSafetyApprovedMap(): Map<string, { kind: "once" | "session"; command: string }> {
  if (!globalThis.__muonroiSafetyApproved) {
    globalThis.__muonroiSafetyApproved = new Map();
  }
  return globalThis.__muonroiSafetyApproved;
}

function getBashRepeatState(): Map<string, BashRepeatEntry> {
  if (!globalThis.__muonroiBashRepeatState) {
    globalThis.__muonroiBashRepeatState = new Map<string, BashRepeatEntry>();
  }
  return globalThis.__muonroiBashRepeatState;
}

let __anonRepeatCounter = 0;
function resolveBashRepeatKey(sessionId: string | undefined): string {
  if (sessionId && sessionId.length > 0) return sessionId;
  __anonRepeatCounter += 1;
  return `__no_session__:${process.pid}:${Date.now()}:${__anonRepeatCounter}`;
}

/**
 * Default per-tool-call output cap in characters (~8k tokens).
 *
 * Read-side tools (read_file, grep, bash, process_logs) previously returned
 * raw output uncapped, so a single large file read could dump ~28k tokens
 * straight into the next LLM prompt. We now apply the cap uniformly to all
 * tool results (head/tail-preserving), which is the primary cost-leak fix
 * for sub-agent loops that read multiple files in one turn.
 *
 * Override with env `MUONROI_MAX_TOOL_OUTPUT_CHARS` (10_000–200_000).
 */
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 32_000;

function resolveMaxToolOutputChars(): number {
  const raw = process.env.MUONROI_MAX_TOOL_OUTPUT_CHARS;
  if (!raw) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 10_000 || n > 200_000) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  return Math.floor(n);
}

export const MAX_TOOL_OUTPUT_CHARS = resolveMaxToolOutputChars();

export function truncateOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - maxChars} chars truncated; full output in transcript] ...\n\n${text.slice(-half)}`;
}

function formatResult(result: ToolResult): string {
  if (result.success) {
    return truncateOutput(result.output ?? "OK");
  }
  return truncateOutput(`ERROR: ${result.error ?? result.output ?? "Unknown error"}`);
}

// ee_query routing: tool-artifact rehydration ("tool-artifact id=<id>" / "full
// tool result id=<id>") is an exact-lookup of a persisted elided output and
// must stay on /api/search (raw single-collection vector lookup). Every other
// query is general recall → /api/recall (recallMode: 3 collections, raw cosine,
// integrity gates, records a surface for exp-feedback). Splitting on intent
// keeps the rehydration contract intact while upgrading recall to the fixed,
// feedback-closing pipeline.
export function isToolArtifactQuery(query: string): boolean {
  return /\b(?:tool-artifact|full tool result)\b/i.test(query) && /\bid\s*=/i.test(query);
}

export function createBuiltinTools(bash: BashTool, mode: AgentMode, opts?: ToolRegistryOpts): ToolSet {
  const tools: ToolSet = {};
  // One tracker per tool registry instance — shared across read/write/edit
  // calls in the same session. Enforces "must read before edit/overwrite".
  const fileTracker = new FileTracker();

  // Native research tools (fetch_url, web_search) — always available.
  // These are the in-process replacements for the old external MCP research servers.
  registerNativeResearchTools(tools);

  // read_file
  tools.read_file = dynamicTool({
    description:
      "Read file contents. To read SEVERAL files, pass them ALL in one call via file_paths (array) — STRONGLY PREFERRED over issuing separate read_file calls: each extra call re-sends the whole conversation as input, so N single reads cost O(N²) tokens while one batched read costs O(N). For a large SINGLE file, use start_line/end_line to extract only the needed section (start_line/end_line apply to file_path only; file_paths reads whole files). Use grep or lsp first to find line numbers.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to a single file to read (supports start_line/end_line)." },
        file_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Read MULTIPLE files in ONE call (preferred when you need 2+ files). Each is returned with its own header; each is capped independently so none is dropped. Best for small-to-medium files; for a large file use file_path + line range.",
        },
        start_line: { type: "number", description: "First line to read (1-based). Applies to file_path only." },
        end_line: { type: "number", description: "Last line to read (1-based). Applies to file_path only." },
      },
    }),
    execute: async (input: any) => {
      const batch: string[] =
        Array.isArray(input.file_paths) && input.file_paths.length > 0
          ? input.file_paths.filter((p: unknown): p is string => typeof p === "string" && p.trim() !== "")
          : [];
      if (batch.length > 1) {
        // Per-file fair-share of the output cap so the concatenated result
        // stays under MAX_TOOL_OUTPUT_CHARS and every file survives (no silent
        // head/tail drop of whole files). Floor keeps each file legible.
        const perFileCap = Math.max(4_000, Math.floor(MAX_TOOL_OUTPUT_CHARS / batch.length));
        return formatResult(readFiles(batch, bash.getCwd(), fileTracker, perFileCap));
      }
      const single = batch.length === 1 ? batch[0] : input.file_path;
      const result = readFile(single, bash.getCwd(), input.start_line, input.end_line, fileTracker);
      return formatResult(result);
    },
  });

  // grep
  tools.grep = dynamicTool({
    description:
      "Fast regex content search across the codebase using ripgrep. Returns matching lines with file paths and line numbers. Use this to find precise line numbers before calling read_file with start_line/end_line.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory path to search in" },
        include: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
      },
      required: ["pattern"],
    }),
    execute: async (input: any) => {
      const result = await executeGrep(
        { pattern: input.pattern, path: input.path, include: input.include },
        bash.getCwd(),
      );
      return formatResult(result);
    },
  });

  // bash — every foreground call goes through here. We track the LAST
  // canonical command + runId in SESSION-SCOPED state so we can inject a
  // reminder when the model issues another bash call that canonicalizes to
  // the same shape (e.g. `bunx vitest run | tail` followed by
  // `bunx vitest run | head` — both canonicalize to `bunx vitest run`).
  // The reminder rides on the tool_result of the SECOND call, which the
  // model is forced to read before its next step — far stronger signal
  // than a system-prompt rule it can attention-decay past.
  //
  // Phase 4R: state was previously a per-closure local; now it lives on a
  // process-global Map keyed by sessionId so a registry rebuild between
  // user turns / askcards no longer wipes it. See getBashRepeatState().
  const repeatState = getBashRepeatState();
  const repeatKey = resolveBashRepeatKey(opts?.sessionId);
  // Git-safety state key. MUST be stable across createBuiltinTools() rebuilds
  // within one process — otherwise a failed-test record made before a registry
  // rebuild (askcard answer, sub-agent turn) would be invisible to the push
  // gate after the rebuild. Unlike resolveBashRepeatKey's anon fallback (which
  // intentionally generates a fresh key per instance to isolate repeat-reminder
  // state), we want the gate to PERSIST: use the real sessionId when present,
  // else a single process-stable key. Over-sharing here is the safe direction
  // (it can only over-block a push, never wrongly allow one).
  const gitSafetyKey =
    opts?.sessionId && opts.sessionId.length > 0 ? opts.sessionId : `__proc_default__:${process.pid}`;
  // Per-session empty-bash streak counter: escalates from guidance (strike 1-2)
  // to hard block (strike 3+) so a cheap model that repeatedly emits `bash: {}`
  // cannot loop indefinitely (live: deepseek session bf58d0f46b51 — 8+ empty calls).
  const _emptyBashStreak = new Map<string, number>();
  const _prefixBlock = (kind: string, msg: string): string => `BLOCKED (${kind}): ${msg}`;

  tools.bash = dynamicTool({
    description:
      "Execute a shell command. Output is automatically cached — every call returns a " +
      "run_id you can re-query via bash_output_get(run_id, mode=tail|head|grep|lines). " +
      "Do NOT pipe `| tail`, `| head`, `| grep`, or `> file` — that hides output from " +
      "the cache. Run unpiped and slice via bash_output_get instead. For collecting system info (OS, versions, cwd layout, git, disk, processes) batch with ; or && in ONE call, e.g. 'uname -a; node -v; bun --version; ls -la | head -15; git status --short; df -h .; ps aux | head -5'. Set background=true for long-running processes (dev servers, watchers). " +
      'Avoid nesting double-quotes inline for database queries/scripts (e.g. executing raw SQL via `sqlite3 db "SELECT..."`) since they can fail parsing in shell environments; write query scripts to a temporary file first and run them.',
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
        background: { type: "boolean", description: "Run in background (returns process ID)" },
      },
      required: ["command"],
    }),
    // Phase 8 — safety-blocked commands queue, keyed by sessionId + toolCallId.
    // When the orchestrator intercepts a blocked result, the approval handler
    // stores the approved command here so bash.execute() can retry it.
    execute: async (input: any, extra?: { toolCallId?: string; messages?: ReadonlyArray<unknown> }) => {
      // Corrective guard for malformed calls: a cheap model sometimes emits a
      // bash call with a missing / empty `command` (live: deepseek sent `{}`
      // repeatedly until the loop-guard fired). Passing undefined to
      // bash.execute() throws an opaque TypeError that doesn't steer the model
      // to self-correct, and a whitespace command "succeeds" with no output —
      // both look like progress and feed the loop. Return a crisp instruction
      // so the next step supplies a real command instead of repeating.
      if (typeof input.command !== "string" || input.command.trim() === "") {
        // Track empty-bash streak per session; escalate from guidance to hard block.
        const _ebKey = gitSafetyKey ?? "no-session";
        let _eb = _emptyBashStreak.get(_ebKey) ?? 0;
        _eb++;
        _emptyBashStreak.set(_ebKey, _eb);
        if (_eb >= 3) {
          return (
            'BLOCKED (empty-bash): the `bash` tool has been called with an empty/missing "command" 3+ times in a row. ' +
            "Bash is now DISABLED for the remainder of this session — use read_file, grep, or other tools instead. " +
            "If you need to run a shell command, state the blocker explicitly and the CLI will enable it again on the next turn."
          );
        }
        if (_eb >= 2) {
          return (
            'BLOCKED (empty-bash): ERROR (2nd consecutive empty bash call): the `bash` tool requires a non-empty "command" string ' +
            "but this is the 2nd call in a row with empty arguments. One more empty call will BLOCK bash for the session. " +
            'Provide a real command, e.g. {"command":"ls -la"}.'
          );
        }
        return 'BLOCKED (empty-bash): the `bash` tool requires a non-empty "command" string, but the call had empty arguments. Provide the shell command to run, e.g. {"command":"ls -la"}.';
      }
      // Reset the empty-bash streak on any successful command.
      _emptyBashStreak.delete(gitSafetyKey ?? "no-session");

      const cmd = typeof input.command === "string" ? input.command : "";

      // Safety override check: approval is granted after a blocked call, but
      // the model's retry receives a new toolCallId. Match by id first, then
      // by exact command so allow-once survives the retry boundary.
      const _approvedMap = getSafetyApprovedMap();
      const _approvalKey =
        extra?.toolCallId && _approvedMap.has(extra.toolCallId)
          ? extra.toolCallId
          : [..._approvedMap.entries()].find(([, approval]) => approval.command === cmd)?.[0];
      const _approvalEntry = _approvalKey ? _approvedMap.get(_approvalKey) : undefined;
      if (_approvalEntry) {
        if (_approvalEntry.kind === "once") {
          _approvedMap.delete(_approvalKey!);
        }
        const result = await bash.execute(input.command, input.timeout ?? 30000);
        return formatResult(result);
      }

      // Git safety (pre-execution). Block `git push` while a verification
      // command failed this session and was not re-run green; warn on broad
      // `git add -A` / `git commit -a` when sensitive paths exist. Applied to
      // BOTH foreground and background paths. See git-safety.ts for the audit
      // motivation (session 18285908637a). gitSafetyKey is STABLE per process
      // (or the real sessionId) — unlike repeatKey, whose anon fallback changes
      // on every registry rebuild and would silently drop the gate across turns.
      const gitShape = analyzeGitCommand(cmd);
      // Hard-block broad staging when sensitive files are present.
      // This runs PRE-EXECUTION (before bash.execute) regardless of permission mode.
      if (gitShape.isBroadStage) {
        const stagingBlock = checkSensitiveStaging(bash.getCwd());
        if (stagingBlock.blocked) {
          return _prefixBlock("git-safety", stagingBlock.message);
        }
      }
      if (gitShape.isPush) {
        const gate = checkPushGate(gitSafetyKey);
        if (gate.blocked) {
          return _prefixBlock("git-safety", pushBlockedMessage(gate.failed));
        }
      }

      // G1 follow-up: a raw bash `git commit` must not bypass the LSP commit
      // gate that the `git_commit` tool + auto-commit backstop enforce. Derive
      // the to-be-committed paths from git state and block (pre-exec, never run
      // the commit) if any staged source file has a severity-1 LSP error. The
      // gate is fail-OPEN (LSP slow/down → allow) and self-disables under
      // MUONROI_COMMIT_GATE=0 / the unit-test suite. Lazy-import keeps the
      // LSP-heavy module off the hot bash path (mirrors git_commit below).
      if (gitShape.isCommit) {
        const { gateStagedPaths, isCommitGateEnabled, pathsForCommitGate } = await import(
          "../orchestrator/auto-commit.js"
        );
        if (isCommitGateEnabled()) {
          const commitCwd = bash.getCwd();
          const paths = await pathsForCommitGate(commitCwd, {
            broadAdd: gitShape.isBroadAdd,
            commitAll: gitShape.isCommitAll,
          });
          if (paths.length > 0) {
            const gate = await gateStagedPaths(commitCwd, paths);
            if (!gate.ok) {
              return _prefixBlock("git-safety", commitBlockedMessage(gate.summary));
            }
          }
        }
      }

      const isLongRunning = (c: string): boolean => {
        const lower = c.toLowerCase().trim();
        return (
          /\bvite\b/.test(lower) ||
          /\bnodemon\b/.test(lower) ||
          /\bwebpack-dev-server\b/.test(lower) ||
          /\bnext\s+dev\b/.test(lower) ||
          /\bwatch\b/.test(lower) ||
          /--watch\b/.test(lower) ||
          /\b-w\b/.test(lower) ||
          /\bdev-server\b/.test(lower) ||
          /\blive-server\b/.test(lower) ||
          /\bhttp-server\b/.test(lower)
        );
      };

      if (input.background || isLongRunning(cmd)) {
        const result = await bash.startBackground(input.command);
        return formatResult(result);
      }
      // 3-3: compute canonical form BEFORE running so we can attach an
      // inline reminder if it matches the previous bash call.
      const canonical = cmd ? canonicalizeBashCommand(cmd) : "";
      const entry = repeatState.get(repeatKey) ?? { lastCanonical: null, lastRunId: null };
      const repeatedIntent = canonical !== "" && canonical === entry.lastCanonical && entry.lastRunId !== null;
      const prevRunId = entry.lastRunId;

      const result = await bash.execute(input.command, input.timeout ?? 30000);
      const formatted = formatResult(result);

      // Record verification outcome so a later `git push` can be gated on it.
      recordCommandOutcome(gitSafetyKey, canonical, result.success);

      // Update last-canonical state AFTER we compared, so the current call's
      // runId becomes the comparison target for the next one. Session-scoped
      // map persists across createBuiltinTools() rebuilds (Phase 4R).
      if (result.bashRunId) {
        repeatState.set(repeatKey, { lastCanonical: canonical, lastRunId: result.bashRunId });
      }

      // 3-3 reminder rides on the tool_result of the SECOND+ same-intent
      // bash call. Cheap models that ignored the system-prompt rule still
      // see this — it's inside the actual tool output they parse next step.
      const reminder = repeatedIntent
        ? `\n\n[reminder: previous bash call had the same canonical intent and produced run_id=${prevRunId}. Use bash_output_get("${prevRunId}", mode=tail|head|grep|lines) to slice the cached output instead of re-running.]`
        : "";

      // 3-1: ALWAYS surface the run_id footer (no truncation gate). The
      // previous gate created a Catch-22 — when the model used `| tail -40`,
      // exec captured only ~5K, totalChars stayed below MAX_TOOL_OUTPUT_CHARS,
      // footer never fired, model never learned the cache existed. The hint
      // about bash_output_get fires only when the cached output is large
      // enough that slicing makes sense (>= 4K chars).
      if (result.bashRunId) {
        const chars = result.bashTotalChars ?? 0;
        const hint =
          chars >= 4_000
            ? ` — ${chars} chars cached; use bash_output_get(run_id, mode=tail|head|grep|lines) to re-query`
            : "";
        return `${formatted}\n\n[bash_run_id: ${result.bashRunId}${hint}]${reminder}`;
      }
      return formatted;
    },
  });

  // bash_output_get — re-query the cached full output of a previous bash run.
  // Designed to break the "re-run vitest with different pipe flags" loop by
  // letting the agent slice cached stdout/stderr instead.
  tools.bash_output_get = dynamicTool({
    description:
      "Re-query the full (untruncated, ANSI-stripped) stdout+stderr of a previous bash run by run_id. " +
      "Use this INSTEAD of re-running the same command with different `| tail`, `| head`, `| grep`, or " +
      "`> file` flags. Modes: head/tail (first/last N lines), grep (regex filter), lines (range N-M).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID from a previous bash result, e.g. 'bash-42'" },
        mode: { type: "string", enum: ["head", "tail", "grep", "lines", "full"] },
        lines: { type: "number", description: "Line count for head/tail (default 50)" },
        pattern: { type: "string", description: "Regex pattern for grep mode" },
        range: { type: "string", description: "Line range 'N-M' (1-based, inclusive) for lines mode" },
        case_insensitive: { type: "boolean", description: "Case-insensitive grep (default false)" },
      },
      required: ["run_id", "mode"],
    }),
    execute: async (input: any) => {
      const record = getBashRun(input.run_id);
      if (!record) {
        return truncateOutput(`ERROR: No cached bash run with id '${input.run_id}'. Cache holds up to 50 runs.`);
      }
      const slice = sliceBashOutput(record, {
        mode: input.mode as BashSliceMode,
        lines: input.lines,
        pattern: input.pattern,
        range: input.range,
        caseInsensitive: input.case_insensitive,
      });
      if (!slice.ok) {
        return truncateOutput(`ERROR: ${slice.text}`);
      }
      const meta = `[${input.run_id} mode=${input.mode} total_lines=${slice.totalLines}${
        slice.matchedLines !== undefined ? ` matched=${slice.matchedLines}` : ""
      } exit=${record.exitCode ?? "?"}]`;
      return truncateOutput(`${meta}\n${slice.text}`);
    },
  });

  // process_logs
  tools.process_logs = dynamicTool({
    description: "View recent output from a background process by ID.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        id: { type: "number", description: "Background process ID" },
        tail: { type: "number", description: "Number of lines to show (default: 50)" },
      },
      required: ["id"],
    }),
    execute: async (input: any) => {
      const result = await bash.getProcessLogs(input.id, input.tail);
      return formatResult(result);
    },
  });

  // process_stop
  tools.process_stop = dynamicTool({
    description: "Stop a background process by ID.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        id: { type: "number", description: "Background process ID to stop" },
      },
      required: ["id"],
    }),
    execute: async (input: any) => {
      const result = await bash.stopProcess(input.id);
      return formatResult(result);
    },
  });

  // process_list
  tools.process_list = dynamicTool({
    description: "List all background processes with status and uptime.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
    }),
    execute: async () => {
      const result = bash.listProcesses();
      return formatResult(result);
    },
  });

  // Agent mode gets write/edit/task/delegate tools
  if (mode === "agent") {
    // Capture delegation functions for auto-routing logic below
    const runTaskFn = opts?.runTask;
    const runDelegationFn = opts?.runDelegation;
    // write_file
    tools.write_file = dynamicTool({
      description:
        "Create a new file or overwrite an existing file with full content. SAFETY: overwriting an existing file requires you to call read_file on it first in the same session. New-file creation does not.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to write" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["file_path", "content"],
      }),
      execute: async (input: any) => {
        if (!input?.file_path?.trim() || input.content === undefined || input.content === null) {
          return {
            success: false,
            output:
              'BLOCKED (empty-write_file): write_file requires non-empty "file_path" and "content". ' +
              'Example: {"file_path":"src/foo.ts","content":"export const x = 1;\\n"}',
          };
        }
        const result = await writeFile(input.file_path, input.content, bash.getCwd(), fileTracker);
        return {
          success: result.success,
          output: truncateOutput(result.output ?? ""),
          diff: result.diff,
          lspDiagnostics: result.lspDiagnostics,
        };
      },
    });

    // edit_file
    tools.edit_file = dynamicTool({
      description:
        "Replace a unique string in a file with new content. The old_string must appear exactly once. MANDATORY: call read_file on the same file_path EARLIER in this session before edit_file — the edit WILL fail with 'File must be read first' otherwise. Batch reads when editing multiple files (parallel tool calls), then issue edits. If the file changed on disk after your read, re-read it first.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to edit" },
          old_string: { type: "string", description: "The exact string to find (must be unique)" },
          new_string: { type: "string", description: "The replacement string" },
        },
        required: ["file_path", "old_string", "new_string"],
      }),
      execute: async (input: any) => {
        if (
          !input?.file_path?.trim() ||
          input.old_string === undefined ||
          input.old_string === null ||
          input.new_string === undefined ||
          input.new_string === null
        ) {
          return {
            success: false,
            output:
              "BLOCKED (empty-edit_file): edit_file requires file_path, old_string, and new_string. " +
              'Example: {"file_path":"src/foo.ts","old_string":"a","new_string":"b"}',
          };
        }
        const result = await editFile(input.file_path, input.old_string, input.new_string, bash.getCwd(), fileTracker);
        return {
          success: result.success,
          output: truncateOutput(result.output ?? ""),
          diff: result.diff,
          lspDiagnostics: result.lspDiagnostics,
        };
      },
    });

    // git_commit — the agent commits its OWN work with a message IT writes.
    tools.git_commit = dynamicTool({
      description:
        "Commit the files you have created/edited so far, with a commit message YOU write. Use this to commit each " +
        "cohesive, working chunk the moment it is finished — and after EACH step of a multi-step plan — instead of " +
        "leaving everything for one commit at the end. message: a clear conventional subject describing WHAT changed " +
        "(e.g. 'feat(auth): add token refresh'), optionally followed by a body — NOT a restatement of the request. " +
        "Only files you wrote via write_file/edit_file are staged (secrets + CLI artifacts are excluded, and the " +
        "'Coding by - Muonroi-CLI' attribution line is appended automatically). No-op if none of your written files " +
        "have uncommitted changes.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Conventional commit subject (optionally + body) describing what changed, authored by you.",
          },
        },
        required: ["message"],
      }),
      execute: async (input: any) => {
        const message = typeof input?.message === "string" ? input.message.trim() : "";
        if (message.length < 3) {
          return { success: false, output: "git_commit requires a non-empty commit message." };
        }
        const written = fileTracker.writtenPaths();
        if (written.length === 0) {
          return {
            success: false,
            output:
              "Nothing to commit — you have not created or edited any file via write_file/edit_file this session.",
          };
        }
        try {
          const { commitSpecificPaths } = await import("../orchestrator/auto-commit.js");
          const result = await commitSpecificPaths(bash.getCwd(), written, message);
          if (!result.committed) {
            // G1: when the LSP quality gate blocked the commit, surface the
            // per-file errors so the agent can fix them and call git_commit again.
            // Tell the agent to FIX the errors — do NOT advertise the bypass
            // env here (that is a USER escape hatch; surfacing it to the agent
            // just invites it to circumvent the gate instead of fixing).
            const detail =
              result.reason === "lsp-errors"
                ? `\nStaged files have errors — fix them and call git_commit again:\n${result.detail ?? ""}`
                : "";
            return { success: false, output: `No commit made (${result.reason}).${detail}` };
          }
          return { success: true, output: `Committed ${result.fileCount} file(s) → ${result.sha}` };
        } catch (e) {
          return { success: false, output: `git_commit failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    });

    // task
    if (opts?.runTask) {
      tools.task = dynamicTool({
        description:
          "Delegate a FOCUSED, SHORT foreground task to a sub-agent that blocks the current turn until complete. " +
          "Use ONLY for quick edit/execute/verify work (default max ~12 rounds). " +
          "For long research, exploration, or anything that may take many steps (explore agent), you MUST use the 'delegate' tool instead — it runs in true background and does not block. " +
          "Using task for long work will cause stalls and timeouts.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Sub-agent type: general, explore, verify, computer, or a custom sub-agent name",
            },
            description: { type: "string", description: "Short description of the task" },
            prompt: { type: "string", description: "Detailed instructions for the sub-agent" },
            maxToolRounds: {
              type: "number",
              description:
                "Optional maximum tool execution rounds. For research/explore use delegate + higher values (default 60); low values (≤20) only for task.",
            },
          },
          required: ["agent", "description", "prompt"],
        }),
        execute: async (input: any) => {
          // Auto-route long research (explore agent or high round count) to true background delegation
          // to prevent blocking the main turn and causing stall timeouts.
          const isLongResearch =
            input.agent === "explore" || (typeof input.maxToolRounds === "number" && input.maxToolRounds > 25);

          const executor = isLongResearch && runDelegationFn ? runDelegationFn : runTaskFn;

          if (!executor) {
            return { success: false, output: "No delegation executor available." };
          }

          const result = await executor({
            agent: input.agent,
            description: input.description,
            prompt: input.prompt,
            maxToolRounds: input.maxToolRounds,
          });
          return formatResult(result);
        },
      });
    }

    // consult_parent_session
    if (opts?.consultParentSession) {
      const consultParentSession = opts.consultParentSession;
      tools.consult_parent_session = dynamicTool({
        description:
          "Consult the parent session for supervision or guidance when stuck, when needing clarification on the overall goal, or when encountering critical errors. ONLY available in sub-sessions.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The specific question or issue you need the parent session to advise on.",
            },
          },
          required: ["question"],
        }),
        execute: async (input: any) => {
          const result = await consultParentSession(input.question);
          return result;
        },
      });
    }

    // delegate
    if (opts?.runDelegation) {
      const runDelegation = opts.runDelegation;
      tools.delegate = dynamicTool({
        description:
          "Launch a read-only BACKGROUND research agent (usually 'explore') that runs independently in a separate process. " +
          "Use this for ANY long-running research, codebase exploration, analysis, or tasks with high maxToolRounds. " +
          "Main session continues working immediately. Results are delivered later via notifications or delegation_read. " +
          "This is the PREFERRED tool over 'task' for explore/research to avoid blocking and timeouts.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            agent: { type: "string", description: "Sub-agent type (usually 'explore')" },
            description: { type: "string", description: "Short description of the research task" },
            prompt: { type: "string", description: "Detailed research instructions" },
            maxToolRounds: {
              type: "number",
              description:
                "Optional maximum tool execution rounds (high values like 60+ expected for background research; do not use task for high values).",
            },
          },
          required: ["agent", "description", "prompt"],
        }),
        execute: async (input: any) => {
          const result = await runDelegation({
            agent: input.agent,
            description: input.description,
            prompt: input.prompt,
            maxToolRounds: input.maxToolRounds,
          });
          return formatResult(result);
        },
      });
    }

    // delegation_read
    if (opts?.readDelegation) {
      const readDelegation = opts.readDelegation;
      tools.delegation_read = dynamicTool({
        description: "Retrieve a completed background delegation result by ID.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            id: { type: "string", description: "Delegation ID to read" },
          },
          required: ["id"],
        }),
        execute: async (input: any) => {
          const result = await readDelegation(input.id);
          return formatResult(result);
        },
      });
    }

    // delegation_list
    if (opts?.listDelegations) {
      const listDelegations = opts.listDelegations;
      tools.delegation_list = dynamicTool({
        description: "List running and completed background delegations.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
        }),
        execute: async () => {
          const result = await listDelegations();
          return formatResult(result);
        },
      });
    }

    // delegation_kill
    if (opts?.killDelegation) {
      const killDelegation = opts.killDelegation;
      tools.delegation_kill = dynamicTool({
        description: "Terminate a running background delegation/subagent by ID.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            id: { type: "string", description: "Delegation ID to terminate" },
          },
          required: ["id"],
        }),
        execute: async (input: any) => {
          const result = await killDelegation(input.id);
          return formatResult(result);
        },
      });
    }

    // ee_query — semantic recall over the Experience Engine brain. This is the
    // in-CLI counterpart of the MCP `ee.query` tool (src/mcp/ee-tools.ts):
    // without it, the Agent Operating Contract + checkpoint reminders instruct
    // the agent to "Use ee_query tool with 'tool-artifact id=XXX'" to rehydrate
    // compaction-elided tool outputs, but the in-CLI agent had no such tool in
    // its loop (session d95113d3be09: the anti-mù rehydrate path was a dead
    // reference). Elided outputs are persisted to EE (message-processor.ts,
    // source="tool-artifact"); this tool retrieves them. Degrades gracefully:
    // returns an ee_unavailable note when EE is down/unconfigured.
    tools.ee_query = dynamicTool({
      description:
        "Active recall over the Experience Engine brain (learned warnings/recipes + task checkpoints + " +
        "compaction-elided tool outputs for this codebase). General queries run the recallMode pipeline " +
        "(/api/recall — same path as exp-recall.js) and return a formatted index whose entries carry " +
        '`[id col]` handles. Anti-mù rehydration: query="tool-artifact id=<id from a [... elided ...] stub>" ' +
        'or "full tool result id=<id>" does an exact lookup. Also: query="recent compaction checkpoint ' +
        'Progress DONE" to confirm finished work after a compaction. Returns hits, or an ee_unavailable note ' +
        "when EE is down/unconfigured.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language recall query (or 'tool-artifact id=<id>')" },
          project: { type: "string", description: "Optional project slug to scope the recall (general queries only)" },
          collections: {
            type: "array",
            items: { type: "string" },
            description: "Optional EE collections to scope an artifact lookup (e.g. ['experience-behavioral'])",
          },
          limit: { type: "number", description: "Max hits for an artifact lookup (1-50, default server-side)" },
          maxChars: {
            type: "number",
            description: "Max chars of the recall index to return (500-20000, default 6000; general queries only)",
          },
        },
        required: ["query"],
      }),
      execute: async (input: any) => {
        const query = typeof input?.query === "string" ? input.query.trim() : "";
        if (!query) {
          return 'ERROR: ee_query requires a non-empty "query" string (e.g. {"query":"tool-artifact id=abc123"}).';
        }
        try {
          if (isToolArtifactQuery(query)) {
            // Local-first (anti-mù durability): the compactor records each elided
            // output in-process by toolCallId. For an exact "tool-artifact id=X"
            // lookup this is the authoritative full content for THIS session and
            // works even when EE is down — the failure window long sessions hit.
            const { findArtifactByQuery, findArtifactOnDisk } = await import("../ee/artifact-cache.js");
            // Lived-experience telemetry: record where the rehydrate came from so
            // a "cảm nhận trong CLI" question (and the measure-first instrumentation)
            // sees cache vs disk vs ee vs needed-but-unavailable.
            const { recordRehydration } = await import("../orchestrator/session-experience.js");
            const mem = findArtifactByQuery(query);
            const local = mem ?? (await findArtifactOnDisk(query));
            if (local) {
              const src = mem ? "in-session cache" : "local disk cache";
              recordRehydration(mem ? "cache" : "disk");
              return truncateOutput(
                `[tool-artifact id=${local.toolCallId} tool=${local.toolName} — rehydrated from ${src}]\n${local.content}`,
              );
            }
            // EE fallback (cross-session / post-restart) → raw /api/search exact lookup.
            const { searchEE } = await import("../ee/search.js");
            const resp = await searchEE(query, {
              ...(Array.isArray(input?.collections) ? { collections: input.collections } : {}),
              ...(typeof input?.limit === "number" ? { limit: input.limit } : {}),
            });
            if (resp === null) {
              recordRehydration("unavailable");
              return "[ee_unavailable] Experience Engine returned no response (server down, timeout, circuit open, or unconfigured) and the artifact is not in this session's local cache. Proceed without EE recall — re-read the source directly if you need the elided content.";
            }
            recordRehydration("ee");
            const points = resp.points ?? [];
            const bestHit = points[0];
            if (bestHit) {
              const matchedId = query.match(/(?:id\s*=\s*|id\s*\b)([a-zA-Z0-9_:-]+)/i)?.[1] ?? "unknown";
              return truncateOutput(
                `[tool-artifact id=${matchedId} — rehydrated from Experience Engine]\n${bestHit.text}`,
              );
            }
            return `[tool-artifact — not found in Experience Engine]`;
          }
          // General recall → /api/recall (recallMode, [id col] index + surface).
          const { recallEE, formatRecallForAgent } = await import("../ee/search.js");
          const resp = await recallEE(query, {
            ...(typeof input?.project === "string" ? { project: input.project } : {}),
          });
          if (resp === null) {
            return "[ee_unavailable] Experience Engine returned no response (server down, timeout, circuit open, or unconfigured). Proceed without EE recall — re-read the source directly if you need the elided content.";
          }
          // Record recalled entries as pending feedback debt in the same in-process
          // ledger the native ee_feedback builtin clears, so an in-CLI active recall
          // accrues a verdict obligation exactly like the external MCP ee.query does
          // (mcp/ee-tools.ts). Layer 3 surfaces this debt as a reminder on the next
          // enriched turn; without it the in-CLI recall arm was write-only and
          // ee_feedback.clear() was a no-op.
          try {
            const { sessionRecallLedger, isRecallLedgerEnabled } = await import("../ee/recall-ledger.js");
            if (isRecallLedgerEnabled()) sessionRecallLedger.record(resp.entries, query);
          } catch (err) {
            console.error(`[tools:ee_query] recall-ledger record failed: ${(err as Error)?.message}`);
          }
          // Compact ranked `[id col]` index, not a JSON dump — the recallMode text
          // is ~30k (wide net), so JSON.stringify wasted the budget on escaping.
          return truncateOutput(
            formatRecallForAgent(resp, {
              query,
              ...(typeof input?.maxChars === "number" ? { maxChars: input.maxChars } : {}),
            }),
          );
        } catch (err) {
          console.error(`[tools:ee_query] EE recall failed: ${(err as Error)?.message}`, {
            query: query.slice(0, 120),
            stack: (err as Error)?.stack?.split("\n").slice(0, 3),
          });
          return `[ee_unavailable] EE recall threw: ${(err as Error)?.message ?? String(err)}. Proceed without EE recall.`;
        }
      },
    });

    tools.retrieve_tool_result = dynamicTool({
      description:
        "Retrieve the full output of a previous tool call by its tool_call_id. " +
        "Searches local cache, disk cache, database history (including parent sessions), and remote Experience Engine. " +
        "Use this to rehydrate elided tool outputs. Optional max_chars and chunk_index allow paginated retrieval.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          tool_call_id: { type: "string", description: "The unique ID of the tool call (e.g. 'call_123')." },
          max_chars: {
            type: "number",
            description: "Optional character limit for the returned chunk (useful for very large outputs).",
          },
          chunk_index: {
            type: "number",
            description: "Optional chunk index if splitting the output by max_chars (0-based, default 0).",
          },
        },
        required: ["tool_call_id"],
      }),
      execute: async (input: any) => {
        const toolCallId = typeof input.tool_call_id === "string" ? input.tool_call_id.trim() : "";
        if (!toolCallId) {
          return "ERROR: tool_call_id is required.";
        }
        const maxChars = typeof input.max_chars === "number" ? input.max_chars : undefined;
        const chunkIndex = typeof input.chunk_index === "number" ? input.chunk_index : 0;

        let content: string | null = null;
        let source = "";

        // Tier 1: LRU cache
        try {
          const { getArtifact } = await import("../ee/artifact-cache.js");
          const tier1 = getArtifact(toolCallId);
          if (tier1) {
            content = tier1.content;
            source = "Tier 1 LRU cache";
          }
        } catch (err) {
          console.error(`[tools:retrieve_tool_result] Tier 1 LRU check failed: ${(err as Error).message}`);
        }

        // Tier 2: Disk cache
        if (!content) {
          try {
            const { findArtifactOnDisk } = await import("../ee/artifact-cache.js");
            const tier2 = await findArtifactOnDisk(`id=${toolCallId}`);
            if (tier2) {
              content = tier2.content;
              source = "Tier 2 disk cache";
            }
          } catch (err) {
            console.error(`[tools:retrieve_tool_result] Tier 2 disk check failed: ${(err as Error).message}`);
          }
        }

        // Tier 3: SQLite database
        if (!content && opts?.sessionId) {
          try {
            const { getSessionChain } = await import("../storage/index.js");
            const { getDatabase } = await import("../storage/db.js");
            const chain = getSessionChain(opts.sessionId);
            const db = getDatabase();
            for (let i = chain.length - 1; i >= 0; i--) {
              const row = db
                .prepare(`
                SELECT tr.output_json
                FROM tool_results tr
                JOIN tool_calls tc ON tc.id = tr.tool_call_row_id
                WHERE tc.tool_call_id = ? AND tc.session_id = ?
                LIMIT 1
              `)
                .get(toolCallId, chain[i]) as { output_json: string } | undefined;

              if (row?.output_json) {
                const parsed = JSON.parse(row.output_json);
                if (parsed && typeof parsed === "object") {
                  if ("output" in parsed && typeof parsed.output === "string") {
                    content = parsed.output;
                  } else if ("error" in parsed && typeof parsed.error === "string") {
                    content = `ERROR: ${parsed.error}`;
                  } else {
                    content = JSON.stringify(parsed);
                  }
                } else {
                  content = String(parsed);
                }
                source = `Tier 3 SQLite database (session ${chain[i]})`;
                break;
              }
            }
          } catch (err) {
            console.error(`[tools:retrieve_tool_result] Tier 3 DB check failed: ${(err as Error).message}`);
          }
        }

        // Tier 4: Remote EE (behavioral collection only)
        if (!content) {
          try {
            const { searchEE } = await import("../ee/search.js");
            const resp = await searchEE(`tool-artifact id=${toolCallId}`, {
              collections: ["experience-behavioral"],
              limit: 1,
            });
            const bestHit = resp?.points?.[0];
            if (bestHit?.text) {
              content = bestHit.text;
              source = "Tier 4 remote EE (behavioral collection)";
            }
          } catch (err) {
            console.error(`[tools:retrieve_tool_result] Tier 4 EE check failed: ${(err as Error).message}`);
          }
        }

        if (content === null) {
          return `ERROR: Tool result not found for tool_call_id: ${toolCallId} in any tier.`;
        }

        const totalLength = content.length;
        if (maxChars !== undefined && maxChars > 0) {
          const totalChunks = Math.ceil(totalLength / maxChars);
          const start = chunkIndex * maxChars;
          const end = Math.min(start + maxChars, totalLength);
          if (start >= totalLength) {
            return `ERROR: chunk_index ${chunkIndex} is out of bounds. Total chunks available: ${totalChunks} (max_chars: ${maxChars}, total length: ${totalLength}).`;
          }
          const chunk = content.slice(start, end);
          return JSON.stringify(
            {
              tool_call_id: toolCallId,
              source,
              chunk_index: chunkIndex,
              total_chunks: totalChunks,
              chunk_length: chunk.length,
              total_length: totalLength,
              content: chunk,
            },
            null,
            2,
          );
        }

        return JSON.stringify(
          {
            tool_call_id: toolCallId,
            source,
            total_length: totalLength,
            content,
          },
          null,
          2,
        );
      },
    });

    tools.search_session_history = dynamicTool({
      description:
        "Search the full message history across all sessions using an FTS5 MATCH expression. " +
        "Useful to locate past questions, answers, and context across the session lineage.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "FTS5 MATCH expression query (e.g. 'compaction AND error' or 'content:Vitest').",
          },
        },
        required: ["query"],
      }),
      execute: async (input: any) => {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) {
          return "ERROR: query MATCH expression is required.";
        }
        try {
          const { getDatabase } = await import("../storage/db.js");
          const db = getDatabase();
          // Wrap FTS search query execution in try-catch to prevent malformed FTS syntax crashes (fixing GAP-03)
          const rows = db
            .prepare(`
            SELECT session_id, seq, role, tool_name, content, tool_args, tool_output
            FROM session_history_fts
            WHERE session_history_fts MATCH ?
            ORDER BY rank
            LIMIT 50
          `)
            .all(query) as Array<{
            session_id: string;
            seq: number;
            role: string;
            tool_name: string | null;
            content: string | null;
            tool_args: string | null;
            tool_output: string | null;
          }>;

          if (rows.length === 0) {
            return `No session history matched the query: "${query}"`;
          }

          const results = rows.map((row) => ({
            session_id: row.session_id,
            seq: row.seq,
            role: row.role,
            tool_name: row.tool_name ?? undefined,
            content: row.content ?? undefined,
            tool_args: row.tool_args ?? undefined,
            tool_output: row.tool_output ?? undefined,
          }));

          return JSON.stringify(
            {
              query,
              match_count: results.length,
              results,
            },
            null,
            2,
          );
        } catch (err) {
          return `ERROR: FTS MATCH query failed. The FTS syntax might be malformed: ${(err as Error).message}`;
        }
      },
    });

    // Native muonroi-tools builtins — ee_health, ee_feedback, usage_forensics,
    // lsp_query, setup_guide, selfverify_*. These run IN-PROCESS; the CLI no
    // longer self-spawns itself as an MCP server to expose them to its own inner
    // agent (that self-spawn cold-started 2-3.5s and overran the build deadline,
    // and a seed-time bug once persisted a crashing vitest-worker command). The
    // muonroi-tools MCP server stays only for EXTERNAL agents. See native-tools.ts.
    registerNativeMuonroiTools(tools, { cwd: bash.getCwd() });

    registerGsdWorkflowTools(tools, {
      cwd: bash.getCwd(),
      sessionModelId: opts?.modelId ?? "unknown",
      sessionId: opts?.sessionId,
      depth: opts?.depthTier ?? "standard",
      runTask: opts?.runTask,
      runDebate: opts?.runDebate,
    });
  }

  // Vision proxy tools — only for text-only models (DeepSeek, etc.)
  if (opts?.modelId && needsVisionProxy(opts.modelId)) {
    const cwd = bash.getCwd();

    tools.analyze_image = dynamicTool({
      description:
        "Inspect an image and receive a <vision-observation> block — treat the result as your direct sight. " +
        "Use IMMEDIATELY when you encounter any image file (.png, .jpg, .gif, .webp, .svg, etc.) " +
        "or when the user references an image. Do not guess visual content. " +
        "Accepts file paths, data URIs, or base64 strings. " +
        "Optionally provide a question to focus the analysis (OCR, layout, specific UI element). " +
        "If details remain unclear, call ask_vision_proxy or ask the user for another screenshot.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          image_source: {
            type: "string",
            description: "File path to the image, a data URI (data:image/...), or raw base64 string",
          },
          question: {
            type: "string",
            description:
              "Optional specific question to focus the analysis (e.g. 'what text is in this image?', 'describe the layout')",
          },
        },
        required: ["image_source"],
      }),
      execute: async (input: any) => {
        return analyzeImageFromSource(input.image_source, input.question, cwd);
      },
    });

    tools.ask_vision_proxy = dynamicTool({
      description:
        "Ask a follow-up about an image you are viewing (cached ID) or analyze a new file with a specific question. " +
        "Returns a <vision-observation> — respond as if you saw it yourself. " +
        "Use when any detail in a prior observation is unclear: zoom on a region, read text, compare colors, verify UI state. " +
        "Reference a cached image by ID (from list_vision_cache) or provide a file path for a new image.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Your specific question about the image",
          },
          image_id_or_path: {
            type: "string",
            description:
              "Cached image ID (e.g. img_1) OR a file path to a new image. If omitted, uses the most recent image.",
          },
        },
        required: ["question"],
      }),
      execute: async (input: any) => {
        return askVisionProxy(input.question, input.image_id_or_path, cwd);
      },
    });

    tools.list_vision_cache = dynamicTool({
      description:
        "List all cached images available for ask_vision_proxy queries. " +
        "Shows image IDs, sources, labels, and ages.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
      }),
      execute: async () => {
        const cached = listCachedImages();
        if (cached.length === 0) {
          return "No cached images. Use analyze_image to analyze an image file, or take a screenshot with browser_take_screenshot.";
        }
        return cached
          .map((c) => `${c.id}: ${c.label} (${c.source}, ${c.age})${c.hasDescription ? " [analyzed]" : ""}`)
          .join("\n");
      },
    });
  }

  // todo_write — Claude-Code-style task list. Each call REPLACES the agent's
  // current todo snapshot; the orchestrator post-processes this tool's args
  // into a task_list_update StreamChunk that the UI renders as a sticky
  // checklist panel. Status flow: pending → in_progress → completed; only
  // ONE item should be in_progress at a time. Use this when the user asks
  // for a multi-step task (≥3 distinct steps) so progress is visible.
  tools.todo_write = dynamicTool({
    description:
      "Write the full current todo list. Replaces the previous list entirely on every call (no partial updates). Use when a user request resolves into ≥3 discrete steps so the UI can show progress. Mark exactly one item as in_progress at a time. Always emit the FULL list, not just the changed items.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "The full ordered list of todo items. Replaces any prior list. Keep order stable across updates so the UI doesn't reshuffle on every call.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id across updates (e.g. '1','2', or a slug)." },
              subject: { type: "string", description: "Short imperative title shown in the list." },
              activeForm: {
                type: "string",
                description:
                  "Present-continuous form shown while in_progress (e.g. 'Reading files'). Falls back to subject when absent.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Item status. Only ONE item should be in_progress at any time.",
              },
            },
            required: ["id", "subject", "status"],
          },
        },
      },
      required: ["todos"],
    }),
    execute: async (input: any) => {
      const todos: Array<{ id?: unknown; subject?: unknown; activeForm?: unknown; status?: unknown }> = Array.isArray(
        input?.todos,
      )
        ? input.todos
        : [];
      const counts = { completed: 0, inProgress: 0, pending: 0, total: todos.length };
      for (const t of todos) {
        if (t.status === "completed") counts.completed++;
        else if (t.status === "in_progress") counts.inProgress++;
        else counts.pending++;
      }
      return `Tracking ${counts.total} todo${counts.total !== 1 ? "s" : ""}: ${counts.completed} done · ${counts.inProgress} in progress · ${counts.pending} queued.`;
    },
  });

  // Vision-tool gate: drop the 3 vision-proxy tools on turns with no plausible
  // image involvement. Built then deleted (closures are cheap) to avoid
  // re-indenting the tool definitions above. todo_write + core tools untouched.
  if (opts?.includeVisionTools === false) {
    for (const name of VISION_TOOL_NAMES) delete tools[name];
  }

  // ── Agent introspection tools: help the inner agent discover capabilities ──
  // These are always added last (after all filtering) so list_tools reflects reality.

  tools.list_mcp_servers = dynamicTool({
    description:
      "List every MCP server in the current user config (enabled or not). Returns id, label, enabled, transport, endpoint, and recommended_native (if any). " +
      "Use this to discover exactly what MCPs you have right now. For each MCP, see if there is a preferred native replacement (e.g. fetch_url instead of legacy fetch). " +
      "Memory, playwright, figma removed from defaults. Only enabled servers contribute tools this turn.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const servers = loadMcpServers();

      // Native replacement recommendations (helps agent choose better tools)
      const RECOMMENDATIONS: Record<string, string | null> = {
        fetch: "Prefer native fetch_url (faster, always available, no external spawn).",
        tavily: "Prefer native web_search (direct Tavily API call, same results).",
        context7: "Consider keeping for library docs, or cache important docs into Experience Engine for offline use.",
        "muonroi-docs": null, // already our own controlled service
        playwright: "Use for full browser interaction/screenshots only; fetch_url sufficient for most content needs.",
        memory: "Use native ee_query / ee_write (Experience Engine) instead.",
        figma: "Add manually only if needed; no native equivalent yet.",
      };

      const summary = servers.map((s) => {
        const rec = RECOMMENDATIONS[s.id] ?? null;
        return {
          id: s.id,
          label: s.label,
          enabled: s.enabled,
          transport: s.transport,
          endpoint: s.url || (s.command ? `${s.command} ${(s.args || []).join(" ")}` : undefined),
          recommended_native: rec,
        };
      });

      return JSON.stringify({ count: summary.length, servers: summary }, null, 2);
    },
  });

  tools.list_tools = dynamicTool({
    description:
      "Compact grouped summary of every tool available this turn. " +
      "native = always-on builtins (fetch_url, web_search, bash, read_file, grep, ee_query, list_mcp_servers, list_tools, ...). " +
      "mcp = tools from your enabled MCP servers (prefixed mcp_<server-id>__). " +
      "Each line: name + short description (tells you purpose and rough usage). " +
      "Call list_mcp_servers() to see your MCP sources, then this to see concrete tools + how to use them. Full parameter schemas are in the system tool list this turn.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["all", "native", "mcp"],
          description: "Optional filter.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const cat = (input?.category as string) || "all";
      const grouped: { native: string[]; mcp: string[] } = { native: [], mcp: [] };

      for (const [name, tool] of Object.entries(tools)) {
        const t = tool as { description?: string };
        const shortDesc = (t.description || "").split("\n")[0].slice(0, 140);
        const entry = `${name}: ${shortDesc}`;
        if (name.startsWith("mcp_")) {
          if (cat === "all" || cat === "mcp") grouped.mcp.push(entry);
        } else {
          if (cat === "all" || cat === "native") grouped.native.push(entry);
        }
      }

      grouped.native.sort();
      grouped.mcp.sort();

      return JSON.stringify(
        {
          total: Object.keys(tools).length,
          native_count: grouped.native.length,
          mcp_count: grouped.mcp.length,
          ...grouped,
          note: "Native tools are always preferred. MCP tools only from servers where enabled=true (see list_mcp_servers).",
        },
        null,
        2,
      );
    },
  });

  tools.describe_tool = dynamicTool({
    description:
      "Get detailed usage information for a specific tool by name. Returns description, full input schema (parameters), and a short usage example or note. " +
      "Call this when you need precise 'how to use' details for a tool (e.g. describe_tool with name='fetch_url' or name='mcp_context7__something'). " +
      "This complements list_tools and list_mcp_servers.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Exact tool name (e.g. 'fetch_url', 'web_search', 'mcp_context7__search' or any from list_tools)",
        },
      },
      required: ["name"],
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return "ERROR: name is required";

      const tool = (tools as any)[name];
      if (!tool) {
        return JSON.stringify(
          {
            name,
            error: "Tool not found in current tool set. Use list_tools to see available names.",
          },
          null,
          2,
        );
      }

      const t = tool as { description?: string; inputSchema?: unknown };
      const schema = t.inputSchema || (tool as any).parameters || null;

      // Provide a minimal example note for common tools
      const examples: Record<string, string> = {
        fetch_url: 'Example: {"url": "https://example.com/docs", "format": "markdown"}',
        web_search: 'Example: {"query": "muonroi building block best practices", "maxResults": 5}',
        list_mcp_servers: "Call with no args: {}",
        list_tools: 'Example: {"category": "native"}',
      };

      return JSON.stringify(
        {
          name,
          description: t.description,
          inputSchema: schema,
          example: examples[name] || "See inputSchema above. Call with correct parameters.",
          note: "Use the exact parameters from inputSchema when calling this tool.",
        },
        null,
        2,
      );
    },
  });

  return tools;
}
