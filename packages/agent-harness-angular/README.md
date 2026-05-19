# @muonroi/agent-harness-angular

Angular 16+ adapter for the muonroi agent harness. Exposes `[muonroiSemantic]` directive, `SemanticRegistryService`, and SSR-safe `SemanticSnapshotService`.

## Install

```bash
bun add @muonroi/agent-harness-angular @muonroi/agent-harness-core
```

Peer dependencies: `@angular/core@>=16`, `@angular/common@>=16`, `rxjs`, `zone.js`.

## Minimal example

```ts
import { Component, inject } from "@angular/core";
import {
  SemanticDirective,
  SemanticRegistryService,
  SemanticSnapshotService,
  createWebSocketTransport,
} from "@muonroi/agent-harness-angular";

@Component({
  standalone: true,
  imports: [SemanticDirective],
  template: `
    <div [muonroiSemantic] id="root" role="region">
      <button [muonroiSemantic] id="root-button" role="button">Submit</button>
    </div>
  `,
})
export class AppComponent {
  private registry = inject(SemanticRegistryService);
  private snapshot = inject(SemanticSnapshotService);
  constructor() {
    const transport = createWebSocketTransport({ url: "ws://127.0.0.1:7777", token: "dev" });
    this.snapshot.start(transport, 30); // 30 Hz, no-op on the server (SSR-safe)
  }
}
```

## Element-injector DI

The directive uses `@Optional() @SkipSelf() @Host()` decorators to walk the **element-injector chain**, not the component injector. Result: nested directives on non-component host elements resolve the correct parent id.

```html
<div [muonroiSemantic] id="d" role="region">
  <span [muonroiSemantic] id="s" role="button"></span>
</div>
<!-- snapshot: s.parentId === "d", NOT the component root -->
```

Verified by `__tests__/semantic.directive.spec.ts` (HIGH-4 risk mitigated).

## SSR safety

`SemanticSnapshotService.start()` is a no-op when `inject(PLATFORM_ID)` reports a non-browser platform — no `WebSocket` or `requestAnimationFrame` calls.

## Public API

| Export | Purpose |
|---|---|
| `[muonroiSemantic]` | Directive: inputs `id`, `role`, `name`, `value`, `state`, `isModal`, `focus`, `selected`, `disabled` |
| `SemanticRegistryService` | Root-provided wrapper around `createSemanticRegistry` |
| `SemanticSnapshotService` | `NgZone.runOutsideAngular`-debounced snapshot loop (RxJS `interval`) |
| `SEMANTIC_PARENT_ID` | `InjectionToken<string \| null>` for element-injector parent resolution |
| `createWebSocketTransport` | Re-exported from core for convenience |

Bundle gzip: ≤ 8 KB (Angular library overhead — `ng-package` metadata + `ɵfac`/`ɵdir` codegen).

## References

- [PROTOCOL.md](../../docs/agent-harness/PROTOCOL.md)
- [TRANSPORTS.md](../../docs/agent-harness/TRANSPORTS.md)

## Migration

The legacy in-repo shim at `src/agent-harness/*` is deprecated for external use.
See the [`[Unreleased] / BREAKING / harness` block in CHANGELOG.md](../../CHANGELOG.md)
for the full migration notes.

```ts
// Before (deprecated, OpenTUI-flavoured shim)
import { Semantic } from "muonroi-cli/src/agent-harness";

// After (Angular adapter)
import { SemanticRegistryService } from "@muonroi/agent-harness-angular";
```

## License

Internal — Muonroi.
