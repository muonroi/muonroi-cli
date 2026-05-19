export const PROTOCOL_VERSION = "0.4.0" as const;

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
  // Phase 1 — lifecycle events (1.1–1.9)
  | {
      t: "event";
      kind: "llm-token";
      /** Correlation ID — matches the runId or callId passed at emit time. */
      correlationId: string;
      /** The raw text delta exactly as the model returned it. */
      delta: string;
      /** Monotonic token index within this call (0-based). */
      tokenIndex: number;
    }
  | {
      t: "event";
      kind: "llm-done";
      correlationId: string;
      /** Total text chars emitted (not token count — avoids provider coupling). */
      totalChars: number;
      /** Finish reason from the AI SDK: "stop" | "length" | "tool-calls" | "error" | "other". */
      finishReason: string;
    }
  | {
      t: "event";
      kind: "council-step";
      phaseId: string;
      /** CouncilPhaseKind string union (kept as string to avoid cross-package dep).
       *  Source enum: CouncilPhaseKind in src/types/index.ts */
      phaseKind: string;
      /** "active" | "done" | "error" */
      state: string;
      label: string;
      elapsedMs?: number;
    }
  | {
      t: "event";
      kind: "council-speaker";
      /** The council role label (e.g. "architect", "security", "qa"). */
      role: string;
      /** "start" — speaker began their turn; "done" — speaker finished. */
      status: "start" | "done";
      /** Round number if available from the status chunk. */
      round?: number;
      /** Correlation ID linking this speaker event to the enclosing council run. */
      correlationId: string;
    }
  | {
      t: "event";
      kind: "askcard-open";
      questionId: string;
      question: string;
      /** "clarify" | "preflight" | "plan-confirm" | "post-debate" */
      phase: string;
      optionCount: number;
      defaultIndex?: number;
    }
  | {
      t: "event";
      kind: "askcard-answered";
      questionId: string;
      /** "choice" | "freetext" | "chat" */
      answerKind: string;
      /** The answer text. Redacted to "[redacted]" if it contains any API key pattern. */
      answerText: string;
    }
  | {
      t: "event";
      kind: "askcard-cancel";
      questionId: string;
    }
  | {
      t: "event";
      kind: "sprint-stage";
      /** Sprint number (1-based). */
      sprintIndex: number;
      /** Current stage entering. */
      stage: "planning" | "implementation" | "verification" | "judgment";
      runId: string;
    }
  | {
      t: "event";
      kind: "sprint-halt";
      sprintN: number;
      /** Halt reason as surfaced by the CB gate that fired. */
      reason: string;
      runId: string;
    }
  | {
      t: "event";
      kind: "sprint-plan-committed";
      runId: string;
      /** Absolute path to the scaffolded project directory, or null when not a scaffolded project. */
      projectDir: string | null;
      /** Total number of sprints in the committed plan. */
      sprintCount: number;
      /** Stable per-sprint identifiers (e.g. "sprint-1", "sprint-2", ...). */
      sprintIds: readonly string[];
      /** Who decided the plan: "leader" = council path, "auto" = hot-path. */
      source: "leader" | "council" | "auto";
      ts: number;
    }
  | {
      t: "event";
      kind: "route-decision";
      /** "hot-path" | "council" */
      path: "hot-path" | "council";
      complexity: string;
      forceCouncil: boolean;
      runId: string;
    }
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
  // Phase 21 — Experience Engine observability. Emitted by src/utils/ee-logger.ts
  // whenever a silent EE catch site fires. `source` is a stable identifier (e.g.
  // `bridge.classifyViaBrain`, `pil.pipeline.logInteraction`) — see Plan 21-01
  // table for the canonical list.
  | {
      t: "event";
      kind: "ee-timeout";
      source: string;
      elapsedMs?: number;
      budgetMs?: number;
      ts: number;
    }
  | {
      t: "event";
      kind: "ee-error";
      source: string;
      name?: string;
      message?: string;
      ts: number;
    }
  // Transport-level event — fired by the harness helper when the underlying
  // outRead stream emits 'end' or 'close'. Lets E2E specs assert a typed
  // disconnect contract instead of waiting for a generic wait_for timeout.
  | {
      t: "event";
      kind: "disconnect";
      /** "end" — orderly EOF; "close" — stream closed (possibly with error). */
      reason: "end" | "close";
      ts: number;
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
