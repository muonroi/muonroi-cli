import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { extractDecisions } from "../extract.js";

describe("extractDecisions", () => {
  it("extracts Decision: lines from messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Decision: Use JWT for auth" },
      { role: "assistant", content: "Understood. I'll implement JWT." },
    ];
    const result = extractDecisions(messages);
    expect(result.decisions).toContain("Use JWT for auth");
  });

  it("extracts Decided: lines", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Decided: Go with PostgreSQL" }];
    const result = extractDecisions(messages);
    expect(result.decisions).toContain("Go with PostgreSQL");
  });

  it("extracts Fact: lines", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: "Fact: The API rate limit is 100 req/min" }];
    const result = extractDecisions(messages);
    expect(result.facts).toContain("The API rate limit is 100 req/min");
  });

  it("extracts Constraint: lines", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Constraint: Must run on Windows and Linux" }];
    const result = extractDecisions(messages);
    expect(result.constraints).toContain("Must run on Windows and Linux");
  });

  it("extracts content inside preserve blocks as decisions", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Some text\n<!-- preserve -->\nImportant preserved content\n<!-- /preserve -->\nMore text",
      },
    ];
    const result = extractDecisions(messages);
    expect(result.decisions).toContain("\nImportant preserved content\n");
  });

  it("returns empty arrays for empty messages", () => {
    const result = extractDecisions([]);
    expect(result.decisions).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.constraints).toEqual([]);
  });

  it("returns empty arrays when no patterns match", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I'm doing well!" },
    ];
    const result = extractDecisions(messages);
    expect(result.decisions).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.constraints).toEqual([]);
  });

  it("extracts multiple patterns from a single message", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Decision: Use TypeScript\nFact: Project uses Bun runtime\nConstraint: No new dependencies",
      },
    ];
    const result = extractDecisions(messages);
    expect(result.decisions).toContain("Use TypeScript");
    expect(result.facts).toContain("Project uses Bun runtime");
    expect(result.constraints).toContain("No new dependencies");
  });
});
