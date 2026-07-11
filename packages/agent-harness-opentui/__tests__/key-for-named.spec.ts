import { describe, expect, it } from "vitest";
import { keyForNamed } from "../src/input-bridge.js";

/**
 * Regression: NAMED was capitalized-only, so a driver sending the natural
 * lowercase key ("enter", "escape", "tab") resolved to null and emitted NOTHING
 * — Enter never submitted, Escape never dismissed a modal. keyForNamed now
 * resolves case-insensitively.
 */
describe("keyForNamed (case-insensitive named keys)", () => {
  it("resolves lowercase, capitalized, and upper named keys to the same event", () => {
    for (const k of ["enter", "Enter", "ENTER", "return", "Return"]) {
      const ev = keyForNamed(k);
      expect(ev, k).not.toBeNull();
      expect(ev!.name, k).toBe("return");
      expect(ev!.sequence, k).toBe("\r");
    }
  });

  it("resolves the keys that were silently no-oping before the fix", () => {
    expect(keyForNamed("escape")!.name).toBe("escape");
    expect(keyForNamed("tab")!.name).toBe("tab");
    expect(keyForNamed("space")!.name).toBe("space");
    expect(keyForNamed("backspace")!.name).toBe("backspace");
    expect(keyForNamed("up")!.name).toBe("up");
    expect(keyForNamed("pagedown")!.name).toBe("pagedown");
  });

  it("keeps short aliases working", () => {
    expect(keyForNamed("esc")!.name).toBe("escape");
    expect(keyForNamed("ret")!.name).toBe("return");
    expect(keyForNamed("del")!.name).toBe("delete");
  });

  it("still honors modifier prefixes on a named base", () => {
    const ev = keyForNamed("C-tab");
    expect(ev!.name).toBe("tab");
    expect(ev!.ctrl).toBe(true);
  });

  it("falls back to a literal single char, and returns null for unknown words", () => {
    expect(keyForNamed("/")!.sequence).toBe("/");
    expect(keyForNamed("a")!.sequence).toBe("a");
    expect(keyForNamed("nosuchkey")).toBeNull();
  });
});
