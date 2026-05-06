import { describe, expect, it } from "vitest";
import { buildClarifyOptions } from "../clarifier.js";

describe("buildClarifyOptions", () => {
  it("converts non-empty suggestions into choice options", () => {
    const out = buildClarifyOptions(["A", "B", "C"]);
    const choices = out.filter((o) => o.kind === "choice");
    expect(choices.map((o) => o.label)).toEqual(["A", "B", "C"]);
    expect(choices.map((o) => o.value)).toEqual(["A", "B", "C"]);
  });

  it("appends Type something + Chat about this escape options", () => {
    const out = buildClarifyOptions(["Pick me"]);
    const kinds = out.map((o) => o.kind);
    expect(kinds).toEqual(["choice", "freetext", "chat"]);
    expect(out[1].label).toBe("Type something");
    expect(out[2].label).toBe("Chat about this");
  });

  it("filters blank or non-string suggestions", () => {
    const out = buildClarifyOptions(["", "  ", "real"]);
    const choices = out.filter((o) => o.kind === "choice");
    expect(choices.map((o) => o.label)).toEqual(["real"]);
  });

  it("works with undefined suggestions (only escape hatches remain)", () => {
    const out = buildClarifyOptions(undefined);
    expect(out.length).toBe(2);
    expect(out[0].kind).toBe("freetext");
    expect(out[1].kind).toBe("chat");
  });

  it("trims whitespace from labels and values", () => {
    const out = buildClarifyOptions(["  spaced  "]);
    expect(out[0].label).toBe("spaced");
    expect(out[0].value).toBe("spaced");
  });
});
