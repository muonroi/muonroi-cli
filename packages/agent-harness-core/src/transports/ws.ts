/**
 * WebSocket transport for @muonroi/agent-harness-core.
 *
 * Browser-safe: uses only globalThis.WebSocket (or an injected WebSocketImpl).
 * No node:* imports — safe for both the Node bundle and the browser bundle.
 *
 * Token authentication is enforced at the URL level: the caller MUST supply a
 * `token` string which is appended as `?token=<token>` to the connection URL.
 * The server is responsible for rejecting connections with an absent/wrong token;
 * this transport merely ensures the token is always present in the URL.
 */

import { z } from "zod";
import type { UINode } from "../protocol.js";

// ---------------------------------------------------------------------------
// Zod schema — copied from docs/agent-harness/ws-envelope.zod.ts (Task 0.4)
// and refined to match protocol.ts field names exactly.
// ---------------------------------------------------------------------------

/**
 * Recursive UINode schema.
 * Kept loose on `role` (z.string()) because the canonical Role union lives in
 * protocol.ts and duplicating it here would create drift risk.
 */
const UINodeSchema: z.ZodType<UINode> = z.lazy(() =>
  z.object({
    id: z.string(),
    role: z.string() as z.ZodType<UINode["role"]>,
    name: z.string().optional(),
    value: z.string().optional(),
    focus: z.literal(true).optional(),
    selected: z.literal(true).optional(),
    disabled: z.literal(true).optional(),
    hidden: z.literal(true).optional(),
    state: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    children: z.array(z.lazy(() => UINodeSchema)).optional(),
  }),
) as z.ZodType<UINode>;

/** dir: "frame" — server → client. Mirrors LiveFrame in protocol.ts exactly. */
const FrameEnvelopeSchema = z.object({
  dir: z.literal("frame"),
  mode: z.literal("live"),
  // NOTE: field name is `version`, NOT `protocolVersion` — see TRANSPORTS.md Editor Note.
  version: z.literal("0.3.0"),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  focus: z.string().optional(),
  modals: z.array(z.string()).optional(),
  nodes: z.array(UINodeSchema),
});

/** dir: "event" — server → client. Inner `t` discriminant preserved from LiveEvent. */
const EventEnvelopeSchema = z.object({
  dir: z.literal("event"),
  t: z.union([z.literal("event"), z.literal("idle")]),
  kind: z.string().optional(),
  level: z.enum(["info", "warn", "error"]).optional(),
  text: z.string().optional(),
  target: z.string().optional(),
  ttlMs: z.number().optional(),
});

/** dir: "cmd" — client → server. Carries harness commands. */
const CommandEnvelopeSchema = z.object({
  dir: z.literal("cmd"),
  op: z.enum(["press", "type", "focus"]),
  key: z.string().optional(),
  text: z.string().optional(),
  id: z.string().optional(),
});

export const WsEnvelopeSchema = z.discriminatedUnion("dir", [
  FrameEnvelopeSchema,
  EventEnvelopeSchema,
  CommandEnvelopeSchema,
]);

export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;
export type FrameEnvelope = z.infer<typeof FrameEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

// Also export UINodeSchema for consumers that need to validate subtrees
export { UINodeSchema };

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export interface WebSocketTransport {
  /**
   * Send a line to the remote end.
   * `line` MUST be a valid JSON-encoded WsEnvelope string (no trailing newline).
   * Throws (via onError) if the socket is not in OPEN state.
   */
  send(line: string): void;

  /**
   * Register a callback that fires when a validated envelope arrives.
   * Invalid messages are silently dropped and reported via onError instead.
   * Returns an unsubscribe function.
   */
  onMessage(cb: (envelope: WsEnvelope) => void): () => void;

  /**
   * Register a callback that fires on parse/validation errors or send errors.
   * `raw` contains the original message text when the error is a parse failure.
   * Returns an unsubscribe function.
   */
  onError(cb: (err: Error, raw?: string) => void): () => void;

  /** Closes the underlying WebSocket and clears all callbacks. */
  close(): void;

  /** Mirror of the underlying WebSocket.readyState (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED). */
  readonly readyState: number;
}

export interface WebSocketTransportOptions {
  /**
   * Absolute WebSocket URL, e.g. `ws://127.0.0.1:7777`.
   * The token will be appended as a query string parameter.
   */
  url: string;

  /**
   * Required shared secret. Appended as `?token=<token>` to the URL before
   * opening the connection. The server must validate this token.
   * Omitting or passing an empty string throws immediately at construction time.
   */
  token: string;

