// src/product-loop/discovery-migrations.ts
import type { ProjectContext } from "./types.js";

export const CURRENT_SCHEMA_VERSION = 1 as const;

export type Migrator = (prev: any) => any;

export const migrators: Record<number, Migrator> = {
  0: (prev) => ({ ...prev, version: 1, schemaName: "project-context" }),
};

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
}

export function readProjectContextWithMigration(raw: string): ProjectContext | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: any;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  let current = parsed.version === undefined ? { ...parsed, version: 0 } : parsed;
  try {
    while (current.version < CURRENT_SCHEMA_VERSION) {
      const m = migrators[current.version];
      if (!m) return null;
      current = m(current);
    }
  } catch {
    return null;
  }
  if (current.version !== CURRENT_SCHEMA_VERSION) return null;
  return current as ProjectContext;
}
