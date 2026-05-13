import { describe, it, expect } from "vitest";
import { truncateCodeBlocks } from "../../ui/components/code-block-truncate.js";

describe("truncateCodeBlocks", () => {
  it("leaves short code blocks untouched", () => {
    const text = "```ts\nconst x = 1;\n```";
    expect(truncateCodeBlocks(text)).toBe(text);
  });

  it("truncates a block with exactly 31 lines to 30 + footer", () => {
    const lines = Array.from({ length: 31 }, (_, i) => `line${i + 1}`).join("\n");
    const text = `\`\`\`ts\n${lines}\n\`\`\``;
    const result = truncateCodeBlocks(text);
    const kept = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
    expect(result).toContain(`\`\`\`ts\n${kept}`);
    expect(result).toContain("… 1 more line");
    expect(result).toContain("/export");
  });

  it("preserves fence language hint after truncation", () => {
    const lines = Array.from({ length: 40 }, () => "x").join("\n");
    const text = `\`\`\`python\n${lines}\n\`\`\``;
    const result = truncateCodeBlocks(text);
    expect(result).toMatch(/^```python/m);
    expect(result).toContain("… 10 more lines");
  });

  it("handles multiple fenced blocks — truncates only long ones", () => {
    const shortBlock = "```js\nconst a = 1;\n```";
    const longLines = Array.from({ length: 35 }, (_, i) => `line${i}`).join("\n");
    const longBlock = `\`\`\`js\n${longLines}\n\`\`\``;
    const text = `${shortBlock}\n\n${longBlock}`;
    const result = truncateCodeBlocks(text);
    expect(result).toContain("const a = 1;");
    expect(result).toContain("… 5 more lines");
  });

  it("handles a block with exactly 30 lines (boundary — no truncation)", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const text = `\`\`\`\n${lines}\n\`\`\``;
    expect(truncateCodeBlocks(text)).toBe(text);
  });

  it("uses custom maxLines param", () => {
    const lines = Array.from({ length: 10 }, () => "x").join("\n");
    const text = `\`\`\`\n${lines}\n\`\`\``;
    const result = truncateCodeBlocks(text, 5);
    expect(result).toContain("… 5 more lines");
  });
});
