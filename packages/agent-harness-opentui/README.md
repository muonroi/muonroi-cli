# @muonroi/agent-harness-opentui

OpenTUI adapter for the muonroi agent harness. Provides `<Semantic>`, `<SemanticProvider>`, the OpenTUI reconciler hook, and the `installOpenTUIHarness` entry point.

## Install

```bash
bun add @muonroi/agent-harness-opentui @muonroi/agent-harness-core
```

Peer dependencies: `@opentui/core`, `@opentui/react`, `react@>=18`.

## Minimal example

```tsx
import { Semantic, SemanticProvider, installOpenTUIHarness } from "@muonroi/agent-harness-opentui";
import { createSemanticRegistry, createSidechannelTransport } from "@muonroi/agent-harness-core";

const registry = createSemanticRegistry();
const transport = createSidechannelTransport(); // fd 3/4 or named pipe
const uninstall = installOpenTUIHarness({ registry, transport, fps: 60 });

// In your OpenTUI app root:
<SemanticProvider registry={registry}>
  <Semantic id="composer" role="textbox" name="Prompt">
    <textbox />
  </Semantic>
</SemanticProvider>
```

## Public API

| Export | Purpose |
|---|---|
| `<Semantic id role …>` | Wrap user-visible elements; zero layout cost when registry is absent |
| `<SemanticProvider registry>` | Provide a registry to all descendant `<Semantic>` nodes |
| `installOpenTUIHarness({ registry, transport, fps?, onFrame? })` | One-call wire-up; returns uninstall handle |
| `createReconcilerHook` | Lower-level: OpenTUI `addPostProcessFn` hook |
| `startAgentMode` | `--agent-mode` runtime init |

## References

- [PROTOCOL.md](../../docs/agent-harness/PROTOCOL.md)
- [TRANSPORTS.md](../../docs/agent-harness/TRANSPORTS.md)
- [Verification workflow](../../CLAUDE.md)

## License

Internal — Muonroi.
