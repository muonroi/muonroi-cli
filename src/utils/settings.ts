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
  getModelIds,
  getModelInfo,
  MODELS,
  normalizeModelId,
} from "../models/registry.js";
import { apiBaseFor, PROVIDER_ENDPOINTS } from "../providers/endpoints.js";
import type { ProviderId } from "../providers/types.js";
import type { AgentMode, ReasoningEffort } from "../types/index";
import { normalizeShellSettings, type ShellSettings } from "./shell";

export type ModelRole = "leader" | "implement" | "verify" | "research";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export type TelegramStreamingMode = "off" | "partial";
export type SandboxMode = "off" | "shuru";
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
  autoInstall: false,
  startupTimeoutMs: 30_000,
  diagnosticsDebounceMs: 200,
  builtins: {},
  servers: [],
};

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
  sandboxMode?: SandboxMode;
  sandbox?: SandboxSettings;
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
}

export interface ProjectSettings {
  model?: string;
  sandboxMode?: SandboxMode;
  sandbox?: SandboxSettings;
  shell?: ShellSettings;
  lsp?: LspSettings;
}

const USER_DIR = path.join(os.homedir(), ".muonroi-cli");
const USER_SETTINGS_PATH = path.join(USER_DIR, "user-settings.json");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function loadUserSettings(): UserSettings {
  return readJson<UserSettings>(USER_SETTINGS_PATH) || {};
}

export function saveUserSettings(partial: Partial<UserSettings>): void {
  const current = loadUserSettings();
  const next: UserSettings = {
    ...current,
    ...partial,
    ...(partial.apiKey !== undefined ? { apiKey: partial.apiKey } : {}),
    ...(partial.defaultModel !== undefined ? { defaultModel: normalizeModelId(partial.defaultModel) } : {}),
    ...(partial.sandboxMode !== undefined ? { sandboxMode: normalizeSandboxMode(partial.sandboxMode) } : {}),
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
    ...(partial.sandbox !== undefined
      ? { sandbox: normalizeSandboxSettings({ ...current.sandbox, ...partial.sandbox }) }
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

  writeJson(USER_SETTINGS_PATH, next);
}

export function loadProjectSettings(): ProjectSettings {
  const projectPath = path.join(process.cwd(), ".muonroi-cli", "settings.json");
  return readJson<ProjectSettings>(projectPath) || {};
}

export function saveProjectSettings(partial: Partial<ProjectSettings>): void {
  const projectPath = path.join(process.cwd(), ".muonroi-cli", "settings.json");
  const current = loadProjectSettings();
  writeJson(projectPath, {
    ...current,
    ...partial,
    ...(partial.model !== undefined ? { model: normalizeModelId(partial.model) } : {}),
    ...(partial.sandboxMode !== undefined ? { sandboxMode: normalizeSandboxMode(partial.sandboxMode) } : {}),
    ...(partial.sandbox !== undefined
      ? { sandbox: normalizeSandboxSettings({ ...current.sandbox, ...partial.sandbox }) }
      : {}),
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
  const id = (provider ?? "anthropic") as ProviderId;
  return PROVIDER_ENDPOINTS[id]?.apiBase ?? PROVIDER_ENDPOINTS.anthropic.apiBase;
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
  return pickValid(user.defaultModel) ?? DEFAULT_MODEL;
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

export function normalizeSandboxMode(value: unknown): SandboxMode {
  return value === "shuru" ? "shuru" : "off";
}

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

export function getCurrentSandboxMode(): SandboxMode {
  const project = loadProjectSettings();
  if (project.sandboxMode) return normalizeSandboxMode(project.sandboxMode);
  const user = loadUserSettings();
  if (user.sandboxMode) return normalizeSandboxMode(user.sandboxMode);
  return "off";
}

export function getCurrentSandboxSettings(): SandboxSettings {
  const user = loadUserSettings();
  const project = loadProjectSettings();
  return mergeSandboxSettings(user.sandbox, project.sandbox);
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
  return 0.25; // default 25% — compact later to reduce summarize-call frequency
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
    if (Number.isFinite(n) && n >= 20_000 && n <= 600_000) return Math.floor(n);
  }
  const val = loadUserSettings().subAgentBudgetChars;
  if (typeof val === "number" && val >= 20_000 && val <= 600_000) return Math.floor(val);
  return 120_000;
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
export function getTopLevelCompactThresholdChars(): number {
  const envRaw = process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 50_000 && n <= 1_500_000) return Math.floor(n);
  }
  // Phase C5 — lowered from 200_000 to 100_000 chars (symmetric with the
  // sub-agent 80→40K reduction). Same evidence applies: tool results are
  // capped, so the chars threshold rarely trips while token billing climbs.
  return 100_000;
}

/**
 * Phase B4 — number of trailing tool turns kept verbatim during top-level
 * compaction. Higher than sub-agent default because top-level agents make
 * decisions across longer horizons.
 * Env override: MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST.
 */
export function getTopLevelCompactKeepLast(): number {
  const envRaw = process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 1 && n <= 30) return Math.floor(n);
  }
  return 5;
}

/**
 * Per-turn cap on cumulative tool-output chars inside the top-level
 * orchestrator agentic loop. Same tiered compression as the sub-agent cap,
 * higher default so single-tool turns are unaffected. Env override:
 * MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS.
 */
export function getTopLevelToolBudgetChars(): number {
  const envRaw = process.env.MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS;
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 50_000 && n <= 1_500_000) return Math.floor(n);
  }
  const val = loadUserSettings().topLevelToolBudgetChars;
  if (typeof val === "number" && val >= 50_000 && val <= 1_500_000) return Math.floor(val);
  return 400_000;
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

export function getDisabledProviders(): ProviderId[] {
  const raw = loadUserSettings().disabledProviders;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is ProviderId =>
      typeof p === "string" &&
      ["anthropic", "openai", "google", "deepseek", "siliconflow", "xai", "ollama"].includes(p),
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
