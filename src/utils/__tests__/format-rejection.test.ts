import { describe, expect, it } from "vitest";
import { formatRejection } from "../format-rejection.js";

/**
 * Regression guard for the `Unhandled rejection: {}` startup blackout.
 *
 * Measured 2026-09-09 under a fresh isolated HOME: both `muonroi-cli
 * --agent-mode` and `muonroi-cli mcp-driver` exited 1 printing exactly
 * `Unhandled rejection: {}` — the entire diagnostic. The rejected value was a
 * Bun `ResolveMessage` for a dynamic import that could not resolve. Measured
 * under `bun` (NOT under vitest, whose vite-node loader throws a plain Error
 * instead): `caught instanceof Error === false` and
 * `Object.getOwnPropertyNames(caught) === []`, so the old
 * `JSON.stringify(reason, Object.getOwnPropertyNames(reason))` collapsed the
 * whole message to `{}`. `makeResolveMessageShape()` reproduces exactly that
 * shape so the guard holds in either runtime.
 */
function makeResolveMessageShape(message: string): object {
  // Data on the PROTOTYPE, nothing own — the property layout that defeated the
  // old own-property serializer.
  const proto = {
    get message() {
      return message;
    },
    toString() {
      return `ResolveMessage: ${message}`;
    },
  };
  Object.defineProperty(proto.constructor, "name", { value: "ResolveMessage" });
  return Object.create(proto) as object;
}

describe("formatRejection", () => {
  it("renders a ResolveMessage-shaped rejection instead of collapsing it to {}", () => {
    const reason = makeResolveMessageShape("Cannot find module '@muonroi/agent-harness-core/mcp-server'");

    // Pin the premise the old code got wrong, so this test cannot silently
    // start passing against a value that never had the failing shape.
    expect(reason instanceof Error).toBe(false);
    expect(Object.getOwnPropertyNames(reason)).toEqual([]);
    expect(JSON.stringify(reason, Object.getOwnPropertyNames(reason))).toBe("{}");

    const rendered = formatRejection(reason);
    expect(rendered).not.toBe("{}");
    expect(rendered).toContain("Cannot find module");
    expect(rendered).toContain("@muonroi/agent-harness-core/mcp-server");
  });

  it("renders a real failed dynamic import in whatever shape the runtime throws", async () => {
    let caught: unknown;
    try {
      // Built dynamically so tsc does not try to resolve it at compile time.
      const missing = ["@this-package-does-not-exist", "nope"].join("/");
      await import(/* @vite-ignore */ missing);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const rendered = formatRejection(caught);
    expect(rendered).not.toBe("{}");
    expect(rendered.length).toBeGreaterThan(10);
  });

  it("keeps the stack for a real Error", () => {
    const err = new Error("boom");
    expect(formatRejection(err)).toContain("boom");
  });

  it("keeps the own-property JSON when it actually carries information", () => {
    expect(formatRejection({ code: "ENOENT", path: "/tmp/x" })).toBe('{"code":"ENOENT","path":"/tmp/x"}');
  });

  it("never returns a bare {} for an information-free object", () => {
    const bare = Object.create({ hidden: 1 }) as object;
    expect(JSON.stringify(bare, Object.getOwnPropertyNames(bare))).toBe("{}");
    expect(formatRejection(bare)).not.toBe("{}");
  });

  it("passes primitives through", () => {
    expect(formatRejection("plain string")).toBe("plain string");
    expect(formatRejection(undefined)).toBe("undefined");
  });
});
