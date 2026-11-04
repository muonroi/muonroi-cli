import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactSubAgentMessages } from "../subagent-compactor.js";

function history(result: string): ModelMessage[] {
  return [
    { role: "user", content: "Use the worker evidence" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "worker-result", toolName: "delegation_read", input: { id: "worker" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "worker-result",
          toolName: "delegation_read",
          output: { type: "text", value: result },
        },
      ],
    },
    { role: "assistant", content: "Continue verification" },
  ];
}

describe("delegation evidence across compaction", () => {
  it("retains the main's exact ACK next action through repeated compaction of a long result", () => {
    const nextAction =
      'Main: after processing this result, call delegation_ack({"jobId":"worker","resultVersion":"v1"}).';
    const receipt =
      "jobId=worker\nresultVersion=v1\nSaved result: /fixture/worker.md\nExecution: complete\nDelivery: delivered\nAcknowledgement: pending\n" +
      nextAction +
      "\n" +
      "long evidence ".repeat(7000);
    const compacted = compactSubAgentMessages(history(receipt), { thresholdChars: 100, keepLastTurns: 0 });
    expect(JSON.stringify(compacted)).toContain(JSON.stringify(nextAction).slice(1, -1));
    expect(compactSubAgentMessages(compacted, { thresholdChars: 100, keepLastTurns: 0 })).toEqual(compacted);
  });

  it.each(["absent", "throws"])("does not claim retention when persistence is %s", (mode) => {
    const receipt = "jobId=worker\nresultVersion=v1\nSaved result: /fixture/worker.md\n" + "evidence ".repeat(7000);
    const compacted = compactSubAgentMessages(history(receipt), {
      thresholdChars: 100,
      keepLastTurns: 0,
      persistArtifact:
        mode === "throws"
          ? () => {
              throw new Error("fixture disk full");
            }
          : undefined,
    });
    const rendered = JSON.stringify(compacted);
    expect(rendered).not.toContain("long log retained");
    expect(rendered).toContain("Artifact retention unconfirmed");
    expect(rendered).toContain("Saved result: /fixture/worker.md");
  });

  it("keeps a short handoff verbatim through repeated compaction", () => {
    const receipt =
      "jobId=worker\nresultVersion=v1\nSaved result: /fixture/worker.md\nVerified source.ts:12; fixture-test exit=0. Unchecked: integration.\n" +
      "evidence ".repeat(180);
    const original = history(receipt);
    const compacted = compactSubAgentMessages(original, { thresholdChars: 100, keepLastTurns: 0 });
    expect(JSON.stringify(compacted)).toContain(receipt.replace(/\n/g, "\\n"));
    expect(compactSubAgentMessages(compacted, { thresholdChars: 100, keepLastTurns: 0 })).toEqual(compacted);
  });

  it("keeps a bounded versioned summary and artifact reference for a long result", () => {
    const receipt =
      "jobId=worker\nresultVersion=v1\nSaved result: /fixture/worker.md\nConclusion: bounded fixture result.\n" +
      "long log ".repeat(7000);
    const persisted: string[] = [];
    const compacted = compactSubAgentMessages(history(receipt), {
      thresholdChars: 100,
      keepLastTurns: 0,
      persistArtifact: (_id, _tool, content) => persisted.push(content),
    });
    const rendered = JSON.stringify(compacted);
    expect(rendered).toContain("resultVersion=v1");
    expect(rendered).toContain("Saved result: /fixture/worker.md");
    expect(rendered).toContain("Conclusion: bounded fixture result");
    expect(rendered).toContain("retrieve_tool_result");
    expect(rendered.length).toBeLessThan(7000);
    expect(persisted).toEqual([receipt]);
    expect(compactSubAgentMessages(compacted, { thresholdChars: 100, keepLastTurns: 0 })).toEqual(compacted);
  });
});
