/**
 * src/mcp/setup-guide-text.ts
 *
 * Single source of the muonroi-cli setup guide, shared by BOTH surfaces that
 * expose it: the native in-CLI `setup_guide` builtin (src/tools/native-tools.ts)
 * and the muonroi-tools MCP server (src/mcp/tools-server.ts, for external agents).
 * Keeping it here avoids duplicating ~70 lines across the two.
 */
export const SETUP_GUIDE_TEXT = `# muonroi-cli Setup Guide

## Install (zero runtime deps — recommended)
Linux / macOS:
  curl -fsSL https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.sh | bash

Windows PowerShell:
  irm https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.ps1 | iex

Bun (requires Bun >= 1.3):
  bun add -g muonroi-cli
  # (npm install -g is NOT supported — TUI engine uses Bun-only ESM features)

The installers fetch a pre-compiled single binary from GitHub Releases.

## First run
- Wizard appears automatically.
- Lists supported providers (DeepSeek + SiliconFlow ready; others via BYOK).
- Four credential options: paste key, Bitwarden sync (B in /providers), keys export/import (encrypted bundle), or skip for later.
- Keys land in OS keychain (keytar). Settings written to ~/.muonroi-cli/user-settings.json.
- Role routing (leader/implement/verify/research) is configured for you.

After setup: run \`muonroi-cli doctor\` to validate.

## Essential commands
- Interactive TUI: \`muonroi-cli\` (or \`node dist/index.js\` after build)
- Headless one-shot: \`muonroi-cli --prompt "your task" --max-tool-rounds 8\`
- Health + MCP nudge: \`muonroi-cli doctor\`
- Update: \`muonroi-cli update\` (or set "autoUpdate": true in user-settings)
- Keys move between machines: \`muonroi-cli keys export file.json\` then import on target
- Native tools MCP (for external agents): \`muonroi-cli tools-mcp\` (stdio)
- Harness driver MCP: \`muonroi-cli mcp-driver\`

## MCP integration (for Claude Desktop, Cursor, other agents)
Add to your MCP client config:

{
  "mcpServers": {
    "muonroi-tools": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/muonroi-cli/src/index.ts", "tools-mcp"]
    }
  }
}

(Use absolute path. After \`bun run build\`: "node", "dist/index.js", "tools-mcp")

The CLI's OWN inner agent exposes these as NATIVE in-process tools (no MCP self-spawn):
- setup_guide (this document)
- ee_query / ee_health / ee_feedback — Experience Engine semantic recall + compaction checkpoints + feedback for learning
- usage_forensics <id-prefix> — per-session cost/token forensics (peak input, cache hits, anomalies)
- lsp_query — goToDefinition, findReferences, hover, symbols, call hierarchy etc.
- selfverify_* — Tier-1 heuristic + Tier-2 agentic self-QA harness runs (start/poll/result/cancel/list)

For BB/.NET template recipes and package docs, also connect an external "muonroi-docs" MCP server if available (provides docs_search + setup_guide for the templates).

## Development
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli && bun install

bun run dev                 # run from source (TUI)
bun run typecheck           # tsc --noEmit
bun run test                # vitest (unit + headless)
bunx vitest -c vitest.harness.config.ts run tests/harness/   # TUI E2E (named-pipes on Win, fd3/4 on POSIX)
bun run build               # or build:binary for standalone exe

See AGENTS.md (quick ref + rules), CLAUDE.md (harness verification), README.md.

## Verify
muonroi-cli doctor
# Checks runtimes, catalog load, keychain, MCP servers enabled, council research MCP nudge, EE reachability, recent error rate.
# Any "warn" entries tell you exactly what to enable (e.g. tavily for web research in council).

For BB-aware scaffolding (/ideal on a muonroi-building-block target): ensure dotnet SDK + the three Muonroi.*.Template packages are installed via NuGet; doctor surfaces missing feed/template cases.
`;
