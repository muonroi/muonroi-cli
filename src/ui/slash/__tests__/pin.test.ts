import { describe, expect, it } from "vitest";
import type { SlashContext } from "../registry.js";

// Trigger self-registration
import "../pin.js";

import { dispatchSlash } from "../registry.js";

const ctx: SlashContext = {
  cwd: "/tmp",
  tenantId: "local",
  defaultProvider: "anthropic",
  defaultModel: "claude-3-5-sonnet-latest",
};

describe("pin slash commands", () => {
  it("/pin with no args returns __PIN_LAST__ sentinel", async () => {
    const result = await dispatchSlash("pin", [], ctx);
    expect(result).toBe("__PIN_LAST__");
  });

  it("/pin <seq> returns __PIN_SEQ__ sentinel with seq", async () => {
    const result = await dispatchSlash("pin", ["42"], ctx);
    expect(result).toBe("__PIN_SEQ__\n42");
  });

  it("/pin <bad> returns usage hint", async () => {
    const result = await dispatchSlash("pin", ["abc"], ctx);
    expect(result).toBeTypeOf("string");
    expect((result ?? "").toLowerCase()).toContain("usage");
  });

  it("/unpin <seq> returns __UNPIN_SEQ__ sentinel", async () => {
    const result = await dispatchSlash("unpin", ["7"], ctx);
    expect(result).toBe("__UNPIN_SEQ__\n7");
  });

  it("/unpin without args returns usage", async () => {
    const result = await dispatchSlash("unpin", [], ctx);
    expect((result ?? "").toLowerCase()).toContain("usage");
  });

  it("/pins returns __PINS_LIST__ sentinel", async () => {
    const result = await dispatchSlash("pins", [], ctx);
    expect(result).toBe("__PINS_LIST__");
  });
});
