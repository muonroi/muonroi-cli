# Agent Harness — Transport Layer Reference

> Last updated: 2026-05-15  
> Protocol version: `0.1.0`  
> Related: [`PROTOCOL.md`](./PROTOCOL.md) · [`ws-envelope.zod.ts`](./ws-envelope.zod.ts)

---

## Purpose

The agent harness supports multiple transport mechanisms so that external agents (Claude, Codex, test harnesses, CI runners) can drive the TUI regardless of the host environment. Every transport carries the same logical message types — `LiveFrame`, `LiveEvent`, and commands (`press`, `type`, `focus`) — serialised as **line-delimited JSON** (one JSON object per `\n`-terminated line). What differs between transports is the physical channel and, for WebSocket, the presence of a `dir` discriminator envelope.

The three transports are:

- **fd 3 / fd 4** — POSIX subprocess sidechannel (original transport)
- **Named pipes** — Windows subprocess sidechannel (`\\.\pipe\muonroi-harness-{pid}-{uuid}-{in|out}`)
- **WebSocket** — bi-directional single socket for React / Angular web app integration

All three serialize payloads the same way internally; only the WebSocket transport requires an additional wrapping envelope because a single socket carries traffic in both directions simultaneously.

---

## Transport Matrix

| Transport | Used by | Direction | Wire format |
|---|---|---|---|
| fd 3 (server → client) + fd 4 (client → server) | POSIX OpenTUI subprocess spawn | bidirectional via **two separate** file descriptors | line-delimited JSON, raw shape — no `dir` wrapper (historic) |
| Named pipe `\\.\pipe\muonroi-harness-{pid}-{uuid}-{in\|out}` | Windows OpenTUI subprocess spawn | bidirectional via **two separate** named pipes | line-delimited JSON, raw shape — no `dir` wrapper |
| WebSocket `ws://127.0.0.1:<port>?token=<token>` | React / Angular web-app harness adapters | bidirectional on a **single socket** | line-delimited JSON, **`{ dir, ...payload }` envelope** |

The spawn-based transports (fd 3/4 and named pipes) are implemented in `src/agent-harness/sidechannel.ts` and `src/agent-harness/test-spawn.ts`. The WebSocket transport is implemented in `packages/agent-harness-core/src/transports/ws.ts` (Phase 1, Task 1.6).

---

## Why WebSocket Needs an Envelope but fd 3/4 Does Not

The fd 3/4 and named-pipe transports expose two **separate, unidirectional** channels: one carrying server-to-client frames (`LiveFrame`, `LiveEvent`) and another carrying client-to-server commands. The direction of any given line is implicit in which channel it arrived on — no discriminator is needed.

A WebSocket connection is a single **bi-directional** stream. Without a discriminator, a consumer receiving a raw JSON object cannot determine whether it is a `LiveFrame` snapshot being pushed from the TUI process or a `press` command being sent by the controlling agent. Field names may overlap (both are plain objects), and a Zod `discriminatedUnion` cannot resolve ambiguity without a common literal field. The `dir` envelope solves this at zero runtime cost: every message gets a top-level `"dir"` field that identifies its role.

---

## Envelope Specification

The WS envelope wraps every message with a `dir` discriminator. Three `dir` values are defined:

### `dir: "frame"` — Server → Client

Carries a `LiveFrame` snapshot. The payload fields are taken verbatim from `LiveFrame` in `src/agent-harness/protocol.ts`. **No fields are renamed or restructured.**

```ts
{
  dir: "frame";
  mode: "live";
  version: "0.1.0";   // field name is `version`, NOT `protocolVersion` — see Editor Note below
  seq: number;        // monotonically increasing frame counter
  ts: number;         // Unix ms timestamp
  focus?: string;     // id of focused UINode, if any
  modals?: string[];  // stack of open modal ids
  nodes: UINode[];    // full accessibility tree
}
```

### `dir: "event"` — Server → Client

Carries a `LiveEvent`. `LiveEvent` in `protocol.ts` uses a different inner discriminant (`t: "event" | "idle"`), but at the WS envelope layer the outer `dir: "event"` value handles transport-level routing. The `t` field is preserved inside the payload so existing consumers can reuse the same `LiveEvent` type.

This `dir` value was **not present in the original task specification** (which listed only `"frame"` and `"cmd"`), but is obviously required: `LiveEvent` messages (idle signals, toasts, stream deltas) must also flow over WebSocket. Omitting them would make the WS transport incomplete for any meaningful harness interaction. The addition is purely additive and does not conflict with the existing two values.

```ts
{
  dir: "event";
  t: "event" | "idle";   // inner discriminant from LiveEvent
  // When t === "event":
  kind?: "stream.delta" | "toast";
  // ... remaining LiveEvent fields as defined in protocol.ts
}
```

### `dir: "cmd"` — Client → Server

Carries a command from the controlling agent to the TUI process.

```ts
{
  dir: "cmd";
  op: "press" | "type" | "focus";
  // When op === "press":
  key?: string;          // e.g. "Enter", "Escape", "ArrowDown"
  // When op === "type":
  text?: string;         // literal text to inject
  // When op === "focus":
  id?: string;           // Semantic node id to focus
}
```

