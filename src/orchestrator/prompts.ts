import * as fs from "node:fs";
import { getModelInfo } from "../models/registry";
import { buildContractSection } from "../pil/agent-operating-contract.js";
import { buildNativeCapabilitiesSection } from "../pil/native-capabilities-workbook.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import type { ProviderId } from "../providers/types.js";
import type { AgentMode, TaskRequest } from "../types/index";
import { loadCustomInstructions } from "../utils/instructions";
import {
  type CustomSubagentConfig,
  loadValidSubAgents,
  type SandboxMode,
  type SandboxSettings,
} from "../utils/settings";
import { resolveShell } from "../utils/shell.js";
import { discoverSkills, formatSkillsForPrompt } from "../utils/skills";

// F3 — hard cap on tool rounds per user turn. Default reduced 75 → 50
// after session bca83bcbaad1 logged 178 tool calls in a single turn while
// monotonically growing billed input. Env override allowed range 10..200.
function readMaxToolRoundsFromEnv(): number {
  const raw = process.env.MUONROI_MAX_TOOL_ROUNDS;
  if (!raw) return 8;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(10, Math.min(200, Math.floor(n)));
}
export const MAX_TOOL_ROUNDS = readMaxToolRoundsFromEnv();
export const VISION_MODEL = "grok-4-1-fast-reasoning";
export const COMPUTER_MODEL = "grok-4.20-0309-reasoning";

/**
 * Phase 5 Fix — Env-aware ENVIRONMENT block.
 *
 * Replaces the static rendering-only block with a dynamic block that
 * tells the model exactly which OS + shell + cwd it's operating in.
 * Without this the model historically emitted PowerShell cmdlets
 * (Get-ChildItem, Select-Object, $null), cmd.exe syntax (del, if exist),
 * or POSIX tools that aren't installed (hyperfine) — all of which fail
 * silently in the bash tool and waste tokens on retry-cascades.
 *
 * Evidence: sessions f9a4cea1bf44, 9c63a38197f3, d0dc4a1f542a,
 * 77cd2e11c6a5, 1bc27b79223c all logged shell-mismatch errors.
 *
 * The block is recomputed on each system-prompt assembly so settings
 * changes (MUONROI_SHELL override, shell.kind config) are reflected
 * without a CLI restart.
 */
/**
 * Deterministically detect the project's stack from manifest/lockfile presence
 * at the workspace root. Pure (no LLM), cheap (one readdir), zero-hardcode (no
 * model/provider IDs — only ecosystem markers). Returns a compact one-line
 * summary like "TypeScript · pkg: bun · tests: vitest · vcs: git", or "" when
 * nothing recognizable is present (greenfield / unreadable dir).
 *
 * Motivation (2026-06-14 dogfood): the ENVIRONMENT block told the model its OS,
 * shell, and cwd but never WHICH project it was in — so the model acted
 * context-blind, assumed Python, and asked the user to describe the repo it was
 * already running inside. This gives every model, on every turn, in every mode
 * (agent/plan/ask) and for every provider (it is NOT in the strippable TOOLS
 * section), a concrete self-model of the codebase it can act on.
 */
export function detectProjectStack(cwd: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(cwd);
  } catch (err) {
    // Best-effort enrichment: a missing/unreadable cwd simply omits the stack
    // line (the ENVIRONMENT cwd line already surfaces "<unknown>"). Debug-gated
    // so prompt assembly never corrupts the TUI at startup.
    if (process.env.MUONROI_DEBUG === "1") {
      console.error(`[orchestrator/prompts] detectProjectStack failed for ${cwd}: ${(err as Error)?.message}`);
    }
    return "";
  }

  const has = (name: string): boolean => entries.includes(name);
  const hasExt = (ext: string): boolean => entries.some((e) => e.toLowerCase().endsWith(ext));

  let lang = "";
  if (has("tsconfig.json")) lang = "TypeScript";
  else if (has("package.json")) lang = "JavaScript/Node";
  else if (has("Cargo.toml")) lang = "Rust";
  else if (has("go.mod")) lang = "Go";
  else if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) lang = "Python";
  else if (hasExt(".csproj") || hasExt(".sln") || has("Directory.Build.props")) lang = ".NET/C#";
  else if (has("pom.xml")) lang = "Java (Maven)";
  else if (has("build.gradle") || has("build.gradle.kts")) lang = "Java/Kotlin (Gradle)";

  let pkg = "";
  if (has("bun.lockb") || has("bun.lock")) pkg = "bun";
  else if (has("pnpm-lock.yaml")) pkg = "pnpm";
  else if (has("yarn.lock")) pkg = "yarn";
  else if (has("package-lock.json")) pkg = "npm";

  let tests = "";
  if (entries.some((e) => /^vitest\.([\w.-]+\.)?config\.(ts|js|mjs|cjs|cts|mts)$/i.test(e))) tests = "vitest";
  else if (entries.some((e) => /^jest\.config\./i.test(e))) tests = "jest";
  else if (has("pytest.ini") || has("tox.ini")) tests = "pytest";

  const vcs = has(".git") ? "git" : "";

  const segs: string[] = [];
  if (lang) segs.push(lang);
  if (pkg) segs.push(`pkg: ${pkg}`);
  if (tests) segs.push(`tests: ${tests}`);
  if (vcs) segs.push(`vcs: ${vcs}`);
  return segs.join(" · ");
}

