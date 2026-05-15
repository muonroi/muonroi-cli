import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { NodeInput, Registry, Role } from "./registry";

export const RegistryCtx = createContext<Registry | null>(null);
export const ParentCtx = createContext<string | undefined>(undefined);

type Props = Omit<NodeInput, "parentId"> & { role: Role; children?: ReactNode };

export function Semantic({ children, ...node }: Props) {
  const registry = useContext(RegistryCtx);
  const parentId = useContext(ParentCtx);
  const key = JSON.stringify(node);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is intentional cache-bust
  useEffect(() => {
    if (!registry) return;
    return registry.register({ ...node, parentId });
  }, [registry, parentId, key]);

  return <ParentCtx.Provider value={node.id}>{children}</ParentCtx.Provider>;
}
