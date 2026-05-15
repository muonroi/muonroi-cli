/**
 * semantic.tsx — React <Semantic> + <SemanticProvider> components.
 *
 * Tree-shake design:
 * - When __MUONROI_HARNESS__ is false, esbuild replaces the constant with
 *   `false` and eliminates all dead `if (false) { ... }` branches.
 * - The live component implementations are assigned via conditional at module
 *   init time. The "dead" implementations are empty passthroughs that reference
 *   no React hooks, no contexts, and no registry calls.
 * - With minify:true + treeShaking:true, esbuild can DCE the full hook branch.
 *
 * StrictMode safety: useEffect cleanup unregisters; re-mount re-registers.
 * Map keys are string IDs, so this is idempotent.
 */

import type { SemanticNodeInput, SemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { Fragment, type ReactNode } from "react";

export interface SemanticProviderProps {
  registry: SemanticRegistry;
  children: ReactNode;
}

export type SemanticProps = Omit<SemanticNodeInput, "parentId"> & {
  children?: ReactNode;
};

// ---------------------------------------------------------------------------
// Harness-ON branch — all hooks, context, registry wiring live here.
// Only evaluated when __MUONROI_HARNESS__ is true.
// ---------------------------------------------------------------------------

function buildHarnessComponents() {
  // Dynamic requires ensure these imports are only resolved when this function
  // is actually called (i.e. when __MUONROI_HARNESS__ is true).
  const { createContext, useContext, useEffect } = require("react") as typeof import("react");

  const RegistryCtx = createContext<SemanticRegistry | null>(null);
  const ParentCtx = createContext<string | undefined>(undefined);

  function Provider({ registry, children }: SemanticProviderProps) {
    return <RegistryCtx.Provider value={registry}>{children}</RegistryCtx.Provider>;
  }

  function SemanticNode({ children, ...node }: SemanticProps) {
    const registry = useContext(RegistryCtx);
    const parentId = useContext(ParentCtx);
    const nodeKey = JSON.stringify(node);

    // biome-ignore lint/correctness/useExhaustiveDependencies: nodeKey captures all node fields
    useEffect(() => {
      if (!registry) return;
      return registry.register({ ...node, parentId });
    }, [registry, parentId, nodeKey]);

    return (
      <ParentCtx.Provider value={node.id}>
        <Fragment>{children}</Fragment>
      </ParentCtx.Provider>
    );
  }

  return { Provider, SemanticNode };
}

// ---------------------------------------------------------------------------
// Module init — assign implementations based on compile-time flag
// ---------------------------------------------------------------------------

let _Provider: (props: SemanticProviderProps) => ReactNode;
let _Semantic: (props: SemanticProps) => ReactNode;

if (__MUONROI_HARNESS__) {
  const { Provider, SemanticNode } = buildHarnessComponents();
  _Provider = Provider;
  _Semantic = SemanticNode;
} else {
  _Provider = ({ children }: SemanticProviderProps) => <Fragment>{children}</Fragment>;
  _Semantic = ({ children }: SemanticProps) => <Fragment>{children}</Fragment>;
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/** Provide a SemanticRegistry to all descendant <Semantic> nodes. */
export const SemanticProvider: (props: SemanticProviderProps) => ReactNode = _Provider;

/**
 * Wrap user-visible elements with <Semantic> to expose them to the agent harness.
 * Renders only a React.Fragment — zero extra DOM nodes.
 */
export const Semantic: (props: SemanticProps) => ReactNode = _Semantic;
