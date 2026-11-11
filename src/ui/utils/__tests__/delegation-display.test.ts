import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { delegationResultForDisplay, parseDelegationList } from "../delegation-display.js";

describe("delegation user display", () => {
  it("hides the digest-bound host review footer without changing worker quotes or raw output", () => {
    const worker = "Worker result stays verbatim.\n## Host review evidence\nThis heading is quoted worker content.";
    const proof = JSON.stringify(
      {
        contextId: "review-context",
        sourceUnchanged: true,
        toolEvidence: [{ tool: "read_file", success: true }],
        verdict: { verdict: "pass", evidence: ["Report read"] },
      },
      null,
      2,
    );
    const digest = createHash("sha256").update(proof).digest("hex");
    const footer =
      "\n## Host review evidence\nHost-collected native tool results. Static inspection does not establish executed tests. Source snapshot is not an OS sandbox.\n" +
      proof;
    const raw = `jobId=worker\nresultVersion=v1\nSaved result: /fixture/worker.md\nHost review evidence sha256=${digest}\n\n${worker}${footer}`;
    expect(delegationResultForDisplay(raw)).toBe(worker);
    expect(raw).toContain(proof);
    expect(delegationResultForDisplay(raw + "tampered")).toBe(worker + footer + "tampered");
    expect(delegationResultForDisplay(raw.replace(`Host review evidence sha256=${digest}\n`, ""))).toBe(
      worker + footer,
    );
  });
  it("displays labelled jobs instead of a false empty list", () => {
    expect(
      parseDelegationList(
        "## Delegations\n\n- `worker` [execution=complete] [delivery=delivered] [ack=pending] Evidence report",
      ),
    ).toEqual([
      { id: "worker", status: "complete", delivery: "delivered", acknowledgement: "pending", label: "Evidence report" },
    ]);
  });
  it("supports legacy receipts and separate cancelled/error execution states", () => {
    expect(
      parseDelegationList(
        "- `old` [complete] [pending] Old report\n- `failed` [execution=error] [delivery=pending] [ack=not_ready] Failed report\n- `stopped` [cancelled] Stopped report",
      ).map((item) => [item.id, item.status, item.label]),
    ).toEqual([
      ["old", "complete", "Old report"],
      ["failed", "error", "Failed report"],
      ["stopped", "cancelled", "Stopped report"],
    ]);
  });
  it("hides only the recognized host envelope while preserving the worker's complete evidence verbatim", () => {
    const worker =
      "# Worker result\nVerified fixture.ts:7; exit0.\nMain: after processing is a quoted example.\n```text\njobId=example\n```";
    const raw =
      "jobId=worker\nresultVersion=version1\nSaved result: /fixture/worker.md\nExecution: complete\nDelivery: delivered\nAcknowledgement: pending\nMain: after processing this result, call delegation_ack(...).\n\n" +
      worker;
    expect(delegationResultForDisplay(raw)).toBe(worker);
    expect(raw).toContain("call delegation_ack");
  });
  it.each([
    "Saved output unavailable",
    "Delegation is still running",
    "Worker example\n\nMain: after processing this result",
    "jobId=worker\nresultVersion=v1\nBad header\n\nImportant evidence",
  ])("keeps unknown and error output intact: %s", (content) => {
    expect(delegationResultForDisplay(content)).toBe(content);
  });
});
