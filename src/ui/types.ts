import type { Agent } from "../orchestrator/orchestrator.js";
import type { SandboxMode, SandboxSettings } from "../utils/settings.js";

export type ContextStats = {
  contextWindow: number;
  usedTokens: number;
  remainingTokens: number;
  ratioUsed: number;
  ratioRemaining: number;
};

export type PasteBlock = {
  id: number;
  content: string;
  lines: number;
  isImage?: boolean;
  clipboardBase64?: string;
  clipboardMediaType?: string;
};

export type FileMentionBlock = { id: number; path: string };

export type QueuedMessage = { text: string; displayText: string };

export interface SandboxRow {
  key: string;
  label: string;
  type: "toggle" | "text";
  placeholder?: string;
  getDisplay: (mode: SandboxMode, s: SandboxSettings) => string;
  getOptions?: () => string[];
  apply: (mode: SandboxMode, s: SandboxSettings, value: string) => { mode?: SandboxMode; settings?: SandboxSettings };
}

export interface WalletDisplayInfo {
  address: string | null;
  ethBalance: string | null;
  usdcBalance: string | null;
}

export interface WalletRow {
  key: string;
  label: string;
  type: "toggle" | "readonly";
  getDisplay: (settings: Record<string, unknown>, info: WalletDisplayInfo) => string;
  getOptions?: () => string[];
  apply?: (settings: Record<string, unknown>, value: string) => Partial<Record<string, unknown>>;
}

export interface AppStartupConfig {
  apiKey: string | undefined;
  baseURL: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings: SandboxSettings;
  maxToolRounds: number;
  version: string;
  /**
   * TEST SEAM (Task 5.2): when true, dispatch a synthetic halt chunk after the
   * TUI reaches its first idle state. Lets harness E2E specs verify the recovery
   * card without triggering a real CB-3 sprint run.
   * Never set this in production — only passed via --inject-halt CLI flag.
   */
  injectHalt?: boolean;
}
