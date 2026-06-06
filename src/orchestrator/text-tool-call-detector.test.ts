import { describe, expect, it } from "vitest";
import { detectTextEmittedToolCall } from "./text-tool-call-detector.js";

describe("detectTextEmittedToolCall", () => {
  it("detects the Cline/Roo <read_file><path> dialect (live deepseek failure)", () => {
    // Verbatim shape from storyflow_ui A/B session 905d564dbde4: after a
    // destructive edit, deepseek emitted this as plain assistant text to
    // re-read the file — the CLI returned it as the final answer and the turn
    // was silently wasted with a broken file left behind.
    const text = `Let me restore the file properly.

<read_file>
<path>src/app/screens/story-list/story-list.component.html</path>
</read_file>`;
    const r = detectTextEmittedToolCall(text);
    expect(r.detected).toBe(true);
    expect(r.tool).toBe("read_file");
  });

  it("detects write_to_file / execute_command / apply_diff blocks", () => {
    expect(detectTextEmittedToolCall("<write_to_file>\n<path>a.ts</path>\n<content>x</content>\n</write_to_file>").detected).toBe(true);
    expect(detectTextEmittedToolCall("<execute_command>\n<command>npm test</command>\n</execute_command>").detected).toBe(true);
    expect(detectTextEmittedToolCall("<apply_diff>\n<path>a.ts</path>\n<diff>...</diff>\n</apply_diff>").detected).toBe(true);
  });

  it("detects an empty-but-closed tool block (open immediately closed)", () => {
    expect(detectTextEmittedToolCall("here:\n<read_file></read_file>").detected).toBe(true);
  });

  it("detects generic native wrappers (Qwen <tool_call>, Anthropic <invoke name=>)", () => {
    expect(detectTextEmittedToolCall('<tool_call>{"name":"read_file"}</tool_call>').detected).toBe(true);
    expect(detectTextEmittedToolCall('<invoke name="read_file"><parameter name="path">a</parameter></invoke>').detected).toBe(true);
    expect(detectTextEmittedToolCall("<function_calls>...").detected).toBe(true);
  });

  it("does NOT fire on a bare inline mention of a tool name (no invocation shape)", () => {
    // Precision: a prose mention must not be flagged — it would wrongly mark a
    // legitimate final answer as a broken tool call.
    expect(detectTextEmittedToolCall("Use the <read_file> tool to view the source.").detected).toBe(false);
    expect(detectTextEmittedToolCall("The read_file and edit_file tools handle this.").detected).toBe(false);
    expect(detectTextEmittedToolCall("I edited the file and ran the tests; everything passes.").detected).toBe(false);
  });

  it("does NOT fire on ordinary prose / code answers", () => {
    expect(detectTextEmittedToolCall("Final number: 16").detected).toBe(false);
    expect(detectTextEmittedToolCall("```ts\nconst a = readFile(path);\n```").detected).toBe(false);
    expect(detectTextEmittedToolCall("").detected).toBe(false);
    // Angular template with self-closing/nested tags must not match a tool tag.
    expect(detectTextEmittedToolCall('<span *ngIf="!story.cover" class="placeholder">{{ title }}</span>').detected).toBe(false);
  });
});
