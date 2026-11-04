import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

describe("native file context controls", () => {
  it("bounds a single excerpt, continues at the named line, previews, and rejects a stale application", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "native-file-context-"));
    const bash = new BashTool(cwd);
    const file = join(cwd, "fixture.txt");
    const before = Array.from({ length: 1000 }, (_, i) => `row ${i + 1}: ${"x".repeat(80)}`).join("\n");
    writeFileSync(file, before);
    try {
      const tools = createBuiltinTools(bash, "agent");
      const excerpt = String(
        await tools.read_file.execute!({ file_path: "fixture.txt", max_chars: 2048 }, {} as never),
      );
      expect(excerpt.length).toBeLessThanOrEqual(2048);
      expect(excerpt).toContain("Unreturned lines");
      expect(excerpt).not.toContain("full output in transcript");
      const next = Number(excerpt.match(/Unreturned lines (\d+)-/)![1]);
      const continuation = String(
        await tools.read_file.execute!({ file_path: "fixture.txt", start_line: next, end_line: next }, {} as never),
      );
      expect(continuation).toContain(`row ${next}:`);
      const preview = (await tools.edit_file.execute!(
        { file_path: "fixture.txt", old_string: "row 1:", new_string: "updated:", dry_run: true },
        {} as never,
      )) as any;
      expect(preview).toMatchObject({ success: true, preview: true });
      expect(preview.diff.patch).toContain("+updated:");
      expect(readFileSync(file, "utf8")).toBe(before);
      writeFileSync(file, "external update");
      const stale = (await tools.edit_file.execute!(
        { file_path: "fixture.txt", old_string: "external", new_string: "changed" },
        {} as never,
      )) as any;
      expect(stale.success).toBe(false);
      expect(stale.output).toContain("changed on disk");
      const tiny = String(await tools.read_file.execute!({ file_path: "fixture.txt", max_chars: 256 }, {} as never));
      expect(tiny).not.toContain("external update");
    } finally {
      await bash.cleanup();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
