/**
 * Built-in AI SDK tool definitions for use when MCP servers are unavailable.
 *
 * These wrap the existing tool implementations (bash, file, grep) as proper
 * AI SDK tools using dynamicTool() + jsonSchema(), ensuring correct JSON Schema
 * is sent to the API for all providers (including DeepSeek, Gemini, etc.).
 */

import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { canonicalizeBashCommand } from "../orchestrator/tool-args-hash.js";
import { analyzeImageFromSource, askVisionProxy, listCachedImages } from "../providers/mcp-vision-bridge.js";
import { needsVisionProxy } from "../providers/vision-proxy.js";
import type { AgentMode, TaskRequest, ToolResult } from "../types/index.js";
import type { BashTool } from "./bash.js";
import { type BashSliceMode, getBashRun, sliceBashOutput } from "./bash-output-cache.js";
import { editFile, readFile, writeFile } from "./file.js";
import { FileTracker } from "./file-tracker.js";
import { executeGrep } from "./grep.js";

interface ToolRegistryOpts {
  runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDelegation?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  readDelegation?: (id: string) => Promise<ToolResult>;
  listDelegations?: () => Promise<ToolResult>;
  modelId?: string;
  /**
   * Phase 4R: session id used to key the bash canonical-repeat detector
   * state across multiple createBuiltinTools() rebuilds within the same
   * agent session. When omitted, each registry instance gets its own
   * isolated state (legacy per-closure behaviour).
   */
  sessionId?: string;
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

export function createBuiltinTools(bash: BashTool, mode: AgentMode, opts?: ToolRegistryOpts): ToolSet {
  const tools: ToolSet = {};
  // One tracker per tool registry instance — shared across read/write/edit
  // calls in the same session. Enforces "must read before edit/overwrite".
  const fileTracker = new FileTracker();

  // read_file
  tools.read_file = dynamicTool({
    description: "Read file contents with optional start_line/end_line for iterative reading.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file to read" },
        start_line: { type: "number", description: "First line to read (1-based)" },
        end_line: { type: "number", description: "Last line to read (1-based)" },
      },
      required: ["file_path"],
    }),
    execute: async (input: any) => {
      const result = readFile(input.file_path, bash.getCwd(), input.start_line, input.end_line, fileTracker);
      return formatResult(result);
    },
  });

  // grep
  tools.grep = dynamicTool({
    description:
      "Fast regex content search across the codebase using ripgrep. Returns matching lines with file paths and line numbers.",
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
  tools.bash = dynamicTool({
    description:
      "Execute a shell command. Output is automatically cached — every call returns a " +
      "run_id you can re-query via bash_output_get(run_id, mode=tail|head|grep|lines). " +
      "Do NOT pipe `| tail`, `| head`, `| grep`, or `> file` — that hides output from " +
      "the cache. Run unpiped and slice via bash_output_get instead. Set background=true " +
      "for long-running processes (dev servers, watchers).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
        background: { type: "boolean", description: "Run in background (returns process ID)" },
      },
      required: ["command"],
    }),
    execute: async (input: any) => {
      if (input.background) {
        const result = await bash.startBackground(input.command);
        return formatResult(result);
      }
      // 3-3: compute canonical form BEFORE running so we can attach an
      // inline reminder if it matches the previous bash call.
      const cmd = typeof input.command === "string" ? input.command : "";
      const canonical = cmd ? canonicalizeBashCommand(cmd) : "";
      const entry = repeatState.get(repeatKey) ?? { lastCanonical: null, lastRunId: null };
      const repeatedIntent = canonical !== "" && canonical === entry.lastCanonical && entry.lastRunId !== null;
      const prevRunId = entry.lastRunId;

      const result = await bash.execute(input.command, input.timeout ?? 30000);
      const formatted = formatResult(result);

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
        "Replace a unique string in a file with new content. The old_string must appear exactly once. SAFETY: you must call read_file on the target in the same session before editing; if the file changed on disk after your read, re-read it first.",
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
        const result = await editFile(input.file_path, input.old_string, input.new_string, bash.getCwd(), fileTracker);
        return {
          success: result.success,
          output: truncateOutput(result.output ?? ""),
          diff: result.diff,
          lspDiagnostics: result.lspDiagnostics,
        };
      },
    });

    // task
    if (opts?.runTask) {
      const runTask = opts.runTask;
      tools.task = dynamicTool({
        description:
          "Delegate a focused foreground task to a sub-agent. Types: general (edit/execute), explore (read-only research), verify (sandbox validation), computer (desktop interaction).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Sub-agent type: general, explore, verify, computer, or a custom sub-agent name",
            },
            description: { type: "string", description: "Short description of the task" },
            prompt: { type: "string", description: "Detailed instructions for the sub-agent" },
          },
          required: ["agent", "description", "prompt"],
        }),
        execute: async (input: any) => {
          const result = await runTask({ agent: input.agent, description: input.description, prompt: input.prompt });
          return formatResult(result);
        },
      });
    }

    // delegate
    if (opts?.runDelegation) {
      const runDelegation = opts.runDelegation;
      tools.delegate = dynamicTool({
        description: "Launch a read-only background agent for longer research while you continue working.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            agent: { type: "string", description: "Sub-agent type (usually 'explore')" },
            description: { type: "string", description: "Short description of the research task" },
            prompt: { type: "string", description: "Detailed research instructions" },
          },
          required: ["agent", "description", "prompt"],
        }),
        execute: async (input: any) => {
          const result = await runDelegation({
            agent: input.agent,
            description: input.description,
            prompt: input.prompt,
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
  }

  // Vision proxy tools — only for text-only models (DeepSeek, etc.)
  if (opts?.modelId && needsVisionProxy(opts.modelId)) {
    const cwd = bash.getCwd();

    tools.analyze_image = dynamicTool({
      description:
        "Proactively analyze an image file via the vision proxy. " +
        "Use this IMMEDIATELY when you encounter any image file (.png, .jpg, .gif, .webp, .svg, etc.) " +
        "or when the user references an image. You CANNOT see images — this tool is your eyes. " +
        "Accepts file paths, data URIs, or base64 strings. " +
        "Optionally provide a question to focus the analysis.",
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
        "Ask a follow-up question about a previously analyzed image, or analyze a new image with a specific question. " +
        "Use this when you need to clarify visual details, compare elements, check colors, read text, etc. " +
        "You can reference a cached image by ID, or provide a file path to analyze a new image.",
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
  }

  return tools;
}
