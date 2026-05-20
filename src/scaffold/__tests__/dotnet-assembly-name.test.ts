/**
 * Verifies kebab → PascalCase conversion used for `dotnet new -n`.
 * Background: original code passed the kebab project name verbatim, which
 * produced .csproj like `todo-app.Catalog.csproj` and C# namespaces like
 * `todo_app.Catalog.*` (C# can't have dashes — dotnet mangles to underscore).
 * The fix uses PascalCase only for the .NET assembly + namespace prefix,
 * keeping kebab for the outer folder and package.json.
 */
import { describe, expect, it } from "vitest";
import { toDotNetAssemblyName } from "../init-new.js";

describe("toDotNetAssemblyName", () => {
  it.each([
    ["todo-app", "TodoApp"],
    ["my-cool-svc", "MyCoolSvc"],
    ["my_cool-svc", "MyCoolSvc"],
    ["project1", "Project1"],
    ["a", "A"],
    ["one-two-three-four", "OneTwoThreeFour"],
    ["UPPERCASE-only", "UppercaseOnly"],
  ])("'%s' → '%s'", (input, expected) => {
    expect(toDotNetAssemblyName(input)).toBe(expected);
  });

  it("matches PascalCase shape", () => {
    expect(toDotNetAssemblyName("any-name")).toMatch(/^[A-Z][a-zA-Z0-9]*$/);
  });
});
