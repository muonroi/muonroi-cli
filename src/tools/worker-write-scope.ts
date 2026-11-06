import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { normalizeMsysDrivePath } from "./write-scope.js";

export interface WorkerWriteScopeBinding {
  root: string;
  targets: string[];
}
export const SCOPED_WORKER_TOOL_NAMES = [
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "worker_message",
  "todo_write",
  "compact",
  "retrieve_tool_result",
  "context_load",
  "skill_load",
  "list_tools",
  "describe_tool",
  // Host-executed verification gate (src/tools/run-gate.ts): a catalog id, never
  // free-form argv. Registered only when the verify recipe yields at least one gate.
  "run_gate",
] as const;
const SCOPED_TOOLS: ReadonlySet<string> = new Set(SCOPED_WORKER_TOOL_NAMES);
export const WORKER_ISOLATION_CAPABILITIES = {
  fileScope: true,
  osSandbox: false,
  scopedCommands: false,
  scopedGates:
    "run_gate runs only build/test commands from the project's verify recipe, selected by id. Out-of-scope effects are DETECTED after the run (git status diff inside the repository), not prevented; writes outside the git repository or to git-ignored paths are not detected.",
  scopeUpdates:
    "Owner delegation_send(writeScope) changes the next write boundary; prose alone does not. [] revokes all workspace writes.",
  note: "File-scoped workers receive bounded native file tools plus run_gate, not shell/MCP/LSP. Omitted writeScope is legacy shared execution, not isolation.",
} as const;

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** No lexical fallback on permission errors, dangling links or unreadable ancestors. */
function canonicalTarget(target: string): string {
  let cursor = target;
  const tail: string[] = [];
  for (;;) {
    const existing = lstatSync(cursor, { throwIfNoEntry: false });
    if (existing) return path.resolve(realpathSync(cursor), ...tail);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Cannot resolve write target ancestor.");
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function safeSegments(relative: string): boolean {
  return relative.split(/[\\/]/).every(
    (s) =>
      s !== ".." &&
      !/^\.git$/i.test(s) &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in worker write paths.
      !/[:\x00-\x1f*?<>|]/.test(s) &&
      !/[. ]$/.test(s) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
  );
}

/** File-operation authorization, not OS isolation. Bind at dispatch; recheck before each write. */
export class WorkerWriteScope {
  readonly binding: WorkerWriteScopeBinding;
  private readonly entries: Array<{ target: string; recursive: boolean }>;
  constructor(
    readonly cwd: string,
    readonly paths: readonly string[],
    pinned?: WorkerWriteScopeBinding,
  ) {
    if (!Array.isArray(paths) || paths.length > 64)
      throw new Error("writeScope must be an array of at most 64 workspace-relative paths.");
    const root = realpathSync(cwd);
    if (!statSync(root).isDirectory()) throw new Error("Scope workspace must be a directory.");
    this.entries = paths.map((p) => {
      if (typeof p !== "string" || !p.trim() || p.length > 4096 || path.isAbsolute(p) || /^[\\/]|^[a-z]:/i.test(p))
        throw new Error("Scope entries must be nonempty workspace-relative files or directories ending in '/'.");
      const relative = p.replace(/^[.][\\/]/, "").replace(/[\\/]$/, "");
      if (!relative || !safeSegments(relative))
        throw new Error("Invalid scope path segment; traversal, special paths and wildcards are forbidden.");
      const target = canonicalTarget(path.resolve(root, relative));
      if (!inside(root, target) || target === root || !safeSegments(path.relative(root, target)))
        throw new Error("Scope entry escapes the workspace or aliases a forbidden path.");
      return { target, recursive: /[\\/]$/.test(p) };
    });
    this.binding = { root, targets: this.entries.map((e) => e.target) };
    if (pinned && JSON.stringify(pinned) !== JSON.stringify(this.binding))
      throw new Error("Scope workspace/entry was retargeted since the host decision.");
  }

  refusal(file: string, cwd: string): string | undefined {
    try {
      if (typeof file !== "string" || !file.trim()) throw new Error("Missing file path.");
      if (realpathSync(this.cwd) !== this.binding.root) throw new Error("Workspace was retargeted.");
      const absolute = path.resolve(cwd, normalizeMsysDrivePath(file));
      const relative = path.relative(this.binding.root, absolute);
      if (!inside(this.binding.root, absolute) || !safeSegments(relative))
        throw new Error("Target is outside the workspace or has a forbidden path segment.");
      const target = canonicalTarget(absolute);
      if (
        !inside(this.binding.root, target) ||
        !safeSegments(path.relative(this.binding.root, target)) ||
        !this.entries.some((e) => (e.recursive ? inside(e.target, target) : e.target === target))
      )
        throw new Error("Target is outside the current task writeScope.");
      const info = statSync(absolute, { throwIfNoEntry: false });
      if (info && (!info.isFile() || info.nlink > 1))
        throw new Error("Scoped writes require a regular file without hardlink aliases.");
      return undefined;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.file("warn", "orchestrator", "Worker write scope refused", { error });
      return `worker_write_scope_refused: ${error} No write performed. Ask main with worker_message(kind=question); main must issue an explicit writeScope decision before an out-of-scope repair. Do not route around the boundary.`;
    }
  }

  /**
   * Membership only: is the absolute path inside a current scope entry? Unlike
   * {@link refusal} this does not require a regular file (a changed path may be
   * deleted or a directory) and does not log — it classifies effects observed
   * after the fact (run_gate), it does not authorize a write.
   */
  covers(absolute: string): boolean {
    try {
      if (realpathSync(this.cwd) !== this.binding.root) return false;
      const target = canonicalTarget(path.resolve(absolute));
      const relative = path.relative(this.binding.root, target);
      return (
        inside(this.binding.root, target) &&
        safeSegments(relative) &&
        this.entries.some((e) => (e.recursive ? inside(e.target, target) : e.target === target))
      );
    } catch (err) {
      // Unresolvable path: classify as NOT covered (fail closed) and say why.
      logger.file("warn", "orchestrator", "Worker write scope membership check failed", {
        path: absolute,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

/** Fail closed by native identity; arbitrary MCP, aliases and future tools are not file-scoped. */
export function filterScopedWorkerTools<T extends Record<string, unknown>>(
  tools: T,
  native: Record<string, unknown>,
): T {
  return Object.fromEntries(
    Object.entries(tools).filter(([name, tool]) => SCOPED_TOOLS.has(name) && native[name] === tool),
  ) as T;
}
