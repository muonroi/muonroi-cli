/**
 * clarifier-language.test.ts
 *
 * The interview must follow the user's conversation language, not default to
 * English. Covers: (1) resolveInterviewLanguage (pinned locale > "english" >
 * auto-detect-from-topic), (2) localized escape-hatch labels on the option
 * builders, (3) buildClarificationPrompt FORCING the resolved language so an
 * English "## Scope Research" context block can't drag the cards to English.
 */

import { describe, expect, it, vi } from "vitest";
import * as settings from "../../utils/settings.js";
import { buildClarifyOptions, buildClarifyOptionsRich, resolveInterviewLanguage } from "../clarifier.js";
import { buildClarificationPrompt } from "../prompts.js";

describe("resolveInterviewLanguage", () => {
  it("auto-detects Vietnamese from the topic when the setting is auto", () => {
    vi.spyOn(settings, "getCouncilLanguage").mockReturnValue("auto");
    expect(resolveInterviewLanguage("Xây dựng công cụ giúp team")).toBe("vietnamese");
    expect(resolveInterviewLanguage("Build a URL shortener")).toBe("english");
  });

  it("honors a pinned locale regardless of the topic language", () => {
    vi.spyOn(settings, "getCouncilLanguage").mockReturnValue("vietnamese");
    expect(resolveInterviewLanguage("Build a URL shortener")).toBe("vietnamese");
  });

  it("forces English when the setting pins english", () => {
    vi.spyOn(settings, "getCouncilLanguage").mockReturnValue("english");
    expect(resolveInterviewLanguage("Xây dựng công cụ")).toBe("english");
  });
});

describe("escape-hatch label localization", () => {
  it("uses Vietnamese labels for a Vietnamese interview", () => {
    const { options } = buildClarifyOptions(["a"], undefined, "vietnamese");
    const hatches = options.filter((o) => o.kind === "freetext" || o.kind === "chat");
    expect(hatches.map((o) => o.label)).toEqual(["Nhập câu trả lời", "Thảo luận thêm"]);
  });

  it("uses English labels + English descriptions for an English interview (rich builder)", () => {
    const { options } = buildClarifyOptionsRich([{ label: "a" }], "english");
    const freetext = options.find((o) => o.kind === "freetext");
    expect(freetext?.label).toBe("Type something");
    expect(freetext?.description).toBe("Type a free-form answer");
  });

  it("keeps the historical label pair byte-identical when no language is passed", () => {
    const { options } = buildClarifyOptions(["a"]);
    const freetext = options.find((o) => o.kind === "freetext");
    // EN label + VN description — unchanged so existing callers/tests are safe.
    expect(freetext?.label).toBe("Type something");
    expect(freetext?.description).toBe("Nhập câu trả lời tự do");
  });
});

describe("buildClarificationPrompt forces the resolved language", () => {
  it("pins Vietnamese into the system prompt even with an English context block", () => {
    const { system } = buildClarificationPrompt(
      "Xây dựng công cụ",
      "## Scope Research\nAll findings written in English here.",
      undefined,
      "vietnamese",
    );
    expect(system).toMatch(/vietnamese/i);
    expect(system).toMatch(/do NOT mirror the language of any/i);
  });

  it("defaults to auto-detect for no-arg callers (backward compatible)", () => {
    const { system } = buildClarificationPrompt("Build X", "");
    expect(system).toMatch(/Language Rule/i);
  });
});
