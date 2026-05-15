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

## References

- [PROTOCOL.md](../../docs/agent-harness/PROTOCOL.md) — wire-level types
- [TRANSPORTS.md](../../docs/agent-harness/TRANSPORTS.md) — fd/pipe/WebSocket envelope spec
- [Multi-framework layout](../../CLAUDE.md) — how adapters plug in

## License

Internal — Muonroi.
