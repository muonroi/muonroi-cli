/**
 * `/council <brief>` must carry the brief through VERBATIM.
 *
 * Measured live (session 770cc78e13cc): a pasted brief citing
 * `/mnt/data/Personal/Core/shipd-challenges/...` reached the council lowercased
 * as `/mnt/data/personal/core/...`, which does not exist on a case-sensitive
 * filesystem. The debate ran with ZERO tool calls — every read of the reference
 * implementation missed — while the same brief on another session (which kept
 * its casing) did 5 successful reads. Two separate mistakes produced it:
 *
 *   1. the TUI derived argv from the LOWERCASED command string (`c`), which
 *      exists only so `/Council` matches `/council`;
 *   2. the handler rebuilt the topic with `args.join(" ")`, collapsing every
 *      line break of a multi-line spec into one run-on line.
 */
import { describe, expect, it } from "vitest";
import "../council.js";
import { dispatchSlash, type SlashContext } from "../registry.js";

const BRIEF = [
  "# Council question: how many independent things?",
  "",
  "Read `/mnt/data/Personal/Core/shipd-challenges/workspace/` and judge",
  "whether `RetryCallState` couples rules 7 and 9.",
].join("\n");

function ctx(argsText?: string): SlashContext {
  return {
    cwd: "/tmp",
    tenantId: "local",
    defaultProvider: "anthropic",
    defaultModel: "claude-3-5-sonnet-latest",
    ...(argsText === undefined ? {} : { argsText }),
  };
}

/** `__COUNCIL__\n<rounds>\n<topic>` — the topic is everything from line 3 on. */
function decodeTopic(result: string | null): string {
  const lines = (result ?? "").split("\n");
  return lines.slice(2).join("\n");
}

describe("/council topic fidelity", () => {
  it("preserves line breaks in a pasted multi-line brief", async () => {
    const result = await dispatchSlash("council", BRIEF.split(/\s+/), ctx(BRIEF));
    expect(decodeTopic(result as string)).toBe(BRIEF);
  });

  it("preserves path casing — the difference between reading the repo and reading nothing", async () => {
    const topic = decodeTopic((await dispatchSlash("council", BRIEF.split(/\s+/), ctx(BRIEF))) as string);
    expect(topic).toContain("/mnt/data/Personal/Core/shipd-challenges/");
    expect(topic).toContain("RetryCallState");
  });

  it("strips a leading round count from the verbatim text, not just from argv", async () => {
    const withRounds = `3 ${BRIEF}`;
    const result = (await dispatchSlash("council", withRounds.split(/\s+/), ctx(withRounds))) as string;
    expect(result.split("\n")[1]).toBe("3");
    expect(decodeTopic(result)).toBe(BRIEF);
  });

  it("falls back to args.join for callers that supply no argsText (tests, MCP)", async () => {
    const result = (await dispatchSlash("council", ["REST", "vs", "gRPC"], ctx())) as string;
    expect(decodeTopic(result)).toBe("REST vs gRPC");
  });

  it("still matches sub-commands case-insensitively now that argv keeps its case", async () => {
    const result = (await dispatchSlash("council", ["LANG"], ctx("LANG"))) as string;
    expect(result).toContain("Council debate language");
  });
});
