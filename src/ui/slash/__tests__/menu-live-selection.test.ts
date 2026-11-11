/**
 * resolveLiveSlashSelection — Enter/Tab in the slash menu act on the LIVE
 * composer text, not the menu state of the last React render.
 *
 * Regression: "/exit" + Enter arriving in one input batch ran with the stale
 * render's query "" and selected item 0 of the unfiltered list
 * ("/permissions"), so /exit never exited (diag line measured on Windows:
 * `closureQuery="" composer="/exit" index=0 item=permissions`).
 */
import { describe, expect, it } from "vitest";
import { filterSlashMenuItems, resolveLiveSlashSelection, SLASH_MENU_ITEMS_ARROW_ORDER } from "../menu-items.js";

const staleEmpty = () => ({ query: "", items: filterSlashMenuItems(""), index: 0 });

describe("resolveLiveSlashSelection", () => {
  it("stale empty-query render + composer '/exit' selects exit, not item 0 of the unfiltered list", () => {
    expect(SLASH_MENU_ITEMS_ARROW_ORDER[0]?.id).not.toBe("exit"); // the precondition that made the bug bite
    const live = resolveLiveSlashSelection("/exit", staleEmpty());
    expect(live.query).toBe("exit");
    expect(live.items[live.index]?.id).toBe("exit");
  });

  it("a partially stale render (query 'e') also resolves to the live query", () => {
    const rendered = { query: "e", items: filterSlashMenuItems("e"), index: 0 };
    const live = resolveLiveSlashSelection("/exit", rendered);
    expect(live.items[live.index]?.id).toBe("exit");
  });

  it("keeps the rendered index when the live query matches the render (user arrowed down)", () => {
    const items = filterSlashMenuItems("c");
    const rendered = { query: "c", items, index: 1 };
    expect(resolveLiveSlashSelection("/c", rendered)).toBe(rendered);
  });

  it("falls back to the rendered state when the composer is not a bare slash command", () => {
    const rendered = staleEmpty();
    expect(resolveLiveSlashSelection("", rendered)).toBe(rendered);
    expect(resolveLiveSlashSelection("hello", rendered)).toBe(rendered);
    expect(resolveLiveSlashSelection("/ideal build x", rendered)).toBe(rendered);
  });

  it("tolerates surrounding whitespace in the composer", () => {
    const live = resolveLiveSlashSelection("  /exit  ", staleEmpty());
    expect(live.items[live.index]?.id).toBe("exit");
  });
});

describe("filterSlashMenuItems", () => {
  it("empty query returns the arrow-navigation order", () => {
    expect(filterSlashMenuItems("")).toBe(SLASH_MENU_ITEMS_ARROW_ORDER);
  });

  it("exact id outranks description matches", () => {
    expect(filterSlashMenuItems("status")[0]?.id).toBe("status");
    expect(filterSlashMenuItems("EXIT")[0]?.id).toBe("exit");
  });

  it("no match returns an empty list", () => {
    expect(filterSlashMenuItems("zzzz-no-such-command")).toEqual([]);
  });
});
