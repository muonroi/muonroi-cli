# @muonroi/agent-harness-core

Framework-agnostic core for the muonroi agent harness — protocol types, selector/predicate engine, driver, registry, WebSocket transport, and Node-only MCP server.

## Install

```bash
bun add @muonroi/agent-harness-core
```

## Minimal example (Node)

```ts
import { createSemanticRegistry, createDriver } from "@muonroi/agent-harness-core";

const registry = createSemanticRegistry();
registry.register({ id: "btn", role: "button", name: "Submit" });
const frame = { mode: "live", version: "0.1.0", seq: 1, ts: Date.now(), nodes: registry.snapshot() };
```

## Browser example

```ts
import { createWebSocketTransport } from "@muonroi/agent-harness-core/transports/ws";

const transport = createWebSocketTransport({ url: "ws://127.0.0.1:7777", token: "dev" });
transport.onMessage((env) => console.log("got", env.dir));
```

The `browser` export condition strips Node-only modules (`mcp-server.ts`, `transports/sidechannel.ts`) — safe to import from Vite/Rollup bundles.

## Public API

| Export | Purpose |
|---|---|
| `createSemanticRegistry()` | Pure registry: `register / update / unregister / snapshot / clear` |
| `createDriver(opts)` | Selector + predicate + wait_for driver |
| `parseSelector`, `matchSelector` | CSS-like selector grammar |
| `evaluatePredicate` | Zod-typed predicate evaluator |
| `createWebSocketTransport` | Browser-safe WebSocket transport with envelope validation |
| `createSidechannelTransport` | Node-only fd 3/4 + named-pipe transport |
| `createMcpHarnessServer` | Node-only MCP server (`tui.start` etc.) — accepts `HarnessSpawn` injection |
| `findUnwrappedComponents` | Node-only lint helper for `lint:semantic` |
| `PROTOCOL_VERSION`, `UINode`, `LiveFrame`, `LiveEvent` | Protocol types |

## Event protocol (v0.2.0)

`LiveEvent` is a discriminated union of all harness events. Events are
serialized as JSONL on the sidechannel (fd 3 / named pipe) and ingested by
`driver._ingest({ kind: "event", event })` on the test side.

### Event kinds

| kind | Payload fields | Volume | Default emitted |
|---|---|---|---|
| `route-decision` | `path` ("hot-path"\|"council"), `complexity`, `forceCouncil`, `runId` | low | yes |
| `council-step` | `phaseId`, `phaseKind`, `state`, `label`, `elapsedMs?` | low | yes |
| `council-speaker` | `role`, `status` ("start"\|"done"), `round?`, `correlationId` | low | yes |
| `askcard-open` | `questionId`, `question`, `phase`, `optionCount`, `defaultIndex?` | low | yes |
| `askcard-answered` | `questionId`, `answerKind`, `answerText` | low | yes |
| `askcard-cancel` | `questionId` | low | yes |
| `sprint-stage` | `sprintIndex`, `stage` ("planning"\|"implementation"\|"verification"\|"judgment"), `runId` | low | yes |
| `sprint-halt` | `sprintN`, `reason`, `runId` | low | yes |
| `llm-token` | `correlationId`, `delta`, `tokenIndex` | **HIGH** (80-120/sec) | **no** — opt-in only |
| `llm-done` | `correlationId`, `totalChars`, `finishReason` | low | yes |
| `toast` | `level` ("info"\|"warn"\|"error"), `text`, `ttlMs?` | low | yes |
| `stream.delta` | `target`, `text` | medium | yes |

### correlationId

`llm-token` and `llm-done` share a `correlationId` UUID set per `streamText` call.
`council-speaker` uses `statusId ?? runId` as its `correlationId`. Use it to pair
the done signal with the corresponding token stream:

```ts
await driver.wait_for({
  event: "llm-done",
  match: (e) => e.kind === "llm-done" && e.correlationId === myId,
  timeoutMs: 30_000,
});
```

### Redaction

Before any event is serialized to the wire, `redactEvent()` applies field-level
redaction:
- String fields that match the API key pattern (`sk-...` or 32+ base64 chars) are
  replaced with `"[redacted]"`.
- `answerText` in `askcard-answered` is run through the key pattern check.
- `delta` in `llm-token` is capped at 500 chars.
- Unknown fields on any event kind are not forwarded (allowlist per kind).

### Volume control: `MUONROI_HARNESS_EVENTS`

Set this env var to control which kinds are emitted:

| Value | Effect |
|---|---|
| unset (default) | lifecycle preset — all except `llm-token` |
| `lifecycle` | same as default |
| `*` or `all` | all kinds (enables high-volume `llm-token`) |
| `llm-token,council-step` | exact comma-separated allowlist |

The filter is evaluated once at `startAgentMode()` time. `{ t: "idle" }` sentinels
bypass the filter entirely.

### Ring buffer

Events are held in a 1000-entry FIFO ring buffer on the driver side. Each
`events()` subscriber has its own 256-entry queue with FIFO eviction (oldest
dropped under `llm-token` load). Subscribing late replays all events currently
in the ring buffer.

## References

- [PROTOCOL.md](../../docs/agent-harness/PROTOCOL.md) — wire-level types
- [TRANSPORTS.md](../../docs/agent-harness/TRANSPORTS.md) — fd/pipe/WebSocket envelope spec
- [Multi-framework layout](../../CLAUDE.md) — how adapters plug in

## License

Internal — Muonroi.
