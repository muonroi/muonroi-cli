import { describe, expect, it } from "vitest";
import { sanitizeToolCallArguments } from "./thinking-mode.js";

// Regression coverage for the grok-composer 400 "expected JSON object for tool
// arguments" wedge (2026-07-14, run mrkoeezk9a29): some models emit a tool_call
// whose `arguments` is valid JSON but the WRONG SHAPE (a bare string / number /
// array / null). xAI rejects the replayed history with a non-transient 400, so
// the bounded stream-retry re-sends the same bad history forever. sanitize must
// normalise every non-object argument to "{}".

function asst(args: unknown) {
  return { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: args } }] };
}
function argsOf(msgs: unknown[]): unknown {
  return (msgs[0] as { tool_calls: Array<{ function: { arguments: unknown } }> }).tool_calls[0].function.arguments;
}

describe("sanitizeToolCallArguments", () => {
  it("repairs an empty-string argument to {}", () => {
    expect(argsOf(sanitizeToolCallArguments([asst("")] as never))).toBe("{}");
  });

  it("repairs an unparseable-string argument to {}", () => {
    expect(argsOf(sanitizeToolCallArguments([asst("{not json")] as never))).toBe("{}");
  });

  it("repairs a JSON string that parses to a NON-object to {} (the grok-composer 400 root cause)", () => {
    for (const badButValidJson of ['"hello"', "[1,2]", "123", "null", "true"]) {
      expect(argsOf(sanitizeToolCallArguments([asst(badButValidJson)] as never))).toBe("{}");
    }
  });

  it("repairs undefined / null arguments to {}", () => {
    expect(argsOf(sanitizeToolCallArguments([asst(undefined)] as never))).toBe("{}");
    expect(argsOf(sanitizeToolCallArguments([asst(null)] as never))).toBe("{}");
  });

  it("leaves a valid JSON OBJECT argument unchanged", () => {
    expect(argsOf(sanitizeToolCallArguments([asst('{"path":"a.ts"}')] as never))).toBe('{"path":"a.ts"}');
  });

  it("stringifies a stray object argument (wire shape must be a string)", () => {
    expect(argsOf(sanitizeToolCallArguments([asst({ path: "a.ts" })] as never))).toBe('{"path":"a.ts"}');
  });

  it("leaves non-assistant messages and empty tool_calls untouched", () => {
    const user = [{ role: "user", content: "hi" }];
    expect(sanitizeToolCallArguments(user as never)).toBe(user);
  });
});
