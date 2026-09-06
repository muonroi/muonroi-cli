export const PROTOCOL_VERSION = "0.4.0" as const;

/**
 * Known accessibility-style roles for semantic blocks. Closed vocabulary —
 * `Role` (below) additionally admits namespaced `x-*` custom roles so new UI
 * surfaces can be introduced without a protocol version bump (additive-only).
 *
 * Declared as a runtime array and the {@link KnownRole} type derived FROM it,
 * not the other way round: `tui.capabilities` has to hand a driving agent the
 * role vocabulary, and a type-only union is invisible at runtime. Deriving in
 * this direction makes a role that exists in the type but not in the advertised
 * vocabulary unrepresentable.
 */
export const KNOWN_ROLES = [
  "dialog",
  "textbox",
  "listbox",
  "listitem",
  "button",
  "checkbox",
  "radio",
  "radiogroup",
  "tab",
  "tablist",
  "tree",
  "treeitem",
  "table",
  "row",
  "cell",
  "progressbar",
  "spinner",
  "log",
  "statusbar",
  "menu",
  "menuitem",
  "toast",
  "tooltip",
  "region",
  // ARIA landmark / live-region / grouping roles (council surface sections)
  "status",
  "complementary",
  "group",
  "banner",
  "article",
  // IDE / editor surfaces (added for the desktop frontend; harmless in the TUI)
  "editor",
  "diff",
  "gutter",
  "panel",
] as const;

