import { describe, it, expect } from "vitest";
import {
  COUNCIL_PALETTE,
  COUNCIL_SIGILS,
  resolveRoleStyle,
} from "../role-palette.js";

function makeRegistry() {
  const map = new Map<string, number>();
  let next = 0;
  return function getSlot(role: string): number {
    if (!map.has(role)) {
      map.set(role, next % 8);
      next++;
    }
    return map.get(role) ?? 0;
  };
}

describe("COUNCIL_PALETTE", () => {
  it("has exactly 8 entries", () => {
    expect(COUNCIL_PALETTE).toHaveLength(8);
  });

  it("slot 0 is cyan", () => {
    expect(COUNCIL_PALETTE[0]).toBe("cyan");
  });
});

describe("COUNCIL_SIGILS", () => {
  it("has exactly 8 entries", () => {
    expect(COUNCIL_SIGILS).toHaveLength(8);
  });
});

describe("role slot registry", () => {
  it("assigns stable slots within a session", () => {
    const getSlot = makeRegistry();
    const slot1 = getSlot("Frontend Engineer");
    const slot2 = getSlot("Frontend Engineer");
    expect(slot1).toBe(slot2);
  });

  it("assigns different slots to different roles", () => {
    const getSlot = makeRegistry();
    const a = getSlot("Frontend Engineer");
    const b = getSlot("Backend Engineer");
    expect(a).not.toBe(b);
  });

  it("wraps modulo 8 when >8 distinct roles appear", () => {
    const getSlot = makeRegistry();
    for (let i = 0; i < 8; i++) getSlot(`Role${i}`);
    expect(getSlot("Role9")).toBe(0);
  });
});

describe("resolveRoleStyle", () => {
  it("NO_COLOR: collapses color to 'white'", () => {
    const style = resolveRoleStyle(0, true);
    expect(style.color).toBe("white");
    expect(style.sigil).toBe("●");
  });

  it("with color: returns palette color", () => {
    const style = resolveRoleStyle(1, false);
    expect(style.color).toBe("magenta");
    expect(style.sigil).toBe("◆");
  });
});
