import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import type { DesignSpec, StatePatch, UINode } from "./protocol.js";

const schemaPath = new URL("../../docs/agent-harness/schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validator = ajv.compile({ $ref: `${schema.$id}#/definitions/DesignSpec` });

export function validateSpec(spec: unknown): { ok: boolean; errors?: unknown[] } {
  const ok = validator(spec);
  return ok ? { ok: true } : { ok: false, errors: validator.errors ?? [] };
}

export function querySpec(spec: DesignSpec, q: { scene: string; state?: string }): UINode {
  const scene = spec.scenes.find((s) => s.id === q.scene);
  if (!scene) throw new Error(`scene not found: ${q.scene}`);
  const layout = JSON.parse(JSON.stringify(scene.layout)) as UINode;
  if (!q.state) return layout;
  const state = scene.states?.find((s) => s.name === q.state);
  if (!state) throw new Error(`state not found: ${q.state}`);
  for (const patch of state.patches) applyPatch(layout, patch);
  return layout;
}

function applyPatch(node: UINode, p: StatePatch): boolean {
  if (node.id === p.id) {
    const { id: _ignored, ...rest } = p;
    Object.assign(node, rest);
    return true;
  }
  for (const c of node.children ?? []) {
    if (applyPatch(c, p)) return true;
  }
  return false;
}

export type SpecDiff = {
  scenes: {
    added: Array<{ id: string }>;
    removed: Array<{ id: string }>;
    modified: Array<{ id: string; changes: string[] }>;
  };
};

export function diffSpecs(a: DesignSpec, b: DesignSpec): SpecDiff {
  const aIds = new Set(a.scenes.map((s) => s.id));
  const bIds = new Set(b.scenes.map((s) => s.id));
  const added = [...bIds].filter((i) => !aIds.has(i)).map((id) => ({ id }));
  const removed = [...aIds].filter((i) => !bIds.has(i)).map((id) => ({ id }));
  const modified: SpecDiff["scenes"]["modified"] = [];
  for (const id of aIds) {
    if (!bIds.has(id)) continue;
    const sa = a.scenes.find((s) => s.id === id)!;
    const sb = b.scenes.find((s) => s.id === id)!;
    const changes: string[] = [];
    if (sa.name !== sb.name) changes.push("name");
    if (JSON.stringify(sa.layout) !== JSON.stringify(sb.layout)) changes.push("layout");
    if (JSON.stringify(sa.states ?? []) !== JSON.stringify(sb.states ?? [])) changes.push("states");
    if (changes.length) modified.push({ id, changes });
  }
  return { scenes: { added, removed, modified } };
}
