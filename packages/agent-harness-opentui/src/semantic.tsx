import type { Role } from "@muonroi/agent-harness-core/protocol";
import * as React from "react";
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

  // nodeKey serializes all node fields so an update effect runs when props
  // change. The mount/unmount effect uses a SEPARATE dep array so register
  // only fires on actual mount — this preserves the registry's insertion
  // order across re-renders. Without this split, useEffect cleanup would
  // delete the entry and the re-register would push it to the end of the
  // Map, rotating queryAll order on every prop change.
  const nodeKey = JSON.stringify(node);
  const nodeRef = React.useRef(node);
  nodeRef.current = node;

  // Mount/unmount: register once, unregister on real unmount.
  React.useEffect(() => {
    if (!registry) return;
    const unregister = registry.register({ ...nodeRef.current, parentId });
    return unregister;
  }, [registry, parentId, node.id]);

  // Updates: patch fields on prop change via registry.update(). nodeKey is the
  // intentional cache-bust dep — it serializes the node fields so this effect
  // re-runs whenever any field changes; Map.set on an existing key preserves
  // insertion order.
  React.useEffect(() => {
    if (!registry) return;
    if (!nodeKey) return;
    // Skip the very first run — the mount effect above already registered.
    // On mount this effect runs after the mount effect, so the entry IS
    // present; update() patches fields in place (Map.set on an existing key
    // preserves insertion order). On subsequent renders with a different
    // nodeKey it patches the changed fields. Using update() (not register())
    // is the cheaper intended path — it merges instead of rebuilding the
    // entry, and it is a no-op if the entry was already unmounted.
    const { id: _id, ...patch } = nodeRef.current;
    registry.update(nodeRef.current.id, patch);
    // No cleanup — the mount effect's cleanup is the single source of
    // truth for unmounting. If we returned a cleanup here, it would race
    // with re-renders and re-delete the entry.
  }, [registry, parentId, nodeKey]);

  if (!registry) return children ?? null;
  return <ParentIdContext.Provider value={node.id}>{children}</ParentIdContext.Provider>;
}
