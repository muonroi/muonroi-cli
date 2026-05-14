import { describe, expect, it } from "vitest";
import { parseSelector } from "../selector";

describe("selector parser", () => {
  it("parses key=value", () => {
    expect(parseSelector('role=button name="Send"')).toEqual({
      terms: [
        { key: "role", op: "=", value: "button" },
        { key: "name", op: "=", value: "Send" },
      ],
      combinators: [" "],
    });
  });

  it("parses contains and regex ops", () => {
    expect(parseSelector("name~=Send name*=^Send$").terms.map((t) => t.op)).toEqual(["~=", "*="]);
  });

  it("parses flags", () => {
    expect(parseSelector("focus selected").terms).toEqual([
      { key: "__flag", op: "=", value: "focus" },
      { key: "__flag", op: "=", value: "selected" },
    ]);
  });

  it("parses [index=N]", () => {
    const s = parseSelector("role=listitem [index=2]");
    expect(s.terms.find((t) => t.key === "__index")?.value).toBe("2");
  });

  it("parses child combinator", () => {
    const s = parseSelector("role=dialog >> role=button");
    expect(s.combinators).toEqual([">>"]);
  });

  it("parses dotted prop key", () => {
    expect(parseSelector("props.scrollTop=5").terms[0].key).toBe("props.scrollTop");
  });
});
