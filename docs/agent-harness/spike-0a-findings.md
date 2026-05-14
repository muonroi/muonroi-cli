# Phase 0a spike findings — OpenTUI hook surface

## OpenTUI version
@opentui/core: 0.1.107
@opentui/react: 0.1.107

## Public APIs that work

- **`addPostProcessFn`** — exported from `@opentui/core` on `CliRenderer`.
  Use as:
  ```ts
  renderer.addPostProcessFn((buffer: OptimizedBuffer, deltaTime: number) => {
    const lines = buffer.getSpanLines();           // CapturedLine[]
    const cursor = renderer.getCursorState();
    const frame: CapturedFrame = {
      cols: buffer.width,
      rows: buffer.height,
      cursor: [cursor.x, cursor.y],
      lines,
    };
    emit({ t: "frame", frameId: renderer.frameId, frame });
  });
  ```
  Observed behavior: fires on every native render pass (14 fires in 300 ms at targetFps=60).
  The `OptimizedBuffer` passed in is the live `nextRenderBuffer` **before** it is swapped; after
  the callback the diff is committed. For reading the committed result use
  `renderer.currentRenderBuffer.getSpanLines()` inside the callback instead.

- **`setFrameCallback`** — exported from `@opentui/core` on `CliRenderer`.
  Use as:
  ```ts
  renderer.setFrameCallback(async (deltaTime: number) => { /* per-frame work */ });
  ```
  Observed behavior: fires once per render-loop iteration (same cadence as `addPostProcessFn`).
  Does NOT receive a buffer — use `renderer.currentRenderBuffer` manually. Best used for
  side-effects or idle-detection rather than frame capture.

- **`renderer.frameId`** — monotonic integer, incremented once per `loop()` iteration.
  Available on `RenderContext` interface (public). Useful as a dedup key in `LiveFrame`.

- **`CapturedFrame` / `CapturedLine` / `CapturedSpan`** — exported from `@opentui/core` types.
  These are the canonical structured-frame types; `addPostProcessFn` + `getSpanLines()` produce
  exactly this shape.

## APIs investigated but not viable

- **`setFrameCallback`** for frame *capture* — fires at the right time but provides no buffer
  argument; buffer must be accessed via `renderer.currentRenderBuffer`, adding coupling. Better
  to use `addPostProcessFn` which receives the buffer directly.

- **`CliRenderEvents` enum** — only covers `resize`, `focus`, `blur`, `theme_mode`,
  `memory:snapshot`, `destroy`, etc. No render/frame event exists in the public enum.

- **`renderNative` monkey-patch** — fires correctly (confirmed in probe) and is how
  `TestRecorder` works internally, but `renderNative` is typed `private` in `renderer.d.ts`
  (bracket-access `["renderNative"]` required). Fragile across versions; not preferred.

- **`SlotRegistry.subscribe`** — triggers on plugin registration changes, not renders. Not
  applicable.

- **`subscribeOsc`** — OSC terminal sequences only. Not applicable.

## Decision

- [x] **HOOK-AVAILABLE**: proceed with §10 plan A. Use API: **`addPostProcessFn`**.

  `addPostProcessFn` is a fully public, documented method on `CliRenderer`. It fires after
  every native render pass and provides the `OptimizedBuffer` directly. `getSpanLines()`
  on that buffer returns `CapturedLine[]` which maps directly to the `CapturedFrame` type
  already exported by `@opentui/core`. No internal symbols required, no monkey-patching.

## Notes for Phase 1 implementer

1. **Frame fires at targetFps even without React changes** — in the 300 ms probe window there
   were 3 React renders but 14 `postProcessFn` fires. The harness must diff successive frames
   or use a dirty-flag before emitting a `LiveFrame` over the wire to avoid flooding consumers
   with duplicate frames. The simplest approach: hash `buffer.getRealCharBytes(false)` and skip
   emit if identical to the previous hash.

2. **Buffer timing**: inside `addPostProcessFn` the argument is `nextRenderBuffer` (the buffer
   being written). To read the *committed* output (what the terminal actually shows) use
   `renderer.currentRenderBuffer.getSpanLines()` inside the same callback — the swap has not
   yet happened but `currentRenderBuffer` holds the last committed frame.

3. **Cleanup**: `removePostProcessFn(fn)` is the paired teardown method; store the function
   reference at harness construction time so it can be removed on `renderer.destroy`.
