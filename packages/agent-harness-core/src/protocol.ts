export const PROTOCOL_VERSION = "0.4.0" as const;

/**
 * Known accessibility-style roles for semantic blocks. Closed vocabulary —
 * `Role` (below) additionally admits namespaced `x-*` custom roles so new UI
 * surfaces can be introduced without a protocol version bump (additive-only).
 */
export type KnownRole =
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
  | "region"
  // IDE / editor surfaces (added for the desktop frontend; harmless in the TUI)
  | "editor"
  | "diff"
  | "gutter"
  | "panel";

/**
 * A semantic role. Either a well-known {@link KnownRole} or a namespaced
 * `x-<custom>` role. The `x-` prefix keeps custom roles greppable and prevents
 * silent collisions with future well-known roles — additive versioning via the
 * `tui.capabilities` handshake rather than a breaking protocol bump.
 */
export type Role = KnownRole | `x-${string}`;

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

/**
 * Text-attribute bit flags in {@link VisualSpan.attrs}. Mirrors the low byte of
 * OpenTUI's `TextAttributes` (`ATTRIBUTE_BASE_MASK = 255`), so a consumer can
 * decode `attrs & VisualAttr.BOLD` etc. without importing the renderer.
 */
export const VisualAttr = {
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  HIDDEN: 64,
  STRIKETHROUGH: 128,
} as const;

/** One coalesced run of identically-styled cells on a visual line. */
export type VisualSpan = {
  /** The run's text (wide-char continuation cells omitted; `width` reflects columns). */
  text: string;
  /** Foreground color as "#rrggbb" (or "#rrggbbaa" when alpha < 255). */
  fg: string;
  /** Background color as "#rrggbb" (or "#rrggbbaa"). */
  bg: string;
  /** Text-attribute bitmask — decode with {@link VisualAttr}. */
  attrs: number;
  /** Display columns this run occupies (accounts for wide CJK/emoji). */
  width: number;
};

/** One row of the rendered grid, as style-coalesced spans. */
export type VisualLine = { spans: VisualSpan[] };

/**
 * Ground-truth snapshot of the ACTUAL rendered terminal cell grid — the real
 * characters, colors, and attributes OpenTUI painted, read directly from
 * `CliRenderer.currentRenderBuffer.getSpanLines()`. Unlike {@link LiveFrame}
 * (semantic structure), this is what a human SEES on screen. No OCR — the cell
 * buffer is authoritative. Emitted on the same sidechannel as LiveFrame,
 * deduped by content hash, and (to bound `getSpanLines` allocation) only
 * captured when a semantic frame also changes.
 */
export type VisualFrame = {
  mode: "visual";
  version: typeof PROTOCOL_VERSION;
  seq: number;
  ts: number;
  cols: number;
  rows: number;
  /** Cursor [col, row], or null when hidden/unknown. */
  cursor: [number, number] | null;
  lines: VisualLine[];
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
      /**
       * "start" — speaker began; "tick" — 1s progress heartbeat (long phases
       * like research emit these with an advancing `elapsedMs`); "done" —
       * speaker finished. A harness poller distinguishes ALIVE (tick with
       * advancing elapsedMs) from HUNG (elapsedMs frozen) via `tui_last_event`.
       */
      status: "start" | "tick" | "done";
      /** Round number if available from the status chunk. */
      round?: number;
      /** Correlation ID linking this speaker event to the enclosing council run. */
      correlationId: string;
      /** Milliseconds elapsed in this speaker's turn/phase; advances on ticks. */
      elapsedMs?: number;
      /**
       * Chars (text + reasoning deltas) streamed since this phase began.
       * `elapsedMs` can freeze on a HEALTHY call — its tick generator only
       * advances when the consumer pulls, and a round awaiting its pairs via
       * Promise.all does not pull. This counter is pushed from the token stream
       * itself, so growth here proves liveness regardless of pumping.
       */
      streamedChars?: number;
      /**
       * Age in ms of the most recent stream delta. Small + growing
       * `streamedChars` = SLOW BUT ALIVE (e.g. a reasoning model emitting
       * reasoning tokens for minutes before any text); growing age + static
       * chars = genuinely STUCK.
       */
      lastDeltaAgeMs?: number;
    }
  // Thrift measurability — emitted when a council speaker's turn output is fully
  // assembled (opening statement or discussion turn). Observe-only: NO truncation,
  // NO behaviour change; it just reports how long each speaker spoke so a harness
  // can measure council verbosity per role/model/round. See src/council/debate.ts.
  | {
      t: "event";
      kind: "council-turn-length";
      /** Council role label (e.g. "architect"); matches council-speaker.role. */
      role: string;
      /** Debate round: 0 = opening statements, 1+ = discussion rounds. */
      round: number;
      /** Full character count of the speaker's output (trimmed; never truncated). */
      charCount: number;
      /** Word count of the speaker's output (whitespace-split, empties dropped). */
      wordCount: number;
      /** The speaker's model id, for per-model thrift attribution. */
      model: string;
      /** Correlation ID tying turns to the enclosing council run (= sessionId). */
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
  // Transient stream error retry — emitted by the orchestrator retry loop
  // before each backoff sleep. Lets E2E specs assert retry semantics without
  // waiting for the full backoff period.
  | {
      t: "event";
      kind: "stream-retry";
      /** 1-based retry attempt number (first retry = 1). */
      attempt: number;
      maxAttempts: number;
      errorName: string;
      errorMessage: string;
      nextDelayMs: number;
    }
  // Summary-phase grounding check — emitted at turn finalize when the model's
  // final synthesis asserts counts / file:line refs that do NOT appear in this
  // turn's tool outputs (possible hallucination). Soft-flag only; the turn is
  // never blocked. See src/orchestrator/grounding-check.ts.
  | {
      t: "event";
      kind: "grounding-flag";
      /** The unverified claim texts, e.g. ["67 tests", "app.tsx:836"]. */
      claims: string[];
      /** Total number of unverified claims in this turn. */
      count: number;
      ts: number;
    }
  | {
      t: "event";
      kind: "steer-inject";
      /** How many queued messages were injected at this boundary. */
      count: number;
      /** The prepareStep step number at which injection occurred (>= 1). */
      atStep: number;
      runId: string;
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

export type HarnessMessage = LiveFrame | VisualFrame | LiveEvent;
