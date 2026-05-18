// Reference Zod schema for the WS envelope. Phase 1 Task 1.6 will copy this verbatim into packages/agent-harness-core/src/transports/ws.ts.
// @ts-nocheck — zod and @muonroi/agent-harness-core are not resolvable from this docs path.

import { z } from "zod";

// TODO (Task 1.6): replace UINodeSchema inline definition with:
//   import type { UINode } from "@muonroi/agent-harness-core";
// UINode is defined in src/agent-harness/protocol.ts — the shape below must stay in sync.
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

// dir: "frame" — server → client
// Carries a LiveFrame snapshot. Field names mirror LiveFrame in protocol.ts exactly.
// NOTE: the runtime field is `version`, NOT `protocolVersion` — see TRANSPORTS.md Editor Note.
const FrameEnvelopeSchema = z.object({
  dir: z.literal("frame"),
  mode: z.literal("live"),
  version: z.literal("0.2.0"),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  focus: z.string().optional(),
  modals: z.array(z.string()).optional(),
  nodes: z.array(UINodeSchema),
});

// dir: "event" — server → client
// Carries a LiveEvent. The inner `t` discriminant is preserved from LiveEvent in protocol.ts.
// `dir: "event"` was added beyond the original two-value spec ("frame" | "cmd") because
// LiveEvent messages (idle, toast, stream.delta) must also flow over WebSocket.
const EventEnvelopeSchema = z.object({
  dir: z.literal("event"),
  t: z.union([z.literal("event"), z.literal("idle")]),
  kind: z.string().optional(),
  level: z.enum(["info", "warn", "error"]).optional(),
  text: z.string().optional(),
  target: z.string().optional(),
  ttlMs: z.number().optional(),
});

// dir: "cmd" — client → server
// Carries a harness command from the controlling agent to the TUI process.
const CommandEnvelopeSchema = z.object({
  dir: z.literal("cmd"),
  op: z.enum(["press", "type", "focus"]),
  key: z.string().optional(), // present when op === "press"
  text: z.string().optional(), // present when op === "type"
  id: z.string().optional(), // present when op === "focus"
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
