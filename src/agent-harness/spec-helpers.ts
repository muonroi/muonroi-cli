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
