/**
 * session-experience — in-process record of the agent's lived session, so a
 * "cảm nhận trong CLI" / "are you blind?" question is answered from data, not by
 * re-reading source. Also the "measure before re-architecting" instrumentation.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetSessionExperienceForTests,
  formatElisionManifest,
  formatSessionExperience,
  getSessionExperience,
  isSessionExperienceEmpty,
  recentElisions,
  recordCompaction,
  recordEeEvent,
  recordElision,
  recordRehydration,
} from "./session-experience.js";

describe("session-experience tracker", () => {
  afterEach(() => __resetSessionExperienceForTests());

  it("starts empty and reports an intact-context felt summary", () => {
    expect(isSessionExperienceEmpty()).toBe(true);
    const text = formatSessionExperience();
    expect(text).toContain("Nothing notable");
    expect(text).toContain("context is intact this session");
    // Steering line must always tell the agent to use lived data, not source.
    expect(text).toMatch(/not by reading the CLI source/i);
  });

  it("accumulates compaction, elision, rehydration and EE counters", () => {
    recordCompaction(4);
    recordCompaction(9);
    recordElision("call_a", "read_file", 4100, 4);
    recordElision("call_b", "grep", 2300, 9);
    recordRehydration("cache");
    recordRehydration("unavailable");
    recordEeEvent("timeout");

    const s = getSessionExperience();
    expect(s.compactions).toBe(2);
    expect(s.lastCompactionStep).toBe(9);
    expect(s.elisions).toHaveLength(2);
    expect(s.totalElidedChars).toBe(6400);
    expect(s.rehydrations.cache).toBe(1);
    expect(s.rehydrations.unavailable).toBe(1);
    expect(s.eeTimeouts).toBe(1);
    expect(isSessionExperienceEmpty()).toBe(false);
  });

  it("felt summary reflects real counters when non-empty", () => {
    recordCompaction(3);
    recordElision("call_x", "read_file", 5000, 3);
    recordRehydration("ee");
    const text = formatSessionExperience();
    expect(text).toContain("fired 1x");
    expect(text).toContain("last at step 3");
    expect(text).toContain("Tool outputs elided: 1");
    expect(text).toContain("ee=1");
    expect(text).not.toContain("Nothing notable");
  });

  it("recentElisions returns newest first and respects the cap arg", () => {
    for (let i = 0; i < 6; i++) recordElision(`call_${i}`, "read_file", 1000 + i, i);
    const recent = recentElisions(3);
    expect(recent.map((e) => e.toolCallId)).toEqual(["call_5", "call_4", "call_3"]);
  });

  it("formatElisionManifest is empty with no elisions, actionable otherwise", () => {
    expect(formatElisionManifest()).toBe("");
    recordElision("0123456789abcdefXYZ", "read_file", 4096, 7);
    const m = formatElisionManifest();
    // id is shortened, tool + char count present, and points at ee_query.
    expect(m).toContain("id=0123456789ab");
    expect(m).toContain("read_file (4096c)");
    expect(m).toMatch(/ee_query "tool-artifact id=XXX"/);
  });

  it("stores and retrieves elision summaries", () => {
    recordElision("call_sum", "grep", 5000, 3, "Grep found 12 matches");
    const s = getSessionExperience();
    const elision = s.elisions.find((e) => e.toolCallId === "call_sum");
    expect(elision).toBeDefined();
    expect(elision!.summary).toBe("Grep found 12 matches");
  });

  it("caps the elision log at 200 (FIFO) without unbounded growth", () => {
    for (let i = 0; i < 250; i++) recordElision(`c_${i}`, "bash", 500, i);
    const s = getSessionExperience();
    expect(s.elisions).toHaveLength(200);
    // Oldest 50 dropped; newest retained.
    expect(s.elisions[0]!.toolCallId).toBe("c_50");
    expect(s.elisions.at(-1)!.toolCallId).toBe("c_249");
  });
});
