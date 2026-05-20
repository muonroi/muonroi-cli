import type { KeyEvent } from "@opentui/core";

export function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function isEscapeKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.code === "Escape" || key.baseCode === 27 || key.sequence === "" || key.raw === "";
}
