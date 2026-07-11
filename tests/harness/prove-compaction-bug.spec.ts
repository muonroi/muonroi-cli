/**
 * PROVE: identity bug trong compactSubAgentMessages
 *
 * Thesis: Khi messages.length > 30, sliceMessageHistory tạo array mới
 * (processedMessages !== messages). Threshold check dùng processedTotal
 * (chỉ ~100K chars) < effectiveThresholdChars (~153.6K) → return ngay
 * mảng mới KHÔNG elide gì. Caller thấy compacted !== stripped → fire
 * recordCompaction (Sai) nhưng 0 char thực sự được elide.
 */
import { describe, expect, it } from "vitest";
import {
  compactSubAgentMessages,
  cumulativeMessageChars,
  sliceMessageHistory,
} from "../../src/orchestrator/subagent-compactor";

interface MockPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
  args?: string;
}

function makeToolTurn(
  userMsgIdx: number,
  toolResultSize = 3_000,
): { assistant: Record<string, unknown>; tool: Record<string, unknown> } {
  const payload = "x".repeat(toolResultSize);
  return {
    assistant: {
      role: "assistant",
      content: [
        { type: "text", text: `Let me call tool #${userMsgIdx}` },
        {
          type: "tool-call",
          toolCallId: `call_${userMsgIdx}`,
          toolName: "read_file",
          args: JSON.stringify({ path: `/tmp/file_${userMsgIdx}.ts` }),
        },
      ],
    },
    tool: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${userMsgIdx}`,
          toolName: "read_file",
          output: { value: payload },
        },
      ],
    },
  };
}

function buildConversation(turnCount: number): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [
    { role: "system", content: "You are an AI coding agent." },
    { role: "user", content: "Read files and help me debug" },
  ];
  for (let i = 0; i < turnCount; i++) {
    const turn = makeToolTurn(i);
    msgs.push(turn.assistant, turn.tool);
  }
  return msgs;
}

describe("compactSubAgentMessages identity bug", () => {
  const DEEPSEEK_128K_OPTS = {
    contextWindowTokens: 128_000,
    contextFillRatio: 0.3, // reasoning model
    keepLastTurns: 5,
    thresholdChars: 179_200, // from getTopLevelCompactThresholdChars(128K)
    stripOldReasoning: true,
  };

  it("B1 — 30 turns (61 messages): identity giữ nguyên", () => {
    const msgs = buildConversation(30);
    expect(msgs.length).toBe(62); // system + user + 60 tool messages

    const compacted = compactSubAgentMessages(msgs as any, DEEPSEEK_128K_OPTS);
    // identity giữ nguyên (không slice, không elide)
    expect(compacted).toBe(msgs);
  });

  it("B2 — 35 turns (72 messages): identity THAY ĐỔI nhưng 0 char elide", () => {
    const msgs = buildConversation(35);
    expect(msgs.length).toBe(72); // system + user + 70 tool messages

    const totalBefore = cumulativeMessageChars(msgs as any);
    console.log(`[B2] totalBefore: ${totalBefore} chars`);

    const compacted = compactSubAgentMessages(msgs as any, DEEPSEEK_128K_OPTS);
    const totalAfter = cumulativeMessageChars(compacted);

    // *** IDENTITY BUG: reference khác nhau ***
    console.log(`[B2] compacted === msgs? ${compacted === msgs}`);
    console.log(`[B2] totalAfter:  ${totalAfter} chars`);
    console.log(`[B2] char diff:   ${totalAfter - totalBefore} chars`);

    // PROOF 1: identity thay đổi (caller thấy compacted !== stripped → recordCompaction)
    expect(compacted).not.toBe(msgs);

    // PROOF 2: nhưng chars KHÔNG giảm (0 elision)
    // Trên thực tế, slice bỏ 2 assistant + 2 tool messages đầu = 4 msgs × ~3K = ~12K
    // Nhưng B4 threshold check return sớm, không call rewriteOlderToolMessage
    // Chỉ slice giữ 30 messages cuối — thực tế làm state nhỏ hơn, nhưng không phải "compaction"
    // QUAN TRỌNG: Đây là "history truncation", không phải "tool result elision"
    // Nên không có marker "elided by compactor" nào được tạo ra
    console.log(`[B2] Char giảm do slice bỏ đầu, nhưng KHÔNG có rewrite nào được gọi`);
    console.log(`[B2] → recordCompaction sẽ fire SAI`);
  });

  it("B3 — sliceMessageHistory luôn trả về array mới khi >30", () => {
    const arr: any[] = new Array(40).fill({ role: "user", content: "hello" });
    const sliced = sliceMessageHistory(arr, 30);
    // sliceMessageHistory tạo mảng mới (dòng 702: messages.slice(keepFromIndex))
    expect(sliced).not.toBe(arr);
    expect(sliced.length).toBe(30);

    // Hệ quả: compacted !== stripped luôn TRUE khi >30 messages
    // Dù không có elision nào xảy ra
  });
});
