import { describe, expect, it } from "vitest";
import { buildHelperReceipt } from "../helper-receipt.js";

describe("bounded helper evidence", () => {
  it("bounds a large final output while retaining head, tail and retrieval identity", () => {
    const receipt = buildHelperReceipt("child-id", [
      { role: "assistant", content: "HEAD" + "X".repeat(80_000) + "TAIL" },
    ]);
    expect(receipt.length).toBeLessThan(13_000);
    expect(receipt).toContain("HEAD");
    expect(receipt).toContain("TAIL");
    expect(receipt).toContain("child-id");
    expect(receipt).toContain("main session");
    expect(receipt).toContain("truncated");
  });

  it("includes a response-tool deliverable when the assistant only called a tool", () => {
    const receipt = buildHelperReceipt("child-id", [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call", toolName: "respond_general", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "respond_general",
            output: { type: "json", value: { summary: "verified outcome" } },
          },
        ],
      },
    ]);
    expect(receipt).toContain("verified outcome");
    expect(receipt).toContain("Status: returned");
  });

  it("marks missing output and failures without accepting them as final answers", () => {
    expect(buildHelperReceipt("child-id", [])).toContain("no result");
    expect(buildHelperReceipt("child-id", [], "provider failure")).toContain("Status: failed");
  });
});
