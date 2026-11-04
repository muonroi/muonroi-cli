import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads every public harness subpath as compiled JavaScript in plain Node", () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const specifiers = Object.keys(pkg.exports).map((key) => (key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`));
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    const results = [];
    for (const name of ${JSON.stringify(specifiers)}) {
      try {
        const resolved = import.meta.resolve(name);
        await import(name);
        results.push({ name, compiled: resolved.endsWith('.js') && resolved.includes('/dist/node/') });
      } catch (error) {
        results.push({ name, error: error.message });
      }
    }
    console.log(JSON.stringify(results));
  `,
    ],
    { cwd, encoding: "utf8", timeout: 15000 },
  );
  expect(child.status, child.stderr).toBe(0);
  const results = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
  expect(results.filter((r: { compiled?: boolean }) => !r.compiled)).toEqual([]);
  expect(results).toHaveLength(specifiers.length);
});