### Discriminated Union Summary

```
dir: "frame"  →  LiveFrame payload      (server → client)
dir: "event"  →  LiveEvent payload      (server → client)
dir: "cmd"    →  command payload        (client → server)
```

---

## Forward Compatibility

Clients and servers **MUST** ignore any `dir` value they do not recognise — skip the line and do not close the connection or throw. This allows future `dir` values (e.g. `"design"` for `DesignSpec` frames) to be introduced without breaking older consumers.

`PROTOCOL_VERSION` remains `"0.1.0"`. The envelope is an additive layer on top of the existing protocol shape; no existing fields are renamed, removed, or reinterpreted. The fd 3/4 and named-pipe transports are unchanged — they continue to emit raw `LiveFrame` and `LiveEvent` objects without a `dir` wrapper.

---

## Security Requirements

All WebSocket harness listeners **MUST** enforce the following:

1. **Bind to `127.0.0.1` only.** Never bind to `0.0.0.0` or `::`. The harness is a local development and testing tool, not a network service.

2. **Token authentication.** The WS handshake URL must include `?token=<secret>`. The server must generate a random token at startup (minimum 128 bits of entropy, hex-encoded) and refuse any upgrade request whose `token` query parameter is absent or does not match. Rejected connections receive WS close code `4001`.

3. **Origin validation.** Reject any WebSocket upgrade whose `Origin` header is present and does not resolve to `localhost` or `127.0.0.1`. A missing `Origin` header (non-browser client) is allowed.

4. **No persistent state across restarts.** The token is ephemeral — regenerated each time the harness process starts.

---

## Zod Schema

The canonical Zod schema is maintained in the **placeholder file** [`docs/agent-harness/ws-envelope.zod.ts`](./ws-envelope.zod.ts). Phase 1 Task 1.6 copies it verbatim into `packages/agent-harness-core/src/transports/ws.ts` and resolves the imports.

```ts
import { z } from "zod";
// TODO (Task 1.6): replace with: import type { UINode } from "@muonroi/agent-harness-core";
// UINode is defined in src/agent-harness/protocol.ts — use the same shape.

const UINodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    role: z.string(),
    name: z.string().optional(),
    value: z.string().optional(),
    focus: z.literal(true).optional(),
    selected: z.literal(true).optional(),
    disabled: z.literal(true).optional(),
    hidden: z.literal(true).optional(),
    state: z.string().optional(),
    props: z.record(z.unknown()).optional(),
    children: z.array(z.lazy(() => UINodeSchema)).optional(),
  }),
);

const FrameEnvelopeSchema = z.object({
  dir: z.literal("frame"),
  mode: z.literal("live"),
  version: z.literal("0.1.0"),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  focus: z.string().optional(),
  modals: z.array(z.string()).optional(),
  nodes: z.array(UINodeSchema),
});

const EventEnvelopeSchema = z.object({
  dir: z.literal("event"),
  t: z.union([z.literal("event"), z.literal("idle")]),
  kind: z.string().optional(),
  level: z.enum(["info", "warn", "error"]).optional(),
  text: z.string().optional(),
  target: z.string().optional(),
  ttlMs: z.number().optional(),
});

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
```

---

## Wire Examples

### Frame envelope (~220 bytes)

```json
{"dir":"frame","mode":"live","version":"0.1.0","seq":1,"ts":1747267200000,"nodes":[{"id":"composer","role":"textbox","focus":true}]}
```

### Event envelope (~90 bytes)

```json
{"dir":"event","t":"event","kind":"toast","level":"info","text":"Session started","ttlMs":3000}
```

### Command envelope (~45 bytes)

```json
{"dir":"cmd","op":"type","text":"hello world"}
```

---

## Editor Note — `version` vs `protocolVersion`

The plan document (`2026-05-14-agent-harness.md`) and some earlier design docs refer to the frame field as `protocolVersion`. The **actual runtime field in `src/agent-harness/protocol.ts`** (and the `LiveFrame` type) is `version`, not `protocolVersion`.

This document mirrors the code: all envelope and schema definitions use `version: "0.1.0"`.

**Recommendation for Task 1.6 author:** Align all docs and the new package type definitions to use `version`. Do **not** rename the runtime field without a corresponding update to `protocol.ts` and all consumers.

---

## Placement of Zod Source

The Zod schema above is provided in two places for Phase 0:

- **Inline** in this document (source of truth for the spec)
- **Standalone file** at `docs/agent-harness/ws-envelope.zod.ts` (copy target for Phase 1)

During **Phase 1 Task 1.6**, the standalone file is copied verbatim into `packages/agent-harness-core/src/transports/ws.ts`. At that point:

1. Remove the `// @ts-nocheck` pragma.
2. Replace the inline `UINodeSchema` definition with an import from `@muonroi/agent-harness-core` (the canonical `UINode` type lives in `protocol.ts` of that package).
3. Export `UINodeSchema` itself from the package if other transports need it.

Do **not** modify `docs/agent-harness/ws-envelope.zod.ts` after Phase 1 copies it — it becomes a historical reference only.
