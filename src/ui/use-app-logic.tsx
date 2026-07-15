// @ts-nocheck
import * as path from "node:path";
import type { AgentModeRuntime } from "@muonroi/agent-harness-opentui";
import { Semantic, SemanticProvider, useAgentInputBridge } from "@muonroi/agent-harness-opentui";
import type { KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { decodePasteBytes, type PasteEvent, parseKeypress } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import os from "os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearLastSurfacedMatches, getDefaultEEClient, getLastSurfacedMatches } from "../ee/intercept.js";
import { deliberateCompact } from "../flow/compaction/index.js";
import { writeScaffoldCheckpoint } from "../flow/scaffold-checkpoint.js";
import { appendCrashLog, setActiveEeYield } from "../index.js";
import { POPULAR_MCP_CATALOG } from "../mcp/catalog";
import { parseEnvLines, parseHeaderLines } from "../mcp/parse-headers";
import { toMcpServerId, validateMcpServerConfig } from "../mcp/validate";
import type { AskUserAskInfo } from "../orchestrator/ask-user.js";
import { ASK_USER_DISMISSED, buildAskUserQuestion } from "../orchestrator/ask-user.js";
import { createCompactionSummaryMessage } from "../orchestrator/compaction.js";
import { Agent } from "../orchestrator/orchestrator";
import {
  buildCompactResumeMessage,
  detectProactiveCompactRequest,
} from "../orchestrator/proactive-compact-detector.js";
import type { SafetyOverrideAskInfo, SafetyOverrideVerdict } from "../orchestrator/safety-askcard.js";
import { planSafetyAskcard } from "../orchestrator/safety-askcard.js";

import type { HaltChunk, ProductStatusCardData, RecoveryOption } from "../product-loop/types.js";
import { getConfiguredProviders, setKeyForProvider } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";
import { buildAdoptExistingContinuationPrompt, buildIdealContinuationPrompt } from "../scaffold/continuation-prompt.js";
import { continueAsCouncil } from "../scaffold/continue-as-council.js";
import { initNewProject } from "../scaffold/init-new.js";
import { detectExistingProjectRecipe, pointToExisting } from "../scaffold/point-to-existing.js";
import { statusBarStore, wireStatusBar } from "../state/status-bar-store.js";
import {
  appendCompaction,
  getNextMessageSequence,
  logUIInteraction,
  revertLatestCompaction,
} from "../storage/index.js";
import type { StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
  CouncilInfoCard,
  CouncilMessage,
  CouncilMetaPatch,
  CouncilPhaseEvent,
  CouncilQuestionData,
  CouncilQuestionOption,
  CouncilRoundRecord,
  CouncilStatusData,
  Plan,
  PlanQuestion,
  ReasoningEffort,
  StructuredResponse,
  SubagentStatus,
  TaskListSnapshot,
  ToolCall,
  ToolResult,
} from "../types/index";
import { MODES } from "../types/index";
import { processAtMentions } from "../utils/at-mentions.js";
import { readClipboardImage } from "../utils/clipboard-image";
import { FileIndex } from "../utils/file-index.js";
import { copyTextToHostClipboard, readTextFromHostClipboard } from "../utils/host-clipboard";
import { logger } from "../utils/logger.js";
import {
  type CustomSubagentConfig,
  getApiKey,
  getCatalogDefaultModel,
  getCurrentModel,
  getSteerInjectionEnabled,
  getTelegramBotToken,
  isModelDisabled,
  isReservedSubagentName,
  loadMcpServers,
  loadPaymentSettings,
  loadUserSettings,
  loadValidSubAgents,
  type McpRemoteTransport,
  type McpServerConfig,
  type PaymentSettings,
  type SandboxMode,
  type SandboxSettings,
  saveApprovedTelegramUserId,
  saveMcpServers,
  savePaymentSettings,
  saveProjectSettings,
  saveUserSettings,
  setDefaultProvider,
  setModelDisabled,
  setProviderDisabled,
} from "../utils/settings";
import { discoverSkills, formatSkillsForChat } from "../utils/skills";
import { formatSubagentName } from "../utils/subagent-display";
import { checkForUpdate, runUpdate, type UpdateCheckResult } from "../utils/update-checker";
import { setRetryReporter } from "../utils/visible-retry.js";
import { buildVerifyPrompt } from "../verify/entrypoint";
import {
  buildSubagentBrowseRows,
  SUBAGENT_EDITOR_FIELDS,
  SubagentEditorModal,
  SubagentsBrowserModal,
} from "./agents-modal";
import { ProductStatusCard } from "./cards/product-status-card.js";
import { BtwOverlay, type BtwState } from "./components/btw-overlay.js";
import { makePairKey, usePairSideMap } from "./components/bubble-layout.js";
import { CopyFlashBanner } from "./components/copy-flash-banner.js";
import { CouncilInfoCardView } from "./components/council-info-card.js";
import { CouncilLeaderBubble } from "./components/council-leader-bubble.js";
import { CouncilMessageBubble } from "./components/council-message-bubble.js";
import { CouncilPhaseTimeline, upsertPhase } from "./components/council-phase-timeline.js";
import { CouncilPlaceholderBubble } from "./components/council-placeholder-bubble.js";
import {
  type CouncilCardState,
  CouncilQuestionCard,
  initialCardState,
  reduceCardKey,
} from "./components/council-question-card.js";
import { cycleRoundSelection } from "./components/council-rail-rounds.js";
import { CouncilStatusList, reapStatuses, upsertStatus } from "./components/council-status-list.js";
import { CouncilSynthesisBanner } from "./components/council-synthesis-banner.js";
import { HaltRecoveryCard } from "./components/halt-recovery-card.js";
import { HeroLogo } from "./components/hero-logo.js";
import {
  BB_TEMPLATE_OPTIONS,
  FE_STACK_OPTIONS,
  InitNewFormCard,
  type InitNewFormState,
  initialInitNewFormState,
} from "./components/init-new-form-card.js";
import { computeMcpRunInfo, MessageView } from "./components/message-view.js";
import {
  initialPointToExistingFormState,
  PointToExistingFormCard,
  type PointToExistingFormState,
} from "./components/point-to-existing-form-card.js";
import { PromptBox } from "./components/prompt-box.js";
import { useRolePalette } from "./components/role-palette.js";
import { SessionHeader } from "./components/session-header.js";
import { Toast, type ToastLevel } from "./components/Toast.js";
import { TaskListPanel } from "./components/task-list-panel.js";
import {
  DelegationTaskLine,
  InlineTool,
  ShimmerText,
  SubagentActivity,
  SubagentTaskLine,
} from "./components/tool-result-views.js";
import { usePairQuoteBuffer } from "./components/use-pair-quote-buffer.js";
import { mapCouncilStatusToSpeakerEvent } from "./council-harness-event.js";
import { useAgentEditor } from "./hooks/use-agent-editor.js";
import { useMcpEditor } from "./hooks/use-mcp-editor.js";
import { useModelPicker } from "./hooks/use-model-picker.js";
import { useSessionPicker } from "./hooks/use-session-picker.js";
import { useTypeahead } from "./hooks/useTypeahead.js";
import { Markdown } from "./markdown";
import { buildMcpBrowseRows, McpBrowserModal, McpEditorModal } from "./mcp-modal";
import { createEmptyMcpEditorDraft, type McpEditorDraft } from "./mcp-modal-types";
import { ApiKeyModal } from "./modals/api-key-modal.js";
import { ConnectModal, TelegramPairModal, TelegramTokenModal } from "./modals/connect-modal.js";
import { ModelPickerModal } from "./modals/model-picker-modal.js";
import { SandboxPickerModal } from "./modals/sandbox-picker-modal.js";
import { SessionPickerModal } from "./modals/session-picker-modal.js";
import { UpdateModal } from "./modals/update-modal.js";
import { PaymentApprovalPanel, WalletPickerModal } from "./modals/wallet-picker-modal.js";
import { resolvePickerProviders } from "./picker-providers.js";
import { formatPlanAnswers, initialPlanQuestionsState, PlanQuestionsPanel, type PlanQuestionsState } from "./plan";
import { buildScheduleBrowseRows, ScheduleBrowserModal } from "./schedule-modal";
import {
  SLASH_MENU_ITEMS,
  SLASH_MENU_ITEMS_ARROW_ORDER,
  type SlashMenuItem,
  VISIBLE_SLASH_MENU_ITEMS,
} from "./slash/menu-items.js";
import { dispatchSlash } from "./slash/registry.js";
import { StatusBar } from "./status-bar/index.js";
import { getCompactTuiSelectionText } from "./terminal-selection-text";
import { dark } from "./theme";
import { relaunchWithSession } from "./utils/relaunch.js";
import "./slash/route.js";
import "./slash/optimize.js";
import "./slash/discuss.js";
import "./slash/plan.js";
import "./slash/execute.js";
import "./slash/compact.js";
import "./slash/expand.js";
import "./slash/clear.js";
import "./slash/pin.js";
import "./slash/cost.js";
import "./slash/ee.js";
import "./slash/debug.js";
import "./slash/council.js";
import "./slash/ideal.js";
import "./slash/export.js";
import "./slash/status.js";
import "./slash/ponytail.js";
import {
  CONNECT_CHANNELS,
  getSandboxVisibleRows,
  MCP_REMOTE_FIELDS,
  MCP_STDIO_FIELDS,
  WALLET_ROWS,
} from "./constants.js";
import type {
  ActiveTurnState,
  AppProps,
  FileMentionBlock,
  PasteBlock,
  QueuedMessage,
  WalletDisplayInfo,
} from "./types.js";

export type { AppStartupConfig } from "./types.js";

import { isScrollLockEnabled } from "../gsd/flags.js";
import {
  getEffectiveReasoningEffort,
  getModelByTier,
  getModelIds,
  getModelInfo,
  getModelsForProvider,
  getSupportedReasoningEfforts,
  isLoading,
  MODELS,
  normalizeModelId,
} from "../models/registry.js";
import {
  buildAssistantEntry,
  buildPreflightQuestion,
  buildToolGroupEntry,
  buildToolResultEntry,
  buildUserEntry,
  formatAnswerForLog,
  formatScheduleDetails,
  isCouncilStartPatch,
  mapCouncilCardKey,
} from "./utils/format.js";
import { isEscapeKey } from "./utils/modal.js";
import { sanitizeContent } from "./utils/text.js";
import { dominantVerb, toolArgs, toolLabel, tryParseArg } from "./utils/tools.js";

/**
 * A — recovery options shown when an /ideal run breaks mid-sprint. Resume /
 * Retry / Abort all auto-detect the newest incomplete run (see runResume /
 * runAbort auto-detect), so the user never has to know the runId; Skip verify
 * sets MUONROI_SPRINT_SKIP_VERIFY=1 before resuming so a broken verify sandbox
 * (e.g. shuru unavailable on Windows) does not re-hang every sprint.
 */
const SPRINT_FAILED_RECOVERY_OPTIONS: readonly RecoveryOption[] = [
  { id: "resume", label: "Resume", description: "Continue the run from where it broke (restarts the failed sprint)." },
  { id: "retry", label: "Retry sprint", description: "Re-run the sprint that just failed from a clean slate." },
  {
    id: "skip_verify",
    label: "Skip verify & resume",
    description: "Bypass the verify stage (use when the sandbox/verify is what hangs), then continue.",
  },
  { id: "abort", label: "Abort run", description: "Hard-kill this run. It can no longer be resumed." },
];

/**
 * Render the EE "experience injected" chunk for the TUI: the count line PLUS a
 * capped per-point list (tier + title + short id) so the user sees WHAT was
 * injected, not just how many. Shared by both render sites to avoid drift.
 */
function formatExperienceInjectedBlock(d: {
  pointCount?: number;
  scoreFloor?: number;
  points?: Array<{ id: string; title: string; tier: string }>;
}): string {
  const head = `\n💡 [Experience Injected] ${d.pointCount ?? 0} point(s) loaded (score ≥ ${d.scoreFloor ?? 0})`;
  const pts = d.points ?? [];
  if (pts.length === 0) return `${head}\n`;
  const MAX = 8;
  const lines = pts.slice(0, MAX).map((p) => `   • [${p.tier}] ${p.title || "(untitled)"} {id:${p.id.slice(0, 8)}}`);
  if (pts.length > MAX) lines.push(`   … +${pts.length - MAX} more`);
  return `${head}\n${lines.join("\n")}\n`;
}

/**
 * Strip terminal bracketed-paste guards (ESC[200~ / ESC[201~), all control
 * bytes, and DEL from pasted/typed text. Keeps printable characters including
 * spaces (a master password may legitimately contain them).
 */
function stripControlBytes(raw: string): string {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal bracketed-paste guards (ESC[200~ / ESC[201~)
      .replace(/?\[20[01]~/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control bytes + DEL from typed/pasted secrets
      .replace(/[ -]/g, "")
  );
}

/**
 * Sanitize text destined for a single-line secret field (provider API key).
 * stripControlBytes + removes every whitespace character — an API key never
 * contains whitespace, and terminal paste often arrives wrapped in guards or
 * with a trailing newline. Shared by the keydown and paste handlers so both
 * input routes behave identically.
 */
function sanitizeSecretInput(raw: string): string {
  return stripControlBytes(raw).replace(/\s+/g, "");
}

const DEFAULT_MODEL = getCurrentModel();

// ---------------------------------------------------------------------------
// Telegram stubs — removed feature, compile-only placeholders
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TelegramBridgeHandle = any;
function createTelegramBridge(_opts: unknown): TelegramBridgeHandle {
  return null as TelegramBridgeHandle;
}
function approvePairingCode(_code: string): { ok: true; userId: number } | { ok: false; error: string } {
  return { ok: false, error: "Telegram bridge not available." };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createTurnCoordinator(): any {
  return {
    reset: () => {},
    handleEvent: () => {},
    run: async (fn: () => Promise<void>) => fn(),
  };
}

function _formatStructuredResponse(sr: StructuredResponse): string {
  const d = sr.data;
  switch (sr.taskType) {
    case "refactor": {
      const r = d as { summary?: string; changes?: Array<{ file: string; diff: string }>; verify_command?: string };
      const parts = [r.summary ?? ""];
      for (const c of r.changes ?? []) parts.push(`\n── ${c.file} ──\n${c.diff}`);
      if (r.verify_command) parts.push(`\nverify: ${r.verify_command}`);
      return parts.join("\n");
    }
    case "debug": {
      const r = d as {
        hypothesis?: string;
        root_cause?: string;
        fix?: { file: string; diff: string };
        verify_command?: string;
      };
      const parts = [`hypothesis: ${r.hypothesis}`, `root cause: ${r.root_cause}`];
      if (r.fix) parts.push(`\n── fix: ${r.fix.file} ──\n${r.fix.diff}`);
      if (r.verify_command) parts.push(`verify: ${r.verify_command}`);
      return parts.join("\n");
    }
    case "plan": {
      const r = d as {
        steps?: Array<{ action: string; criterion: string; rationale?: string }>;
        assumptions?: string[];
        risks?: string[];
      };
      const lines = (r.steps ?? []).map(
        (s, i) => `${i + 1}. ${s.action}\n   done when: ${s.criterion}${s.rationale ? `\n   why: ${s.rationale}` : ""}`,
      );
      if (r.assumptions?.length) lines.push(`\nassumptions:\n${r.assumptions.map((a) => `  - ${a}`).join("\n")}`);
      if (r.risks?.length) lines.push(`\nrisks:\n${r.risks.map((r2) => `  - ${r2}`).join("\n")}`);
      return lines.join("\n");
    }
    case "analyze": {
      const r = d as { findings?: Array<{ text: string; evidence: string; severity: string }> };
      return (r.findings ?? [])
        .map((f) => `[${f.severity.toUpperCase()}] ${f.text}\n  evidence: ${f.evidence}`)
        .join("\n");
    }
    case "documentation": {
      const r = d as { content?: string; examples?: Array<{ code: string; description: string }> };
      const parts = [r.content ?? ""];
      for (const ex of r.examples ?? []) parts.push(`\n${ex.description}\n${ex.code}`);
      return parts.join("\n");
    }
    case "generate": {
      const r = d as { files?: Array<{ path: string; content: string; language: string }>; explanation?: string };
      const parts: string[] = [];
      if (r.explanation) parts.push(r.explanation);
      for (const f of r.files ?? []) parts.push(`\n── ${f.path} (${f.language}) ──\n${f.content}`);
      return parts.join("\n");
    }
    case "general": {
      const r = d as { response?: string; reasoning?: string };
      return r.response ?? JSON.stringify(d, null, 2);
    }
    default: {
      // Graceful fallback for unknown taskTypes; probe common text fields.
      const obj = (d ?? {}) as Record<string, unknown>;
      const primary =
        (typeof obj.response === "string" && obj.response) ||
        (typeof obj.summary === "string" && obj.summary) ||
        (typeof obj.content === "string" && obj.content) ||
        (typeof obj.text === "string" && obj.text) ||
        null;
      return primary || JSON.stringify(d, null, 2);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decorateTelegramEntries(_entries: any[], _userId: number, _remoteKey: string): any[] {
  return [];
}
function getTelegramSourceLabel(_role?: string, _userId?: number): string {
  return "";
}
function getUnflushedTelegramAssistantContent(_content: string, _flushedChars: number): string {
  return "";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function replaceTurnEntries(_prev: any[], _remoteKey: string, _delta: any[]): any[] {
  return _prev;
}

// STAR_PALETTE, LOADING_SPINNER_FRAMES, PROMPT_LOADING_FRAMES, Star, Row extracted to ./constants.ts
// ContextStats, PasteBlock, FileMentionBlock, QueuedMessage extracted to ./types.ts

function getPasteBlockToken(block: Pick<PasteBlock, "id" | "lines" | "isImage">): string {
  if (block.isImage) {
    return `[Image #${block.id}]`;
  }
  return `[Pasted text #${block.id} +${block.lines} lines]`;
}

function getFileMentionToken(block: FileMentionBlock): string {
  const name = block.path.split("/").pop() || block.path;
  return `[File: ${name}]`;
}

// HERO_ROWS extracted to ./constants.ts

const SPLIT = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};
const _SPLIT_END = { ...SPLIT, bottomLeft: "╹" };
const _EMPTY = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};
const _LINE = {
  topLeft: "━",
  bottomLeft: "━",
  vertical: "",
  topRight: "━",
  bottomRight: "━",
  horizontal: "━",
  bottomT: "━",
  topT: "━",
  cross: "━",
  leftT: "━",
  rightT: "━",
};

const REVIEW_PROMPT = `Review all current changes in this repository. Follow these steps:

1. Run \`git status\` to see which files have been modified, staged, or are untracked.
2. Run \`git diff\` to see unstaged changes and \`git diff --cached\` to see staged changes.
3. If there are no changes at all, say so and stop.
4. Read any changed files in full if needed for context.

Then produce a **Review Report** in this exact structure:

## Summary
One paragraph overview of what changed and why (inferred from the diff).

## Files Changed
For each changed file, list the filename and a brief description of the change.

## Issues Found
List any bugs, logic errors, security concerns, missing error handling, or correctness problems. If none, say "No issues found."

## Suggestions
Code quality, naming, performance, and best-practice improvements. If none, say "No suggestions."

## Risk Assessment
Rate the overall risk of these changes as **Low**, **Medium**, or **High** with a short justification.`;

const COMMIT_PUSH_PROMPT = `Create a git commit for the current repository changes and push the current branch to its remote.

Before committing, inspect the current branch. If it is not already a feature branch, create and switch to a new feature branch with a descriptive name based on the changes.

Follow the repository's commit workflow and safety checks. Inspect the current changes, stage any relevant untracked files, create an appropriate commit message, and push the branch if a commit was created. If there is nothing to commit, say so and stop.`;

const COMMIT_PR_PROMPT = `Create a git commit for the current repository changes and open a pull request for the current branch.

Before committing, inspect the current branch. If it is not already a feature branch, create and switch to a new feature branch with a descriptive name based on the changes.

Follow the repository's commit and pull request workflows. Inspect the current changes, stage any relevant untracked files, create an appropriate commit, push the branch if needed, then open a pull request with a concise summary and test plan. Return the pull request URL. If there is nothing to commit or open in a pull request, explain why and stop.`;

const BUILTIN_TYPED_SLASH_COMMANDS = new Set([
  "/clear",
  "/providers",
  "/model",
  "/models",
  "/sandbox",
  "/remote-control",
  "/mcp",
  "/mcps",
  "/agents",
  "/agent",
  "/schedule",
  "/schedules",
  "/quit",
  "/exit",
  "/q",
  "/review",
  "/verify",
  "/commit-push",
  "/commit-pr",
  "/wallet",
  "/btw",
  // Registry-dispatched commands. Must be reserved so the custom-subagent
  // matcher does not hijack them when a user-defined subagent name happens to
  // prefix-match (e.g. an "ideal" subagent would otherwise swallow /ideal,
  // routing the input to the LLM which then runs `/ideal "..."` via bash and
  // shows the resulting Windows cmd error as a fake assistant message).
  "/ideal",
  "/council",
  "/compact",
  "/expand",
  "/pin",
  "/pins",
  "/unpin",
  "/cost",
  "/ee",
  "/debug",
]);

// SandboxRow extracted to ./types.ts
// SANDBOX_ROWS, getSandboxVisibleRows extracted to ./constants.ts

// WalletDisplayInfo, WalletRow extracted to ./types.ts
// WALLET_ROWS extracted to ./constants.ts

function parseCustomSubagentSlashCommand(
  cmd: string,
  subagents: CustomSubagentConfig[],
): { agentName: string; prompt: string } | null {
  const trimmed = cmd.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1).trim();
  if (!body) return null;

  const commandToken = body.split(/\s+/, 1)[0]?.toLowerCase();
  if (commandToken && BUILTIN_TYPED_SLASH_COMMANDS.has(`/${commandToken}`)) {
    return null;
  }

  const lowerBody = body.toLowerCase();
  const sortedSubagents = [...subagents].sort((a, b) => b.name.length - a.name.length);
  const match = sortedSubagents.find((item) => {
    const lowerName = item.name.trim().toLowerCase();
    return lowerBody === lowerName || lowerBody.startsWith(`${lowerName} `);
  });
  if (!match) return null;

  return {
    agentName: match.name,
    prompt: body.slice(match.name.length).trim(),
  };
}

function buildCustomSubagentSlashPrompt(agentName: string, prompt: string): string {
  return `Use the custom sub-agent "${agentName}" for this task.

Delegate the work with the \`task\` tool using:
- \`agent\`: "${agentName}"
- \`description\`: a short summary of the work
- \`prompt\`: a detailed prompt based on the user's request

User request:
${prompt}`;
}

// CONNECT_CHANNELS, MCP_REMOTE_FIELDS, MCP_STDIO_FIELDS extracted to ./constants.ts

// AppStartupConfig, AppProps, ActiveTurnState extracted to ./types.ts

// Splash UX: the curated primary providers surfaced in the picker. Other
// providers (openai/anthropic/ollama) keep working programmatically when the
// router picks them, but the user-facing picker hides them so the user cannot
// enable a provider we are not actively maintaining UX for. NOTE: keep this in
// sync with SPLASH_PROVIDERS in app.tsx — siliconflow/google were removed from
// ProviderId, so they MUST NOT appear here (they render as dead "no key" chips).
// Hoisted to module-level so React useEffect deps stay stable across renders.
const SPLASH_PROVIDERS: readonly ProviderId[] = ["deepseek", "zai", "opencode-go", "xai"];

export interface AppLogicProps {
  agent: any;
  startupConfig: any;
  initialMessage?: any;
  onExit: any;
  onRelaunch: any;
}

function shouldOpenApiKeyModalForKey(key: {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}): boolean {
  if (key.ctrl || key.meta) return false;
  if (key.name === "return" || key.name === "backspace") return true;
  return !!(key.sequence && key.sequence.length === 1);
}

export function useAppLogic(props: AppLogicProps) {
  const { agent, startupConfig, initialMessage, onExit, onRelaunch } = props;

  const t = dark;
  const renderer = useRenderer();
  // Set initial status bar values synchronously before first render
  useMemo(() => {
    statusBarStore.setState({
      provider: agent.getProviderId(),
      model: agent.getModel(),
    });
  }, [agent.getModel, agent.getProviderId]);
  // Wire status bar subscriptions once at boot (Plan 06)
  useEffect(() => wireStatusBar(), []);

  // Agent-mode: wire addPostProcessFn so each renderer pass triggers a registry
  // snapshot → LiveFrame diff → JSONL write on fd 3.
  const agentRuntime = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as AgentModeRuntime | undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentRuntime is a process-lifetime stable ref from globalThis; it never changes after App mounts
  useEffect(() => {
    if (!agentRuntime) return;
    // Toast-only stub in normal interactive mode provides emitEvent but not
    // capture/onCommand. Skip the post-process hook so renderer doesn't throw
    // each frame (the resulting unhandledRejection kills the TUI).
    if (typeof agentRuntime.capture !== "function") return;
    const captureFrame = () => {
      agentRuntime.capture();
    };
    renderer.addPostProcessFn(captureFrame);
    return () => {
      renderer.removePostProcessFn(captureFrame);
    };
  }, [renderer, agentRuntime]);
  // Wire fd4 input bridge: translate agent JSONL ops → synthetic key events.
  useAgentInputBridge(agentRuntime);

  // ─── Phase 21 / Plan 02 — Toast subscriber ────────────────────────────────
  // Hook into the same agentRuntime.emitEvent sink used by `logEeFailure` so
  // EE failures (and any explicit `kind: "toast"` event) surface visually.
  //
  // Implementation: monkey-patch `agentRuntime.emitEvent` once on mount to tee
  // events into a local React state setter. When agentRuntime is absent (no
  // agent-mode), we fall back to a global-bus tap so the toast still renders
  // for normal users.
  const [activeToast, setActiveToast] = useState<{
    level: ToastLevel;
    text: string;
    id: number;
  } | null>(null);
  const toastIdRef = useRef(0);
  const eeToastSeenSessionsRef = useRef<Set<string>>(new Set());
  const lastBootSessionIdRef = useRef<string | null>(null);

  // Reset the per-session EE-toast debounce when a new session boots.
  // Read sessionId via the agent (component-state `sessionId` is declared
  // later in the function body; agent.getSessionId() is stable through the
  // session lifetime so this poll is cheap).
  useEffect(() => {
    const id = setInterval(() => {
      const sid = agent.getSessionId() ?? null;
      if (sid !== lastBootSessionIdRef.current) {
        lastBootSessionIdRef.current = sid;
        eeToastSeenSessionsRef.current = new Set();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [agent]);

  const pushToast = useCallback((level: ToastLevel, text: string) => {
    toastIdRef.current += 1;
    setActiveToast({ level, text, id: toastIdRef.current });
  }, []);

  // Route visible-retry progress ("[retry] rate-limited (429) — waiting Xs …")
  // through the toast surface. Without this it falls back to a raw
  // process.stderr.write, which under OpenTUI's raw-mode alt-screen paints over
  // the composer input frame (user-reported bad UX).
  useEffect(() => {
    setRetryReporter((message, level) => pushToast(level === "warn" ? "warn" : "info", message));
    return () => setRetryReporter(null);
  }, [pushToast]);

  // Stable handler — only reads from refs, never recreated, so the patched
  // emitEvent reference below remains valid for the lifetime of the runtime.
  const handleHarnessEvent = useCallback(
    (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const e = raw as Record<string, unknown>;
      if (e.t !== "event") return;

      if (e.kind === "toast") {
        const lvl = e.level === "warn" || e.level === "error" ? (e.level as ToastLevel) : "info";
        const text = typeof e.text === "string" ? e.text : "";
        if (text) pushToast(lvl, text);
        return;
      }

      if (e.kind === "steer-inject") {
        const count = typeof e.count === "number" ? e.count : 1;
        pushToast("info", `↳ steering applied (${count} message${count === 1 ? "" : "s"})`);
        return;
      }

      if (e.kind === "ee-timeout" || e.kind === "ee-error") {
        const source = typeof e.source === "string" ? e.source : "unknown";
        const kind = e.kind === "ee-timeout" ? "timeout" : "error";
        const sessionKey = lastBootSessionIdRef.current ?? "__no_session__";
        const dedupKey = `${sessionKey}::${source}::${kind}`;
        if (!eeToastSeenSessionsRef.current.has(dedupKey)) {
          eeToastSeenSessionsRef.current.add(dedupKey);
          const text = source.startsWith("bb-retrieval")
            ? "running without BB context (EE slow or down)"
            : `EE ${kind}: ${source}`;
          pushToast("warn", text);
        }
      }
    },
    [pushToast],
  );

  useEffect(() => {
    // Tap point 1: patch agentRuntime.emitEvent if present.
    if (agentRuntime && typeof agentRuntime.emitEvent === "function") {
      const original = agentRuntime.emitEvent.bind(agentRuntime);
      const patched = (e: unknown) => {
        try {
          handleHarnessEvent(e);
        } catch {
          /* never let the toast subscriber break the harness pipeline */
        }
        // Forward to the original sink (sidechannel write).
        (original as (e: unknown) => void)(e);
      };
      (agentRuntime as { emitEvent: (e: unknown) => void }).emitEvent = patched;
      return () => {
        try {
          (agentRuntime as { emitEvent: (e: unknown) => void }).emitEvent = original as (e: unknown) => void;
        } catch {
          /* restoration best-effort */
        }
      };
    }
    // Tap point 2 (no agent-mode): install a fallback __muonroiAgentRuntime
    // stub so logEeFailure (src/utils/ee-logger.ts) can deliver ee-timeout /
    // ee-error events to the toast subscriber in normal interactive sessions.
    // Without this stub, EE failures only emit to stderr — the user never
    // sees a toast.
    const globals = globalThis as Record<string, unknown>;
    const existing = globals.__muonroiAgentRuntime;
    if (existing === undefined) {
      globals.__muonroiAgentRuntime = { emitEvent: handleHarnessEvent };
      return () => {
        if (
          globals.__muonroiAgentRuntime &&
          (globals.__muonroiAgentRuntime as { emitEvent?: unknown }).emitEvent === handleHarnessEvent
        ) {
          delete globals.__muonroiAgentRuntime;
        }
      };
    }
    return undefined;
  }, [handleHarnessEvent]);

  // Live-queue steering: expose the mid-turn queue to the running turn so
  // prepareStep can inject typed-while-busy messages at the next step boundary
  // instead of deferring them to a new turn. Disabled → callback not wired, so
  // finishTurnProcessing drains the queue post-turn exactly as before.
  useEffect(() => {
    if (!getSteerInjectionEnabled()) return;
    agent.setSteerDrain(() => {
      if (queuedMessagesRef.current.length === 0) return [];
      const drained = queuedMessagesRef.current.map((m) => ({ text: m.text }));
      queuedMessagesRef.current = [];
      setQueuedMessages([]);
      return drained;
    });
    return () => agent.setSteerDrain(null);
  }, [agent]);

  const dismissToast = useCallback(() => setActiveToast(null), []);
  // ─── /Phase 21 toast subscriber ────────────────────────────────────────────

  const {
    model,
    setModel,
    showModelPicker,
    setShowModelPicker,
    modelPickerIndex,
    setModelPickerIndex,
    modelSearchQuery,
    setModelSearchQuery,
    configuredProviders,
    setConfiguredProviders,
    disabledProviders,
    setDisabledProvidersState,
    defaultProvider,
    setDefaultProviderState,
    disabledModels,
    setDisabledModelsState,
    modelPickerFocus,
    setModelPickerFocus,
    providerChipIndex,
    setProviderChipIndex,
    reasoningEffortByModel,
    setReasoningEffortByModel,
  } = useModelPicker(agent.getModel());
  const {
    showSessionPicker,
    setShowSessionPicker,
    sessionPickerIndex,
    setSessionPickerIndex,
    sessions: sessionPickerList,
    setSessions: setSessionPickerList,
  } = useSessionPicker();
  const modelRef = useRef(model);

  const [providersWithKey, setProvidersWithKey] = useState<ReadonlySet<ProviderId>>(() => new Set());
  const refreshProvidersWithKey = useCallback(async () => {
    try {
      // Use the broader check: keychain + env vars + settings.json + OAuth.
      // listStoredProviders only sees keychain, which falsely shows "no key"
      // for users who set keys via env/settings.
      const configured = await getConfiguredProviders();
      // Surface every credentialed provider that has catalog models (e.g. an
      // OAuth-authenticated OpenAI) in the picker — not just the curated splash
      // set. Previously configuredProviders stayed pinned to SPLASH_PROVIDERS,
      // so OAuth providers worked at the routing layer but could never be
      // selected in /models. Splash providers stay listed even with no key so
      // the user can still press `k` to add one.
      setConfiguredProviders(
        resolvePickerProviders(SPLASH_PROVIDERS, configured, (p) => getModelsForProvider(p).length > 0),
      );
      setProvidersWithKey(new Set(configured));
    } catch {
      setConfiguredProviders([...SPLASH_PROVIDERS]);
      setProvidersWithKey(new Set());
    }
  }, [setConfiguredProviders]);

  useEffect(() => {
    let cancelled = false;
    // Paint the curated splash providers immediately, then replace with the
    // resolved list (splash ∪ configured-with-models) once the async credential
    // check completes. The modal shows a "(no key)" badge and lets the user
    // press `k` to set a key without leaving the TUI.
    setConfiguredProviders([...SPLASH_PROVIDERS]);
    if (!cancelled) void refreshProvidersWithKey();
    return () => {
      cancelled = true;
    };
  }, [setConfiguredProviders, refreshProvidersWithKey]);

  const [apiKeyPrompt, setApiKeyPrompt] = useState<{
    provider: ProviderId;
    value: string;
    error: string | null;
    reveal?: boolean;
  } | null>(null);
  const submitProviderKey = useCallback(async () => {
    if (!apiKeyPrompt) return;
    const key = apiKeyPrompt.value.trim();
    if (!key) {
      setApiKeyPrompt({ ...apiKeyPrompt, error: "Key cannot be empty" });
      return;
    }
    try {
      const ok = await setKeyForProvider(apiKeyPrompt.provider, key);
      if (!ok) {
        setApiKeyPrompt({ ...apiKeyPrompt, error: "Could not store key. Try `export <PROVIDER>_API_KEY=…`." });
        return;
      }
      await refreshProvidersWithKey();
      setApiKeyPrompt(null);
    } catch (e) {
      setApiKeyPrompt({ ...apiKeyPrompt, error: (e as Error).message });
    }
  }, [apiKeyPrompt, refreshProvidersWithKey]);

  // ── OAuth subscription login (browser-based) for openai / xai ───────────
  // One auth mode per provider: a successful OAuth login clears any stored API
  // key for that provider (exclusivity). Runs the registry login() flow, which
  // opens the browser and resolves when the loopback callback completes.
  const [oauthProviders, setOAuthProviders] = useState<ReadonlySet<ProviderId>>(() => new Set());
  const [oauthLogin, setOAuthLogin] = useState<{ provider: ProviderId; error: string | null } | null>(null);
  const oauthCancelRef = useRef(false);

  // Populate the OAuth-capable provider set once, from the OAuth registry.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { listOAuthProviderIds } = await import("../providers/auth/registry.js");
        const ids = await listOAuthProviderIds();
        if (alive) setOAuthProviders(new Set(ids as ProviderId[]));
      } catch {
        /* registry unavailable — no OAuth affordance */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const startProviderOAuth = useCallback(
    async (provider: ProviderId) => {
      oauthCancelRef.current = false;
      setOAuthLogin({ provider, error: null });
      try {
        const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
        const cfg = await getOAuthProviderConfig(provider);
        if (!cfg) {
          setOAuthLogin({ provider, error: "OAuth is not available for this provider." });
          return;
        }
        const tokens = await cfg.provider.login({});
        if (oauthCancelRef.current) return;
        const { saveTokens } = await import("../providers/auth/token-store.js");
        await saveTokens(provider, tokens);
        // Exclusivity: OAuth login clears any stored API key for this provider.
        try {
          const { clearEnvVar } = await import("../providers/env-store.js");
          const { ENV_BY_PROVIDER } = await import("../providers/keychain.js");
          clearEnvVar(ENV_BY_PROVIDER[provider]);
        } catch {
          /* best-effort */
        }
        await refreshProvidersWithKey();
        setOAuthLogin(null);
      } catch (e) {
        if (oauthCancelRef.current) return;
        setOAuthLogin({ provider, error: (e as Error).message });
      }
    },
    [refreshProvidersWithKey],
  );

  const cancelProviderOAuth = useCallback(() => {
    oauthCancelRef.current = true;
    setOAuthLogin(null);
  }, []);

  // Sync React model state with status bar store so chat input reflects
  // per-turn router upgrades (brain EE upgrade, warm/cold routing, etc.)
  useEffect(() => {
    return statusBarStore.subscribe((s) => {
      if (s.model) setModel(s.model);
    });
  }, [setModel]);
  const initialHasApiKey = agent.hasApiKey();
  const [hasApiKey, setHasApiKey] = useState(initialHasApiKey);
  const [messages, setMessages] = useState<ChatEntry[]>(() => agent.getChatEntries());
  const [streamContent, setStreamContent] = useState("");
  // Reasoning state: track activity + last-elapsed for a "💭 Thought for Ns"
  // pill instead of dumping CoT into the chat (saves 80–120 setState/sec on
  // DeepSeek Flash's verbose reasoning stream — was a freeze contributor).
  const [reasoningActive, setReasoningActive] = useState(false);
  const [lastReasoningElapsedMs, setLastReasoningElapsedMs] = useState(0);
  const reasoningStartRef = useRef<number | null>(null);
  const [streamReasoning, setStreamReasoning] = useState("");
  const reasoningAccRef = useRef("");
  const lastReasoningRenderTimeRef = useRef(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [liveTurnSourceLabel, setLiveTurnSourceLabel] = useState<string | null>(null);
  modelRef.current = model;
  const [sandboxMode, setSandboxModeState] = useState<SandboxMode>(agent.getSandboxMode());
  const [mode, setModeState] = useState<AgentMode>(agent.getMode());
  const [showSandboxPicker, setShowSandboxPicker] = useState(false);
  const [sandboxSettings, setSandboxSettingsState] = useState<SandboxSettings>(() => agent.getSandboxSettings());
  const [sandboxSettingsFocusIndex, setSandboxSettingsFocusIndex] = useState(0);
  const [sandboxSettingsEditing, setSandboxSettingsEditing] = useState<string | null>(null);
  const [sandboxSettingsEditBuffer, setSandboxSettingsEditBuffer] = useState("");
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [walletSettings, setWalletSettings] = useState<Required<PaymentSettings>>(() => loadPaymentSettings());
  const [walletFocusIndex, setWalletFocusIndex] = useState(0);
  const [walletDisplayInfo, setWalletDisplayInfo] = useState<WalletDisplayInfo>({
    address: null,
    ethBalance: null,
    usdcBalance: null,
  });
  const [pendingPaymentApproval, setPendingPaymentApproval] = useState<{
    url: string;
    description: string;
    security: string;
    securityLabel: string;
    securityUrl: string;
    amount: string;
    network: string;
    asset: string;
    approvalId?: string;
    selected: number;
  } | null>(null);
  const [pendingCouncilQuestion, setPendingCouncilQuestion] = useState<CouncilQuestionData | null>(null);
  const [councilCardState, setCouncilCardState] = useState<CouncilCardState | null>(null);
  const [preflightCardState, setPreflightCardState] = useState<CouncilCardState | null>(null);
  // Ref mirrors — keep current synchronously so keyboard-burst handlers read
  // the correct idx without waiting on React's setState commit (same pattern as showSlashMenuRef).
  const pendingCouncilQuestionRef = useRef<CouncilQuestionData | null>(null);
  const councilCardStateRef = useRef<CouncilCardState | null>(null);
  const preflightCardStateRef = useRef<CouncilCardState | null>(null);
  // E2 — post-action heartbeat shown while waiting for the NEXT chunk after the
  // user answers an AskCard. Avoids the silent gap between accept-N and the
  // arrival of chunk-(N+1) (next AskCard, council phase chunk, sprint stage).
  // The chunk loop in /ideal calls clearInterCardHeartbeat() on every chunk.
  const interCardHeartbeatRef = useRef<{ interval: ReturnType<typeof setInterval>; marker: string } | null>(null);
  const setPendingCouncilQuestionSync = useCallback((v: CouncilQuestionData | null) => {
    pendingCouncilQuestionRef.current = v;
    setPendingCouncilQuestion(v);
  }, []);
  const setCouncilCardStateSync = useCallback(
    (v: CouncilCardState | null | ((prev: CouncilCardState | null) => CouncilCardState | null)) => {
      // Compute the new value against the CURRENT ref so the ref reflects the
      // latest state immediately — handlers running before React flushes the
      // setState updater must see this value. Putting the ref write inside
      // the updater closure defers it until React commits, which races with
      // a harness Enter that arrives between this call and the React flush.
      const next =
        typeof v === "function"
          ? (v as (p: CouncilCardState | null) => CouncilCardState | null)(councilCardStateRef.current)
          : v;
      councilCardStateRef.current = next;
      setCouncilCardState(next);
    },
    [],
  );
  const setPreflightCardStateSync = useCallback(
    (v: CouncilCardState | null | ((prev: CouncilCardState | null) => CouncilCardState | null)) => {
      // Same pattern as setCouncilCardStateSync — ref must be written before
      // the React batch flush so synchronous handlers see the latest value.
      const next =
        typeof v === "function"
          ? (v as (p: CouncilCardState | null) => CouncilCardState | null)(preflightCardStateRef.current)
          : v;
      preflightCardStateRef.current = next;
      setPreflightCardState(next);
    },
    [],
  );
  const [pendingCouncilPreflight, setPendingCouncilPreflight] = useState<{
    preflightId: string;
    problemStatement: string;
    constraints: string[];
    successCriteria: string[];
    scope: string;
    participants: Array<{ role: string; model: string }>;
    researchNeeded: boolean;
  } | null>(null);
  const [councilStatuses, setCouncilStatuses] = useState<CouncilStatusData[]>([]);
  const councilDoneAtRef = useRef<Map<string, number>>(new Map());
  const [councilPhases, setCouncilPhases] = useState<CouncilPhaseEvent[]>([]);
  const [councilMessages, setCouncilMessages] = useState<CouncilMessage[]>([]);
  // Debate transcript pill: collapsed by default (shows a live tail while the
  // debate runs, a one-line summary once done). Ctrl+O expands to the full
  // back-and-forth. Synthesis renders outside the pill so it stays visible.
  const [councilTranscriptExpanded, setCouncilTranscriptExpanded] = useState(false);
  // Peek toggle (ctrl+e) for the todo panel while it auto-collapses during a
  // council debate. Default collapsed; expands back to the full panel on demand.
  const [councilTodoExpanded, setCouncilTodoExpanded] = useState(false);
  const [councilInfoCards, setCouncilInfoCards] = useState<CouncilInfoCard[]>([]);
  // P3 — council metadata for the context rail (leader/panel/budget/research/
  // cost), upsert-merged from incremental council_meta patches.
  const [councilMeta, setCouncilMeta] = useState<CouncilMetaPatch>({});
  // Tracks the current council's topic so a NEW council (topic change) can flush
  // the prior council's residue even when clearLiveTurnUi (turn-end) was skipped
  // — e.g. an Esc-interrupt before a fresh /council. applyCouncilMetaPatch is
  // defined below, after councilRounds, so it can reset that state too.
  const councilTopicRef = useRef<string | undefined>(undefined);
  // P5/P6 — per-round lifecycle records, upsert-merged by round number so a
  // `running` record is overwritten by its `done` record in place.
  const [councilRounds, setCouncilRounds] = useState<CouncilRoundRecord[]>([]);
  // P2/D — round selected in the rail to scope the MAIN transcript pane. null =
  // global (all/live rounds). Mirrored into a ref so the global key handler can
  // read the current round list without re-subscribing on every round update.
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const councilRoundsRef = useRef<CouncilRoundRecord[]>([]);
  useEffect(() => {
    councilRoundsRef.current = councilRounds;
    // Drop a stale selection if that round is gone (new debate / cleared).
    if (selectedRound !== null && !councilRounds.some((r) => r.round === selectedRound)) {
      setSelectedRound(null);
    }
  }, [councilRounds, selectedRound]);
  const applyCouncilMetaPatch = useCallback((patch: CouncilMetaPatch) => {
    const newTopic = patch.topic;
    // The council entrypoint (index.ts) emits leader+panel+topic together exactly
    // once, at the START of each debate; every later patch is partial (a lone
    // roundBudget / researchMode / successCriteria / criteriaMet). That combo is
    // the STRONGEST new-council signal — stronger than a topic change, which
    // misses a re-run on the SAME topic (auto-council re-firing on a phase, or a
    // fresh /council after an Esc that skipped clearLiveTurnUi) and leaks the
    // prior council's pinned successCriteria into the rail as stale ○ rows (F5).
    // Reset on it unconditionally; keep the topic-change check as a fallback.
    const isCouncilStart = isCouncilStartPatch(patch);
    const isNewTopic = !!newTopic && !!councilTopicRef.current && newTopic !== councilTopicRef.current;
    if (newTopic) councilTopicRef.current = newTopic;
    if (isCouncilStart || isNewTopic) {
      // Flush prior round records + replace meta so a previous council's Progress
      // row / criteriaMet / successCriteria / leader / panel can't bleed into the
      // new one. selectedRound follows via the councilRounds effect above.
      setCouncilRounds([]);
      setCouncilMeta({ ...patch });
      return;
    }
    setCouncilMeta((prev) => ({ ...prev, ...patch }));
  }, []);
  const applyCouncilRound = useCallback((rec: CouncilRoundRecord) => {
    setCouncilRounds((prev) => {
      const idx = prev.findIndex((r) => r.round === rec.round);
      if (idx < 0) return [...prev, rec];
      const next = prev.slice();
      // Preserve fields from the running record the done record may omit.
      next[idx] = { ...next[idx], ...rec };
      return next;
    });
  }, []);
  const [councilPlaceholders, setCouncilPlaceholders] = useState<
    Map<
      string,
      { role: string; side: "left" | "right"; color: string; variant: "participant" | "leader"; detail?: string }
    >
  >(new Map());

  const resolveStyle = useRolePalette();
  const getSide = usePairSideMap();
  const { store: storeQuote, getPartnerLast } = usePairQuoteBuffer();
  const [productStatus, setProductStatus] = useState<ProductStatusCardData | null>(null);
  const [activeHaltCard, setActiveHaltCard] = useState<HaltChunk | null>(null);
  const [haltSelectedIndex, setHaltSelectedIndex] = useState(0);
  // A — most recent sprint number seen on a product_status_card, used to title
  // the recovery card ("Sprint N failed") when an /ideal run throws mid-run.
  const lastProductSprintNRef = useRef<number | null>(null);
  const [initNewForm, setInitNewForm] = useState<InitNewFormState | null>(null);
  const lastInitNewStepRef = useRef<string | null>(null);

  // E2 — start/clear post-answer heartbeat. Renders "⏳ Waiting for next phase...
  // elapsed Ns" as a fresh assistant entry that updates in place every second
  // until the next chunk arrives. clearInterCardHeartbeat is idempotent and is
  // also called from the chunk-loop (line ~3402) and on AskCard cancel.
  const clearInterCardHeartbeat = useCallback(() => {
    const h = interCardHeartbeatRef.current;
    if (!h) return;
    clearInterval(h.interval);
    interCardHeartbeatRef.current = null;
    // Strip the heartbeat assistant entry so the next chunk starts clean. It is
    // usually the last entry, but an askcard answer can insert a `user` message
    // AFTER it (the answer flow runs outside the chunk loop), which left the
    // heartbeat orphaned + frozen in scrollback. Match the precise heartbeat
    // shape (`⏳ ... elapsed Ns`) and remove it wherever it landed in the tail —
    // the shape is distinctive enough not to hit real assistant content.
    setMessages((prev) => {
      const HEARTBEAT_RE = /^⏳ .*\.\.\. elapsed \d+s\s*$/;
      const idx = prev.findIndex((e) => e.type === "assistant" && HEARTBEAT_RE.test((e.content ?? "").trim()));
      if (idx === -1) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    });
  }, []);

  const startInterCardHeartbeat = useCallback(
    (label: string) => {
      clearInterCardHeartbeat();
      const startedAt = Date.now();
      const marker = "⏳ ";
      // Do NOT render the heartbeat immediately. Council phase transitions are
      // frequently sub-second, and an entry that flashes "elapsed 0s" for every
      // short gap is pure noise (this is exactly the "meaningless elapsed 0s" the
      // user reported). Only surface the ticking entry once a gap is long enough
      // to warrant a "still working" reassurance — and never show "0s". The tail
      // is stripped by clearInterCardHeartbeat() at the top of the next chunk
      // iteration, so the heartbeat is always the last entry while active; that
      // invariant lets us detect-or-create idempotently on each tick.
      const MIN_VISIBLE_S = 3;
      const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        if (elapsed < MIN_VISIBLE_S) return;
        const line = `${marker}${label}... elapsed ${elapsed}s\n`;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const hasHeartbeat = last?.type === "assistant" && !!last.content?.includes(marker);
          if (!hasHeartbeat) return [...prev, buildAssistantEntry(line)];
          return [...prev.slice(0, -1), { ...last, content: line }];
        });
      }, 1_000);
      interCardHeartbeatRef.current = { interval, marker };
    },
    [clearInterCardHeartbeat],
  );

  useEffect(() => {
    const cur = initNewForm?.step ?? null;
    const prev = lastInitNewStepRef.current;
    if (cur !== prev) {
      if (cur !== null) {
        logUIInteraction(agent.getSessionId() ?? undefined, {
          subtype: "init_new_step",
          data: { from: prev ?? "(closed)", to: cur },
        });
      }
      lastInitNewStepRef.current = cur;
    }
  }, [initNewForm?.step, agent]);
  const [pointToExistingForm, setPointToExistingForm] = useState<PointToExistingFormState | null>(null);
  const [councilProgress, setCouncilProgress] = useState<{
    status: "running" | "done" | "error";
    specPath: string;
    hasContent: boolean;
    error?: string;
  } | null>(null);
  // TEST SEAM — inject a synthetic halt chunk on boot when --inject-halt is set.
  // This lets harness E2E specs verify the recovery card without a real CB-3 run.
  useEffect(() => {
    if (!startupConfig.injectHalt) return;
    setActiveHaltCard({
      type: "halt",
      reason: "no_recipe",
      detail: "Injected by --inject-halt for E2E testing.",
      recovery_options: [
        {
          id: "init_new",
          label: "Init new project",
          description: "Run /ideal init to scaffold a fresh verify recipe.",
        },
        {
          id: "point_to_existing",
          label: "Point to existing recipe",
          description: "Provide the path to an existing verify-manifest.yml.",
        },
        {
          id: "continue_as_council",
          label: "Continue as council brainstorm",
          description: "Skip verification and proceed with the council debate flow.",
        },
      ],
    });
    setHaltSelectedIndex(0);
  }, [startupConfig.injectHalt]);
  // TEST SEAM (A) — inject a synthetic sprint-failed recovery card on boot when
  // --inject-halt-sprint is set, so E2E specs can verify the break-recovery card.
  useEffect(() => {
    if (!startupConfig.injectHaltSprint) return;
    setActiveHaltCard({
      type: "halt",
      reason: "sprint_failed",
      sprintN: 3,
      detail: "Injected by --inject-halt-sprint for E2E testing.",
      recovery_options: [...SPRINT_FAILED_RECOVERY_OPTIONS],
    });
    setHaltSelectedIndex(0);
  }, [startupConfig.injectHaltSprint]);
  // Reap completed status rows after their hold window so the row clears.
  useEffect(() => {
    if (councilStatuses.length === 0) return;
    const id = setInterval(() => {
      setCouncilStatuses((prev) => {
        const next = reapStatuses(prev, councilDoneAtRef.current, Date.now());
        if (next.length === prev.length) return prev;
        for (const s of prev) {
          if (!next.includes(s)) councilDoneAtRef.current.delete(s.statusId);
        }
        return next;
      });
    }, 500);
    return () => clearInterval(id);
  }, [councilStatuses.length]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);
  // ID of the in-progress ToolGroup entry (Claude-style grouping). Non-null while
  // the assistant is in a tool-calling streak; cleared when text arrives or the
  // stream ends so the next streak opens a fresh group.
  const currentToolGroupIdRef = useRef<string | null>(null);
  // Pending resolvers for tool-loop-cap askcards. Keyed by questionId; populated
  // by setToolLoopCapHandler, drained by the askcard answer/cancel branches.
  const toolLoopCapResolversRef = useRef<Map<string, (verdict: "continue" | "stop") => void>>(new Map());

  // Pending resolvers for safety-override askcards. Keyed by questionId; populated
  // by setSafetyOverrideHandler, drained by the askcard answer/cancel branches.
  const safetyOverrideResolversRef = useRef<Map<string, (verdict: SafetyOverrideVerdict) => void>>(new Map());
  // Pending resolvers for ask_user askcards (the model-callable ask_user tool).
  // Keyed by questionId; populated by setAskUserHandler, drained by the askcard
  // answer/cancel branches. Resolve value = the human's answer string.
  const askUserResolversRef = useRef<Map<string, (answer: string) => void>>(new Map());
  // Current todo snapshot (Claude-style sticky checklist). Updated by
  // `task_list_update` chunks emitted after every `todo_write` tool call.
  // Auto-hides ~2s after 100% completion so the panel doesn't linger.
  const [taskListSnapshot, setTaskListSnapshot] = useState<TaskListSnapshot | null>(() => agent.getLastTodoSnapshot());
  const taskListClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(() => agent.getSessionTitle());
  const [sessionId, setSessionId] = useState<string | null>(() => agent.getSessionId());
  // Session tree (root + rotation/sub-agent descendants) for the rail's
  // "Sessions" block. Recomputed when the visible transcript or session id
  // changes — sub-sessions are spawned/absorbed across turns, so message.length
  // is the cheapest signal that the tree may have grown. getSessionTree() never
  // throws (internal try/catch → []).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId + messages.length are intentional recompute signals (getSessionTree reads the current session internally)
  const sessionTree = useMemo(() => agent.getSessionTree(), [agent, sessionId, messages.length]);
  const [showApiKeyModal, setShowApiKeyModal] = useState(() => !initialHasApiKey);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  // Ref stays current synchronously so keyboard-burst handlers read the right value
  const showSlashMenuRef = useRef(false);
  const setShowSlashMenuSync = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setShowSlashMenu((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      showSlashMenuRef.current = next;
      return next;
    });
  }, []);
  // Diagnostic tap (MUONROI_DEBUG_TAB=1): log every showSlashMenu state
  // transition so live runs can see if Tab autocomplete's close actually
  // commits, or if a subsequent effect re-opens the menu.
  useEffect(() => {
    if (process.env.MUONROI_DEBUG_TAB === "1") {
      process.stderr.write(
        `[tab-debug] showSlashMenu-state-change: ${JSON.stringify({
          showSlashMenu,
          ref: showSlashMenuRef.current,
          plainText: inputRef.current?.plainText ?? null,
        })}\n`,
      );
    }
  }, [showSlashMenu]);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [slashSearchQuery, setSlashSearchQuery] = useState("");
  const [btwState, setBtwState] = useState<BtwState | null>(null);
  const btwAbortRef = useRef<AbortController | null>(null);
  const btwStateRef = useRef<BtwState | null>(null);
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  /** Incremented on each successful TUI copy; drives a brief "Copied" banner. */
  const [copyFlashId, setCopyFlashId] = useState(0);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(() => new Set());
  const [activeSubagent, setActiveSubagent] = useState<SubagentStatus | null>(null);
  const [pqs, setPqs] = useState<PlanQuestionsState>(initialPlanQuestionsState());
  const pasteCounterRef = useRef(0);
  const pasteBlocksRef = useRef<PasteBlock[]>([]);
  const apiKeyInputRef = useRef<TextareaRenderable>(null);
  const inputRef = useRef<TextareaRenderable>(null);
  // Per-session input history: ArrowUp recalls earlier submitted prompts when
  // the prompt buffer is empty. Lives only in component state, so each session
  // (process) starts with a clean slate — no rác history bleeding between sessions.
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const historyDraftRef = useRef<string>("");
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  // Scroll-lock (MUONROI_SCROLL_LOCK): while the user has scrolled up to read,
  // suppress forced `scrollToBottom()` yanks and surface a jump-to-latest pill.
  // Count of new appends suppressed since the user left the bottom.
  const newSinceLockRef = useRef(0);
  const [newSinceLock, setNewSinceLock] = useState(0);
  const [scrollLockedAway, setScrollLockedAway] = useState(false);
  // Context rail (MUONROI_CONTEXT_RAIL): user can hide/show the right metadata
  // panel with Ctrl+B. Defaults visible; the rail also auto-hides below 100 cols
  // (decided in app.tsx where terminal width is known).
  const [railVisible, setRailVisible] = useState(true);
  // True when the user is pinned to (or near) the bottom. Mirrors OpenTUI's
  // private `_hasManualScroll`: once the user scrolls up, sticky-bottom stops
  // and this returns false, so our explicit scrolls back off. Falls back to a
  // geometric at-bottom check if the private field is ever absent.
  const isPinnedToBottom = useCallback((): boolean => {
    const sb = scrollRef.current;
    if (!sb) return true;
    const manual = (sb as unknown as { _hasManualScroll?: boolean })._hasManualScroll;
    if (typeof manual === "boolean") return !manual;
    const vpH = (sb.viewport as unknown as { height?: number }).height ?? 0;
    return sb.scrollTop + vpH >= sb.scrollHeight - 2;
  }, []);
  // Soft scroll: respects scroll-lock. New content that arrives while the user
  // reads history does NOT move the viewport; it just increments the pill count.
  const scrollToBottom = useCallback(() => {
    if (isScrollLockEnabled() && !isPinnedToBottom()) {
      newSinceLockRef.current += 1;
      setNewSinceLock(newSinceLockRef.current);
      setScrollLockedAway(true);
      return;
    }
    // Pinned (or lock off): scroll, and if the user had manually scrolled back
    // to the bottom on their own, retire the jump-to-latest pill.
    if (newSinceLockRef.current !== 0) {
      newSinceLockRef.current = 0;
      setNewSinceLock(0);
      setScrollLockedAway(false);
    }
    try {
      scrollRef.current?.scrollTo(scrollRef.current?.scrollHeight ?? 99999);
    } catch {
      /* */
    }
  }, [isPinnedToBottom]);
  // Hard scroll: re-arms native sticky and jumps to the latest line regardless
  // of manual-scroll state. Used by explicit user actions (new prompt submit,
  // jump-to-latest pill) that intend to return to the live tail.
  const scrollToBottomForced = useCallback(() => {
    const sb = scrollRef.current;
    if (sb) {
      try {
        (sb as unknown as { _hasManualScroll?: boolean })._hasManualScroll = false;
        sb.stickyScroll = true;
        sb.scrollTo(sb.scrollHeight ?? 99999);
      } catch {
        /* */
      }
    }
    newSinceLockRef.current = 0;
    setNewSinceLock(0);
    setScrollLockedAway(false);
  }, []);
  const { width, height } = useTerminalDimensions();
  const processedInitial = useRef(false);
  const contentAccRef = useRef("");
  const startTimeRef = useRef(0);
  // Plan 23-02 — Capture the most recent `/ideal "..."` idea so the init-new
  // form can route it through designBBPackages() for EE-driven template + pkg
  // suggestion. Empty string falls back to the manual template menu.
  const lastIdealIdeaRef = useRef<string>("");
  const originalIdealPromptRef = useRef<string | null>(null);
  const isProcessingRef = useRef(false);
  const hasApiKeyRef = useRef(initialHasApiKey);
  const showApiKeyModalRef = useRef(!initialHasApiKey);
  const queuedMessagesRef = useRef<QueuedMessage[]>([]);
  const processMessageRef = useRef<(text: string, displayText?: string) => Promise<void> | void>(() => {});
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const modeInfoRef = useRef<(typeof MODES)[number]>(MODES[0]);
  const activeRunIdRef = useRef(0);
  const interruptedRunIdRef = useRef<number | null>(null);
  const activeTurnRef = useRef<ActiveTurnState | null>(null);
  const coordinatorRef = useRef(createTurnCoordinator());
  const bridgeRef = useRef<TelegramBridgeHandle | null>(null);
  const telegramAgentsRef = useRef<Map<number, Agent>>(new Map());
  const telegramEntryCountsRef = useRef<Map<number, number>>(new Map());
  const telegramSubagentUnsubsRef = useRef<Map<number, () => void>>(new Map());
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showTelegramTokenModal, setShowTelegramTokenModal] = useState(false);
  const [showTelegramPairModal, setShowTelegramPairModal] = useState(false);
  const [telegramTokenError, setTelegramTokenError] = useState<string | null>(null);
  const [telegramPairError, setTelegramPairError] = useState<string | null>(null);
  const [connectModalIndex, setConnectModalIndex] = useState(0);
  const telegramTokenInputRef = useRef<TextareaRenderable>(null);
  const telegramPairInputRef = useRef<TextareaRenderable>(null);
  const showConnectModalRef = useRef(false);
  const showTelegramTokenModalRef = useRef(false);
  const showTelegramPairModalRef = useRef(false);
  const {
    showMcpModal,
    setShowMcpModal,
    showMcpEditor,
    setShowMcpEditor,
    mcpSearchQuery,
    setMcpSearchQuery,
    mcpModalIndex,
    setMcpModalIndex,
    mcpServers,
    setMcpServers,
    mcpEditorDraft,
    setMcpEditorDraft,
    mcpEditorField,
    setMcpEditorField,
    mcpEditorSyncKey,
    setMcpEditorSyncKey,
    mcpEditorError,
    setMcpEditorError,
    editingMcpId,
    setEditingMcpId,
  } = useMcpEditor();
  const showMcpModalRef = useRef(false);
  const showMcpEditorRef = useRef(false);
  const mcpLabelRef = useRef<TextareaRenderable>(null);
  const mcpUrlRef = useRef<TextareaRenderable>(null);
  const mcpHeadersRef = useRef<TextareaRenderable>(null);
  const mcpCommandRef = useRef<TextareaRenderable>(null);
  const mcpArgsRef = useRef<TextareaRenderable>(null);
  const mcpCwdRef = useRef<TextareaRenderable>(null);
  const mcpEnvRef = useRef<TextareaRenderable>(null);
  const {
    showAgentsModal,
    setShowAgentsModal,
    showAgentsEditor,
    setShowAgentsEditor,
    subAgents,
    setSubAgents,
    agentsSearchQuery,
    setAgentsSearchQuery,
    agentsModalIndex,
    setAgentsModalIndex,
    editingSubagent,
    setEditingSubagent,
    agentsEditorDraft,
    setAgentsEditorDraft,
    agentsEditorField,
    setAgentsEditorField,
    agentsEditorModelIndex,
    setAgentsEditorModelIndex,
    agentsEditorSyncKey,
    setAgentsEditorSyncKey,
    agentsEditorError,
    setAgentsEditorError,
    showScheduleModal,
    setShowScheduleModal,
    schedules,
    setSchedules,
    scheduleSearchQuery,
    setScheduleSearchQuery,
    scheduleModalIndex,
    setScheduleModalIndex,
  } = useAgentEditor();
  const showAgentsModalRef = useRef(false);
  const showAgentsEditorRef = useRef(false);
  const subagentNameRef = useRef<TextareaRenderable>(null);
  const subagentInstructionRef = useRef<TextareaRenderable>(null);
  const showScheduleModalRef = useRef(false);

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState<string | null>(null);
  const showUpdateModalRef = useRef(false);

  const fileIndexRef = useRef<FileIndex | null>(null);
  if (!fileIndexRef.current) {
    fileIndexRef.current = new FileIndex(agent.getCwd());
  }
  const fileMentionCounterRef = useRef(0);
  const fileMentionBlocksRef = useRef<FileMentionBlock[]>([]);

  const handleFileAccept = useCallback((filePath: string, tokenInfo: { startPos: number; endPos: number }) => {
    const ta = inputRef.current;
    if (!ta) return;

    const id = ++fileMentionCounterRef.current;
    const block: FileMentionBlock = { id, path: fileIndexRef.current?.resolvePath(filePath) ?? filePath };
    fileMentionBlocksRef.current = [...fileMentionBlocksRef.current, block];

    const text = ta.plainText;
    const before = text.slice(0, tokenInfo.startPos);
    const after = text.slice(tokenInfo.endPos);
    const token = getFileMentionToken(block);
    const newText = `${before}${token} ${after}`;
    ta.setText(newText);
    ta.cursorOffset = before.length + token.length + 1;
  }, []);

  const typeahead = useTypeahead(inputRef, fileIndexRef.current, handleFileAccept);
  const typeaheadRef = useRef(typeahead);
  typeaheadRef.current = typeahead;

  const setMode = useCallback(
    (m: AgentMode) => {
      if (m === "agent" && mode === "plan" && activePlan) {
        const planText = [
          `# ${activePlan.title}`,
          activePlan.summary,
          "",
          ...activePlan.steps.map(
            (s, i) =>
              `${i + 1}. ${s.title}: ${s.description}${s.filePaths?.length ? ` (${s.filePaths.join(", ")})` : ""}`,
          ),
        ].join("\n");
        agent.setPlanContext(planText);
      }
      agent.setMode(m);
      setModeState(m);
      setModel(agent.getModel());
    },
    [agent, mode, activePlan, setModel],
  );
  const cycleMode = useCallback(() => {
    const idx = MODES.findIndex((m) => m.id === mode);
    setMode(MODES[(idx + 1) % MODES.length].id);
  }, [mode, setMode]);

  const modeInfo = MODES.find((m) => m.id === mode)!;
  modeInfoRef.current = modeInfo;
  const modelInfo = getModelInfo(model);
  const contextStats = modelInfo ? agent.getContextStats(modelInfo.contextWindow, streamContent) : null;

  // UI Loading logic for dynamic models — restrict to providers that have API keys configured
  // and have not been explicitly disabled by the user. Catalog entries lacking a provider are
  // kept (defensive); models with an unknown provider are filtered out to avoid clutter.
  const activeProviders = useMemo(() => {
    const disabled = new Set(disabledProviders);
    return new Set(configuredProviders.filter((p) => !disabled.has(p)));
  }, [configuredProviders, disabledProviders]);

  const modelList = useMemo(() => {
    if (isLoading) return [];
    if (configuredProviders.length === 0) return MODELS; // boot-time fallback before async load
    return MODELS.filter((m) => !m.provider || activeProviders.has(m.provider as ProviderId));
  }, [activeProviders, configuredProviders.length]);

  const filteredModels = modelSearchQuery
    ? modelList.filter(
        (m) =>
          m.name.toLowerCase().includes(modelSearchQuery.toLowerCase()) ||
          m.id.toLowerCase().includes(modelSearchQuery.toLowerCase()),
      )
    : [...modelList];

  const filteredModelIds = filteredModels.map((m) => m.id);
  // Autocomplete shows the curated primary surface. When the user types a
  // query we widen the search to ALL items (including hidden ones) so power
  // users can still discover commands that were intentionally dehoisted.
  const filteredSlashItems = slashSearchQuery
    ? (() => {
        const q = slashSearchQuery.toLowerCase();
        // Rank by exactness so the command the user TYPED wins: exact label/id
        // (0) > label/id prefix (1) > label substring (2) > description
        // substring (3). Without ranking, a command whose DESCRIPTION contains
        // the query (e.g. /ee "…status…") sorts above the exact match the user
        // typed (/status) and Enter runs the wrong command. See VERIFY F5/F6.
        const rank = (item: SlashMenuItem): number => {
          const label = item.label.toLowerCase();
          const id = item.id.toLowerCase();
          if (label === q || id === q) return 0;
          if (label.startsWith(q) || id.startsWith(q)) return 1;
          if (label.includes(q)) return 2;
          if (item.description.toLowerCase().includes(q)) return 3;
          return 99;
        };
        return SLASH_MENU_ITEMS.map((item, i) => ({ item, r: rank(item), i }))
          .filter((x) => x.r < 99)
          .sort((a, b) => a.r - b.r || a.i - b.i)
          .map((x) => x.item);
      })()
    : // Empty query (just "/"): primary surface first, then the rest so the
      // full command set is reachable by arrow-scroll — the dropdown viewport
      // scrolls, keeping the splash lean while nothing stays unreachable.
      SLASH_MENU_ITEMS_ARROW_ORDER;
  const slashInputIsMatched = useMemo(() => {
    if (!showSlashMenu) return false;
    const typed = slashSearchQuery.toLowerCase();
    if (!typed) return false;
    return filteredSlashItems.some((item) => item.id.toLowerCase() === typed || item.label.toLowerCase() === typed);
  }, [showSlashMenu, filteredSlashItems, slashSearchQuery]);
  const mcpRows = buildMcpBrowseRows(mcpServers, POPULAR_MCP_CATALOG, mcpSearchQuery);
  const mcpEditorFields = mcpEditorDraft.transport === "stdio" ? MCP_STDIO_FIELDS : MCP_REMOTE_FIELDS;
  const agentRows = useMemo(
    () => buildSubagentBrowseRows(subAgents, agentsSearchQuery),
    [subAgents, agentsSearchQuery],
  );
  const scheduleRows = useMemo(
    () => buildScheduleBrowseRows(schedules, scheduleSearchQuery),
    [schedules, scheduleSearchQuery],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: setMcpServers is a stable useState setter from useMcpEditor hook
  const syncStoredMcpServers = useCallback((servers: McpServerConfig[]) => {
    setMcpServers(servers);
    saveMcpServers(servers);
  }, []);

  const applySandboxMode = useCallback(
    (next: SandboxMode) => {
      agent.setSandboxMode(next);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setSandboxMode(next);
      }
      setSandboxModeState(next);
      // sandboxMode settings removed — sandbox will be redesigned later
    },
    [agent],
  );

  const applySandboxSettings = useCallback(
    (next: SandboxSettings) => {
      agent.setSandboxSettings(next);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setSandboxSettings(next);
      }
      setSandboxSettingsState(next);
      // sandbox settings removed — sandbox will be redesigned later
    },
    [agent],
  );

  const openSandboxPicker = useCallback(() => {
    setSandboxSettingsFocusIndex(0);
    setSandboxSettingsEditing(null);
    setSandboxSettingsEditBuffer("");
    setShowSandboxPicker(true);
  }, []);

  const applyWalletSettings = useCallback((next: Required<PaymentSettings>) => {
    setWalletSettings(next);
    savePaymentSettings(next);
  }, []);

  const openWalletPicker = useCallback(() => {
    setWalletFocusIndex(0);
    setWalletSettings(loadPaymentSettings());
    setShowWalletPicker(true);
    // Wallet UI disabled — Stripe billing pending.
    setWalletDisplayInfo({ address: null, ethBalance: null, usdcBalance: null });
  }, []);

  const toggleProviderEnabled = useCallback(
    (provider: ProviderId) => {
      setDisabledProvidersState((prev) => {
        const isDisabled = prev.includes(provider);
        const next = setProviderDisabled(provider, !isDisabled);
        return next;
      });
      setModelPickerIndex(0);
    },
    [setModelPickerIndex, setDisabledProvidersState],
  );

  const setAsDefaultProvider = useCallback(
    (provider: ProviderId) => {
      // Disabled providers cannot be default — router would just skip them.
      if (disabledProviders.includes(provider)) return;
      const pickModel = (id: ProviderId): string | null => {
        for (const tier of ["balanced", "fast", "premium"] as const) {
          const m = getModelByTier(tier, id);
          if (m && m.provider === id) return m.id;
        }
        const fallback = getModelsForProvider(id);
        return fallback[0]?.id ?? null;
      };
      const modelId = pickModel(provider);
      if (!modelId) return;
      setDefaultProvider(provider);
      setDefaultProviderState(provider);
      agent.setModel(modelId);
      setModel(modelId);
      statusBarStore.setState({ model: modelId, provider });
      saveProjectSettings({ model: modelId });
      saveUserSettings({ defaultModel: modelId, defaultProvider: provider });
    },
    [agent, disabledProviders, setDefaultProviderState, setModel],
  );

  const toggleModelDisabled = useCallback(
    (modelId: string) => {
      const disabled = isModelDisabled(modelId);
      const next = setModelDisabled(modelId, !disabled);
      setDisabledModelsState(next);
    },
    [setDisabledModelsState],
  );

  const setReasoningEfforts = useCallback(
    (next: Record<string, ReasoningEffort>) => {
      setReasoningEffortByModel(next);
      saveUserSettings({ reasoningEffortByModel: next });
    },
    [setReasoningEffortByModel],
  );

  const replacePasteBlocks = useCallback((next: PasteBlock[]) => {
    pasteBlocksRef.current = next;
    setPasteBlocks(next);
  }, []);

  const getModelReasoningEffort = useCallback(
    (modelId: string): ReasoningEffort | undefined => {
      const normalizedModelId = normalizeModelId(modelId);
      return getEffectiveReasoningEffort(normalizedModelId, reasoningEffortByModel[normalizedModelId]);
    },
    [reasoningEffortByModel],
  );

  const adjustModelReasoningEffort = useCallback(
    (modelId: string, direction: -1 | 1) => {
      const normalizedModelId = normalizeModelId(modelId);
      const supported = getSupportedReasoningEfforts(normalizedModelId);
      if (supported.length === 0) return;

      const current = getModelReasoningEffort(normalizedModelId);

      if (!current) {
        if (direction > 0) {
          setReasoningEfforts({ ...reasoningEffortByModel, [normalizedModelId]: supported[0] });
        }
        return;
      }

      const currentIndex = supported.indexOf(current);
      if (direction < 0 && currentIndex <= 0) {
        const { [normalizedModelId]: _, ...rest } = reasoningEffortByModel;
        setReasoningEfforts(rest);
      } else {
        const nextIndex = direction < 0 ? currentIndex - 1 : Math.min(supported.length - 1, currentIndex + 1);
        setReasoningEfforts({ ...reasoningEffortByModel, [normalizedModelId]: supported[nextIndex] });
      }
    },
    [getModelReasoningEffort, reasoningEffortByModel, setReasoningEfforts],
  );

  const snapshotMcpEditorDraft = useCallback((): McpEditorDraft => {
    return {
      ...mcpEditorDraft,
      label: mcpLabelRef.current?.plainText ?? mcpEditorDraft.label,
      url: mcpUrlRef.current?.plainText ?? mcpEditorDraft.url,
      headersText: mcpHeadersRef.current?.plainText ?? mcpEditorDraft.headersText,
      command: mcpCommandRef.current?.plainText ?? mcpEditorDraft.command,
      argsText: mcpArgsRef.current?.plainText ?? mcpEditorDraft.argsText,
      cwd: mcpCwdRef.current?.plainText ?? mcpEditorDraft.cwd,
      envText: mcpEnvRef.current?.plainText ?? mcpEditorDraft.envText,
    };
  }, [mcpEditorDraft]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: all setters are stable useState setters from useMcpEditor hook
  const openMcpModal = useCallback(() => {
    const latest = loadMcpServers();
    setMcpServers(latest);
    setMcpSearchQuery("");
    setMcpModalIndex(0);
    setShowMcpModal(true);
    setShowMcpEditor(false);
    setEditingMcpId(null);
    setMcpEditorError(null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: all setters are stable useState setters from useMcpEditor hook
  const openMcpEditor = useCallback((draft: McpEditorDraft, editingId: string | null = null) => {
    setMcpEditorDraft(draft);
    setEditingMcpId(editingId);
    setMcpEditorField("transport");
    setMcpEditorError(null);
    setMcpEditorSyncKey((n) => n + 1);
    setShowMcpEditor(true);
    setShowMcpModal(true);
  }, []);

  const openCatalogMcp = useCallback(
    (entry: (typeof POPULAR_MCP_CATALOG)[number]) => {
      const existing = mcpServers.find((server) => toMcpServerId(server.id) === toMcpServerId(entry.id));
      if (existing) {
        openMcpEditor(
          {
            label: existing.label,
            transport: existing.transport,
            url: existing.url ?? "",
            headersText: Object.entries(existing.headers ?? {})
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n"),
            command: existing.command ?? "",
            argsText: (existing.args ?? []).join("\n"),
            cwd: existing.cwd ?? "",
            envText: Object.entries(existing.env ?? {})
              .map(([key, value]) => `${key}=${value}`)
              .join("\n"),
          },
          existing.id,
        );
        return;
      }
      openMcpEditor({
        ...createEmptyMcpEditorDraft(),
        label: entry.name,
        transport: entry.starterTransport ?? "stdio",
      });
    },
    [mcpServers, openMcpEditor],
  );

  const editSavedMcp = useCallback(
    (server: McpServerConfig) => {
      openMcpEditor(
        {
          label: server.label,
          transport: server.transport,
          url: server.url ?? "",
          headersText: Object.entries(server.headers ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n"),
          command: server.command ?? "",
          argsText: (server.args ?? []).join("\n"),
          cwd: server.cwd ?? "",
          envText: Object.entries(server.env ?? {})
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
        },
        server.id,
      );
    },
    [openMcpEditor],
  );

  const toggleSavedMcp = useCallback(
    (server: McpServerConfig) => {
      syncStoredMcpServers(
        mcpServers.map((item) => (item.id === server.id ? { ...item, enabled: !item.enabled } : item)),
      );
    },
    [mcpServers, syncStoredMcpServers],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: setMcpModalIndex is a stable useState setter from useMcpEditor hook
  const deleteSavedMcp = useCallback(
    (server: McpServerConfig) => {
      syncStoredMcpServers(mcpServers.filter((item) => item.id !== server.id));
      setMcpModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, mcpRows.length - 2))));
    },
    [mcpRows.length, mcpServers, syncStoredMcpServers],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: all setters are stable useState setters from useAgentEditor hook
  const openAgentsModal = useCallback(() => {
    setSubAgents(loadValidSubAgents());
    setAgentsSearchQuery("");
    setAgentsModalIndex(0);
    setEditingSubagent(null);
    setAgentsEditorError(null);
    setShowAgentsEditor(false);
    setShowAgentsModal(true);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: all setters are stable useState setters from useAgentEditor hook
  const openScheduleModal = useCallback(() => {
    void agent
      .listSchedules()
      .then((latest) => {
        setSchedules(latest);
        setScheduleSearchQuery("");
        setScheduleModalIndex(0);
        setShowScheduleModal(true);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [...prev, buildAssistantEntry(`Failed to load schedules: ${message}`)]);
      });
  }, [agent]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setMessages is stable, setScheduleModalIndex is stable useState setter from useAgentEditor hook
  const showScheduleDetails = useCallback(
    (schedule: StoredSchedule) => {
      void agent
        .getScheduleDaemonStatus()
        .then((status) => {
          setMessages((prev) => [...prev, buildAssistantEntry(formatScheduleDetails(schedule, status))]);
          setShowScheduleModal(false);
          setScheduleSearchQuery("");
          setTimeout(scrollToBottomForced, 10);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) => [...prev, buildAssistantEntry(`Failed to load schedule details: ${message}`)]);
        });
    },
    [agent, scrollToBottomForced],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: setSchedules is stable useState setter from useAgentEditor hook
  const removeSchedule = useCallback(
    (schedule: StoredSchedule) => {
      void agent
        .removeSchedule(schedule.id)
        .then(async (message) => {
          const latest = await agent.listSchedules();
          setSchedules(latest);
          setScheduleModalIndex((index) => Math.max(0, Math.min(index, Math.max(0, latest.length - 1))));
          setMessages((prev) => [...prev, buildAssistantEntry(message)]);
          setTimeout(scrollToBottomForced, 10);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) => [...prev, buildAssistantEntry(`Failed to remove schedule: ${message}`)]);
        });
    },
    [agent, scrollToBottomForced],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: all setters are stable useState setters from useAgentEditor hook
  const openSubagentEditor = useCallback((agent: CustomSubagentConfig | null) => {
    setEditingSubagent(agent);
    if (agent) {
      setAgentsEditorDraft({ name: agent.name, instruction: agent.instruction });
      setAgentsEditorModelIndex(
        Math.max(
          0,
          MODELS.findIndex((model) => model.id === normalizeModelId(agent.model)),
        ),
      );
    } else {
      setAgentsEditorDraft({ name: "", instruction: "" });
      setAgentsEditorModelIndex(
        Math.max(
          0,
          MODELS.findIndex((model) => model.id === DEFAULT_MODEL),
        ),
      );
    }
    setAgentsEditorField("name");
    setAgentsEditorError(null);
    setAgentsEditorSyncKey((n) => n + 1);
    setShowAgentsEditor(true);
    setShowAgentsModal(true);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: all setters are stable useState setters from useAgentEditor hook
  const submitSubagentEditor = useCallback(() => {
    const name = (subagentNameRef.current?.plainText || "").trim();
    const instruction = subagentInstructionRef.current?.plainText || "";
    const model = MODELS[agentsEditorModelIndex]?.id;

    if (!name) {
      setAgentsEditorError("Name is required.");
      return;
    }
    if (isReservedSubagentName(name)) {
      setAgentsEditorError('Names "general" and "explore" are reserved.');
      return;
    }
    if (!model || !getModelIds().includes(model)) {
      setAgentsEditorError("Pick a valid model.");
      return;
    }

    const next = [...subAgents];
    if (editingSubagent) {
      const index = next.findIndex((item) => item.name === editingSubagent.name);
      if (index >= 0) next.splice(index, 1);
    }

    if (next.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      setAgentsEditorError("Another sub-agent already uses this name.");
      return;
    }

    next.push({ name, model, instruction });
    saveUserSettings({ subAgents: next });
    setSubAgents(loadValidSubAgents());
    setShowAgentsEditor(false);
    setEditingSubagent(null);
    setAgentsEditorError(null);
  }, [agentsEditorModelIndex, editingSubagent, subAgents]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setters from useAgentEditor are stable useState setters
  const removeEditingSubagent = useCallback(() => {
    if (!editingSubagent) return;

    const next = subAgents.filter((item) => item.name !== editingSubagent.name);
    saveUserSettings({ subAgents: next });
    setSubAgents(loadValidSubAgents());
    setShowAgentsEditor(false);
    setEditingSubagent(null);
    setAgentsEditorError(null);
    setAgentsModalIndex(0);
  }, [editingSubagent, subAgents]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setters from useMcpEditor are stable useState setters
  const submitMcpEditor = useCallback(() => {
    const draft: McpEditorDraft = {
      label: mcpLabelRef.current?.plainText || "",
      transport: mcpEditorDraft.transport,
      url: mcpUrlRef.current?.plainText || "",
      headersText: mcpHeadersRef.current?.plainText || "",
      command: mcpCommandRef.current?.plainText || "",
      argsText: mcpArgsRef.current?.plainText || "",
      cwd: mcpCwdRef.current?.plainText || "",
      envText: mcpEnvRef.current?.plainText || "",
    };

    const baseId = toMcpServerId(draft.label);
    const currentServers = loadMcpServers();

    const conflictingServer = currentServers.find((s) => s.id === baseId && s.id !== editingMcpId);
    if (conflictingServer) {
      setMcpEditorError(`Only one protocol is supported per MCP. Edit "${conflictingServer.label}" instead.`);
      return;
    }

    const id = editingMcpId ?? baseId;

    const server: McpServerConfig = {
      id,
      label: draft.label.trim(),
      enabled: true,
      transport: draft.transport,
      ...(draft.transport === "stdio"
        ? {
            command: draft.command.trim(),
            args: draft.argsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: draft.cwd.trim() || undefined,
            env: Object.keys(parseEnvLines(draft.envText)).length ? parseEnvLines(draft.envText) : undefined,
          }
        : {
            url: draft.url.trim(),
            headers: Object.keys(parseHeaderLines(draft.headersText)).length
              ? parseHeaderLines(draft.headersText)
              : undefined,
            env: Object.keys(parseEnvLines(draft.envText)).length ? parseEnvLines(draft.envText) : undefined,
          }),
    };

    const validation = validateMcpServerConfig(server);
    if (!validation.ok) {
      setMcpEditorError(validation.error);
      return;
    }

    const nextServers = editingMcpId
      ? currentServers.map((item) =>
          item.id === editingMcpId ? { ...server, id: editingMcpId, enabled: item.enabled } : item,
        )
      : [...currentServers, server];
    saveMcpServers(nextServers);
    setMcpServers(nextServers);
    setShowMcpEditor(false);
    setEditingMcpId(null);
    setMcpEditorError(null);
    setMcpSearchQuery("");
    setMcpModalIndex(
      Math.max(
        0,
        nextServers.findIndex((item) => item.id === (editingMcpId ?? server.id)),
      ),
    );
  }, [editingMcpId, mcpEditorDraft.transport]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setters from useMcpEditor are stable useState setters
  const cycleMcpEditorTransport = useCallback(
    (direction: 1 | -1 = 1) => {
      const draft = snapshotMcpEditorDraft();
      const order: Array<McpRemoteTransport | "stdio"> = ["stdio", "http", "sse"];
      const currentIndex = order.indexOf(draft.transport);
      const nextTransport = order[(currentIndex + direction + order.length) % order.length];
      const nextDraft = { ...draft, transport: nextTransport };
      setMcpEditorDraft(nextDraft);
      setMcpEditorField("transport");
      setMcpEditorSyncKey((n) => n + 1);

      if (!editingMcpId) return;

      const existing = mcpServers.find((server) => server.id === editingMcpId);
      if (!existing) return;

      const optimisticServer: McpServerConfig = {
        id: existing.id,
        label: nextDraft.label.trim() || existing.label,
        enabled: existing.enabled,
        transport: nextTransport,
        ...(nextTransport === "stdio"
          ? {
              command: nextDraft.command.trim() || existing.command,
              args: nextDraft.argsText
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
              cwd: nextDraft.cwd.trim() || undefined,
              env: Object.keys(parseEnvLines(nextDraft.envText)).length ? parseEnvLines(nextDraft.envText) : undefined,
            }
          : {
              url: nextDraft.url.trim() || existing.url,
              headers: Object.keys(parseHeaderLines(nextDraft.headersText)).length
                ? parseHeaderLines(nextDraft.headersText)
                : undefined,
              env: Object.keys(parseEnvLines(nextDraft.envText)).length ? parseEnvLines(nextDraft.envText) : undefined,
            }),
      };

      syncStoredMcpServers(mcpServers.map((server) => (server.id === editingMcpId ? optimisticServer : server)));
    },
    [editingMcpId, mcpServers, snapshotMcpEditorDraft, syncStoredMcpServers],
  );

  useEffect(() => {
    if (!showMcpEditor || !editingMcpId) return;

    const existing = mcpServers.find((server) => server.id === editingMcpId);
    if (!existing) return;
    if (existing.transport === mcpEditorDraft.transport) return;

    const syncedServer: McpServerConfig = {
      id: existing.id,
      label: mcpEditorDraft.label.trim() || existing.label,
      enabled: existing.enabled,
      transport: mcpEditorDraft.transport,
      ...(mcpEditorDraft.transport === "stdio"
        ? {
            command: mcpEditorDraft.command.trim() || undefined,
            args: mcpEditorDraft.argsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: mcpEditorDraft.cwd.trim() || undefined,
            env: Object.keys(parseEnvLines(mcpEditorDraft.envText)).length
              ? parseEnvLines(mcpEditorDraft.envText)
              : undefined,
          }
        : {
            url: mcpEditorDraft.url.trim() || undefined,
            headers: Object.keys(parseHeaderLines(mcpEditorDraft.headersText)).length
              ? parseHeaderLines(mcpEditorDraft.headersText)
              : undefined,
            env: Object.keys(parseEnvLines(mcpEditorDraft.envText)).length
              ? parseEnvLines(mcpEditorDraft.envText)
              : undefined,
          }),
    };

    syncStoredMcpServers(mcpServers.map((server) => (server.id === editingMcpId ? syncedServer : server)));
  }, [editingMcpId, mcpEditorDraft, mcpServers, showMcpEditor, syncStoredMcpServers]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setMcpModalIndex is a stable useState setter from useMcpEditor hook
  useEffect(() => {
    setMcpModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, mcpRows.length - 1))));
  }, [mcpRows.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setScheduleModalIndex is a stable useState setter from useAgentEditor hook
  useEffect(() => {
    setScheduleModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, scheduleRows.length - 1))));
  }, [scheduleRows.length]);

  const clearLiveTurnUi = useCallback(() => {
    setStreamContent("");
    setReasoningActive(false);
    setLastReasoningElapsedMs(0);
    reasoningStartRef.current = null;
    setStreamReasoning("");
    reasoningAccRef.current = "";
    lastReasoningRenderTimeRef.current = 0;
    setActiveToolCalls([]);
    setActiveSubagent(null);
    setLiveTurnSourceLabel(null);
    contentAccRef.current = "";
    // Collapse the ephemeral council transcript to the persisted [Council
    // Decision] message on every turn end. These three arrays are append-only
    // and rendered as a block BELOW the timestamp-sorted messages list, so
    // leaving them populated makes a later message render ABOVE the stale
    // council block (looks "swallowed"). Synthesis is persisted independently,
    // so clearing here loses nothing. Covers auto-council + slash paths.
    setCouncilMessages([]);
    setCouncilInfoCards([]);
    setCouncilMeta({});
    setCouncilRounds([]);
    setSelectedRound(null);
    setCouncilPlaceholders(new Map());
    // The auto-council path drives councilPhases through the MAIN stream loop,
    // which — unlike the nested /council and /ideal loops — never reset it on
    // turn end. On a hung/watchdog-aborted council turn the running phase never
    // emits its `state:"done"` event, so <CouncilPhaseTimeline> stays frozen at
    // "Council working… elapsed Ns" forever and the session LOOKS hung even after
    // the turn actually finalized (live: reasoning-model hang c1d461439618).
    // Clearing here (called at both beginLiveTurn and finalizeActiveTurn) tears
    // the timeline down on every turn boundary. The completed phases were already
    // rendered live; the persisted [Council Decision] message is the durable record.
    setCouncilPhases([]);
    councilTopicRef.current = undefined;
  }, []);

  const finishTurnProcessing = useCallback(() => {
    const nextQueued = queuedMessagesRef.current.shift();
    if (nextQueued) {
      setQueuedMessages(queuedMessagesRef.current.map((msg) => msg.displayText));
      // Set isProcessingRef.current = false before calling processMessageRef.current
      // so it doesn't get blocked by the early return guard at the start of processMessage.
      // Since Javascript is single-threaded, this synchronous reset is safe and
      // won't create a race condition window for other inputs.
      isProcessingRef.current = false;
      void processMessageRef.current(nextQueued.text, nextQueued.displayText);
      return;
    }

    isProcessingRef.current = false;
    setIsProcessing(false);
  }, []);

  const beginLiveTurn = useCallback(
    (turn: Omit<ActiveTurnState, "latestAssistantText" | "flushedAssistantChars">) => {
      clearLiveTurnUi();
      activeTurnRef.current = {
        ...turn,
        latestAssistantText: "",
        flushedAssistantChars: 0,
      };
      isProcessingRef.current = true;
      setIsProcessing(true);
      setLiveTurnSourceLabel(turn.sourceLabel ?? null);
      startTimeRef.current = Date.now();
    },
    [clearLiveTurnUi],
  );

  const flushPendingAssistantMessage = useCallback(() => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn) return;

    const cleaned = sanitizeContent(contentAccRef.current);
    if (!cleaned) {
      contentAccRef.current = "";
      setStreamContent("");
      if (activeTurn.kind === "telegram") {
        activeTurn.flushedAssistantChars = activeTurn.latestAssistantText.length;
      }
      return;
    }

    setMessages((prev) => [
      ...prev,
      buildAssistantEntry(cleaned, {
        modeColor: activeTurn.modeColor,
        remoteKey: activeTurn.remoteKey,
        sourceLabel: activeTurn.sourceLabel,
        reasoning: reasoningAccRef.current || undefined,
      }),
    ]);

    if (activeTurn.kind === "telegram") {
      activeTurn.flushedAssistantChars = activeTurn.latestAssistantText.length;
    }

    contentAccRef.current = "";
    setStreamContent("");
    setStreamReasoning("");
    reasoningAccRef.current = "";
    lastReasoningRenderTimeRef.current = 0;
  }, []);

  // Close the in-progress ToolGroup (if any) and stamp it as done / failed.
  // Declared before applyLocalAssistantDelta so the latter can use it.
  const closeCurrentToolGroup = useCallback(() => {
    const groupId = currentToolGroupIdRef.current;
    if (!groupId) return;
    currentToolGroupIdRef.current = null;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.type !== "tool_group" || m.toolGroup?.id !== groupId) return m;
        const failed = m.toolGroup.items.some((it) => it.failed);
        return {
          ...m,
          toolGroup: {
            ...m.toolGroup,
            state: failed ? "failed" : "done",
            finishedAt: Date.now(),
          },
        };
      }),
    );
  }, []);

  const lastFlushRef = useRef<number>(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushContent = useCallback(() => {
    setStreamContent(sanitizeContent(contentAccRef.current));
    lastFlushRef.current = Date.now();
    setTimeout(scrollToBottom, 10);
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, [scrollToBottom]);

  const applyLocalAssistantDelta = useCallback(
    (delta: string) => {
      // First non-empty assistant text after a tool streak ends that streak —
      // mirrors Claude Code's "Done (N tool uses · ...)" collapse moment.
      if (delta && currentToolGroupIdRef.current) {
        closeCurrentToolGroup();
      }
      contentAccRef.current += delta;

      const now = Date.now();
      if (now - lastFlushRef.current > 32) {
        flushContent();
      } else if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushContent, 32);
      }
    },
    [closeCurrentToolGroup, flushContent],
  );

  const applyTelegramAssistantPreview = useCallback(
    (fullContent: string) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn || activeTurn.kind !== "telegram") return;

      activeTurn.latestAssistantText = fullContent;
      contentAccRef.current = getUnflushedTelegramAssistantContent(fullContent, activeTurn.flushedAssistantChars);

      const now = Date.now();
      if (now - lastFlushRef.current > 32) {
        flushContent();
      } else if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushContent, 32);
      }
    },
    [flushContent],
  );

  const showLiveToolCalls = useCallback(
    (toolCalls: ToolCall[]) => {
      flushPendingAssistantMessage();
      const activeTurn = activeTurnRef.current;
      if (!activeTurn || toolCalls.length === 0) {
        setActiveToolCalls(toolCalls);
        setTimeout(scrollToBottom, 10);
        return;
      }
      // Lazy-open: first tool of a streak creates the group entry; subsequent
      // tool_calls in the same streak are appended in place keyed on id.
      setMessages((prev) => {
        let groupId = currentToolGroupIdRef.current;
        let next = prev;
        if (!groupId) {
          const entry = buildToolGroupEntry({
            modeColor: activeTurn.modeColor,
            remoteKey: activeTurn.remoteKey,
            sourceLabel: activeTurn.sourceLabel,
          });
          groupId = entry.toolGroup!.id;
          currentToolGroupIdRef.current = groupId;
          next = [...prev, entry];
        }
        return next.map((m) => {
          if (m.type !== "tool_group" || m.toolGroup?.id !== groupId) return m;
          const knownIds = new Set(m.toolGroup.items.map((it) => it.toolCall.id));
          const additions = toolCalls
            .filter((tc) => !knownIds.has(tc.id))
            .map((tc) => ({ toolCall: tc, startedAt: Date.now() }));
          if (additions.length === 0) return m;
          return { ...m, toolGroup: { ...m.toolGroup, items: [...m.toolGroup.items, ...additions] } };
        });
      });
      // Keep the legacy ephemeral panel populated as a fallback for code paths
      // (e.g. accessibility, harness queries) that still read activeToolCalls.
      setActiveToolCalls(toolCalls);
      setTimeout(scrollToBottom, 10);
    },
    [flushPendingAssistantMessage, scrollToBottom],
  );

  const appendLiveToolResult = useCallback(
    (toolCall: ToolCall, toolResult: ToolResult) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn) return;

      const groupId = currentToolGroupIdRef.current;
      if (groupId) {
        // Update the matching item in the active group. If the item is missing
        // (tool_result arrived before tool_call — rare race), append it.
        setMessages((prev) =>
          prev.map((m) => {
            if (m.type !== "tool_group" || m.toolGroup?.id !== groupId) return m;
            const failed = !toolResult.success;
            const finishedAt = Date.now();
            let touched = false;
            const items = m.toolGroup.items.map((it) => {
              if (it.toolCall.id !== toolCall.id) return it;
              touched = true;
              return { ...it, result: toolResult, finishedAt, failed };
            });
            if (!touched) {
              items.push({ toolCall, result: toolResult, startedAt: finishedAt, finishedAt, failed });
            }
            return { ...m, toolGroup: { ...m.toolGroup, items } };
          }),
        );
      } else {
        // Fallback: no active group (e.g. legacy code path) — preserve the
        // pre-grouping behaviour so headless / non-TUI consumers see results.
        setMessages((prev) => [
          ...prev,
          buildToolResultEntry(toolCall, toolResult, {
            modeColor: activeTurn.modeColor,
            remoteKey: activeTurn.remoteKey,
            sourceLabel: activeTurn.sourceLabel,
          }),
        ]);
      }

      if (toolResult.plan?.questions?.length) {
        setActivePlan(toolResult.plan);
        setPqs(initialPlanQuestionsState());
      }

      setActiveToolCalls([]);
      setTimeout(scrollToBottom, 10);
    },
    [scrollToBottom],
  );

  const syncTelegramTurnEntries = useCallback((activeTurn: ActiveTurnState) => {
    if (activeTurn.kind !== "telegram" || activeTurn.userId === undefined || !activeTurn.remoteKey) return;

    const currentEntries = activeTurn.agent.getChatEntries();
    const syncedCount = telegramEntryCountsRef.current.get(activeTurn.userId) ?? 0;
    if (currentEntries.length <= syncedCount) return;

    const delta = decorateTelegramEntries(currentEntries.slice(syncedCount), activeTurn.userId, activeTurn.remoteKey);
    telegramEntryCountsRef.current.set(activeTurn.userId, currentEntries.length);
    setMessages((prev) => replaceTurnEntries(prev, activeTurn.remoteKey!, delta));
  }, []);

  // Register the tool-loop cap handler. The orchestrator calls this when
  // stepCount reaches the cap or a repetition pattern fires. Previously this
  // surfaced an askcard; now the agent is trusted to self-regulate — we auto-
  // resolve so the session is never interrupted by a blocking user prompt.
  //   • pattern kind → always "continue": the single-shot pattern guard already
  //     fires only once per session, so auto-continuing lets the agent keep going
  //     (the cap guard is still in place as the ultimate hard stop).
  //   • cap kind → always "stop": hard cap reached, return the best answer.
  // All auto-resolutions are logged to the audit trail so sessions can be reviewed.
  useEffect(() => {
    agent.setToolLoopCapHandler(async (info) => {
      const isPattern = info.kind === "pattern";
      const qid = isPattern ? `tool-pattern-loop-${Date.now()}` : `tool-loop-cap-${info.stepNumber}-${Date.now()}`;
      const verdict: "continue" | "stop" = isPattern ? "continue" : "stop";
      // Audit log — keep the trail so sessions are still reviewable.
      try {
        const patternInfo = isPattern ? (info as { toolName: string; count: number; naturalCeiling?: number }) : null;
        const capInfo = !isPattern ? (info as { cap: number }) : null;
        logUIInteraction(agent.getSessionId() ?? undefined, {
          subtype: "loop_cap_auto",
          data: {
            questionId: qid,
            phase: "tool-loop-cap",
            autoVerdict: verdict,
            kind: info.kind,
            stepNumber: info.stepNumber,
            ...(patternInfo
              ? {
                  toolName: patternInfo.toolName,
                  count: patternInfo.count,
                  naturalCeiling: patternInfo.naturalCeiling ?? null,
                }
              : { cap: capInfo!.cap }),
          },
        });
      } catch {
        /* best-effort */
      }
      return verdict;
    });
    return () => {
      agent.setToolLoopCapHandler(null);
      toolLoopCapResolversRef.current.clear();
    };
  }, [agent]);

  // Safety-override askcard handler. When bash.execute blocks a command,
  // the message-processor calls askSafetyOverride. We surface a council-style
  // askcard with Allow-once / Allow-session / Block options.
  useEffect(() => {
    agent.setSafetyOverrideHandler(async (info: SafetyOverrideAskInfo) => {
      const layout = planSafetyAskcard({
        kind: info.kind,
        blockedItem: info.blockedItem,
        reason: info.reason,
      });
      return new Promise<SafetyOverrideVerdict>((resolve) => {
        const qid = `safety-override-${Date.now()}`;
        safetyOverrideResolversRef.current.set(qid, resolve);
        const question: CouncilQuestionData = {
          questionId: qid,
          question: layout.question,
          context: layout.detail,
          isRequired: true,
          phase: "safety-override",
          options: layout.options.map((o) => ({
            label: o.label,
            value: o.value,
            kind: "choice" as const,
            description: o.description,
          })),
          defaultIndex: layout.defaultIndex,
        };
        setPendingCouncilQuestionSync(question);
        setCouncilCardStateSync(initialCardState(question));
        try {
          agentRuntime?.emitEvent({
            t: "event",
            kind: "askcard-open",
            questionId: qid,
            question: question.question,
            phase: "safety-override",
            optionCount: question.options!.length,
            defaultIndex: question.defaultIndex ?? 0,
          });
        } catch {
          /* best-effort */
        }
      });
    });
    return () => {
      agent.setSafetyOverrideHandler(null);
      safetyOverrideResolversRef.current.clear();
    };
  }, [agent, setPendingCouncilQuestionSync, setCouncilCardStateSync]);

  // ask_user handler — surfaces an AGENT-authored card (question + options come
  // ONLY from the model's tool input; the CLI synthesises nothing) and blocks
  // until the human answers or dismisses. The resolved string becomes the tool
  // result the agent reads to decide its next step.
  useEffect(() => {
    agent.setAskUserHandler(async (info: AskUserAskInfo) => {
      return new Promise<string>((resolve) => {
        const qid = `ask-user-${Date.now()}`;
        askUserResolversRef.current.set(qid, resolve);
        const question = buildAskUserQuestion(info, qid);
        setPendingCouncilQuestionSync(question);
        setCouncilCardStateSync(initialCardState(question));
        try {
          agentRuntime?.emitEvent({
            t: "event",
            kind: "askcard-open",
            questionId: qid,
            question: question.question,
            phase: "ask-user",
            optionCount: question.options?.length ?? 0,
            defaultIndex: question.defaultIndex ?? 0,
          });
        } catch {
          /* best-effort */
        }
      });
    });
    return () => {
      agent.setAskUserHandler(null);
      askUserResolversRef.current.clear();
    };
  }, [agent, setPendingCouncilQuestionSync, setCouncilCardStateSync]);

  const finalizeActiveTurn = useCallback(
    ({ wasInterrupted = false, hadError = false }: { wasInterrupted?: boolean; hadError?: boolean } = {}) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn) {
        finishTurnProcessing();
        return;
      }

      const finalContent = sanitizeContent(contentAccRef.current);
      if (!wasInterrupted && finalContent) {
        setMessages((prev) => [
          ...prev,
          buildAssistantEntry(finalContent, {
            modeColor: activeTurn.modeColor,
            remoteKey: activeTurn.remoteKey,
            sourceLabel: activeTurn.sourceLabel,
          }),
        ]);
      }

      if (!wasInterrupted && !hadError) {
        if (activeTurn.kind === "local" && activeTurn.agent.getSessionId()) {
          setMessages((prev) => {
            const fresh = activeTurn.agent.getChatEntries();
            let prevUserIdx = 0;
            for (let i = 0; i < fresh.length; i++) {
              if (fresh[i]!.type !== "user") continue;
              while (prevUserIdx < prev.length && prev[prevUserIdx]!.type !== "user") prevUserIdx++;
              if (prevUserIdx < prev.length) {
                fresh[i] = { ...fresh[i]!, content: prev[prevUserIdx]!.content };
                prevUserIdx++;
              }
            }
            return fresh;
          });
          setSessionTitle(activeTurn.agent.getSessionTitle());
          setSessionId(activeTurn.agent.getSessionId());
        } else if (activeTurn.kind === "telegram") {
          syncTelegramTurnEntries(activeTurn);
        }
      }

      activeTurnRef.current = null;
      clearLiveTurnUi();
      finishTurnProcessing();
      setTimeout(scrollToBottom, 50);
    },
    [clearLiveTurnUi, finishTurnProcessing, scrollToBottom, syncTelegramTurnEntries],
  );

  const wireTelegramAgentUi = useCallback((userId: number, telegramAgent: Agent) => {
    if (!telegramEntryCountsRef.current.has(userId)) {
      telegramEntryCountsRef.current.set(userId, telegramAgent.getChatEntries().length);
    }

    if (telegramSubagentUnsubsRef.current.has(userId)) {
      return;
    }

    const unsubscribe = telegramAgent.onSubagentStatus((status) => {
      if (activeTurnRef.current?.agent !== telegramAgent) return;
      setActiveSubagent(status);
    });
    telegramSubagentUnsubsRef.current.set(userId, unsubscribe);
  }, []);

  const getTelegramAgent = useCallback(
    (userId: number) => {
      const map = telegramAgentsRef.current;
      const existing = map.get(userId);
      if (existing) {
        wireTelegramAgentUi(userId, existing);
        return existing;
      }

      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error("API key required. Set MUONROI_API_KEY or add via CLI.");
      }

      const u = loadUserSettings();
      const sid = u.telegram?.sessionsByUserId?.[String(userId)];
      const a = new Agent(apiKey, startupConfig.baseURL, startupConfig.model, startupConfig.maxToolRounds, {
        session: sid,
        sandboxMode,
        sandboxSettings,
      });
      if (!sid && a.getSessionId()) {
        saveUserSettings({
          telegram: {
            ...u.telegram,
            sessionsByUserId: {
              ...u.telegram?.sessionsByUserId,
              [String(userId)]: a.getSessionId()!,
            },
          },
        });
      }
      wireTelegramAgentUi(userId, a);
      map.set(userId, a);
      return a;
    },
    [sandboxMode, sandboxSettings, startupConfig, wireTelegramAgentUi],
  );

  const appendTelegramUserMessage = useCallback(
    (event: { turnKey: string; userId: number; content: string }) => {
      const telegramAgent = getTelegramAgent(event.userId);
      beginLiveTurn({
        kind: "telegram",
        agent: telegramAgent,
        remoteKey: event.turnKey,
        userId: event.userId,
        sourceLabel: getTelegramSourceLabel("assistant", event.userId),
      });
      setMessages((prev) => [
        ...prev,
        buildUserEntry(event.content, {
          remoteKey: event.turnKey,
          sourceLabel: getTelegramSourceLabel("user", event.userId),
        }),
      ]);
      setTimeout(scrollToBottom, 10);
    },
    [beginLiveTurn, getTelegramAgent, scrollToBottom],
  );

  const upsertTelegramAssistantMessage = useCallback(
    (event: { turnKey: string; userId: number; content: string; done: boolean }) => {
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }

      applyTelegramAssistantPreview(event.content);
      if (event.done) {
        finalizeActiveTurn();
      }
    },
    [applyTelegramAssistantPreview, beginLiveTurn, finalizeActiveTurn, getTelegramAgent],
  );

  const showTelegramToolCalls = useCallback(
    (event: { turnKey: string; userId: number; toolCalls: ToolCall[] }) => {
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }
      showLiveToolCalls(event.toolCalls);
    },
    [beginLiveTurn, getTelegramAgent, showLiveToolCalls],
  );

  const appendTelegramToolResult = useCallback(
    (event: { turnKey: string; userId: number; toolCall: ToolCall; toolResult: ToolResult }) => {
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }
      appendLiveToolResult(event.toolCall, event.toolResult);
    },
    [appendLiveToolResult, beginLiveTurn, getTelegramAgent],
  );

  const startTelegramBridge = useCallback(() => {
    const token = getTelegramBotToken();
    if (!token || !getApiKey()) return;
    if (bridgeRef.current) return;

    const bridge = createTelegramBridge({
      token,
      getApprovedUserIds: () => loadUserSettings().telegram?.approvedUserIds ?? [],
      coordinator: coordinatorRef.current,
      getTelegramAgent,
      onUserMessage: appendTelegramUserMessage,
      onAssistantMessage: upsertTelegramAssistantMessage,
      onToolCalls: showTelegramToolCalls,
      onToolResult: appendTelegramToolResult,
      onError: (msg: string) => {
        setMessages((p) => [...p, { type: "assistant", content: `Telegram: ${msg}`, timestamp: new Date() }]);
      },
    });
    bridgeRef.current = bridge;
    bridge.start();
  }, [
    appendTelegramToolResult,
    appendTelegramUserMessage,
    getTelegramAgent,
    showTelegramToolCalls,
    upsertTelegramAssistantMessage,
  ]);

  /** Start long polling when a bot token is already saved (pairing UI is optional if already approved). */
  useEffect(() => {
    if (!hasApiKey) return;
    if (!getTelegramBotToken()) return;
    startTelegramBridge();
  }, [hasApiKey, startTelegramBridge]);

  const handleExit = useCallback(() => {
    // Best-effort EE session-end reconciliation (fire-and-forget)
    try {
      const { getDefaultEEClient: getEE, getLastSurfacedState: getSurfaced } = require("../ee/intercept.js");
      const { surfacedIds, timestamp } = getSurfaced();
      const ee = getEE();
      const cwd = agent.getCwd();

      // Prompt-stale: mark surfaced suggestions as stale on session end
      if (surfacedIds.length > 0) {
        ee.promptStale({
          state: { surfacedIds, timestamp },
          nextPromptMeta: { trigger: "session-end" as const, cwd, tenantId: "local" },
        }).catch(() => {});
      }
    } catch {
      // Swallow all errors — exit must never fail due to EE
    }

    void bridgeRef.current?.stop();
    bridgeRef.current = null;
    onExit?.();
  }, [onExit, agent]);

  const showCopyBanner = useCallback(() => {
    setCopyFlashId((n) => n + 1);
  }, []);

  /** Match OpenCode: OSC 52 + real OS clipboard; used from keyboard and root onMouseUp. */
  const copyTuiSelectionToHost = useCallback((): boolean => {
    if (!renderer.hasSelection) return false;
    const sel = renderer.getSelection();
    const text = sel ? getCompactTuiSelectionText(sel) : "";
    if (!text) return false;
    renderer.copyToClipboardOSC52(text);
    copyTextToHostClipboard(text);
    renderer.clearSelection();
    showCopyBanner();
    return true;
  }, [renderer, showCopyBanner]);

  // Double-click tracking: detect fast consecutive clicks at roughly the same
  // position and copy any terminal-level word selection (like Claude Code / Codex CLI).
  const lastClickRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });

  const handleRootMouseUp = useCallback(
    (event?: { button?: number; type?: string; x?: number; y?: number }) => {
      // Right-click semantics:
      //   - With selection → copy (same as left).
      //   - Without selection → paste clipboard text into the input buffer.
      // Left/middle-click keep the prior copy-on-release-with-selection behavior.
      const isRightClick = event?.button === 2;
      if (isRightClick) {
        const copied = copyTuiSelectionToHost();
        if (!copied) {
          const ta = inputRef.current;
          const text = readTextFromHostClipboard();
          if (ta && text) {
            const current = ta.plainText || "";
            const insertAt = typeof ta.cursorOffset === "number" ? ta.cursorOffset : current.length;
            const next = current.slice(0, insertAt) + text + current.slice(insertAt);
            ta.setText(next);
            try {
              ta.cursorOffset = insertAt + text.length;
            } catch {
              /* noop */
            }
          }
        }
        inputRef.current?.focus();
        return;
      }

      // Double-click detection: left-click within 400ms and within 5 cells of last click
      const now = Date.now();
      const ex = event?.x ?? -1;
      const ey = event?.y ?? -1;
      const last = lastClickRef.current;
      const isDoubleClick = now - last.time < 400 && Math.abs(ex - last.x) <= 5 && Math.abs(ey - last.y) <= 5;
      lastClickRef.current = { time: now, x: ex, y: ey };

      if (isDoubleClick) {
        // On double-click, the terminal emulator may select the word under cursor.
        // Give the terminal a tick to populate the selection, then copy.
        setTimeout(() => {
          copyTuiSelectionToHost();
        }, 10);
      } else {
        copyTuiSelectionToHost();
      }
      inputRef.current?.focus();
    },
    [copyTuiSelectionToHost],
  );

  const handleRootMouseDown = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (copyFlashId === 0) return;
    const id = setTimeout(() => setCopyFlashId(0), 2000);
    return () => clearTimeout(id);
  }, [copyFlashId]);

  const openApiKeyModal = useCallback(() => {
    showApiKeyModalRef.current = true;
    setApiKeyError(null);
    setShowApiKeyModal(true);
  }, []);

  const closeApiKeyModal = useCallback(() => {
    showApiKeyModalRef.current = false;
    setApiKeyError(null);
    setShowApiKeyModal(false);
  }, []);

  const submitApiKey = useCallback(() => {
    const apiKey = (apiKeyInputRef.current?.plainText || "").trim();
    if (!apiKey) {
      setApiKeyError("Enter an API key to continue.");
      return;
    }
    if (!apiKey.startsWith("xai-")) {
      setApiKeyError("API keys should start with xai-.");
      return;
    }

    saveUserSettings({ apiKey });
    agent.setApiKey(apiKey);
    hasApiKeyRef.current = true;
    showApiKeyModalRef.current = false;
    setHasApiKey(true);
    setApiKeyError(null);
    setShowApiKeyModal(false);
    apiKeyInputRef.current?.clear();
    if (getTelegramBotToken()) {
      startTelegramBridge();
    }
  }, [agent, startTelegramBridge]);

  useEffect(() => {
    hasApiKeyRef.current = hasApiKey;
  }, [hasApiKey]);

  useEffect(() => {
    showApiKeyModalRef.current = showApiKeyModal;
  }, [showApiKeyModal]);

  useEffect(() => {
    showConnectModalRef.current = showConnectModal;
  }, [showConnectModal]);
  useEffect(() => {
    showTelegramTokenModalRef.current = showTelegramTokenModal;
  }, [showTelegramTokenModal]);
  useEffect(() => {
    showTelegramPairModalRef.current = showTelegramPairModal;
  }, [showTelegramPairModal]);
  useEffect(() => {
    showMcpModalRef.current = showMcpModal;
  }, [showMcpModal]);
  useEffect(() => {
    showMcpEditorRef.current = showMcpEditor;
  }, [showMcpEditor]);
  useEffect(() => {
    showAgentsModalRef.current = showAgentsModal;
  }, [showAgentsModal]);
  useEffect(() => {
    showAgentsEditorRef.current = showAgentsEditor;
  }, [showAgentsEditor]);
  useEffect(() => {
    showScheduleModalRef.current = showScheduleModal;
  }, [showScheduleModal]);
  useEffect(() => {
    showUpdateModalRef.current = showUpdateModal;
  }, [showUpdateModal]);

  useEffect(() => {
    let cancelled = false;
    // Throttle the npm-registry check to once per day so we don't hammer it
    // every launch (and stay nice to free-tier registries / corporate proxies).
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const settings = loadUserSettings();
    const lastCheck = settings.lastUpdateCheck ?? 0;
    if (Date.now() - lastCheck < ONE_DAY_MS) return;

    checkForUpdate(startupConfig.version).then(async (result) => {
      if (cancelled) return;
      // Persist the attempt timestamp regardless of outcome (don't retry a
      // failed fetch dozens of times in one day).
      saveUserSettings({ lastUpdateCheck: Date.now() });
      if (!result?.hasUpdate) return;
      setUpdateInfo(result);
      // autoUpdate: skip the modal and just run the update silently.
      if (settings.autoUpdate === true) {
        try {
          await runUpdate(startupConfig.version);
        } catch {
          // Silent — surface in the modal as fallback.
          setShowUpdateModal(true);
        }
        return;
      }
      setShowUpdateModal(true);
    });
    return () => {
      cancelled = true;
    };
  }, [startupConfig.version]);

  useEffect(() => {
    return () => {
      void bridgeRef.current?.stop();
      bridgeRef.current = null;
    };
  }, []);

  const submitTelegramToken = useCallback(() => {
    const token = (telegramTokenInputRef.current?.plainText || "").trim();
    if (!token) {
      setTelegramTokenError("Paste your bot token from @BotFather.");
      return;
    }
    if (!getApiKey()) {
      setTelegramTokenError("Add an API key first.");
      return;
    }
    const u = loadUserSettings();
    saveUserSettings({ telegram: { ...u.telegram, botToken: token } });
    telegramTokenInputRef.current?.clear();
    setShowTelegramTokenModal(false);
    setTelegramTokenError(null);
    startTelegramBridge();
    setShowTelegramPairModal(true);
    setTelegramPairError(null);
    setMessages((p) => [
      ...p,
      {
        type: "assistant",
        content:
          "Telegram polling started. In Telegram, DM your bot and send /pair. Copy the code, then enter it below.",
        timestamp: new Date(),
      },
    ]);
  }, [startTelegramBridge]);

  const submitTelegramPair = useCallback(async () => {
    const code = (telegramPairInputRef.current?.plainText || "").trim();
    if (!code) {
      setTelegramPairError("Enter the pairing code.");
      return;
    }
    const result = approvePairingCode(code);
    if (!result.ok) {
      setTelegramPairError(result.error);
      return;
    }
    saveApprovedTelegramUserId(result.userId);
    telegramPairInputRef.current?.clear();
    setShowTelegramPairModal(false);
    setTelegramPairError(null);
    setMessages((p) => [
      ...p,
      {
        type: "assistant",
        content: `Telegram user ${result.userId} paired. Keep this CLI open while you use the bot.`,
        timestamp: new Date(),
      },
    ]);
    try {
      await bridgeRef.current?.sendDm(result.userId, "Pairing approved. You can message muonroi-cli here.");
    } catch {
      /* optional DM */
    }
  }, []);

  const beginTelegramFromConnect = useCallback(() => {
    setShowConnectModal(false);
    if (!getApiKey()) {
      setMessages((p) => [...p, { type: "assistant", content: "Add an API key first.", timestamp: new Date() }]);
      openApiKeyModal();
      return;
    }
    if (!getTelegramBotToken()) {
      setShowTelegramTokenModal(true);
      setTelegramTokenError(null);
      return;
    }
    startTelegramBridge();
    const alreadyPaired = (loadUserSettings().telegram?.approvedUserIds?.length ?? 0) > 0;
    if (!alreadyPaired) {
      setShowTelegramPairModal(true);
      setTelegramPairError(null);
      setMessages((p) => [
        ...p,
        {
          type: "assistant",
          content:
            "Telegram polling started. In Telegram, DM your bot and send /pair. Copy the code, then enter it below.",
          timestamp: new Date(),
        },
      ]);
    } else {
      setMessages((p) => [
        ...p,
        {
          type: "assistant",
          content: "Telegram polling is running. Your chat is already paired.",
          timestamp: new Date(),
        },
      ]);
    }
  }, [openApiKeyModal, startTelegramBridge]);

  const interruptActiveRun = useCallback(
    (key?: KeyEvent) => {
      if (btwStateRef.current) {
        btwAbortRef.current?.abort();
        btwAbortRef.current = null;
        btwStateRef.current = null;
        setBtwState(null);
        key?.preventDefault();
        key?.stopPropagation();
        return true;
      }
      // A pending council/preflight askcard owns the Escape key: the card's
      // own handler cancels it (routed as an empty answer → save-and-exit
      // semantics). Without this guard the renderer-internal Escape listener
      // (below) also fired Stage 2 — clearLiveTurnUi() + abort() — wiping the
      // whole debate transcript the instant the user dismissed the card
      // (live-verified 2026-07-06). Mirrors the pendingCouncilQuestionRef
      // guard the typing-jump listener already has.
      if (pendingCouncilQuestionRef.current || preflightCardStateRef.current) {
        return false;
      }
      if (!isProcessingRef.current) return false;
      key?.preventDefault();
      key?.stopPropagation();

      // Stage 1: queue has items → clear queue only, keep process running
      if (queuedMessagesRef.current.length > 0) {
        queuedMessagesRef.current = [];
        setQueuedMessages([]);
        return true;
      }

      // Stage 2: queue empty → abort current process
      interruptedRunIdRef.current = activeRunIdRef.current;
      const activeAgent = activeTurnRef.current?.agent ?? agent;
      activeTurnRef.current = null;
      clearLiveTurnUi();
      activeAgent.abort();
      return true;
    },
    [agent, clearLiveTurnUi],
  );

  useEffect(() => {
    const onInternalKey = (key: KeyEvent) => {
      // Skip keys another handler already consumed (e.g. the council askcard
      // Esc-cancel path calls preventDefault before nulling its refs).
      if ((key as { defaultPrevented?: boolean }).defaultPrevented) return;
      if (isEscapeKey(key)) {
        interruptActiveRun(key);
      }
    };

    renderer._internalKeyInput.onInternal("keypress", onInternalKey);
    return () => {
      renderer._internalKeyInput.offInternal("keypress", onInternalKey);
    };
  }, [interruptActiveRun, renderer]);

  // Typing-to-jump-to-bottom: when the user is mid-scroll-up reading the log
  // and starts typing into the composer, snap the scroll back to the newest
  // message so their next response lands where they expect. Triggers on any
  // printable char + backspace/delete. Skipped while a modal/picker is open
  // so arrow-key nav in those overlays doesn't shift the log.
  useEffect(() => {
    const onTypingKey = (key: KeyEvent) => {
      if (key.ctrl || key.meta) return; // modifier combos are commands
      const name = key.name ?? "";
      const isPrintable = name.length === 1 || name === "space";
      const isEdit = name === "backspace" || name === "delete";
      if (!isPrintable && !isEdit) return;
      if (
        showModelPicker ||
        showSandboxPicker ||
        showWalletPicker ||
        (activePlan?.questions?.length ?? 0) > 0 ||
        showApiKeyModal ||
        showSlashMenu ||
        pendingCouncilQuestionRef.current ||
        preflightCardStateRef.current
      ) {
        return;
      }
      // Follow the live tail while composing, but ONLY when already pinned to the
      // bottom. Typing must never inflate the jump-to-latest "N new below" pill:
      // that counter tracks new *content* arriving while the user reads history,
      // not keystrokes. Calling the soft scrollToBottom() unconditionally ran its
      // scroll-locked branch on every printable key, which did `newSinceLock += 1`
      // — so merely typing into the composer made the counter climb (the reported
      // bug). When the user is scroll-locked-away we now do nothing: no yank, no
      // miscount; the pill keeps its accurate real-content count.
      if (isPinnedToBottom()) scrollToBottom();
    };
    renderer._internalKeyInput.onInternal("keypress", onTypingKey);
    return () => {
      renderer._internalKeyInput.offInternal("keypress", onTypingKey);
    };
  }, [
    renderer,
    scrollToBottom,
    isPinnedToBottom,
    showModelPicker,
    showSandboxPicker,
    showWalletPicker,
    activePlan,
    showApiKeyModal,
    showSlashMenu,
  ]);

  useEffect(() => {
    const onRawInput = (sequence: string) => {
      const parsed = parseKeypress(sequence, { useKittyKeyboard: renderer.useKittyKeyboard });
      if (parsed?.name === "escape" || sequence === "\u001b" || sequence === "\u001b\u001b") {
        return interruptActiveRun();
      }
      return false;
    };

    renderer.prependInputHandler(onRawInput);
    return () => {
      renderer.removeInputHandler(onRawInput);
    };
  }, [interruptActiveRun, renderer]);

  useEffect(() => {
    const onStdinData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.length === 1 && data[0] === 27) {
        interruptActiveRun();
      }
    };

    renderer.stdin.on("data", onStdinData);
    return () => {
      renderer.stdin.off("data", onStdinData);
    };
  }, [interruptActiveRun, renderer]);

  const resetToNewSession = useCallback(() => {
    const snapshot = agent.startNewSession();
    setMessages(snapshot?.entries ?? []);
    setExpandedMessages(new Set());
    activeTurnRef.current = null;
    clearLiveTurnUi();
    setSessionTitle(snapshot?.session.title ?? null);
    setSessionId(snapshot?.session.id ?? agent.getSessionId());
    setActivePlan(null);
    setPqs(initialPlanQuestionsState());
    replacePasteBlocks([]);
    queuedMessagesRef.current = [];
    setQueuedMessages([]);
  }, [agent, clearLiveTurnUi, replacePasteBlocks]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: getSide, resolveStyle, storeQuote are stable hooks/callbacks that do not need to be in the dep array — adding them would cause unnecessary re-creation of processMessage on every render
  const processMessage = useCallback(
    async (text: string, displayText?: string, images?: Array<{ path: string; mediaType: string; base64: string }>) => {
      if (!text.trim() || isProcessingRef.current) return;
      if (taskListClearTimerRef.current) {
        clearTimeout(taskListClearTimerRef.current);
        taskListClearTimerRef.current = null;
      }
      setTaskListSnapshot(null);
      const runId = ++activeRunIdRef.current;
      const isStale = () => activeRunIdRef.current !== runId;
      isProcessingRef.current = true;
      setIsProcessing(true);

      const sessionInfo = agent.getSessionInfo();
      if (sessionInfo?.updatedAt) {
        const lastUpdated = new Date(sessionInfo.updatedAt).getTime();
        const diffMs = Date.now() - lastUpdated;
        const diffMins = Math.floor(diffMs / (60 * 1000));
        if (diffMins >= 10) {
          pushToast(
            "warn",
            `⚠️ Lần tương tác cuối cách đây ${diffMins} phút. Cache của DeepSeek có thể đã bị giải phóng (Cache Miss).`,
          );
        }
      }

      if (!sessionTitle)
        agent
          .generateTitle((displayText ?? text).trim())
          .then(setSessionTitle)
          .catch(() => {});
      await coordinatorRef.current.run(async () => {
        const color = modeInfoRef.current.color;
        beginLiveTurn({ kind: "local", agent, modeColor: color });
        setMessages((prev) => [...prev, buildUserEntry((displayText ?? text).trim(), { modeColor: color })]);
        setTimeout(scrollToBottom, 50);
        await new Promise((r) => setTimeout(r, 0));
        let turnHadError = false;
        let turnHadAuthError = false;
        try {
          // Register EE sink BEFORE the stream loop so experience_warning/injected chunks
          // reach the TUI render path. Deregistered in finally to prevent stale closure.
          setActiveEeYield((eeChunk) => {
            if (eeChunk.type === "experience_warning") {
              applyLocalAssistantDelta(
                `\n⚠ [Experience] ${eeChunk.experienceWarning?.message ?? eeChunk.content ?? ""}\nWhy: ${eeChunk.experienceWarning?.why ?? ""}\n`,
              );
            } else if (eeChunk.type === "experience_injected") {
              applyLocalAssistantDelta(formatExperienceInjectedBlock(eeChunk.experienceInjected ?? {}));
            }
          });
          for await (const chunk of agent.processMessage(text.trim(), undefined, images)) {
            if (isStale()) {
              break;
            }

            switch (chunk.type) {
              case "content":
                // Reasoning streak ended (model started speaking). Stamp the
                // elapsed time so the pill can replace the live "Thinking…"
                // indicator.
                if (reasoningStartRef.current !== null) {
                  setLastReasoningElapsedMs(Date.now() - reasoningStartRef.current);
                  reasoningStartRef.current = null;
                  setReasoningActive(false);
                  setStreamReasoning(reasoningAccRef.current);
                }
                applyLocalAssistantDelta(chunk.content || "");
                break;
              case "toast":
                // Ephemeral notice — flash it, do NOT append to the persisted
                // assistant message (that was the old "message thừa ở console"
                // the user reported: transient status stuck permanently in log).
                if (chunk.content) {
                  pushToast(chunk.toastLevel ?? "info", chunk.content);
                }
                break;
              case "reasoning":
                if (reasoningStartRef.current === null) {
                  reasoningStartRef.current = Date.now();
                  setReasoningActive(true);
                }
                if (chunk.content) {
                  reasoningAccRef.current += chunk.content;
                  const now = Date.now();
                  if (now - lastReasoningRenderTimeRef.current > 150) {
                    setStreamReasoning(reasoningAccRef.current);
                    lastReasoningRenderTimeRef.current = now;
                  }
                }
                break;
              case "tool_calls":
                if (reasoningStartRef.current !== null) {
                  setLastReasoningElapsedMs(Date.now() - reasoningStartRef.current);
                  reasoningStartRef.current = null;
                  setReasoningActive(false);
                  setStreamReasoning(reasoningAccRef.current);
                }
                if (chunk.toolCalls) {
                  showLiveToolCalls(chunk.toolCalls);
                }
                break;
              case "tool_result":
                if (chunk.toolCall && chunk.toolResult) {
                  appendLiveToolResult(chunk.toolCall, chunk.toolResult);
                }
                break;
              case "structured_response":
                if (chunk.structuredResponse) {
                  flushPendingAssistantMessage();
                  setMessages((prev) => [
                    ...prev,
                    {
                      type: "structured_response" as const,
                      content: "",
                      timestamp: new Date(),
                      modeColor: activeTurnRef.current?.modeColor,
                      structuredResponse: chunk.structuredResponse,
                    },
                  ]);
                  setTimeout(scrollToBottom, 10);
                }
                break;
              case "tool_approval_request":
                if (chunk.toolCall && chunk.approvalId) {
                  let args: Record<string, string> = {};
                  try {
                    args = JSON.parse(chunk.toolCall.function.arguments);
                  } catch {
                    /* ignore */
                  }
                  const pc = chunk.paymentPrecheck;
                  setPendingPaymentApproval({
                    url: args?.url ?? "",
                    description: pc?.description ?? "",
                    security: pc?.security ?? "",
                    securityLabel: pc?.securityLabel ?? "",
                    securityUrl: pc?.securityUrl ?? "",
                    amount: pc?.amount ?? "",
                    network: pc?.network ?? "",
                    asset: pc?.asset ?? "",
                    approvalId: chunk.approvalId,
                    selected: 0,
                  });
                }
                break;
              case "council_question":
                if (chunk.councilQuestion) {
                  process.stderr.write(`[app.tsx] RECEIVED council_question: ${chunk.councilQuestion.questionId}\n`);
                  const cq = chunk.councilQuestion;
                  // Render the card via dedicated state — do NOT bleed text into
                  // the assistant stream (that caused the freetext-soup look).
                  // Sync ref + React state — ref is checked by the key handler
                  // so a fast harness Enter after the askcard-open event lands
                  // even before React commits (mirror of councilCardStateRef).
                  setPendingCouncilQuestionSync(cq);
                  setCouncilCardStateSync(initialCardState(cq));
                  // Task 2.3 — emit askcard-open harness event (agent-mode only).
                  try {
                    agentRuntime?.emitEvent({
                      t: "event",
                      kind: "askcard-open",
                      questionId: cq.questionId,
                      question: cq.question,
                      phase: cq.phase ?? "clarify",
                      optionCount: cq.options?.length ?? 0,
                      defaultIndex: cq.defaultIndex,
                    });
                  } catch {
                    /* best-effort */
                  }
                  logUIInteraction(agent.getSessionId() ?? undefined, {
                    subtype: "askcard_open",
                    data: {
                      questionId: cq.questionId,
                      question: cq.question,
                      phase: cq.phase ?? "clarify",
                      optionCount: cq.options?.length ?? 0,
                      defaultIndex: cq.defaultIndex,
                      optionLabels: cq.options?.map((o) => o.label),
                      recommendedLabel: cq.options?.[cq.defaultIndex ?? 0]?.label,
                    },
                  });
                }
                break;
              case "council_preflight":
                if (chunk.councilPreflight) {
                  applyLocalAssistantDelta(chunk.content || "");
                  setPendingCouncilPreflight(chunk.councilPreflight);
                  setPreflightCardStateSync(initialCardState(buildPreflightQuestion(chunk.councilPreflight)));
                }
                break;
              case "council_message":
                if (chunk.councilMessage) {
                  const cm = chunk.councilMessage;
                  setCouncilMessages((prev) => [...prev, cm]);
                  if (cm.kind === "debate" && cm.partner) {
                    const pairKey = makePairKey(cm.speaker.role, cm.partner.role);
                    storeQuote(pairKey, cm.speaker.role, cm.text);
                    setCouncilPlaceholders((prev) => {
                      const next = new Map(prev);
                      for (const [id, p] of next) {
                        if (p.role === cm.speaker.role) next.delete(id);
                      }
                      return next;
                    });
                  }
                }
                break;
              case "council_info_card":
                if (chunk.councilInfoCard) {
                  const card = chunk.councilInfoCard;
                  setCouncilInfoCards((prev) => [...prev, card]);
                }
                break;
              case "council_meta":
                if (chunk.councilMeta) applyCouncilMetaPatch(chunk.councilMeta);
                break;
              case "council_round":
                if (chunk.councilRound) applyCouncilRound(chunk.councilRound);
                break;
              case "council_status":
                if (chunk.councilStatus) {
                  const cs = chunk.councilStatus;
                  // Placeholder "composing…" bubbles only make sense for debate
                  // speaker turns (opening/exchange) that later swap for a real
                  // CouncilMessageBubble. For clarify/plan/research/evaluate/
                  // synthesis the live status line already covers it, so a
                  // placeholder there is redundant noise at council start.
                  if (cs.state === "start" && cs.label && (cs.phase === "opening" || cs.phase === "exchange")) {
                    const placeholderRole = cs.label;
                    const isLeader = /^leader\b/i.test(placeholderRole);
                    const styleForRole = isLeader ? null : resolveStyle(placeholderRole);
                    const side: "left" | "right" = isLeader
                      ? "left"
                      : getSide(`placeholder::${placeholderRole}`, placeholderRole);
                    setCouncilPlaceholders((prev) => {
                      const next = new Map(prev);
                      next.set(cs.statusId, {
                        role: placeholderRole,
                        side,
                        color: styleForRole?.color ?? t.councilLeaderBorder,
                        variant: isLeader ? "leader" : "participant",
                        detail: cs.detail,
                      });
                      return next;
                    });
                  }
                  if (cs.state === "done" || cs.state === "error") {
                    councilDoneAtRef.current.set(cs.statusId, Date.now());
                    setCouncilPlaceholders((prev) => {
                      const next = new Map(prev);
                      next.delete(cs.statusId);
                      return next;
                    });
                  }
                  setCouncilStatuses((prev) => upsertStatus(prev, cs));
                  // Task 2.2b — emit council-speaker harness event (agent-mode only).
                  // Carries state:"tick" + elapsedMs so a harness poller can tell
                  // a long-running research phase (alive) from a hung one.
                  try {
                    agentRuntime?.emitEvent(mapCouncilStatusToSpeakerEvent(cs));
                  } catch {
                    /* best-effort */
                  }
                }
                break;
              case "council_phase":
                if (chunk.councilPhase) {
                  const cp = chunk.councilPhase;
                  setCouncilPhases((prev) => upsertPhase(prev, cp));
                  // Task 2.2 — emit council-step harness event (agent-mode only).
                  try {
                    agentRuntime?.emitEvent({
                      t: "event",
                      kind: "council-step",
                      phaseId: cp.phaseId,
                      phaseKind: cp.kind,
                      state: cp.state,
                      label: cp.label,
                      elapsedMs: cp.elapsedMs,
                    });
                  } catch {
                    /* best-effort */
                  }
                }
                break;
              case "error":
                turnHadError = true;
                if (chunk.isAuthError) {
                  turnHadAuthError = true;
                }
                contentAccRef.current += `\n${chunk.content || "Unknown error"}`;
                setStreamContent(contentAccRef.current);
                agentRuntime?.emitEvent({
                  t: "event",
                  kind: "toast",
                  level: "error",
                  text: chunk.content || "Unknown error",
                });
                break;
              case "experience_warning":
                applyLocalAssistantDelta(
                  `\n⚠ [Experience] ${chunk.experienceWarning?.message ?? chunk.content ?? ""}\nWhy: ${chunk.experienceWarning?.why ?? ""}\n`,
                );
                break;
              case "experience_injected":
                applyLocalAssistantDelta(formatExperienceInjectedBlock(chunk.experienceInjected ?? {}));
                break;
              case "halt":
                if (chunk.haltChunk) {
                  setActiveHaltCard(chunk.haltChunk);
                  setHaltSelectedIndex(0);
                  logUIInteraction(agent.getSessionId() ?? undefined, {
                    subtype: "halt_card_open",
                    data: {
                      reason: chunk.haltChunk.reason,
                      optionCount: chunk.haltChunk.recovery_options.length,
                      optionIds: chunk.haltChunk.recovery_options.map((o) => o.id),
                    },
                  });
                }
                break;
              case "task_list_update":
                if (chunk.taskListSnapshot) {
                  // Clear any pending auto-collapse — a fresh update means the
                  // agent is still working, even if the previous snapshot was
                  // already 100% done.
                  if (taskListClearTimerRef.current) {
                    clearTimeout(taskListClearTimerRef.current);
                    taskListClearTimerRef.current = null;
                  }
                  setTaskListSnapshot(chunk.taskListSnapshot);
                  // Auto-collapse 2s after 100% completion so finished lists
                  // don't linger on screen.
                  const c = chunk.taskListSnapshot.counts;
                  if (c.total > 0 && c.completed === c.total) {
                    taskListClearTimerRef.current = setTimeout(() => {
                      setTaskListSnapshot(null);
                      taskListClearTimerRef.current = null;
                    }, 2000);
                  }
                }
                break;
              case "done":
                if (turnHadError) {
                  break;
                }
                // Auto-complete any remaining non-completed todos when the turn ends.
                // Models often write the initial todo list but forget to call todo_write
                // again with all items marked "completed" at the end of the task.
                // This synthetic update marks every item completed and starts the 2s
                // auto-hide timer — same UX as if the model had done it explicitly.
                setTaskListSnapshot((prev) => {
                  if (!prev) return prev;
                  const allDone = prev.items.every((it) => it.status === "completed");
                  if (allDone) return prev; // nothing to do
                  const items = prev.items.map((it) =>
                    it.status === "completed" ? it : { ...it, status: "completed" as const },
                  );
                  const total = items.length;
                  // Schedule auto-hide after 2s (same as explicit 100% completion path)
                  if (taskListClearTimerRef.current) clearTimeout(taskListClearTimerRef.current);
                  taskListClearTimerRef.current = setTimeout(() => {
                    setTaskListSnapshot(null);
                    taskListClearTimerRef.current = null;
                  }, 2000);
                  return { items, counts: { completed: total, inProgress: 0, pending: 0, total }, ts: Date.now() };
                });
                break;
            }
          }
        } catch {
          turnHadError = true;
          if (!isStale()) {
            contentAccRef.current += "\nAn unexpected error occurred.";
            setStreamContent(contentAccRef.current);
            agentRuntime?.emitEvent({
              t: "event",
              kind: "toast",
              level: "error",
              text: "An unexpected error occurred.",
            });
          }
        } finally {
          // Defensive: if the stream ends mid-tool-streak (no trailing text
          // chunk), still close the group so it renders as "done" instead of
          // forever-active. Failed items keep the group expanded via state.
          closeCurrentToolGroup();
          setActiveEeYield(null);
        }
        const wasInterrupted = interruptedRunIdRef.current === runId;
        if (isStale()) {
          contentAccRef.current = "";
          return;
        }

        if (turnHadAuthError) {
          setApiKeyError("Your API key is invalid or expired. Please enter a new key.");
          setShowApiKeyModal(true);
          showApiKeyModalRef.current = true;
        }

        if (!isStale()) {
          finalizeActiveTurn({ wasInterrupted, hadError: turnHadError });

          // If the agent proactively requested compaction (ended its turn with a
          // `/compact` line — e.g. it felt context getting heavy), run the REAL
          // compaction pass and then AUTO-RESUME the task, so a long task is
          // never left stranded. Note: processMessage does NOT route slash
          // commands (it streams text to the model), so the compaction must be
          // performed inline here — not by re-dispatching "/compact" as a prompt.
          const finalContent = contentAccRef.current.trim();
          if (finalContent.startsWith("/compact")) {
            const _pc = detectProactiveCompactRequest(finalContent);
            const _resume = buildCompactResumeMessage(_pc.instructions);
            setTimeout(() => {
              void (async () => {
                try {
                  const flowDir = path.join(agent.getCwd(), ".muonroi-flow");
                  const cr = await deliberateCompact(
                    flowDir,
                    agent.getMessages(),
                    "",
                    4096,
                    agent.getProvider(),
                    model,
                    _pc.instructions ?? undefined,
                  );
                  const sessionId = agent.getSessionId();
                  if (sessionId) {
                    const nextSeq = getNextMessageSequence(sessionId);
                    appendCompaction(sessionId, nextSeq, cr.summary, cr.tokensBeforeCompress);
                  }
                  agent.setMessages([createCompactionSummaryMessage(cr.summary)]);
                  setMessages(agent.getChatEntries());
                  setMessages((prev) => [
                    ...prev,
                    buildAssistantEntry(
                      `⋯ Đã tự nén ngữ cảnh (${cr.tokensBeforeCompress} → ${cr.tokensAfterCompress} tokens, giữ ${cr.decisionsExtracted} quyết định; kết quả tool vẫn rehydrate được qua ee_query). Tiếp tục tác vụ...`,
                    ),
                  ]);
                } catch (e) {
                  logger.error("ui", "proactive compaction failed", {
                    message: (e as Error)?.message,
                    stack: (e as Error)?.stack?.split("\n").slice(0, 3),
                  });
                  setMessages((prev) => [...prev, buildAssistantEntry(`Compaction failed: ${e}`)]);
                }
                // Resume the task with the fresh compacted context so the long
                // task continues without the user having to type "tiếp tục".
                if (processMessageRef.current) void processMessageRef.current(_resume);
              })();
            }, 100);
          }
        }
        if (wasInterrupted) {
          interruptedRunIdRef.current = null;
        }
      });
    },
    [
      agent,
      appendLiveToolResult,
      applyLocalAssistantDelta,
      beginLiveTurn,
      closeCurrentToolGroup,
      finalizeActiveTurn,
      scrollToBottom,
      sessionTitle,
      showLiveToolCalls,
      flushPendingAssistantMessage,
      pushToast,
    ],
  );

  useEffect(() => {
    if (initialMessage && hasApiKey && !processedInitial.current) {
      processedInitial.current = true;
      processMessage(initialMessage);
    }
  }, [hasApiKey, initialMessage, processMessage]);
  useEffect(() => {
    processMessageRef.current = processMessage;
  }, [processMessage]);

  // Scaffold-checkpoint integration — wraps initNewProject() so a single helper
  // serves both submit branches (design-preview + bb-template) and the R-key
  // retry on the error step. Persists a checkpoint at submitted/done/error to
  // .muonroi-flow/runs/<runId>/scaffold-checkpoint.json so future restarts can
  // (eventually) auto-resume. The error catch stamps the form with
  // errorRetryable=true + replayInputs so R-retry can re-run with no debate.
  const runScaffoldAttempt = useCallback(
    async (replayInputs: NonNullable<InitNewFormState["replayInputs"]>) => {
      const sessionId = agent.getSessionId() ?? undefined;
      const runId = sessionId ?? `manual-${Date.now()}`;
      const cwd = process.cwd();
      setInitNewForm((s) =>
        s
          ? {
              ...s,
              step: "running",
              progressMessage: "dotnet new — scaffolding template…",
              replayInputs,
              checkpointRunId: runId,
              errorRetryable: false,
              resultMessage: null,
            }
          : s,
      );
      logUIInteraction(sessionId, {
        subtype: "init_new_submitted",
        data: {
          projectName: replayInputs.projectName,
          feStack: replayInputs.feStack,
          bbTemplate: replayInputs.bbTemplate?.shortName ?? replayInputs.bbTemplate?.nugetId ?? null,
          packageCount: replayInputs.eePackages?.length ?? 0,
        },
      });
      await writeScaffoldCheckpoint(cwd, runId, {
        status: "submitted",
        inputs: replayInputs,
        originalPrompt: originalIdealPromptRef.current ?? null,
      }).catch(() => {});

      try {
        const result = await initNewProject({
          projectName: replayInputs.projectName,
          feStack: replayInputs.feStack,
          bbTemplate: replayInputs.bbTemplate,
          eePackages: replayInputs.eePackages,
          commercial: replayInputs.commercial,
          onPackageProgress: (info) => {
            const verb = info.status === "start" ? "Adding" : info.status === "ok" ? "Added" : "Failed";
            setInitNewForm((s) =>
              s ? { ...s, progressMessage: `[${info.index}/${info.total}] ${verb} package ${info.pkgId}…` } : s,
            );
          },
        });
        logUIInteraction(sessionId, {
          subtype: "init_new_result",
          data: {
            outcome: "done",
            message: `Created: ${result.projectDir}`,
            usedDotnetTemplate: result.usedDotnetTemplate,
          },
        });
        await writeScaffoldCheckpoint(cwd, runId, {
          status: "done",
          inputs: replayInputs,
          projectDir: result.projectDir,
          originalPrompt: originalIdealPromptRef.current ?? null,
        }).catch(() => {});

        const templateName = replayInputs.bbTemplate?.nugetId ?? null;
        const originalPrompt = originalIdealPromptRef.current;
        setInitNewForm((s) =>
          s
            ? {
                ...s,
                step: "done",
                resultMessage: originalPrompt
                  ? `Created: ${result.projectDir}`
                  : `Created: ${result.projectDir}\n(project scaffolded — start a new prompt to continue)`,
                scaffoldedTemplate: templateName ?? undefined,
                scaffoldedCoverage: result.usedDotnetTemplate ? "full" : "partial",
              }
            : s,
        );
        if (originalPrompt) {
          setTimeout(() => {
            try {
              agent.setCwd(result.projectDir);
            } catch (_) {}
            const tplLabel = templateName ?? "bb-template";
            const continuationPrompt = buildIdealContinuationPrompt({
              originalPrompt,
              projectDir: result.projectDir,
              templateName: tplLabel,
            });
            logUIInteraction(sessionId, {
              subtype: "init_new_resume",
              data: { projectDir: result.projectDir, templateName: tplLabel, originalPrompt },
            });
            originalIdealPromptRef.current = null;
            setInitNewForm(null);
            void processMessageRef.current(continuationPrompt, "(resuming /ideal in scaffolded project)");
          }, 500);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logUIInteraction(sessionId, {
          subtype: "init_new_result",
          data: { outcome: "error", message: msg },
        });
        await writeScaffoldCheckpoint(cwd, runId, {
          status: "error",
          inputs: replayInputs,
          errorMessage: msg,
          originalPrompt: originalIdealPromptRef.current ?? null,
        }).catch(() => {});
        setInitNewForm((s) =>
          s
            ? {
                ...s,
                step: "error",
                resultMessage: msg,
                errorRetryable: true,
                replayInputs,
                checkpointRunId: runId,
              }
            : s,
        );
      }
    },
    [agent],
  );
  useEffect(
    () =>
      agent.onSubagentStatus((status) => {
        if (activeTurnRef.current?.agent !== agent) return;
        setActiveSubagent(status);
      }),
    [agent],
  );
  useEffect(
    () => () => {
      for (const unsubscribe of telegramSubagentUnsubsRef.current.values()) {
        unsubscribe();
      }
      telegramSubagentUnsubsRef.current.clear();
    },
    [],
  );
  useEffect(() => {
    let active = true;
    const id = setInterval(() => {
      agent
        .consumeBackgroundNotifications()
        .then((notifications) => {
          if (!active || notifications.length === 0) return;
          setMessages((prev) => [
            ...prev,
            ...notifications.map((message) => ({
              type: "assistant" as const,
              content: message,
              timestamp: new Date(),
            })),
          ]);
          setTimeout(scrollToBottom, 10);
        })
        .catch(() => {});
    }, 2000);

    return () => {
      active = false;
      clearInterval(id);
    };
  }, [agent, scrollToBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: getSide, resolveStyle, storeQuote are stable hooks/callbacks; adding them to deps would unnecessarily recreate handleCommand on each render
  const handleCommand = useCallback(
    (cmd: string): boolean => {
      const c = cmd.trim().toLowerCase();
      if (c === "/clear") {
        resetToNewSession();
        return true;
      }
      if (c === "/providers" || c === "/model" || c === "/models") {
        setShowModelPicker(true);
        setModelPickerIndex(0);
        setModelSearchQuery("");
        return true;
      }
      if (c === "/sandbox") {
        openSandboxPicker();
        return true;
      }
      if (c === "/sessions" || c === "/session" || c === "/resume") {
        try {
          const { SessionStore } = require("../storage/sessions.js") as typeof import("../storage/sessions.js");
          const list = new SessionStore(agent.getCwd()).listRecentSessions(20);
          setSessionPickerList(list);
          setSessionPickerIndex(0);
          setShowSessionPicker(true);
        } catch (err) {
          console.error(`[session-picker] list failed: ${(err as Error)?.message ?? err}`);
          setMessages((p) => [
            ...p,
            {
              type: "assistant",
              content: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: new Date(),
            },
          ]);
        }
        return true;
      }
      if (c === "/wallet") {
        openWalletPicker();
        return true;
      }
      if (c === "/remote-control") {
        setConnectModalIndex(0);
        setShowConnectModal(true);
        return true;
      }
      if (c === "/mcp" || c === "/mcps") {
        openMcpModal();
        return true;
      }
      if (c === "/agents" || c === "/agent") {
        openAgentsModal();
        return true;
      }
      if (c === "/schedule" || c === "/schedules") {
        openScheduleModal();
        return true;
      }
      if (c === "/quit" || c === "/exit" || c === "/q") {
        handleExit();
        return true;
      }
      if (c === "/review") {
        processMessage(REVIEW_PROMPT);
        return true;
      }
      if (c === "/verify") {
        processMessage(buildVerifyPrompt(agent.getCwd()));
        return true;
      }
      if (c === "/commit-push") {
        processMessage(COMMIT_PUSH_PROMPT);
        return true;
      }
      if (c === "/commit-pr") {
        processMessage(COMMIT_PR_PROMPT);
        return true;
      }
      // Phase 21 / Plan 02 / T3: BB-context feature flag toggle.
      // `/ee-context on|off|status` — surfaces userSettings.eeBBContext.
      if (c === "/ee-context" || c.startsWith("/ee-context ")) {
        const arg = c.slice("/ee-context".length).trim();
        const current = loadUserSettings().eeBBContext !== false; // default ON
        if (arg === "" || arg === "status") {
          pushToast("info", `BB context: ${current ? "ON" : "OFF"}`);
          return true;
        }
        if (arg === "on") {
          saveUserSettings({ eeBBContext: true });
          pushToast("info", "BB context: ON");
          return true;
        }
        if (arg === "off") {
          saveUserSettings({ eeBBContext: false });
          pushToast("info", "BB context: OFF");
          return true;
        }
        pushToast("warn", "Usage: /ee-context on|off|status");
        return true;
      }
      if (c.startsWith("/btw ") || c === "/btw") {
        const question = cmd.trim().slice(4).trim();
        if (!question) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry("Usage: /btw <question>\nExample: /btw what does useEffect cleanup do?"),
          ]);
          return true;
        }
        const ac = new AbortController();
        btwAbortRef.current = ac;
        const loadingState: BtwState = { status: "loading", question };
        btwStateRef.current = loadingState;
        setBtwState(loadingState);
        agent
          .askSideQuestion(question, ac.signal)
          .then((result) => {
            if (ac.signal.aborted) return;
            const doneState: BtwState = { status: "done", question, answer: result.response };
            btwStateRef.current = doneState;
            setBtwState(doneState);
          })
          .catch((err) => {
            if (ac.signal.aborted) return;
            const errState: BtwState = {
              status: "error",
              question,
              error: err instanceof Error ? err.message : String(err),
            };
            btwStateRef.current = errState;
            setBtwState(errState);
          });
        return true;
      }
      const customSubagentCommand = parseCustomSubagentSlashCommand(cmd, subAgents);
      if (customSubagentCommand) {
        if (!customSubagentCommand.prompt) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry(
              `Usage: /${customSubagentCommand.agentName} <task>\nExample: /${customSubagentCommand.agentName} review the latest changes`,
            ),
          ]);
          return true;
        }

        processMessage(buildCustomSubagentSlashPrompt(customSubagentCommand.agentName, customSubagentCommand.prompt));
        return true;
      }
      // Plan 06: fallback to slash registry (dispatchSlash) for custom commands like /route
      if (c.startsWith("/")) {
        const parts = c.slice(1).split(/\s+/);
        const name = parts[0] ?? "";
        const args = parts.slice(1);
        dispatchSlash(name, args, {
          cwd: agent.getCwd(),
          tenantId: "local",
          defaultProvider: agent.getProviderId(),
          defaultModel: model,
          lastPrompt: messages[messages.length - 1]?.content,
          sessionId: agent.getSessionId() ?? undefined,
          getLiveEntries: () => messages,
        })
          .then(async (result) => {
            if (result === null) return;

            if (result.startsWith("__COMPACT__")) {
              const match = result.match(/Instructions:\s*(.+)/);
              const instructions = match ? match[1].trim() : "";
              const flowDir = path.join(agent.getCwd(), ".muonroi-flow");
              try {
                const cr = await deliberateCompact(
                  flowDir,
                  agent.getMessages(),
                  "",
                  4096,
                  agent.getProvider(),
                  model,
                  instructions,
                );
                const sessionId = agent.getSessionId();
                if (sessionId) {
                  const nextSeq = getNextMessageSequence(sessionId);
                  appendCompaction(sessionId, nextSeq, cr.summary, cr.tokensBeforeCompress);
                }
                const summaryMsg = createCompactionSummaryMessage(cr.summary);
                agent.setMessages([summaryMsg]);
                setMessages(agent.getChatEntries());
                setMessages((prev) => [
                  ...prev,
                  buildAssistantEntry(
                    `Compaction: ${cr.decisionsExtracted} decisions extracted, ${cr.tokensBeforeCompress} → ${cr.tokensAfterCompress} tokens.\nSnapshot: ${cr.historyPath}`,
                  ),
                ]);
              } catch (e: unknown) {
                setMessages((prev) => [...prev, buildAssistantEntry(`Compaction failed: ${e}`)]);
              }
              return;
            }

            if (result.startsWith("__EXPAND__") || result.startsWith("__EXPAND_JSON__")) {
              const sessionId = agent.getSessionId();
              if (result.startsWith("__EXPAND_JSON__")) {
                try {
                  const lines = result.split("\n");
                  const jsonStr = lines[1]!;
                  const restoredMessages = JSON.parse(jsonStr);
                  if (sessionId) {
                    revertLatestCompaction(sessionId);
                  }
                  agent.setMessages(restoredMessages);
                  setMessages(agent.getChatEntries());
                  const text = lines.slice(2).join("\n");
                  setMessages((prev) => [...prev, buildAssistantEntry(text)]);
                  return;
                } catch (e) {
                  // fallback
                }
              }
              const content = result.replace(/^__EXPAND__\n[^\n]*\n?/, "");
              setMessages((prev) => [...prev, buildAssistantEntry(`Restored session context:\n${content}`)]);
              return;
            }

            if (result.startsWith("__CLEAR__")) {
              const summary = result.replace(/^__CLEAR__\n/, "");
              agent.clearHistory();
              setMessages([buildAssistantEntry(`Session cleared and relocked.\n\n${summary}`)]);
              return;
            }

            if (result === "__PIN_LAST__") {
              const seq = agent.pinLastUserMessage();
              setMessages((prev) => [
                ...prev,
                buildAssistantEntry(
                  seq === null
                    ? "No user message to pin."
                    : `Pinned user message (seq=${seq}). It will survive compaction.`,
                ),
              ]);
              return;
            }
            if (result.startsWith("__PIN_SEQ__")) {
              const seq = Number.parseInt(result.split("\n")[1] ?? "", 10);
              const ok = Number.isFinite(seq) && agent.pinMessageBySeq(seq);
              setMessages((prev) => [
                ...prev,
                buildAssistantEntry(
                  ok ? `Pinned message seq=${seq}.` : `Could not pin seq=${seq} (not found or not a user message).`,
                ),
              ]);
              return;
            }
            if (result.startsWith("__UNPIN_SEQ__")) {
              const seq = Number.parseInt(result.split("\n")[1] ?? "", 10);
              const ok = Number.isFinite(seq) && agent.unpinMessageBySeq(seq);
              setMessages((prev) => [
                ...prev,
                buildAssistantEntry(ok ? `Unpinned seq=${seq}.` : `seq=${seq} was not pinned.`),
              ]);
              return;
            }
            if (result === "__PINS_LIST__") {
              const seqs = agent.getPinnedSeqs();
              setMessages((prev) => [
                ...prev,
                buildAssistantEntry(seqs.length === 0 ? "No pinned messages." : `Pinned seqs: ${seqs.join(", ")}`),
              ]);
              return;
            }

            if (result.startsWith("__PRODUCT_LOOP__") || result.includes("\n__PRODUCT_LOOP__\n")) {
              const sentinelIdx = result.indexOf("__PRODUCT_LOOP__\n");
              const warningPrefix = sentinelIdx > 0 ? result.slice(0, sentinelIdx) : "";
              const json = result.slice(sentinelIdx + "__PRODUCT_LOOP__\n".length);
              let payload: any;
              try {
                payload = JSON.parse(json);
              } catch (e) {
                setMessages((prev) => [...prev, buildAssistantEntry(`/ideal parse error: ${e}`)]);
                return;
              }
              // Plan 23-02 — capture the original idea for EE-driven BB design.
              if (payload.subcommand === "start" && typeof payload.idea === "string") {
                lastIdealIdeaRef.current = payload.idea;
                originalIdealPromptRef.current = payload.idea;
                // A — a brand-new run re-enables verification even if a prior
                // recovery chose "Skip verify", and clears the last sprint marker.
                delete process.env.MUONROI_SPRINT_SKIP_VERIFY;
                lastProductSprintNRef.current = null;
              }
              const heading =
                payload.subcommand === "start"
                  ? `/ideal "${payload.idea ?? ""}"`
                  : `/ideal ${payload.subcommand}${payload.runId ? ` ${payload.runId}` : ""}`;
              setMessages((prev) => [
                ...prev,
                buildUserEntry(heading),
                buildAssistantEntry(
                  warningPrefix
                    ? `${warningPrefix}\nProduct loop starting… (initializing council + discovery — first phase usually appears within 30s)\n`
                    : "Product loop starting… (initializing council + discovery — first phase usually appears within 30s)\n",
                ),
              ]);
              // Fresh product-loop run — clear any persisted phase/status so old
              // runs don't bleed into the new one (phaseIds collide across runs).
              setCouncilPhases([]);
              setCouncilStatuses([]);
              councilDoneAtRef.current.clear();
              // Liveness heartbeat — between "Product loop starting…" and the
              // first phase event (CB-1 + discovery + leader call can take
              // 5-60s), the UI used to look frozen with no indication of
              // activity. We append a single-line elapsed counter every second
              // that is REPLACED in place (not appended) until the first real
              // chunk arrives. The counter is then cleared so the normal phase
              // flow takes over.
              const heartbeatStartedAt = Date.now();
              let firstChunkSeen = false;
              const heartbeatLineMarker = "\n⏳ Initializing… elapsed ";
              const writeHeartbeat = () => {
                if (firstChunkSeen) return;
                const elapsed = Math.floor((Date.now() - heartbeatStartedAt) / 1000);
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (!last || last.type !== "assistant") return prev;
                  const base = (last.content ?? "").split(heartbeatLineMarker)[0] ?? last.content ?? "";
                  return [...prev.slice(0, -1), { ...last, content: `${base}${heartbeatLineMarker}${elapsed}s\n` }];
                });
              };
              const heartbeatInterval = setInterval(writeHeartbeat, 1_000);
              const clearHeartbeat = () => {
                if (firstChunkSeen) return;
                firstChunkSeen = true;
                clearInterval(heartbeatInterval);
                // Strip the heartbeat line from the assistant message so the
                // normal phase output starts on a clean slate.
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (!last || last.type !== "assistant") return prev;
                  const base = (last.content ?? "").split(heartbeatLineMarker)[0] ?? last.content ?? "";
                  return [...prev.slice(0, -1), { ...last, content: base.endsWith("\n") ? base : `${base}\n` }];
                });
              };
              try {
                const gen = (agent as any).runProductLoopV1(payload);
                for await (const chunk of gen) {
                  clearHeartbeat();
                  clearInterCardHeartbeat();
                  if (process.env.MUONROI_DEBUG_LEADER === "1") {
                    const cq = chunk.councilQuestion;
                    process.stderr.write(
                      `[ideal-chunk-rx] type=${chunk.type}, questionId=${cq?.questionId ?? "n/a"}\n`,
                    );
                  }
                  const _chunkType = chunk.type;
                  if (chunk.type === "content") {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.type === "assistant") {
                        return [
                          ...prev.slice(0, -1),
                          { ...last, content: (last.content ?? "") + (chunk.content ?? "") },
                        ];
                      }
                      return [...prev, buildAssistantEntry(chunk.content ?? "")];
                    });
                  }
                  if (chunk.type === "council_question" && chunk.councilQuestion) {
                    const cq2 = chunk.councilQuestion;
                    setPendingCouncilQuestionSync(cq2);
                    setCouncilCardStateSync(initialCardState(cq2));
                    // Task 2.2c — emit askcard-open in branch 2 (agent-mode only).
                    try {
                      agentRuntime?.emitEvent({
                        t: "event",
                        kind: "askcard-open",
                        questionId: cq2.questionId,
                        question: cq2.question,
                        phase: cq2.phase ?? "clarify",
                        optionCount: cq2.options?.length ?? 0,
                        defaultIndex: cq2.defaultIndex,
                      });
                    } catch {
                      /* best-effort */
                    }
                    logUIInteraction(agent.getSessionId() ?? undefined, {
                      subtype: "askcard_open",
                      data: {
                        questionId: cq2.questionId,
                        question: cq2.question,
                        phase: cq2.phase ?? "clarify",
                        optionCount: cq2.options?.length ?? 0,
                        defaultIndex: cq2.defaultIndex,
                        optionLabels: cq2.options?.map((o: { label: string }) => o.label),
                        recommendedLabel: cq2.options?.[cq2.defaultIndex ?? 0]?.label,
                      },
                    });
                  }
                  if (chunk.type === "council_preflight" && chunk.councilPreflight) {
                    setPendingCouncilPreflight(chunk.councilPreflight);
                    setPreflightCardStateSync(initialCardState(buildPreflightQuestion(chunk.councilPreflight)));
                  }
                  if (chunk.type === "council_meta" && chunk.councilMeta) {
                    applyCouncilMetaPatch(chunk.councilMeta);
                  }
                  if (chunk.type === "council_round" && chunk.councilRound) {
                    applyCouncilRound(chunk.councilRound);
                  }
                  if (chunk.type === "council_message" && chunk.councilMessage) {
                    const cm = chunk.councilMessage;
                    setCouncilMessages((prev) => [...prev, cm]);
                    if (cm.kind === "debate" && cm.partner) {
                      const pairKey = makePairKey(cm.speaker.role, cm.partner.role);
                      storeQuote(pairKey, cm.speaker.role, cm.text);
                      setCouncilPlaceholders((prev) => {
                        const next = new Map(prev);
                        for (const [id, p] of next) {
                          if (p.role === cm.speaker.role) next.delete(id);
                        }
                        return next;
                      });
                    }
                  }
                  if (chunk.type === "council_status" && chunk.councilStatus) {
                    const cs = chunk.councilStatus;
                    // Placeholder "composing…" only for debate speaker turns
                    // (opening/exchange) — see the council_status handler above.
                    if (cs.state === "start" && cs.label && (cs.phase === "opening" || cs.phase === "exchange")) {
                      const placeholderRole = cs.label;
                      const isLeader = /^leader\b/i.test(placeholderRole);
                      const styleForRole = isLeader ? null : resolveStyle(placeholderRole);
                      const side: "left" | "right" = isLeader
                        ? "left"
                        : getSide(`placeholder::${placeholderRole}`, placeholderRole);
                      setCouncilPlaceholders((prev) => {
                        const next = new Map(prev);
                        next.set(cs.statusId, {
                          role: placeholderRole,
                          side,
                          color: styleForRole?.color ?? t.councilLeaderBorder,
                          variant: isLeader ? "leader" : "participant",
                          detail: cs.detail,
                        });
                        return next;
                      });
                    }
                    if (cs.state === "done" || cs.state === "error") {
                      councilDoneAtRef.current.set(cs.statusId, Date.now());
                      setCouncilPlaceholders((prev) => {
                        const next = new Map(prev);
                        next.delete(cs.statusId);
                        return next;
                      });
                    }
                    setCouncilStatuses((prev) => upsertStatus(prev, cs));
                    // Task 2.2b — emit council-speaker in branch 2 (agent-mode only).
                    try {
                      agentRuntime?.emitEvent(mapCouncilStatusToSpeakerEvent(cs));
                    } catch {
                      /* best-effort */
                    }
                  }
                  if (chunk.type === "council_phase" && chunk.councilPhase) {
                    const cp2 = chunk.councilPhase;
                    setCouncilPhases((prev) => upsertPhase(prev, cp2));
                    // Task 2.2 — emit council-step in branch 2 (agent-mode only).
                    try {
                      agentRuntime?.emitEvent({
                        t: "event",
                        kind: "council-step",
                        phaseId: cp2.phaseId,
                        phaseKind: cp2.kind,
                        state: cp2.state,
                        label: cp2.label,
                        elapsedMs: cp2.elapsedMs,
                      });
                    } catch {
                      /* best-effort */
                    }
                  }
                  if (chunk.type === "product_status_card" && chunk.productStatusCard) {
                    const d = chunk.productStatusCard;
                    // A — remember the live sprint number so a subsequent break
                    // can title the recovery card with the sprint that failed.
                    if (typeof d.sprintN === "number") lastProductSprintNRef.current = d.sprintN;
                    setProductStatus((prev) => {
                      // Accumulate per-sprint history client-side so loop-driver
                      // doesn't have to ship the full history every chunk.
                      const total = d.criteriaMet + d.criteriaPartial + d.criteriaUnmet;
                      const prevHistory = prev?.criteriaHistory ?? [];
                      const lastHist = prevHistory[prevHistory.length - 1];
                      const criteriaHistory =
                        lastHist && lastHist.sprintN === d.sprintN
                          ? [...prevHistory.slice(0, -1), { sprintN: d.sprintN, met: d.criteriaMet, total }]
                          : [...prevHistory, { sprintN: d.sprintN, met: d.criteriaMet, total }];
                      const prevCost = prev?.costHistory ?? [];
                      const lastCost = prevCost[prevCost.length - 1];
                      const costHistory =
                        lastCost && lastCost.sprintN === d.sprintN
                          ? [...prevCost.slice(0, -1), { sprintN: d.sprintN, cumulativeUsd: d.costSpent }]
                          : [...prevCost, { sprintN: d.sprintN, cumulativeUsd: d.costSpent }];
                      return { ...d, criteriaHistory, costHistory };
                    });
                  }
                  if (chunk.type === "experience_warning" && chunk.experienceWarning) {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.type === "assistant") {
                        return [
                          ...prev.slice(0, -1),
                          {
                            ...last,
                            content: `${last.content ?? ""}\n⚠ [Experience] ${chunk.experienceWarning!.message}\nWhy: ${chunk.experienceWarning!.why}\n`,
                          },
                        ];
                      }
                      return [...prev, buildAssistantEntry(`⚠ [Experience] ${chunk.experienceWarning!.message}`)];
                    });
                  }
                  if (chunk.type === "experience_injected" && chunk.experienceInjected) {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.type === "assistant") {
                        return [
                          ...prev.slice(0, -1),
                          {
                            ...last,
                            content: `${last.content ?? ""}${formatExperienceInjectedBlock(chunk.experienceInjected!)}`,
                          },
                        ];
                      }
                      return [...prev, buildAssistantEntry(formatExperienceInjectedBlock(chunk.experienceInjected!))];
                    });
                  }
                  if (chunk.type === "halt" && chunk.haltChunk) {
                    // Surface the structured recovery card. The /ideal product-loop
                    // emits halt when CB-1 / CB-3 trip (e.g. no verify recipe in
                    // the target directory). Without this branch the chunk was
                    // silently dropped and the TUI looked frozen.
                    setActiveHaltCard(chunk.haltChunk);
                    setHaltSelectedIndex(0);
                    logUIInteraction(agent.getSessionId() ?? undefined, {
                      subtype: "halt_card_open",
                      data: {
                        reason: chunk.haltChunk.reason,
                        optionCount: chunk.haltChunk.recovery_options.length,
                        optionIds: chunk.haltChunk.recovery_options.map((o: { id: string }) => o.id),
                      },
                    });
                  }
                  if (chunk.type === "done") break;
                  if (process.env.MUONROI_DEBUG_LEADER === "1") {
                    process.stderr.write(`[ideal-chunk-done] type=${_chunkType}\n`);
                  }
                }
                if (process.env.MUONROI_DEBUG_LEADER === "1") {
                  process.stderr.write(`[ideal-loop-exit] for-await ended cleanly\n`);
                }
              } catch (e: unknown) {
                clearHeartbeat();
                if (process.env.MUONROI_DEBUG_LEADER === "1") {
                  process.stderr.write(`[ideal-loop-error] ${String(e)}\n`);
                }
                // A — a break mid-run (thrown implement/verify error, cap breach,
                // provider outage) used to surface only an opaque one-line
                // "Product loop error" with no way forward. Instead render the
                // actionable recovery card: Resume / Retry / Skip verify / Abort.
                // Resume/Retry/Abort auto-detect the newest incomplete run (A/B)
                // so the user never has to know the runId.
                const errMsg = e instanceof Error ? e.message : String(e);
                const brokenSprintN =
                  payload.subcommand === "resume" ? undefined : (lastProductSprintNRef.current ?? undefined);
                setMessages((prev) => [...prev, buildAssistantEntry(`Product loop error: ${errMsg}`)]);
                setActiveHaltCard({
                  type: "halt",
                  reason: "sprint_failed",
                  sprintN: brokenSprintN,
                  runId: typeof payload.runId === "string" ? payload.runId : undefined,
                  detail: `The run broke: ${errMsg}`,
                  recovery_options: SPRINT_FAILED_RECOVERY_OPTIONS,
                });
                setHaltSelectedIndex(0);
                logUIInteraction(agent.getSessionId() ?? undefined, {
                  subtype: "halt_card_open",
                  data: { reason: "sprint_failed", trigger: "loop_throw", sprintN: brokenSprintN ?? null },
                });
              } finally {
                if (!firstChunkSeen) clearHeartbeat();
                setCouncilPhases([]);
                setCouncilStatuses([]);
                councilDoneAtRef.current.clear();
                setProductStatus(null);
              }
              return;
            }

            if (result.startsWith("__COUNCIL__")) {
              const lines = result.split("\n");
              const topic = lines.slice(2).join("\n");
              // No "Council convening..." placeholder message — the council phase
              // timeline + inter-card heartbeat already signal liveness, and a
              // seeded assistant entry both (a) rendered a meaningless line at
              // elapsed 0s and (b) got PREPENDED to the real synthesis because the
              // content handler appends into the last assistant entry. The content
              // handler below already creates a fresh assistant entry when the tail
              // is the user message, so the anchor is unnecessary.
              setMessages((prev) => [...prev, buildUserEntry(`/council ${topic}`)]);
              // Fresh council run — clear any persisted phase timeline so old runs
              // don't bleed into the new one (phaseIds collide across runs).
              setCouncilPhases([]);
              setCouncilStatuses([]);
              councilDoneAtRef.current.clear();
              // Mark the turn as processing for the lifetime of the council run.
              // The /council slash command is dispatched via a DETACHED
              // `dispatchSlash(...).then(...)` promise: the submit handler returns
              // (and resets isProcessing) before this callback runs, so without
              // re-arming it here `interruptActiveRun` bails on `!isProcessingRef`
              // and Esc never reaches `agent.abort()` — the multi-minute council
              // was uncancellable. Set the ref (read synchronously by the Esc
              // handler) AND the state (drives the "esc to interrupt" affordance).
              isProcessingRef.current = true;
              setIsProcessing(true);
              try {
                const gen = agent.runCouncilV2(topic, { convenePath: true });
                for await (const chunk of gen) {
                  // Council emitted a chunk — clear the "Waiting for next phase"
                  // inter-card heartbeat started after the last askcard answer.
                  // The /council chunk loop never cleared it (only /ideal's did),
                  // so on cancel/done it orphaned and kept overwriting the final
                  // message — making a cancelled/finished run look stuck.
                  // clearInterCardHeartbeat is idempotent.
                  clearInterCardHeartbeat();
                  if (chunk.type === "content") {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.type === "assistant") {
                        return [...prev.slice(0, -1), { ...last, content: (last.content ?? "") + chunk.content }];
                      }
                      return [...prev, buildAssistantEntry(chunk.content ?? "")];
                    });
                  }
                  if (chunk.type === "council_question" && chunk.councilQuestion) {
                    const cq3 = chunk.councilQuestion;
                    setPendingCouncilQuestionSync(cq3);
                    setCouncilCardStateSync(initialCardState(cq3));
                    // Task 2.2c — emit askcard-open in branch 3 (agent-mode only).
                    try {
                      agentRuntime?.emitEvent({
                        t: "event",
                        kind: "askcard-open",
                        questionId: cq3.questionId,
                        question: cq3.question,
                        phase: cq3.phase ?? "clarify",
                        optionCount: cq3.options?.length ?? 0,
                        defaultIndex: cq3.defaultIndex,
                      });
                    } catch {
                      /* best-effort */
                    }
                    logUIInteraction(agent.getSessionId() ?? undefined, {
                      subtype: "askcard_open",
                      data: {
                        questionId: cq3.questionId,
                        question: cq3.question,
                        phase: cq3.phase ?? "clarify",
                        optionCount: cq3.options?.length ?? 0,
                        defaultIndex: cq3.defaultIndex,
                        optionLabels: cq3.options?.map((o) => o.label),
                        recommendedLabel: cq3.options?.[cq3.defaultIndex ?? 0]?.label,
                      },
                    });
                  }
                  if (chunk.type === "council_preflight" && chunk.councilPreflight) {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.type === "assistant") {
                        return [
                          ...prev.slice(0, -1),
                          { ...last, content: (last.content ?? "") + (chunk.content ?? "") },
                        ];
                      }
                      return prev;
                    });
                    setPendingCouncilPreflight(chunk.councilPreflight);
                    setPreflightCardStateSync(initialCardState(buildPreflightQuestion(chunk.councilPreflight)));
                  }
                  if (chunk.type === "council_meta" && chunk.councilMeta) {
                    applyCouncilMetaPatch(chunk.councilMeta);
                  }
                  if (chunk.type === "council_round" && chunk.councilRound) {
                    applyCouncilRound(chunk.councilRound);
                  }
                  if (chunk.type === "council_message" && chunk.councilMessage) {
                    const cm = chunk.councilMessage;
                    setCouncilMessages((prev) => [...prev, cm]);
                    if (cm.kind === "debate" && cm.partner) {
                      const pairKey = makePairKey(cm.speaker.role, cm.partner.role);
                      storeQuote(pairKey, cm.speaker.role, cm.text);
                      setCouncilPlaceholders((prev) => {
                        const next = new Map(prev);
                        for (const [id, p] of next) {
                          if (p.role === cm.speaker.role) next.delete(id);
                        }
                        return next;
                      });
                    }
                  }
                  if (chunk.type === "council_status" && chunk.councilStatus) {
                    const cs = chunk.councilStatus;
                    // Placeholder "composing…" only for debate speaker turns
                    // (opening/exchange) — see the council_status handler above.
                    if (cs.state === "start" && cs.label && (cs.phase === "opening" || cs.phase === "exchange")) {
                      const placeholderRole = cs.label;
                      const isLeader = /^leader\b/i.test(placeholderRole);
                      const styleForRole = isLeader ? null : resolveStyle(placeholderRole);
                      const side: "left" | "right" = isLeader
                        ? "left"
                        : getSide(`placeholder::${placeholderRole}`, placeholderRole);
                      setCouncilPlaceholders((prev) => {
                        const next = new Map(prev);
                        next.set(cs.statusId, {
                          role: placeholderRole,
                          side,
                          color: styleForRole?.color ?? t.councilLeaderBorder,
                          variant: isLeader ? "leader" : "participant",
                          detail: cs.detail,
                        });
                        return next;
                      });
                    }
                    if (cs.state === "done" || cs.state === "error") {
                      councilDoneAtRef.current.set(cs.statusId, Date.now());
                      setCouncilPlaceholders((prev) => {
                        const next = new Map(prev);
                        next.delete(cs.statusId);
                        return next;
                      });
                    }
                    setCouncilStatuses((prev) => upsertStatus(prev, cs));
                    // Task 2.2b — emit council-speaker in branch 3 (agent-mode only).
                    try {
                      agentRuntime?.emitEvent(mapCouncilStatusToSpeakerEvent(cs));
                    } catch {
                      /* best-effort */
                    }
                  }
                  if (chunk.type === "council_phase" && chunk.councilPhase) {
                    const cp3 = chunk.councilPhase;
                    setCouncilPhases((prev) => upsertPhase(prev, cp3));
                    // Task 2.2 — emit council-step in branch 3 (agent-mode only).
                    try {
                      agentRuntime?.emitEvent({
                        t: "event",
                        kind: "council-step",
                        phaseId: cp3.phaseId,
                        phaseKind: cp3.kind,
                        state: cp3.state,
                        label: cp3.label,
                        elapsedMs: cp3.elapsedMs,
                      });
                    } catch {
                      /* best-effort */
                    }
                  }
                  if (chunk.type === "experience_warning" && chunk.experienceWarning) {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.type === "assistant") {
                        return [
                          ...prev.slice(0, -1),
                          {
                            ...last,
                            content: `${last.content ?? ""}\n⚠ [Experience] ${chunk.experienceWarning!.message}\nWhy: ${chunk.experienceWarning!.why}\n`,
                          },
                        ];
                      }
                      return [...prev, buildAssistantEntry(`⚠ [Experience] ${chunk.experienceWarning!.message}`)];
                    });
                  }
                  if (chunk.type === "experience_injected" && chunk.experienceInjected) {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.type === "assistant") {
                        return [
                          ...prev.slice(0, -1),
                          {
                            ...last,
                            content: `${last.content ?? ""}${formatExperienceInjectedBlock(chunk.experienceInjected!)}`,
                          },
                        ];
                      }
                      return [...prev, buildAssistantEntry(formatExperienceInjectedBlock(chunk.experienceInjected!))];
                    });
                  }
                  if (chunk.type === "done") break;
                  // C (latency UX): re-arm the inter-chunk heartbeat so the long
                  // silent gaps BETWEEN council phases (planDebate, each debate
                  // pair call, synthesis — 30-60s each on a slow provider) show a
                  // ticking "⏳ Council working… elapsed Ns" instead of a
                  // frozen-looking UI. The next chunk clears it at the top of the
                  // loop (clearInterCardHeartbeat), and finally clears it on exit.
                  startInterCardHeartbeat("Council working");
                }
              } catch (e: unknown) {
                setMessages((prev) => [...prev, buildAssistantEntry(`Council error: ${e}`)]);
              } finally {
                // Clear council ephemeral UI so the assistant message (containing
                // synthesis output + stats) becomes the bottommost visible content.
                // Without this, the persisted timeline hides the final result and
                // makes the council look stuck.
                setCouncilPhases([]);
                setCouncilStatuses([]);
                councilDoneAtRef.current.clear();
                // Stop any orphaned inter-card heartbeat so a finished/cancelled
                // run doesn't keep ticking "Waiting for next phase…".
                clearInterCardHeartbeat();
                // Release the processing flag re-armed before the run so the
                // composer returns to idle and a subsequent turn isn't blocked.
                isProcessingRef.current = false;
                setIsProcessing(false);
              }
              return;
            }

            setMessages((prev) => [...prev, buildAssistantEntry(result)]);
          })
          .catch((err: unknown) => {
            // A slash handler that throws must never escape as an unhandled
            // rejection — that path (headless) calls process.exit(1) and (TUI) is
            // now suppressed by setTuiActive, so without this the user is either
            // kicked out or sees nothing (e.g. /export when buildChatEntries' DB
            // read throws). Surface it in-band, log to crash.log, release the
            // composer.
            const emsg = err instanceof Error ? err.message : String(err);
            appendCrashLog("SLASH", `/${name}: ${err instanceof Error ? err.stack || err.message : emsg}`);
            setMessages((prev) => [...prev, buildAssistantEntry(`/${name} failed: ${emsg}`)]);
          })
          .finally(() => {
            isProcessingRef.current = false;
            setIsProcessing(false);
          });
        return true;
      }

      return false;
    },
    [
      agent,
      handleExit,
      openAgentsModal,
      openMcpModal,
      openSandboxPicker,
      openWalletPicker,
      openScheduleModal,
      processMessage,
      resetToNewSession,
      subAgents,
      model,
      messages.length,
      messages,
      setSessionPickerList,
      setSessionPickerIndex,
      setShowSessionPicker,
    ],
  );

  const handleSlashMenuSelect = useCallback(
    (item: SlashMenuItem) => {
      setShowSlashMenuSync(false);
      inputRef.current?.clear();
      switch (item.id) {
        case "new":
          resetToNewSession();
          break;
        case "providers":
        case "models":
          setShowModelPicker(true);
          setModelPickerIndex(0);
          setModelSearchQuery("");
          break;
        case "sandbox":
          openSandboxPicker();
          break;
        case "wallet":
          openWalletPicker();
          break;
        case "remote-control":
          setConnectModalIndex(0);
          setShowConnectModal(true);
          break;
        case "exit":
          handleExit();
          break;
        case "help":
          setMessages((p) => [
            ...p,
            {
              type: "assistant",
              content: VISIBLE_SLASH_MENU_ITEMS.map((i) => `/${i.label} — ${i.description}`).join("\n"),
              timestamp: new Date(),
            },
          ]);
          break;
        case "mcp":
          openMcpModal();
          break;
        case "review":
          processMessage(REVIEW_PROMPT);
          break;
        case "verify":
          processMessage(buildVerifyPrompt(agent.getCwd()));
          break;
        case "commit-push":
          processMessage(COMMIT_PUSH_PROMPT);
          break;
        case "commit-pr":
          processMessage(COMMIT_PR_PROMPT);
          break;
        case "council":
          inputRef.current?.clear();
          inputRef.current?.insertText("/council ");
          try {
            (inputRef.current as unknown as { focus?: () => void })?.focus?.();
          } catch {
            /* opentui versions vary */
          }
          break;
        case "update":
          setIsUpdating(true);
          setUpdateOutput(null);
          // Always echo into the message log — the home-screen `updateOutput`
          // banner only renders on the splash screen, so an /update run inside an
          // active chat would otherwise produce no visible output at all.
          setMessages((prev) => [...prev, buildAssistantEntry("🔄 Checking for updates...")]);
          runUpdate(startupConfig.version).then((result) => {
            setIsUpdating(false);
            const text = result.success ? result.output : `Update failed: ${result.output}`;
            setUpdateOutput(text);
            setMessages((prev) => [...prev, buildAssistantEntry(text)]);
          });
          break;
        case "clear":
          agent.clearHistory();
          resetToNewSession();
          break;
        case "resume": {
          // Open the picker (delegates to the same path as typing `/resume`)
          // so the user can pick a session and resume it directly instead of
          // having to remember the id + relaunch by hand.
          try {
            const { SessionStore } = require("../storage/sessions.js") as typeof import("../storage/sessions.js");
            const list = new SessionStore(agent.getCwd()).listRecentSessions(20);
            setSessionPickerList(list);
            setSessionPickerIndex(0);
            setShowSessionPicker(true);
          } catch (err) {
            console.error(`[session-picker] list failed: ${(err as Error)?.message ?? err}`);
            setMessages((p) => [
              ...p,
              {
                type: "assistant",
                content: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: new Date(),
              },
            ]);
          }
          break;
        }
        default: {
          // Dispatch to slash registry for registered commands (compact, cost, ee, route, plan, execute, discuss, expand, optimize, debug, council)
          dispatchSlash(item.id, [], {
            cwd: agent.getCwd(),
            tenantId: "local",
            defaultProvider: agent.getProviderId(),
            defaultModel: model,
            lastPrompt: messages[messages.length - 1]?.content,
            sessionId: agent.getSessionId() ?? undefined,
            getLiveEntries: () => messages,
          })
            .then(async (result) => {
              if (result === null) return;
              if (result.startsWith("__COMPACT__")) {
                const match = result.match(/Instructions:\s*(.+)/);
                const instructions = match ? match[1].trim() : "";
                const flowDir = path.join(agent.getCwd(), ".muonroi-flow");
                try {
                  const cr = await deliberateCompact(
                    flowDir,
                    agent.getMessages(),
                    "",
                    4096,
                    agent.getProvider(),
                    model,
                    instructions,
                  );
                  const sessionId = agent.getSessionId();
                  if (sessionId) {
                    const nextSeq = getNextMessageSequence(sessionId);
                    appendCompaction(sessionId, nextSeq, cr.summary, cr.tokensBeforeCompress);
                  }
                  const summaryMsg = createCompactionSummaryMessage(cr.summary);
                  agent.setMessages([summaryMsg]);
                  setMessages(agent.getChatEntries());
                  setMessages((prev) => [
                    ...prev,
                    buildAssistantEntry(
                      `Compaction: ${cr.decisionsExtracted} decisions extracted, ${cr.tokensBeforeCompress} → ${cr.tokensAfterCompress} tokens.\nSnapshot: ${cr.historyPath}`,
                    ),
                  ]);
                } catch (e: unknown) {
                  setMessages((prev) => [...prev, buildAssistantEntry(`Compaction failed: ${e}`)]);
                }
                return;
              }
              if (result.startsWith("__EXPAND__") || result.startsWith("__EXPAND_JSON__")) {
                const sessionId = agent.getSessionId();
                if (result.startsWith("__EXPAND_JSON__")) {
                  try {
                    const lines = result.split("\n");
                    const jsonStr = lines[1]!;
                    const restoredMessages = JSON.parse(jsonStr);
                    if (sessionId) {
                      revertLatestCompaction(sessionId);
                    }
                    agent.setMessages(restoredMessages);
                    setMessages(agent.getChatEntries());
                    const text = lines.slice(2).join("\n");
                    setMessages((prev) => [...prev, buildAssistantEntry(text)]);
                    return;
                  } catch (e) {
                    // fallback
                  }
                }
                const content = result.replace(/^__EXPAND__\n[^\n]*\n?/, "");
                setMessages((prev) => [...prev, buildAssistantEntry(`Restored session context:\n${content}`)]);
                return;
              }
              if (result.startsWith("__CLEAR__")) {
                const summary = result.replace(/^__CLEAR__\n/, "");
                agent.clearHistory();
                setMessages([buildAssistantEntry(`Session cleared and relocked.\n\n${summary}`)]);
                return;
              }
              if (result === "__PIN_LAST__") {
                const seq = agent.pinLastUserMessage();
                setMessages((prev) => [
                  ...prev,
                  buildAssistantEntry(
                    seq === null
                      ? "No user message to pin."
                      : `Pinned user message (seq=${seq}). It will survive compaction.`,
                  ),
                ]);
                return;
              }
              if (result.startsWith("__PIN_SEQ__")) {
                const seq = Number.parseInt(result.split("\n")[1] ?? "", 10);
                const ok = Number.isFinite(seq) && agent.pinMessageBySeq(seq);
                setMessages((prev) => [
                  ...prev,
                  buildAssistantEntry(
                    ok ? `Pinned message seq=${seq}.` : `Could not pin seq=${seq} (not found or not a user message).`,
                  ),
                ]);
                return;
              }
              if (result.startsWith("__UNPIN_SEQ__")) {
                const seq = Number.parseInt(result.split("\n")[1] ?? "", 10);
                const ok = Number.isFinite(seq) && agent.unpinMessageBySeq(seq);
                setMessages((prev) => [
                  ...prev,
                  buildAssistantEntry(ok ? `Unpinned seq=${seq}.` : `seq=${seq} was not pinned.`),
                ]);
                return;
              }
              if (result === "__PINS_LIST__") {
                const seqs = agent.getPinnedSeqs();
                setMessages((prev) => [
                  ...prev,
                  buildAssistantEntry(seqs.length === 0 ? "No pinned messages." : `Pinned seqs: ${seqs.join(", ")}`),
                ]);
                return;
              }
              if (result.startsWith("__COUNCIL__")) {
                const topic = result.replace(/^__COUNCIL__\n/, "");
                // No "Council convening..." placeholder — see the branch above:
                // the content handler creates a fresh assistant entry on demand,
                // so seeding one only produced 0s-noise + prepended the real reply.
                setMessages((prev) => [...prev, buildUserEntry(`/council ${topic}`)]);
                try {
                  const gen = agent.runCouncilRound(topic);
                  for await (const chunk of gen) {
                    if (chunk.type === "content") {
                      setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last?.type === "assistant") {
                          return [...prev.slice(0, -1), { ...last, content: (last.content ?? "") + chunk.content }];
                        }
                        return [...prev, buildAssistantEntry(chunk.content ?? "")];
                      });
                    }
                    if (chunk.type === "done") break;
                  }
                } catch (e: unknown) {
                  setMessages((prev) => [...prev, buildAssistantEntry(`Council error: ${e}`)]);
                }
                return;
              }
              setMessages((prev) => [...prev, buildAssistantEntry(result)]);
            })
            .catch((err: unknown) => {
              // See the typed-slash .catch above: a throwing slash handler must
              // surface in-band, never become a fatal unhandledRejection.
              const emsg = err instanceof Error ? err.message : String(err);
              appendCrashLog("SLASH", `/${item.id}: ${err instanceof Error ? err.stack || err.message : emsg}`);
              setMessages((prev) => [...prev, buildAssistantEntry(`/${item.id} failed: ${emsg}`)]);
            })
            .finally(() => {
              isProcessingRef.current = false;
              setIsProcessing(false);
            });
          return true;
        }
      }
    },
    [
      agent,
      handleExit,
      model,
      messages,
      openMcpModal,
      openSandboxPicker,
      openWalletPicker,
      processMessage,
      resetToNewSession,
      startupConfig.version,
      setShowSlashMenuSync,
      setModelPickerIndex,
      setModelSearchQuery,
      setShowModelPicker,
      setSessionPickerList,
      setSessionPickerIndex,
      setShowSessionPicker,
    ],
  );

  const blockPrompt =
    showConnectModal ||
    showTelegramTokenModal ||
    showTelegramPairModal ||
    showMcpModal ||
    showSandboxPicker ||
    showSessionPicker ||
    showWalletPicker ||
    !!pendingPaymentApproval ||
    showScheduleModal ||
    showAgentsModal ||
    showAgentsEditor ||
    showUpdateModal ||
    // Overlay forms — when these are up the composer textarea must NOT capture
    // Enter, otherwise PromptBox.onSubmit fires first and swallows the key
    // before the global useKeyboard handler can route it to the overlay's
    // own Enter handler (halt-card → init-new, init-new step transitions,
    // point-to-existing path validation).
    activeHaltCard !== null ||
    initNewForm !== null ||
    pointToExistingForm !== null;

  const showPlanPanel = !!activePlan?.questions?.length;
  const planQuestions = activePlan?.questions ?? [];
  const isSinglePlan = planQuestions.length === 1 && planQuestions[0]?.type !== "multiselect";
  const planTabCount = isSinglePlan ? 1 : planQuestions.length + 1;
  const isPlanConfirmTab = !isSinglePlan && pqs.tab === planQuestions.length;

  const dismissPlan = useCallback(() => {
    setActivePlan(null);
    setPqs(initialPlanQuestionsState());
  }, []);

  const submitPlanAnswers = useCallback(() => {
    if (!activePlan?.questions?.length) return;
    const text = formatPlanAnswers(activePlan.questions, pqs.answers);
    setActivePlan(null);
    setPqs(initialPlanQuestionsState());
    processMessage(text);
  }, [activePlan, pqs.answers, processMessage]);

  const handlePlanSelect = useCallback(
    (q: PlanQuestion, idx: number, options: { id: string; label: string }[], showCustom: boolean) => {
      const isCustom = showCustom && idx === options.length;
      if (isCustom) {
        if (q.type === "multiselect") {
          const customVal = pqs.customInputs[q.id] ?? "";
          if (customVal) {
            const existing = (pqs.answers[q.id] as string[] | undefined) ?? [];
            if (existing.includes(customVal)) {
              setPqs((s) => ({ ...s, answers: { ...s.answers, [q.id]: existing.filter((x) => x !== customVal) } }));
            } else {
              setPqs((s) => ({ ...s, editing: true }));
            }
          } else {
            setPqs((s) => ({ ...s, editing: true }));
          }
        } else {
          setPqs((s) => ({ ...s, editing: true }));
        }
        return;
      }
      const opt = options[idx];
      if (!opt) return;

      if (q.type === "multiselect") {
        setPqs((s) => {
          const existing = (s.answers[q.id] as string[] | undefined) ?? [];
          const next = existing.includes(opt.id) ? existing.filter((x) => x !== opt.id) : [...existing, opt.id];
          return { ...s, answers: { ...s.answers, [q.id]: next } };
        });
      } else {
        setPqs((s) => ({ ...s, answers: { ...s.answers, [q.id]: opt.id } }));
        if (isSinglePlan) {
          submitPlanAnswers();
          return;
        }
        setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
      }
    },
    [pqs, isSinglePlan, submitPlanAnswers],
  );

  const dismissBtw = useCallback(() => {
    btwAbortRef.current?.abort();
    btwAbortRef.current = null;
    btwStateRef.current = null;
    setBtwState(null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setters from useMcpEditor/useModelPicker hooks are stable useState setters (stable identity across renders)
  const handleKey = useCallback(
    (key: KeyEvent) => {
      // Ctrl+G — mark the most-recent surfaced experience hints as noise.
      // Sends IRRELEVANT verdict with reason='wrong_task' for every match
      // in the last intercept batch. Default to wrong_task because we can't
      // detect lang/repo mismatch from a keypress; user can use the
      // exp-feedback CLI for more precise narrowing.
      if (key.name === "g" && key.ctrl && !key.meta) {
        const matches = getLastSurfacedMatches();
        if (matches.length > 0) {
          const client = getDefaultEEClient();
          for (const m of matches) {
            try {
              client.noiseFeedback({
                pointId: m.principleUuid,
                collection: m.collection,
                reason: "wrong_task",
              });
            } catch {
              /* fail-open */
            }
          }
          clearLastSurfacedMatches();
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry(`🚫 [Experience] Marked ${matches.length} hint(s) as noise (wrong_task).`),
          ]);
        }
        return;
      }

      // Ctrl+O — toggle the council debate transcript pill between the collapsed
      // summary/tail and the full back-and-forth. Global (unbound elsewhere); a
      // no-op visually when no debate turns exist, so an unconditional toggle is
      // safe and avoids threading councilMessages into this useCallback.
      if (key.name === "o" && key.ctrl && !key.meta) {
        setCouncilTranscriptExpanded((v) => !v);
        return;
      }

      // Ctrl+E — peek the full todo panel while it is auto-collapsed during a
      // council debate (app.tsx collapses it to one line so the debate scrollbox
      // keeps its height). Global + unconditional toggle; a no-op visually when
      // no todo snapshot exists or no council is active.
      if (key.name === "e" && key.ctrl && !key.meta) {
        setCouncilTodoExpanded((v) => !v);
        return;
      }

      // Ctrl+B — toggle the right context rail (MUONROI_CONTEXT_RAIL). No-op
      // visually when the rail flag is off or the terminal is too narrow; the
      // toggle only flips intent, app.tsx gates actual rendering on width.
      if (key.name === "b" && key.ctrl && !key.meta) {
        setRailVisible((v) => !v);
        return;
      }

      // P2/D — Ctrl+←/→ scope the main transcript to a single debate round (and
      // back to the global view). Composer-aware: only when the prompt is empty,
      // so Ctrl+arrows still do word-nav while composing. No-op when no rounds
      // exist. Mirrors the rail's clickable round list (council-rail-rounds).
      if (key.ctrl && !key.meta && (key.name === "left" || key.name === "right")) {
        const rounds = councilRoundsRef.current;
        if (rounds.length > 0) {
          const composerEmpty = !(inputRef.current?.plainText ?? "").trim();
          if (composerEmpty) {
            const nums = rounds.map((r) => r.round);
            setSelectedRound((cur) => cycleRoundSelection(nums, cur, key.name === "right" ? 1 : -1));
            return;
          }
        }
      }

      // Scroll-lock navigation (MUONROI_SCROLL_LOCK). Composer-aware: only act
      // when the prompt input is empty, so End/PageUp/PageDown still edit text
      // while composing. End re-pins to the live tail; PageUp/PageDown page the
      // transcript by one viewport without disturbing the composer.
      if (isScrollLockEnabled() && !key.ctrl && !key.meta) {
        const composerEmpty = !(inputRef.current?.plainText ?? "").trim();
        if (composerEmpty && (key.name === "pageup" || key.name === "pagedown" || key.name === "end")) {
          const sb = scrollRef.current;
          if (key.name === "end") {
            scrollToBottomForced();
            return;
          }
          if (sb) {
            const vpH = (sb.viewport as unknown as { height?: number }).height ?? 10;
            const page = Math.max(1, vpH - 1);
            try {
              sb.scrollBy(key.name === "pageup" ? -page : page);
            } catch {
              /* */
            }
            // Paging up leaves the tail; paging back to bottom clears the pill.
            if (key.name === "pagedown" && isPinnedToBottom()) {
              newSinceLockRef.current = 0;
              setNewSinceLock(0);
              setScrollLockedAway(false);
            }
          }
          return;
        }
      }

      // Point-to-existing form intercepts all input while open.
      if (pointToExistingForm) {
        if (pointToExistingForm.step === "input") {
          if (isEscapeKey(key)) {
            setPointToExistingForm(null);
            return;
          }
          if (key.name === "return") {
            const rawPath = pointToExistingForm.pathInput.trim();
            if (!rawPath) {
              setPointToExistingForm((s) => (s ? { ...s, errorMessage: "Path cannot be empty." } : s));
              return;
            }
            setPointToExistingForm((s) => (s ? { ...s, step: "loading", errorMessage: null } : s));
            pointToExisting({
              path: rawPath,
              detectVerifyRecipe: async (cwd) => {
                // Filesystem recipe detection for the pointed-to project. The
                // orchestrator's LLM verify-detect runs against the SESSION cwd (via
                // this.bash.getCwd()), not this arbitrary path, so a pure-fs inference
                // is the correct detector here (see detectExistingProjectRecipe).
                // Previously stubbed to `return null` while the seam was deferred,
                // which left this recovery option permanently inert.
                try {
                  return detectExistingProjectRecipe(cwd);
                } catch (err) {
                  console.error(`[point-to-existing] recipe detection failed for ${cwd}: ${(err as Error)?.message}`);
                  return null;
                }
              },
            })
              .then((result) => {
                if (result.ok) {
                  const adoptedDir = result.absolutePath;
                  setPointToExistingForm((s) =>
                    s ? { ...s, step: "done", resultPath: adoptedDir, errorMessage: null } : s,
                  );
                  // Re-enter the /ideal loop in the adopted project so the halted
                  // run actually continues (mirrors the init_new resume seam:
                  // switch the agent cwd, then re-dispatch the original request as a
                  // fresh turn). Without this the card only reported "done" and the
                  // run stayed halted. Deferred to setTimeout so the "done" frame
                  // paints before the continuation turn takes over input.
                  const originalPrompt = originalIdealPromptRef.current;
                  if (originalPrompt) {
                    setTimeout(() => {
                      try {
                        agent.setCwd(adoptedDir);
                      } catch (err) {
                        console.error(`[point-to-existing] setCwd(${adoptedDir}) failed: ${(err as Error)?.message}`);
                      }
                      logUIInteraction(sessionId, {
                        subtype: "point_to_existing_resume",
                        data: { projectDir: adoptedDir, originalPrompt },
                      });
                      originalIdealPromptRef.current = null;
                      setPointToExistingForm(null);
                      void processMessageRef.current(
                        buildAdoptExistingContinuationPrompt({ originalPrompt, projectDir: adoptedDir }),
                        "(resuming /ideal in existing project)",
                      );
                    }, 500);
                  }
                } else if (result.reason === "not_a_dir") {
                  setPointToExistingForm((s) =>
                    s ? { ...s, step: "input", errorMessage: "Path does not exist or is not a directory." } : s,
                  );
                } else {
                  // no_recipe
                  setPointToExistingForm((s) =>
                    s
                      ? {
                          ...s,
                          step: "error",
                          errorMessage:
                            "No verify recipe found at " +
                            result.absolutePath +
                            ". Try a different directory or pick 'Init new' instead.",
                        }
                      : s,
                  );
                }
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                setPointToExistingForm((s) => (s ? { ...s, step: "error", errorMessage: msg } : s));
              });
            return;
          }
          if (key.name === "backspace" || key.name === "delete") {
            setPointToExistingForm((s) => (s ? { ...s, pathInput: s.pathInput.slice(0, -1), errorMessage: null } : s));
            return;
          }
          if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
            setPointToExistingForm((s) =>
              s ? { ...s, pathInput: s.pathInput + key.sequence, errorMessage: null } : s,
            );
            return;
          }
          return;
        }
        // done / error — any key dismisses. loading ignores keys.
        if (pointToExistingForm.step === "done" || pointToExistingForm.step === "error") {
          setPointToExistingForm(null);
          return;
        }
        return;
      }
      // Init-new form intercepts all input while open.
      if (initNewForm) {
        if (initNewForm.step === "name") {
          if (isEscapeKey(key)) {
            setInitNewForm(null);
            return;
          }
          if (key.name === "return") {
            const name = initNewForm.nameInput.trim();
            if (!name) {
              setInitNewForm((s) => (s ? { ...s, nameError: "Project name cannot be empty." } : s));
              return;
            }
            if (name.includes("/") || name.includes("\\") || name.includes("..")) {
              setInitNewForm((s) => (s ? { ...s, nameError: "Name cannot contain path separators." } : s));
              return;
            }
            setInitNewForm((s) => (s ? { ...s, step: "fe-stack", nameError: null } : s));
            return;
          }
          if (key.name === "backspace" || key.name === "delete") {
            setInitNewForm((s) => (s ? { ...s, nameInput: s.nameInput.slice(0, -1), nameError: null } : s));
            return;
          }
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            setInitNewForm((s) => (s ? { ...s, nameInput: s.nameInput + key.sequence, nameError: null } : s));
            return;
          }
          return;
        }
        if (initNewForm.step === "fe-stack") {
          if (isEscapeKey(key)) {
            setInitNewForm((s) => (s ? { ...s, step: "name" } : s));
            return;
          }
          if (key.name === "up") {
            setInitNewForm((s) => (s ? { ...s, feStackIndex: Math.max(0, s.feStackIndex - 1) } : s));
            return;
          }
          if (key.name === "down") {
            setInitNewForm((s) =>
              s ? { ...s, feStackIndex: Math.min(FE_STACK_OPTIONS.length - 1, s.feStackIndex + 1) } : s,
            );
            return;
          }
          if (key.name === "return") {
            // Plan 23-02 — when /ideal intent is captured, route through EE design.
            if (initNewForm.intent.trim().length > 0) {
              setInitNewForm((s) => (s ? { ...s, step: "designing", designError: null } : s));
              (async () => {
                try {
                  const { designBBPackages } = await import("../ee/bb-design.js");
                  const result = await designBBPackages(initNewForm.intent, {
                    allowCommercial: initNewForm.allowCommercial,
                  });
                  setInitNewForm((s) => {
                    if (!s) return s;
                    if (result) {
                      return {
                        ...s,
                        step: "design-preview",
                        bbDesign: result,
                        packageToggles: result.packageIds.map(() => true),
                        designCursor: 0,
                      };
                    }
                    return { ...s, step: "bb-template", designError: "EE unavailable" };
                  });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  setInitNewForm((s) => (s ? { ...s, step: "bb-template", designError: msg } : s));
                }
              })();
              return;
            }
            // No intent → manual template picker (task 6.2a, back-compat).
            setInitNewForm((s) => (s ? { ...s, step: "bb-template" } : s));
            return;
          }
          return;
        }
        // Plan 23-02 — EE designing step. Esc skips to manual menu; ignore other keys.
        if (initNewForm.step === "designing") {
          if (isEscapeKey(key)) {
            setInitNewForm((s) => (s ? { ...s, step: "bb-template" } : s));
            return;
          }
          return;
        }
        // Plan 23-02 — EE design-preview step: navigate / toggle / confirm.
        if (initNewForm.step === "design-preview") {
          if (isEscapeKey(key)) {
            setInitNewForm((s) => (s ? { ...s, step: "bb-template" } : s));
            return;
          }
          if (key.name === "up") {
            setInitNewForm((s) => (s ? { ...s, designCursor: Math.max(0, s.designCursor - 1) } : s));
            return;
          }
          if (key.name === "down") {
            setInitNewForm((s) =>
              s
                ? {
                    ...s,
                    designCursor: Math.min((s.bbDesign?.packageIds.length ?? 1) - 1, s.designCursor + 1),
                  }
                : s,
            );
            return;
          }
          if (key.name === "space" || key.sequence === " ") {
            setInitNewForm((s) => {
              if (!s?.bbDesign) return s;
              const toggles = [...s.packageToggles];
              toggles[s.designCursor] = !(toggles[s.designCursor] ?? true);
              return { ...s, packageToggles: toggles };
            });
            return;
          }
          if (key.sequence === "c" || key.sequence === "C") {
            // Toggle commercial flag + re-run design.
            const nextAllowCommercial = !initNewForm.allowCommercial;
            setInitNewForm((s) =>
              s
                ? {
                    ...s,
                    step: "designing",
                    allowCommercial: nextAllowCommercial,
                    designError: null,
                  }
                : s,
            );
            (async () => {
              try {
                const { designBBPackages } = await import("../ee/bb-design.js");
                const result = await designBBPackages(initNewForm.intent, {
                  allowCommercial: nextAllowCommercial,
                });
                setInitNewForm((s) => {
                  if (!s) return s;
                  if (result) {
                    return {
                      ...s,
                      step: "design-preview",
                      bbDesign: result,
                      packageToggles: result.packageIds.map(() => true),
                      designCursor: 0,
                    };
                  }
                  return { ...s, step: "bb-template", designError: "EE unavailable" };
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setInitNewForm((s) => (s ? { ...s, step: "bb-template", designError: msg } : s));
              }
            })();
            return;
          }
          if (key.name === "return") {
            const design = initNewForm.bbDesign;
            if (!design) return;
            const selectedPackages = design.packageIds.filter((_, i) => initNewForm.packageToggles[i] ?? true);
            const feStack = FE_STACK_OPTIONS[initNewForm.feStackIndex]?.value ?? "react";
            const projectName = initNewForm.nameInput.trim();
            const commercial = initNewForm.allowCommercial;
            const replayInputs = {
              projectName,
              feStack,
              bbTemplate: design.template,
              eePackages: selectedPackages,
              commercial,
            };
            void runScaffoldAttempt(replayInputs);
            return;
          }
          return;
        }
        // Task 6.2a — BB template picker step
        if (initNewForm.step === "bb-template") {
          if (isEscapeKey(key)) {
            setInitNewForm((s) => (s ? { ...s, step: "fe-stack" } : s));
            return;
          }
          if (key.name === "up") {
            setInitNewForm((s) => (s ? { ...s, bbTemplateIndex: Math.max(0, s.bbTemplateIndex - 1) } : s));
            return;
          }
          if (key.name === "down") {
            setInitNewForm((s) =>
              s ? { ...s, bbTemplateIndex: Math.min(BB_TEMPLATE_OPTIONS.length - 1, s.bbTemplateIndex + 1) } : s,
            );
            return;
          }
          if (key.name === "return") {
            const feStack = FE_STACK_OPTIONS[initNewForm.feStackIndex]?.value ?? "react";
            const bbTemplate = BB_TEMPLATE_OPTIONS[initNewForm.bbTemplateIndex]?.info;
            const projectName = initNewForm.nameInput.trim();
            const replayInputs = { projectName, feStack, bbTemplate };
            void runScaffoldAttempt(replayInputs);
            return;
          }
          return;
        }
        // Error step — R retries with stored inputs (no debate re-run); any
        // other key dismisses. running ignores keys; done dismisses too.
        if (initNewForm.step === "error") {
          if (
            initNewForm.errorRetryable &&
            initNewForm.replayInputs &&
            (key.name === "r" || key.sequence === "r" || key.sequence === "R")
          ) {
            void runScaffoldAttempt(initNewForm.replayInputs);
            return;
          }
          setInitNewForm(null);
          return;
        }
        if (initNewForm.step === "done") {
          setInitNewForm(null);
          return;
        }
        return;
      }
      // Halt recovery card intercepts all input until dismissed.
      if (activeHaltCard) {
        if (isEscapeKey(key)) {
          setActiveHaltCard(null);
          setHaltSelectedIndex(0);
          return;
        }
        if (key.name === "up") {
          setHaltSelectedIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setHaltSelectedIndex((i) => Math.min(activeHaltCard.recovery_options.length - 1, i + 1));
          return;
        }
        if (key.name === "return") {
          const chosen = activeHaltCard.recovery_options[haltSelectedIndex];
          if (chosen) {
            logUIInteraction(agent.getSessionId() ?? undefined, {
              subtype: "halt_card_answered",
              data: { chosenId: chosen.id, chosenLabel: chosen.label, index: haltSelectedIndex },
            });
            if (chosen.id === "init_new") {
              // Abort any in-flight LLM stream so its text reply doesn't bleed
              // into the TUI while the init-new form runs (observed session
              // 6ff8dabe1aa7: hot-path "Bạn muốn tạo..." reply landed 20s
              // after halt-card was answered, mid-scaffold).
              interruptActiveRun();
              setInitNewForm(initialInitNewFormState(lastIdealIdeaRef.current));
              setActiveHaltCard(null);
              setHaltSelectedIndex(0);
              return;
            }
            if (chosen.id === "point_to_existing") {
              interruptActiveRun();
              setPointToExistingForm(initialPointToExistingFormState());
              setActiveHaltCard(null);
              setHaltSelectedIndex(0);
              return;
            }
            if (chosen.id === "continue_as_council") {
              interruptActiveRun();
              setActiveHaltCard(null);
              setHaltSelectedIndex(0);
              void continueAsCouncil({ prompt: activeHaltCard.detail ?? "(no prompt)" })
                .then((r) => {
                  setCouncilProgress({ status: "done", specPath: r.specPath, hasContent: r.hasContent });
                })
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  setCouncilProgress({ status: "error", specPath: "", hasContent: false, error: msg });
                });
              setCouncilProgress({ status: "running", specPath: "", hasContent: false });
              return;
            }
            // A — sprint-break recovery. Resume/Retry/Abort re-dispatch through
            // the existing `/ideal` slash pipeline; the runId is optional because
            // runResume/runAbort auto-detect the newest incomplete run (A/B).
            if (
              chosen.id === "resume" ||
              chosen.id === "retry" ||
              chosen.id === "skip_verify" ||
              chosen.id === "abort"
            ) {
              interruptActiveRun();
              const rid = activeHaltCard.runId ? ` ${activeHaltCard.runId}` : "";
              setActiveHaltCard(null);
              setHaltSelectedIndex(0);
              if (chosen.id === "abort") {
                handleCommand(`/ideal abort${rid}`);
              } else {
                if (chosen.id === "skip_verify") {
                  // Consumed by sprint-runner Step 5; reset on the next fresh start.
                  process.env.MUONROI_SPRINT_SKIP_VERIFY = "1";
                }
                handleCommand(`/ideal resume${rid}`);
              }
              return;
            }
            console.log("halt recovery: unknown option id:", chosen.id);
          }
          setActiveHaltCard(null);
          setHaltSelectedIndex(0);
          return;
        }
        return;
      }
      if (btwState) {
        if (isEscapeKey(key) || key.name === "return") {
          dismissBtw();
        }
        return;
      }
      // Use ref instead of React state: a synchronous keyboard burst from
      // the harness arriving right after askcard-open emit can race React's
      // batched setState commit. Ref is updated synchronously in
      // setPendingCouncilQuestionSync so the handler sees the new question
      // immediately. (Mirror of councilCardStateRef pattern.)
      const pendingQuestion = pendingCouncilQuestionRef.current;
      if (pendingQuestion && councilCardStateRef.current) {
        const cardKey = mapCouncilCardKey(key);
        if (cardKey) {
          // Mark the key consumed BEFORE mutating card state: the renderer's
          // internal Escape listener (onInternalKey → interruptActiveRun) runs
          // AFTER this handler in the same dispatch, and by then the cancel
          // branch below has already nulled pendingCouncilQuestionRef — so the
          // ref guard alone can't tell "card just handled this Esc" from "no
          // card at all", and Stage 2 wiped the whole debate transcript
          // (live-verified stack trace 2026-07-06).
          key.preventDefault?.();
          key.stopPropagation?.();
          const result = reduceCardKey(pendingQuestion, councilCardStateRef.current, cardKey);
          setCouncilCardStateSync(result.state);
          if (result.emit?.type === "answer") {
            const qid = pendingQuestion.questionId;
            const ans = result.emit.answer;
            // Tool-loop-cap askcards bypass the council answer machinery — the
            // verdict resolves a stored Promise that's awaited inside the
            // streamText stopWhen predicate. Drain the resolver, emit the
            // harness event, and return so the council path doesn't see this.
            if (pendingQuestion.phase === "tool-loop-cap") {
              const resolver = toolLoopCapResolversRef.current.get(qid);
              toolLoopCapResolversRef.current.delete(qid);
              setPendingCouncilQuestionSync(null);
              setCouncilCardStateSync(null);
              const verdict = ans.text === "continue" ? "continue" : "stop";
              resolver?.(verdict);
              try {
                agentRuntime?.emitEvent({
                  t: "event",
                  kind: "askcard-answered",
                  questionId: qid,
                  answerKind: ans.kind ?? "choice",
                  answerText: verdict,
                });
              } catch {
                /* best-effort */
              }
              logUIInteraction(agent.getSessionId() ?? undefined, {
                subtype: "askcard_answered",
                data: { questionId: qid, answerKind: "choice", answerText: verdict },
              });
              return;
            }
            // Safety-override askcard: resolve the stored promise with the
            // user's verdict (allow-once / allow-session / block).
            if (pendingQuestion.phase === "safety-override") {
              const resolver = safetyOverrideResolversRef.current.get(qid);
              safetyOverrideResolversRef.current.delete(qid);
              setPendingCouncilQuestionSync(null);
              setCouncilCardStateSync(null);
              let parsed: SafetyOverrideVerdict;
              if (ans.text === "allow-once" || ans.text === "allow-session") {
                parsed = { action: ans.text };
              } else {
                parsed = { action: "block" };
              }
              resolver?.(parsed);
              try {
                agentRuntime?.emitEvent({
                  t: "event",
                  kind: "askcard-answered",
                  questionId: qid,
                  answerKind: ans.kind ?? "choice",
                  answerText: ans.text,
                });
              } catch {
                /* best-effort */
              }
              logUIInteraction(agent.getSessionId() ?? undefined, {
                subtype: "askcard_answered",
                data: { questionId: qid, answerKind: "choice", answerText: ans.text },
              });
              return;
            }
            // ask_user askcard: resolve the stored promise with the user's
            // answer string (option value or free text) — becomes the tool result.
            if (pendingQuestion.phase === "ask-user") {
              const resolver = askUserResolversRef.current.get(qid);
              askUserResolversRef.current.delete(qid);
              setPendingCouncilQuestionSync(null);
              setCouncilCardStateSync(null);
              resolver?.(ans.text);
              try {
                agentRuntime?.emitEvent({
                  t: "event",
                  kind: "askcard-answered",
                  questionId: qid,
                  answerKind: ans.kind ?? "choice",
                  answerText: ans.text,
                });
              } catch {
                /* best-effort */
              }
              logUIInteraction(agent.getSessionId() ?? undefined, {
                subtype: "askcard_answered",
                data: { questionId: qid, answerKind: ans.kind ?? "choice", answerText: ans.text },
              });
              return;
            }
            // Resolve the label of the option that was selected. For "choice"
            // and "freetext" the option index lives on the card state; for
            // "chat" the user typed a free reply and there is no option to
            // reference. The label gives forensics tooling the recommendation
            // value next to the bare answerText (e.g. "accept" vs. the actual
            // recommendation string "Recommended: 'saas' — …").
            const cardOptions = pendingQuestion.options ?? [];
            const cardIdx = councilCardStateRef.current?.idx ?? -1;
            const selectedOptionLabel =
              ans.kind === "choice" || ans.kind === "freetext" ? cardOptions[cardIdx]?.label : undefined;
            setPendingCouncilQuestionSync(null);
            setCouncilCardStateSync(null);
            agent.respondToCouncilQuestion(qid, ans.text, pendingQuestion.question);
            // Suppress the transcript echo for no-op "Skip — leave as-is" choices:
            // they contribute nothing, and a post-debate refine over N sections
            // produces N blank "· Skip" user rows (transcript garbage — see the
            // 2217600e1f27 export). Every real answer / non-skip choice still echoes.
            const isNoopSkip = ans.kind === "choice" && !ans.text.trim() && /^skip\b/i.test(selectedOptionLabel ?? "");
            if (!isNoopSkip) {
              setMessages((prev) => [
                ...prev,
                buildUserEntry(
                  formatAnswerForLog(ans, {
                    selectedOptionLabel,
                    questionId: pendingQuestion.question?.match(/^Question:\s*(\w+)/)?.[1],
                  }),
                ),
              ]);
            }
            // E2 — start a heartbeat while we wait for the NEXT chunk from
            // /ideal (next AskCard, council phase tick, or sprint stage event).
            // chunk loop clears it on first arrival.
            startInterCardHeartbeat("Waiting for next phase");
            // Task 2.4 — emit askcard-answered harness event (agent-mode only).
            try {
              agentRuntime?.emitEvent({
                t: "event",
                kind: "askcard-answered",
                questionId: qid,
                answerKind: ans.kind ?? "choice",
                answerText: ans.text,
              });
            } catch {
              /* best-effort */
            }
            logUIInteraction(agent.getSessionId() ?? undefined, {
              subtype: "askcard_answered",
              data: {
                questionId: qid,
                answerKind: ans.kind ?? "choice",
                answerText: ans.text,
                ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
              },
            });
          } else if (result.emit?.type === "cancel") {
            const qid = pendingQuestion.questionId;
            // Tool-loop-cap cancel → treat as "stop" (user wants out, not loop).
            if (pendingQuestion.phase === "tool-loop-cap") {
              const resolver = toolLoopCapResolversRef.current.get(qid);
              toolLoopCapResolversRef.current.delete(qid);
              setPendingCouncilQuestionSync(null);
              setCouncilCardStateSync(null);
              clearInterCardHeartbeat();
              resolver?.("stop");
              try {
                agentRuntime?.emitEvent({ t: "event", kind: "askcard-cancel", questionId: qid });
              } catch {
                /* best-effort */
              }
              return;
            }
            // Safety-override cancel → treat as "block" (user wants out).
            if (pendingQuestion.phase === "safety-override") {
              const resolver = safetyOverrideResolversRef.current.get(qid);
              safetyOverrideResolversRef.current.delete(qid);
              setPendingCouncilQuestionSync(null);
              setCouncilCardStateSync(null);
              clearInterCardHeartbeat();
              resolver?.({ action: "block" });
              try {
                agentRuntime?.emitEvent({ t: "event", kind: "askcard-cancel", questionId: qid });
              } catch {
                /* best-effort */
              }
              return;
            }
            // ask_user cancel (Esc) → resolve with the dismissed sentinel; the
            // agent reads it and decides its own follow-up (never CLI-forced).
            if (pendingQuestion.phase === "ask-user") {
              const resolver = askUserResolversRef.current.get(qid);
              askUserResolversRef.current.delete(qid);
              setPendingCouncilQuestionSync(null);
              setCouncilCardStateSync(null);
              clearInterCardHeartbeat();
              resolver?.(ASK_USER_DISMISSED);
              try {
                agentRuntime?.emitEvent({ t: "event", kind: "askcard-cancel", questionId: qid });
              } catch {
                /* best-effort */
              }
              return;
            }
            setPendingCouncilQuestionSync(null);
            setCouncilCardStateSync(null);
            clearInterCardHeartbeat();
            agent.respondToCouncilQuestion(qid, "", pendingQuestion.question);
            // Task 2.4 — emit askcard-cancel harness event (agent-mode only).
            try {
              agentRuntime?.emitEvent({
                t: "event",
                kind: "askcard-cancel",
                questionId: qid,
              });
            } catch {
              /* best-effort */
            }
            logUIInteraction(agent.getSessionId() ?? undefined, {
              subtype: "askcard_cancel",
              data: { questionId: qid },
            });
          }
          return;
        }
      }
      if (showPlanPanel) {
        const q = planQuestions[pqs.tab];

        // Escape always dismisses
        if (isEscapeKey(key)) {
          dismissPlan();
          return;
        }

        // When editing custom text input
        if (pqs.editing && !isPlanConfirmTab) {
          if (key.name === "return") {
            const qId = q?.id;
            if (qId) {
              const text = (pqs.customInputs[qId] ?? "").trim();
              if (text) {
                if (q.type === "multiselect") {
                  const existing = (pqs.answers[qId] as string[] | undefined) ?? [];
                  const next = existing.includes(text) ? existing : [...existing, text];
                  setPqs((s) => ({ ...s, editing: false, answers: { ...s.answers, [qId]: next } }));
                } else if (q.type === "text") {
                  setPqs((s) => ({ ...s, editing: false, answers: { ...s.answers, [qId]: text } }));
                  if (isSinglePlan) {
                    submitPlanAnswers();
                    return;
                  }
                  setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
                } else {
                  setPqs((s) => ({ ...s, editing: false, answers: { ...s.answers, [qId]: text } }));
                  if (isSinglePlan) {
                    submitPlanAnswers();
                    return;
                  }
                  setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
                }
              } else {
                setPqs((s) => ({ ...s, editing: false }));
              }
            }
            return;
          }
          if (key.name === "backspace") {
            const qId = q?.id;
            if (qId)
              setPqs((s) => ({
                ...s,
                customInputs: { ...s.customInputs, [qId]: (s.customInputs[qId] ?? "").slice(0, -1) },
              }));
            return;
          }
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            const qId = q?.id;
            if (qId)
              setPqs((s) => ({
                ...s,
                customInputs: { ...s.customInputs, [qId]: (s.customInputs[qId] ?? "") + key.sequence },
              }));
            return;
          }
          return;
        }

        // Tab / left / right — switch between question tabs
        if (key.name === "tab") {
          const dir = key.shift ? -1 : 1;
          setPqs((s) => ({ ...s, tab: (s.tab + dir + planTabCount) % planTabCount, selected: 0 }));
          return;
        }
        if (key.name === "left" || key.name === "h") {
          setPqs((s) => ({ ...s, tab: (s.tab - 1 + planTabCount) % planTabCount, selected: 0 }));
          return;
        }
        if (key.name === "right" || key.name === "l") {
          setPqs((s) => ({ ...s, tab: (s.tab + 1) % planTabCount, selected: 0 }));
          return;
        }

        // Confirm tab
        if (isPlanConfirmTab) {
          if (key.name === "return") {
            submitPlanAnswers();
            return;
          }
          return;
        }

        if (!q) return;

        // Text-only question (no options)
        if (q.type === "text") {
          setPqs((s) => ({ ...s, editing: true }));
          return;
        }

        // Up/down — navigate options
        const options = q.options ?? [];
        const showCustom = true;
        const totalItems = options.length + 1;

        if (key.name === "up" || key.name === "k") {
          setPqs((s) => ({ ...s, selected: (s.selected - 1 + totalItems) % totalItems }));
          return;
        }
        if (key.name === "down" || key.name === "j") {
          setPqs((s) => ({ ...s, selected: (s.selected + 1) % totalItems }));
          return;
        }

        // Number keys 1-9 for quick selection
        const digit = Number(key.name);
        if (!Number.isNaN(digit) && digit >= 1 && digit <= Math.min(totalItems, 9)) {
          const idx = digit - 1;
          setPqs((s) => ({ ...s, selected: idx }));
          handlePlanSelect(q, idx, options, showCustom);
          return;
        }

        // Enter — select current option
        if (key.name === "return") {
          handlePlanSelect(q, pqs.selected, options, showCustom);
          return;
        }

        return;
      }
      if (showUpdateModalRef.current) {
        if (isEscapeKey(key)) {
          setShowUpdateModal(false);
          return;
        }
        if (key.name === "return") {
          setIsUpdating(true);
          setShowUpdateModal(false);
          // Echo into the message log too — same reason as the /update command:
          // the updateOutput banner only renders on the home/splash screen.
          setMessages((prev) => [...prev, buildAssistantEntry("🔄 Checking for updates...")]);
          runUpdate(startupConfig.version).then((result) => {
            setIsUpdating(false);
            const text = result.success ? result.output : `Update failed: ${result.output}`;
            setUpdateOutput(text);
            setMessages((prev) => [...prev, buildAssistantEntry(text)]);
          });
          return;
        }
        return;
      }
      if (showMcpEditorRef.current) {
        if (isEscapeKey(key)) {
          setShowMcpEditor(false);
          setMcpEditorError(null);
          setMcpSearchQuery("");
          return;
        }
        if (key.name === "return") {
          submitMcpEditor();
          return;
        }
        if (mcpEditorField === "transport" && (key.name === "left" || key.name === "right")) {
          cycleMcpEditorTransport(key.name === "left" ? -1 : 1);
          return;
        }
        if (key.name === "tab") {
          const idx = mcpEditorFields.indexOf(mcpEditorField);
          const nextIdx = (idx + (key.shift ? -1 : 1) + mcpEditorFields.length) % mcpEditorFields.length;
          setMcpEditorField(mcpEditorFields[nextIdx]);
          return;
        }
        if (mcpEditorField === "transport") {
          return;
        }
      }
      if (showAgentsEditorRef.current) {
        if (isEscapeKey(key)) {
          setShowAgentsEditor(false);
          setAgentsEditorError(null);
          return;
        }
        if (key.name === "x" && key.ctrl && editingSubagent) {
          removeEditingSubagent();
          return;
        }
        if (key.name === "return") {
          submitSubagentEditor();
          return;
        }
        if (
          agentsEditorField === "model" &&
          (key.name === "up" ||
            key.name === "down" ||
            key.name === "left" ||
            key.name === "right" ||
            key.name === "j" ||
            key.name === "k")
        ) {
          const decrement = key.name === "up" || key.name === "left" || key.name === "k";
          setAgentsEditorModelIndex((index) =>
            decrement ? Math.max(0, index - 1) : Math.min(MODELS.length - 1, index + 1),
          );
          return;
        }
        if (key.name === "tab") {
          const index = SUBAGENT_EDITOR_FIELDS.indexOf(agentsEditorField);
          const nextIndex =
            (index + (key.shift ? -1 : 1) + SUBAGENT_EDITOR_FIELDS.length) % SUBAGENT_EDITOR_FIELDS.length;
          setAgentsEditorField(SUBAGENT_EDITOR_FIELDS[nextIndex]);
          return;
        }
        if (agentsEditorField === "model") {
          return;
        }
      }
      if (showMcpModalRef.current) {
        const row = mcpRows[mcpModalIndex];
        if (isEscapeKey(key)) {
          setShowMcpEditor(false);
          setShowMcpModal(false);
          setMcpSearchQuery("");
          setEditingMcpId(null);
          setMcpEditorError(null);
          return;
        }
        if (key.name === "up") {
          setMcpModalIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setMcpModalIndex((i) => Math.min(mcpRows.length - 1, i + 1));
          return;
        }
        if (key.name === "return") {
          if (row?.kind === "server") {
            toggleSavedMcp(row.server);
          } else if (row?.kind === "catalog") {
            openCatalogMcp(row.entry);
          } else {
            openMcpEditor(createEmptyMcpEditorDraft());
          }
          return;
        }
        if (key.name === "a" && key.ctrl) {
          openMcpEditor(createEmptyMcpEditorDraft());
          return;
        }
        if (key.name === "e" && key.ctrl && row?.kind === "server") {
          editSavedMcp(row.server);
          return;
        }
        if (key.name === "x" && key.ctrl && row?.kind === "server") {
          deleteSavedMcp(row.server);
          return;
        }
        if (key.name === "backspace") {
          setMcpSearchQuery((q) => q.slice(0, -1));
          setMcpModalIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setMcpSearchQuery((q) => q + key.sequence);
          setMcpModalIndex(0);
          return;
        }
        return;
      }
      if (showScheduleModalRef.current) {
        const row = scheduleRows[scheduleModalIndex];
        if (isEscapeKey(key)) {
          setShowScheduleModal(false);
          setScheduleSearchQuery("");
          return;
        }
        if (key.name === "up") {
          setScheduleModalIndex((index) => Math.max(0, index - 1));
          return;
        }
        if (key.name === "down") {
          setScheduleModalIndex((index) => Math.min(Math.max(0, scheduleRows.length - 1), index + 1));
          return;
        }
        if (key.name === "return") {
          if (row?.kind === "schedule") {
            showScheduleDetails(row.schedule);
          }
          return;
        }
        if (key.name === "x" && key.ctrl && row?.kind === "schedule") {
          removeSchedule(row.schedule);
          return;
        }
        if (key.name === "backspace") {
          setScheduleSearchQuery((query) => query.slice(0, -1));
          setScheduleModalIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setScheduleSearchQuery((query) => query + key.sequence);
          setScheduleModalIndex(0);
          return;
        }
        return;
      }
      if (showAgentsModalRef.current && !showAgentsEditorRef.current) {
        const row = agentRows[agentsModalIndex];
        if (isEscapeKey(key)) {
          setShowAgentsModal(false);
          setShowAgentsEditor(false);
          setAgentsSearchQuery("");
          setEditingSubagent(null);
          setAgentsEditorError(null);
          return;
        }
        if (key.name === "up") {
          setAgentsModalIndex((index) => Math.max(0, index - 1));
          return;
        }
        if (key.name === "down") {
          setAgentsModalIndex((index) => Math.min(Math.max(0, agentRows.length - 1), index + 1));
          return;
        }
        if (key.name === "return") {
          if (row?.kind === "agent") {
            openSubagentEditor(row.agent);
          }
          return;
        }
        if (key.name === "a" && key.ctrl) {
          openSubagentEditor(null);
          return;
        }
        if (key.name === "backspace") {
          setAgentsSearchQuery((query) => query.slice(0, -1));
          setAgentsModalIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setAgentsSearchQuery((query) => query + key.sequence);
          setAgentsModalIndex(0);
          return;
        }
        return;
      }
      if (showTelegramTokenModalRef.current) {
        if (isEscapeKey(key)) {
          setShowTelegramTokenModal(false);
          setTelegramTokenError(null);
          return;
        }
        if (key.name === "return") {
          submitTelegramToken();
        }
        return;
      }
      if (showTelegramPairModalRef.current) {
        if (isEscapeKey(key)) {
          setShowTelegramPairModal(false);
          setTelegramPairError(null);
          return;
        }
        if (key.name === "return") {
          void submitTelegramPair();
        }
        return;
      }
      if (showConnectModalRef.current) {
        if (isEscapeKey(key)) {
          setShowConnectModal(false);
          return;
        }
        if (key.name === "up") {
          setConnectModalIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setConnectModalIndex((i) => Math.min(CONNECT_CHANNELS.length - 1, i + 1));
          return;
        }
        if (key.name === "return") {
          const ch = CONNECT_CHANNELS[connectModalIndex];
          if (ch?.id === "telegram") beginTelegramFromConnect();
          return;
        }
        return;
      }
      if (showApiKeyModalRef.current) {
        if (isEscapeKey(key)) {
          closeApiKeyModal();
          return;
        }
        if (key.name === "return") {
          submitApiKey();
        }
        return;
      }
      if (showSlashMenuRef.current) {
        if (isEscapeKey(key)) {
          setShowSlashMenuSync(false);
          setSlashSearchQuery("");
          inputRef.current?.clear();
          key.preventDefault?.();
          return;
        }
        if (key.name === "up") {
          setSlashMenuIndex((i) => Math.max(0, i - 1));
          key.preventDefault?.();
          return;
        }
        if (key.name === "down") {
          if (filteredSlashItems.length > 0) setSlashMenuIndex((i) => Math.min(filteredSlashItems.length - 1, i + 1));
          key.preventDefault?.();
          return;
        }
        if (key.name === "return") {
          // Safety: when the user has already typed args after the slash
          // command (e.g. "/ideal --force-council <topic>"), pressing Enter
          // must dispatch the composer text — NOT trigger the currently
          // selected menu item. Previously this defaulted to "/exit" and
          // killed the CLI on power-user enter-after-args flows.
          // Detect args: any non-leading whitespace in the composer text
          // means the user has moved past the bare command.
          const composerText = inputRef.current?.plainText ?? "";
          const hasArgsAfterSlashCommand = /^\s*\/\S+\s+\S/.test(composerText);
          if (hasArgsAfterSlashCommand) {
            setShowSlashMenuSync(false);
            setSlashSearchQuery("");
            // Do NOT call key.preventDefault() — textarea must receive Enter
            // so the typed command (with args) is submitted normally.
            return;
          }

          const item = filteredSlashItems[slashMenuIndex];
          if (item) {
            handleSlashMenuSelect(item);
            setSlashSearchQuery("");
            key.preventDefault?.();
          } else {
            // No items match the current filter — close the menu and let
            // Enter fall through to the textarea's submit handler so the
            // typed command (e.g. "/council <topic>") is submitted as-is.
            setShowSlashMenuSync(false);
            setSlashSearchQuery("");
            // Do NOT call key.preventDefault() — textarea must receive Enter.
          }
          return;
        }
        if (key.name === "tab") {
          // Autocomplete: fill the input with "/<id> " and close the menu so
          // the user can keep typing message text (e.g. /ideate Tab <prompt>).
          const item = filteredSlashItems[slashMenuIndex];
          if (item) {
            const completion = `/${item.id} `;
            setShowSlashMenuSync(false);
            setSlashSearchQuery("");
            const ta = inputRef.current;
            if (ta) {
              const _tabDebug = process.env.MUONROI_DEBUG_TAB === "1";
              if (_tabDebug) {
                process.stderr.write(
                  `[tab-debug] before-clear: ${JSON.stringify({ filteredItems: filteredSlashItems.map((x) => x.id), slashMenuIndex, currentText: ta.plainText })}
`,
                );
              }
              ta.clear?.();
              ta.insertText?.(completion);
              if (_tabDebug) {
                process.stderr.write(
                  `[tab-debug] after-insertText: ${JSON.stringify({ textBeingInserted: completion, postInsertText: ta.plainText })}
`,
                );
              }
              try {
                ta.cursorOffset = completion.length;
              } catch {
                /* opentui versions vary */
              }
              // Re-focus the textarea so subsequent keystrokes land in the
              // input (clear/insertText can drop OpenTUI's internal focus).
              let _focusErr: unknown = null;
              try {
                (ta as unknown as { focus?: () => void }).focus?.();
              } catch (err) {
                _focusErr = err;
              }
              if (_tabDebug) {
                const focused = (ta as unknown as { _focused?: boolean })._focused;
                process.stderr.write(
                  `[tab-debug] after-focus: ${JSON.stringify({ focused: focused ?? null, postFocusText: ta.plainText, focusError: _focusErr ? String(_focusErr) : null })}
`,
                );
              }
            }
          }
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
        if (key.name === "backspace") {
          // Textarea is focused and handles the actual deletion. We only mirror
          // the resulting state into slashSearchQuery, and close the overlay
          // when the predicted next text no longer starts with "/".
          const predicted = slashSearchQuery.length > 0 ? slashSearchQuery.slice(0, -1) : "";
          setSlashSearchQuery(predicted);
          setSlashMenuIndex(0);
          // If the query is already empty, the next backspace will eat the
          // leading "/" — close the menu so the user is back to free typing.
          if (slashSearchQuery.length === 0) {
            setShowSlashMenuSync(false);
          }
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          // Textarea is focused — let it insert the character natively. We
          // only sync the search query so the menu filter stays accurate.
          // No preventDefault, no insertText: that combination caused the
          // "/iideall" duplication AND the focus-loss feeling because the
          // textarea was previously unfocused.
          setSlashSearchQuery((q) => q + key.sequence);
          setSlashMenuIndex(0);
          return;
        }
        return;
      }
      if (showSessionPicker) {
        if (isEscapeKey(key)) {
          setShowSessionPicker(false);
          return;
        }
        if (key.name === "up") {
          setSessionPickerIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setSessionPickerIndex((i) => Math.min(Math.max(0, sessionPickerList.length - 1), i + 1));
          return;
        }
        if (key.name === "return") {
          const picked = sessionPickerList[sessionPickerIndex];
          if (!picked) {
            setShowSessionPicker(false);
            return;
          }
          // Close the modal first so the toast renders before the spawn.
          setShowSessionPicker(false);
          pushToast("info", `Resuming session ${picked.id}… restarting CLI`);
          // Defer to the next tick so OpenTUI flushes the toast frame, then hand
          // off to onRelaunch — which tears down the renderer + restores the
          // terminal (raw mode / mouse tracking / alt-screen) and supervises the
          // child. Doing the spawn here directly (the old relaunchWithSession
          // call) skipped that teardown and dropped the user to a corrupted
          // shell prompt. Fall back to the legacy path only if no handler wired.
          setTimeout(() => {
            try {
              if (onRelaunch) {
                onRelaunch(picked.resumeId);
              } else {
                relaunchWithSession(picked.resumeId);
              }
            } catch (err) {
              console.error(`[session-picker] relaunch failed: ${(err as Error)?.message ?? err}`);
              pushToast("error", `Resume failed: ${(err as Error)?.message ?? err}`);
            }
          }, 50);
          return;
        }
        return;
      }
      if (showModelPicker) {
        // Sub-modal: OAuth login in progress (browser-based). Only Esc (cancel)
        // is actionable — the flow completes via the browser/loopback callback.
        if (oauthLogin) {
          if (isEscapeKey(key)) {
            cancelProviderOAuth();
            return;
          }
          return;
        }
        // Sub-modal: API key prompt for the focused provider.
        if (apiKeyPrompt) {
          if (isEscapeKey(key)) {
            setApiKeyPrompt(null);
            return;
          }
          if (key.name === "return") {
            void submitProviderKey();
            return;
          }
          if (key.name === "backspace") {
            // Functional updater: a burst of keystrokes (paste, or the harness
            // delivering type() synchronously) batches before React re-renders,
            // so reading apiKeyPrompt.value from the closure would be stale.
            setApiKeyPrompt((s) => (s ? { ...s, value: s.value.slice(0, -1), error: null } : s));
            return;
          }
          // Ctrl+R toggles plaintext reveal so the user can verify a pasted key.
          if (key.name === "r" && key.ctrl && !key.meta) {
            setApiKeyPrompt((s) => (s ? { ...s, reveal: !s.reveal } : s));
            return;
          }
          if (key.sequence && !key.ctrl && !key.meta) {
            // Terminal paste sometimes arrives as one chunk (40-100 chars for
            // an API key) through the keydown path rather than the bracketed-
            // paste handler. sanitizeSecretInput strips guards/control/whitespace.
            const cleaned = sanitizeSecretInput(key.sequence);
            if (cleaned.length === 0) return;
            setApiKeyPrompt((s) => (s ? { ...s, value: s.value + cleaned, error: null } : s));
            return;
          }
          return;
        }
        if (isEscapeKey(key)) {
          setShowModelPicker(false);
          setModelSearchQuery("");
          setModelPickerFocus("providers");
          return;
        }
        if (configuredProviders.length === 0) return;
        if (key.name === "up") {
          setProviderChipIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setProviderChipIndex((i) => Math.min(configuredProviders.length - 1, i + 1));
          return;
        }
        if (key.name === "k") {
          const p = configuredProviders[providerChipIndex];
          if (p) setApiKeyPrompt({ provider: p, value: "", error: null });
          return;
        }
        if (key.name === "o") {
          const p = configuredProviders[providerChipIndex];
          if (p && oauthProviders.has(p)) void startProviderOAuth(p);
          return;
        }
        if (key.name === "space" || key.sequence === " ") {
          const p = configuredProviders[providerChipIndex];
          if (p && providersWithKey.has(p)) toggleProviderEnabled(p);
          return;
        }
        if (key.name === "d" || key.name === "return") {
          const p = configuredProviders[providerChipIndex];
          if (p && providersWithKey.has(p)) setAsDefaultProvider(p);
          return;
        }
        return;
      }
      if (pendingPaymentApproval) {
        if (isEscapeKey(key)) {
          setPendingPaymentApproval(null);
          return;
        }
        if (key.name === "up" || key.name === "down") {
          setPendingPaymentApproval((p) => (p ? { ...p, selected: p.selected === 0 ? 1 : 0 } : p));
          return;
        }
        if (key.name === "return") {
          const approved = pendingPaymentApproval.selected === 0;
          const aid = pendingPaymentApproval.approvalId;
          setPendingPaymentApproval(null);
          if (aid) {
            agent.respondToToolApproval(aid, approved);
            if (approved) {
              processMessage("[Payment approved]");
            }
          }
          return;
        }
        return;
      }
      if (pendingCouncilPreflight && preflightCardStateRef.current) {
        const cardKey = mapCouncilCardKey(key);
        if (cardKey) {
          const synthetic = buildPreflightQuestion(pendingCouncilPreflight);
          const result = reduceCardKey(synthetic, preflightCardStateRef.current, cardKey);
          setPreflightCardStateSync(result.state);
          if (result.emit?.type === "answer") {
            const pid = pendingCouncilPreflight.preflightId;
            const value = result.emit.answer.text;
            setPendingCouncilPreflight(null);
            setPreflightCardStateSync(null);
            agent.respondToCouncilPreflight(pid, value === "approve");
          } else if (result.emit?.type === "cancel") {
            const pid = pendingCouncilPreflight.preflightId;
            setPendingCouncilPreflight(null);
            setPreflightCardStateSync(null);
            // F4 — Esc on the preflight card is a CLEAN CANCEL of the whole
            // council, not a plan rejection. The council entrypoint loops
            // `while (!approved)`, so respondToPreflight(false) ALONE just re-runs
            // clarification (or, on auto-council with skipClarification, re-shows
            // the same card) — there was no way out ("no clean cancel"). Its only
            // real exit is a post-await userAborted() check. Abort FIRST so that
            // check is true when the generator resumes, THEN resolve the preflight
            // false to unblock the await. Safe here — preflight is pre-debate, so
            // there is no live transcript to wipe (unlike the mid-debate question
            // card the global Esc handler deliberately shields).
            const activeAgent = activeTurnRef.current?.agent ?? agent;
            activeAgent.abort();
            agent.respondToCouncilPreflight(pid, false);
          }
          return;
        }
        // Y/N quick-keys preserved for muscle memory
        if (key.sequence === "y" || key.sequence === "Y") {
          const pid = pendingCouncilPreflight.preflightId;
          setPendingCouncilPreflight(null);
          setPreflightCardStateSync(null);
          agent.respondToCouncilPreflight(pid, true);
          return;
        }
        if (key.sequence === "n" || key.sequence === "N") {
          const pid = pendingCouncilPreflight.preflightId;
          setPendingCouncilPreflight(null);
          setPreflightCardStateSync(null);
          agent.respondToCouncilPreflight(pid, false);
          return;
        }
        return;
      }
      if (showWalletPicker) {
        if (isEscapeKey(key)) {
          setShowWalletPicker(false);
          return;
        }
        if (key.name === "up") {
          setWalletFocusIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setWalletFocusIndex((i) => Math.min(WALLET_ROWS.length - 1, i + 1));
          return;
        }

        const focusedWalletRow = WALLET_ROWS[walletFocusIndex];
        if (!focusedWalletRow || focusedWalletRow.type === "readonly") return;

        if (key.name === "left" || key.name === "right") {
          const options = focusedWalletRow.getOptions!();
          const current = focusedWalletRow.getDisplay(walletSettings, walletDisplayInfo);
          const idx = options.indexOf(current);
          const next =
            key.name === "right" ? options[Math.min(options.length - 1, idx + 1)] : options[Math.max(0, idx - 1)];
          if (next && next !== current && focusedWalletRow.apply) {
            const patch = focusedWalletRow.apply(walletSettings, next);
            applyWalletSettings({ ...walletSettings, ...patch });
          }
          return;
        }

        if (key.name === "return") {
          const options = focusedWalletRow.getOptions!();
          const current = focusedWalletRow.getDisplay(walletSettings, walletDisplayInfo);
          const idx = options.indexOf(current);
          const next = options[(idx + 1) % options.length];
          if (next && focusedWalletRow.apply) {
            const patch = focusedWalletRow.apply(walletSettings, next);
            applyWalletSettings({ ...walletSettings, ...patch });
          }
          return;
        }
        return;
      }
      if (showSandboxPicker) {
        const visibleRows = getSandboxVisibleRows(sandboxMode);

        if (sandboxSettingsEditing) {
          if (isEscapeKey(key)) {
            setSandboxSettingsEditing(null);
            setSandboxSettingsEditBuffer("");
            return;
          }
          if (key.name === "return") {
            const row = visibleRows.find((r) => r.key === sandboxSettingsEditing);
            if (row) {
              const result = row.apply(sandboxMode, sandboxSettings, sandboxSettingsEditBuffer.trim());
              if (result.mode !== undefined) applySandboxMode(result.mode);
              if (result.settings) applySandboxSettings({ ...sandboxSettings, ...result.settings });
            }
            setSandboxSettingsEditing(null);
            setSandboxSettingsEditBuffer("");
            return;
          }
          if (key.name === "backspace") {
            setSandboxSettingsEditBuffer((b) => b.slice(0, -1));
            return;
          }
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            setSandboxSettingsEditBuffer((b) => b + key.sequence);
            return;
          }
          return;
        }

        if (isEscapeKey(key)) {
          setShowSandboxPicker(false);
          return;
        }
        if (key.name === "up") {
          setSandboxSettingsFocusIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setSandboxSettingsFocusIndex((i) => Math.min(visibleRows.length - 1, i + 1));
          return;
        }

        const focusedRow = visibleRows[sandboxSettingsFocusIndex];
        if (!focusedRow) return;

        if (focusedRow.type === "toggle" && (key.name === "left" || key.name === "right")) {
          const options = focusedRow.getOptions!();
          const current = focusedRow.getDisplay(sandboxMode, sandboxSettings);
          const idx = options.indexOf(current);
          const next =
            key.name === "right" ? options[Math.min(options.length - 1, idx + 1)] : options[Math.max(0, idx - 1)];
          if (next && next !== current) {
            const result = focusedRow.apply(sandboxMode, sandboxSettings, next);
            if (result.mode !== undefined) applySandboxMode(result.mode);
            if (result.settings) applySandboxSettings({ ...sandboxSettings, ...result.settings });
          }
          return;
        }

        if (key.name === "return") {
          if (focusedRow.type === "toggle") {
            const options = focusedRow.getOptions!();
            const current = focusedRow.getDisplay(sandboxMode, sandboxSettings);
            const idx = options.indexOf(current);
            const next = options[(idx + 1) % options.length];
            const result = focusedRow.apply(sandboxMode, sandboxSettings, next);
            if (result.mode !== undefined) applySandboxMode(result.mode);
            if (result.settings) applySandboxSettings({ ...sandboxSettings, ...result.settings });
          } else {
            setSandboxSettingsEditing(focusedRow.key);
            const current = sandboxSettings[focusedRow.key as keyof SandboxSettings];
            setSandboxSettingsEditBuffer(
              Array.isArray(current) ? current.join(", ") : current != null ? String(current) : "",
            );
          }
          return;
        }
        return;
      }

      if (isEscapeKey(key) && interruptActiveRun(key)) {
        return;
      }

      // ↑ arrow while processing with queue → pop last queued message into input for editing
      if (key.name === "up" && isProcessingRef.current && queuedMessagesRef.current.length > 0) {
        const popped = queuedMessagesRef.current.pop()!;
        setQueuedMessages(queuedMessagesRef.current.map((msg) => msg.displayText));
        inputRef.current?.clear();
        inputRef.current?.insertText(popped.displayText);
        key.preventDefault();
        key.stopPropagation();
        return;
      }

      if (!hasApiKeyRef.current && shouldOpenApiKeyModalForKey(key)) {
        openApiKeyModal();
        return;
      }
      if (key.sequence === "/" && !isProcessing) {
        const text = inputRef.current?.plainText || "";
        if (!text.trim()) {
          setShowSlashMenuSync(true);
          setSlashMenuIndex(0);
          setSlashSearchQuery("");
          // Mirror the leading "/" into the input field so the cursor stays
          // visible to the user. Without this, the textarea is unfocused and
          // the menu's filter keystrokes happen "invisibly".
          inputRef.current?.clear();
          inputRef.current?.insertText("/");
          key.preventDefault?.();
          return;
        }
      }

      if (key.name === "e" && key.ctrl) {
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.type === "user") {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          setExpandedMessages((prev) => {
            const next = new Set(prev);
            if (next.has(lastUserIdx)) next.delete(lastUserIdx);
            else next.add(lastUserIdx);
            return next;
          });
        }
        return;
      }
      if (key.name === "c" && key.ctrl && key.shift) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
        }
        return;
      }
      if (key.name === "y" && key.ctrl && copyTuiSelectionToHost()) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      // ⌘C: Kitty / iTerm report Command as `super`; some setups use `meta` instead.
      if (key.name === "c" && !key.ctrl && (key.meta || key.super)) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
      }
      // Alt+V: paste image from clipboard (like Claude Code / Codex / Gemini CLI)
      if (key.name === "v" && (key.meta || key.option)) {
        const clip = readClipboardImage();
        if (clip) {
          const id = ++pasteCounterRef.current;
          const block = {
            id,
            content: `__clipboard_image_${id}__`,
            lines: 1,
            isImage: true,
            clipboardBase64: clip.base64,
            clipboardMediaType: clip.mediaType,
          } satisfies PasteBlock;
          replacePasteBlocks([...pasteBlocksRef.current, block]);
          inputRef.current?.insertText(getPasteBlockToken(block));
        }
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (key.name === "c" && key.ctrl) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
        const text = inputRef.current?.plainText || "";
        if (text.trim()) {
          inputRef.current?.clear();
          replacePasteBlocks([]);
        } else {
          handleExit();
        }
        return;
      }
      if (typeaheadRef.current.visible) {
        if (key.name === "up") {
          typeaheadRef.current.navigateUp();
          return;
        }
        if (key.name === "down") {
          typeaheadRef.current.navigateDown();
          return;
        }
        if (key.name === "tab" || key.name === "return") {
          key.preventDefault();
          key.stopPropagation();
          typeaheadRef.current.accept();
          return;
        }
        if (isEscapeKey(key)) {
          typeaheadRef.current.dismiss();
          return;
        }
      }
      if (key.name === "tab" && !isProcessing) {
        cycleMode();
        return;
      }
      // Per-session input history: ArrowUp/ArrowDown navigate previously
      // submitted prompts only when the cursor sits at the end of the buffer.
      // If the cursor is mid-text the keys fall through so the textarea can
      // move the caret between lines while editing a recalled prompt.
      if ((key.name === "up" || key.name === "down") && !key.ctrl && !key.meta) {
        const ta = inputRef.current;
        if (!ta) return;
        const hist = inputHistoryRef.current;
        if (hist.length === 0) return;
        const browsing = historyIndexRef.current !== -1;
        const buffer = ta.plainText || "";
        const caret = typeof ta.cursorOffset === "number" ? ta.cursorOffset : buffer.length;
        if (caret !== buffer.length) return;
        if (key.name === "up") {
          if (!browsing) {
            historyDraftRef.current = buffer;
            historyIndexRef.current = hist.length - 1;
          } else if (historyIndexRef.current > 0) {
            historyIndexRef.current -= 1;
          } else {
            key.preventDefault();
            key.stopPropagation();
            return;
          }
          const entry = hist[historyIndexRef.current] ?? "";
          ta.setText(entry);
          try {
            ta.cursorOffset = entry.length;
          } catch {
            /* opentui versions vary */
          }
          key.preventDefault();
          key.stopPropagation();
          return;
        }
        if (key.name === "down") {
          if (!browsing) return;
          if (historyIndexRef.current < hist.length - 1) {
            historyIndexRef.current += 1;
            const entry = hist[historyIndexRef.current] ?? "";
            ta.setText(entry);
            try {
              ta.cursorOffset = entry.length;
            } catch {
              /* noop */
            }
          } else {
            historyIndexRef.current = -1;
            const draft = historyDraftRef.current;
            historyDraftRef.current = "";
            ta.setText(draft);
            try {
              ta.cursorOffset = draft.length;
            } catch {
              /* noop */
            }
          }
          key.preventDefault();
          key.stopPropagation();
          return;
        }
      }
    },
    [
      agent,
      agentRows,
      agentsEditorField,
      agentsModalIndex,
      beginTelegramFromConnect,
      btwState,
      closeApiKeyModal,
      connectModalIndex,
      cycleMode,
      cycleMcpEditorTransport,
      deleteSavedMcp,
      dismissBtw,
      dismissPlan,
      editingSubagent,
      editSavedMcp,
      adjustModelReasoningEffort,
      filteredModelIds,
      filteredSlashItems,
      handleExit,
      handlePlanSelect,
      handleSlashMenuSelect,
      interruptActiveRun,
      isPlanConfirmTab,
      isProcessing,
      isSinglePlan,
      mcpEditorField,
      mcpEditorFields,
      mcpModalIndex,
      mcpRows,
      modelPickerIndex,
      modelPickerFocus,
      providerChipIndex,
      configuredProviders,
      toggleProviderEnabled,
      // Model-picker credential sub-modals — MUST stay in deps. handleKey reads
      // these directly; omitting them froze the closure on a stale `null`, which
      // is why typing/pasting into the per-provider key prompt did nothing.
      apiKeyPrompt,
      oauthLogin,
      oauthProviders,
      submitProviderKey,
      startProviderOAuth,
      cancelProviderOAuth,
      openApiKeyModal,
      openCatalogMcp,
      openMcpEditor,
      replacePasteBlocks,
      openSubagentEditor,
      removeSchedule,
      scheduleModalIndex,
      scheduleRows,
      showScheduleDetails,
      submitTelegramPair,
      submitTelegramToken,
      submitMcpEditor,
      submitSubagentEditor,
      planQuestions,
      planTabCount,
      pqs,
      removeEditingSubagent,
      applySandboxMode,
      applySandboxSettings,
      sandboxSettings,
      sandboxSettingsEditing,
      sandboxSettingsEditBuffer,
      sandboxSettingsFocusIndex,
      sandboxMode,
      showModelPicker,
      showPlanPanel,
      showSandboxPicker,
      pendingPaymentApproval,
      processMessage,
      showWalletPicker,
      walletSettings,
      walletFocusIndex,
      walletDisplayInfo,
      applyWalletSettings,
      slashMenuIndex,
      submitApiKey,
      submitPlanAnswers,
      copyTuiSelectionToHost,
      toggleSavedMcp,
      messages,
      startupConfig.version,
      pendingCouncilPreflight,
      slashSearchQuery.length,
      slashSearchQuery.slice,
      activeHaltCard,
      haltSelectedIndex,
      handleCommand,
      initNewForm,
      toggleModelDisabled,
      pointToExistingForm,
      setApiKeyPrompt,
      setCouncilCardStateSync,
      setPendingCouncilQuestionSync,
      setShowSlashMenuSync,
      setPreflightCardStateSync,
      setModelSearchQuery,
      setProviderChipIndex,
      setModelPickerFocus,
      setShowModelPicker,
      setModelPickerIndex,
      setModel,
      showSessionPicker,
      sessionPickerList,
      sessionPickerIndex,
      setShowSessionPicker,
      setSessionPickerIndex,
      scrollToBottomForced,
      isPinnedToBottom,
    ],
  );
  useKeyboard(handleKey);

  const handlePaste = useCallback(
    (event: PasteEvent) => {
      // A credential prompt steals paste so the secret lands in the right
      // field instead of the composer. API keys are single-line, so without
      // this they hit the `lineCount < 2` early-return below and vanish.
      if (apiKeyPrompt) {
        event.preventDefault();
        const pasted = sanitizeSecretInput(decodePasteBytes(event.bytes));
        if (pasted) setApiKeyPrompt((s) => (s ? { ...s, value: s.value + pasted, error: null } : s));
        return;
      }
      if (!hasApiKeyRef.current) {
        event.preventDefault();
        openApiKeyModal();
        return;
      }

      const text = decodePasteBytes(event.bytes);
      const trimmed = text.trim();
      const imageExts = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i;
      if (imageExts.test(trimmed) && !trimmed.includes("\n")) {
        event.preventDefault();
        const id = ++pasteCounterRef.current;
        const block = { id, content: trimmed, lines: 1, isImage: true } satisfies PasteBlock;
        replacePasteBlocks([...pasteBlocksRef.current, block]);
        inputRef.current?.insertText(getPasteBlockToken(block));
        return;
      }
      const lineCount = text.split("\n").length;
      if (lineCount < 2) return;
      event.preventDefault();
      const id = ++pasteCounterRef.current;
      const block = { id, content: text, lines: lineCount } satisfies PasteBlock;
      replacePasteBlocks([...pasteBlocksRef.current, block]);
      inputRef.current?.insertText(getPasteBlockToken(block));
    },
    [apiKeyPrompt, openApiKeyModal, replacePasteBlocks],
  );

  const handleSubmit = useCallback(() => {
    const raw = inputRef.current?.plainText || "";
    if (raw.trim()) {
      const hist = inputHistoryRef.current;
      const last = hist[hist.length - 1];
      if (raw !== last) hist.push(raw);
      // Keep history bounded — 200 most recent entries is plenty for one session.
      if (hist.length > 200) hist.splice(0, hist.length - 200);
    }
    historyIndexRef.current = -1;
    historyDraftRef.current = "";
    if (!raw.trim() && pasteBlocksRef.current.length === 0) {
      if (queuedMessagesRef.current.length > 0 && isProcessingRef.current) {
        interruptedRunIdRef.current = activeRunIdRef.current;
        const activeAgent = activeTurnRef.current?.agent ?? agent;
        activeTurnRef.current = null;
        clearLiveTurnUi();
        activeAgent.abort();
      }
      return;
    }
    inputRef.current?.clear();
    let message = raw;
    const blocks = [...pasteBlocksRef.current];
    replacePasteBlocks([]);

    const imageBlocks = blocks.filter((b) => b.isImage);
    const textBlocks = blocks.filter((b) => !b.isImage);
    for (const block of textBlocks) {
      message = message.replace(getPasteBlockToken(block), block.content);
    }

    // Load images into base64 for multimodal messages
    const images: Array<{ path: string; mediaType: string; base64: string }> = [];
    for (const block of imageBlocks) {
      // Clipboard image (Alt+V): already has base64 data
      if (block.clipboardBase64) {
        message = message.replace(getPasteBlockToken(block), "[clipboard image]");
        images.push({
          path: "clipboard",
          mediaType: block.clipboardMediaType ?? "image/png",
          base64: block.clipboardBase64,
        });
        continue;
      }
      // File path image: read from disk
      const filePath = block.content.trim();
      message = message.replace(getPasteBlockToken(block), `[image: ${filePath}]`);
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(agent.getCwd(), filePath);
        const buf = fs.readFileSync(resolved);
        const ext = path.extname(resolved).toLowerCase().replace(".", "");
        const mimeMap: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
          bmp: "image/bmp",
          ico: "image/x-icon",
          tif: "image/tiff",
          tiff: "image/tiff",
        };
        images.push({ path: resolved, mediaType: mimeMap[ext] ?? "image/png", base64: buf.toString("base64") });
      } catch {
        // File unreadable — keep path as text fallback
      }
    }

    const displayText = raw.trim();
    const fileBlocks = [...fileMentionBlocksRef.current];
    fileMentionBlocksRef.current = [];
    for (const block of fileBlocks) {
      message = message.replace(getFileMentionToken(block), `@${block.path}`);
    }
    if (!message.trim()) return;
    if (!hasApiKeyRef.current) {
      openApiKeyModal();
      return;
    }
    // Council question response — route answer back to council generator.
    // The card now owns keyboard input; this branch survives only for the
    // legacy code path where the user typed an answer in the main prompt
    // before the card was wired up.
    if (pendingCouncilQuestion) {
      const qid = pendingCouncilQuestion.questionId;
      setPendingCouncilQuestionSync(null);
      setCouncilCardStateSync(null);
      agent.respondToCouncilQuestion(qid, message.trim(), pendingCouncilQuestion.question);
      setMessages((prev) => [...prev, buildUserEntry(message.trim())]);
      return;
    }
    if (handleCommand(message)) {
      setShowSlashMenuSync(false);
      setSlashSearchQuery("");
      return;
    }
    const { enhancedMessage } = processAtMentions(message.trim(), agent.getCwd());
    if (isProcessingRef.current) {
      queuedMessagesRef.current.push({ text: enhancedMessage, displayText });
      setQueuedMessages(queuedMessagesRef.current.map((msg) => msg.displayText));
      setTimeout(scrollToBottom, 10);
      return;
    }
    // Sync the displayed model (from status bar / router upgrade) to the agent
    // so the next turn starts from the correct base model. This covers both
    // routing upgrades (e.g. flash→pro) and downgrades (e.g. pro→flash).
    const displayedModel = modelRef.current;
    if (displayedModel && displayedModel !== agent.getModel()) {
      agent.setModel(displayedModel);
    }
    // Submitting a fresh prompt is an explicit "engage the live tail" action —
    // re-pin even if the user had scrolled up to read history (scroll-lock).
    scrollToBottomForced();
    processMessage(enhancedMessage, displayText, images.length > 0 ? images : undefined);
  }, [
    agent,
    clearLiveTurnUi,
    handleCommand,
    openApiKeyModal,
    processMessage,
    replacePasteBlocks,
    scrollToBottom,
    scrollToBottomForced,
    pendingCouncilQuestion?.questionId,
    pendingCouncilQuestion,
    setShowSlashMenuSync,
    setPendingCouncilQuestionSync,
    setCouncilCardStateSync,
  ]);

  // Switch to the "messages" branch (which renders log + halt-card + init-new-form +
  // point-to-existing-form + council-progress) whenever ANY of these overlays
  // is active. Previously only message-stream signals flipped this, which meant
  // /ideal halts (and their --inject-halt E2E counterpart) registered the halt
  // state but the home-screen branch never rendered the card → semantic tree
  // missing → harness wait_for timed out across multiple specs.
  const hasMessages =
    messages.length > 0 ||
    streamContent !== "" ||
    isProcessing ||
    activeHaltCard !== null ||
    initNewForm !== null ||
    pointToExistingForm !== null ||
    councilProgress !== null;

  // SemanticProvider wraps the app root so descendant <Semantic> components can
  // register nodes into the runtime's registry. When agent-mode is inactive,
  // agentRuntime is undefined and the registry is a stable no-op stub (never
  // triggers captures since addPostProcessFn was not wired without a runtime).

  return {
    activeHaltCard,
    activeSubagent,
    activeToast,
    activeToolCalls,
    agentRows,
    agentRuntime,
    agentsEditorDraft,
    agentsEditorError,
    agentsEditorField,
    agentsEditorModelIndex,
    agentsEditorSyncKey,
    agentsModalIndex,
    agentsSearchQuery,
    apiKeyError,
    apiKeyInputRef,
    apiKeyPrompt,
    blockPrompt,
    btwState,
    oauthLogin,
    oauthProviders,
    configuredProviders,
    connectModalIndex,
    contextStats,
    copyFlashId,
    councilCardState,
    councilInfoCards,
    councilMeta,
    councilRounds,
    selectedRound,
    setSelectedRound,
    councilMessages,
    councilTranscriptExpanded,
    councilTodoExpanded,
    councilPhases,
    councilPlaceholders,
    councilProgress,
    councilStatuses,
    defaultProvider,
    disabledModels,
    disabledProviders,
    dismissToast,
    editingMcpId,
    editingSubagent,
    expandedMessages,
    filteredModels,
    filteredSlashItems,
    getPartnerLast,
    getSide,
    haltSelectedIndex,
    handlePaste,
    handleRootMouseDown,
    handleRootMouseUp,
    handleSubmit,
    hasMessages,
    height,
    initNewForm,
    inputRef,
    isProcessing,
    isUpdating,
    lastReasoningElapsedMs,
    liveTurnSourceLabel,
    mcpArgsRef,
    mcpCommandRef,
    mcpCwdRef,
    mcpEditorDraft,
    mcpEditorError,
    mcpEditorField,
    mcpEditorSyncKey,
    mcpEnvRef,
    mcpHeadersRef,
    mcpLabelRef,
    mcpModalIndex,
    mcpRows,
    mcpSearchQuery,
    mcpUrlRef,
    messages,
    modeInfo,
    model,
    modelInfo,
    modelPickerFocus,
    modelPickerIndex,
    modelSearchQuery,
    pasteBlocks,
    pendingCouncilPreflight,
    pendingCouncilQuestion,
    pendingPaymentApproval,
    planQuestions,
    pointToExistingForm,
    pqs,
    preflightCardState,
    productStatus,
    providerChipIndex,
    providersWithKey,
    queuedMessages,
    reasoningActive,
    reasoningEffortByModel,
    resolveStyle,
    sandboxMode,
    sandboxSettings,
    sandboxSettingsEditBuffer,
    sandboxSettingsEditing,
    sandboxSettingsFocusIndex,
    scheduleModalIndex,
    scheduleRows,
    scheduleSearchQuery,
    scrollRef,
    scrollToBottomForced,
    newSinceLock,
    scrollLockedAway,
    railVisible,
    sessionId,
    sessionPickerIndex,
    sessionPickerList,
    sessionTitle,
    sessionTree,
    showAgentsEditor,
    showAgentsModal,
    showApiKeyModal,
    showConnectModal,
    showCopyBanner,
    showMcpEditor,
    showMcpModal,
    showModelPicker,
    showPlanPanel,
    showSandboxPicker,
    showScheduleModal,
    showSessionPicker,
    showSlashMenu,
    showTelegramPairModal,
    showTelegramTokenModal,
    showUpdateModal,
    showWalletPicker,
    slashInputIsMatched,
    slashMenuIndex,
    slashSearchQuery,
    streamContent,
    streamReasoning,
    subagentInstructionRef,
    subagentNameRef,
    submitApiKey,
    submitMcpEditor,
    submitSubagentEditor,
    submitTelegramPair,
    submitTelegramToken,
    t,
    taskListSnapshot,
    telegramPairError,
    telegramPairInputRef,
    telegramTokenError,
    telegramTokenInputRef,
    typeahead,
    updateInfo,
    updateOutput,
    walletDisplayInfo,
    walletFocusIndex,
    walletSettings,
    width,
  } as any;
}
