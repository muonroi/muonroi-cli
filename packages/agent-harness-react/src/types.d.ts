/**
 * Compile-time tree-shake guard.
 *
 * When the build tool sets `__MUONROI_HARNESS__ = false`, all branches inside
 * `if (__MUONROI_HARNESS__) { ... }` are statically eliminated by esbuild/Vite.
 * Default to `true` in development and test environments.
 */
declare const __MUONROI_HARNESS__: boolean;
