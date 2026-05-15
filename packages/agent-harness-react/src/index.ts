/**
 * @muonroi/agent-harness-react
 *
 * React adapter for the muonroi agent harness.
 * Provides <SemanticProvider>, <Semantic>, and installReactHarness().
 *
 * Tree-shake guard: all registry-touching code is wrapped in
 * `if (__MUONROI_HARNESS__) { ... }` branches. When the build tool sets
 * `__MUONROI_HARNESS__ = false`, the entire harness is eliminated at build time.
 */

export type { ReactHarnessHandle, ReactHarnessOptions } from "./install.js";
export { installReactHarness } from "./install.js";
export type { SemanticProps, SemanticProviderProps } from "./semantic.js";
export { Semantic, SemanticProvider } from "./semantic.js";