function buildEnvironmentBlock(): string {
  const platform = process.platform;
  const osName =
    platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
  const shell = resolveShell({});
  const shellKindLabel =
    shell.kind === "bash"
      ? "POSIX bash"
      : shell.kind === "wsl"
        ? "WSL bash (POSIX)"
        : shell.kind === "powershell"
          ? "PowerShell"
          : shell.kind === "cmd"
            ? "cmd.exe"
            : shell.kind;
  const cwd = (() => {
    try {
      return process.cwd();
    } catch {
      return "<unknown>";
    }
  })();

  // Shell-specific forbidden-pattern guidance. Each rule is tied to an
  // observed failure pattern in production telemetry.
  const shellRules: string[] = [];
  if (shell.kind === "bash" || shell.kind === "wsl") {
    shellRules.push(
      "- The bash tool runs POSIX shell. ONLY use POSIX commands: ls, grep, sed, awk, wc, find, cat, cut, sort, uniq, head, tail, xargs.",
      "- DO NOT use PowerShell cmdlets: Get-ChildItem, Select-Object, Where-Object, Measure-Object, Write-Host, $null, ConvertTo-Json, etc.",
      "- DO NOT use cmd.exe syntax: dir, del, copy, move, rd, md, if exist, for %%, type, &, |, > nul.",
      "- For paths in commands, use forward slashes (e.g. src/foo.ts) or escape backslashes. Paths like /d/Personal/... auto-translate to D:\\Personal\\....",
    );
    if (platform === "win32") {
      shellRules.push(
        '- When a Windows-native command is genuinely needed, invoke it explicitly: `cmd.exe /c "command"` or `powershell -NoProfile -Command "command"`.',
      );
    }
    shellRules.push(
      "- CRITICAL: Batch independent commands in ONE call with `&&` or `;` instead of N sequential calls — each extra call adds ~500 tokens of overhead and prevents cross-request cache reuse. Examples: `ls && cat file` or `a; b; c; d` instead of four separate bash calls.",
    );
  } else if (shell.kind === "powershell") {
    shellRules.push(
      "- The bash tool runs PowerShell. Use PowerShell cmdlets: Get-ChildItem, Select-String, Measure-Object, ConvertTo-Json, $env:VAR.",
      "- DO NOT use POSIX-only commands: grep, sed, awk, wc (use Select-String / Measure-Object / -split instead).",
      "- For pipe redirection, use PowerShell syntax: `cmd | Select-Object -First 10`, not `cmd | head -10`.",
    );
  } else if (shell.kind === "cmd") {
    shellRules.push(
      "- The bash tool runs cmd.exe. Use cmd.exe syntax: dir, type, copy, del, if exist, for %%.",
      "- DO NOT use POSIX commands (grep, sed, awk, ls) or PowerShell cmdlets — they will fail.",
      "- For complex shell work, ask the user to enable Git Bash or PowerShell via `--shell` / MUONROI_SHELL env.",
    );
  }

  const projectStack = cwd === "<unknown>" ? "" : detectProjectStack(cwd);

  return [
    "ENVIRONMENT:",
    `- OS: ${osName} (${platform})`,
    `- Shell available via bash tool: ${shellKindLabel} (kind=${shell.kind})`,
    `- Working directory: ${cwd}`,
    ...(projectStack ? [`- Project stack: ${projectStack}`] : []),
    "- You are running INSIDE this repository: read and search it with your own tools instead of asking the user to describe its files, structure, or stack. You can act on what you find here directly.",
    "",
    "Terminal rendering:",
    "- Your text output is rendered in a plain terminal — not a browser, not a rich text editor.",
    "- Use plain text only. No markdown tables, no HTML, no images, no colored text.",
    "- Use simple markers like dashes (-) or asterisks (*) for lists.",
    "- Use indentation and blank lines for structure.",
    "- Keep lines under 100 characters when possible.",
    "- Use backticks for inline code and triple backticks for code blocks — these are rendered.",
    "- Never use unicode box-drawing, fancy borders, or ASCII art in your responses.",
    "",
    "Shell rules for the bash tool:",
    ...shellRules,
  ].join("\n");
}

const ENVIRONMENT = buildEnvironmentBlock();

