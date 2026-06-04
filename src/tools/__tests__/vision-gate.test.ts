import { describe, expect, it } from "vitest";
import { messagesHaveImagePart, VISION_TOOL_NAMES, visionToolsNeeded } from "../vision-gate.js";

describe("visionToolsNeeded", () => {
  it("drops vision tools for a pure-text turn with no image anywhere", () => {
    expect(visionToolsNeeded({ userMessage: "what is this project about?", messages: [], cachedImageCount: 0 })).toBe(
      false,
    );
    expect(visionToolsNeeded({ userMessage: "fix the auth bug in src/auth/login.ts" })).toBe(false);
  });

  it("keeps vision tools when the message text references an image", () => {
    for (const msg of [
      "analyze screenshot.png",
      "what does this diagram show?",
      "review the figma mockup",
      "here is a data:image/png;base64,AAAA",
      "phân tích cái ảnh này giúp tôi",
    ]) {
      expect(visionToolsNeeded({ userMessage: msg })).toBe(true);
    }
  });

  it("keeps vision tools when the turn carries an image content part (attachment)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mediaType: "image/png", data: "BASE64" },
        ],
      },
    ];
    expect(visionToolsNeeded({ userMessage: "what is this?", messages })).toBe(true);
  });

  it("keeps vision tools when earlier turns cached images (follow-up queries)", () => {
    expect(visionToolsNeeded({ userMessage: "what color is the button?", cachedImageCount: 2 })).toBe(true);
  });

  it("keeps vision tools on a continuation that already used tools (BUG-A guard)", () => {
    expect(visionToolsNeeded({ userMessage: "continue", priorTurnHadTools: true })).toBe(true);
  });

  it("exports exactly the three vision tool ids (todo_write / core tools excluded)", () => {
    expect([...VISION_TOOL_NAMES]).toEqual(["analyze_image", "ask_vision_proxy", "list_vision_cache"]);
    expect(VISION_TOOL_NAMES).not.toContain("todo_write");
    expect(VISION_TOOL_NAMES).not.toContain("read_file");
  });
});

describe("messagesHaveImagePart", () => {
  it("detects an image part by type", () => {
    expect(messagesHaveImagePart([{ role: "user", content: [{ type: "image", data: "x" }] }])).toBe(true);
  });

  it("detects an image part by mediaType prefix", () => {
    expect(messagesHaveImagePart([{ role: "user", content: [{ type: "file", mediaType: "image/jpeg" }] }])).toBe(true);
  });

  it("returns false for text-only content and malformed input", () => {
    expect(messagesHaveImagePart([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe(false);
    expect(messagesHaveImagePart([{ role: "user", content: "plain string" }])).toBe(false);
    expect(messagesHaveImagePart(undefined)).toBe(false);
  });
});
