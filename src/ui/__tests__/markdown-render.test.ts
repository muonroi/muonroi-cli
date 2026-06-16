import { describe, expect, it } from "vitest";
import { type InlineSegment, parseInline } from "../markdown-render.js";
import { dark } from "../theme.js";

const t = dark;
const text = (segs: InlineSegment[]) => segs.map((s) => s.text).join("");

describe("parseInline — marker concealment", () => {
  it("strips bold markers and styles the inner text", () => {
    const segs = parseInline("a **bold** b", t);
    expect(text(segs)).toBe("a bold b");
    const bold = segs.find((s) => s.text === "bold");
    expect(bold?.bold).toBe(true);
    expect(bold?.fg).toBe(t.mdBold);
  });

  it("strips italic markers (* and _)", () => {
    expect(text(parseInline("an *italic* word", t))).toBe("an italic word");
    expect(text(parseInline("an _italic_ word", t))).toBe("an italic word");
    expect(parseInline("an *italic* word", t).find((s) => s.text === "italic")?.italic).toBe(true);
  });

  it("handles bold+italic ***x***", () => {
    const seg = parseInline("***wow***", t).find((s) => s.text === "wow");
    expect(seg?.bold).toBe(true);
    expect(seg?.italic).toBe(true);
  });

  it("strips inline code backticks and colors it", () => {
    const segs = parseInline("call `.catch(next)` here", t);
    expect(text(segs)).toBe("call .catch(next) here");
    expect(segs.find((s) => s.text === ".catch(next)")?.fg).toBe(t.mdCode);
  });

  it("renders link label only, dropping the url", () => {
    const segs = parseInline("see [the docs](https://x/y) now", t);
    expect(text(segs)).toBe("see the docs now");
    expect(text(segs)).not.toContain("https://x/y");
    expect(segs.find((s) => s.text === "the docs")?.underline).toBe(true);
  });

  it("strips strikethrough ~~x~~", () => {
    expect(text(parseInline("~~gone~~", t))).toBe("gone");
  });

  it("leaves unterminated markers as literal text (streaming-safe)", () => {
    expect(text(parseInline("a **partial answer", t))).toBe("a **partial answer");
    expect(text(parseInline("trailing `code", t))).toBe("trailing `code");
  });

  it("never leaves ** ` ### markers in styled segments", () => {
    const sample = "**A** and `b` and ***c*** and [d](http://e) and ~~f~~";
    const out = text(parseInline(sample, t));
    expect(out).not.toMatch(/\*\*|`|~~|\]\(/);
  });
});
