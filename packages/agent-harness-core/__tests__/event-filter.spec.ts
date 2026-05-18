/**
 * event-filter.spec.ts — Unit tests for Phase 4.1 / Phase 6.5.
 *
 * Verifies the MUONROI_HARNESS_EVENTS allowlist filter behaviour:
 * - Default (unset): lifecycle preset passes; llm-token blocked.
 * - Wildcard "*" and "all": every kind passes.
 * - "lifecycle" named preset: same as default.
 * - Comma-separated list: exact allowlist.
 * - "lifecycle" in comma list: expands to all preset members.
 */

import { describe, expect, it } from "vitest";
import { createEventFilter, LIFECYCLE_PRESET } from "../src/event-filter.js";

describe("createEventFilter — default (env unset)", () => {
  const filter = createEventFilter(undefined);

  it("allows all lifecycle preset kinds", () => {
    for (const kind of LIFECYCLE_PRESET) {
      expect(filter(kind)).toBe(true);
    }
  });

  it("blocks llm-token (high volume — default off)", () => {
    expect(filter("llm-token")).toBe(false);
  });

  it("blocks unknown kinds", () => {
    expect(filter("some-future-event")).toBe(false);
  });
});

describe("createEventFilter — empty string (treated as unset)", () => {
  const filter = createEventFilter("");

  it("allows lifecycle preset kinds", () => {
    expect(filter("toast")).toBe(true);
    expect(filter("council-step")).toBe(true);
  });

  it("blocks llm-token", () => {
    expect(filter("llm-token")).toBe(false);
  });
});

describe('createEventFilter — wildcard "*"', () => {
  const filter = createEventFilter("*");

  it("passes every kind including llm-token", () => {
    expect(filter("llm-token")).toBe(true);
    expect(filter("toast")).toBe(true);
    expect(filter("council-step")).toBe(true);
    expect(filter("route-decision")).toBe(true);
    expect(filter("some-future-event")).toBe(true);
  });
});

describe('createEventFilter — "all" keyword', () => {
  const filter = createEventFilter("all");

  it('passes every kind (synonym for "*")', () => {
    expect(filter("llm-token")).toBe(true);
    expect(filter("toast")).toBe(true);
    expect(filter("sprint-halt")).toBe(true);
  });
});

describe('createEventFilter — "lifecycle" named preset', () => {
  const filter = createEventFilter("lifecycle");

  it("allows all lifecycle preset kinds", () => {
    for (const kind of LIFECYCLE_PRESET) {
      expect(filter(kind)).toBe(true);
    }
  });

  it("blocks llm-token", () => {
    expect(filter("llm-token")).toBe(false);
  });
});

describe("createEventFilter — comma-separated explicit list", () => {
  const filter = createEventFilter("toast,council-step");

  it("allows only explicitly listed kinds", () => {
    expect(filter("toast")).toBe(true);
    expect(filter("council-step")).toBe(true);
  });

  it("blocks kinds not in the list", () => {
    expect(filter("sprint-halt")).toBe(false);
    expect(filter("llm-token")).toBe(false);
    expect(filter("route-decision")).toBe(false);
  });
});

describe("createEventFilter — comma list with llm-token explicitly added", () => {
  const filter = createEventFilter("llm-token,council-step");

  it("allows llm-token when explicitly listed", () => {
    expect(filter("llm-token")).toBe(true);
    expect(filter("council-step")).toBe(true);
  });

  it("still blocks other kinds not listed", () => {
    expect(filter("toast")).toBe(false);
  });
});

describe("createEventFilter — 'lifecycle' in comma list expands preset", () => {
  const filter = createEventFilter("lifecycle,llm-token");

  it("allows all lifecycle preset kinds", () => {
    for (const kind of LIFECYCLE_PRESET) {
      expect(filter(kind)).toBe(true);
    }
  });

  it("also allows llm-token (explicitly added)", () => {
    expect(filter("llm-token")).toBe(true);
  });
});

describe("createEventFilter — whitespace tolerance", () => {
  const filter = createEventFilter("  toast , council-step  ");

  it("trims whitespace around kind names", () => {
    expect(filter("toast")).toBe(true);
    expect(filter("council-step")).toBe(true);
    expect(filter("sprint-halt")).toBe(false);
  });
});