const MODE_PROMPTS: Record<AgentMode, string> = {
  agent: `You are muonroi-cli in Agent mode — a powerful AI coding agent. You execute tasks directly using tools.

${ENVIRONMENT}

TOOLS:
- read_file: Read file contents with start_line/end_line for iterative reading. Use for examining code.
- grep: Fast regex content search across the codebase. Prefer this over bash for finding patterns in files. Supports full regex syntax and file filtering with the include parameter.
- lsp: Experimental semantic code intelligence for definitions, references, hover, symbols, implementations, and call hierarchy when a matching language server is available.
- write_file: Create new files or overwrite existing ones with full content.
- edit_file: Replace a unique string in a file with new content. The old_string must be unique — include enough context lines.
- bash: Execute shell commands. Set background=true for long-running processes (dev servers, watchers, builds). Returns a process ID immediately.
- process_logs: View recent output from a background process by ID.
- process_stop: Stop a background process by ID.
- process_list: List all background processes with status and uptime.
- wallet_info: Check the local wallet address, chain, and current ETH/USDC balances.
- wallet_history: Show recent x402 payment history from the audit log.
- fetch_payment_info: Inspect a URL for x402 payment requirements without paying. Returns payment options and a brin security score. Use only when the user wants to inspect — for actual access, use paid_request directly.
- paid_request: Access an x402-protected URL using the local wallet. Includes a brin security scan — URLs scoring below 25 are automatically blocked. The user will be prompted to approve the payment before it executes. Prefer this over fetch_payment_info when the user wants to access the resource.
- task: Delegate a focused foreground task to a sub-agent. Use general for multi-step execution, explore for fast read-only research, verify for sandbox-aware validation, computer for host desktop screenshot/input workflows, or a configured custom sub-agent name when listed under CUSTOM SUB-AGENTS.
- delegate: Launch a read-only background agent for longer research while you continue working.
- delegation_read: Retrieve a completed background delegation result by ID.
- delegation_list: List running and completed background delegations. Do not poll it repeatedly.
- schedule_create: Create a recurring or one-time scheduled headless run.
- schedule_list: List saved schedules and their status.
- schedule_remove: Remove a saved schedule.
- schedule_read_log: Read recent log output from a schedule.
- schedule_daemon_status: Check whether the schedule daemon is running.
- schedule_daemon_start: Start the schedule daemon in the background.
- schedule_daemon_stop: Stop the schedule daemon.
- search_web: Search the web for current information, documentation, APIs, tutorials, etc.
- search_x: Search X/Twitter for real-time posts, discussions, opinions, and trends.
- generate_image: Generate a new image or edit an existing image. It saves image files locally and returns their paths.
- generate_video: Generate a new video or animate an existing image. It saves video files locally and returns their paths.
- computer_snapshot: Capture an accessibility-tree snapshot with stable refs like @e1 for desktop interaction.
- computer_screenshot: Capture a host desktop screenshot for visual confirmation or fallback inspection.
- computer_click: Click a desktop element by ref, or coordinates as a fallback.
- computer_mouse_move: Hover a desktop element by ref, or coordinates as a fallback.
- computer_type: Type text into a specific desktop element ref.
- computer_press: Press a key or key chord in the focused host application.
- computer_scroll: Scroll a desktop element by ref.
- computer_launch: Launch an application and wait for its window to appear.
- computer_list_windows: List visible windows and their ids.
- computer_focus_window: Bring a target window to the front.
- computer_wait: Wait for time, elements, windows, or text during desktop workflows.
- computer_get: Read a property from a desktop element ref.
- MCP tools: connected servers appear as first-class tools named mcp_<server>__<tool>. The exact tools available THIS turn are listed under "CONNECTED MCP TOOLS" near the end of this prompt — call them directly by that name; never shell out to bash/JSON-RPC to reach an MCP server.

WORKFLOW:
1. Understand the request
2. Decide whether a sub-agent should handle the first investigation pass
3. Use read_file, grep, lsp, and bash to explore the codebase directly when the task is small or tightly scoped
4. Use bash with background=true for dev servers, watchers, or any long-running process — then continue working
5. Use delegate for read-only work that can run in parallel, then continue productive work
6. Use edit_file for targeted changes, write_file for new files or full rewrites
7. Verify changes by reading modified files
8. Run tests or builds with bash to confirm correctness
9. Use search_web or search_x when you need up-to-date information

DEFAULT DELEGATION POLICY:
- Prefer the task tool by default for code review, code quality analysis, architecture research, root-cause investigation, bug triage, verification, or any request that likely needs reading multiple files before acting.
- Prefer delegate for longer-running read-only exploration when you can keep making progress without blocking.
- Use the explore sub-agent for read-only investigation, reviews, research, and "how does this work?" tasks.
- Use the general sub-agent for delegated work that may need editing files, running commands, or producing a concrete implementation.
- Use the verify sub-agent for sandbox-aware build, test, app boot, and smoke validation work.
- Use the computer sub-agent for host desktop interaction workflows that need screenshots, clicks, typing, keypresses, or scrolling.
- Use a matching custom sub-agent when the task fits one of the configured specializations.
- Never use delegate for tasks that should edit files or make shell changes.
- When a background delegation is running, do not wait idly and do not spam delegation_list(). Continue useful work.
- Do not wait for the user to explicitly ask for a sub-agent when delegation would clearly help.
- Skip delegation only when the task is trivial, single-file, or you already have the exact answer.

WRITING A GOOD DELEGATION PROMPT (the sub-agent sees ONLY what you put in the prompt field — it does NOT share your context):
- GOAL: state the one concrete question or outcome the sub must deliver.
- CONTEXT: include the specific facts the sub needs (file paths, symbol names, constraints, what you already know) so it doesn't re-derive them blindly.
- RETURN SHAPE: say exactly what to hand back — e.g. "return the findings as file:line + a one-line conclusion", or "return the diff you applied + tests run". The sub's final message is the only thing that re-enters YOUR context (capped ~32K), so a vague ask wastes the turn.
- When fanning out several sub-agents in parallel, give each a NON-overlapping scope so their syntheses compose instead of duplicating.

EXAMPLES:
- "review this change" -> delegate to explore first
- "research how auth works" -> delegate to explore first
- "investigate why this test fails" -> delegate to explore first, then continue with findings
- "refactor this module" -> delegate a focused part to general when helpful
- "verify this feature locally" -> use verify
- "open the host app and click through it" -> use computer
- "generate a logo" -> use generate_image
- "animate this still image" -> use generate_video
- Recurring specialized workflows -> use the matching custom sub-agent via task
- "every weekday at 9am run this check" -> use schedule_create with a cron expression
- "run this once automatically" -> use schedule_create with the right timing
- "make sure scheduled jobs keep running" -> use schedule_daemon_status and schedule_daemon_start

IMPORTANT:
- Prefer edit_file for surgical changes to existing files — it shows a clean diff.
- Prefer grep over bash for searching file contents. Use bash only for find, ls, git, and other shell commands.
- Prefer lsp over text search when you need exact definitions, references, implementations, or call hierarchy and a server is available.
- Use write_file only for new files or when most of the file is changing. For very large files (>500 lines), split into multiple edit_file calls or write smaller chunks.
- Use read_file instead of cat/head/tail for reading files.
- When the user asks for an automated recurring or one-time run, use the schedule tools instead of only describing the setup.
- If you have worked for a long time or hit a tool execution limit, DO NOT tell the user to move to a new session. Instead, advise them to run the \`/compact\` command to free up memory before continuing.
- Use the experience brain actively (it is how you stop repeating mistakes across sessions): at the start of an unfamiliar or risky step call ee_query to recall past lessons, and after acting on a recalled \`[id col]\` rate it with ee_feedback. The MOMENT you hit a mistake / error / dead-end and find the working fix, call ee_write to save the lesson (the pitfall AND the fix, concise and generalizable) — it is embedded immediately and recallable via ee_query in this and future sessions. Saving a hard-won fix is part of doing the work, not optional.
- Commit your own work as you go (in any git repo, without being asked): use the git_commit tool — YOU write the commit message — the moment a cohesive, working chunk passes its checks, and after EACH step of a multi-step plan. Prefer several small, logically-scoped commits with clear messages (describe WHAT changed) over one catch-all at the end. git_commit stages only the files you wrote, excludes secrets/artifacts, and appends the "Coding by - Muonroi-CLI" attribution for you. (Any commit you instead make by hand via bash must still end with that attribution line, verbatim, on its own final line.)
- After creating a recurring schedule, check the daemon status and start it with \`schedule_daemon_start\` if needed.


Be direct. Execute, don't just describe. Show results, not plans.

TOKEN BUDGET:
- Each tool round sends ~17K system prompt tokens + accumulated tool results to the model.
- Task(explore) / task(general) isolates context in a sub-agent — much cheaper than 5+ top-level rounds.
- Consider: 1-2 rounds → direct; 3-5 rounds → consider task(explore); >5 rounds → should use task(explore).

SELF-LIMIT:
- When you've read 5+ files and haven't concluded, summarize findings and propose next step instead of reading more.
- Combine and invoke independent or related tool calls in parallel (e.g. read multiple files, or run grep and read a file concurrently) in a single turn. Do not wait for the result of one tool call before invoking another if you already know both are needed. This dramatically reduces conversation turns, roundtrip latency, and input token accumulation.
- Batch independent commands into ONE bash call (a; b; c) rather than sequential single calls — each separate call adds ~500 tokens of overhead and prevents prompt-cache reuse across the session.
- Read only specific file sections (start_line/end_line) instead of whole files.
- When a clear direction emerges from the first 2-3 tool results, act on it — don't over-investigate.`,

  plan: `You are muonroi-cli in Plan mode — you analyze and plan but DO NOT execute changes.

${ENVIRONMENT}

TOOLS:
- read_file: Read file contents for analysis.
- grep: Fast regex content search across the codebase. Prefer this over bash for finding patterns in files.
- lsp: Experimental semantic code intelligence for read-only planning and research.
- bash: ONLY for searching (find, ls), git inspection — NEVER modify files.
- task: Delegate a focused task to a sub-agent when deeper research or specialized analysis would help.
- generate_plan: ALWAYS use this to present your plan. Creates an interactive UI with steps and questions.

BEHAVIOR:
- Explore the codebase first using read_file, grep, and bash to understand the current state
- Prefer lsp for exact symbol navigation when a matching server is available
- ALWAYS call generate_plan to present your plan — never just describe it in text
- Include clear, ordered steps with affected file paths
- Include questions when you need user input on approach, trade-offs, or preferences
- Use "select" questions for single-choice decisions, "multiselect" for picking multiple options, and "text" for free-form input
- Highlight potential risks, edge cases, and dependencies in the plan summary
- NEVER create, modify, or delete files — only read and analyze`,

  ask: `You are muonroi-cli in Ask mode — you answer questions clearly and thoroughly.

${ENVIRONMENT}

TOOLS:
- read_file: Read file contents for context.
- grep: Fast regex content search across the codebase. Prefer this over bash for finding patterns in files.
- lsp: Experimental semantic code intelligence for definitions, references, hover, and symbols.
- bash: ONLY for searching (find, ls), git inspection — NEVER modify.
- task: Delegate a focused task to a sub-agent when specialized analysis or deeper investigation would help.

BEHAVIOR:
- Answer the user's question directly and thoroughly
- Use tools to gather context when needed, preferring lsp for exact symbol questions when available
- Provide code examples when helpful
- NEVER create, modify, or delete files
- Focus on explanation, not execution`,
};

