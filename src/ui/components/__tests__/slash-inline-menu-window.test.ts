import { describe, expect, it } from "vitest";
import { computeSlashMenuWindow } from "../slash-inline-menu.js";

describe("computeSlashMenuWindow", () => {
  it("shows the whole list with no scroll when it fits the window", () => {
    // 7 primary commands, max 8 visible → no scrolling, no hidden markers.
    expect(computeSlashMenuWindow(7, 0)).toEqual({ start: 0, end: 7, hiddenAbove: 0, hiddenBelow: 0 });
    expect(computeSlashMenuWindow(7, 6)).toEqual({ start: 0, end: 7, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it("keeps the window pinned to the top while the selection is within the first page", () => {
    // 20 items, selecting index 0..7 keeps start=0 and shows 'more' below.
    expect(computeSlashMenuWindow(20, 0)).toEqual({ start: 0, end: 8, hiddenAbove: 0, hiddenBelow: 12 });
    expect(computeSlashMenuWindow(20, 7)).toEqual({ start: 0, end: 8, hiddenAbove: 0, hiddenBelow: 12 });
  });

  it("scrolls the window once the selection passes the last visible row (the bug)", () => {
    // Index 8 must scroll: start advances to 1 so row 8 is the last visible one.
    expect(computeSlashMenuWindow(20, 8)).toEqual({ start: 1, end: 9, hiddenAbove: 1, hiddenBelow: 11 });
    expect(computeSlashMenuWindow(20, 12)).toEqual({ start: 5, end: 13, hiddenAbove: 5, hiddenBelow: 7 });
  });

  it("clamps the window at the bottom of the list", () => {
    // Selecting the last item shows the final page; nothing hidden below.
    expect(computeSlashMenuWindow(20, 19)).toEqual({ start: 12, end: 20, hiddenAbove: 12, hiddenBelow: 0 });
  });

  it("clamps an out-of-range or negative selection", () => {
    expect(computeSlashMenuWindow(20, 999)).toEqual({ start: 12, end: 20, hiddenAbove: 12, hiddenBelow: 0 });
    expect(computeSlashMenuWindow(20, -5)).toEqual({ start: 0, end: 8, hiddenAbove: 0, hiddenBelow: 12 });
  });

  it("handles an empty list", () => {
    expect(computeSlashMenuWindow(0, 0)).toEqual({ start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 });
  });
});