  /**
   * Optional WebSocket constructor override.
   * Useful in test environments (Node < 22) where `globalThis.WebSocket` is
   * not available. Pass the `WebSocket` export from the `ws` package here.
   * In production (browser / Node 22+) leave this undefined.
   */
  WebSocketImpl?: typeof globalThis.WebSocket;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Creates a WebSocket-based transport that validates every inbound message
 * against the WsEnvelope discriminated union schema.
 *
 * Token enforcement design:
 *   - Token is required at construction time; missing/empty → throws synchronously.
 *   - Token is appended as `?token=<value>` (or `&token=<value>` if the URL
 *     already has a query string). This matches the server-side expectation
 *     documented in TRANSPORTS.md § Security Requirements.
 *   - Server-side rejection (WS close 4001) bubbles as an onError event when
 *     the socket fires its `close` event with code 4001.
 */
export function createWebSocketTransport(opts: WebSocketTransportOptions): WebSocketTransport {
  const { url, token, WebSocketImpl } = opts;

  // --- Token validation ---
  if (!token || token.trim() === "") {
    throw new Error(
      "createWebSocketTransport: `token` is required and must be non-empty. " +
        "The server enforces token authentication; omitting it will cause connection rejection.",
    );
  }

  // --- Build authenticated URL ---
  // Append ?token= (or &token= if a query string already exists) without
  // modifying any existing query parameters.
  const separator = url.includes("?") ? "&" : "?";
  const authenticatedUrl = `${url}${separator}token=${encodeURIComponent(token)}`;

  // --- Resolve WebSocket constructor ---
  const WS: typeof globalThis.WebSocket =
    WebSocketImpl ?? (typeof globalThis !== "undefined" ? globalThis.WebSocket : undefined!);

  if (typeof WS !== "function") {
    throw new Error(
      "createWebSocketTransport: No WebSocket implementation available. " +
        "Pass `WebSocketImpl` from the `ws` package (devDependency) in test/Node environments, " +
        "or run in a browser / Node 22+ environment where globalThis.WebSocket exists.",
    );
  }

  // --- Callback registries ---
  const messageCallbacks = new Set<(envelope: WsEnvelope) => void>();
  const errorCallbacks = new Set<(err: Error, raw?: string) => void>();

  function dispatchError(err: Error, raw?: string): void {
    if (errorCallbacks.size === 0) return; // no-op if nobody is listening
    for (const cb of errorCallbacks) {
      try {
        cb(err, raw);
      } catch {
        // Swallow errors thrown inside error callbacks to avoid infinite loops.
      }
    }
  }

  // --- Open socket ---
  const socket = new WS(authenticatedUrl) as InstanceType<typeof globalThis.WebSocket>;

  // Attach an error listener immediately to prevent unhandled-error crashes.
  // The `ws` npm package emits an "error" event for connection failures (including
  // close-while-connecting), which Node.js turns into an uncaught exception when
  // no listener is registered. We forward to onError callbacks if any exist,
  // otherwise swallow (the socket will close naturally).
  //
  // Note: `ErrorEvent` is a browser/DOM global that does NOT exist in Node.js.
  // The `ws` package passes a plain `{ error, message }` shaped object to the
  // "error" event listener via the EventTarget API. We extract the error safely
  // without referencing the browser-only `ErrorEvent` constructor.
  socket.addEventListener("error", (event: Event) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = event as any;
    let err: Error;
    if (raw?.error instanceof Error) {
      err = raw.error;
    } else if (typeof raw?.message === "string") {
      err = new Error(raw.message);
    } else {
      err = new Error("WebSocket error");
    }
    dispatchError(err);
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      dispatchError(new Error(`WS message is not valid JSON: ${String(e)}`), raw);
      return;
    }

    const result = WsEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      dispatchError(new Error(`WS envelope validation failed: ${result.error.message}`), raw);
      return;
    }

    for (const cb of messageCallbacks) {
      try {
        cb(result.data);
      } catch {
        // Swallow to avoid one bad callback killing the rest.
      }
    }
  });

  socket.addEventListener("close", (event: Event) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closeCode = (event as any).code as number | undefined;
    if (closeCode === 4001) {
      dispatchError(new Error(`WS connection rejected by server: token authentication failed (close code 4001)`));
    }
  });

  // --- Public transport object ---
  const transport: WebSocketTransport = {
    get readyState(): number {
      return socket.readyState;
    },

    send(line: string): void {
      if (socket.readyState !== 1 /* OPEN */) {
        dispatchError(
          new Error(
            `WS send failed: socket is not OPEN (readyState=${socket.readyState}). ` +
              "Wait for the connection to be established before sending.",
          ),
        );
        return;
      }
      socket.send(line);
    },

    onMessage(cb: (envelope: WsEnvelope) => void): () => void {
      messageCallbacks.add(cb);
      return () => {
        messageCallbacks.delete(cb);
      };
    },

    onError(cb: (err: Error, raw?: string) => void): () => void {
      errorCallbacks.add(cb);
      return () => {
        errorCallbacks.delete(cb);
      };
    },

    close(): void {
      messageCallbacks.clear();
      errorCallbacks.clear();
      // The `ws` npm package (used in test environments via WebSocketImpl) throws
      // "WebSocket was closed before the connection was established" when close()
      // is called while the socket is still in CONNECTING state (readyState 0).
      // The browser spec allows this call — it just transitions the socket to CLOSING.
      // Swallow the error so callers don't have to guard against the quirk.
      try {
        socket.close();
      } catch {
        // Ignore close-while-connecting errors (ws package quirk).
      }
    },
  };

  return transport;
}
