import type { DesignSpec, UINode } from "@muonroi/agent-harness-core/protocol";
import { PROTOCOL_VERSION } from "@muonroi/agent-harness-core/protocol";

type Input = Omit<DesignSpec, "mode" | "version">;

function collectIds(node: UINode, set: Set<string>): void {
  set.add(node.id);
  for (const c of node.children ?? []) collectIds(c, set);
}

export function emitDesignSpec(input: Input): DesignSpec {
  for (const scene of input.scenes) {
    const ids = new Set<string>();
    collectIds(scene.layout, ids);
    for (const state of scene.states ?? []) {
      for (const p of state.patches) {
        if (!ids.has(p.id)) {
          throw new Error(`patch references unknown id "${p.id}" in scene "${scene.id}"`);
        }
      }
    }
  }
  return { mode: "design", version: PROTOCOL_VERSION, ...input };
}
