import { describe, it, expect } from "vitest";
import { parseSections, serializeSections, getSection } from "../parser.js";

describe("parseSections", () => {
  it("parses two headed sections", () => {
    const result = parseSections("## A\ncontent a\n\n## B\ncontent b");
    expect(result.sections.get("A")).toBe("content a");
    expect(result.sections.get("B")).toBe("content b");
    expect(result.preamble).toBe("");
  });

  it("captures preamble before first heading", () => {
    const result = parseSections("preamble\n\n## A\ncontent");
    expect(result.preamble).toBe("preamble");
    expect(result.sections.get("A")).toBe("content");
  });

  it("returns empty sections and preamble for empty string", () => {
    const result = parseSections("");
    expect(result.sections.size).toBe(0);
    expect(result.preamble).toBe("");
  });

  it("returns preamble only for text without headings", () => {
    const result = parseSections("no headings at all");
    expect(result.preamble).toBe("no headings at all");
    expect(result.sections.size).toBe(0);
  });
});

describe("getSection", () => {
  it("returns undefined for missing section (tolerant, no throw)", () => {
    const map = parseSections("## A\ncontent");
    expect(getSection(map, "Missing")).toBeUndefined();
  });

  it("returns content for existing section", () => {
    const map = parseSections("## A\ncontent a");
    expect(getSection(map, "A")).toBe("content a");
  });
});

describe("serializeSections", () => {
  it("round-trips: parse then serialize produces equivalent output", () => {
    const input = "## A\n\ncontent a\n\n## B\n\ncontent b\n";
    const parsed = parseSections(input);
    const output = serializeSections(parsed);
    const reparsed = parseSections(output);
    expect(reparsed.sections.get("A")).toBe(parsed.sections.get("A"));
    expect(reparsed.sections.get("B")).toBe(parsed.sections.get("B"));
    expect(reparsed.preamble).toBe(parsed.preamble);
  });

  it("respects heading order parameter", () => {
    const map = parseSections("## B\nb content\n\n## A\na content\n\n## C\nc content");
    const output = serializeSections(map, ["A", "B", "C"]);
    const aPos = output.indexOf("## A");
    const bPos = output.indexOf("## B");
    const cPos = output.indexOf("## C");
    expect(aPos).toBeLessThan(bPos);
    expect(bPos).toBeLessThan(cPos);
  });

  it("includes headings not in order parameter at the end", () => {
    const map = parseSections("## X\nx\n\n## Y\ny");
    const output = serializeSections(map, ["Y"]);
    const yPos = output.indexOf("## Y");
    const xPos = output.indexOf("## X");
    expect(yPos).toBeLessThan(xPos);
  });

  it("serializes preamble first when present", () => {
    const map = parseSections("my preamble\n\n## A\ncontent");
    const output = serializeSections(map);
    expect(output.startsWith("my preamble")).toBe(true);
  });
});
