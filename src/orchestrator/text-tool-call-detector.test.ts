import { describe, expect, it } from "vitest";
import { detectTextEmittedToolCall, parseDsmlToolCalls } from "./text-tool-call-detector.js";

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

  it("detects builtin tool names emitted as text (<bash>, <grep>) — live deepseek <bash> leak", () => {
    const r = detectTextEmittedToolCall("Starting:\n<bash>\nfind /workspace -name '*.html'\n</bash>");
    expect(r.detected).toBe(true);
    expect(r.tool).toBe("bash");
    expect(detectTextEmittedToolCall("<grep>\n<pattern>foo</pattern>\n</grep>").detected).toBe(true);
    expect(detectTextEmittedToolCall("<delegate>\n<agent>explore</agent>\n</delegate>").detected).toBe(true);
  });

  it("does NOT fire on a bare inline mention of bash (no invocation shape)", () => {
    expect(detectTextEmittedToolCall("Run the build with the <bash> tool to verify.").detected).toBe(false);
    expect(detectTextEmittedToolCall("I used bash to run the tests; they pass.").detected).toBe(false);
  });

  it("detects generic native wrappers (Qwen <tool_call>, Anthropic <invoke name=>)", () => {
    expect(detectTextEmittedToolCall('<tool_call>{"name":"read_file"}</tool_call>').detected).toBe(true);
    expect(detectTextEmittedToolCall('<invoke name="read_file"><parameter name="path">a</parameter></invoke>').detected).toBe(true);
    expect(detectTextEmittedToolCall("<function_calls>...").detected).toBe(true);
  });

  it("detects the DeepSeek-native DSML leak (｜｜DSML｜｜invoke …) and extracts the tool name", () => {
    // Live: storyflow_ui explore-A/B, deepseek T3 (session 799f0508e830) emitted
    // this as text and made no real tool call → empty, silent turn. The generic
    // <invoke matcher misses it because `<` is followed by the U+FF5C sentinel.
    const text = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="read_file">
<｜｜DSML｜｜parameter name="file_path" string="true">src/app/foo.html</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;
    const r = detectTextEmittedToolCall(text);
    expect(r.detected).toBe(true);
    expect(r.tool).toBe("read_file");
  });

  it("does NOT fire on a bare inline mention of a tool name (no invocation shape)", () => {
    // Precision: a prose mention must not be flagged — it would wrongly mark a
    // legitimate final answer as a broken tool call.
    expect(detectTextEmittedToolCall("Use the <read_file> tool to view the source.").detected).toBe(false);
    expect(detectTextEmittedToolCall("The read_file and edit_file tools handle this.").detected).toBe(false);
    expect(detectTextEmittedToolCall("I edited the file and ran the tests; everything passes.").detected).toBe(false);
  });

  it("parseDsmlToolCalls extracts name + args from the DSML block (for targeted re-steer)", () => {
    const text = `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="read_file">
<｜｜DSML｜｜parameter name="file_path" string="true">src/app/foo.html</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="start_line" string="false">25</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read_file");
    expect(calls[0]!.args.file_path).toBe("src/app/foo.html");
    expect(calls[0]!.args.start_line).toBe("25");
  });

  it("parseDsmlToolCalls handles multiple invoke blocks and returns [] for non-DSML text", () => {
    const text = `<｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="file_path">a.ts</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke><｜｜DSML｜｜invoke name="edit_file"><｜｜DSML｜｜parameter name="path">b.ts</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["read_file", "edit_file"]);
    expect(parseDsmlToolCalls("just a normal answer")).toEqual([]);
  });

  it("does NOT fire on ordinary prose / code answers", () => {
    expect(detectTextEmittedToolCall("Final number: 16").detected).toBe(false);
    expect(detectTextEmittedToolCall("```ts\nconst a = readFile(path);\n```").detected).toBe(false);
    expect(detectTextEmittedToolCall("").detected).toBe(false);
    // Angular template with self-closing/nested tags must not match a tool tag.
    expect(detectTextEmittedToolCall('<span *ngIf="!story.cover" class="placeholder">{{ title }}</span>').detected).toBe(false);
  });
});
