import { describe, expect, it } from "vitest";
import { parseRepoStructureHints } from "./repo-structure-hints.js";

describe("parseRepoStructureHints", () => {
  it("extracts checked-in line-count hints from REPO_DEEP_MAP markdown", () => {
    const hints = parseRepoStructureHints(
      "`src/ui/app.tsx` is the root TUI component (~6200 lines as of 2026-05-20, reduced from 9368).",
    );
    expect(hints).toEqual([{ path: "src/ui/app.tsx", lineCount: 6200 }]);
  });

  it("deduplicates repeated paths", () => {
    const hints = parseRepoStructureHints(
      [
        "`src/ui/app.tsx` is the root TUI component (~6200 lines as of 2026-05-20).",
        "`src/ui/app.tsx` is the root TUI component (~6200 lines as of 2026-05-20).",
      ].join("\n"),
    );
    expect(hints).toHaveLength(1);
  });
});
