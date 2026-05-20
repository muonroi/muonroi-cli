import type { PaymentChain, SandboxMode } from "../utils/settings.js";
import type { McpEditorField } from "./mcp-modal-types.js";
import type { SandboxRow, WalletRow } from "./types.js";

// ---------------------------------------------------------------------------
// Small animation constants
// ---------------------------------------------------------------------------

export const STAR_PALETTE = ["#777777", "#666666", "#4a4a4a", "#333333", "#222222"];
export const LOADING_SPINNER_FRAMES = ["⬒", "⬔", "⬓", "⬕"];
export const PROMPT_LOADING_FRAMES = [
  { active: 0, forward: true },
  { active: 1, forward: true },
  { active: 2, forward: true },
  { active: 1, forward: false },
] as const;

// ---------------------------------------------------------------------------
// Hero logo types + data
// ---------------------------------------------------------------------------

export type Star = { col: number; ch: string };
export type Row = { stars: Star[]; brand?: number };

export const HERO_ROWS: Row[] = [
  {
    stars: [
      { col: 0, ch: "·" },
      { col: 13, ch: "*" },
      { col: 21, ch: "·" },
      { col: 34, ch: "·" },
    ],
  },
  {
    stars: [
      { col: 3, ch: "*" },
      { col: 11, ch: "·" },
      { col: 17, ch: "·" },
      { col: 25, ch: "*" },
    ],
  },
  {
    stars: [
      { col: 6, ch: "·" },
      { col: 12, ch: "·" },
      { col: 15, ch: "·" },
      { col: 18, ch: "·" },
      { col: 24, ch: "·" },
    ],
  },
  {
    stars: [
      { col: 2, ch: "·" },
      { col: 10, ch: "·" },
      { col: 19, ch: "·" },
      { col: 27, ch: "·" },
    ],
    brand: 13,
  },
  {
    stars: [
      { col: 6, ch: "·" },
      { col: 12, ch: "·" },
      { col: 15, ch: "·" },
      { col: 18, ch: "·" },
      { col: 24, ch: "·" },
    ],
  },
  {
    stars: [
      { col: 3, ch: "·" },
      { col: 11, ch: "*" },
      { col: 17, ch: "·" },
      { col: 25, ch: "·" },
    ],
  },
  {
    stars: [
      { col: 0, ch: "*" },
      { col: 13, ch: "·" },
      { col: 21, ch: "*" },
      { col: 34, ch: "·" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Sandbox settings rows + helper
// ---------------------------------------------------------------------------

export const SANDBOX_ROWS: SandboxRow[] = [
  {
    key: "mode",
    label: "Mode",
    type: "toggle",
    getDisplay: (mode) => (mode === "shuru" ? "Shuru" : "Off"),
    getOptions: () => ["Off", "Shuru"],
    apply: (_mode, _s, value) => ({ mode: value === "Shuru" ? "shuru" : "off" }),
  },
  {
    key: "allowNet",
    label: "Network",
    type: "toggle",
    getDisplay: (_m, s) => (s.allowNet ? "On" : "Off"),
    getOptions: () => ["Off", "On"],
    apply: (_m, _s, value) => ({ settings: { allowNet: value === "On" } }),
  },
  {
    key: "allowedHosts",
    label: "Allowed hosts",
    type: "text",
    placeholder: "api.openai.com, registry.npmjs.org",
    getDisplay: (_m, s) => s.allowedHosts?.join(", ") || "(unrestricted)",
    apply: (_m, _s, value) => ({
      settings: {
        allowedHosts: value
          ? value
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean)
          : undefined,
      },
    }),
  },
  {
    key: "ports",
    label: "Port forwards",
    type: "text",
    placeholder: "8080:80, 8443:443",
    getDisplay: (_m, s) => s.ports?.join(", ") || "(none)",
    apply: (_m, _s, value) => ({
      settings: {
        ports: value
          ? value
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
          : undefined,
      },
    }),
  },
  {
    key: "cpus",
    label: "CPUs",
    type: "text",
    placeholder: "e.g. 4",
    getDisplay: (_m, s) => (s.cpus ? String(s.cpus) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { cpus: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "memory",
    label: "Memory (MB)",
    type: "text",
    placeholder: "e.g. 4096",
    getDisplay: (_m, s) => (s.memory ? String(s.memory) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { memory: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "diskSize",
    label: "Disk size (MB)",
    type: "text",
    placeholder: "e.g. 8192",
    getDisplay: (_m, s) => (s.diskSize ? String(s.diskSize) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { diskSize: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "from",
    label: "Checkpoint",
    type: "text",
    placeholder: "checkpoint name",
    getDisplay: (_m, s) => s.from || "(none)",
    apply: (_m, _s, value) => ({ settings: { from: value || undefined } }),
  },
];

export function getSandboxVisibleRows(mode: SandboxMode): SandboxRow[] {
  return mode === "shuru" ? SANDBOX_ROWS : SANDBOX_ROWS.slice(0, 1);
}

// ---------------------------------------------------------------------------
// Wallet settings rows
// ---------------------------------------------------------------------------

export const WALLET_ROWS: WalletRow[] = [
  {
    key: "enabled",
    label: "Payments",
    type: "toggle",
    getDisplay: (s) => (s.enabled ? "enabled" : "disabled"),
    getOptions: () => ["enabled", "disabled"],
    apply: (_s, v) => ({ enabled: v === "enabled" }),
  },
  {
    key: "chain",
    label: "Chain",
    type: "toggle",
    getDisplay: (s) => s.chain,
    getOptions: () => ["base-sepolia", "base"] as PaymentChain[],
    apply: (_s, v) => ({ chain: v as PaymentChain }),
  },
  {
    key: "autoApprove",
    label: "Auto-approve",
    type: "toggle",
    getDisplay: (s) => (s.approval.autoApprove ? "on" : "off"),
    getOptions: () => ["off", "on"],
    apply: (s, v) => ({ approval: { ...s.approval, autoApprove: v === "on" } }),
  },
  {
    key: "address",
    label: "Address",
    type: "readonly",
    getDisplay: (_s, info) => info.address ?? "No wallet",
  },
  {
    key: "eth",
    label: "ETH",
    type: "readonly",
    getDisplay: (_s, info) => info.ethBalance ?? "...",
  },
  {
    key: "usdc",
    label: "USDC",
    type: "readonly",
    getDisplay: (_s, info) => info.usdcBalance ?? "...",
  },
];

// ---------------------------------------------------------------------------
// MCP editor field lists
// ---------------------------------------------------------------------------

export const MCP_REMOTE_FIELDS: McpEditorField[] = ["transport", "label", "url", "headers", "env"];
export const MCP_STDIO_FIELDS: McpEditorField[] = ["transport", "label", "command", "args", "cwd", "env"];

// ---------------------------------------------------------------------------
// Connect channels
// ---------------------------------------------------------------------------

export const CONNECT_CHANNELS: { id: string; label: string; description: string }[] = [
  { id: "telegram", label: "Telegram", description: "Chat from Telegram" },
];
