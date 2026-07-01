import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { HooksConfig } from "../hooks/types";
import type {
  LspBuiltInServerId,
  LspBuiltInServerSettings,
  LspCustomServerConfig,
  LspSettings,
  NormalizedLspSettings,
} from "../lsp/types";
import {
  getEffectiveReasoningEffort,
  getFirstCatalogModel,
  getFirstCatalogProvider,
  getModelByTier,
  getModelIds,
  getModelInfo,
  MODELS,
  normalizeModelId,
} from "../models/registry.js";
import { apiBaseFor, PROVIDER_ENDPOINTS } from "../providers/endpoints.js";
import type { ProviderId } from "../providers/types.js";
import { ALL_PROVIDER_IDS } from "../providers/types.js";
import type { AgentMode, ReasoningEffort } from "../types/index";
import { logger } from "./logger.js";
import { normalizeShellSettings, type ShellSettings } from "./shell";

export type ModelRole = "leader" | "implement" | "verify" | "research";

export function getCatalogDefaultModel(): string {
  const provider = getDefaultProvider();
  if (provider) {
    const m = getModelByTier("fast", provider);
    if (m) return m.id;
  }
  const m = getModelByTier("fast");
  if (m) return m.id;
  return getFirstCatalogModel().id;
}

export type TelegramStreamingMode = "off" | "partial";
export type CouncilExperienceMode = "off" | "advisory" | "enforcing";

/** @deprecated Phase 4 will replace with LemonSqueezy billing. Wallet UI only. */
export type PaymentChain = "base" | "base-sepolia";

/** @deprecated Phase 4 will replace with LemonSqueezy billing. Wallet UI only. */
export interface PaymentApprovalSettings {
  autoApprove?: boolean;
}

/** @deprecated Phase 4 will replace with LemonSqueezy billing. Wallet UI only. */
export interface PaymentSettings {
  enabled?: boolean;
  chain?: PaymentChain;
  approval?: PaymentApprovalSettings;
}

const DEFAULT_PAYMENT_SETTINGS: Required<PaymentSettings> = {
  enabled: false,
  chain: "base-sepolia",
  approval: { autoApprove: false },
};

const DEFAULT_LSP_SETTINGS: NormalizedLspSettings = {
  enabled: true,
  tool: true,
  autoInstall: true,
  startupTimeoutMs: 30_000,
  requestTimeoutMs: 30_000,
  diagnosticsDebounceMs: 200,
  builtins: {},
  servers: [],
};

export interface TelegramAudioInputSettings {
  /** Enable Telegram voice/audio transcription before sending text to the agent. Default: true. */
  enabled?: boolean;
  /** Language code (e.g. `en`, `fr`) forwarded to the STT endpoint. Default: en. */
  language?: string;
}

export interface TelegramSettings {
  botToken?: string;
  approvedUserIds?: number[];
  sessionsByUserId?: Record<string, string>;
  /** Live preview while generating. Default: partial (send + edit). Use `off` for buffer-then-send only. */
  streaming?: TelegramStreamingMode;
  /** Send `typing` chat action on an interval while the agent runs. Default: true. */
  typingIndicator?: boolean;
  /** Reserved: Bot API `sendMessageDraft` for private DMs (not implemented yet). */
  nativeDrafts?: boolean;
  audioInput?: TelegramAudioInputSettings;
}

export type McpRemoteTransport = "http" | "sse";

