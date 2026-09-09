/**
 * N1 — executor-side malformed-args guard.
 *
 * These tests drive `createBuiltinTools()` and call `tools.<name>.execute(...)`
 * — the SAME entry point an AI-SDK tool call travels through. That is
 * deliberate: this repo has twice shipped a helper-level test that stayed green
 * while the real call site passed nothing, so pinning `evaluateToolArgs` in
 * isolation would prove nothing about whether a live `read_file` call is
 * actually stopped.
 *
 * Failure being reproduced (session 2026-09-08): a sub-agent emitted 267 tool
 * calls whose arguments were the compactor's history marker
 * `{"__elided_note":"[earlier call args elided by sub-agent compactor — NNN
 * chars; …]"}`. 266 failed. `read_file` (no `required` array) took 184 of them
 * with `The "path" property must be of type string, got undefined`; `grep`
 * (which DOES declare `required:["pattern"]`, proving the provider does not
 * enforce schemas) took 71 with `pattern is required`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../bash.js";
import { createBuiltinTools } from "../registry.js";

interface BlockResult {
  success?: boolean;
  output?: string;
}

const MARKER =
  "[earlier call args elided by sub-agent compactor — 412 chars; consult the matching tool_result for what came back]";
const ELIDED_ARGS = { __elided_note: MARKER };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "arg-guard-"));
  dirs.push(d);
  return d;
}

async function call(
  tools: Record<string, unknown>,
  name: string,
  input: unknown,
): Promise<{ text: string; raw: unknown }> {
  const tool = tools[name] as { execute?: (i: unknown) => unknown };
  if (!tool?.execute) throw new Error(`tool ${name} has no execute`);
  const raw = await tool.execute(input);
  return { text: typeof raw === "string" ? raw : JSON.stringify(raw), raw };
}

function build(cwd: string, sessionId?: string): Record<string, unknown> {
  return createBuiltinTools(new BashTool(cwd), "agent", sessionId ? { sessionId } : undefined) as unknown as Record<
    string,
    unknown
  >;
}

describe("N1 — executor arg guard", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
  });

  it("blocks read_file called with the compactor's elision marker (the 184-failure shape)", async () => {
    const tools = build(tempDir(), "S-marker");
    const { raw, text } = await call(tools, "read_file", ELIDED_ARGS);
    const res = raw as BlockResult;

    expect(res.success).toBe(false);
    expect(text).toContain("BLOCKED (elision-marker-as-args)");
    expect(text).toContain("__elided_note");
    // The message must show a call that actually works — the opaque
    // `path must be of type string, got undefined` is what the model could not
    // act on for 141 consecutive steps.
    expect(res.output).toContain('{"file_path":"src/foo.ts"}');
    expect(text).not.toMatch(/must be of type string/);
  });

  it("blocks keyless read_file — the schema declares NO required array at all", async () => {
    const tools = build(tempDir(), "S-keyless-read");
    const { raw, text } = await call(tools, "read_file", {});
    expect((raw as BlockResult).success).toBe(false);
    expect(text).toContain("BLOCKED (missing-required-args)");
    expect(text).toContain("file_path or file_paths");
  });

  it("blocks keyless grep even though the provider was shown required:['pattern']", async () => {
    const tools = build(tempDir(), "S-keyless-grep");
    const { raw, text } = await call(tools, "grep", {});
    expect((raw as BlockResult).success).toBe(false);
    expect(text).toContain("BLOCKED (missing-required-args)");
    expect(text).toContain("pattern");
    expect((raw as BlockResult).output).toContain('{"pattern":"TODO"}');
  });

  it("blocks grep called with the elision marker", async () => {
    const tools = build(tempDir(), "S-grep-marker");
    const { text } = await call(tools, "grep", ELIDED_ARGS);
    expect(text).toContain("BLOCKED (elision-marker-as-args)");
  });

  it("blocks a marker that lands INSIDE an argument slot, so it never reaches the filesystem", async () => {
    // The presence checks alone would pass this: `file_path` is a non-empty
    // string. Without value scanning, write_file would create a file named
    // after the marker containing the marker.
    const cwd = tempDir();
    const victim = join(cwd, "victim.ts");
    writeFileSync(victim, "export const real = 1;\n", "utf8");

    const tools = build(cwd, "S-nested");
    // Satisfy the read-before-overwrite tracker FIRST, so the only thing left
    // standing between the marker and the file on disk is this guard.
    await call(tools, "read_file", { file_path: "victim.ts" });
    const { raw, text } = await call(tools, "write_file", { file_path: "victim.ts", content: MARKER });
    // Inertness is the load-bearing property: the guarded call must not write.
    // Asserted FIRST so a regression reports the overwritten file, not a
    // downstream flag.
    expect(readFileSync(victim, "utf8")).toBe("export const real = 1;\n");
    expect((raw as BlockResult).success).toBe(false);
    expect(text).toContain("BLOCKED (elision-marker-as-args)");
  });

  it("blocks the marker on an all-optional tool without demanding an optional key", async () => {
    // `compact` was the ONE call out of 267 that survived, because it takes no
    // arguments. Blocking it is deliberate — the marker is proof the model is
    // quoting compacted history — but the message must say `{}` is the valid
    // re-issue rather than invent a required parameter.
    const tools = build(tempDir(), "S-optional");
    const { text } = await call(tools, "compact", ELIDED_ARGS);
    expect(text).toContain("BLOCKED (elision-marker-as-args)");
    expect(text).toContain("every parameter of this tool is optional");
    expect(text).not.toMatch(/Re-issue with a non-empty/);
  });

  it("keeps bash's established BLOCKED kind so the safety intercept still auto-blocks it", async () => {
    // `parseSafetyBlock` reads the kind out of BASH's tool result only, and
    // tool-engine auto-blocks `empty-bash` while routing every other kind to an
    // interactive safety-override askcard. A new kind here would pop a modal per
    // malformed call, labelled with a kind the askcard does not know.
    const tools = build(tempDir(), "S-bash-kind");
    const { raw } = await call(tools, "bash", ELIDED_ARGS);
    const output = (raw as BlockResult).output ?? "";
    // Exactly the regex parseSafetyBlock applies to bash's result text.
    expect(output.replace(/^\s+/, "").match(/^BLOCKED \(([^)]+)\):/)?.[1]).toBe("empty-bash");
    // …and the body still names the real mistake.
    expect(output).toContain("__elided_note");
    expect(output).toContain('{"command":"ls -la"}');
  });

  it("escalates across tools within one session and stops on a well-formed call", async () => {
    const cwd = tempDir();
    const tools = build(cwd, "S-escalate");

    const first = await call(tools, "read_file", ELIDED_ARGS);
    expect(first.text).not.toMatch(/malformed tool calls in a row/);

    const second = await call(tools, "grep", {});
    expect(second.text).toMatch(/2 malformed tool calls in a row/);

    const third = await call(tools, "read_file", {});
    expect(third.text).toMatch(/3 malformed tool calls in a row/);
    expect(third.text).toMatch(/STOP issuing tool calls/);
    // Escalation must not name another tool — that is what turned a bash-only
    // stall into a whole-session stall.
    expect(third.text).not.toMatch(/use read_file, grep/);

    // A well-formed call resets the streak.
    writeFileSync(join(cwd, "ok.txt"), "hello-guard\n", "utf8");
    const good = await call(tools, "read_file", { file_path: "ok.txt" });
    expect(good.text).toContain("hello-guard");

    const afterReset = await call(tools, "grep", {});
    expect(afterReset.text).not.toMatch(/malformed tool calls in a row/);
  });

  it("keeps the streak across registry rebuilds when the sessionId is stable", async () => {
    const cwd = tempDir();
    await call(build(cwd, "S-rebuild"), "read_file", {});
    await call(build(cwd, "S-rebuild"), "grep", {});
    const third = await call(build(cwd, "S-rebuild"), "read_file", ELIDED_ARGS);
    expect(third.text).toMatch(/3 malformed tool calls in a row/);
  });

  it("does not block well-formed calls, nor no-arg tools called with {}", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "a.txt"), "alpha-content\n", "utf8");
    const tools = build(cwd, "S-happy");

    const read = await call(tools, "read_file", { file_path: "a.txt" });
    expect(read.text).toContain("alpha-content");
    expect(read.text).not.toContain("BLOCKED");

    const batch = await call(tools, "read_file", { file_paths: ["a.txt"] });
    expect(batch.text).toContain("alpha-content");

    const grep = await call(tools, "grep", { pattern: "alpha" });
    expect(grep.text).not.toContain("BLOCKED");

    // `process_list` declares no properties — `{}` is a legitimate call and
    // must stay one.
    const list = await call(tools, "process_list", {});
    expect(list.text).not.toContain("BLOCKED");

    // `list_tools` declares only OPTIONAL properties — `{}` is legitimate.
    const lt = await call(tools, "list_tools", {});
    expect(lt.text).not.toContain("BLOCKED");
    expect(lt.text).toContain("native_count");
  });

  it("allows write_file with empty content (presence check, not emptiness check)", async () => {
    const cwd = tempDir();
    const tools = build(cwd, "S-empty-content");
    const { raw } = await call(tools, "write_file", { file_path: "empty.txt", content: "" });
    expect((raw as BlockResult).success).toBe(true);
    expect(readFileSync(join(cwd, "empty.txt"), "utf8")).toBe("");
  });
});
