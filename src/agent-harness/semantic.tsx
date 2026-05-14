import * as React from "react";
import type { Role } from "./protocol.js";
import type { SemanticNodeInput, SemanticRegistry } from "./reconciler-hook.js";

// Re-export Role for consumers of this module.
export type { Role };

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const RegistryContext = React.createContext<SemanticRegistry | null>(null);
const ParentIdContext = React.createContext<string | undefined>(undefined);

// ---------------------------------------------------------------------------
// SemanticProvider
// ---------------------------------------------------------------------------

export function SemanticProvider(props: { registry: SemanticRegistry; children: React.ReactNode }) {
  return <RegistryContext.Provider value={props.registry}>{props.children}</RegistryContext.Provider>;
}

// ---------------------------------------------------------------------------
// Semantic
// ---------------------------------------------------------------------------

export type SemanticProps = Omit<SemanticNodeInput, "parentId"> & {
  children?: React.ReactNode;
};

export function Semantic(props: SemanticProps) {
  const registry = React.useContext(RegistryContext);
  const parentId = React.useContext(ParentIdContext);
  const { children, ...node } = props;

  // nodeKey serializes all node fields so that prop changes (without unmount)
  // trigger the effect. `node` itself is intentionally NOT in the dep array —
  // it is a new object on every render and would cause infinite re-registration.
  const nodeKey = JSON.stringify(node);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeKey is the intentional cache-bust for node fields; adding `node` would cause infinite re-registration
  React.useEffect(() => {
    if (!registry) return;
    const unregister = registry.register({ ...node, parentId });
    return unregister;
  }, [registry, parentId, nodeKey]);

  if (!registry) return children ?? null;
  return <ParentIdContext.Provider value={node.id}>{children}</ParentIdContext.Provider>;
}
