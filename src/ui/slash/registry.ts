/**
 * src/ui/slash/registry.ts
 *
 * Slash command registry — extensible by feature plans (Plan 06+ add commands).
 * Plan 06 wires dispatchSlash() into app.tsx alongside existing switch.
 */

export interface SlashContext {
  cwd: string;
  tenantId: string;
  lastPrompt?: string;
  defaultProvider: string;
  defaultModel: string;
  sessionId?: string;
  /**
   * Returns the in-memory TUI scrollback (`messages` state in app.tsx). Used
   * by /export to compare what was persisted to the DB against what the user
   * actually saw on screen — they diverge when streaming chunks (council
   * debate, tool traces) render to TUI but never get appended to `messages`
   * as a ModelMessage. Optional so non-TUI callers (tests, MCP) can omit it.
   */
  getLiveEntries?: () => import("../../types/index.js").ChatEntry[];
}

export type SlashHandler = (args: string[], ctx: SlashContext) => Promise<string> | string;

const registry = new Map<string, SlashHandler>();

/** Register a slash command handler. */
export function registerSlash(name: string, handler: SlashHandler): void {
  registry.set(name, handler);
}

/**
 * Dispatch a slash command by name.
 * Returns null if command not registered (caller falls back to legacy switch).
 */
export async function dispatchSlash(name: string, args: string[], ctx: SlashContext): Promise<string | null> {
  const h = registry.get(name);
  if (!h) return null;
  return await h(args, ctx);
}

/** List all registered slash command names. */
export function listSlashCommands(): string[] {
  return [...registry.keys()];
}
