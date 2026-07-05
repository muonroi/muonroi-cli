import { describe, expect, it } from "vitest";
import { buildClarifyOptions, buildClarifyOptionsRich } from "../clarifier.js";

describe("buildClarifyOptions", () => {
  it("converts non-empty suggestions into choice options", () => {
    const { options } = buildClarifyOptions(["A", "B", "C"]);
    const choices = options.filter((o) => o.kind === "choice");
    expect(choices.map((o) => o.label)).toEqual(["A", "B", "C"]);
    expect(choices.map((o) => o.value)).toEqual(["A", "B", "C"]);
  });

  it("appends Type something + Chat about this escape options", () => {
    const { options } = buildClarifyOptions(["Pick me"]);
    const kinds = options.map((o) => o.kind);
    expect(kinds).toEqual(["choice", "freetext", "chat"]);
    expect(options[1].label).toBe("Type something");
    expect(options[2].label).toBe("Chat about this");
  });

  it("filters blank or non-string suggestions", () => {
    const { options } = buildClarifyOptions(["", "  ", "real"]);
    const choices = options.filter((o) => o.kind === "choice");
    expect(choices.map((o) => o.label)).toEqual(["real"]);
  });

  it("works with undefined suggestions (only escape hatches remain)", () => {
    const { options } = buildClarifyOptions(undefined);
    expect(options.length).toBe(2);
    expect(options[0].kind).toBe("freetext");
    expect(options[1].kind).toBe("chat");
  });

  it("trims whitespace from labels and values", () => {
    const { options } = buildClarifyOptions(["  spaced  "]);
    expect(options[0].label).toBe("spaced");
    expect(options[0].value).toBe("spaced");
  });

  it("omits defaultIndex when no recommendation provided", () => {
    const { defaultIndex } = buildClarifyOptions(["A", "B"]);
    expect(defaultIndex).toBeUndefined();
  });

  it("omits defaultIndex when recommended does not match any suggestion", () => {
    const { defaultIndex } = buildClarifyOptions(["A", "B"], "C");
    expect(defaultIndex).toBeUndefined();
  });

  it("omits defaultIndex when recommended is blank", () => {
    const { defaultIndex } = buildClarifyOptions(["A", "B"], "  ");
    expect(defaultIndex).toBeUndefined();
  });

  it("sets defaultIndex to recommended position when it matches a suggestion", () => {
    const { defaultIndex } = buildClarifyOptions(["A", "B", "C"], "B");
    expect(defaultIndex).toBe(1);
  });

  it("matches recommended case-insensitively", () => {
    const { defaultIndex } = buildClarifyOptions(["Postgres", "MySQL"], "postgres");
    expect(defaultIndex).toBe(0);
  });
});

describe("buildClarifyOptionsRich", () => {
  it("carries each choice's per-option description onto the card", () => {
    const { options } = buildClarifyOptionsRich([
      { label: "Refactor in place", description: "Lower risk, keeps history" },
      { label: "Rewrite module", description: "Higher risk, cleaner result" },
    ]);
    const choices = options.filter((o) => o.kind === "choice");
    expect(choices.map((o) => o.label)).toEqual(["Refactor in place", "Rewrite module"]);
    expect(choices.map((o) => o.description)).toEqual(["Lower risk, keeps history", "Higher risk, cleaner result"]);
  });

  it("appends the same Type something + Chat about this escape hatches", () => {
    const { options } = buildClarifyOptionsRich([{ label: "Only" }]);
    expect(options.map((o) => o.kind)).toEqual(["choice", "freetext", "chat"]);
  });

  it("points defaultIndex at the option flagged recommended", () => {
    const { defaultIndex } = buildClarifyOptionsRich([
      { label: "A" },
      { label: "B", recommended: true },
      { label: "C" },
    ]);
    expect(defaultIndex).toBe(1);
  });

  it("omits defaultIndex when no option is flagged recommended", () => {
    const { defaultIndex } = buildClarifyOptionsRich([{ label: "A" }, { label: "B" }]);
    expect(defaultIndex).toBeUndefined();
  });

  it("drops blank/invalid labels and omits empty descriptions", () => {
    const { options } = buildClarifyOptionsRich([
      { label: "  ", description: "ignored" },
      { label: "keep", description: "  " },
    ]);
    const choices = options.filter((o) => o.kind === "choice");
    expect(choices.map((o) => o.label)).toEqual(["keep"]);
    expect(choices[0]?.description).toBeUndefined();
  });

  it("returns only escape hatches for undefined/empty specs", () => {
    const { options } = buildClarifyOptionsRich(undefined);
    expect(options.map((o) => o.kind)).toEqual(["freetext", "chat"]);
  });
});
