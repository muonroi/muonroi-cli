import { evaluatePredicate, type Predicate, predicateSchema } from "./predicate.js";
import type { LiveEvent, LiveFrame, UINode, VisualFrame } from "./protocol.js";
import { matchSelector } from "./selector.js";
import { computeVisualQuality, type VisualQualityReport } from "./visual-quality.js";

/** A single decoded cell from the rendered grid (returned by `visual_cell`). */
export type VisualCell = {
  char: string;
  fg: string;
  bg: string;
  attrs: number;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WaitConditionIdle = { idle: true };
type WaitConditionSelector = { selector: string };
type WaitConditionEvent = {
  event: string;
  /** Optional: only satisfy if at least one buffered event of this kind passes this check. */
  match?: (e: LiveEvent) => boolean;
};
type WaitConditionAll = { all: (WaitConditionIdle | WaitConditionSelector | WaitConditionEvent)[] };

export type WaitArgs = (WaitConditionIdle | WaitConditionSelector | WaitConditionEvent | WaitConditionAll) & {
  timeoutMs?: number;
};

/** Events that carry a `kind` discriminator (excludes the `{ t: "idle" }` pseudo-event). */
export type LiveEventWithKind = Extract<LiveEvent, { kind: string }>;

export type EventFilter = { kinds?: Array<LiveEventWithKind["kind"]> } | ((e: LiveEvent) => boolean);

type DriverDeps = {
  sendKey: (key: string) => void;
  sendType: (text: string) => void;
};

type Ingested =
  | { kind: "frame"; frame: LiveFrame }
  | { kind: "visual"; frame: VisualFrame }
  | { kind: "idle" }
  | { kind: "event"; event: LiveEvent };

export type Driver = {
  snapshot: () => LiveFrame | null;
  changes_since: (seq: number) => LiveFrame | null;
  press: (key: string) => void;
  press_sequence: (keys: string[]) => void;
  type: (text: string) => void;
  focus: (selector: string) => void;
  wait_for: (args: WaitArgs) => Promise<void>;
  query: (selector: string) => UINode | null;
  queryAll: (selector: string) => UINode[];
  count: (selector: string) => number;
  expect: (selector: string, predicate: Predicate | unknown) => boolean;
  last_event: {
    <K extends LiveEventWithKind["kind"]>(kind: K): Extract<LiveEvent, { kind: K }> | null;
    (kind: string): LiveEvent | null;
  };
  /**
   * Returns an async iterable of LiveEvents that match the optional filter.
   *
   * - **Late-subscribe replay:** events already in the ring buffer are replayed
   *   first (up to EVENT_RING_CAP = 1000), then new events are delivered live.
   * - **Per-subscriber queue cap:** PER_SUBSCRIBER_QUEUE_CAP = 256. Under
   *   llm-token load (80–120 events/sec), a slow consumer will lose oldest
   *   events when its queue exceeds 256. Subscribe with a narrow filter or
   *   process events synchronously to avoid loss.
   * - **Termination:** when `driver._closeAllSubscribers()` is called (TUI exit),
   *   the iterator yields `done: true` cleanly — no deadlock in `for await`.
   */
  events: (filter?: EventFilter) => AsyncIterable<LiveEvent>;
  render_text: () => string;
  /** Latest VisualFrame — the ACTUAL rendered cell grid (colors + attributes),
   *  or null if the TUI has not emitted one (renderer not attached). */
  snapshot_visual: () => VisualFrame | null;
  /** Render the visual grid as plain text (what a human reads on screen) —
   *  faithful to the rendered characters, unlike render_text (semantic tree). */
  render_visual: () => string;
  /** Decode the cell at (row, col) — char + fg/bg hex + attribute bits — from
   *  the latest VisualFrame, accounting for wide (2-col) glyphs. Null if out of
   *  range or no visual frame yet. */
  visual_cell: (row: number, col: number) => VisualCell | null;
  /** Programmatic visual-quality heuristics over the latest VisualFrame:
   *  near-empty-row ratio, blank-row runs, whitespace density, and mojibake —
   *  the exact "messy render" signals the semantic tree is blind to. Null if no
   *  visual frame yet. */
  visual_quality: () => VisualQualityReport | null;
  _ingest: (m: Ingested) => void;
  /** Called when the TUI exits. Cleanly terminates all active `events()` iterables. */
  _closeAllSubscribers: () => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events held in the global ring buffer (FIFO eviction). */
const EVENT_RING_CAP = 1000;

/** Maximum events held per subscriber's internal push-queue (FIFO eviction). */
const PER_SUBSCRIBER_QUEUE_CAP = 256;

// ---------------------------------------------------------------------------
// Internal subscriber type
// ---------------------------------------------------------------------------

type Subscriber = {
  filter: (e: LiveEvent) => boolean;
  queue: LiveEvent[];
  /** Resolve handle for the currently pending next() call, if any. */
  pending: ((result: IteratorResult<LiveEvent>) => void) | null;
  closed: boolean;
};

// ---------------------------------------------------------------------------
// createDriver
// ---------------------------------------------------------------------------

export function createDriver(deps: DriverDeps): Driver {
  let latestFrame: LiveFrame | null = null;
  let latestVisualFrame: VisualFrame | null = null;
  let lastIdleAt: number = -1;
  const eventBuffer: LiveEvent[] = [];
  const waiters: Set<Waiter> = new Set();
  const subscribers: Set<Subscriber> = new Set();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function selectorMatches(sel: string): UINode[] {
    if (!latestFrame) return [];
    const syntheticRoot: UINode = {
      id: "__root__",
      role: "dialog",
      children: latestFrame.nodes,
    };
    const all = matchSelector(syntheticRoot, sel);
    // Filter out the synthetic root itself
    return all.filter((n) => n.id !== "__root__");
  }

  function notifyWaiters(): void {
    for (const w of waiters) {
      if (w.check()) {
        w.resolve();
        waiters.delete(w);
      }
    }
  }

  function renderNode(node: UINode, indent = 0): string {
    const pad = "  ".repeat(indent);
    const parts: string[] = [node.role];
    if (node.id) parts.push(`#${node.id}`);
    if (node.name) parts.push(`[name=${node.name}]`);
    if (node.value !== undefined) parts.push(`[value=${node.value}]`);
    if (node.focus) parts.push("[focus]");
    if (node.selected) parts.push("[selected]");
    if (node.disabled) parts.push("[disabled]");
    if (node.state) parts.push(`[state=${node.state}]`);
    let line = pad + parts.join(" ");
    if (node.children?.length) {
      line += "\n" + node.children.map((c) => renderNode(c, indent + 1)).join("\n");
    }
    return line;
  }

  /** Build a predicate from an EventFilter (or undefined → pass all). */
  function buildFilterFn(filter?: EventFilter): (e: LiveEvent) => boolean {
    if (!filter) return () => true;
    if (typeof filter === "function") return filter;
    if (filter.kinds) {
      const set = new Set<string>(filter.kinds);
      return (e: LiveEvent) => "kind" in e && set.has((e as LiveEventWithKind).kind);
    }
    return () => true;
  }

  /** Push an event to a subscriber's queue, evicting oldest if at cap. */
  function pushToSubscriber(sub: Subscriber, e: LiveEvent): void {
    if (!sub.filter(e)) return;
    if (sub.closed) return;

    if (sub.queue.length >= PER_SUBSCRIBER_QUEUE_CAP) {
      sub.queue.shift(); // FIFO eviction of oldest
    }
    sub.queue.push(e);

    // If there is a pending next() call, resolve it immediately
    if (sub.pending !== null) {
      const resolve = sub.pending;
      sub.pending = null;
      const item = sub.queue.shift();
      if (item !== undefined) {
        resolve({ value: item, done: false });
      }
    }
  }

  /** Deliver an event to all active subscribers. */
  function pushToSubscribers(e: LiveEvent): void {
    for (const sub of subscribers) {
      pushToSubscriber(sub, e);
    }
  }

  // ---------------------------------------------------------------------------
  // wait_for — check builder
  // ---------------------------------------------------------------------------

  type Waiter = {
    check: () => boolean;
    resolve: () => void;
    reject: (err: Error) => void;
  };

  function buildCheck(cond: WaitConditionIdle | WaitConditionSelector | WaitConditionEvent): () => boolean {
    if ("idle" in cond && cond.idle) {
      const capturedStart = Date.now();
      return () => lastIdleAt >= capturedStart;
    }
    if ("selector" in cond) {
      const sel = (cond as WaitConditionSelector).selector;
      return () => selectorMatches(sel).length > 0;
    }
    if ("event" in cond) {
      const kind = (cond as WaitConditionEvent).event;
      const matchFn = (cond as WaitConditionEvent).match;
      return () => eventBuffer.some((e) => e.t === "event" && e.kind === kind && (matchFn ? matchFn(e) : true));
    }
    return () => false;
  }

  // ---------------------------------------------------------------------------
  // Driver implementation
  // ---------------------------------------------------------------------------

  const driver: Driver = {
    snapshot(): LiveFrame | null {
      return latestFrame;
    },

    changes_since(seq: number): LiveFrame | null {
      if (latestFrame && latestFrame.seq > seq) return latestFrame;
      return null;
    },

    press(key: string): void {
      deps.sendKey(key);
    },

    press_sequence(keys: string[]): void {
      for (const key of keys) deps.sendKey(key);
    },

    type(text: string): void {
      deps.sendType(text);
    },

    focus(selector: string): void {
      const hits = selectorMatches(selector);
      if (hits.length !== 1) {
        throw new Error(`focus: expected 1 match for "${selector}", got ${hits.length}`);
      }
      deps.sendKey(`__focus__:${hits[0].id}`);
    },

    wait_for(args: WaitArgs): Promise<void> {
      const timeoutMs = (args as { timeoutMs?: number }).timeoutMs ?? 5000;
      const start = Date.now();

      let check: () => boolean;
      if ("all" in args) {
        const checks = (args as WaitConditionAll).all.map(buildCheck);
        check = () => checks.every((c) => c());
      } else if ("idle" in args && (args as WaitConditionIdle).idle) {
        // Re-use capturedStart from buildCheck — create a fresh check with correct start
        const capturedStart = start;
        check = () => lastIdleAt >= capturedStart;
      } else if ("selector" in args) {
        check = buildCheck(args as WaitConditionSelector);
      } else if ("event" in args) {
        check = buildCheck(args as WaitConditionEvent);
      } else {
        check = () => false;
      }

      // Check immediately in case condition is already met
      if (check()) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;

        const waiter: Waiter = {
          check,
          resolve() {
            if (timer !== null) clearTimeout(timer);
            resolve();
          },
          reject(err) {
            reject(err);
          },
        };

        timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`wait_for timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        waiters.add(waiter);
      });
    },

    query(selector: string): UINode | null {
      const results = selectorMatches(selector);
      if (results.length > 1) {
        throw new Error(
          `query: ambiguous — selector "${selector}" matched ${results.length} nodes (use queryAll for multiple)`,
        );
      }
      return results[0] ?? null;
    },

    queryAll(selector: string): UINode[] {
      return selectorMatches(selector);
    },

    count(selector: string): number {
      return selectorMatches(selector).length;
    },

    expect(selector: string, predicate: Predicate | unknown): boolean {
      const node = selectorMatches(selector)[0];
      if (!node) return false;
      const parsed = predicateSchema.safeParse(predicate);
      if (!parsed.success) return false;
      return evaluatePredicate(parsed.data, node);
    },

    last_event: ((kind: string): LiveEvent | null => {
      for (let i = eventBuffer.length - 1; i >= 0; i--) {
        const e = eventBuffer[i];
        if (e.t === "event" && (e as LiveEventWithKind).kind === kind) return e;
      }
      return null;
    }) as Driver["last_event"],

    events(filter?: EventFilter): AsyncIterable<LiveEvent> {
      const filterFn = buildFilterFn(filter);

      const sub: Subscriber = {
        filter: filterFn,
        queue: [],
        pending: null,
        closed: false,
      };

      // Late-subscribe replay: enqueue all matching events already in the ring buffer
      for (const e of eventBuffer) {
        if (filterFn(e)) {
          sub.queue.push(e);
        }
      }
      // Cap the replay queue too (keep last PER_SUBSCRIBER_QUEUE_CAP)
      if (sub.queue.length > PER_SUBSCRIBER_QUEUE_CAP) {
        sub.queue = sub.queue.slice(sub.queue.length - PER_SUBSCRIBER_QUEUE_CAP);
      }

      subscribers.add(sub);

      const iterator: AsyncIterator<LiveEvent> & { [Symbol.asyncIterator](): typeof iterator } = {
        [Symbol.asyncIterator]() {
          return this;
        },

        next(): Promise<IteratorResult<LiveEvent>> {
          if (sub.closed) {
            return Promise.resolve({ value: undefined as unknown as LiveEvent, done: true });
          }

          // If there is already a queued event, return it immediately
          const item = sub.queue.shift();
          if (item !== undefined) {
            return Promise.resolve({ value: item, done: false });
          }

          // Otherwise, park until an event arrives or the subscriber is closed
          return new Promise<IteratorResult<LiveEvent>>((resolve) => {
            sub.pending = resolve;
          });
        },

        return(): Promise<IteratorResult<LiveEvent>> {
          sub.closed = true;
          subscribers.delete(sub);
          // Resolve any pending next() with done
          if (sub.pending !== null) {
            const resolve = sub.pending;
            sub.pending = null;
            resolve({ value: undefined as unknown as LiveEvent, done: true });
          }
          return Promise.resolve({ value: undefined as unknown as LiveEvent, done: true });
        },
      };

      return iterator;
    },

    render_text(): string {
      if (!latestFrame) return "(no frame)";
      return latestFrame.nodes.map((n) => renderNode(n, 0)).join("\n");
    },

    snapshot_visual(): VisualFrame | null {
      return latestVisualFrame;
    },

    render_visual(): string {
      if (!latestVisualFrame) return "(no visual frame)";
      return latestVisualFrame.lines
        .map((ln) =>
          ln.spans
            .map((s) => s.text)
            .join("")
            .replace(/\s+$/, ""),
        )
        .join("\n");
    },

    visual_cell(row: number, col: number): VisualCell | null {
      const frame = latestVisualFrame;
      if (!frame) return null;
      const line = frame.lines[row];
      if (!line) return null;
      // Walk spans accumulating display columns; a wide glyph spans 2 columns
      // but its span.width already reflects that, so index within the run by
      // string position while tracking the column cursor.
      let colCursor = 0;
      for (const span of line.spans) {
        const chars = [...span.text];
        for (const ch of chars) {
          // A char occupies span.width / chars.length columns on average; for
          // the common width===text-length case this is 1. Round to stay integral.
          const chCols = Math.max(1, Math.round(span.width / Math.max(1, chars.length)));
          if (col >= colCursor && col < colCursor + chCols) {
            return { char: ch, fg: span.fg, bg: span.bg, attrs: span.attrs };
          }
          colCursor += chCols;
        }
      }
      return null;
    },

    visual_quality(): VisualQualityReport | null {
      return latestVisualFrame ? computeVisualQuality(latestVisualFrame) : null;
    },

    _ingest(m: Ingested): void {
      if (m.kind === "frame") {
        latestFrame = m.frame;
      } else if (m.kind === "visual") {
        latestVisualFrame = m.frame;
      } else if (m.kind === "idle") {
        lastIdleAt = Date.now();
      } else if (m.kind === "event") {
        // Ring buffer with FIFO eviction at cap
        if (eventBuffer.length >= EVENT_RING_CAP) {
          eventBuffer.shift();
        }
        eventBuffer.push(m.event);
        pushToSubscribers(m.event);
      }
      notifyWaiters();
    },

    _closeAllSubscribers(): void {
      for (const sub of subscribers) {
        sub.closed = true;
        // Resolve any pending next() with done
        if (sub.pending !== null) {
          const resolve = sub.pending;
          sub.pending = null;
          resolve({ value: undefined as unknown as LiveEvent, done: true });
        }
      }
      subscribers.clear();
    },
  };

  return driver;
}
