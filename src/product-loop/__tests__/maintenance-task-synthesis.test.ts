/**
 * maintenance-task-synthesis.test.ts
 *
 * Heuristic synthesis used by runMaintain when no explicit task shape is given.
 * Replaces the previous hardcoded `kind: "bug"` and single default criterion
 * with idea-text-driven detection.
 */

import { describe, expect, it } from "vitest";
import { buildDefaultAcceptanceCriteria, detectMaintenanceKind } from "../index.js";

describe("detectMaintenanceKind", () => {
  it("detects bug from 'fix' / 'bug' / 'crash' keywords", () => {
    expect(detectMaintenanceKind("fix login crash on Safari")).toBe("bug");
    expect(detectMaintenanceKind("bug: token expires too early")).toBe("bug");
    expect(detectMaintenanceKind("auth flow is broken")).toBe("bug");
    expect(detectMaintenanceKind("hotfix the rate limiter")).toBe("bug");
  });

  it("detects refactor from refactor/rename/cleanup keywords", () => {
    expect(detectMaintenanceKind("refactor the auth module")).toBe("refactor");
    expect(detectMaintenanceKind("rename UserService to AccountService")).toBe("refactor");
    expect(detectMaintenanceKind("split the giant App.tsx file")).toBe("refactor");
    expect(detectMaintenanceKind("extract validation into a hook")).toBe("refactor");
  });

  it("detects docs from documentation keywords", () => {
    expect(detectMaintenanceKind("update the README")).toBe("docs");
    expect(detectMaintenanceKind("add jsdoc to public exports")).toBe("docs");
    expect(detectMaintenanceKind("write documentation for the API")).toBe("docs");
  });

  it("detects chore from upgrade/deps/lint keywords", () => {
    expect(detectMaintenanceKind("bump react to 19")).toBe("chore");
    expect(detectMaintenanceKind("upgrade dependencies")).toBe("chore");
    expect(detectMaintenanceKind("fix lint errors")).toBe("bug"); // 'fix' wins — that's the user intent
    expect(detectMaintenanceKind("run prettier across the repo")).toBe("feature"); // no keyword match → feature
  });

  it("falls back to feature for additive prompts", () => {
    expect(detectMaintenanceKind("add a dark mode toggle")).toBe("feature");
    expect(detectMaintenanceKind("implement OAuth login")).toBe("feature");
    expect(detectMaintenanceKind("support CSV export")).toBe("feature");
  });

  it("bug keyword takes precedence over additive language", () => {
    // 'fix' triggers bug even when prompt also says 'add'
    expect(detectMaintenanceKind("fix the bug where adding items crashes")).toBe("bug");
  });
});

describe("buildDefaultAcceptanceCriteria", () => {
  it("always includes 'verify recipe passes'", () => {
    const criteria = buildDefaultAcceptanceCriteria("anything goes");
    expect(criteria[0]).toBe("Existing verify recipe passes after edits");
  });

  it("adds test-coverage criterion when idea mentions tests", () => {
    const criteria = buildDefaultAcceptanceCriteria("add unit test for password hashing");
    expect(criteria).toContain("New behavior is covered by at least one test");
  });

  it("adds no-regression criterion when idea hints at preservation", () => {
    const criteria = buildDefaultAcceptanceCriteria("refactor without breaking existing API");
    expect(criteria).toContain("No regression in existing test suite");
  });

  it("adds error-path criterion when idea mentions error/exception/null", () => {
    const criteria = buildDefaultAcceptanceCriteria("crash when user input is null");
    expect(criteria).toContain("Error path is handled explicitly (no silent swallowing)");
  });

  it("returns only the baseline for a neutral prompt", () => {
    const criteria = buildDefaultAcceptanceCriteria("add a logout button");
    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toBe("Existing verify recipe passes after edits");
  });
});
