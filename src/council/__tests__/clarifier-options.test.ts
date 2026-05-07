import { describe, expect, it } from "vitest";
import { buildClarifyOptions } from "../clarifier.js";

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
