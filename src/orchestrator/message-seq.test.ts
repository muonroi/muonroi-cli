import { describe, expect, it } from "vitest";
import { lastPersistedSeq } from "./message-seq.js";

describe("lastPersistedSeq", () => {
  it("returns null for empty array", () => {
    expect(lastPersistedSeq([])).toBeNull();
  });

  it("returns null when all entries are null", () => {
    expect(lastPersistedSeq([null, null, null])).toBeNull();
  });

  it("returns the last numeric entry when trailing nulls exist", () => {
    expect(lastPersistedSeq([1, 2, 3, null, null])).toBe(3);
  });

  it("returns the highest seq when the last entry is numeric", () => {
    expect(lastPersistedSeq([1, 2, 3])).toBe(3);
  });

  it("skips over interrupted/stub gaps", () => {
    expect(lastPersistedSeq([5, null, 7, null, 9, null])).toBe(9);
  });

  it("returns 0 (not null) when 0 is a valid seq", () => {
    expect(lastPersistedSeq([0])).toBe(0);
    expect(lastPersistedSeq([0, null])).toBe(0);
  });
});
