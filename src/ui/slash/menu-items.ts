/**
 * Slash command autocomplete menu — single source of truth.
 *
 * Extracted from app.tsx so:
 *  1. Tests can verify drift between this list and the runtime registry
 *     without importing the full Ink/React UI module.
 *  2. New slash commands have ONE place to register their menu entry.
 *
 * Built-in commands (exit, help, clear, compact, mcp, agents, sandbox, wallet,
 * models, sessions, commit-*, review, verify, skills, btw, update, debug-*,
 * ee-*) are NOT in the runtime registry — they are handled by legacy switch
 * statements in app.tsx and live here as the only definition.
 *
 * Registry-backed commands (route, plan, execute, discuss, expand, optimize,
 * debug, council, cost, ee, pin, ideal) MUST appear here too — the parity
 * test in __tests__/menu-parity.test.ts enforces this.
 */

export interface SlashMenuItem {
  id: string;
  label: string;
  description: string;
  /**
   * When true the command is still routable (typed in full + Enter still works,
   * parity test still passes) but does NOT appear in the autocomplete dropdown
   * or `/help` listing. Use to declutter the splash for commands that exist
   * but are not part of the current "primary surface".
   */
  hidden?: boolean;
}

/**
 * Visible-by-default commands shown in the autocomplete dropdown.
 * Curated set per product decision (2026-05-21): keep only the primary
 * surface (exit, providers, compact, clear, ideal, council). Everything
 * else is `hidden: true` and still works when typed in full.
 *
 * To promote a hidden command back into the dropdown, remove `hidden: true`.
 * To add a new command, append here AND register its handler via
 * `registerSlash` (parity test enforces this).
 */
export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  // ── Primary surface ────────────────────────────────────────────────────
  { id: "exit", label: "exit", description: "Quit the CLI" },
  {
    id: "providers",
    label: "providers",
    description: "Providers, keys and sign-in (K adds a key, Enter signs in with OAuth)",
  },
  { id: "compact", label: "compact", description: "Compact conversation context" },
  { id: "clear", label: "clear", description: "Clear conversation and start fresh" },
  { id: "ideal", label: "ideal", description: "Product Ideal Loop — from idea to shipped product, autonomously" },
  { id: "council", label: "council", description: "Multi-model adversarial debate" },
  // ── Hidden (still functional when typed in full) ───────────────────────
  { id: "help", label: "help", description: "Show available commands", hidden: true },
  { id: "remote-control", label: "remote-control", description: "Remote control", hidden: true },
  { id: "mcp", label: "mcp", description: "Manage MCP servers", hidden: true },
  { id: "sandbox", label: "sandbox", description: "Select shell sandbox mode", hidden: true },
  { id: "wallet", label: "wallet", description: "Wallet and payment settings", hidden: true },
  { id: "models", label: "models", description: "Alias of /providers", hidden: true },
  { id: "new", label: "new session", description: "Start a new session", hidden: true },
  { id: "resume", label: "resume", description: "List recent sessions to resume" },
  { id: "commit-push", label: "commit & push", description: "Commit and push", hidden: true },
  { id: "commit-pr", label: "commit & pr", description: "Commit and open PR", hidden: true },
  { id: "review", label: "review", description: "Review recent changes", hidden: true },
  { id: "verify", label: "verify", description: "Run local verification", hidden: true },
  { id: "update", label: "update", description: "Update muonroi-cli to the latest version", hidden: true },
  { id: "cost", label: "cost", description: "Show session cost breakdown", hidden: true },
  { id: "ee", label: "ee", description: "Experience Engine status and controls", hidden: true },
  { id: "route", label: "route", description: "Show current model routing info", hidden: true },
  { id: "plan", label: "plan", description: "Show active GSD plan", hidden: true },
  { id: "execute", label: "execute", description: "Execute active GSD plan", hidden: true },
  { id: "discuss", label: "discuss", description: "Discuss phase gray areas", hidden: true },
  { id: "expand", label: "expand", description: "Expand last compacted context", hidden: true },
  { id: "optimize", label: "optimize", description: "Optimize prompt for token savings", hidden: true },
  { id: "debug", label: "debug", description: "Toggle debug trace mode", hidden: true },
  { id: "debug-on", label: "debug on", description: "Enable pipeline debug tracing", hidden: true },
  { id: "debug-off", label: "debug off", description: "Disable pipeline debug tracing", hidden: true },
  { id: "debug-status", label: "debug status", description: "Show session debug summary", hidden: true },
  { id: "debug-last", label: "debug last", description: "Show last recorded trace", hidden: true },
  {
    id: "council-inspect",
    label: "council inspect",
    description: "Inspect a past council debate by session ID",
    hidden: true,
  },
  { id: "pin", label: "pin", description: "Pin a user message so it survives compaction", hidden: true },
  { id: "unpin", label: "unpin", description: "Remove a pinned message by sequence number", hidden: true },
  { id: "pins", label: "pins", description: "List currently pinned message sequences", hidden: true },
  { id: "export", label: "export", description: "Export entire conversation to a .txt file", hidden: true },
  { id: "status", label: "status", description: "Show Agile sprint progress dashboard", hidden: true },
  { id: "ponytail", label: "ponytail", description: "Toggle Lazy Senior AI Mode (on/off/status)", hidden: false },
];

/** Items shown in the splash autocomplete + /help listing. */
export const VISIBLE_SLASH_MENU_ITEMS: SlashMenuItem[] = SLASH_MENU_ITEMS.filter((m) => !m.hidden);

/**
 * Arrow-navigation order for the empty-query ("just /") dropdown: primary
 * surface first, then the hidden commands. The dropdown renders a scrolling
 * viewport, so listing the full set here makes every command reachable by
 * arrow keys without cluttering the top of the list (primary stays on top).
 */
export const SLASH_MENU_ITEMS_ARROW_ORDER: SlashMenuItem[] = [
  ...VISIBLE_SLASH_MENU_ITEMS,
  ...SLASH_MENU_ITEMS.filter((m) => m.hidden),
];
