import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../__test-stubs__/cleanup";
import { addedLineNumbers, formatQualityWarnings, scanAddedSilentCatches } from "./empty-catch-scan.js";
import { editFile, writeFile } from "./file.js";
import { FileTracker } from "./file-tracker.js";

const scanNew = (file: string, content: string) => scanAddedSilentCatches(file, "", content);

describe("scanAddedSilentCatches — brace languages", () => {
  it.each([
    ["try { f(); } catch {}", "empty-catch"],
    ["try { f(); } catch (e) {}", "empty-catch"],
    ["try {\n  f();\n} catch (err: unknown) {\n  /* ignore */\n}", "empty-catch"],
    ["try { f(); } catch (e) {\n  // nothing to do\n}", "empty-catch"],
    ["p.catch(() => {});", "empty-promise-catch"],
    ["p.catch((_e) => undefined);", "empty-promise-catch"],
    ["p.catch(function () {});", "empty-promise-catch"],
  ])("flags %j", (code, kind) => {
    const w = scanNew("a.ts", `${code}\n`);
    expect(w).toHaveLength(1);
    expect(w[0]!.kind).toBe(kind);
    // The reported line is where the handler (`catch` / `.catch`) starts.
    expect(w[0]!.line).toBe(code.slice(0, code.indexOf("catch")).split("\n").length);
  });

  it.each([
    "try { f(); } catch (e) { console.error('[mod] f failed: ' + (e as Error).message); }",
    "try { f(); } catch (e) {\n  // optional cleanup — safe to ignore, but still logged\n  logger.debug('cleanup failed', { e });\n}",
    "try { f(); } catch { return null; }",
    "try { f(); } catch (e) { throw new Wrapped(e); }",
    "p.catch((e) => log.warn('x', e));",
    "p.catch(() => [] as string[]);",
    "// BAD example: catch {} swallows errors",
    'const doc = "never write catch {} in this repo";',
    " * catch {} — documented anti-pattern",
  ])("does not flag %j", (code) => {
    expect(scanNew("a.ts", `${code}\n`)).toEqual([]);
  });

  it("C# empty catch with a filter is flagged; Java with a body is not", () => {
    expect(scanNew("A.cs", "try { F(); } catch (Exception ex) when (ex is IOException) { }\n")).toHaveLength(1);
    expect(scanNew("A.java", 'try { f(); } catch (IOException e) { LOG.warn("f", e); }\n')).toEqual([]);
  });

  it("only reports handlers on ADDED lines (pre-existing empty catches are not re-flagged)", () => {
    const before = "try { a(); } catch {}\nconst x = 1;\n";
    const after = "try { a(); } catch {}\nconst x = 2;\ntry { b(); } catch (e) {}\n";
    const w = scanAddedSilentCatches("a.ts", before, after);
    expect(w.map((x) => x.line)).toEqual([3]);
  });

  it("unknown extensions are not scanned", () => {
    expect(scanNew("notes.md", "catch {}\n")).toEqual([]);
    expect(scanNew("a.go", "catch {}\n")).toEqual([]);
  });
});

describe("scanAddedSilentCatches — python", () => {
  it.each([
    "try:\n    f()\nexcept:\n    pass\n",
    "try:\n    f()\nexcept Exception:\n    pass\n",
    "try:\n    f()\nexcept ValueError: pass\n",
    "try:\n    f()\nexcept Exception as e:\n    # ignore\n    pass\n",
    "try:\n    f()\nexcept OSError:\n    ...\n",
  ])("flags %j", (code) => {
    const w = scanNew("m.py", code);
    expect(w).toHaveLength(1);
    expect(w[0]!.kind).toBe("except-pass");
    expect(w[0]!.line).toBe(3);
  });

  it.each([
    "try:\n    f()\nexcept Exception as e:\n    logger.warning('f failed: %s', e)\n",
    "try:\n    f()\nexcept Exception as e:\n    # optional probe; logged at debug\n    log.debug('probe failed', exc_info=e)\n    pass\n",
    "try:\n    f()\nexcept KeyError:\n    raise\n",
  ])("does not flag %j", (code) => {
    expect(scanNew("m.py", code)).toEqual([]);
  });
});

describe("addedLineNumbers", () => {
  it("numbers lines in the NEW content", () => {
    expect([...addedLineNumbers("a\nb\n", "a\nX\nb\nY\n")]).toEqual([2, 4]);
  });
});

describe("write_file / edit_file surface the warning", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "empty-catch-"));
  });
  afterEach(() => bestEffortRemoveSync(dir, "empty-catch-scan.test.ts"));

  it("write_file returns a structured warning and names file:line in the output", async () => {
    const res = await writeFile("svc.ts", "export function f() {\n  try { g(); } catch (e) {}\n}\n", dir);
    expect(res.success).toBe(true);
    expect(res.qualityWarnings).toEqual([
      { rule: "no-silent-catch", kind: "empty-catch", line: 2, snippet: "catch (e) {}" },
    ]);
    expect(res.output).toContain("svc.ts:2 empty-catch");
  });

  it("edit_file warns only for the handler it introduced", async () => {
    const tracker = new FileTracker();
    const path = join(dir, "svc.ts");
    const original = "try { a(); } catch {}\nconst v = 1;\n";
    writeFileSync(path, original);
    tracker.markRead(path, original, Date.now());
    const clean = await editFile(path, "const v = 1;", "const v = 2;", dir, tracker);
    expect(clean.success).toBe(true);
    expect(clean.qualityWarnings).toBeUndefined();

    const dirty = await editFile(path, "const v = 2;", "try { b(); } catch (e) {}", dir, tracker);
    expect(dirty.success).toBe(true);
    expect(dirty.qualityWarnings?.map((w) => w.line)).toEqual([2]);
  });

  it("formatQualityWarnings is empty when there is nothing to report", () => {
    expect(formatQualityWarnings("a.ts", [])).toBe("");
  });
});