export type KnownRole = (typeof KNOWN_ROLES)[number];

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
  // The terminal event of a `/ideal` run — the SUCCESS counterpart to
  // `sprint-halt`. A failing run has announced itself since Phase 0
  // (`sprint-halt reason=…`, `announceDriverBail`), but a run that finished
  // FINE emitted nothing at all, so "approved" and "hung" were the same
  // observation to a driver watching the event stream. Emitted from the single
  // choke point every `/ideal` subcommand returns through
  // (`runProductLoop` in src/product-loop/index.ts), in a `finally`, so it also
  // covers the two exits that never produce a result: an exception escaping the
  // generator, and the consumer tearing the generator down mid-run.
  | {
      t: "event";
      kind: "run-finished";
      /** The `/ideal` run id. `""` when the run died before `createRun`. */
      runId: string;
      /** Which `/ideal` subcommand ended (start | status | resume | abort | ship | review). */
      subcommand: string;
      /**
       * How the run ENDED, named so a driver can act without parsing prose:
       *  - `approved`  — reached the approved stage (the success case)
       *  - `halted`    — stopped at a gate or by user action; `reason` says which
       *  - `error`     — returned a failure result; `reason` says which
       *  - `threw`     — an exception escaped the run; `reason` is its message
       *  - `abandoned` — the consumer tore the generator down before it returned
       */
      outcome: "approved" | "halted" | "error" | "threw" | "abandoned";
      /** Mirrors `ProductLoopResult.success`; always false for `threw` / `abandoned`. */
      success: boolean;
      /** Stable machine code (e.g. "shipped", "not_found", "budget exhausted"). */
      reason: string;
      /** Sprints actually executed; 0 when none ran or the count is unknown. */
      sprintsRun: number;
      /** Whether the run reached the shipped state. */
      shipped: boolean;
      ts: number;
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
  // A call was deliberately HELD to stay inside a provider limit the catalog
  // declares (`rate_limits` in catalog.json). Emitted by the request pacer
  // (src/providers/rate-limiter.ts) via the metered gate, only when a wait was
  // actually incurred — a call that fits the budget emits nothing.
  //
  // Deliberately NOT folded into `stream-retry`, for the same reason
  // `model-fallback` is not: `stream-retry` means an error already happened and
  // the SAME call is being re-attempted, and it carries `attempt`/`maxAttempts`/
  // `errorName`/`errorMessage` to say which error and which try. A pacing wait is
  // the opposite — no error occurred, no attempt was consumed, and the request
  // has not been sent yet. Reusing the kind would mean fabricating an error name
  // and an attempt number for a healthy call, corrupting exactly the retry metric
  // that comment protects, and making "attempt 2 of 3" ambiguous between "the
  // provider rejected us" and "we chose to wait".
  //
  // A driving agent needs this: without it a paced call is indistinguishable from
  // a hung one, which is the precise failure shape ("reported success for
  // something that did not happen") this protocol exists to eliminate.
  | {
      t: "event";
      kind: "rate-limit-wait";
      /** Provider whose account-level budget produced the wait. */
      provider: string;
      /** Model the held call was going to. */
      modelId: string;
      /** Pipeline stage of the held call (main / council / subagent / …). */
      stage: string;
      /** Which declared budget bound: the per-minute request count, or in-flight concurrency. */
      limitKind: "requests-per-minute" | "concurrency";
      /** The declared ceiling that produced the wait, verbatim from the catalog. */
      limit: number;
      /** How long the call was held, in ms. */
      waitMs: number;
      ts: number;
    }
  // A council model-fallback chain advanced to a DIFFERENT model, or ran out of
  // candidates. Distinct from `stream-retry` on purpose: that kind means the SAME
  // model is retried after a transient error with a backoff, and carries no model
  // identity. Here the model itself is substituted, there is no backoff, and the
  // trigger is frequently NOT an error at all (`empty-completion` — a reasoning
  // model that spends its whole output budget inside <think> and returns nothing).
  // Folding the two together would make "attempt 2 of 3" ambiguous between "same
  // model, second try" and "second different model", silently corrupting any
  // retry metric built on stream-retry.
  //
  // Before this existed, the ONLY trace of a provider switch was the human-readable
  // label string `"<label> (fallback: <modelId>)"` on a council-speaker event — a
  // driving agent had to regex a display label to learn the model policy had been
  // violated, and the reason was destroyed by a bare `catch {}`.
  | {
      t: "event";
      kind: "model-fallback";
      /** The model that just failed or returned nothing. */
      fromModel: string;
      /** The next candidate to be tried, or null when the chain is exhausted. */
      toModel: string | null;
      /**
       * Why the chain advanced:
       *  - "error"            — the call threw (see statusCode / errorMessage)
       *  - "empty-completion" — the call SUCCEEDED and was billed, but produced
       *                         no usable text after think-block stripping
       *  - "blocked"          — candidate skipped; already blocklisted this session
       */
      reason: "error" | "empty-completion" | "blocked";
      /** 1-based index of the candidate that just failed. */
      attempt: number;
      /** Total candidates in the deduped chain. */
      totalCandidates: number;
      /**
       * True on the single terminal record emitted when EVERY candidate failed.
       * The last candidate's own record also carries `toModel: null` (there was
       * no next model), so this flag — not a null check — is what a driver
       * filters on to detect an exhausted chain without double-counting.
       */
      exhausted?: boolean;
      /** Phase label, e.g. "Inferring spec from topic". */
      label?: string;
      /** Provider id backing `fromModel`, when resolvable. */
      provider?: string;
      /** HTTP status when the failure was an API error (429 vs 401 want opposite responses). */
      statusCode?: number;
      errorName?: string;
      /** Provider-side message. Capped + scrubbed by event-redact. */
      errorMessage?: string;
      ts: number;
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
  // Emitted when /resume is invoked while the TUI runs under the harness
  // (agent-mode). A relaunch would spawn a NEW process that cannot inherit the
  // fd3/4 (POSIX) or named-pipe (Windows) harness transport, stranding the
  // driver (every subsequent tui.* call returns no_driver). So under agent-mode
  // the relaunch is SUPPRESSED and this event is emitted instead: the current
  // process + driver stay alive, and the driving agent should resume by calling
  // tui.stop then tui.start({ args: ["--session=<sessionId>"] }).
  | {
      t: "event";
      kind: "resume-request";
      /** The session id the user selected to resume. */
      sessionId: string;
      ts: number;
    }
  // Emitted exactly once per process, at the moment the React input bridge
  // registers its command handler — i.e. the first instant a `type`/`press`
  // can actually reach the UI.
  //
  // Before this existed there was no way to ask "is this TUI ready for input?".
  // The transport accepts commands ~120 ms after process start, but nothing
  // consumed them until the bridge mounted 445-745 ms later (measured), and
  // everything sent inside that window was discarded by an empty handler array
  // with no error and no event. Those commands are now buffered across the
  // window (`agent-mode.ts`), and this event is how a driver LEARNS the window
  // closed — and, via `dropped`, whether anything was lost after all.
  //
  // Gate on `wait_for({event:"input-ready"})`, not `wait_for({idle:true})`: the
  // event condition is replay-safe (the driver scans its buffered ring), while
  // `idle` is captured-start based and resolves on an empty pre-mount frame.
  | {
      t: "event";
      kind: "input-ready";
      /** Pre-mount commands replayed into the bridge at registration. */
      flushed: number;
      /** Commands discarded because the pre-mount buffer overflowed (normally 0). */
      dropped: number;
      ts: number;
    }
  | { t: "idle" };

/** The `kind` discriminant of every non-sentinel {@link LiveEvent} member. */
export type LiveEventKind = Extract<LiveEvent, { t: "event" }>["kind"];

/**
 * Runtime list of every {@link LiveEvent} kind, excluding the `{t:"idle"}`
 * sentinel (which carries no `kind`).
 *
 * The `LiveEvent` union is type-only, so nothing downstream — the
 * `tui.last_event` MCP enum, the `tui.capabilities` payload — could enumerate it
 * at runtime; both maintained hand-written copies instead, and the MCP enum
 * drifted to 21 of 22 (`resume-request` was missing, so that call was rejected
 * at the boundary). This array is that runtime projection, and the two
 * assertions below make it exhaustive at COMPILE time in both directions: a new
 * union member that is not listed here, or an entry here that no union member
 * declares, fails `tsc`. Zero runtime cost.
 */
export const LIVE_EVENT_KINDS = [
  "stream.delta",
  "toast",
  "llm-token",
  "llm-done",
  "council-step",
  "council-speaker",
  "council-turn-length",
  "askcard-open",
  "askcard-answered",
  "askcard-cancel",
  "sprint-stage",
  "sprint-halt",
  "run-finished",
  "sprint-plan-committed",
  "route-decision",
  "usage",
  "ee-timeout",
  "ee-error",
  "disconnect",
  "stream-retry",
  "rate-limit-wait",
  "model-fallback",
  "grounding-flag",
  "steer-inject",
  "resume-request",
  "input-ready",
] as const;

/** Fails to compile unless `T` is `never`. */
type AssertNever<T extends never> = T;
/** A LiveEvent kind exists that LIVE_EVENT_KINDS does not list. */
export type _LiveEventKindsMissing = AssertNever<Exclude<LiveEventKind, (typeof LIVE_EVENT_KINDS)[number]>>;
/** LIVE_EVENT_KINDS lists a kind no LiveEvent member declares. */
export type _LiveEventKindsExtra = AssertNever<Exclude<(typeof LIVE_EVENT_KINDS)[number], LiveEventKind>>;

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
