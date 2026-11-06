import { describe, expect, it } from "vitest";
import { deriveNoiseReason, hintScopeOf } from "../noise-reason.js";
import { createRecallLedger } from "../recall-ledger.js";

const session = { project: "muonroi-cli", lang: "typescript" };

describe("hintScopeOf", () => {
  it("reads project and language from the stored scope; 'any' languages do not scope", () => {
    expect(hintScopeOf({ projectSlug: "storyflow", scope: { lang: ["C#", "any"] } })).toEqual({
      project: "storyflow",
      langs: ["csharp"],
    });
    expect(hintScopeOf({ scope: { project_slug: "bb", lang: "any" } })).toEqual({ project: "bb" });
    expect(hintScopeOf({})).toBeUndefined();
  });
});

describe("deriveNoiseReason", () => {
  it("derives wrong_repo when the hint's project differs from the session's", () => {
    const d = deriveNoiseReason(undefined, { project: "storyflow" }, session);
    expect(d).toMatchObject({ reason: "wrong_repo", derived: true });
    expect(d.basis).toContain("storyflow");
  });

  it("replaces a deleting wrong_task when a scope mismatch explains the noise", () => {
    expect(deriveNoiseReason("wrong_task", { langs: ["csharp"] }, session)).toMatchObject({
      reason: "wrong_language",
      derived: true,
    });
  });

  it("keeps stale_rule and explicit scope reasons; leaves wrong_task when the scope matches", () => {
    expect(deriveNoiseReason("stale_rule", { project: "storyflow" }, session)).toEqual({
      reason: "stale_rule",
      derived: false,
    });
    expect(deriveNoiseReason("wrong_task", { project: "MUONROI-CLI", langs: ["ts"] }, session)).toEqual({
      reason: "wrong_task",
      derived: false,
    });
    expect(deriveNoiseReason(undefined, undefined, session)).toEqual({ reason: undefined, derived: false });
    expect(deriveNoiseReason(undefined, { langs: ["csharp"] }, { project: "x", lang: null })).toEqual({
      reason: undefined,
      derived: false,
    });
  });
});

describe("recall ledger keeps the hint scope for feedback", () => {
  it("stores projectSlug/scope and finds entries by unique id prefix", () => {
    const ledger = createRecallLedger();
    ledger.record(
      [
        { id: "abcd1234-0000", collection: "experience-behavioral", projectSlug: "storyflow" },
        { id: "abff0000-1111", collection: "experience-principles" },
      ],
      "q",
    );
    expect(ledger.find("abcd", "experience-behavioral")?.projectSlug).toBe("storyflow");
    expect(ledger.find("ab")).toBeUndefined(); // ambiguous prefix
    expect(ledger.find("abff0000-1111", "experience-behavioral")).toBeUndefined();
  });
});
