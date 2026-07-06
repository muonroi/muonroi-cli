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
import { isContextRailEnabled, isRoundGroupsEnabled } from "../gsd/flags.js";
import { appendCrashLog, setActiveEeYield } from "../index.js";
import { POPULAR_MCP_CATALOG } from "../mcp/catalog";
import { parseEnvLines, parseHeaderLines } from "../mcp/parse-headers";
import { toMcpServerId, validateMcpServerConfig } from "../mcp/validate";
import { Agent } from "../orchestrator/orchestrator";
import type { SafetyOverrideAskInfo, SafetyOverrideVerdict } from "../orchestrator/safety-askcard.js";
import { planSafetyAskcard } from "../orchestrator/safety-askcard.js";

import type { HaltChunk, ProductStatusCardData } from "../product-loop/types.js";
import { getConfiguredProviders, setKeyForProvider } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";
import { buildIdealContinuationPrompt } from "../scaffold/continuation-prompt.js";
import { continueAsCouncil } from "../scaffold/continue-as-council.js";
import { initNewProject } from "../scaffold/init-new.js";
import { pointToExisting } from "../scaffold/point-to-existing.js";
import { statusBarStore, wireStatusBar } from "../state/status-bar-store.js";
import { logUIInteraction } from "../storage/index.js";
import type { StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
  CouncilInfoCard,
  CouncilMessage,
  CouncilPhaseEvent,
  CouncilQuestionData,
  CouncilQuestionOption,
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
import { ContextRail, type ContextRailRow } from "./components/context-rail.js";
import { CopyFlashBanner } from "./components/copy-flash-banner.js";
import { CouncilDebatePill } from "./components/council-debate-pill.js";
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
import { CouncilRailRounds } from "./components/council-rail-rounds.js";
import { CouncilRoundGroup, CouncilRoundsOverview } from "./components/council-round-group.js";
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
import { JumpToLatestPill } from "./components/jump-to-latest-pill.js";
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
import { SLASH_MENU_ITEMS, type SlashMenuItem, VISIBLE_SLASH_MENU_ITEMS } from "./slash/menu-items.js";
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
  mapCouncilCardKey,
} from "./utils/format.js";
import { isEscapeKey } from "./utils/modal.js";
import { sanitizeContent } from "./utils/text.js";
import { dominantVerb, toolArgs, toolLabel, tryParseArg } from "./utils/tools.js";

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
  const head = `\n≡ƒÆí [Experience Injected] ${d.pointCount ?? 0} point(s) loaded (score ΓëÑ ${d.scoreFloor ?? 0})`;
  const pts = d.points ?? [];
  if (pts.length === 0) return `${head}\n`;
  const MAX = 8;
  const lines = pts.slice(0, MAX).map((p) => `   ΓÇó [${p.tier}] ${p.title || "(untitled)"} {id:${p.id.slice(0, 8)}}`);
  if (pts.length > MAX) lines.push(`   ΓÇª +${pts.length - MAX} more`);
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
 * stripControlBytes + removes every whitespace character ΓÇö an API key never
 * contains whitespace, and terminal paste often arrives wrapped in guards or
 * with a trailing newline. Shared by the keydown and paste handlers so both
 * input routes behave identically.
 */
function sanitizeSecretInput(raw: string): string {
  return stripControlBytes(raw).replace(/\s+/g, "");
}

const DEFAULT_MODEL = getCurrentModel();

// ---------------------------------------------------------------------------
// Telegram stubs ΓÇö removed feature, compile-only placeholders
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
      for (const c of r.changes ?? []) parts.push(`\nΓöÇΓöÇ ${c.file} ΓöÇΓöÇ\n${c.diff}`);
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
      if (r.fix) parts.push(`\nΓöÇΓöÇ fix: ${r.fix.file} ΓöÇΓöÇ\n${r.fix.diff}`);
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
      for (const f of r.files ?? []) parts.push(`\nΓöÇΓöÇ ${f.path} (${f.language}) ΓöÇΓöÇ\n${f.content}`);
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
  vertical: "Γöâ",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};
const _SPLIT_END = { ...SPLIT, bottomLeft: "Γò╣" };
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
  topLeft: "Γöü",
  bottomLeft: "Γöü",
  vertical: "",
  topRight: "Γöü",
  bottomRight: "Γöü",
  horizontal: "Γöü",
  bottomT: "Γöü",
  topT: "Γöü",
  cross: "Γöü",
  leftT: "Γöü",
  rightT: "Γöü",
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