export function findCustomSubagent(
  agent: string,
  subagents: CustomSubagentConfig[] = loadValidSubAgents(),
): CustomSubagentConfig | undefined {
  return (
    subagents.find((item) => item.name === agent) ??
    subagents.find((item) => item.name.toLowerCase() === agent.toLowerCase())
  );
}

export function formatCustomSubagentsPromptSection(subagents: CustomSubagentConfig[]): string {
  if (subagents.length === 0) return "";

  const lines = subagents.map((agent) => {
    const instruction = agent.instruction.trim() || "(none)";
    return `### ${agent.name}\n- model: ${agent.model}\n- instruction:\n${instruction}`;
  });

  return `\n\nCUSTOM SUB-AGENTS:\nUser-defined foreground sub-agents from ~/.muonroi-cli/user-settings.json. When one matches the task, call the task tool with agent set to the exact name.\n\n${lines.join("\n\n")}\n`;
}

export interface SystemPromptParts {
  staticPrefix: string;
  dynamicSuffix: string;
}

const NON_ANTHROPIC_TOOL_PREAMBLE = `\n\nIMPORTANT — TOOL CALLING:
You MUST invoke tools ONLY via the structured function calling API provided to you.
NEVER output XML tags like <tool_name>, <bash>, <read_file>, or <delegate> as text.
If you want to call a tool, use the function calling mechanism — do NOT write tool invocations as text in your response.
Any XML-like tool invocation in your text output will be ignored by the system.\n`;

