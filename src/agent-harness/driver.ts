import { evaluatePredicate, type Predicate, predicateSchema } from "./predicate.js";
import type { LiveEvent, LiveFrame, UINode } from "./protocol.js";
import { matchSelector } from "./selector.js";

type WaitConditionIdle = { idle: true };
type WaitConditionSelector = { selector: string };
type WaitConditionAll = { all: (WaitConditionIdle | WaitConditionSelector)[] };

type WaitArgs = (WaitConditionIdle | WaitConditionSelector | WaitConditionAll) & { timeoutMs?: number };

type DriverDeps = {
  sendKey: (key: string) => void;
  sendType: (text: string) => void;
};

type Ingested = { kind: "frame"; frame: LiveFrame } | { kind: "idle" } | { kind: "event"; event: LiveEvent };

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
  last_event: (kind: string) => LiveEvent | null;
  render_text: () => string;
  _ingest: (m: Ingested) => void;
};

type Waiter = {
  check: () => boolean;
  resolve: () => void;
  reject: (err: Error) => void;
};

export function createDriver(deps: DriverDeps): Driver {
  let latestFrame: LiveFrame | null = null;
  let lastIdleAt: number = -1;
  const eventBuffer: LiveEvent[] = [];
  const waiters: Set<Waiter> = new Set();

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
      const node = driver.query(selector);
      if (!node) throw new Error(`focus: no node matching "${selector}"`);
    },

    wait_for(args: WaitArgs): Promise<void> {
      const timeoutMs = (args as { timeoutMs?: number }).timeoutMs ?? 5000;
      const start = Date.now();

      function buildCheck(cond: WaitConditionIdle | WaitConditionSelector): () => boolean {
        if ("idle" in cond && cond.idle) {
          return () => lastIdleAt >= start;
        }
        if ("selector" in cond) {
          const sel = (cond as WaitConditionSelector).selector;
          return () => selectorMatches(sel).length > 0;
        }
        return () => false;
      }

      let check: () => boolean;
      if ("all" in args) {
        const checks = (args as WaitConditionAll).all.map(buildCheck);
        check = () => checks.every((c) => c());
      } else if ("idle" in args && (args as WaitConditionIdle).idle) {
        check = buildCheck(args as WaitConditionIdle);
      } else if ("selector" in args) {
        check = buildCheck(args as WaitConditionSelector);
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
        throw new Error(`query: selector "${selector}" matched ${results.length} nodes (use queryAll for multiple)`);
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
      const node = driver.query(selector);
      if (!node) return false;
      const parsed = predicateSchema.safeParse(predicate);
      if (!parsed.success) return false;
      return evaluatePredicate(parsed.data, node);
    },

    last_event(kind: string): LiveEvent | null {
      for (let i = eventBuffer.length - 1; i >= 0; i--) {
        const e = eventBuffer[i];
        if (e.t === "event" && e.kind === kind) return e;
      }
      return null;
    },

    render_text(): string {
      if (!latestFrame) return "(no frame)";
      return latestFrame.nodes.map((n) => renderNode(n, 0)).join("\n");
    },

    _ingest(m: Ingested): void {
      if (m.kind === "frame") {
        latestFrame = m.frame;
      } else if (m.kind === "idle") {
        lastIdleAt = Date.now();
      } else if (m.kind === "event") {
        eventBuffer.push(m.event);
      }
      notifyWaiters();
    },
  };

  return driver;
}
