import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { refreshSessionGuidance } from "../session-guidance.js";

const snapshot = (revision: string) => `[EE Session Guidance — avoid these patterns when using tools]\n${revision}`;

describe("current EE session guidance snapshot", () => {
  it("keeps only the current revision and preserves unrelated history and row sequences", () => {
    const user: ModelMessage = { role: "user", content: "USER_GOAL" };
    const assistant: ModelMessage = { role: "assistant", content: "VERIFIED_PROGRESS" };
    const messages: ModelMessage[] = [user, { role: "system", content: snapshot("rev1") }, assistant];
    const seqs: Array<number | null> = [11, 12, 13];
    refreshSessionGuidance(messages, seqs, snapshot("rev2"));
    refreshSessionGuidance(messages, seqs, snapshot("rev3"));
    expect(messages).toEqual([user, assistant, { role: "system", content: snapshot("rev3") }]);
    expect(seqs).toEqual([11, 13, null]);
    expect(JSON.stringify(messages)).not.toContain("rev1");
    expect(JSON.stringify(messages)).not.toContain("rev2");
  });

  it("does not append an identical snapshot or overwrite its stored identity", () => {
    const guidance: ModelMessage = { role: "system", content: snapshot("rev1") };
    const messages = [guidance];
    const seqs = [42];
    refreshSessionGuidance(messages, seqs, snapshot("rev1"));
    expect(messages).toEqual([guidance]);
    expect(messages[0]).toBe(guidance);
    expect(seqs).toEqual([42]);
  });

  it("restores current guidance after compaction removed the earlier snapshot", () => {
    const messages: ModelMessage[] = [{ role: "system", content: "[Context checkpoint summary] DONE" }];
    const seqs: Array<number | null> = [7];
    refreshSessionGuidance(messages, seqs, snapshot("rev1"));
    expect(messages[1]!.content).toBe(snapshot("rev1"));
    expect(seqs).toEqual([7, null]);
  });

  it("on resume retains only the latest stored snapshot until fresh guidance is available", () => {
    const old: ModelMessage = { role: "system", content: snapshot("old") };
    const latest: ModelMessage = { role: "system", content: snapshot("latest") };
    const user: ModelMessage = { role: "user", content: snapshot("USER_TEXT_IS_NOT_GUIDANCE") };
    const messages = [old, user, latest];
    const seqs = [1, 2, 3];
    refreshSessionGuidance(messages, seqs);
    expect(messages).toEqual([user, latest]);
    expect(seqs).toEqual([2, 3]);
  });

  it("is a no-op when no current or historical guidance exists", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "goal" }];
    const seqs = [1];
    refreshSessionGuidance(messages, seqs);
    expect(messages).toHaveLength(1);
    expect(seqs).toEqual([1]);
  });
});
