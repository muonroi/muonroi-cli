import { describe, expect, it } from "vitest";
import { resolveCouncilTopic } from "../council-topic.js";

/**
 * Session 3f998bfef7db — auto-council fired on the bare message "tiếp tục nhé"
 * and pinned that literal string as the debate topic, so every round prompt
 * ("Topic for discussion: …", "Round N discussion on: …") debated a phrase
 * carrying no subject. The topic must resolve to the work actually in flight.
 */
const msgs = (...pairs: Array<[string, string]>) => pairs.map(([role, content]) => ({ role, content }));

describe("resolveCouncilTopic", () => {
  it("substitutes the last substantive user message for a continuation phrase", () => {
    const topic = resolveCouncilTopic(
      "tiếp tục nhé",
      msgs(
        ["user", "bạn check xem vì sao lsp lại không work trong phiên này"],
        ["assistant", "LSP hỏng vì nhánh auto-install cache trả sai executable trên Windows."],
        ["user", "fix root cause cho tôi nhé"],
        ["assistant", "..."],
      ),
    );

    expect(topic).toContain("fix root cause cho tôi nhé");
    expect(topic).not.toBe("tiếp tục nhé");
  });

  it("skips over earlier continuation phrases to reach real content", () => {
    const topic = resolveCouncilTopic(
      "continue",
      msgs(["user", "refactor the auth token cache to use an LRU"], ["assistant", "..."], ["user", "tiếp tục"]),
    );

    expect(topic).toContain("refactor the auth token cache to use an LRU");
  });

  it("leaves a substantive trigger message untouched", () => {
    const topic = resolveCouncilTopic("design the billing ledger schema", msgs(["user", "hello"]));

    expect(topic).toBe("design the billing ledger schema");
  });

  it("falls back to the raw phrase when there is no prior substantive turn", () => {
    expect(resolveCouncilTopic("tiếp tục nhé", msgs(["user", "ok"]))).toBe("tiếp tục nhé");
    expect(resolveCouncilTopic("tiếp tục nhé", [])).toBe("tiếp tục nhé");
  });

  it("reads array-shaped message content (multi-part user turns)", () => {
    const topic = resolveCouncilTopic("tiếp tục", [
      { role: "user", content: [{ type: "text", text: "migrate the session store to sqlite WAL" }] },
      { role: "assistant", content: "..." },
    ]);

    expect(topic).toContain("migrate the session store to sqlite WAL");
  });
});
