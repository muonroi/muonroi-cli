/**
 * Built-in AI SDK tool definitions for use when MCP servers are unavailable.
 *
 * These wrap the existing tool implementations (bash, file, grep) as proper
 * AI SDK tools using dynamicTool() + jsonSchema(), ensuring correct JSON Schema
 * is sent to the API for all providers (including DeepSeek, Gemini, etc.).
 */

import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { analyzeImageFromSource, askVisionProxy, listCachedImages } from "../providers/mcp-vision-bridge.js";
import { needsVisionProxy } from "../providers/vision-proxy.js";
import type { AgentMode, TaskRequest, ToolResult } from "../types/index.js";
import type { BashTool } from "./bash.js";
import { editFile, readFile, writeFile } from "./file.js";
import { FileTracker } from "./file-tracker.js";
import { executeGrep } from "./grep.js";

interface ToolRegistryOpts {
  runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDelegation?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  readDelegation?: (id: string) => Promise<ToolResult>;
  listDelegations?: () => Promise<ToolResult>;
  modelId?: string;
}

const MAX_TOOL_OUTPUT_CHARS = 12_000;

function truncateOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - maxChars} chars truncated] ...\n\n${text.slice(-half)}`;
}

function formatResult(result: ToolResult): string {
  if (result.success) {
    return result.output ?? "OK";
  }
  return `ERROR: ${result.error ?? result.output ?? "Unknown error"}`;
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

  // bash
  tools.bash = dynamicTool({
    description: "Execute a shell command. Set background=true for long-running processes.",
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
      const result = await bash.execute(input.command, input.timeout ?? 30000);
      return formatResult(result);
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
  }

  return tools;
}
