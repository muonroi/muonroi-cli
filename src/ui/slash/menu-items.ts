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
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { id: "exit", label: "exit", description: "Quit the CLI" },
  { id: "help", label: "help", description: "Show available commands" },
  { id: "clear", label: "clear", description: "Clear conversation and start fresh" },
  { id: "compact", label: "compact", description: "Compact conversation context" },
  { id: "remote-control", label: "remote-control", description: "Remote control" },
  { id: "agents", label: "agents", description: "Manage custom sub-agents" },
  { id: "schedule", label: "schedule", description: "View scheduled runs" },
  { id: "mcp", label: "mcp", description: "Manage MCP servers" },
  { id: "sandbox", label: "sandbox", description: "Select shell sandbox mode" },
  { id: "wallet", label: "wallet", description: "Wallet and payment settings" },
  { id: "models", label: "models", description: "Select a model" },
  { id: "new", label: "new session", description: "Start a new session" },
  { id: "sessions", label: "sessions", description: "List recent sessions to resume" },
  { id: "commit-push", label: "commit & push", description: "Commit and push" },
  { id: "commit-pr", label: "commit & pr", description: "Commit and open PR" },
  { id: "review", label: "review", description: "Review recent changes" },
  { id: "verify", label: "verify", description: "Run local verification" },
  { id: "skills", label: "skills", description: "Manage skills" },
  { id: "btw", label: "btw", description: "Ask a side question without interrupting" },
  { id: "update", label: "update", description: "Update muonroi-cli to the latest version" },
  { id: "cost", label: "cost", description: "Show session cost breakdown" },
  { id: "ee", label: "ee", description: "Experience Engine status and controls" },
  { id: "route", label: "route", description: "Show current model routing info" },
  { id: "plan", label: "plan", description: "Show active GSD plan" },
  { id: "execute", label: "execute", description: "Execute active GSD plan" },
  { id: "discuss", label: "discuss", description: "Discuss phase gray areas" },
  { id: "expand", label: "expand", description: "Expand last compacted context" },
  { id: "optimize", label: "optimize", description: "Optimize prompt for token savings" },
  { id: "debug", label: "debug", description: "Toggle debug trace mode" },
  { id: "debug-on", label: "debug on", description: "Enable pipeline debug tracing" },
  { id: "debug-off", label: "debug off", description: "Disable pipeline debug tracing" },
  { id: "debug-status", label: "debug status", description: "Show session debug summary" },
  { id: "debug-last", label: "debug last", description: "Show last recorded trace" },
  { id: "council", label: "council", description: "Multi-model adversarial debate" },
  { id: "council-inspect", label: "council inspect", description: "Inspect a past council debate by session ID" },
  { id: "ideal", label: "ideal", description: "Product Ideal Loop — autonomous build from idea to ship" },
  { id: "pin", label: "pin", description: "Pin a user message so it survives compaction" },
  { id: "unpin", label: "unpin", description: "Remove a pinned message by sequence number" },
  { id: "pins", label: "pins", description: "List currently pinned message sequences" },
  { id: "ee-stats", label: "ee stats", description: "Knowledge base statistics" },
  { id: "ee-gates", label: "ee gates", description: "Quality gate checklist" },
  { id: "ee-evolve", label: "ee evolve", description: "Trigger EE evolution cycle" },
  { id: "ee-user", label: "ee user", description: "Current EE user identity" },
  { id: "ee-search", label: "ee search", description: "Semantic search across knowledge base" },
  { id: "ee-timeline", label: "ee timeline", description: "Principle evolution for a topic" },
  { id: "ee-graph", label: "ee graph", description: "Principle relationship graph" },
  { id: "ee-route", label: "ee route", description: "Route task to workflow" },
];
