/**
 * src/lsp/client-normalize.test.ts
 *
 * Regression guard for the Windows diagnostics-cache key mismatch: the LSP
 * client stores publishDiagnostics under normalizeUriPath(uri) (a LOWERCASE
 * drive, decoded from `file:///c%3A/…`) but retrieves under
 * normalizeFsPath(path.resolve(...)) (the cwd's UPPERCASE drive). Without
 * canonicalizing the drive letter the keys never matched, so diagnostics were
 * permanently [] on Windows — silently breaking write-time LSP feedback AND the
 * commit gate. normalizeFsPath must produce the SAME key for both casings.
 */

import { describe, expect, it } from "vitest";
import { normalizeFsPath } from "./client.js";

describe("normalizeFsPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeFsPath("C:\\Users\\x\\bug.ts")).toBe("c:/Users/x/bug.ts");
  });

  it("lowercases the Windows drive letter so store/retrieve keys converge", () => {
    // The whole point: an UPPERCASE-drive query path and a LOWERCASE-drive
    // publishDiagnostics URI path must normalize to the identical cache key.
    expect(normalizeFsPath("C:/Users/x/bug.ts")).toBe(normalizeFsPath("c:/Users/x/bug.ts"));
    expect(normalizeFsPath("C:/Users/x/bug.ts")).toBe("c:/Users/x/bug.ts");
    expect(normalizeFsPath("D:\\proj\\a.ts")).toBe("d:/proj/a.ts");
  });

  it("leaves POSIX absolute paths untouched (no drive letter)", () => {
    expect(normalizeFsPath("/home/u/bug.ts")).toBe("/home/u/bug.ts");
  });

  it("does not mangle a non-drive leading segment", () => {
    // Only a single leading letter + ":/" is a drive; a path segment that
    // merely starts with a letter must be preserved.
    expect(normalizeFsPath("src/lsp/client.ts")).toBe("src/lsp/client.ts");
  });
});
