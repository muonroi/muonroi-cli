import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { salvageSubSessionOutput } from "../salvage-sub-session-output.js";

/**
 * Session 708f0fc4ac8b (2026-07-27T04:21:38) — the user asked "có vẻ trong lúc
 * sửa có 1 số test fail mà không phải do change của bạn nhỉ?" and got back,
 * 13 ms later, the VERBATIM answer to a different question asked 8 minutes
 * earlier ("Chính xác. LSP đọc file lớn hiệu quả hơn grep…"). 13 ms is far too
 * fast for a model call: no answer was generated at all.
 *
 * Cause: the sub-session is long-lived and resumed across turns, so its message
 * array still holds every PRIOR turn's assistant reply. When the current turn
 * produced nothing (aborted, or killed by the compaction 400 of session
 * bce44da8134d), the backward scan for "last assistant" walked past this turn's
 * boundary and re-served the previous turn's answer as the reply to the new
 * question.
 *
 * Salvage must only ever consider messages this turn actually produced.
 */
const prior: ModelMessage[] = [
  { role: "user", content: "câu hỏi cũ về LSP vs grep" },
  { role: "assistant", content: "Chính xác. LSP đọc file lớn hiệu quả hơn grep ở mọi mặt…" },
];

describe("salvageSubSessionOutput", () => {
  it("returns nothing when the current turn produced no assistant message", () => {
    const messages: ModelMessage[] = [...prior, { role: "user", content: "câu hỏi mới về test fail" }];

    expect(salvageSubSessionOutput(messages, prior.length)).toEqual([]);
  });

  it("never re-serves a prior turn's answer as the reply to a new question", () => {
    const messages: ModelMessage[] = [...prior, { role: "user", content: "câu hỏi mới về test fail" }];

    const salvaged = salvageSubSessionOutput(messages, prior.length);
    const texts = salvaged.map((m) => String(m.content));

    expect(texts.some((t) => t.includes("LSP đọc file lớn hiệu quả hơn grep"))).toBe(false);
  });

  it("salvages the answer this turn DID produce", () => {
    const messages: ModelMessage[] = [
      ...prior,
      { role: "user", content: "câu hỏi mới về test fail" },
      { role: "assistant", content: "Đúng, 2 test fail đó nằm ngoài change của tôi." },
    ];

    const salvaged = salvageSubSessionOutput(messages, prior.length);

    expect(salvaged).toHaveLength(1);
    expect(String(salvaged[0].content)).toContain("nằm ngoài change của tôi");
  });

  it("keeps trailing tool messages that follow this turn's assistant message", () => {
    const messages: ModelMessage[] = [
      ...prior,
      { role: "user", content: "câu hỏi mới" },
      { role: "assistant", content: "đang chạy test" },
      { role: "tool", content: [] as never },
    ];

    expect(salvageSubSessionOutput(messages, prior.length)).toHaveLength(2);
  });

  it("treats an out-of-range or missing boundary as 'whole array' (legacy callers)", () => {
    const messages: ModelMessage[] = [...prior];

    expect(salvageSubSessionOutput(messages, 0)).toHaveLength(1);
    expect(salvageSubSessionOutput(messages)).toHaveLength(1);
  });
});
