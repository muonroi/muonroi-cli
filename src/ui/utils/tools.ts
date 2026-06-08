import type { ToolCall } from "../../types/index.js";
import { trunc } from "./text.js";

export function describeMcpFsTool(name: string): { verb: string; ns: string } | null {
  if (!name.startsWith("mcp_filesystem__") && !name.startsWith("mcp__filesystem__")) return null;
  const op = name.replace(/^mcp_+filesystem__/, "");
  const verbMap: Record<string, string> = {
    read_text_file: "read",
    read_file: "read",
    read_media_file: "read media",
    read_multiple_files: "read multi",
    write_file: "write",
    edit_file: "edit",
    create_directory: "mkdir",
    list_directory: "ls",
    list_directory_with_sizes: "ls -s",
    directory_tree: "tree",
    move_file: "mv",
    search_files: "search",
    get_file_info: "stat",
    list_allowed_directories: "list-allowed",
  };
  return { verb: verbMap[op] ?? op.replace(/_/g, " "), ns: "fs" };
}

export function toolArgs(tc?: ToolCall): string {
  if (!tc) return "";
  try {
    const a = JSON.parse(tc.function.arguments);
    if (tc.function.name === "bash") return String(a.command || "").replace(/\n/g, " ").trim();
    if (tc.function.name === "read_file" || tc.function.name === "write_file" || tc.function.name === "edit_file")
      return String(a.file_path || a.path || "");
    if (describeMcpFsTool(tc.function.name)) {
      // Most MCP fs tools take `path`; some take `paths` (read_multiple_files) or `source`/`destination` (move_file).
      if (Array.isArray(a.paths)) return a.paths.map(String).join(", ");
      if (a.source && a.destination) return `${a.source} → ${a.destination}`;
      return String(a.path || a.pattern || "");
    }
    if (tc.function.name === "grep") {
      const path = a.path ? ` in ${a.path}` : "";
      return `"${a.pattern || ""}"${path}`;
    }
    if (tc.function.name === "generate_image" || tc.function.name === "generate_video") return String(a.prompt || "");
    if (tc.function.name === "task") return String(a.description || "");
    if (tc.function.name === "lsp") return `${a.operation || "query"} ${a.filePath || ""}`.trim();
    if (tc.function.name === "delegate") return String(a.description || "");
    if (tc.function.name === "delegation_read") return String(a.id || "");
    if (tc.function.name === "process_logs" || tc.function.name === "process_stop")
      return a.id != null ? String(a.id) : "";
    return String(a.query || "");
  } catch {
    return "";
  }
}

export function tryParseArg(tc: ToolCall | undefined, key: string): string {
  if (!tc) return "";
  try {
    return JSON.parse(tc.function.arguments)[key] || "";
  } catch {
    return "";
  }
}

// Maps a tool name to a present-continuous verb used as the group header.
// Mirrors Claude Code's "Reading…" / "Searching…" / "Running…" affordances.
// Returns "Working" for unknown tools so the header never goes blank.
export function verbForTool(name: string): string {
  if (name === "read_file" || /^mcp_+filesystem__read_(text_)?file$/.test(name) || name === "read_multiple_files")
    return "Reading";
  if (name === "write_file" || name === "edit_file" || /^mcp_+filesystem__(write_file|edit_file)$/.test(name))
    return "Editing";
  if (name === "bash") return "Running";
  if (name === "grep" || name === "search_files" || /^mcp_+filesystem__search_files$/.test(name)) return "Searching";
  if (name === "search_web" || name === "search_x") return "Searching";
  if (name === "task" || name === "delegate") return "Exploring";
  if (name === "generate_image" || name === "generate_video" || name === "generate_plan") return "Generating";
  if (name === "list_directory" || /^mcp_+filesystem__(list_directory|directory_tree)/.test(name)) return "Listing";
  if (name === "lsp") return "Inspecting";
  if (name === "process_logs" || name === "process_list" || name === "delegation_list" || name === "delegation_read")
    return "Reading";
  if (name === "process_stop") return "Stopping";
  return "Working";
}

// Pick the verb that dominates a batch of tool calls. Falls back to "Working"
// when the list is empty or no verb wins outright. Used by ToolGroup header
// to mirror the dominant action ("Reading 4 files" vs generic "Working").
export function dominantVerb(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return "Working";
  const counts = new Map<string, number>();
  for (const n of toolNames) {
    const v = verbForTool(n);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = "Working";
  let max = 0;
  for (const [v, c] of counts) {
    if (c > max) {
      max = c;
      best = v;
    }
  }
  return best;
}

export function toolLabel(tc: ToolCall): string {
  const args = toolArgs(tc);
  if (tc.function.name === "bash") {
    try {
      const parsed = JSON.parse(tc.function.arguments);
      if (parsed.background) return `Background: ${trunc(args || "Starting process...", 70)}`;
    } catch {
      /* */
    }
    return trunc(args || "Running command...", 80);
  }
  if (tc.function.name === "read_file") return `Read ${trunc(args, 60)}`;
  if (tc.function.name === "write_file") return `Write ${trunc(args, 60)}`;
  if (tc.function.name === "edit_file") return `Edit ${trunc(args, 60)}`;
  if (tc.function.name === "grep") return `Grep ${trunc(args, 60)}`;
  if (tc.function.name === "search_web") return `Web Search "${trunc(args, 60)}"`;
  if (tc.function.name === "search_x") return `X Search "${trunc(args, 60)}"`;
  if (tc.function.name === "generate_image") return `Generate image "${trunc(args, 60)}"`;
  if (tc.function.name === "generate_video") return `Generate video "${trunc(args, 60)}"`;
  if (tc.function.name === "task") return `Task ${trunc(args, 60)}`;
  if (tc.function.name === "delegate") return `Background ${trunc(args, 60)}`;
  if (tc.function.name === "delegation_read") return `Read delegation ${trunc(args, 60)}`;
  if (tc.function.name === "delegation_list") return "List delegations";
  if (tc.function.name === "process_logs") return `Logs for process ${args}`;
  if (tc.function.name === "process_stop") return `Stop process ${args}`;
  if (tc.function.name === "process_list") return "List processes";
  if (tc.function.name === "generate_plan") return "Generating plan...";
  const mcp = describeMcpFsTool(tc.function.name);
  if (mcp) return `MCP ${mcp.ns} ${mcp.verb}${args ? ` ${trunc(args, 60)}` : ""}`;
  return trunc(`${tc.function.name} ${args}`, 80);
}
