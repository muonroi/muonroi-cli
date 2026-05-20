/**
 * Unit tests for scoreSufficiency — the context-sufficiency gate that decides
 * whether the /ideal dispatcher MUST force the Council path (and AskCard
 * discovery) regardless of complexity. Vague briefs like "todo app" are
 * exactly the case where an Agile team would stop and discover, not
 * scaffold-and-pray.
 */

import { describe, expect, it } from "vitest";
import { scoreSufficiency } from "../layer1-intent.js";

describe("scoreSufficiency — vague briefs MUST go through Council", () => {
  it("'todo app' → not sufficient, missing scope + intent", () => {
    const out = scoreSufficiency({ rawText: "todo app" });
    expect(out.sufficient).toBe(false);
    expect(out.missing).toContain("scope");
    expect(out.missing).toContain("intent");
  });

  it("'crm system' → not sufficient, scope missing", () => {
    const out = scoreSufficiency({ rawText: "crm system" });
    expect(out.sufficient).toBe(false);
    expect(out.missing).toContain("scope");
  });

  it("'build a chat platform' → not sufficient, scope missing", () => {
    const out = scoreSufficiency({ rawText: "build a chat platform" });
    expect(out.sufficient).toBe(false);
    expect(out.missing).toContain("scope");
  });

  it("'dashboard for users' → not sufficient, scope missing", () => {
    const out = scoreSufficiency({ rawText: "dashboard for users" });
    expect(out.sufficient).toBe(false);
    expect(out.missing).toContain("scope");
  });

  it("empty string → not sufficient, all three categories missing", () => {
    const out = scoreSufficiency({ rawText: "" });
    expect(out.sufficient).toBe(false);
    expect(out.missing).toEqual(expect.arrayContaining(["scope", "target", "intent"]));
  });

  it("single short word 'todo' → not sufficient, intent + target missing", () => {
    const out = scoreSufficiency({ rawText: "todo" });
    expect(out.sufficient).toBe(false);
    expect(out.missing).toContain("intent");
    expect(out.missing).toContain("target");
  });
});

describe("scoreSufficiency — context-complete prompts CAN skip Council", () => {
  it("'fix typo in src/foo.ts:42' → sufficient (file ref + concrete verb)", () => {
    const out = scoreSufficiency({ rawText: "fix typo in src/foo.ts:42" });
    expect(out.sufficient).toBe(true);
    expect(out.missing).toEqual([]);
  });

  it("'rename FooService to BarService' → sufficient (concrete verb)", () => {
    const out = scoreSufficiency({ rawText: "rename FooService to BarService" });
    expect(out.sufficient).toBe(true);
  });

  it("'add validation to UserController.cs' → sufficient (file ref + verb)", () => {
    const out = scoreSufficiency({ rawText: "add validation to UserController.cs" });
    expect(out.sufficient).toBe(true);
  });

  it("'delete unused import in src/utils.ts' → sufficient", () => {
    const out = scoreSufficiency({ rawText: "delete unused import in src/utils.ts" });
    expect(out.sufficient).toBe(true);
  });

  it("long detailed brief (≥80 chars) with vague noun → scope NOT flagged", () => {
    // 80+ chars carrying enough context that scope is implied even with 'app'.
    const text =
      "Build a todo app with auth, multi-user support, postgres persistence, and a React + Vite frontend talking to a NestJS API";
    const out = scoreSufficiency({ rawText: text });
    expect(out.missing).not.toContain("scope");
  });
});

describe("scoreSufficiency — edge cases", () => {
  it("whitespace-only string treated as empty", () => {
    const out = scoreSufficiency({ rawText: "   \n\t  " });
    expect(out.sufficient).toBe(false);
  });

  it("repeated calls are idempotent (no FILE_REF_RE.lastIndex regression)", () => {
    const text = "fix bug in src/index.ts";
    const a = scoreSufficiency({ rawText: text });
    const b = scoreSufficiency({ rawText: text });
    expect(a.sufficient).toBe(b.sufficient);
    expect(a.missing).toEqual(b.missing);
  });

  it("'build a counter' → sufficient (concrete verb 'add'-adjacent 'build' is NOT in verb list, but length < 30 + no scope-noun → intent)", () => {
    // 'build' is not in CONCRETE_VERB_RE — intent only flagged if scope-noun AND file-ref AND verb all absent
    // 'build a counter' (15 chars) lacks scope-noun, file-ref, concrete-verb → intent missing
    const out = scoreSufficiency({ rawText: "build a counter" });
    expect(out.sufficient).toBe(false);
    expect(out.missing).toContain("intent");
  });
});
