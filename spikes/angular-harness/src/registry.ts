// Minimal inline registry — mirrors spikes/react-dom-harness/src/registry.ts
// Self-contained: do NOT import from src/ or other spikes.

export type Role =
  | "button"
  | "dialog"
  | "textbox"
  | "listitem"
  | "region"
  | "menu"
  | "menuitem"
  | "log"
  | "statusbar"
  | "toast"
  | string;

export type UINode = {
  id: string;
  role: Role;
  name?: string;
  value?: string;
  state?: string;
  focus?: true;
  selected?: true;
  disabled?: true;
  isModal?: true;
  props?: Record<string, unknown>;
  children?: UINode[];
};

export type NodeInput = {
  id: string;
  role: Role;
  name?: string;
  value?: string;
  state?: string;
  focus?: boolean;
  selected?: boolean;
  disabled?: boolean;
  isModal?: boolean;
  props?: Record<string, unknown>;
  parentId?: string | null;
};

export type Registry = {
  register(n: NodeInput): () => void;
  snapshot(): UINode[];
  size(): number;
  get(id: string): NodeInput | undefined;
};

export function createSemanticRegistry(): Registry {
  const store = new Map<string, NodeInput>();

  return {
    register(n: NodeInput) {
      store.set(n.id, n);
      return () => {
        store.delete(n.id);
      };
    },

    snapshot(): UINode[] {
      const ids = new Set(store.keys());
      const childMap = new Map<string, NodeInput[]>();
      const roots: NodeInput[] = [];

      for (const n of store.values()) {
        if (n.parentId && ids.has(n.parentId)) {
          const siblings = childMap.get(n.parentId) ?? [];
          siblings.push(n);
          childMap.set(n.parentId, siblings);
        } else {
          roots.push(n);
        }
      }

      function build(n: NodeInput): UINode {
        const node: UINode = { id: n.id, role: n.role };
        if (n.name) node.name = n.name;
        if (n.value) node.value = n.value;
        if (n.state) node.state = n.state;
        if (n.focus) node.focus = true;
        if (n.selected) node.selected = true;
        if (n.disabled) node.disabled = true;
        if (n.isModal) node.isModal = true;
        if (n.props && Object.keys(n.props).length > 0) node.props = n.props;
        const kids = childMap.get(n.id);
        if (kids?.length) node.children = kids.map(build);
        return node;
      }

      return roots.map(build);
    },

    size(): number {
      return store.size;
    },

    get(id: string): NodeInput | undefined {
      return store.get(id);
    },
  };
}
