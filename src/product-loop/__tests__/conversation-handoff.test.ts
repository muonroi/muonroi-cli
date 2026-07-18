import { describe, expect, it } from "vitest";
import { withPriorConversation } from "../loop-driver.js";

// Feature A — conversation handoff into /ideal. loop-driver PREPENDS a chat-derived
// conversation summary to its repo-audit conversationContext so the clarifier +
// council debate inherit what the user discussed before running `/ideal`.
describe("withPriorConversation (Feature A — /ideal conversation handoff)", () => {
  const audit = "## Repo audit\n- language: TypeScript\n- has tests: yes";

  it("prepends the prior conversation under a clear heading, keeping the audit context", () => {
    const prior = "[user]: let's build a rate limiter | [assistant]: token-bucket, per-IP, Redis-backed";
    const out = withPriorConversation(prior, audit);
    expect(out.startsWith("## Prior conversation (from the chat before /ideal)")).toBe(true);
    expect(out).toContain(prior);
    // Augments — never overwrites — the audit context.
    expect(out).toContain("## Repo audit");
    expect(out.indexOf("## Prior conversation")).toBeLessThan(out.indexOf("## Repo audit"));
  });

  it("returns the base unchanged when there is no prior conversation (flag off → undefined)", () => {
    expect(withPriorConversation(undefined, audit)).toBe(audit);
    expect(withPriorConversation("", audit)).toBe(audit);
    expect(withPriorConversation("   ", audit)).toBe(audit);
  });

  it("emits only the heading block when the base audit context is empty", () => {
    const prior = "[user]: discussed X";
    const out = withPriorConversation(prior, "");
    expect(out).toBe(`## Prior conversation (from the chat before /ideal)\n${prior}`);
  });
});