export interface McpServerConfig {
  id: string;
  label: string;
  enabled: boolean;
  transport: McpRemoteTransport | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpSettings {
  servers?: McpServerConfig[];
}

export interface CustomSubagentConfig {
  name: string;
  model: string;
  instruction: string;
}

const RESERVED_SUBAGENT_NAMES = new Set([
  "general",
  "explore",
  "vision",
  "verify",
  "verify-detect",
  "verify-manifest",
  "computer",
]);

export function isReservedSubagentName(name: string): boolean {
  return RESERVED_SUBAGENT_NAMES.has(name.trim().toLowerCase());
}

export function parseSubAgentsRawList(raw: unknown): CustomSubagentConfig[] {
  if (!Array.isArray(raw)) return [];

  const validModels = new Set(getModelIds());
  const seen = new Set<string>();
  const agents: CustomSubagentConfig[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;

    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const model = typeof entry.model === "string" ? normalizeModelId(entry.model) : "";
    const instruction = typeof entry.instruction === "string" ? entry.instruction : "";

    if (!name || isReservedSubagentName(name) || !validModels.has(model)) {
      continue;
    }

    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    agents.push({ name, model, instruction });
  }

  return agents;
}

export function loadValidSubAgents(): CustomSubagentConfig[] {
  return parseSubAgentsRawList(loadUserSettings().subAgents);
}

export interface ProviderKeyConfig {
  apiKey: string;
  baseURL?: string;
}

export interface UserSettings {
  apiKey?: string;
  defaultModel?: string;
  /**
   * Preferred provider. When set, the splash/config UI hides the model
   * picker and the router picks the model from this provider's catalog
   * (first balanced model, falling back to fast/premium). The legacy
   * defaultModel field stays as the hard pin for legacy paths.
   */
  defaultProvider?: ProviderId;
  /** When true, the agent prioritizes task completion over strict runaway safety caps. */
  agentFirst?: boolean;
  /** Custom soft limit on the number of tool execution steps before pausing. */
  maxToolRounds?: number;
  /** Custom hard limit on the number of tool execution steps per turn. */
  hardMaxToolRounds?: number;
  /** Custom limit on the number of LLM call round-trips allowed in a single turn. */
  maxLlmCallsPerTurn?: number;
  /** Shell used by the bash tool. On Windows, defaults to Git Bash when present. */
  shell?: ShellSettings;
  lsp?: LspSettings;
  reasoningEffortByModel?: Record<string, ReasoningEffort>;
  telegram?: TelegramSettings;
  mcp?: McpSettings;
  subAgents?: CustomSubagentConfig[];
  hooks?: HooksConfig;
  /** @deprecated Phase 4 will replace with LemonSqueezy billing. */
  payments?: PaymentSettings;
  modeModels?: Partial<Record<AgentMode, string>>;
  ecosystem?: { name: string; patterns: string[] };
  autoCompactAfterTurn?: boolean;
  /** Minimum % of context window to trigger post-turn auto-compact (default 0.25 = 25%, range 0.05-0.50). */
  autoCompactThresholdPct?: number;
  roleModels?: Partial<Record<ModelRole, string>>;
  councilRounds?: number;
  autoCouncil?: boolean;
  /**
   * Minimum PIL confidence required to auto-trigger council for plan/analyze
   * tasks. Default 0.85. Range 0.5-1.0. Lower values trigger council more
   * eagerly (better debate coverage, higher cost); higher values restrict it
   * to clearly-architectural prompts.
   */
  autoCouncilConfidence?: number;
  /**
   * Minimum number of configured roleModels required before auto-council
   * triggers. Default 2 — a "debate" needs at least two participants. Range 1-4.
   * Set to 1 to allow single-model auto-council (degenerate; mostly useful for
   * preserving legacy behavior).
   */
  autoCouncilMinRoles?: number;
  councilPreferMultiProvider?: boolean;
  /** EE involvement level in council debates. Default: advisory. CQ-19. */
  councilExperienceMode?: CouncilExperienceMode;
  /**
   * Cost-aware council sub-task routing. When true (default), trivial leader
   * sub-tasks (research-need decision, round summary, evaluation JSON parse,
   * clarification question gen, spec synthesis) drop down to a cheaper
   * fast/balanced tier model on the SAME provider, with fallback to the
   * leader model when no cheaper model is reachable.
   *
   * Final synthesis and debate-plan ALWAYS use the leader model — those
   * decide structure and quality, not throughput.
   */
  councilCostAware?: boolean;
  /** Set true after the user has been prompted (or skipped) the web-research onboarding. */
  webResearchPrompted?: boolean;
  /** Set true after the user has been prompted (or skipped) the first-run Experience Engine setup. */
  eeSetupPrompted?: boolean;
  /**
   * Unix ms timestamp of the last npm-registry update check. Used to throttle
   * checkForUpdate to once per day so the CLI never spams the registry on
   * every launch.
   */
  lastUpdateCheck?: number;
  /**
   * When true, the TUI skips the "Update available — install now?" modal and
   * runs the update silently when a newer version is detected. Defaults to
   * false (interactive prompt).
   */
  autoUpdate?: boolean;
  providers?: {
    anthropic?: ProviderKeyConfig;
    openai?: ProviderKeyConfig;
    google?: ProviderKeyConfig;
    deepseek?: ProviderKeyConfig;
    siliconflow?: ProviderKeyConfig;
    xai?: ProviderKeyConfig;
    ollama?: { baseURL?: string };
  };
  /** Providers the user has explicitly disabled in the model picker (still configured but hidden). */
  disabledProviders?: ProviderId[];
  /** Models the user has explicitly disabled in the model picker. Migration: missing field -> empty array. */
  disabledModels?: string[];
  /**
   * BB-aware EE context injection in /ideal CB-1 council prompts.
   * When false, fetchBBContext returns empty immediately — no network call, no telemetry.
   * Default: true.
   */
  eeBBContext?: boolean;
  /**
   * Ecosystem-aware bias for /ideal discovery + council + research prompts.
   * When true, leader recommendations, debate stances, and research lenses all
   * frame the answer around Muonroi ecosystem packages (BB, templates,
   * agent-harness-*) instead of generic options like "Node.js + Express".
   * Set to false to use muonroi-cli for projects outside the Muonroi ecosystem.
   * Default: true.
   */
  discoveryEcosystemBias?: boolean;
  /** Step-aware model routing: downgrade to cheaper model for tool-execution steps. */
  stepRouter?: {
    /** Enable step-aware routing. Default: true. */
    enabled?: boolean;
    /** Tier to use for tool-execution steps. Default: "fast". */
    toolExecutionTier?: "fast" | "balanced";
    /** Switch back to premium for final synthesis. Default: false. */
    premiumSynthesis?: boolean;
  };
  /**
   * Reporter auto-fire settings (B2).
   * Controls whether the reporter posts to Discord automatically on sprint
   * lifecycle events (sprint done, plan committed, halt).
   */
  reporter?: {
    /**
     * Enable automatic Discord posts on sprint lifecycle events.
     * Default: false (opt-in, to avoid accidental Discord spam on first ship).
     */
    autoFire?: boolean;
  };
  /**
   * Maximum cumulative chars of tool output a `task` sub-agent may receive
   * before its tool results get progressively trimmed (then stubbed out).
   * Prevents one sub-agent from accumulating 500k+ billed input tokens via
   * unbounded read_file/grep loops. Default 120_000 (~30k tokens). Range
   * 20_000–600_000.
   */
  subAgentBudgetChars?: number;
  /**
   * Cumulative tool-output budget for the TOP-LEVEL orchestrator tool loop
   * (the agentic streamText loop in runTurn, separate from sub-agents).
   * Same tiered compression as the sub-agent cap, but with a larger
   * default so casual single-tool turns are unaffected. Range
   * 50_000–1_500_000. Env override: MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS.
   * Default 400_000 (~100k tokens).
   */
  topLevelToolBudgetChars?: number;
  /**
   * Router tier-promotion cap. The session's default model is treated as the
   * user's cost ceiling: the EE router may DOWNGRADE per turn (cheaper model)
   * but may not promote to a HIGHER tier than this setting allows without an
   * explicit opt-in.
   *
   * - `"off"`: never promote beyond the default model's own tier.
   * - `"balanced"` (default): allow promotion up to balanced, never premium.
   *   Routine tasks the EE brain over-classifies as premium get clamped to
   *   balanced (or to the default model when the provider has no balanced
   *   option — e.g. DeepSeek native only has fast + premium).
   * - `"any"`: restore legacy behavior (router may promote to any tier).
   *
   * Evidence: session 89b34ce9a4e8 — default deepseek-v4-flash (fast tier),
   * stored session.model=flash, but EE warm path returned premium for a
   * routine "check và commit files" task → 47/47 turns silently ran on
   * deepseek-v4-pro ($0.353) instead of flash (~$0.06). The per-turn routing
   * override never flowed through setModel so the sessions row stayed flash
   * ("session.model lie"). Default cap="balanced" prevents that silent leak.
   */
  routingPromoteMax?: "off" | "balanced" | "any";
}

export interface ProjectSettings {
  model?: string;
  shell?: ShellSettings;
  lsp?: LspSettings;
}

function getUserSettingsPath(): string {
  return path.join(os.homedir(), ".muonroi-cli", "user-settings.json");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readJson<T>(filePath: string): T | null {
  const RETRIES = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch (err) {
      lastErr = err;
      const code = (err as any)?.code;
      if (code === "EBUSY" || code === "EPERM" || err instanceof SyntaxError) {
        logger.warn(
          "cli",
          `Lock contention or syntax error reading ${path.basename(filePath)}, retrying (attempt ${attempt + 1}/${RETRIES})`,
          { error: err },
        );
        // Spin wait briefly to let the lock release or the write complete
        const end = Date.now() + 20 * (attempt + 1);
        while (Date.now() < end) {
          // busy wait
        }
      } else {
        return null;
      }
    }
  }
  return null;
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const serialized = JSON.stringify(data, null, 2);
  const RETRIES = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      fs.writeFileSync(filePath, serialized, { mode: 0o600 });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as any)?.code;
      if (code === "EBUSY" || code === "EPERM") {
        logger.warn(
          "cli",
          `Lock contention writing ${path.basename(filePath)}, retrying (attempt ${attempt + 1}/${RETRIES})`,
          { error: err },
        );
        const end = Date.now() + 20 * (attempt + 1);
        while (Date.now() < end) {
          // busy wait
        }
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

/**
 * Ensure the CLI's own project-local footprint (`.muonroi-cli/`) is gitignored
 * in `cwd`, so it is never swept into a commit by `git add -A`. The directory
 * can hold provider API keys and sandbox secrets in `settings.json` /
 * `environment.json`; a real session committed it to a public repo. We add the
 * entry only inside an actual git repo (a `.git` dir/file present) to avoid
 * littering `.gitignore` into arbitrary directories. Idempotent and silent on
 * any I/O error — protection is best-effort and must never break the workflow.
 */
export function ensureFootprintGitignored(cwd: string = process.cwd()): void {
  const ENTRY = ".muonroi-cli/";
  try {
    if (!fs.existsSync(path.join(cwd, ".git"))) return; // not a git repo — skip
    const gitignorePath = path.join(cwd, ".gitignore");
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
      // Already covered by an exact or directory entry (`.muonroi-cli` or
      // `.muonroi-cli/`). Avoid matching unrelated lines via line-exact test.
      const lines = content.split(/\r?\n/).map((l) => l.trim());
      if (lines.includes(ENTRY) || lines.includes(".muonroi-cli")) return;
    }
    const comment = "# muonroi-cli local state (may contain API keys) — auto-added";
    let block: string;
    if (content.length === 0) {
      // Fresh file — no leading blank line.
      block = `${comment}\n${ENTRY}\n`;
    } else {
      const sep = content.endsWith("\n") ? "\n" : "\n\n";
      block = `${sep}${comment}\n${ENTRY}\n`;
    }
    fs.appendFileSync(gitignorePath, block);
  } catch (err) {
    // best-effort: permission denied / read-only fs — never break the caller.
    // Log at debug level only (No Silent Catch Rule) so a failure is diagnosable
    // without spamming normal runs.
    if (process.env.MUONROI_DEBUG) {
      console.error(
        `[settings] ensureFootprintGitignored failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function loadUserSettings(): UserSettings {
  return readJson<UserSettings>(getUserSettingsPath()) || {};
}

export function saveUserSettings(partial: Partial<UserSettings>): void {
  const current = loadUserSettings();
  const next: UserSettings = {
    ...current,
    ...partial,
    ...(partial.apiKey !== undefined ? { apiKey: partial.apiKey } : {}),
    ...(partial.defaultModel !== undefined ? { defaultModel: normalizeModelId(partial.defaultModel) } : {}),
    ...(partial.reasoningEffortByModel !== undefined
      ? {
          reasoningEffortByModel: Object.fromEntries(
            Object.entries(partial.reasoningEffortByModel).map(([modelId, effort]) => [
              normalizeModelId(modelId),
              effort,
            ]),
          ),
        }
      : {}),
    ...(partial.telegram !== undefined
      ? {
          telegram: {
            ...current.telegram,
            ...partial.telegram,
            audioInput: {
              ...current.telegram?.audioInput,
              ...partial.telegram?.audioInput,
            },
            sessionsByUserId: {
              ...current.telegram?.sessionsByUserId,
              ...partial.telegram?.sessionsByUserId,
            },
          },
        }
      : {}),
    ...(partial.mcp !== undefined
      ? {
          mcp: {
            ...current.mcp,
            ...partial.mcp,
            servers: partial.mcp.servers ?? current.mcp?.servers ?? [],
          },
        }
      : {}),
    ...(partial.subAgents !== undefined
      ? {
          subAgents: partial.subAgents.map((agent) => ({
            ...agent,
            model: normalizeModelId(agent.model),
          })),
        }
      : {}),
    ...(partial.shell !== undefined ? { shell: normalizeShellSettings({ ...current.shell, ...partial.shell }) } : {}),
    ...(partial.lsp !== undefined
      ? {
          lsp: mergeLspSettings(current.lsp, partial.lsp),
        }
      : {}),
    ...(partial.payments !== undefined
      ? {
          payments: {
            ...current.payments,
            ...partial.payments,
            approval: {
              ...current.payments?.approval,
              ...partial.payments?.approval,
            },
          },
        }
      : {}),
  };

  writeJson(getUserSettingsPath(), next);
}

export function loadProjectSettings(): ProjectSettings {
  const projectPath = path.join(process.cwd(), ".muonroi-cli", "settings.json");
  return readJson<ProjectSettings>(projectPath) || {};
}

export function saveProjectSettings(partial: Partial<ProjectSettings>): void {
  const projectPath = path.join(process.cwd(), ".muonroi-cli", "settings.json");
  // Protect the footprint BEFORE the first write so the secrets-bearing file is
  // gitignored from the moment it exists.
  ensureFootprintGitignored(process.cwd());
  const current = loadProjectSettings();
  writeJson(projectPath, {
    ...current,
    ...partial,
    ...(partial.model !== undefined ? { model: normalizeModelId(partial.model) } : {}),
    ...(partial.shell !== undefined ? { shell: normalizeShellSettings({ ...current.shell, ...partial.shell }) } : {}),
    ...(partial.lsp !== undefined
      ? {
          lsp: mergeLspSettings(current.lsp, partial.lsp),
        }
      : {}),
  });
}

export function getApiKey(): string | undefined {
  // Test escape hatch (api-key harness spec): suppress all key sources so the
  // boot flow reaches the API-key modal. See src/index.ts resolveKeyForModel.
  if (process.env.MUONROI_TEST_NO_KEYCHAIN === "1") return undefined;
  return process.env.MUONROI_API_KEY || loadUserSettings().apiKey;
}

export function getBaseURL(provider?: string): string {
  if (process.env.MUONROI_BASE_URL) return process.env.MUONROI_BASE_URL;
  const id = (provider ?? getDefaultProvider() ?? detectProviderFromCatalog()) as ProviderId;
  const endpoint = PROVIDER_ENDPOINTS[id]?.apiBase;
  if (!endpoint)
    throw new Error(`No API base URL for provider "${id}". Configure a provider in settings or catalog.json.`);
  return endpoint;
}

function detectProviderFromCatalog(): string {
  return getFirstCatalogProvider();
}

/**
 * Build provider configs for adapter creation.
 * Reads env vars + user-settings.json providers section.
 * Anthropic uses the main apiKey; others use providers.* keys.
 */
export function getProviderConfigs(
  mainApiKey?: string,
): Record<string, { apiKey?: string; baseURL?: string; model?: string }> {
  const settings = loadUserSettings();
  const p = settings.providers ?? {};

  const configs: Record<string, { apiKey?: string; baseURL?: string; model?: string }> = {};

  // Anthropic — main API key
  const anthropicKey = mainApiKey ?? getApiKey();
  if (anthropicKey) {
    configs.anthropic = { apiKey: anthropicKey, baseURL: getBaseURL() };
  }

  // OpenAI
  const openaiKey = process.env.OPENAI_API_KEY ?? p.openai?.apiKey;
  if (openaiKey) {
    configs.openai = { apiKey: openaiKey, baseURL: p.openai?.baseURL };
  }

  // Google Gemini
  const googleKey = process.env.GOOGLE_API_KEY ?? p.google?.apiKey;
  if (googleKey) {
    configs.google = { apiKey: googleKey, baseURL: p.google?.baseURL };
  }

  // DeepSeek
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? p.deepseek?.apiKey;
  if (deepseekKey) {
    configs.deepseek = {
      apiKey: deepseekKey,
      baseURL: p.deepseek?.baseURL ?? apiBaseFor("deepseek"),
    };
  }

  // SiliconFlow
  const siliconflowKey = process.env.SILICONFLOW_API_KEY ?? p.siliconflow?.apiKey;
  if (siliconflowKey) {
    configs.siliconflow = {
      apiKey: siliconflowKey,
      baseURL: p.siliconflow?.baseURL ?? apiBaseFor("siliconflow"),
    };
  }

  // xAI / Grok (OpenAI-compatible)
  const xaiKey = process.env.XAI_API_KEY ?? p.xai?.apiKey;
  if (xaiKey) {
    configs.xai = {
      apiKey: xaiKey,
      baseURL: p.xai?.baseURL ?? apiBaseFor("xai"),
    };
  }

  // Ollama — no key needed, just baseURL
  const ollamaURL = process.env.OLLAMA_URL ?? p.ollama?.baseURL ?? "http://localhost:11434";
  configs.ollama = { baseURL: ollamaURL };

  return configs;
}

export function getCurrentModel(mode?: AgentMode): string {
  // Only honor a configured model if it resolves to a known catalog entry.
  // Stale configs (e.g. retired ids like "deepseek-chat") otherwise break boot.
  // If the catalog hasn't loaded yet, skip validation and return the raw normalized id.
  const catalogReady = MODELS.length > 0;
  const pickValid = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const normalized = normalizeModelId(id);
    if (!catalogReady) return normalized;
    return getModelInfo(normalized) ? normalized : undefined;
  };

  const envModel = pickValid(process.env.MUONROI_MODEL);
  if (envModel) return envModel;

  const project = loadProjectSettings();
  const projectModel = pickValid(project.model);
  if (projectModel) return projectModel;

  if (mode) {
    const user = loadUserSettings();
    const modeModel = pickValid(user.modeModels?.[mode]);
    if (modeModel) return modeModel;
  }

  const user = loadUserSettings();
  return pickValid(user.defaultModel) ?? getCatalogDefaultModel();
}

/**
 * Returns the explicitly configured model for a mode, or undefined if none is set.
 * Only MUONROI_MODEL env var suppresses this (absolute override). Project-level model
 * does NOT suppress — modeModels is an explicit per-mode config that applies on mode switch.
 */
export function getModeSpecificModel(mode: AgentMode): string | undefined {
  if (process.env.MUONROI_MODEL) return undefined;

  const user = loadUserSettings();
  const modeModel = user.modeModels?.[mode];
  return modeModel ? normalizeModelId(modeModel) : undefined;
}

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeLspBuiltInServerSettings(raw: unknown): LspBuiltInServerSettings | undefined {
  if (!isNonNullObject(raw)) return undefined;
  const result: LspBuiltInServerSettings = {};

  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  if (typeof raw.command === "string" && raw.command.trim()) result.command = raw.command.trim();
  if (Array.isArray(raw.args)) {
    const args = raw.args.filter((value): value is string => typeof value === "string");
    if (args.length > 0) result.args = args;
  }
  if (isNonNullObject(raw.env)) {
    const envEntries = Object.entries(raw.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    const env = Object.fromEntries(envEntries);
    if (Object.keys(env).length > 0) result.env = env;
  }
  if (isNonNullObject(raw.initialization)) {
    result.initialization = raw.initialization;
  }
  if (Array.isArray(raw.rootMarkers)) {
    const rootMarkers = raw.rootMarkers.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    if (rootMarkers.length > 0) result.rootMarkers = rootMarkers;
  }
  if (Array.isArray(raw.extensions)) {
    const extensions = raw.extensions.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    if (extensions.length > 0) result.extensions = extensions;
  }

  return result;
}

function normalizeLspCustomServerConfig(raw: unknown): LspCustomServerConfig | null {
  if (!isNonNullObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : [];
  if (!id || !command || extensions.length === 0) return null;

  const result: LspCustomServerConfig = {
    id,
    command,
    extensions,
  };

  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  if (Array.isArray(raw.args)) {
    result.args = raw.args.filter((value): value is string => typeof value === "string");
  }
  if (isNonNullObject(raw.env)) {
    result.env = Object.fromEntries(
      Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  if (isNonNullObject(raw.initialization)) {
    result.initialization = raw.initialization;
  }
  if (Array.isArray(raw.rootMarkers)) {
    result.rootMarkers = raw.rootMarkers.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
  }
  if (isNonNullObject(raw.languageIds)) {
    result.languageIds = Object.fromEntries(
      Object.entries(raw.languageIds)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].trim() !== "")
        .map(([key, value]) => [key.trim(), value]),
    );
  }

  return result;
}

export function normalizeLspSettings(raw: unknown): NormalizedLspSettings {
  if (!isNonNullObject(raw)) return { ...DEFAULT_LSP_SETTINGS };

  const builtins: Partial<Record<LspBuiltInServerId, LspBuiltInServerSettings>> = {};
  if (isNonNullObject(raw.builtins)) {
    for (const [key, value] of Object.entries(raw.builtins)) {
      const normalized = normalizeLspBuiltInServerSettings(value);
      if (!normalized) continue;
      builtins[key as LspBuiltInServerId] = normalized;
    }
  }

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_LSP_SETTINGS.enabled,
    tool: typeof raw.tool === "boolean" ? raw.tool : DEFAULT_LSP_SETTINGS.tool,
    autoInstall: typeof raw.autoInstall === "boolean" ? raw.autoInstall : DEFAULT_LSP_SETTINGS.autoInstall,
    startupTimeoutMs:
      typeof raw.startupTimeoutMs === "number" && raw.startupTimeoutMs > 0
        ? raw.startupTimeoutMs
        : DEFAULT_LSP_SETTINGS.startupTimeoutMs,
    requestTimeoutMs:
      typeof raw.requestTimeoutMs === "number" && raw.requestTimeoutMs > 0
        ? raw.requestTimeoutMs
        : DEFAULT_LSP_SETTINGS.requestTimeoutMs,
    diagnosticsDebounceMs:
      typeof raw.diagnosticsDebounceMs === "number" && raw.diagnosticsDebounceMs >= 0
        ? raw.diagnosticsDebounceMs
        : DEFAULT_LSP_SETTINGS.diagnosticsDebounceMs,
    builtins,
    servers: Array.isArray(raw.servers)
      ? raw.servers
          .map(normalizeLspCustomServerConfig)
          .filter((value): value is LspCustomServerConfig => value !== null)
      : [],
  };
}

export function mergeLspSettings(
  base: LspSettings | undefined,
  override: LspSettings | undefined,
): NormalizedLspSettings {
  const baseNormalized = normalizeLspSettings(base);
  const overrideNormalized = normalizeLspSettings(override);

  return {
    enabled: override?.enabled ?? base?.enabled ?? DEFAULT_LSP_SETTINGS.enabled,
    tool: override?.tool ?? base?.tool ?? DEFAULT_LSP_SETTINGS.tool,
    autoInstall: override?.autoInstall ?? base?.autoInstall ?? DEFAULT_LSP_SETTINGS.autoInstall,
    startupTimeoutMs: override?.startupTimeoutMs ?? base?.startupTimeoutMs ?? DEFAULT_LSP_SETTINGS.startupTimeoutMs,
    requestTimeoutMs: override?.requestTimeoutMs ?? base?.requestTimeoutMs ?? DEFAULT_LSP_SETTINGS.requestTimeoutMs,
    diagnosticsDebounceMs:
      override?.diagnosticsDebounceMs ?? base?.diagnosticsDebounceMs ?? DEFAULT_LSP_SETTINGS.diagnosticsDebounceMs,
    builtins: {
      ...baseNormalized.builtins,
      ...overrideNormalized.builtins,
    },
    servers:
      override?.servers !== undefined
        ? overrideNormalized.servers
        : base?.servers !== undefined
          ? baseNormalized.servers
          : DEFAULT_LSP_SETTINGS.servers,
  };
}

export function getCurrentShellSettings(): ShellSettings {
  const user = loadUserSettings();
  const project = loadProjectSettings();
  return { ...(user.shell ?? {}), ...(project.shell ?? {}) };
}

export function getCurrentLspSettings(): NormalizedLspSettings {
  const user = loadUserSettings();
  const project = loadProjectSettings();
  return mergeLspSettings(user.lsp, project.lsp);
}

export function getReasoningEffortForModel(modelId: string): ReasoningEffort | undefined {
  const normalizedModelId = normalizeModelId(modelId);
  const savedEfforts = loadUserSettings().reasoningEffortByModel ?? {};
  const effort =
    savedEfforts[normalizedModelId] ??
    Object.entries(savedEfforts).find(([savedModelId]) => normalizeModelId(savedModelId) === normalizedModelId)?.[1];
  return getEffectiveReasoningEffort(normalizedModelId, effort);
}

export function getTelegramBotToken(): string | undefined {
  const env = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (env) return env;
  return loadUserSettings().telegram?.botToken?.trim();
}

export function saveApprovedTelegramUserId(userId: number): void {
  const settings = loadUserSettings();
  const approvedUserIds = new Set(settings.telegram?.approvedUserIds ?? []);
  approvedUserIds.add(userId);
  saveUserSettings({
    telegram: {
      ...settings.telegram,
      approvedUserIds: [...approvedUserIds],
    },
  });
}

export function resolveTelegramStreamSettings(t: TelegramSettings | undefined): {
  streaming: TelegramStreamingMode;
  typingIndicator: boolean;
  nativeDrafts: boolean;
} {
  return {
    streaming: t?.streaming === "off" ? "off" : "partial",
    typingIndicator: t?.typingIndicator !== false,
    nativeDrafts: t?.nativeDrafts === true,
  };
}

export function resolveTelegramAudioInputSettings(t: TelegramSettings | undefined): {
  enabled: boolean;
  language: string;
} {
  return {
    enabled: t?.audioInput?.enabled !== false,
    language: t?.audioInput?.language?.trim() || "en",
  };
}

export function loadMcpServers(): McpServerConfig[] {
  return loadUserSettings().mcp?.servers ?? [];
}

export function saveMcpServers(servers: McpServerConfig[]): void {
  saveUserSettings({ mcp: { servers } });
}

/** @deprecated Phase 4 will replace with LemonSqueezy billing. Wallet UI only. */
export function loadPaymentSettings(): Required<PaymentSettings> {
  const payments = loadUserSettings().payments;
  return {
    enabled: payments?.enabled ?? DEFAULT_PAYMENT_SETTINGS.enabled,
    chain:
      payments?.chain === "base" || payments?.chain === "base-sepolia"
        ? payments.chain
        : DEFAULT_PAYMENT_SETTINGS.chain,
    approval: {
      autoApprove: payments?.approval?.autoApprove ?? DEFAULT_PAYMENT_SETTINGS.approval.autoApprove,
    },
  };
}

/** @deprecated Phase 4 will replace with LemonSqueezy billing. Wallet UI only. */
export function savePaymentSettings(partial: PaymentSettings): void {
  saveUserSettings({ payments: partial });
}

export function isAutoCompactAfterTurnEnabled(): boolean {
  return loadUserSettings().autoCompactAfterTurn ?? true;
}

export function getAutoCompactThresholdPct(): number {
  const val = loadUserSettings().autoCompactThresholdPct;
  if (typeof val === "number" && val >= 0.05 && val <= 0.5) return val;
  return 0.4; // default 40% — Reduced from 25% after session bf58d0f46b51 analysis: 13 compacts in 43min generated 1.3M uncached tokens. Higher threshold = fewer compacts = less compaction overhead. For DeepSeek 128K context: fires at 51K instead of 32K.
}

/**
 * Per-invocation cap on cumulative tool-output chars inside a `task`
 * sub-agent. See orchestrator/sub-agent-cap.ts for the tiered compression
 * schedule. Env override: MUONROI_SUB_AGENT_BUDGET_CHARS.
 */
export function getSubAgentBudgetChars(): number {
  const envRaw = process.env.MUONROI_SUB_AGENT_BUDGET_CHARS;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 20_000 && n <= 5_000_000) return Math.floor(n);
  }
  const val = loadUserSettings().subAgentBudgetChars;
  if (typeof val === "number" && val >= 20_000 && val <= 5_000_000) return Math.floor(val);
  return 240_000;
}

/**
 * Stall watchdog timeout (ms) for streaming model calls: if the provider sends
 * no stream chunk for this long, the stream is aborted and the error is
 * surfaced as a toast instead of leaving the agent silently frozen. Re-armed on
 * every chunk, so it only fires on genuine stalls (first-chunk or mid-stream),
 * never on an actively-producing stream. Range 10_000–600_000; 0 disables.
 * Default 120_000 (2 min). Env override: MUONROI_PROVIDER_STALL_TIMEOUT_MS.
 */
export function getProviderStallTimeoutMs(): number {
  const envRaw = process.env.MUONROI_PROVIDER_STALL_TIMEOUT_MS;
  if (envRaw !== undefined && envRaw !== "") {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n === 0) return 0; // explicit disable
    if (Number.isFinite(n) && n >= 10_000 && n <= 600_000) return Math.floor(n);
  }
  return 120_000;
}

/**
 * Number of times to AUTOMATICALLY re-issue a streaming model call after the
 * stall watchdog fires WITHOUT any chunk having arrived (a time-to-first-byte
 * "frozen" stall). Some providers (observed: xai/grok-build-0.1) accept a
 * request then never send the first byte, yet a fresh request goes through —
 * a single dead socket, not a down backend. Re-prompting is gated on
 * zero-chunks-this-attempt so it can NEVER restart a turn that already ran
 * tools or emitted text (that would corrupt/duplicate output — the partial-
 * answer rescue path handles those). Each re-prompt waits a short backoff.
 * Range 0–5; 0 restores the legacy "surface the stall, never retry" behaviour.
 * Default 1. Env override: MUONROI_PROVIDER_STALL_RETRIES.
 */
export function getProviderStallRetries(): number {
  const envRaw = process.env.MUONROI_PROVIDER_STALL_RETRIES;
  if (envRaw !== undefined && envRaw !== "") {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 5) return Math.floor(n);
  }
  return 1;
}

/**
 * Live-queue steering: when true, a message typed while a turn is streaming is
 * injected into the running turn at the next prepareStep boundary (as a `user`
 * interjection) instead of waiting for the turn to finish and running as a new
 * turn. When false, the legacy deferred-queue behaviour is preserved (the
 * message runs only after the current turn completes). House convention for a
 * default-true boolean knob: only an explicit "0" disables; unset/blank/any
 * other value = enabled. Env override: MUONROI_STEER_INJECTION.
 */
export function getSteerInjectionEnabled(): boolean {
  return process.env.MUONROI_STEER_INJECTION !== "0";
}

/**
 * Phase B3 — threshold (in chars of cumulative message content) above which
 * the sub-agent `prepareStep` compactor rewrites older tool_result parts
 * into short summary stubs. Below the threshold compaction is a no-op.
 * Env override: MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS.
 */
export function getSubAgentCompactThresholdChars(): number {
  const envRaw = process.env.MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 20_000 && n <= 500_000) return Math.floor(n);
  }
  // Phase C5 — lowered from 80_000 to 40_000 chars. Evidence from session
  // bcf1f0951567: 88 prepareStep iterations grew billed input to 68K *tokens*
  // (~273K char-equivalent), but the chars-based threshold never fired
  // because each tool result is already capped to 32K chars. Lowering the
  // trigger to 40K chars makes compaction fire ~step 30 instead of never —
  // projected peak ~35K tokens, ~$0.085 saved per equivalent session.
  return 40_000;
}

/**
 * Phase B3 — number of trailing tool turns kept verbatim during sub-agent
 * compaction. Each tool turn = one assistant tool-call + one tool message.
 * Env override: MUONROI_SUBAGENT_COMPACT_KEEP_LAST.
 */
export function getSubAgentCompactKeepLast(): number {
  const envRaw = process.env.MUONROI_SUBAGENT_COMPACT_KEEP_LAST;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 1 && n <= 20) return Math.floor(n);
  }
  return 3;
}

/**
 * Phase B4 — threshold (in chars of cumulative message content) above which
 * the top-level `prepareStep` compactor rewrites older tool_result parts
 * into short summary stubs. Higher than the sub-agent default because
 * top-level loops typically carry more useful early context.
 * Env override: MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS.
 */
export function getTopLevelCompactThresholdChars(contextWindowTokens?: number): number {
  const envRaw = process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 10_000 && n <= 1_500_000) return Math.floor(n);
  }
  // For small-context models (e.g. DeepSeek 64K), scale threshold proportionally
  // to prevent linear token growth during tool loops. A model with 64K context
  // gets threshold = 64000 * 4 * 0.35 = 89,600 chars (~22K tokens = 35% of window).
  // Large-context models (128K+) keep the original 200K default.
  if (contextWindowTokens && contextWindowTokens > 0) {
    const dynamicThreshold = Math.floor(contextWindowTokens * 4 * 0.35);
    return Math.min(200_000, dynamicThreshold);
  }
  return 200_000;
}

/**
 * Phase B4 — number of trailing tool turns kept verbatim during top-level
 * compaction. Higher than sub-agent default because top-level agents make
 * decisions across longer horizons.
 * Env override: MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST.
 */
export function getTopLevelCompactKeepLast(contextWindowTokens?: number): number {
  const envRaw = process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 1 && n <= 30) return Math.floor(n);
  }
  // Small-context models (< 100K tokens) benefit from keeping fewer trailing
  // turns — each verbatim turn with tool results + reasoning tokens costs
  // 5-15K tokens. Reduce from 5 to 3 for small windows.
  if (contextWindowTokens && contextWindowTokens < 100_000) {
    return 3;
  }
  return 5;
}

/**
 * Per-turn cap on cumulative tool-output chars inside the top-level
 * orchestrator agentic loop. Same tiered compression as the sub-agent cap,
 * higher default so single-tool turns are unaffected. Env override:
 * MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS.
 */
export function getTopLevelToolBudgetChars(maxRounds?: number, contextWindowTokens?: number): number {
  const envRaw = process.env.MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 50_000 && n <= 10_000_000) return Math.floor(n);
  }
  const val = loadUserSettings().topLevelToolBudgetChars;
  if (typeof val === "number" && val >= 50_000 && val <= 10_000_000) return Math.floor(val);

  // Dynamically scale default based on maxRounds relative to default base (40)
  const baseRounds = 40;
  const scale = maxRounds && maxRounds > baseRounds ? maxRounds / baseRounds : 1;
  const baseDefault = Math.floor(400_000 * scale);
  // For small-context models (e.g. DeepSeek 64K), scale the budget to 60% of
  // the context window in chars so tiered compression kicks in before the
  // cumulative tool output exceeds what the model can hold in context.
  if (contextWindowTokens && contextWindowTokens > 0 && contextWindowTokens < 200_000) {
    const windowBudget = Math.floor(contextWindowTokens * 4 * 0.6);
    return Math.min(baseDefault, Math.max(50_000, windowBudget));
  }
  return baseDefault;
}

export function getRoleModel(role: ModelRole): string | undefined {
  return loadUserSettings().roleModels?.[role];
}

export function getRoleModels(): Partial<Record<ModelRole, string>> {
  return loadUserSettings().roleModels ?? {};
}

export function getCouncilRounds(): number {
  const r = loadUserSettings().councilRounds;
  return typeof r === "number" && r >= 1 ? Math.min(r, 5) : 3;
}

export function isAutoCouncilEnabled(): boolean {
  return loadUserSettings().autoCouncil ?? true;
}

/** Pure validator extracted for testability; clamps user input to a sane range. */
export function normalizeAutoCouncilConfidence(val: unknown): number {
  if (typeof val === "number" && val >= 0.5 && val <= 1.0) return val;
  return 0.85; // default — only trigger on clearly-architectural prompts
}

/** Pure validator extracted for testability; clamps user input to a sane range. */
export function normalizeAutoCouncilMinRoles(val: unknown): number {
  if (typeof val === "number" && Number.isInteger(val) && val >= 1 && val <= 4) return val;
  return 2; // default — a "debate" needs at least two participants
}

export function getAutoCouncilConfidence(): number {
  return normalizeAutoCouncilConfidence(loadUserSettings().autoCouncilConfidence);
}

export function getAutoCouncilMinRoles(): number {
  return normalizeAutoCouncilMinRoles(loadUserSettings().autoCouncilMinRoles);
}

export function isCouncilMultiProviderPreferred(): boolean {
  return loadUserSettings().councilPreferMultiProvider ?? false;
}

export function getCouncilExperienceMode(): CouncilExperienceMode {
  return loadUserSettings().councilExperienceMode ?? "advisory";
}

export function isCouncilCostAware(): boolean {
  return loadUserSettings().councilCostAware ?? true;
}

/**
 * Router tier-promotion ceiling. See UserSettings.routingPromoteMax.
 * Default "balanced" — router may promote up to balanced but never silently
 * to premium. Validated to the three allowed values; any unknown value
 * falls back to the default.
 */
export function getRoutingPromoteMax(): "off" | "balanced" | "any" {
  const raw = loadUserSettings().routingPromoteMax;
  return raw === "off" || raw === "balanced" || raw === "any" ? raw : "balanced";
}

export function getDisabledProviders(): ProviderId[] {
  const raw = loadUserSettings().disabledProviders;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is ProviderId => typeof p === "string" && (ALL_PROVIDER_IDS as readonly string[]).includes(p),
  );
}

export function isProviderDisabled(provider: ProviderId): boolean {
  return getDisabledProviders().includes(provider);
}

export function setProviderDisabled(provider: ProviderId, disabled: boolean): ProviderId[] {
  const current = new Set(getDisabledProviders());
  if (disabled) current.add(provider);
  else current.delete(provider);
  const next = [...current];
  saveUserSettings({ disabledProviders: next });
  return next;
}

export function getDisabledModels(): string[] {
  const raw = loadUserSettings().disabledModels;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === "string");
}

export function isModelDisabled(modelId: string): boolean {
  const info = getModelInfo(modelId);
  if (info?.provider && isProviderDisabled(info.provider as ProviderId)) return true;
  return getDisabledModels().includes(modelId);
}

export function setModelDisabled(modelId: string, disabled: boolean): string[] {
  const current = new Set(getDisabledModels());
  if (disabled) current.add(modelId);
  else current.delete(modelId);
  const next = [...current];
  saveUserSettings({ disabledModels: next });
  return next;
}

/**
 * Preferred provider. The splash UI persists this when the user picks a
 * provider as default; the router then auto-selects a model from this
 * provider's catalog. Returns null when nothing is pinned.
 */
export function getDefaultProvider(): ProviderId | null {
  const raw = loadUserSettings().defaultProvider;
  if (typeof raw !== "string") return null;
  if (!(ALL_PROVIDER_IDS as readonly string[]).includes(raw)) return null;
  return raw as ProviderId;
}

export function setDefaultProvider(provider: ProviderId): void {
  saveUserSettings({ defaultProvider: provider });
}

export type SandboxMode = "off" | "shuru";

export interface SandboxSecretConfig {
  name: string;
  fromEnv: string;
  hosts: string[];
}

export interface SandboxSettings {
  allowNet?: boolean;
  allowedHosts?: string[];
  ports?: string[];
  cpus?: number;
  memory?: number;
  diskSize?: number;
  secrets?: SandboxSecretConfig[];
  from?: string;
  allowEphemeralInstall?: boolean;
  guestWorkdir?: string;
  syncHostWorkspace?: boolean;
  verifyBaseFrom?: string;
  shellInit?: string[];
  hostBrowserCommandsOnHost?: boolean;
}

export function getCurrentSandboxMode(): SandboxMode {
  return "off";
}

export function getCurrentSandboxSettings(): SandboxSettings {
  return {};
}

function normalizeSecretConfig(raw: unknown): SandboxSecretConfig | null {
  if (!isNonNullObject(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const fromEnv = typeof raw.fromEnv === "string" ? raw.fromEnv.trim() : "";
  const hosts = Array.isArray(raw.hosts)
    ? raw.hosts.filter((h): h is string => typeof h === "string" && h.trim() !== "")
    : [];
  if (!name || !fromEnv) return null;
  return { name, fromEnv, hosts };
}

export function normalizeSandboxSettings(raw: unknown): SandboxSettings {
  if (!isNonNullObject(raw)) return {};
  const result: SandboxSettings = {};

  if (typeof raw.allowNet === "boolean") result.allowNet = raw.allowNet;
  if (Array.isArray(raw.allowedHosts)) {
    const hosts = raw.allowedHosts.filter((h): h is string => typeof h === "string" && h.trim() !== "");
    if (hosts.length > 0) result.allowedHosts = hosts;
  }
  if (Array.isArray(raw.ports)) {
    const ports = raw.ports.filter((p): p is string => typeof p === "string" && /^\d+:\d+$/.test(p.trim()));
    if (ports.length > 0) result.ports = ports;
  }
  if (typeof raw.cpus === "number" && raw.cpus > 0) result.cpus = raw.cpus;
  if (typeof raw.memory === "number" && raw.memory > 0) result.memory = raw.memory;
  if (typeof raw.diskSize === "number" && raw.diskSize > 0) result.diskSize = raw.diskSize;
  if (Array.isArray(raw.secrets)) {
    const secrets = raw.secrets.map(normalizeSecretConfig).filter((s): s is SandboxSecretConfig => s !== null);
    if (secrets.length > 0) result.secrets = secrets;
  }
  if (typeof raw.from === "string" && raw.from.trim()) result.from = raw.from.trim();
  if (typeof raw.verifyBaseFrom === "string" && raw.verifyBaseFrom.trim())
    result.verifyBaseFrom = raw.verifyBaseFrom.trim();
  if (typeof raw.allowEphemeralInstall === "boolean") result.allowEphemeralInstall = raw.allowEphemeralInstall;
  if (typeof raw.syncHostWorkspace === "boolean") result.syncHostWorkspace = raw.syncHostWorkspace;
  if (typeof raw.guestWorkdir === "string" && raw.guestWorkdir.trim()) result.guestWorkdir = raw.guestWorkdir.trim();
  if (Array.isArray(raw.shellInit)) {
    const shellInit = raw.shellInit.filter((line): line is string => typeof line === "string" && line.trim() !== "");
    if (shellInit.length > 0) result.shellInit = shellInit;
  }
  if (typeof raw.hostBrowserCommandsOnHost === "boolean")
    result.hostBrowserCommandsOnHost = raw.hostBrowserCommandsOnHost;

  return result;
}

export function mergeSandboxSettings(
  base: SandboxSettings | undefined,
  override: SandboxSettings | undefined,
): SandboxSettings {
  if (!base && !override) return {};
  if (!base) return { ...override };
  if (!override) return { ...base };
  return {
    allowNet: override.allowNet ?? base.allowNet,
    allowedHosts: override.allowedHosts ?? base.allowedHosts,
    ports: override.ports ?? base.ports,
    cpus: override.cpus ?? base.cpus,
    memory: override.memory ?? base.memory,
    diskSize: override.diskSize ?? base.diskSize,
    secrets: override.secrets ?? base.secrets,
    from: override.from ?? base.from,
    allowEphemeralInstall: override.allowEphemeralInstall ?? base.allowEphemeralInstall,
    guestWorkdir: override.guestWorkdir ?? base.guestWorkdir,
    syncHostWorkspace: override.syncHostWorkspace ?? base.syncHostWorkspace,
    verifyBaseFrom: override.verifyBaseFrom ?? base.verifyBaseFrom,
    shellInit: override.shellInit ?? base.shellInit,
    hostBrowserCommandsOnHost: override.hostBrowserCommandsOnHost ?? base.hostBrowserCommandsOnHost,
  };
}

export function normalizeSandboxMode(value: unknown): SandboxMode {
  return value === "shuru" ? "shuru" : "off";
}
