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

import type { UINode } from "../protocol";
import { matchSelector } from "../selector";

const tree: UINode = {
  id: "root",
  role: "dialog",
  children: [
    { id: "composer", role: "textbox", focus: true, value: "hello" },
    { id: "send", role: "button", name: "Send" },
    {
      id: "list",
      role: "listbox",
      children: [
        { id: "i0", role: "listitem", name: "A" },
        { id: "i1", role: "listitem", name: "B", selected: true },
        { id: "i2", role: "listitem", name: "C" },
      ],
    },
  ],
};

describe("matcher", () => {
  it("matches role=button name=Send", () => {
    const hits = matchSelector(tree, 'role=button name="Send"');
    expect(hits.map((n) => n.id)).toEqual(["send"]);
  });

  it("matches contains op", () => {
    const hits = matchSelector(tree, "name~=Sen");
    expect(hits.map((n) => n.id)).toEqual(["send"]);
  });

  it("matches focus flag", () => {
    const hits = matchSelector(tree, "focus");
    expect(hits.map((n) => n.id)).toEqual(["composer"]);
  });

  it("matches [index=N] under listbox", () => {
    const hits = matchSelector(tree, "role=listbox >> role=listitem [index=2]");
    expect(hits.map((n) => n.id)).toEqual(["i2"]);
  });
});
