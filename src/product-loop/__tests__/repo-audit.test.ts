import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { additionalPrefills, auditAsContextBlock, auditRepo, formatAuditSummary } from "../repo-audit.js";

async function makeFixture(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "audit-"));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  }
  return root;
}

describe("auditRepo", () => {
  let cwd: string;
  afterEach(async () => {
    if (cwd) await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("returns greenfield mode for empty cwd", async () => {
    cwd = await makeFixture({});
    const a = await auditRepo(cwd);
    expect(a.hasProject).toBe(false);
    expect(a.mode).toBe("greenfield");
    expect(formatAuditSummary(a)).toBeNull();
  });

  it("flags upgrade-existing when src+tests+README all present", async () => {
    cwd = await makeFixture({
      "README.md": "# My Project\n\nA cool tool.\n\n## Usage\n",
      "package.json": JSON.stringify({
        name: "my-tool",
        version: "0.1.0",
        description: "A cool tool",
        devDependencies: { vitest: "1.0.0" },
      }),
      "src/index.ts": "export const a = 1;",
      "src/foo.ts": "export const b = 2;",
      "src/bar.ts": "export const c = 3;",
      "tests/foo.test.ts": "test('x', () => {});",
      "vitest.config.ts": "export default {};",
    });
    const a = await auditRepo(cwd);
    expect(a.hasProject).toBe(true);
    expect(a.mode).toBe("upgrade-existing");
    expect(a.srcFileCount).toBeGreaterThanOrEqual(3);
    expect(a.testFileCount).toBeGreaterThanOrEqual(1);
    expect(a.testFramework).toBe("vitest");
    expect(a.hasCoverageConfig).toBe(true);
    expect(a.packageMeta?.name).toBe("my-tool");
    expect(a.readmeExcerpt).toContain("cool tool");
    expect(a.readmeSections).toContain("Usage");
  });

  it("classifies scratch-dir when only src exists without tests/docs", async () => {
    cwd = await makeFixture({
      "src/index.ts": "console.log('hi');",
    });
    const a = await auditRepo(cwd);
    expect(a.hasProject).toBe(true);
    expect(a.mode).toBe("scratch-dir");
  });

  it("additionalPrefills surfaces persona+core-features for upgrade-existing", async () => {
    cwd = await makeFixture({
      "README.md": "# X\n\nLib.\n",
      "package.json": JSON.stringify({ devDependencies: { vitest: "1.0.0" } }),
      "src/a.ts": "",
      "src/b.ts": "",
      "src/c.ts": "",
      "tests/a.test.ts": "",
      "vitest.config.ts": "",
      "docs/README.md": "",
    });
    const a = await auditRepo(cwd);
    const prefills = additionalPrefills(a);
    expect(prefills.get("persona")).toMatch(/developers/i);
    expect(prefills.get("core-features")).toMatch(/upgrade in place/i);
    expect(prefills.get("success-metric")).toMatch(/vitest/);
  });

  it("auditAsContextBlock includes pkg meta and recent-context fields", async () => {
    cwd = await makeFixture({
      "README.md": "# Foo\n\nReadme paragraph.\n",
      "package.json": JSON.stringify({ name: "foo", version: "1.2.3", description: "the foo" }),
      "src/a.ts": "",
    });
    const a = await auditRepo(cwd);
    const block = auditAsContextBlock(a);
    expect(block).toContain("Repository audit");
    expect(block).toContain("foo@1.2.3");
    expect(block).toContain("Readme paragraph");
  });

  it("auditAsContextBlock returns greenfield notice when no project", async () => {
    cwd = await makeFixture({});
    const a = await auditRepo(cwd);
    expect(auditAsContextBlock(a)).toMatch(/greenfield/i);
  });
});
