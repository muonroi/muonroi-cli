import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  htmlToText,
  MAX_PROBE_BYTES,
  normalizeForCompare,
  renderFidelityEvidence,
  runFidelityProbe,
  samplePassages,
} from "../fidelity-probe.js";

const SOURCE = `<html><head><title>x</title><style>p{}</style></head><body>
<h1>Tenant isolation guide</h1>
<p>The tenant_id column identifies every tenant row across all of the services in the platform.</p>
<p>Use the <code>List&lt;Tenant&gt;</code> type when you enumerate tenants from the repository layer.</p>
<table><tr><td>Header value one for the table</td><td>Header value two for the table</td></tr></table>
<p>Always pass the cancellation token through every asynchronous call you make in handlers.</p>
</body></html>`;

const CLEAN_MD = `# Tenant isolation guide

The tenant_id column identifies every tenant row across all of the services in the platform.

Use the \`List<Tenant>\` type when you enumerate tenants from the repository layer.

| Header value one for the table | Header value two for the table |
| --- | --- |

Always pass the cancellation token through every asynchronous call you make in handlers.
`;

const DIRTY_MD = `# Tenant isolation guide

The tenant\\_id column identifies every tenant row across all of the services in the platform.

Use the \`List&lt;Tenant&gt;\` type when you enumerate tenants from the repository layer.

\`\`\`csharp
var x = new List&lt;Tenant&gt;();
\`\`\`

Always pass the cancellation token through every asynchronous call you make in handlers.
`;

const dirs: string[] = [];
function fixture(source: string, out: string): { cwd: string; src: string; out: string } {
  const cwd = mkdtempSync(join(tmpdir(), "fidelity-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "doc.html"), source);
  writeFileSync(join(cwd, "out.md"), out);
  return { cwd, src: join(cwd, "doc.html"), out: join(cwd, "out.md") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fidelity probe helpers", () => {
  it("strips markup, scripts and decodes entities", () => {
    const text = htmlToText("<style>x{}</style><p>a &lt;b&gt; &amp; c</p><script>evil()</script><p>d</p>");
    expect(text).toContain("a <b> & c");
    expect(text).not.toContain("evil");
  });

  it("normalizes markdown escapes and markup away", () => {
    expect(normalizeForCompare("The **tenant\\_id** [link](http://x) `a`")).toBe("the tenant id link a");
  });

  it("samples deterministically and capped", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `this is paragraph number ${i} with enough words`).join("\n");
    const a = samplePassages(lines);
    expect(a).toHaveLength(25);
    expect(samplePassages(lines)).toEqual(a);
  });
});

describe("runFidelityProbe", () => {
  it("passes a faithful conversion", () => {
    const f = fixture(SOURCE, CLEAN_MD);
    const r = runFidelityProbe(f.src, [f.out], f.cwd);
    expect(r.failures).toEqual([]);
    expect(r.sampled).toBeGreaterThanOrEqual(4);
    expect(r.found).toBe(r.sampled);
    expect(renderFidelityEvidence(r)).toContain("fidelity probe: pass");
  });

  it("flags \\_ and &lt;/&gt; residue, counting those inside code and quoting examples", () => {
    const f = fixture(SOURCE, DIRTY_MD);
    const r = runFidelityProbe(f.src, [f.out], f.cwd);
    const kinds = r.residue.map((x) => x.kind);
    expect(kinds).toContain("\\_");
    expect(kinds).toContain("&lt;");
    expect(kinds).toContain("&gt;");
    const lt = r.residue.find((x) => x.kind === "&lt;")!;
    expect(lt.outputCount).toBe(2);
    expect(lt.sourceCount).toBe(0);
    expect(lt.inCode).toBe(2);
    expect(r.failures.length).toBeGreaterThanOrEqual(3);
    expect(renderFidelityEvidence(r)).toContain("fidelity probe: FAIL");
    expect(renderFidelityEvidence(r)).toContain("tenant");
  });

  it("does not flag an escape the source text itself contains", () => {
    const src = "<p>Write the path as C:\\_tmp and keep it exactly like that in the output text please.</p>";
    const f = fixture(src, "Write the path as C:\\_tmp and keep it exactly like that in the output text please.\n");
    const r = runFidelityProbe(f.src, [f.out], f.cwd);
    expect(r.residue).toEqual([]);
    expect(r.failures).toEqual([]);
  });

  it("fails when the output drops most of the source", () => {
    const f = fixture(SOURCE, "# Tenant isolation guide\n\nSomething unrelated entirely.\n");
    const r = runFidelityProbe(f.src, [f.out], f.cwd);
    expect(r.found).toBeLessThan(r.sampled);
    expect(r.failures.join("\n")).toMatch(/sampled source passages appear/);
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it("skips (no verdict) when an input is over the size cap or missing", () => {
    const f = fixture(SOURCE, CLEAN_MD);
    const big = join(f.cwd, "big.md");
    writeFileSync(big, "x".repeat(MAX_PROBE_BYTES + 1));
    const r = runFidelityProbe(f.src, [big], f.cwd);
    expect(r.skipped).toMatch(/probe cap/);
    expect(r.failures).toEqual([]);
    expect(runFidelityProbe(f.src, [join(f.cwd, "nope.md")], f.cwd).skipped).toMatch(/does not exist/);
  });
});
