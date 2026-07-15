import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInteractivePauseForTests,
  beginInteractivePause,
  endInteractivePause,
  isInteractivePaused,
} from "../interactive-pause.js";

describe("interactive-pause", () => {
  beforeEach(() => __resetInteractivePauseForTests());

  it("is not paused by default", () => {
    expect(isInteractivePaused()).toBe(false);
  });

  it("pauses between begin and end", () => {
    beginInteractivePause();
    expect(isInteractivePaused()).toBe(true);
    endInteractivePause();
    expect(isInteractivePaused()).toBe(false);
  });

  it("is reference-counted so nested/concurrent cards are safe", () => {
    beginInteractivePause();
    beginInteractivePause();
    endInteractivePause();
    expect(isInteractivePaused()).toBe(true); // one card still open
    endInteractivePause();
    expect(isInteractivePaused()).toBe(false);
  });

  it("never goes below zero on unbalanced end", () => {
    endInteractivePause();
    expect(isInteractivePaused()).toBe(false);
    beginInteractivePause();
    expect(isInteractivePaused()).toBe(true);
  });
});
