// Minimal inline registry — same semantics as src/agent-harness/reconciler-hook.ts

export type Role = "button" | "dialog" | "textbox" | "listitem" | "region" | string;
export type UINode = { id: string; role: Role; name?: string; children?: UINode[] };
export type NodeInput = { id: string; role: Role; name?: string; parentId?: string };

export type Registry = {
  register(n: NodeInput): () => void;
  snapshot(): UINode[];
};

export function createRegistry(): Registry {
  const store = new Map<string, NodeInput>();
  return {
    register(n) {
      store.set(n.id, n);
      return () => {
        store.delete(n.id);
      };
    },
    snapshot() {
      const ids = new Set(store.keys());
      const childMap = new Map<string, NodeInput[]>();
      const roots: NodeInput[] = [];
      for (const n of store.values()) {
        if (n.parentId && ids.has(n.parentId)) {
          childMap.set(n.parentId, [...(childMap.get(n.parentId) ?? []), n]);
        } else {
          roots.push(n);
        }
      }
      function build(n: NodeInput): UINode {
        const node: UINode = { id: n.id, role: n.role };
        if (n.name) node.name = n.name;
        const kids = childMap.get(n.id);
        if (kids?.length) node.children = kids.map(build);
        return node;
      }
      return roots.map(build);
    },
  };
}
