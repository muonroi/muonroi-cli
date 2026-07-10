/**
 * config-loader.ts — Native replacement for gsd-core/bin/lib/config-loader.cjs
 *
 * Simplified config loading for the muonroi-cli native GSD workflow.
 * Reads .planning/config.json from the project directory and returns
 * a normalized config object.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PlanningConfig {
  model_profile?: string;
  planning?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Load the GSD planning config from .planning/config.json in the given cwd.
 * Returns an empty object when no config is present.
 */
export function loadConfig(cwd: string): PlanningConfig {
  const configPath = join(cwd, ".planning", "config.json");
  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as PlanningConfig;
  } catch {
    return {};
  }
}

/** Resolve a dotted config key against a config object (e.g. "workflow.research"). */
export function resolveConfigKey(dotKey: string, config: Record<string, unknown>): { found: boolean; value: unknown } {
  const parts = dotKey.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (typeof current !== "object" || Array.isArray(current)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

/**
 * Simple activation value resolver.
 * If the when key is `true` → active. Absent/falsy → inactive.
 */
export function resolveActivationValue(when: string, config: Record<string, unknown>): boolean {
  const { found, value } = resolveConfigKey(when, config);
  return found && value === true;
}
