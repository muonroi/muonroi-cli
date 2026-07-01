import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Resolved @opengsd/gsd-core package root (bin/lib lives under gsd-core/). */
export function gsdCoreLibDir(): string {
  const pkgJson = require.resolve("@opengsd/gsd-core/package.json");
  return join(dirname(pkgJson), "gsd-core", "bin", "lib");
}

export function loadGsdLib<T = Record<string, unknown>>(moduleName: string): T {
  return require(join(gsdCoreLibDir(), `${moduleName}.cjs`)) as T;
}

export interface LoopHostContractEntry {
  step: string;
  points: string[];
  agentRoles: string[];
  coreArtifacts: { produces: string[]; consumes: string[] };
}

export function loadLoopHostContract(): LoopHostContractEntry[] {
  const mod = loadGsdLib<{ LOOP_HOST_CONTRACT: LoopHostContractEntry[] }>("loop-host-contract");
  return mod.LOOP_HOST_CONTRACT;
}

export function allLoopHostPoints(): string[] {
  return loadLoopHostContract().flatMap((e) => e.points);
}

export interface StateDocumentModule {
  stateExtractField: (content: string, fieldName: string) => string | null;
  stateReplaceField: (content: string, fieldName: string, newValue: string) => string;
}

export function loadStateDocument(): StateDocumentModule {
  return loadGsdLib<StateDocumentModule>("state-document");
}
