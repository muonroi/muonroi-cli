# @muonroi/agent-harness-react

React-DOM adapter for the muonroi agent harness. Lets agents drive a React web app via the same semantic-tree protocol used in the OpenTUI version.

## Install

```bash
bun add @muonroi/agent-harness-react @muonroi/agent-harness-core
```

Peer dependencies: `react@>=18`, `react-dom@>=18`.

## Minimal example

```tsx
import { Semantic, SemanticProvider, installReactHarness } from "@muonroi/agent-harness-react";
import { createSemanticRegistry, createWebSocketTransport } from "@muonroi/agent-harness-core";

const registry = createSemanticRegistry();
const transport = createWebSocketTransport({ url: "ws://127.0.0.1:7777", token: "dev" });
const uninstall = installReactHarness({ registry, transport, fps: 30 });

function App() {
  return (
    <SemanticProvider registry={registry}>
      <Semantic id="root-button" role="button" name="Submit">
        <button onClick={...}>Submit</button>
      </Semantic>
    </SemanticProvider>
  );
}
```

## Tree-shake guarantee

`<Semantic>` is implemented behind `if (__MUONROI_HARNESS__) { … }`. When you build prod with `--define:__MUONROI_HARNESS__=false`, esbuild eliminates the harness branch entirely.

- Bundle gzip (harness OFF): **~346 bytes**
- Bundle gzip (harness ON): **~914 bytes**

Verified by `__tests__/bundle-size.spec.ts`.

## StrictMode / Suspense

The adapter is safe under React 18 StrictMode (effect double-mount → register/unregister/register/unregister produces a clean registry on unmount). Suspense replay is absorbed by hash-dedup at the snapshot layer.

## Public API

| Export | Purpose |
|---|---|
| `<Semantic id role …>` | Wrap user-visible elements; renders `<Fragment>` (zero DOM) |
| `<SemanticProvider registry>` | Provide a registry to all descendant `<Semantic>` |
| `installReactHarness({ registry, transport, fps? })` | `requestAnimationFrame`-debounced snapshot loop |

## References

- [PROTOCOL.md](../../docs/agent-harness/PROTOCOL.md)
- [TRANSPORTS.md](../../docs/agent-harness/TRANSPORTS.md)

## License

Internal — Muonroi.
