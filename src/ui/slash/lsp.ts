/**
 * src/ui/slash/lsp.ts
 *
 * /lsp slash command handler — language-server onboarding & status.
 *   /lsp setup  — open the multi-select language setup card any time
 *   /lsp status — per-language install status of the built-in servers
 *
 * Self-registers on module import (imported by app.tsx alongside slash/ee).
 */

import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

const HELP = [
  "**Language servers (/lsp)**",
  "",
  "Usage:",
  "  /lsp setup   — Open the language picker (Space toggles, Enter installs)",
  "  /lsp status  — Show install status for every built-in language server",
].join("\n");

async function handleStatus(): Promise<string> {
  const { defaultLspSetupDeps, isLspServerInstalled, LSP_INSTALL_RECIPES } = await import("../../lsp/lsp-setup.js");
  const { listBuiltInServerMeta } = await import("../../lsp/builtins.js");
  const deps = defaultLspSetupDeps();
  const lines: string[] = ["**LSP servers**", ""];
  for (const server of listBuiltInServerMeta()) {
    const recipe = LSP_INSTALL_RECIPES[server.id];
    const installed = await isLspServerInstalled(server.id, deps);
    lines.push(
      installed
        ? `  ✓ ${recipe.label} (${server.id})`
        : `  – ${recipe.label} (${server.id}) — not installed (install: \`${recipe.manualCommand}\`)`,
    );
  }
  lines.push("", "Run `/lsp setup` to pick and install servers for your languages.");
  return lines.join("\n");
}

export const handleLspSlash: SlashHandler = async (args, _ctx) => {
  const sub = args[0]?.toLowerCase();
  if (!sub || sub === "help") return HELP;

  // `/lsp setup` opens the guided multi-select card (mirrors `/ee setup`):
  // reset the once-per-session dedupe so an explicit request always re-opens.
  if (sub === "setup") {
    const { publishLspSetup, resetLspSetupAnnouncements } = await import("../../lsp/lsp-setup-bus.js");
    resetLspSetupAnnouncements(); // explicit request — bypass the once-per-session dedupe
    publishLspSetup();
    return "Opening the language-server setup card — Space toggles a language, Enter installs, esc closes.";
  }

  if (sub === "status") return await handleStatus();

  return `Unknown subcommand "${sub}".\n\n${HELP}`;
};

// Self-register on module import
registerSlash("lsp", handleLspSlash);
