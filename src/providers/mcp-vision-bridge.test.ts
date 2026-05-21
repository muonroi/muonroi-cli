import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeImageFromSource,
  askVisionProxy,
  bridgeMcpToolResult,
  getVisionGuidanceForTextOnly,
  isImageFile,
  listCachedImages,
  scrubImagePayloadsInMessages,
} from "./mcp-vision-bridge.js";

vi.mock("../models/registry.js", () => ({
  getModelInfo: (id: string) => {
    if (id.startsWith("deepseek")) return { supportsVision: false };
    if (id === "claude-sonnet-4-6") return { supportsVision: true };
    return {};
  },
}));

vi.mock("./keychain.js", () => ({
  loadKeyForProvider: vi.fn().mockResolvedValue("sk-test-key-12345678901234567890"),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("bridgeMcpToolResult", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("passes through for vision-capable models", async () => {
    const result = await bridgeMcpToolResult(
      "mcp_playwright__browser_take_screenshot",
      "some output",
      "claude-sonnet-4-6",
    );
    expect(result.proxied).toBe(false);
    expect(result.output).toBe("some output");
  });

  it("passes through snapshot (text) results without proxying", async () => {
    const result = await bridgeMcpToolResult(
      "mcp_playwright__browser_snapshot",
      "accessibility tree content...",
      "deepseek-v4-flash",
    );
    expect(result.proxied).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("proxies screenshot results for text-only models", async () => {
    const fakeBase64 = `iVBORw0KGgo${"A".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A login page with username and password fields" } }],
      }),
    });

    const result = await bridgeMcpToolResult(
      "mcp_playwright__browser_take_screenshot",
      { data: fakeBase64 },
      "deepseek-v4-flash",
    );

    expect(result.proxied).toBe(true);
    expect(result.description).toContain("login page");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("intercepts ANY MCP tool with image data, not just Playwright", async () => {
    const fakeBase64 = `iVBORw0KGgo${"A".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Figma design with buttons" } }],
      }),
    });

    const result = await bridgeMcpToolResult("mcp_figma__export_frame", { imageData: fakeBase64 }, "deepseek-v4-flash");

    expect(result.proxied).toBe(true);
    expect(result.description).toContain("Figma design");
  });

  it("intercepts non-MCP tools with image data", async () => {
    const fakeBase64 = `/9j/${"A".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "JPEG content" } }],
      }),
    });

    const result = await bridgeMcpToolResult("computer_screenshot", { screenshot: fakeBase64 }, "deepseek-v4-flash");

    expect(result.proxied).toBe(true);
  });

  it("detects data URI images in generic results", async () => {
    const fakeBase64 = "A".repeat(200);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Chart showing revenue data" } }],
      }),
    });

    const result = await bridgeMcpToolResult(
      "mcp_some_tool__capture",
      `data:image/png;base64,${fakeBase64}`,
      "deepseek-v4-flash",
    );

    expect(result.proxied).toBe(true);
  });

  it("passes through non-image tool results", async () => {
    const result = await bridgeMcpToolResult(
      "mcp_playwright__browser_click",
      { success: true, message: "Clicked element" },
      "deepseek-v4-flash",
    );

    expect(result.proxied).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back gracefully when vision API fails — but still strips base64", async () => {
    const fakeBase64 = `iVBORw0KGgo${"A".repeat(600)}`;
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const result = await bridgeMcpToolResult(
      "mcp_playwright__browser_take_screenshot",
      { data: fakeBase64 },
      "deepseek-v4-flash",
    );

    // proxied=true means the orchestrator will swap in our cleaned output;
    // critical to prevent the raw base64 from polluting conversation history.
    expect(result.proxied).toBe(true);
    const serialized = JSON.stringify(result.output);
    expect(serialized).toContain("could not be analyzed");
    expect(serialized).not.toContain(fakeBase64);
  });

  it("strips base64 data from output when proxied", async () => {
    const fakeBase64 = `iVBORw0KGgo${"A".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Dashboard page" } }],
      }),
    });

    const result = await bridgeMcpToolResult(
      "mcp_playwright__browser_take_screenshot",
      { screenshot: fakeBase64, format: "png" },
      "deepseek-v4-flash",
    );

    expect(result.proxied).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.screenshot).toContain("removed");
  });

  it("caches images for follow-up queries", async () => {
    const fakeBase64 = `iVBORw0KGgo${"A".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Test page" } }],
      }),
    });

    const result = await bridgeMcpToolResult(
      "mcp_playwright__browser_take_screenshot",
      { data: fakeBase64 },
      "deepseek-v4-flash",
    );

    expect(result.cachedImageIds).toBeDefined();
    expect(result.cachedImageIds!.length).toBeGreaterThan(0);

    const cached = listCachedImages();
    expect(cached.length).toBeGreaterThan(0);
    expect(cached[cached.length - 1].hasDescription).toBe(true);
  });
});

describe("design context structured output", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests json_object response_format for figma/design tools", async () => {
    const fakeBase64 = `iVBORw0KGgo${"A".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"viewport":{"width":1440,"height":900}}' } }],
      }),
    });

    await bridgeMcpToolResult("mcp_figma__export_frame", { imageData: fakeBase64 }, "deepseek-v4-flash");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("does NOT set response_format for non-design contexts", async () => {
    const fakeBase64 = `iVBORw0KGgo${"A".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    await bridgeMcpToolResult("mcp_playwright__browser_take_screenshot", { data: fakeBase64 }, "deepseek-v4-flash");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
  });
});

describe("SVG fast-path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bypasses vision API when input is image/svg+xml", async () => {
    const svgText = '<svg width="100" height="50"><rect x="10" y="10" width="80" height="30" fill="#007bff"/></svg>';
    const svgBase64 = Buffer.from(svgText, "utf8").toString("base64");
    const dataUri = `data:image/svg+xml;base64,${svgBase64}`;

    const result = await bridgeMcpToolResult("mcp_figma__export_frame", dataUri, "deepseek-v4-flash");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.proxied).toBe(true);
    const out = JSON.stringify(result.output);
    expect(out).toContain("fast-path");
    expect(out).toContain("rect");
  });
});

describe("askVisionProxy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns guidance when no images cached and no path given", async () => {
    const result = await askVisionProxy("What?", "img_nonexistent");
    expect(result).toContain("No matching image");
    expect(result).toContain("file_path");
  });

  it("answers follow-up questions about cached images", async () => {
    // Cache an image first
    const fakeBase64 = `/9j/${"B".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A form page" } }],
      }),
    });

    const bridgeResult = await bridgeMcpToolResult(
      "mcp_playwright__take_screenshot",
      { data: fakeBase64 },
      "deepseek-v4-flash",
    );
    const imageId = bridgeResult.cachedImageIds?.[0];
    expect(imageId).toBeDefined();

    // Ask follow-up
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "The submit button is blue" } }],
      }),
    });

    const answer = await askVisionProxy("What color is the submit button?", imageId);
    expect(answer).toContain("submit button is blue");
    expect(answer).toContain("Vision Proxy Answer");
  });

  it("uses most recent image when no ID specified", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Green banner at top" } }],
      }),
    });

    // Should use most recent cached image from previous tests
    const answer = await askVisionProxy("What color is the banner?");
    expect(answer).toContain("Vision Proxy Answer");
  });
});

