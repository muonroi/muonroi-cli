export const PROTOCOL_VERSION = "0.1.0" as const;

export type Role =
  | "dialog"
  | "textbox"
  | "listbox"
  | "listitem"
  | "button"
  | "checkbox"
  | "radio"
  | "radiogroup"
  | "tab"
  | "tablist"
  | "tree"
  | "treeitem"
  | "table"
  | "row"
  | "cell"
  | "progressbar"
  | "spinner"
  | "log"
  | "statusbar"
  | "menu"
  | "menuitem"
  | "toast"
  | "tooltip"
  | "region";

export type UINode = {
  id: string;
  role: Role;
  name?: string;
  value?: string;
  focus?: true;
  selected?: true;
  disabled?: true;
  hidden?: true;
  isModal?: true;
  state?: string;
  props?: Record<string, unknown>;
  children?: UINode[];
};

export type LiveFrame = {
  mode: "live";
  version: typeof PROTOCOL_VERSION;
  seq: number;
  ts: number;
  focus?: string;
  modals?: string[];
  nodes: UINode[];
};

export type LiveEvent =
  | { t: "event"; kind: "stream.delta"; target: string; text: string }
  | { t: "event"; kind: "toast"; level: "info" | "warn" | "error"; text: string; ttlMs?: number }
  // Phase D — surfaced for harness E2E verification of usage-event normalization
  // (e.g. cost-leak-c1: DeepSeek prompt_cache_hit_tokens → cacheReadTokens).
  | {
      t: "event";
      kind: "usage";
      source: string;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      messageSeq?: number | null;
    }
  | { t: "idle" };

export type StatePatch = { id: string } & Partial<Omit<UINode, "children" | "id">>;

export type DesignSpec = {
  mode: "design";
  version: typeof PROTOCOL_VERSION;
  target?: "tui" | "react" | "angular" | "any";
  scenes: Array<{
    id: string;
    name: string;
    layout: UINode;
    states?: Array<{ name: string; patches: StatePatch[] }>;
    transitions?: Array<{ from: string; on: string; to: string }>;
    notes?: string;
  }>;
};

export type HarnessMessage = LiveFrame | LiveEvent;
