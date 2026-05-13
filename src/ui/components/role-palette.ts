import { useState, useCallback } from "react";

/** 8-slot HEX color palette for council roles (@opentui/react fg prop). */
export const COUNCIL_PALETTE: readonly string[] = [
  "#22d3ee", // cyan
  "#e879f9", // magenta
  "#facc15", // yellow
  "#4ade80", // green
  "#60a5fa", // blue
  "#f87171", // red
  "#e0e0e0", // white
  "#888888", // gray
] as const;

/** Sigils for NO_COLOR mode — ensures role identity survives color-off. */
export const COUNCIL_SIGILS: readonly string[] = [
  "●",
  "◆",
  "▲",
  "★",
  "■",
  "◐",
  "◇",
  "△",
] as const;

export interface RoleStyle {
  color: string;
  sigil: string;
}

/**
 * Resolve color + sigil for a palette slot index.
 *
 * @param slot   0–7 palette index
 * @param noColor when true (NO_COLOR env), color collapses to "white"
 */
export function resolveRoleStyle(slot: number, noColor: boolean): RoleStyle {
  const sigil = COUNCIL_SIGILS[slot % COUNCIL_SIGILS.length] ?? "●";
  if (noColor) {
    return { color: "#e0e0e0", sigil };
  }
  const color = COUNCIL_PALETTE[slot % COUNCIL_PALETTE.length] ?? "#e0e0e0";
  return { color, sigil };
}

/**
 * React hook: returns a stable `(role) => RoleStyle` resolver.
 *
 * First-seen assignment: the first distinct role string encountered in
 * a session gets slot 0, the next slot 1, etc., wrapping modulo 8.
 */
export function useRolePalette(): (role: string) => RoleStyle {
  const noColor = Boolean(process.env.NO_COLOR);
  const [registry] = useState(() => new Map<string, number>());
  const [nextSlot, setNextSlot] = useState(0);

  return useCallback(
    (role: string): RoleStyle => {
      const existing = registry.get(role);
      if (existing !== undefined) {
        return resolveRoleStyle(existing, noColor);
      }
      const slot = nextSlot % 8;
      registry.set(role, slot);
      setNextSlot((n) => n + 1);
      return resolveRoleStyle(slot, noColor);
    },
    [registry, nextSlot, noColor],
  );
}
