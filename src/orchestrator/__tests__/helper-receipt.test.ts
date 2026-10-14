import { describe, expect, it } from "vitest";
import { buildHelperReceipt } from "../helper-receipt.js";

describe("bounded helper evidence", () => {
  it("preserves the final changes and verification between oversized tool outputs", () => {
    const receipt = buildHelperReceipt("child-evidence", [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read_file",
            output: { type: "text", value: "SOURCE" + "x".repeat(80_000) },
          },
        ],
      },
      {
        role: "assistant",
        content:
          "Key Changes: src/fix.ts\nVerification Details: build passed; 4 tests passed\nRemaining Blockers: staging not verified\nResult Summary: CRITICAL_DELIVERABLE",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "test",
            toolName: "bash",
            output: { type: "text", value: "BUILD_LOG" + "y".repeat(80_000) + "CHECK_EXIT_0" },
          },
        ],
      },
    ]);
    expect(receipt).toContain("CRITICAL_DELIVERABLE");
    expect(receipt).toContain("src/fix.ts");
    expect(receipt).toContain("4 tests passed");
    expect(receipt).toContain("staging not verified");
    expect(receipt).toContain("toolCallId=read");
    expect(receipt).toContain("toolCallId=test");
    expect(receipt).toContain("CHECK_EXIT_0");
    expect(receipt.length).toBeLessThanOrEqual(12_000);
  });

  it("selects the latest final response rather than concatenating earlier exploration", () => {
    const receipt = buildHelperReceipt("child-id", [
      { role: "assistant", content: "EARLY_EXPLORATION".repeat(2_000) },
      { role: "assistant", content: [{ type: "text", text: "FINAL_VERIFIED_OUTCOME" }] },
    ]);
    expect(receipt).toContain("FINAL_VERIFIED_OUTCOME");
    expect(receipt).not.toContain("EARLY_EXPLORATION");
  });

  it("retains legacy string tool results from stored child transcripts", () => {
    const receipt = buildHelperReceipt("legacy-child", [
      { role: "tool", content: "Final tool output" } as unknown as import("ai").ModelMessage,
    ]);
    expect(receipt).toContain("Final tool output");
    expect(receipt).toContain("Status: returned");
    expect(receipt).toContain("No final deliverable returned");
  });

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