describe("analyzeImageFromSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("analyzes inline base64 images", async () => {
    const fakeBase64 = `iVBORw0KGgo${"C".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A diagram showing system architecture" } }],
      }),
    });

    const result = await analyzeImageFromSource(fakeBase64);
    expect(result).toContain("diagram");
    expect(result).toContain("Cached as");
  });

  it("analyzes data URIs", async () => {
    const fakeBase64 = "A".repeat(200);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Logo image" } }],
      }),
    });

    const result = await analyzeImageFromSource(`data:image/png;base64,${fakeBase64}`);
    expect(result).toContain("Logo");
  });

  it("rejects invalid source", async () => {
    const result = await analyzeImageFromSource("not-a-file-and-not-base64");
    expect(result).toContain("Cannot resolve image source");
  });

  it("focuses analysis with a question", async () => {
    const fakeBase64 = `iVBORw0KGgo${"D".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "The text reads: Hello World" } }],
      }),
    });

    const result = await analyzeImageFromSource(fakeBase64, "What text is visible?");
    expect(result).toContain("Hello World");
  });
});

describe("getVisionGuidanceForTextOnly", () => {
  it("returns comprehensive guidance for text-only models", () => {
    const guidance = getVisionGuidanceForTextOnly("deepseek-v4-flash");
    expect(guidance).toContain("analyze_image");
    expect(guidance).toContain("ask_vision_proxy");
    expect(guidance).toContain("list_vision_cache");
    expect(guidance).toContain("PROACTIVE");
    expect(guidance.length).toBeGreaterThan(200);
  });

  it("returns empty for vision-capable models", () => {
    expect(getVisionGuidanceForTextOnly("claude-sonnet-4-6")).toBe("");
  });
});