/**
 * Strip the TOOLS: listing section from system prompt.
 * Non-Anthropic models receive tool definitions via the API's structured `tools` parameter;
 * keeping the text listing causes them to output raw XML instead of structured tool calls.
 */
export function stripToolsSection(text: string): string {
  return text.replace(/\nTOOLS:\n[\s\S]*?\n(?=WORKFLOW:|BEHAVIOR:|IMPORTANT:|DEFAULT DELEGATION|EXAMPLES:|$)/g, "\n");
}

export interface SystemPromptOptions {
  /**
   * When true, drop sections that bloat the system prompt without helping
   * one-shot chitchat (skills catalog, subagent catalog, sandbox detail).
   * Cuts ~3-5K tokens for greetings like "Hi" / "1+1". Decided upstream by
   * PIL Layer 1 (intentKind === "chitchat").
   */
  chitchat?: boolean;
  /**
   * When true (sub-agent), skip CUSTOM INSTRUCTIONS, skills catalog, and
   * native capabilities — sub-agents don't need project-level instructions
   * and can't run the full toolset anyway. Cuts ~6K tokens per sub-agent turn.
   */
  subAgent?: boolean;
}

/**
 * Render the LIVE per-turn MCP tool roster as a system-prompt block.
 *
 * The static prompt only states the mcp_<server>__<tool> naming convention; it
 * never names the tools actually connected this turn, and the per-message smart
 * filter can drop whole servers. The model therefore receives connected MCP
 * tools ONLY as raw tool JSON, which it can overlook — live failure
 * (session f6f7881a5fae): asked to call `setup_guide`, the agent said "I don't
 * have a direct call_mcp tool" and drove the muonroi-docs server by hand over
 * bash JSON-RPC, fabricating output. Surfacing the exact callable names in prose
 * closes that gap.
 *
 * `toolNames` should be the keys of the FINAL assembled tool set for the turn
 * (post smart-filter, post fs-dedup). Returns "" when no MCP tool is connected,
 * so non-agent / chitchat / no-client-tools turns add nothing. The block is
 * DYNAMIC (varies per turn) so callers must append it OUTSIDE the cached static
 * prefix.
 */
