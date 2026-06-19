import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getWhoAmIProfile,
  outputStyleFromProfile,
  resetWhoAmICache,
  selectWhoAmIDims,
  type WhoAmIProfile,
} from "./who-am-i";

// Build a raw EE profile (the shape ~/.experience/src/profile-model.js loadProfile() returns).
function rawDim(value: string | null, confidence: number, sampleCount = 20) {
  return { value, confidence, sampleCount, distribution: {}, evidence: null };
}
function rawProfile(dims: Record<string, ReturnType<typeof rawDim>>) {
  return { version: 1, updatedAt: null, dimensions: dims };
}

describe("selectWhoAmIDims — privacy allowlist + commit/confidence gates", () => {
  const all = () =>
    rawProfile({
      "communication.question_style": rawDim("directive", 0.8),
      "communication.feedback_style": rawDim("implicit", 0.75),
      "communication.brevity": rawDim("concise", 0.83),
      "personality.conflict_style": rawDim("direct-constructive", 0.7),
      "personality.risk_tolerance": rawDim("experimental", 0.72),
      "personality.decision_speed": rawDim("fast-intuitive", 0.7),
      "work_patterns.energy": rawDim("night-owl", 0.6),
      "work_patterns.multitasking": rawDim("sequential-deep", 0.65),
      "work_patterns.session_length": rawDim("long", 0.55),
      "work_patterns.delegation_style": rawDim("autonomous", 0.68),
    });

  test("minimal exposes only the 4 Tang-1 work dims", () => {
    const dims = selectWhoAmIDims(all(), "minimal");
    expect(Object.keys(dims).sort()).toEqual(
      [
        "personality.decision_speed",
        "work_patterns.energy",
        "work_patterns.multitasking",
        "work_patterns.session_length",
      ].sort(),
    );
  });

  test("standard exposes all 10 committed dims", () => {
    const dims = selectWhoAmIDims(all(), "standard");
    expect(Object.keys(dims).length).toBe(10);
  });

  test("delegation_style is standard-only — stripped at minimal (transcript-derived, not Tang-1)", () => {
    expect(selectWhoAmIDims(all(), "minimal")["work_patterns.delegation_style"]).toBeUndefined();
    expect(selectWhoAmIDims(all(), "standard")["work_patterns.delegation_style"]).toBeDefined();
  });

  test("standard-built profile rendered at minimal strips Tang-2 dims (no stale leak)", () => {
    const dims = selectWhoAmIDims(all(), "minimal");
    expect(dims["communication.brevity"]).toBeUndefined();
    expect(dims["personality.conflict_style"]).toBeUndefined();
  });

  test("pending (value=null) dims are skipped", () => {
    const dims = selectWhoAmIDims(rawProfile({ "communication.brevity": rawDim(null, 0.9, 5) }), "standard");
    expect(Object.keys(dims).length).toBe(0);
  });

  test("per-tier confidence floors: 0.55 Tang-2 drops at 0.6, 0.50 work survives at 0.45", () => {
    const dims = selectWhoAmIDims(
      rawProfile({
        "communication.brevity": rawDim("concise", 0.55),
        "work_patterns.energy": rawDim("night-owl", 0.5),
      }),
      "standard",
    );
    expect(dims["communication.brevity"]).toBeUndefined();
    expect(dims["work_patterns.energy"]).toBeDefined();
  });

  test("Tang-3 emotional.* is never exposed (not in any allowlist)", () => {
    const dims = selectWhoAmIDims(rawProfile({ "emotional.mood": rawDim("calm", 0.99) }), "full");
    expect(Object.keys(dims).length).toBe(0);
  });

  test("decision_speed (personality.* but Tang-1) is allowed at minimal — namespace trap", () => {
    const dims = selectWhoAmIDims(rawProfile({ "personality.decision_speed": rawDim("measured", 0.7) }), "minimal");
    expect(dims["personality.decision_speed"]).toBeDefined();
  });
});

describe("outputStyleFromProfile — brevity/decision_speed → OutputStyle", () => {
  const p = (dims: WhoAmIProfile["dims"]): WhoAmIProfile => ({ level: "standard", dims });

  test("brevity concise → concise, verbose → detailed, moderate → balanced", () => {
    expect(
      outputStyleFromProfile(p({ "communication.brevity": { value: "concise", confidence: 0.8, samples: 20 } })),
    ).toBe("concise");
    expect(
      outputStyleFromProfile(p({ "communication.brevity": { value: "verbose", confidence: 0.8, samples: 20 } })),
    ).toBe("detailed");
    expect(
      outputStyleFromProfile(p({ "communication.brevity": { value: "moderate", confidence: 0.8, samples: 20 } })),
    ).toBe("balanced");
  });

  test("no brevity → decision_speed fast-intuitive → concise; deliberate → detailed", () => {
    expect(
      outputStyleFromProfile(
        p({ "personality.decision_speed": { value: "fast-intuitive", confidence: 0.7, samples: 20 } }),
      ),
    ).toBe("concise");
    expect(
      outputStyleFromProfile(
        p({ "personality.decision_speed": { value: "deliberate", confidence: 0.7, samples: 20 } }),
      ),
    ).toBe("detailed");
  });

  test("null profile or no usable dim → null (caller keeps its own default)", () => {
    expect(outputStyleFromProfile(null)).toBeNull();
    expect(
      outputStyleFromProfile(p({ "personality.decision_speed": { value: "measured", confidence: 0.7, samples: 20 } })),
    ).toBeNull();
  });
});

describe("getWhoAmIProfile — fail-open + cache", () => {
  const origHome = process.env.HOME;
  const origUser = process.env.USERPROFILE;

  beforeEach(() => {
    resetWhoAmICache();
  });
  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUser;
    resetWhoAmICache();
  });

  test("returns null when no EE install is present (no ~/.experience modules)", () => {
    const empty = os.tmpdir(); // no .experience/src here
    process.env.HOME = empty;
    process.env.USERPROFILE = empty;
    expect(getWhoAmIProfile()).toBeNull();
  });
});
