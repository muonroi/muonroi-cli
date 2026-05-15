import type { Role, UINode } from "./protocol.js";

// ---------------------------------------------------------------------------
// SemanticNodeInput
// ---------------------------------------------------------------------------

export type SemanticNodeInput = {
  id: string;
  role: Role;
  parentId?: string;
  name?: string;
  value?: string;
  focus?: true;
  selected?: true;
  disabled?: true;
  hidden?: true;
  state?: string;
  props?: Record<string, unknown>;
  isModal?: true;
};

// ---------------------------------------------------------------------------
// SemanticRegistry
// ---------------------------------------------------------------------------

export type SemanticRegistry = {
  /** Register a node. Returns an unregister function. */
  register(node: SemanticNodeInput): () => void;
  /** Patch a registered node in-place. */
  update(id: string, patch: Partial<Omit<SemanticNodeInput, "id" | "parentId">>): void;
  /** Build a point-in-time snapshot of the tree. */
  snapshot(): { nodes: UINode[]; focus?: string; modals?: string[] };
  /** Remove all registered nodes. */
  clear(): void;
};

export function createSemanticRegistry(): SemanticRegistry {
  // Insertion-ordered map of id → input
  const store = new Map<string, SemanticNodeInput>();

  function register(node: SemanticNodeInput): () => void {
    store.set(node.id, { ...node });
    return () => {
      store.delete(node.id);
    };
  }

  function update(id: string, patch: Partial<Omit<SemanticNodeInput, "id" | "parentId">>): void {
    const existing = store.get(id);
    if (!existing) return;
    store.set(id, { ...existing, ...patch });
  }

  function snapshot(): { nodes: UINode[]; focus?: string; modals?: string[] } {
    // Determine which ids still exist (for parent resolution)
    const ids = new Set(store.keys());

    // Collect focused id and modal ids (insertion order preserved)
    let focus: string | undefined;
    const modals: string[] = [];

    for (const node of store.values()) {
      if (node.focus) focus = node.id;
      if (node.isModal) modals.push(node.id);
    }

    // Convert a stored entry to UINode (strips parentId, isModal)
    function toUINode(input: SemanticNodeInput): UINode {
      const node: UINode = { id: input.id, role: input.role };
      if (input.name !== undefined) node.name = input.name;
      if (input.value !== undefined) node.value = input.value;
      if (input.focus) node.focus = true;
      if (input.selected) node.selected = true;
      if (input.disabled) node.disabled = true;
      if (input.hidden) node.hidden = true;
      if (input.state !== undefined) node.state = input.state;
      if (input.props !== undefined) node.props = input.props;
      return node;
    }

    // Group children by parentId; orphans (parentId set but parent absent) become roots
    const childrenMap = new Map<string, SemanticNodeInput[]>();
    const roots: SemanticNodeInput[] = [];

    for (const input of store.values()) {
      if (input.parentId !== undefined && ids.has(input.parentId)) {
        const list = childrenMap.get(input.parentId) ?? [];
        list.push(input);
        childrenMap.set(input.parentId, list);
      } else if (input.parentId === undefined || !ids.has(input.parentId)) {
        // true root OR orphan (parent was unregistered) → promote to root
        roots.push(input);
      }
    }

    // Recursively build UINode tree
    function buildNode(input: SemanticNodeInput): UINode {
      const uiNode = toUINode(input);
      const kids = childrenMap.get(input.id);
      if (kids && kids.length > 0) {
        uiNode.children = kids.map(buildNode);
      }
      return uiNode;
    }

    const nodes = roots.map(buildNode);

    return {
      nodes,
      focus,
      modals: modals.length > 0 ? modals : undefined,
    };
  }

  function clear(): void {
    store.clear();
  }

  return { register, update, snapshot, clear };
}