// Splash UX: only DeepSeek + SiliconFlow are surfaced. Other providers
// (openai/anthropic/google/xai/ollama) keep working programmatically when
// the router picks them, but the user-facing picker hides them so the
// user cannot enable a provider we are not actively maintaining UX for.
// Hoisted to module-level so React useEffect deps stay stable across renders.
const SPLASH_PROVIDERS: readonly ProviderId[] = ["deepseek", "zai", "opencode-go", "xai"];

import { useAppLogic } from "./use-app-logic.js";

export function App({ agent, startupConfig, initialMessage, onExit, onRelaunch }: AppProps) {
  const {
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
    bwSync,
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
    newSinceLock,
    scrollLockedAway,
    railVisible,
    sessionId,
    sessionPickerIndex,
    sessionPickerList,
    sessionTitle,
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
  } = useAppLogic({ agent, startupConfig, initialMessage, onExit, onRelaunch });

  // Context rail (MUONROI_CONTEXT_RAIL): only render when enabled, the user
  // hasn't hidden it (Ctrl+B), and the terminal is wide enough that a fixed
  // side panel doesn't starve the transcript. Below 100 cols it stays inline.
  const railActive = isContextRailEnabled() && railVisible && width >= 100;
  const railWidth = Math.min(40, Math.max(28, Math.floor(width * 0.28)));
  const railRows: ContextRailRow[] = [
    { label: "Session", value: sessionId ? sessionId.slice(0, 12) : "—" },
    { label: "Mode", value: modeInfo?.label ?? "—" },
    { label: "Model", value: model ?? "—" },
  ];
  // Council metadata rows (P3) — appended only when a debate has published them,
  // so non-council sessions keep a lean rail.
  if (councilMeta?.topic) {
    const t = councilMeta.topic.trim();
    railRows.push({ label: "Topic", value: t.length > 90 ? `${t.slice(0, 89)}…` : t });
  }
  if (councilMeta?.leader) railRows.push({ label: "Leader", value: councilMeta.leader });
  if (councilMeta?.panel?.length) {
    railRows.push({ label: "Panel", value: `${councilMeta.panel.length}: ${councilMeta.panel.join(", ")}` });
  }
  // Round budget is a CEILING the leader may stop under once the panel converges
  // — not a commitment to run that many. Label it as a budget so it doesn't read
  // as "3 of 3 done" next to a Progress row that stopped early.
  const roundBudget = typeof councilMeta?.roundBudget === "number" ? councilMeta.roundBudget : undefined;
  if (roundBudget !== undefined) {
    const upTo =
      typeof councilMeta?.roundCeiling === "number" && councilMeta.roundCeiling > roundBudget
        ? ` (up to ${councilMeta.roundCeiling})`
        : "";
    railRows.push({ label: "Round budget", value: `${roundBudget} max${upTo}` });
  }
  if (councilMeta?.researchMode !== undefined) {
    railRows.push({ label: "Research", value: councilMeta.researchMode ? "on" : "off" });
  }
  if (councilMeta?.costAware) railRows.push({ label: "Cost-aware", value: "on" });
  // Live debate progress — current round vs budget + its outcome/decision, so the
  // rail reflects debate STATE. A `stop` before the budget is an EARLY convergence,
  // not a truncation — say so explicitly to resolve the "3 planned but 1 ran" look.
  if (councilRounds.length > 0) {
    const last = councilRounds[councilRounds.length - 1];
    const parts = [roundBudget ? `Round ${last.round}/${roundBudget}` : `Round ${last.round}`];
    if (last.state === "running") parts.push("running");
    if (typeof last.criteriaTotal === "number" && last.criteriaTotal >= 0) {
      parts.push(`${last.criteriaMet ?? 0}/${last.criteriaTotal} met`);
    }
    if (last.state === "done") {
      if (last.leaderDecision === "stop") {
        parts.push(roundBudget && last.round < roundBudget ? "converged — stopped early" : "converged");
      } else if (last.leaderDecision && last.leaderDecision !== "eval-unavailable") {
        parts.push(last.leaderDecision);
      }
    }
    railRows.push({ label: "Progress", value: parts.join(" · ") });
  }

  // Council metadata cards (phase timeline, product-status, statuses, info cards
  // like Clarified Spec / Discussion Brief / Debate Plan). Rendered INLINE in the
  // transcript when the rail is off, or hoisted into the rail when it is on — so
  // metadata stops pushing the live debate off screen. `cols` sizes the info
  // cards to whichever container holds them.
  const renderCouncilMeta = (cols: number) => (
    <>
      {councilPhases.length > 0 && (
        <Semantic id="council-phases" role="listbox" name="Council Phases">
          <CouncilPhaseTimeline phases={councilPhases} theme={t} expanded={councilTranscriptExpanded} />
        </Semantic>
      )}
      {productStatus && <ProductStatusCard data={productStatus} theme={t} />}
      {councilStatuses.length > 0 && (
        <Semantic id="council-status" role="listbox" name="Council Status">
          <CouncilStatusList statuses={councilStatuses} theme={t} />
        </Semantic>
      )}
      {councilInfoCards.map((card, idx) => (
        <Semantic
          key={`sem-info-${idx}-${card.title}`}
          id={`council-card-${idx}`}
          role="listitem"
          name={card.title || `Council card ${idx}`}
        >
          <CouncilInfoCardView key={`info-card-${idx}-${card.title}`} card={card} terminalCols={cols} theme={t} />
        </Semantic>
      ))}
      {isRoundGroupsEnabled() && councilRounds.length > 0 && (
        <CouncilRailRounds
          rounds={councilRounds}
          selected={selectedRound}
          onSelect={setSelectedRound}
          width={cols}
          theme={t}
        />
      )}
    </>
  );

  return (
    <SemanticProvider
      registry={
        agentRuntime
          ? agentRuntime.registry
          : { register: () => () => {}, update: () => {}, snapshot: () => ({ nodes: [] }), clear: () => {} }
      }
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenCode-style copy-on-mouse-up on root surface */}
      <box
        width={width}
        height={height}
        backgroundColor={t.background}
        flexDirection="column"
        onMouseUp={handleRootMouseUp}
        onMouseDown={handleRootMouseDown}
      >
        {copyFlashId > 0 ? <CopyFlashBanner t={t} width={width} /> : null}
        {hasMessages ? (
          <box flexGrow={1} flexDirection="column">
            <SessionHeader
              t={t}
              modeInfo={modeInfo}
              sessionTitle={sessionTitle}
              sessionId={sessionId}
              onCopySessionId={showCopyBanner}
            />
            <box
              flexGrow={1}
              paddingBottom={1}
              paddingTop={1}
              paddingLeft={2}
              paddingRight={2}
              gap={1}
              flexDirection="row"
            >
              {/* Main transcript column — splits with the context rail (P1). */}
              <box flexDirection="column" flexGrow={1} gap={1}>
                {/* Scrollable messages */}
                <Semantic
                  id="log"
                  role="log"
                  props={{ scrollTop: scrollRef.current?.scrollTop ?? 0, locked: scrollLockedAway, newSinceLock }}
                >
                  {/* biome-ignore lint/suspicious/noExplicitAny: OpenTUI type mismatch for stickyStart */}
                  <scrollbox ref={scrollRef} flexGrow={1} stickyScroll={true} stickyStart={"bottom" as any}>
                    {(() => {
                      const mcpRuns = computeMcpRunInfo(messages);
                      // Phase 5 F7 ΓÇö index of the last assistant message so
                      // MessageView can skip auto-collapse on it (final answer
                      // should always be fully visible, not hidden behind
                      // "ctrl+e expand").
                      let _lastAssistantIdx = -1;
                      for (let _i = messages.length - 1; _i >= 0; _i--) {
                        if (messages[_i]?.type === "assistant") {
                          _lastAssistantIdx = _i;
                          break;
                        }
                      }
                      return messages.map((msg, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: append-only message log; index is part of the stable semantic id
                        <Semantic
                          key={`sem-${msg.timestamp?.getTime?.() ?? i}-${i}`}
                          id={`msg-${i}`}
                          role="listitem"
                          name={`${msg.type ?? "msg"}:${String(msg.content ?? "").slice(0, 40)}`}
                        >
                          <MessageView
                            key={`${msg.timestamp?.getTime?.() ?? i}-${msg.type}-${msg.remoteKey ?? ""}-${String(msg.content ?? "").slice(0, 24)}`}
                            entry={msg}
                            index={i}
                            t={t}
                            modeColor={modeInfo.color}
                            expandedMessages={expandedMessages}
                            mcpRun={mcpRuns[i]}
                            isFinalAssistant={i === _lastAssistantIdx}
                          />
                        </Semantic>
                      ));
                    })()}
                    {/* taskListSnapshot moved below scrollbox ΓÇö renders as a
                      fixed-bottom panel so agent text can never push it up. */}
                    {liveTurnSourceLabel && (activeToolCalls.length > 0 || streamContent || isProcessing) && (
                      <box paddingLeft={3} marginTop={1} flexShrink={0}>
                        <text fg={t.textMuted}>{liveTurnSourceLabel}</text>
                      </box>
                    )}
                    {/* Active tool calls ΓÇö pending inline */}
                    {activeToolCalls.map((tc) =>
                      tc.function.name === "task" ? (
                        <SubagentTaskLine
                          key={tc.id}
                          t={t}
                          agent={tryParseArg(tc, "agent") || "sub-agent"}
                          label={toolArgs(tc) || "Working"}
                          pending
                        />
                      ) : tc.function.name === "delegate" ? (
                        <DelegationTaskLine
                          key={tc.id}
                          t={t}
                          label={toolArgs(tc) || "Background research"}
                          pending
                          id={undefined}
                        />
                      ) : (
                        <InlineTool key={tc.id} t={t} pending>
                          {toolLabel(tc)}
                        </InlineTool>
                      ),
                    )}
                    {activeSubagent && <SubagentActivity t={t} status={activeSubagent} />}
                    {/* Council metadata cards render here INLINE only when the
                      rail is off; when the rail is on they are hoisted into it
                      (see the <ContextRail> below) so they stop pushing the live
                      debate above the viewport. Halt/init-new/point-to-existing
                      cards still render AFTER councilMessages below so sticky-
                      bottom reveals them. */}
                    {!railActive && renderCouncilMeta(width)}
                    {(() => {
                      // Fold the debate back-and-forth (leader + debate + research
                      // turns) into a collapsible pill; render synthesis inline
                      // below so the deliverable stays visible. Preserve each
                      // turn's ORIGINAL index for stable Semantic ids (the harness
                      // queries `council-msg-N`).
                      type Turn = { cm: (typeof councilMessages)[number]; idx: number };
                      const turns: Turn[] = councilMessages.map((cm, idx) => ({ cm, idx }));
                      const debateTurns = turns.filter(({ cm }) => cm.kind !== "synthesis");
                      const synthesisTurns = turns.filter(({ cm }) => cm.kind === "synthesis");
                      const debateActive = isProcessing && synthesisTurns.length === 0;
                      const lastDebate = debateTurns.length > 0 ? debateTurns[debateTurns.length - 1]!.cm : null;
                      const tailText = lastDebate
                        ? lastDebate.text
                            .split("\n")
                            .filter((l) => l.trim().length > 0)
                            .slice(-3)
                            .join(" · ")
                        : "";

                      const renderTurn = ({ cm, idx }: Turn) => {
                        const side: "left" | "right" =
                          cm.kind === "debate" && cm.partner
                            ? getSide(makePairKey(cm.speaker.role, cm.partner.role), cm.speaker.role)
                            : "left";
                        const semName = `${cm.kind}:${cm.speaker?.role ?? "?"}`;
                        if (cm.kind === "leader") {
                          return (
                            <Semantic
                              key={`sem-cm-${idx}`}
                              id={`council-msg-${idx}`}
                              role="listitem"
                              name={semName}
                              value={cm.text}
                            >
                              <CouncilLeaderBubble key={idx} msg={cm} terminalCols={width} />
                            </Semantic>
                          );
                        }
                        const pairKey = cm.partner
                          ? makePairKey(cm.speaker.role, cm.partner.role)
                          : `solo::${cm.speaker.role}`;
                        const partnerLastText = cm.partner ? getPartnerLast(pairKey, cm.partner.role) : undefined;
                        return (
                          <Semantic
                            key={`sem-cm-${idx}`}
                            id={`council-msg-${idx}`}
                            role="listitem"
                            name={semName}
                            value={cm.text}
                          >
                            <CouncilMessageBubble
                              key={idx}
                              msg={cm}
                              terminalCols={width}
                              side={side}
                              resolveStyle={resolveStyle}
                              partnerLastText={partnerLastText}
                              partnerRole={cm.partner?.role}
                              theme={t}
                            />
                          </Semantic>
                        );
                      };

                      // P6 — round-grouped transcript: only the running round
                      // streams turns; done rounds collapse to a summary. Falls
                      // back to the collapsible pill when no round records exist
                      // (older paths / flag off).
                      const roundGroupsActive = isRoundGroupsEnabled() && councilRounds.length > 0;
                      return (
                        <>
                          {roundGroupsActive ? (
                            <>
                              <CouncilRoundsOverview rounds={councilRounds} theme={t} />
                              {councilRounds
                                // When a round is selected in the rail, scope the
                                // main pane to just that round (its debate turns
                                // expanded); otherwise show every round group.
                                .filter((rec) => selectedRound === null || rec.round === selectedRound)
                                .map((rec) => {
                                  const isSelected = selectedRound === rec.round;
                                  // Render turns while running (live) OR when this
                                  // round is the selected one (inspect its debate).
                                  const showTurns = rec.state === "running" || isSelected;
                                  return (
                                    <CouncilRoundGroup
                                      key={`round-${rec.round}`}
                                      record={rec}
                                      selected={isSelected}
                                      theme={t}
                                    >
                                      {showTurns
                                        ? debateTurns.filter(({ cm }) => cm.round === rec.round).map(renderTurn)
                                        : null}
                                    </CouncilRoundGroup>
                                  );
                                })}
                            </>
                          ) : (
                            debateTurns.length > 0 && (
                              <Semantic
                                id="council-debate-pill"
                                role="log"
                                name="Council debate transcript"
                                props={{
                                  expanded: councilTranscriptExpanded,
                                  active: debateActive,
                                  count: debateTurns.length,
                                }}
                              >
                                <CouncilDebatePill
                                  count={debateTurns.length}
                                  active={debateActive}
                                  expanded={councilTranscriptExpanded}
                                  tailText={tailText}
                                  theme={t}
                                >
                                  {councilTranscriptExpanded ? debateTurns.map(renderTurn) : null}
                                </CouncilDebatePill>
                              </Semantic>
                            )
                          )}
                          {synthesisTurns.map(({ cm, idx }) => (
                            <Semantic
                              key={`sem-cm-${idx}`}
                              id={`council-msg-${idx}`}
                              role="listitem"
                              name={`${cm.kind}:${cm.speaker?.role ?? "?"}`}
                              value={cm.text}
                            >
                              <CouncilSynthesisBanner key={idx} msg={cm} />
                            </Semantic>
                          ))}
                        </>
                      );
                    })()}
                    {Array.from(councilPlaceholders.entries()).map(([id, p]) => (
                      <CouncilPlaceholderBubble
                        key={id}
                        role={p.role}
                        side={p.side}
                        terminalCols={width}
                        color={p.color}
                        theme={t}
                        variant={p.variant}
                      />
                    ))}
                    {/* Council question / preflight askcards render at the END of
                      the scrollbox (see below) so the bottom-sticky scroll
                      always anchors to the active question. Rendered here they
                      sat ABOVE trailing live content (streamContent,
                      councilProgress, reasoning pill), which owned the sticky
                      anchor during the council debate phase ΓÇö leaving the card
                      scrolled above the fold so the user had to scroll UP to
                      find it. See fix/tui-askcard-anchor. */}
                    {/* Reasoning pill ΓÇö Claude-style "💭 ThinkingΓÇª" while a
                      reasoning streak is active, then "💭 Thought for Ns"
                      once the model emits text or a tool call. CoT body is
                      discarded so we never re-render heavy markdown for it. */}
                    {(reasoningActive || lastReasoningElapsedMs > 0) && (
                      <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
                        <text fg={t.textMuted}>
                          {reasoningActive
                            ? "[Thought] Thinking..."
                            : `[Thought] Thought for ${(lastReasoningElapsedMs / 1000).toFixed(1)}s`}
                        </text>
                        {streamReasoning ? (
                          <box
                            border={["left"]}
                            borderColor={t.textMuted}
                            paddingLeft={2}
                            marginTop={1}
                            flexDirection="column"
                          >
                            {reasoningActive ? (
                              // While actively streaming, render only the last 3
                              // non-empty lines as plain text to avoid Markdown
                              // re-parse overhead every 150ms.
                              <text fg={t.textMuted}>
                                {streamReasoning
                                  .split("\n")
                                  .filter((l) => l.trim().length > 0)
                                  .slice(-3)
                                  .join(" ┬╖ ")}
                              </text>
                            ) : (
                              <Markdown content={streamReasoning} t={t} />
                            )}
                          </box>
                        ) : null}
                      </box>
                    )}
                    {/* Streaming assistant content */}
                    {streamContent && (
                      <box paddingLeft={3} marginTop={1} flexShrink={0}>
                        <Markdown content={streamContent} t={t} />
                      </box>
                    )}
                    {/* Waiting indicator */}
                    {isProcessing && !streamContent && activeToolCalls.length === 0 && (
                      <ShimmerText t={t} text="Planning next moves" />
                    )}
                    {/* Plan questions panel ΓÇö inline, OpenCode-style */}
                    {showPlanPanel && <PlanQuestionsPanel t={t} questions={planQuestions} state={pqs} />}
                    {pendingPaymentApproval && <PaymentApprovalPanel t={t} payment={pendingPaymentApproval} />}
                    {/* Modals/wizards anchored to the bottom so sticky-bottom
                      auto-scroll keeps them in view even when councilMessages
                      fill the scrollbox. */}
                    {activeHaltCard && (
                      <HaltRecoveryCard
                        halt={activeHaltCard}
                        selectedIndex={haltSelectedIndex}
                        terminalCols={width}
                        theme={t}
                      />
                    )}
                    {initNewForm && <InitNewFormCard state={initNewForm} terminalCols={width} theme={t} />}
                    {pointToExistingForm && (
                      <PointToExistingFormCard state={pointToExistingForm} terminalCols={width} theme={t} />
                    )}
                    {councilProgress && (
                      <Semantic id="continue-as-council-progress" role="log" name="Council brainstorm">
                        <box
                          flexDirection="column"
                          borderStyle="single"
                          borderColor={councilProgress.status === "error" ? t.initFormError : t.text}
                          padding={1}
                          marginTop={1}
                        >
                          <text fg={t.text}>
                            {councilProgress.status === "running" && "Council brainstorming ΓÇö writing spec.md..."}
                            {councilProgress.status === "done" &&
                              `Council brainstorm complete: ${councilProgress.specPath}${councilProgress.hasContent ? "" : " (no content ΓÇö production council wiring deferred)"}`}
                            {councilProgress.status === "error" &&
                              `Council brainstorm failed: ${councilProgress.error}`}
                          </text>
                        </box>
                      </Semantic>
                    )}
                    {/* Active council askcards LAST so the bottom-sticky scroll
                      anchors to the pending question (moved here from above
                      streamContent/councilProgress ΓÇö see fix/tui-askcard-anchor). */}
                    {pendingCouncilQuestion && councilCardState && (
                      <CouncilQuestionCard question={pendingCouncilQuestion} theme={t} state={councilCardState} />
                    )}
                    {pendingCouncilPreflight && preflightCardState && (
                      <CouncilQuestionCard
                        question={buildPreflightQuestion(pendingCouncilPreflight)}
                        theme={t}
                        state={preflightCardState}
                      />
                    )}
                  </scrollbox>
                </Semantic>
                {scrollLockedAway && (
                  <box flexShrink={0} alignItems="center" marginTop={0}>
                    <JumpToLatestPill newSinceLock={newSinceLock} />
                  </box>
                )}
                {btwState && <BtwOverlay state={btwState} theme={t} />}
                {/* TodoCard ΓÇö fixed bottom so agent text cannot push it up */}
                {taskListSnapshot && (
                  <box flexShrink={0} paddingLeft={2} paddingRight={2} marginBottom={1}>
                    <TaskListPanel snapshot={taskListSnapshot} t={t} expanded={false} />
                  </box>
                )}
                {activeToast ? (
                  <box flexShrink={0} marginBottom={1}>
                    <Toast
                      key={activeToast.id}
                      level={activeToast.level}
                      text={activeToast.text}
                      theme={t}
                      onDismiss={dismissToast}
                    />
                  </box>
                ) : null}
                {/* Prompt */}
                <box flexShrink={0}>
                  <PromptBox
                    t={t}
                    inputRef={inputRef}
                    isProcessing={isProcessing}
                    showModelPicker={showModelPicker}
                    showSandboxPicker={showSandboxPicker}
                    showWalletPicker={showWalletPicker}
                    showSlashMenu={showSlashMenu}
                    showPlanQuestions={showPlanPanel}
                    showApiKeyModal={showApiKeyModal}
                    blockPrompt={blockPrompt}
                    onSubmit={handleSubmit}
                    onPaste={handlePaste}
                    pasteBlocks={pasteBlocks}
                    modeInfo={modeInfo}
                    model={model}
                    modelInfo={modelInfo}
                    contextStats={contextStats}
                    queuedCount={queuedMessages.length}
                    queuedMessages={queuedMessages}
                    typeahead={typeahead}
                    slashItems={filteredSlashItems}
                    slashSelectedIndex={slashMenuIndex}
                    slashInputIsMatched={slashInputIsMatched}
                    composerValue={showSlashMenu ? `/${slashSearchQuery}` : undefined}
                  />
                </box>
              </box>
              {railActive && (
                <ContextRail width={railWidth} rows={railRows}>
                  {renderCouncilMeta(railWidth)}
                </ContextRail>
              )}
            </box>
            <box paddingLeft={2} paddingRight={2} flexShrink={0}>
              <StatusBar />
            </box>
            <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="row" flexShrink={0}>
              <text fg={t.textDim}>{agent.getCwd().replace(os.homedir(), "~")}</text>
              {sandboxMode === "shuru" ? <text fg="#f97316">{" ┬╖ sandbox"}</text> : null}
              <box flexGrow={1} />
            </box>
          </box>
        ) : (
          <>
            <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
              <box flexGrow={1} minHeight={0} />
              <box flexShrink={0} alignItems="center">
                <HeroLogo t={t} />
              </box>
              <box height={1} minHeight={0} flexShrink={1} />
              <box width="100%" maxWidth={75} flexShrink={0}>
                {activeToast ? (
                  <box marginBottom={1} flexShrink={0}>
                    <Toast
                      key={activeToast.id}
                      level={activeToast.level}
                      text={activeToast.text}
                      theme={t}
                      onDismiss={dismissToast}
                    />
                  </box>
                ) : null}
                <PromptBox
                  t={t}
                  inputRef={inputRef}
                  isProcessing={isProcessing}
                  showModelPicker={showModelPicker}
                  showSandboxPicker={showSandboxPicker}
                  showWalletPicker={showWalletPicker}
                  showSlashMenu={showSlashMenu}
                  showPlanQuestions={showPlanPanel}
                  showApiKeyModal={showApiKeyModal}
                  blockPrompt={blockPrompt}
                  onSubmit={handleSubmit}
                  onPaste={handlePaste}
                  pasteBlocks={pasteBlocks}
                  modeInfo={modeInfo}
                  model={model}
                  modelInfo={modelInfo}
                  contextStats={contextStats}
                  placeholder={"What are we building?"}
                  typeahead={typeahead}
                  slashItems={filteredSlashItems}
                  slashSelectedIndex={slashMenuIndex}
                  slashInputIsMatched={slashInputIsMatched}
                  composerValue={showSlashMenu ? `/${slashSearchQuery}` : undefined}
                />
              </box>
              <box height={2} minHeight={0} flexShrink={1} />
              <box flexGrow={1} minHeight={0} />
            </box>
            {updateInfo?.hasUpdate && (
              <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
                <text fg="#f59e0b">
                  {"Γöâ Update available: v"}
                  {startupConfig.version}
                  {" ΓåÆ v"}
                  {updateInfo.latestVersion}
                  {" ΓÇö run /update to install"}
                </text>
              </box>
            )}
            {isUpdating && (
              <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
                <text fg="#f59e0b">{"Γöâ Updating..."}</text>
              </box>
            )}
            {updateOutput && !isUpdating && (
              <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
                <text fg={updateOutput.startsWith("Update complete") ? "#22c55e" : "#ef4444"}>
                  {"Γöâ "}
                  {updateOutput}
                </text>
              </box>
            )}
            <box paddingLeft={2} paddingRight={2} flexShrink={0}>
              <StatusBar />
            </box>
            <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="row" flexShrink={0}>
              <text fg={t.textDim}>{agent.getCwd().replace(os.homedir(), "~")}</text>
              {sandboxMode === "shuru" ? <text fg="#f97316">{" ┬╖ sandbox"}</text> : null}
              <box flexGrow={1} />
              <text fg={t.textDim}>{`v${startupConfig.version}`}</text>
            </box>
          </>
        )}
        {showApiKeyModal && (
          <ApiKeyModal
            t={t}
            width={width}
            height={height}
            inputRef={apiKeyInputRef}
            error={apiKeyError}
            onSubmit={submitApiKey}
          />
        )}
        {showUpdateModal && updateInfo && (
          <UpdateModal
            t={t}
            width={width}
            height={height}
            currentVersion={startupConfig.version}
            latestVersion={updateInfo.latestVersion}
          />
        )}
        {showMcpModal && !showMcpEditor && (
          <McpBrowserModal
            t={t}
            width={width}
            height={height}
            selectedIndex={mcpModalIndex}
            searchQuery={mcpSearchQuery}
            rows={mcpRows}
          />
        )}
        {showMcpEditor && (
          <McpEditorModal
            t={t}
            width={width}
            height={height}
            draft={mcpEditorDraft}
            focusedField={mcpEditorField}
            syncKey={mcpEditorSyncKey}
            error={mcpEditorError}
            title={editingMcpId ? "Edit MCP Server" : "Add MCP Server"}
            labelRef={mcpLabelRef}
            urlRef={mcpUrlRef}
            headersRef={mcpHeadersRef}
            commandRef={mcpCommandRef}
            argsRef={mcpArgsRef}
            cwdRef={mcpCwdRef}
            envRef={mcpEnvRef}
            onSubmit={submitMcpEditor}
          />
        )}
        {showScheduleModal && (
          <ScheduleBrowserModal
            t={t}
            width={width}
            height={height}
            selectedIndex={scheduleModalIndex}
            searchQuery={scheduleSearchQuery}
            rows={scheduleRows}
          />
        )}
        {showAgentsModal && !showAgentsEditor && (
          <SubagentsBrowserModal
            t={t}
            width={width}
            height={height}
            selectedIndex={agentsModalIndex}
            searchQuery={agentsSearchQuery}
            rows={agentRows}
          />
        )}
        {showAgentsEditor && (
          <SubagentEditorModal
            key={`subagent-editor-${agentsEditorSyncKey}`}
            t={t}
            width={width}
            height={height}
            draft={agentsEditorDraft}
            focusedField={agentsEditorField}
            modelIndex={agentsEditorModelIndex}
            error={agentsEditorError}
            title={editingSubagent ? `Edit sub-agent: ${formatSubagentName(editingSubagent.name)}` : "Add sub-agent"}
            nameRef={subagentNameRef}
            instructionRef={subagentInstructionRef}
            onSubmit={submitSubagentEditor}
            showRemoveHint={!!editingSubagent}
          />
        )}
        {showModelPicker && (
          <ModelPickerModal
            t={t}
            currentModel={model}
            selectedIndex={modelPickerIndex}
            width={width}
            height={height}
            searchQuery={modelSearchQuery}
            filteredModels={filteredModels}
            reasoningEffortByModel={reasoningEffortByModel}
            configuredProviders={configuredProviders}
            disabledProviders={disabledProviders}
            disabledModels={disabledModels}
            defaultProvider={defaultProvider}
            focus={modelPickerFocus}
            providerChipIndex={providerChipIndex}
            providersWithKey={providersWithKey}
            apiKeyPrompt={apiKeyPrompt}
            bwSync={bwSync}
          />
        )}
        {showSessionPicker && (
          <SessionPickerModal
            t={t}
            sessions={sessionPickerList}
            focusIndex={sessionPickerIndex}
            width={width}
            height={height}
          />
        )}
        {showWalletPicker && (
          <WalletPickerModal
            t={t}
            settings={walletSettings}
            walletInfo={walletDisplayInfo}
            focusIndex={walletFocusIndex}
            width={width}
            height={height}
          />
        )}
        {showSandboxPicker && (
          <SandboxPickerModal
            t={t}
            currentMode={sandboxMode}
            settings={sandboxSettings}
            focusIndex={sandboxSettingsFocusIndex}
            editing={sandboxSettingsEditing}
            editBuffer={sandboxSettingsEditBuffer}
            width={width}
            height={height}
          />
        )}
        {showConnectModal && (
          <ConnectModal
            t={t}
            width={width}
            height={height}
            selectedIndex={connectModalIndex}
            channels={CONNECT_CHANNELS}
          />
        )}
        {showTelegramTokenModal && (
          <TelegramTokenModal
            t={t}
            width={width}
            height={height}
            inputRef={telegramTokenInputRef}
            error={telegramTokenError}
            onSubmit={submitTelegramToken}
          />
        )}
        {showTelegramPairModal && (
          <TelegramPairModal
            t={t}
            width={width}
            height={height}
            inputRef={telegramPairInputRef}
            error={telegramPairError}
            onSubmit={() => void submitTelegramPair()}
          />
        )}
      </box>
    </SemanticProvider>
  );
}

// ApiKeyModal extracted to src/ui/modals/api-key-modal.tsx

export type { McpRunInfo } from "./components/message-view.js";
export { computeMcpRunInfo } from "./components/message-view.js";

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
