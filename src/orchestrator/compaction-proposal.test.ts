import { describe, expect, it } from "vitest";
import { parseCompactionProposal } from "./compaction-proposal.js";

const action = { messageIndex: 0, action: "keep", reason: 'Keep {braces}, quotes " and backslash \\' };
const encode = (actions: unknown[]) => JSON.stringify({ shouldCompact: true, reason: "bounded", actions });
describe("complete compaction proposal validation", () => {
  it("preserves quoted braces and escapes inside complete JSON", () => {
    expect(parseCompactionProposal(encode([action]), 1)?.actions).toEqual([action]);
  });
  it.each(
    [
      [action, action],
      [{ ...action, messageIndex: 1 }],
      [{ ...action, messageIndex: 0.5 }],
      [{ ...action, action: "delete-everything" }],
      [null],
    ].map((actions) => ({ actions })),
  )("rejects invalid or duplicate action indices without inventing replacements ($actions)", ({ actions }) => {
    expect(parseCompactionProposal(encode(actions), 1)).toBeNull();
  });
});
