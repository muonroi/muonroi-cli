import { describe, expect, it } from "vitest";
import {
  attemptStallRescue,
  buildStallSynthesisMessages,
  pushStallToolResult,
  STALL_RESCUE_MAX_CHARS_PER_RESULT,
  STALL_RESCUE_MAX_RESULTS,
  type StallToolResult,
} from "./stall-rescue.js";

describe("pushStallToolResult", () => {
  it("caps the buffer count, keeping the most recent results", () => {
    const buf: StallToolResult[] = [];
    for (let i = 0; i < STALL_RESCUE_MAX_RESULTS + 5; i++) pushStallToolResult(buf, "bash", `out-${i}`);
    expect(buf.length).toBe(STALL_RESCUE_MAX_RESULTS);
    // oldest dropped, newest kept
    expect(buf[buf.length - 1]?.text).toBe(`out-${STALL_RESCUE_MAX_RESULTS + 4}`);
    expect(buf.some((r) => r.text === "out-0")).toBe(false);
  });

  it("truncates per-entry text and defaults a missing tool name", () => {
    const buf: StallToolResult[] = [];
    pushStallToolResult(buf, "", "x".repeat(STALL_RESCUE_MAX_CHARS_PER_RESULT + 500));
    expect(buf[0]?.tool).toBe("tool");
    expect(buf[0]?.text.length).toBe(STALL_RESCUE_MAX_CHARS_PER_RESULT);
  });
});

describe("buildStallSynthesisMessages", () => {
  it("appends one synthetic user turn with the request + tool digest", () => {
    const base = [{ role: "user", content: "hi" }];
    const out = buildStallSynthesisMessages(base, "find a bug", [
      { tool: "grep", text: "match in a.ts" },
      { tool: "read_file", text: "contents" },
    ]);
    expect(out.length).toBe(base.length + 1);
    const last = out[out.length - 1] as { role: string; content: string };
    expect(last.role).toBe("user");
    expect(last.content).toContain("find a bug");
    expect(last.content).toContain("grep");
    expect(last.content).toContain("match in a.ts");
    expect(last.content).toMatch(/Do NOT call any more tools/i);
    // does not mutate the base array
    expect(base.length).toBe(1);
  });
});

describe("attemptStallRescue", () => {
  it("returns null when there are no tool results (nothing to synthesize)", async () => {
    let called = false;
    const out = await attemptStallRescue({
      baseMessages: [],
      userText: "q",
      toolResults: [],
      finalize: async () => {
        called = true;
        return { text: "should not run" };
      },
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it("returns the synthesized text when finalize yields content", async () => {
    const out = await attemptStallRescue({
      baseMessages: [{ role: "user", content: "x" }],
      userText: "find a bug",
      toolResults: [{ tool: "grep", text: "found it in a.ts:42" }],
      finalize: async ({ messages }) => {
        // proves the digest reached the finalize call
        const last = messages[messages.length - 1] as { content: string };
        expect(last.content).toContain("a.ts:42");
        return { text: "The bug is at a.ts:42 — null deref." };
      },
    });
    expect(out).toBe("The bug is at a.ts:42 — null deref.");
  });

  it("returns null when finalize yields empty/whitespace text", async () => {
    const out = await attemptStallRescue({
      baseMessages: [],
      userText: "q",
      toolResults: [{ tool: "bash", text: "out" }],
      finalize: async () => ({ text: "   " }),
    });
    expect(out).toBeNull();
  });

  it("never throws — returns null when finalize rejects (provider still dead)", async () => {
    const out = await attemptStallRescue({
      baseMessages: [],
      userText: "q",
      toolResults: [{ tool: "bash", text: "out" }],
      finalize: async () => {
        throw new Error("stall again");
      },
    });
    expect(out).toBeNull();
  });
});
