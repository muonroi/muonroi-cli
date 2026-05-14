// src/agent-harness/__tests__/sidechannel.spec.ts
import { describe, expect, it } from "vitest";
import { createLineSplitter, createSidechannelWriter, parseSidechannelLine } from "../sidechannel";

describe("sidechannel framing", () => {
  it("serializes a message as a single JSONL line", () => {
    const line = createSidechannelWriter.serialize({ t: "idle" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean).length).toBe(1);
  });

  it("rejects messages over 1 MiB", () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    expect(() =>
      createSidechannelWriter.serialize({ t: "event", kind: "stream.delta", target: "a", text: huge }),
    ).toThrow(/exceeds 1 MiB/);
  });

  it("parses a valid line", () => {
    expect(parseSidechannelLine('{"t":"idle"}\n')).toEqual({ t: "idle" });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSidechannelLine("not json\n")).toThrow();
  });
});

describe("line splitter", () => {
  it("ignores empty lines", () => {
    const got: string[] = [];
    const split = createLineSplitter((l: string) => got.push(l));
    split("a\n\nb\n");
    expect(got).toEqual(["a\n", "b\n"]);
  });
});
