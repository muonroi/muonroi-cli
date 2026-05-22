import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMockModel, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import { createLlmClassifier } from "../llm-classify.js";

describe("createLlmClassifier (PIL Layer 1 Pass 4)", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("parses a clean two-word reply into TaskType + style", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise") } });
    cleanup = handle.uninstall;

    // Build a stub factory — installMockModel routes everything through the mock anyway.
    const factory = (() => handle.model) as never;
    const classify = createLlmClassifier(factory, "deepseek-v4-flash");
    const result = await classify("ci action github fail, fix giúp tôi");

    expect(result).not.toBeNull();
    expect(result?.taskType).toBe("debug");
    expect(result?.outputStyle).toBe("concise");
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it("returns null when the reply cannot be parsed", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("¯\\_(ツ)_/¯") } });
    cleanup = handle.uninstall;

    const factory = (() => handle.model) as never;
    const classify = createLlmClassifier(factory, "deepseek-v4-flash");
    const result = await classify("hello");

    expect(result).toBeNull();
  });

  it("accepts a taskType-only reply (style optional)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("plan") } });
    cleanup = handle.uninstall;

    const factory = (() => handle.model) as never;
    const classify = createLlmClassifier(factory, "deepseek-v4-flash");
    const result = await classify("design a sharded queue");

    expect(result?.taskType).toBe("plan");
    expect(result?.outputStyle).toBeNull();
  });

  it("ignores noisy formatting (markdown, quotes, newlines)", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream('**"refactor, balanced"**\n\nrationale: ...') },
    });
    cleanup = handle.uninstall;

    const factory = (() => handle.model) as never;
    const classify = createLlmClassifier(factory, "deepseek-v4-flash");
    const result = await classify("tái cấu trúc auth module");

    expect(result?.taskType).toBe("refactor");
    expect(result?.outputStyle).toBe("balanced");
  });
});