describe("isImageFile", () => {
  it("detects common image extensions", () => {
    expect(isImageFile("photo.png")).toBe(true);
    expect(isImageFile("photo.jpg")).toBe(true);
    expect(isImageFile("photo.jpeg")).toBe(true);
    expect(isImageFile("icon.svg")).toBe(true);
    expect(isImageFile("anim.gif")).toBe(true);
    expect(isImageFile("photo.webp")).toBe(true);
  });

  it("rejects non-image files", () => {
    expect(isImageFile("code.ts")).toBe(false);
    expect(isImageFile("doc.pdf")).toBe(false);
    expect(isImageFile("data.json")).toBe(false);
  });
});

describe("scrubImagePayloadsInMessages — vision description injection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("injects bridged vision description into AI-SDK tool-result content", async () => {
    const fakeBase64 = `iVBORw0KGgo${"Z".repeat(600)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Login form with email and password" } }],
      }),
    });

    const toolCallId = "call_test_inject_123";
    await bridgeMcpToolResult(
      "mcp_playwright__browser_take_screenshot",
      { data: fakeBase64 },
      "deepseek-v4-flash",
      undefined,
      toolCallId,
    );

    // Mimic AI SDK v5 response.messages shape after scrubbing base64.
    const aiSdkMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "mcp_playwright__browser_take_screenshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "### Result\n- [Screenshot]" },
              { type: "image-data", data: fakeBase64, mediaType: "image/png" },
            ],
          },
        },
      ],
    };

    const [scrubbed] = scrubImagePayloadsInMessages([aiSdkMessage]) as Array<{
      content: Array<{ output: { value: Array<{ type: string; text?: string; data?: string }> } }>;
    }>;
    const value = scrubbed.content[0].output.value;

    // Original image bytes gone.
    const imgPart = value.find((p) => p.type === "image-data");
    expect(imgPart?.data).not.toContain(fakeBase64);

    // Vision description injected as a text part so the next turn can read it.
    const injected = value.find((p) => p.type === "text" && p.text?.includes("Login form"));
    expect(injected).toBeDefined();
  });
});

describe("scrubImagePayloadsInMessages — non-image size cap", () => {
  it("truncates oversized AI-SDK tool-result text content", () => {
    // Newlines + spaces ensure the chunk doesn't match the base64-image regex,
    // so we exercise the size cap rather than the image scrubber.
    const huge = "  some directory entry line\n".repeat(20_000); // ~580KB
    const msg = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_huge_1",
          toolName: "mcp_filesystem__directory_tree",
          output: { type: "content", value: [{ type: "text", text: huge }] },
        },
      ],
    };

    const [scrubbed] = scrubImagePayloadsInMessages([msg]) as Array<{
      content: Array<{ output: { value: Array<{ text: string }> } }>;
    }>;
    const text = scrubbed.content[0].output.value[0].text;

    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain("truncated by muonroi-cli");
    expect(text).toContain("directory_tree");
  });

  it("truncates oversized bash string output", () => {
    const huge = "line\n".repeat(80_000); // ~400KB
    const msg = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_huge_2",
          toolName: "bash",
          output: huge,
        },
      ],
    };

    const [scrubbed] = scrubImagePayloadsInMessages([msg]) as Array<{
      content: Array<{ output: string }>;
    }>;
    const out = scrubbed.content[0].output;

    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("truncated");
  });

  it("leaves small tool outputs untouched", () => {
    const small = "hello world";
    const msg = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_small",
          toolName: "bash",
          output: small,
        },
      ],
    };

    const [scrubbed] = scrubImagePayloadsInMessages([msg]) as Array<{
      content: Array<{ output: string }>;
    }>;
    expect(scrubbed.content[0].output).toBe(small);
  });
});

describe("listCachedImages", () => {
  it("returns structured list with required fields", () => {
    const cached = listCachedImages();
    for (const entry of cached) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("source");
      expect(entry).toHaveProperty("label");
      expect(entry).toHaveProperty("age");
      expect(entry).toHaveProperty("hasDescription");
    }
  });
});
