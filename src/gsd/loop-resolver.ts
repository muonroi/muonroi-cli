/**
 * loop-resolver.ts — Native replacement for gsd-core/bin/lib/loop-resolver.cjs
 *
 * ADR-857 phase 3c registry-consuming query.
 * Given a loop point (one of the 12 canonical points from loop-host-contract.ts),
 * filters the frozen Capability Registry by config activation and returns
 * the active hooks as a JSON envelope.
 */
import type { CapabilityRegistry, LoopHook } from "./capability-registry.js";
import { resolveConfigKey } from "./config-loader.js";
import { getAllCanonicalPoints } from "./loop-host-contract.js";

export interface ResolvedLoopHooks {
  point: string;
  activeHooks: LoopHook[];
}

/**
 * Pure resolver: given a point, registry, and config, returns the active hooks.
 *
 * Throws if `point` is not one of the 12 canonical points.
 * Never throws for malformed registry/hook entries — skips and continues.
 *
 * Activation: a hook with no `when` is always active. With `when` (dotted key),
 * resolved against `config`; active iff truthy. Inactive hooks are filtered out.
 */
export function resolveLoopHooks(input: {
  point: string;
  registry: CapabilityRegistry;
  config: Record<string, unknown>;
  cwd?: string;
}): ResolvedLoopHooks {
  const { point, registry, config } = input;

  // Validate point against canonical points
  const canonicalPoints = getAllCanonicalPoints();
  if (!canonicalPoints.includes(point)) {
    throw new Error(`Invalid loop point: "${point}". Valid points: ${canonicalPoints.join(", ")}`);
  }

  // Guard: registry missing byLoopPoint
  const byLoopPoint = registry.byLoopPoint;
  if (!byLoopPoint || typeof byLoopPoint !== "object") {
    return { point, activeHooks: [] };
  }

  // Guard: point missing in registry
  const entry = byLoopPoint[point];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { point, activeHooks: [] };
  }

  const activeHooks: LoopHook[] = [];

  // Helper: check activation using config key resolver
  function isActive(hook: LoopHook): boolean {
    const when = hook.when;
    if (when === undefined || when === null) return true;
    if (typeof when !== "string" || when.length === 0) return false;
    const { found, value } = resolveConfigKey(when, config);
    return found && value === true;
  }

  // Process steps
  const steps = Array.isArray(entry.steps) ? entry.steps : [];
  for (const hook of steps) {
    if (!hook || typeof hook !== "object") continue;
    if (!isActive(hook)) continue;
    activeHooks.push(hook);
  }

  // Process contributions
  const contributions = Array.isArray(entry.contributions) ? entry.contributions : [];
  for (const hook of contributions) {
    if (!hook || typeof hook !== "object") continue;
    if (!isActive(hook)) continue;
    activeHooks.push(hook);
  }

  // Process gates
  const gates = Array.isArray(entry.gates) ? entry.gates : [];
  for (const hook of gates) {
    if (!hook || typeof hook !== "object") continue;
    if (!isActive(hook)) continue;
    activeHooks.push(hook);
  }

  return { point, activeHooks };
}

/**
 * Render resolved hooks as a simple envelope for backward compatibility
 * with the existing GsdDispatchResult shape.
 */
export function renderLoopHooksEnvelope(resolved: ResolvedLoopHooks): { point: string; activeHooks: LoopHook[] } {
  return {
    point: resolved.point,
    activeHooks: resolved.activeHooks,
  };
}
