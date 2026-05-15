/**
 * semantic.tsx — React <Semantic> + <SemanticProvider> components.
 *
 * API mirrors the OpenTUI semantic.tsx exactly so consumers can swap adapters
 * without changing component code.
 *
 * Design notes:
 * - <SemanticProvider registry={r}> provides the registry via React context.
 * - <Semantic id role ...> wraps user-visible elements. It renders ONLY a
 *   React.Fragment — zero DOM nodes are added.
 * - Registry calls (register/update/unregister) live inside
 *   `if (__MUONROI_HARNESS__) { ... }` branches so that when the build tool
 *   sets __MUONROI_HARNESS__ = false, the entire block is eliminated at build time.
 * - StrictMode double-mount safety: the cleanup returned from useEffect
 *   unregisters the node. On re-mount, the register effect re-runs. The
 *   registry's Map handles this correctly because keys are string IDs.
 */

import type { Role, SemanticNodeInput, SemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { createContext, Fragment, type ReactNode, useContext, useEffect } from "react";

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** Provides the registry to all <Semantic> descendants. */
const RegistryContext = createContext<SemanticRegistry | null>(null);

/** Tracks the nearest ancestor <Semantic> id for parent-child linking. */
const ParentIdContext = createContext<string | undefined>(undefined);

// ---------------------------------------------------------------------------
// <SemanticProvider>
// ---------------------------------------------------------------------------

export interface SemanticProviderProps {
  registry: SemanticRegistry;
  children: ReactNode;
}

export function SemanticProvider({ registry, children }: SemanticProviderProps) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

// ---------------------------------------------------------------------------
// <Semantic>
// ---------------------------------------------------------------------------

export type SemanticProps = Omit<SemanticNodeInput, "parentId"> & {
  children?: ReactNode;
};

export function Semantic({ children, ...node }: SemanticProps) {
  const registry = useContext(RegistryContext);
  const parentId = useContext(ParentIdContext);

  // Build a stable cache key from node props (excluding children).
  // We stringify ALL fields so that ANY prop change triggers a re-register.
  const nodeKey = JSON.stringify(node);

  // Register on mount, re-register on prop change, unregister on unmount.
  // This is safe under StrictMode: cleanup → unregister, re-run → re-register.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeKey captures all node fields
  useEffect(() => {
    if (!__MUONROI_HARNESS__) return;
    if (!registry) return;
    return registry.register({ ...node, parentId });
  }, [registry, parentId, nodeKey]);

  // Render children inside a ParentIdContext so nested <Semantic> nodes know
  // their parent. We wrap in Fragment — zero extra DOM nodes.
  return (
    <ParentIdContext.Provider value={node.id}>
      <Fragment>{children}</Fragment>
    </ParentIdContext.Provider>
  );
}
