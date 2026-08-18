/**
 * NotificationBridge — opt-in server→client push for the harness MCP server.
 *
 * MCP defines three push mechanisms, but their reach into the LLM context is
 * host-dependent:
 *   - `notifications/message` (logging)         → host UI / logs
 *   - `notifications/resources/updated`         → host re-reads the resource
 *   - `sampling/createMessage`                  → routed THROUGH the client LLM
 *
 * Research (2026-11-25 spec + client matrix): only `sampling` reliably wakes a
 * dormant LLM, and only a few clients implement it (VS Code yes; Claude Code /
 * Cursor no). Logging/resource-updated are additive telemetry for hosts/dashboards.
 *
 * This bridge is therefore OPT-IN and feature-detected: it reads client caps at
 * startup and wires whichever channels the client advertised. The streaming
 * `tui.wait_for_event` tool remains the portable primary path — this bridge is
 * complementary, never a replacement.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Driver } from "./driver.js";
import type { LiveEvent } from "./protocol.js";

/** Shape returned by Server.getClientCapabilities() (avoids a fragile SDK type import path). */
type ClientCapabilities = ReturnType<McpServer["server"]["getClientCapabilities"]>;

/** URI of the subscribable event-feed resource (host polls on `updated`). */
export const EVENTS_RESOURCE_URI = "tui://events";

/** Event kinds considered "terminal" — the only ones worth a sampling round. */
const TERMINAL_KINDS = new Set([
  "council-step", // state: done | error
  "sprint-halt",
  "askcard-open",
]);

/** Kinds rich enough to be worth a debug log line (others are too noisy). */
const LOG_KINDS = new Set([
  "council-step",
  "council-speaker",
  "sprint-halt",
  "sprint-stage",
  "askcard-open",
  "askcard-answered",
  "askcard-cancel",
  "toast",
  "disconnect",
]);

export type BridgeCapabilities = {
  /** Client advertised `logging` → bridge emits notifications/message. */
  logging: boolean;
  /** Client advertised `resources.subscribe` → bridge emits resources/updated. */
  resources: boolean;
  /** Client advertised `sampling` → bridge may send sampling/createMessage. */
  sampling: boolean;
};

/**
 * Detect which push channels are usable.
 *
 * `logging` and `resources` are SERVER capabilities we advertise by
 * registering them; they are usable regardless of the client. `sampling` is a
 * CLIENT capability — only present when the client advertised
 * `capabilities.sampling` (VS Code: yes; Claude Code / Cursor: no).
 */
export function detectBridgeCapabilities(caps: ClientCapabilities | undefined): BridgeCapabilities {
  return {
    // Server-side features we register unconditionally.
    logging: true,
    resources: true,
    // The only true client capability among the three.
    sampling: Boolean(caps?.sampling),
  };
}

export type NotificationBridgeOptions = {
  /** When true and client supports sampling, emit sampling on terminal events. */
  pushMode: boolean;
  /** Min ms between resource-updated notifications (default 250). */
  resourceThrottleMs?: number;
};

/**
 * A live bridge that subscribes to `driver.events()` and forwards filtered
 * events to the client via the channels it advertised. Safe to call when no
 * channel is supported — it becomes a no-op subscriber that drains the queue.
 */
export class NotificationBridge {
  private closed = false;
  private lastResourceNotify = 0;
  private readonly throttleMs: number;
  private readonly caps: BridgeCapabilities;
  private readonly pushMode: boolean;
  private samplingDisabled = false;

  constructor(
    private readonly server: McpServer,
    private readonly driver: Driver,
    caps: BridgeCapabilities,
    opts: NotificationBridgeOptions,
  ) {
    this.caps = caps;
    this.pushMode = opts.pushMode;
    this.throttleMs = opts.resourceThrottleMs ?? 250;
  }

  /** Start forwarding events. Returns a stop() to tear down the subscription. */
  start(): () => void {
    if (this.closed) return () => {};
    const iter = this.driver.events({ kinds: Array.from(LOG_KINDS) as any })[Symbol.asyncIterator]();
    let running = true;

    const pump = async () => {
      while (running && !this.closed) {
        const { value, done } = await iter.next().catch(() => ({ value: undefined, done: true }) as const);
        if (done || !value) break;
        this.onEvent(value).catch(() => {
          /* best-effort; a dead client must not crash the driver */
        });
      }
      await iter.return?.().catch(() => {});
    };
    void pump();

    return () => {
      running = false;
    };
  }

  private async onEvent(ev: LiveEvent): Promise<void> {
    const kind = (ev as { kind?: string }).kind;
    if (!kind) return;

    // Channel 1: logging (debug) for rich kinds.
    if (this.caps.logging && LOG_KINDS.has(kind)) {
      try {
        await this.server.sendLoggingMessage({ level: "debug", data: ev });
      } catch {
        /* host may have disconnected; ignore */
      }
    }

    // Channel 2: resource-updated (throttled) — host re-reads tui://events.
    if (this.caps.resources) {
      const now = Date.now();
      if (now - this.lastResourceNotify >= this.throttleMs) {
        this.lastResourceNotify = now;
        try {
          await this.server.server.sendResourceUpdated({ uri: EVENTS_RESOURCE_URI });
        } catch {
          /* ignore */
        }
      }
    }

    // Channel 3: sampling on terminal events only (opt-in via pushMode).
    if (this.pushMode && this.caps.sampling && !this.samplingDisabled && TERMINAL_KINDS.has(kind)) {
      await this.trySampling(ev, kind);
    }
  }

  private async trySampling(ev: LiveEvent, kind: string): Promise<void> {
    // Build a compact prompt: just the event + a hint, no context bloat.
    const prompt = JSON.stringify({ event: ev, ts: Date.now(), hint: "React to this terminal TUI event if relevant." });
    try {
      await this.server.server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: 200,
        systemPrompt:
          "You are observing a live TUI via MCP. A terminal event arrived. If no action is needed, reply with the single word 'noop'.",
      });
    } catch {
      // Sampling unsupported in practice, or capability assertion failed.
      // Disable for the rest of the session — don't spam retries.
      this.samplingDisabled = true;
    }
  }
}