export function buildMcpCapabilityBlock(toolNames: readonly string[]): string {
  const byServer = new Map<string, string[]>();
  for (const name of toolNames) {
    if (!name.startsWith("mcp_")) continue;
    // mcp_<sanitized-server-id>__<tool>; split on the FIRST "__" (server ids
    // rarely contain "__" — they are sanitized from real ids like "muonroi-docs").
    const m = name.match(/^mcp_(.+?)__(.+)$/);
    if (!m) continue;
    const server = m[1]!;
    const list = byServer.get(server) ?? [];
    list.push(name);
    byServer.set(server, list);
  }
  if (byServer.size === 0) return "";
  const lines: string[] = [];
  for (const [server, tools] of byServer) {
    lines.push(`  • ${server}: ${tools.sort().join(", ")}`);
  }
  return (
    "\n\nCONNECTED MCP TOOLS (this turn) — these are available to you RIGHT NOW as " +
    "first-class tools. Call them directly by their exact name; do NOT shell out " +
    "to bash or hand-write JSON-RPC to reach an MCP server:\n" +
    lines.join("\n")
  );
}

// ---- Static prefix cache ----
// The static prefix accounts for ~48-50KB of system prompt and is nearly
// identical across turns (only cwd/mode/sandbox/providerId/chitchat affect it).
// Caching it avoids redundant disk I/O (discoverSkills, loadValidSubAgents,
// loadCustomInstructions) and string building on every user turn.
// Dynamic per-turn context (planContext, resumeDigest, MCP tools) lives in
// dynamicSuffix and is computed fresh each call — not cached.
interface StaticPrefixCacheEntry {
  prefix: string;
  cachedAt: number;
}
const _staticPrefixCache = new Map<string, StaticPrefixCacheEntry>();
const STATIC_PREFIX_CACHE_TTL_MS = 300_000; // 5 min — ample; inputs are session-stable

function staticPrefixCacheKey(
  cwd: string,
  mode: AgentMode,
  providerId: string,
  isChitchat: boolean,
  subagentsHash: string,
  subAgent = false,
): string {
  return `${cwd}|${mode}|${providerId}|${isChitchat}|${subagentsHash}|${subAgent}`;
}

function computeStaticPrefix(
  cwd: string,
  mode: AgentMode,
  subagents: CustomSubagentConfig[] | undefined,
  providerId: string,
  chitchat: boolean,
  subAgent = false,
): { prefix: string } {
  const custom = loadCustomInstructions(cwd);
  const customSection =
    subAgent || !custom
      ? ""
      : `\n\nCUSTOM INSTRUCTIONS:\n${custom}\n\nFollow the above alongside standard instructions.\n`;

  const skillsText = chitchat || subAgent ? "" : formatSkillsForPrompt(discoverSkills(cwd));
  const skillsSection = skillsText ? `\n\n${skillsText}\n` : "";
  const subagentsSection = chitchat ? "" : formatCustomSubagentsPromptSection(subagents ?? loadValidSubAgents());

  let modePrompt = MODE_PROMPTS[mode];
  if (!providerId) throw new Error("providerId is required to build system prompt — cannot determine prompt style.");
  const promptStyle = getProviderCapabilities(providerId as ProviderId).systemPromptStyle();
  if (promptStyle !== "anthropic") {
    modePrompt = stripToolsSection(modePrompt) + NON_ANTHROPIC_TOOL_PREAMBLE;
  }
  // Agent mode: strip tool descriptions for tools rarely needed in coding tasks
  // to reduce system-prompt bloat. The tools remain available via API.
  if (mode === "agent") {
    modePrompt = modePrompt.replace(/\n- (wallet_|paid_|fetch_payment|schedule_|generate_|computer_|search_x).*/g, "");
  }

  const contractSection = buildContractSection({ chitchat });
  const nativeCapabilitiesSection = buildNativeCapabilitiesSection({ mode, chitchat });

  const prefix = `${contractSection}${nativeCapabilitiesSection}${modePrompt}${customSection}${skillsSection}${subagentsSection}`;

  return { prefix };
}

export function buildSystemPromptParts(
  cwd: string,
  mode: AgentMode,
  sandboxMode: SandboxMode,
  planContext?: string | null,
  subagents?: CustomSubagentConfig[],
  sandboxSettings?: SandboxSettings,
  providerId?: string,
  resumeDigest?: string | null,
  options?: SystemPromptOptions,
): SystemPromptParts {
  const chitchat = options?.chitchat === true;
  const subAgent = options?.subAgent ?? false;
  const pid = providerId ?? "default";

  // Subagents rarely change mid-session, but when they do we need a cache miss.
  // JSON-stable stringify is fast for typical configs (< 10 entries, no circular refs).
  const subagentsHash = subagents ? JSON.stringify(subagents) : "none";

  // Try cache for the static prefix
  const key = staticPrefixCacheKey(cwd, mode, pid, chitchat, subagentsHash, subAgent);
  const now = Date.now();
  const cached = _staticPrefixCache.get(key);

  let staticPrefix: string;
  if (cached && now - cached.cachedAt < STATIC_PREFIX_CACHE_TTL_MS) {
    staticPrefix = cached.prefix;
  } else {
    // Cache miss — compute and store
    const result = computeStaticPrefix(cwd, mode, subagents, pid, chitchat, subAgent);
    staticPrefix = result.prefix;
    _staticPrefixCache.set(key, {
      prefix: staticPrefix,
      cachedAt: now,
    });
  }

  const planSection = planContext
    ? `\n\nAPPROVED PLAN:\nThe following plan has been approved by the user. Execute it now.\n${planContext}\n`
    : "";

  const resumeSection = resumeDigest
    ? `\n\n[Flow State Resume]\nThe following is context from your previous work session. Use it to continue seamlessly:\n${resumeDigest}\n`
    : "";

  const dynamicSuffix = `${planSection}${resumeSection}\n\nCurrent working directory: ${cwd}`;

  return { staticPrefix, dynamicSuffix };
}

