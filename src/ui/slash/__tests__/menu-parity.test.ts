/**
 * Drift guard — every command registered at runtime via registerSlash() MUST
 * appear in SLASH_MENU_ITEMS, otherwise the autocomplete shows
 * "No commands match" even though the command works when typed in full.
 *
 * This was the failure mode for /ideal: handler registered, menu entry missing.
 */
import { describe, expect, it } from "vitest";
import { SLASH_MENU_ITEMS } from "../menu-items.js";
import { listSlashCommands } from "../registry.js";

// Trigger side-effect registration for every slash module that participates
// in the registry. Mirrors the imports in app.tsx — keep in sync.
import "../optimize.js";
import "../discuss.js";
import "../plan.js";
import "../execute.js";
import "../compact.js";
import "../expand.js";
import "../clear.js";
import "../pin.js";
import "../cost.js";
import "../ee.js";
import "../debug.js";
import "../council.js";
import "../council-inspect.js";
import "../ideal.js";
import "../route.js";
import "../status.js";
import "../ponytail.js";

describe("slash menu / registry parity", () => {
  it("every registered slash command has a menu entry", () => {
    const menuIds = new Set(SLASH_MENU_ITEMS.map((m) => m.id));
    const registered = listSlashCommands();
    const missing = registered.filter((name) => !menuIds.has(name));
    expect(missing).toEqual([]);
  });

  it("includes /ideal entry (regression: was silently missing)", () => {
    const ideal = SLASH_MENU_ITEMS.find((m) => m.id === "ideal");
    expect(ideal).toBeDefined();
    expect(ideal?.label).toBe("ideal");
  });
});