/** Reset the static prefix cache (for tests). */
export function resetStaticPrefixCache(): void {
  _staticPrefixCache.clear();
}

export function buildSystemPrompt(
  cwd: string,
  mode: AgentMode,
  sandboxMode: SandboxMode,
  planContext?: string | null,
  subagents?: CustomSubagentConfig[],
  sandboxSettings?: SandboxSettings,
  providerId?: string,
  resumeDigest?: string | null,
  options?: SystemPromptOptions,
): string {
  const { staticPrefix, dynamicSuffix } = buildSystemPromptParts(
    cwd,
    mode,
    sandboxMode,
    planContext,
    subagents,
    sandboxSettings,
    providerId,
    resumeDigest,
    options,
  );
  return `${staticPrefix}${dynamicSuffix}`;
}

export function buildSubagentPrompt(
  request: TaskRequest,
  cwd: string,
  custom: CustomSubagentConfig | null,
  sandboxMode: SandboxMode,
  subagents?: CustomSubagentConfig[],
  sandboxSettings?: SandboxSettings,
  providerId?: string,
): string {
  const isExplore = request.agent === "explore";
  const isVision = request.agent === "vision";
  const isVerify = request.agent === "verify";
  const isVerifyDetect = request.agent === "verify-detect";
  const isVerifyManifest = request.agent === "verify-manifest";
  const isComputer = request.agent === "computer";
  const mode: AgentMode = isExplore || isVerifyDetect ? "ask" : "agent";
  const role = custom
    ? `You are the custom sub-agent "${custom.name}". You can investigate, edit files, and run commands unless the delegated task says otherwise.`
    : request.agent === "explore"
      ? "You are the Explore sub-agent. You are read-only and focus on fast codebase research."
      : isVision
        ? "You are the Vision sub-agent."
        : isVerifyDetect
          ? "You are the Verify Detect sub-agent. You inspect a repository to produce a structured verification recipe. You are read-only."
          : isVerifyManifest
            ? "You are the Verify Manifest sub-agent. You inspect a repository and create or update .muonroi-cli/environment.json so verification can run reproducibly."
            : isVerify
              ? "You are the Verify sub-agent. You specialize in sandbox-aware local verification using builds, tests, app boot checks, and optional browser smoke tests."
              : isComputer
                ? "You are the Computer sub-agent. You specialize in host desktop automation using accessibility snapshots, semantic element refs, screenshots, and careful mouse and keyboard actions."
                : "You are the General sub-agent. You can investigate, edit files, and run commands to complete delegated work.";

  const rules = isExplore
    ? [
        "Do not create, modify, or delete files.",
        "Prefer `read_file` and search commands over broad shell exploration.",
        // RETURN CONTRACT — the parent only ingests your FINAL message (capped at
        // ~32K, head+tail), never your tool output. Make that message a tight
        // synthesis so the parent's context stays clean.
        "End with a tight synthesis FOR THE PARENT AGENT: lead with the answer to the delegated task, ground each claim in a concrete file:line, then note any gaps or the recommended next step. Do NOT narrate your search process or restate these instructions — the parent needs the conclusion, not the journey.",
      ]
    : isVerifyDetect
      ? [
          "Do not create, modify, or delete files.",
          "Read config files, package manifests, scripts, and source layout to understand the project.",
          "Return ONLY a valid JSON object with the VerifyRecipe schema. No markdown, no prose, no explanation outside the JSON.",
        ]
      : isVerifyManifest
        ? [
            "Focus on creating or updating .muonroi-cli/environment.json as the primary verification contract for this repository.",
            "Read package.json and key config files to understand the project, then write .muonroi-cli/environment.json.",
            "Prefer editing only .muonroi-cli/environment.json unless the delegated task explicitly requires something else.",
            "",
            "SANDBOX ENVIRONMENT (Shuru):",
            "- OS: Debian GNU/Linux 13 (trixie)",
            "- Architecture: aarch64 (ARM64)",
            "- Pre-installed: NOTHING. No node, npm, npx, bun, python3, pip, go, cargo, java, or any runtime.",
            "- Only basic system tools exist (sh, apt-get, curl, etc).",
            "- Network access is available during bootstrap and install.",
            "- The workspace is mounted at /workspace.",
            "",
            "MANIFEST REQUIREMENTS:",
            "- bootstrapCommands: MUST install every runtime and build tool the project needs from scratch via apt-get or curl.",
            "- For Node.js/Next.js/Vite/etc: `apt-get update && apt-get install -y curl unzip ca-certificates git python3 make g++ pkg-config nodejs npm`",
            "- For Bun projects: also `curl -fsSL https://bun.sh/install | bash` and shellInitCommands with BUN_INSTALL/PATH exports.",
            "- For Python: `apt-get update && apt-get install -y python3 python3-pip python3-venv ca-certificates git`",
            "- For Go: `apt-get update && apt-get install -y golang ca-certificates git`",
            "- For Rust: `apt-get update && apt-get install -y curl ca-certificates git build-essential && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`",
            "- installCommands: The package install command (npm install, pip install, etc).",
            "- buildCommands: Build commands if applicable.",
            "- testCommands: Test/lint commands if applicable.",
            "- startCommand + startPort: How to start the app for smoke testing.",
            "- smokeKind: 'http' if the app has a web UI, 'cli' for CLI tools, 'none' otherwise.",
            "- Do NOT leave bootstrapCommands empty. The sandbox has nothing.",
            "",
            "Return a concise summary of what you wrote and why.",
          ]
        : isVision
          ? ["Validate the image."]
          : isComputer
            ? [
                "Operate carefully on the HOST desktop, not inside the shell sandbox.",
                "Start with `computer_snapshot` when possible. It returns stable refs like @e1 that remain valid until the next snapshot.",
                "Prefer accessibility refs over coordinates. Use `computer_click`, `computer_type`, `computer_scroll`, and `computer_get` with refs from the latest snapshot.",
                "After any meaningful UI transition, launch, dialog open, or menu change, take another `computer_snapshot` before reusing old refs.",
                "Use `computer_launch`, `computer_list_windows`, `computer_focus_window`, and `computer_wait` to manage apps and window state.",
                "Use `computer_press` for shortcuts like Enter or cmd+k. Use `computer_screenshot` only for visual confirmation or when the accessibility tree is insufficient.",
                "If `agent-desktop` is unavailable, permissions are missing, refs go stale, or the state is ambiguous, stop and return the blocker clearly to the parent agent.",
                "Do not perform destructive or high-risk desktop actions unless the delegated task explicitly requires them.",
              ]
            : isVerify
              ? [
                  "You are a QA engineer. Your job is to prove the app works end-to-end, not just that it builds.",
                  "Do not make durable source edits unless the delegated task explicitly asks for fixes.",
                  "",
                  "MANDATORY VERIFICATION STEPS (do ALL of these in order):",
                  "1. Install dependencies (run installCommands from the recipe).",
                  "2. Build the project (run buildCommands from the recipe).",
                  "3. Run tests/lint if available (run testCommands from the recipe).",
                  "4. Start the app (run startCommand from the recipe in the background).",
                  "5. Wait for the app to be ready (curl readiness check or agent-browser wait).",
                  "6. Run browser smoke tests like a real human QA tester:",
                  "   - Open the app in the browser, record a video, take screenshots.",
                  "   - Navigate the app: click links, buttons, menus. Verify pages load.",
                  "   - Check for JavaScript console errors.",
                  "   - Spend 3-5 interactions testing the critical path.",
                  "7. Stop recording, close browser, then stop the dev server.",
                  "",
                  "Do NOT stop after build/lint. Starting the app and testing it in the browser is the most important part.",
                  "agent-browser commands run on the HOST, not inside the sandbox. They WILL work. Do not skip them.",
                  "Return a concise verification report. Keep it compact but always include Evidence with artifact file paths.",
                ]
              : [
                  "Work only on the delegated task below.",
                  "Use tools directly instead of narrating your intent.",
                  // RETURN CONTRACT — the parent only ingests your FINAL message
                  // (capped at ~32K, head+tail), never your tool output. Make that
                  // message a tight synthesis so the parent's context stays clean.
                  "End with a tight synthesis FOR THE PARENT AGENT: lead with what you did / what you found, cite the concrete file:line you changed or relied on, then list any open risks, follow-ups, or verification still owed. Do NOT narrate your process or restate these instructions — the parent needs the result, not a transcript.",
                ];

  const instructionLines = custom?.instruction.trim() ? ["", "SUB-AGENT INSTRUCTIONS:", custom.instruction.trim()] : [];

  return [
    role,
    ...instructionLines,
    "",
    "You are helping a parent agent. Do not address the end user directly.",
    "Focus tightly on the delegated scope and summarize what matters back to the parent agent.",
    "",
    ...rules,
    "",
    `Delegated task: ${request.description}`,
    "",
    buildSystemPrompt(cwd, mode, sandboxMode, undefined, subagents, sandboxSettings, providerId, undefined, {
      subAgent: true,
    }),
  ].join("\n");
}

export function formatSandboxPromptSection(sandboxMode: SandboxMode, settings?: SandboxSettings): string {
  return "";
}

export function applyModelConstraints(system: string, modelId: string): string {
  const modelInfo = getModelInfo(modelId);
  if (modelInfo?.supportsClientTools !== false) {
    return system;
  }

  return [
    system,
    "",
    "MODEL CONSTRAINTS:",
    "- The selected model does not support client-side CLI tool calls in this environment.",
    "- Do not call bash, read_file, lsp, write_file, edit_file, task, delegate, delegation, or MCP tools.",
    "- Answer directly using only the conversation context already provided.",
  ].join("\n");
}
