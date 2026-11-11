import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { councilReportDirectory, readCouncilReport } from "../council-report.js";
import { completeDelegation, loadDelegation, type StoredDelegation, saveDelegationToolResult } from "../delegations.js";

let dir: string, job: string;
const synthesis =
  '```council-verdict\n{"verdict":"revise","concerns":["Validate the raw path before canonicalization"],"evidence":["PLAN.md section 4"]}\n```';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "council-dossier-"));
  job = join(dir, "fixture.json");
  const record: StoredDelegation = {
    id: "fixture",
    agent: "council",
    kind: "council",
    status: "running",
    model: "fixture-model",
    description: "Plan review",
    prompt: "",
    cwd: dir,
    sandboxMode: "off",
    maxToolRounds: 3,
    maxTokens: 2000,
    startedAt: new Date().toISOString(),
    outputPath: join(dir, "fixture.md"),
    parentSessionId: "owner",
    council: {
      topic: "Review bound plan",
      reason: "Admission",
      context: "Read only",
      outputContract: "structured verdict",
    },
  };
  writeFileSync(job, JSON.stringify(record));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe("host council evidence dossiers", () => {
  it("packages the leader, findings, missing-role disclosure and actual capture separately", async () => {
    await saveDelegationToolResult(job, "raw-path", "read_file", { path: "PLAN.md" }, "exact plan excerpt", {
      modelId: "fixture-model",
      phase: "debate",
    });
    await completeDelegation(job, synthesis);
    const record = await loadDelegation(job);
    expect(record.councilReport).toBeDefined();
    expect(readCouncilReport(job, record, "leader.md")).toBe(synthesis);
    expect(JSON.parse(readCouncilReport(job, record, "findings.json"))[0]).toMatchObject({
      id: expect.stringMatching(/^legacy-/),
      severity: "blocking",
      evidenceKind: "plan-risk",
    });
    expect(readCouncilReport(job, record, "README.md")).toContain("Captured native tool calls: 1");
    expect(JSON.parse(readCouncilReport(job, record, "participants.json"))).toEqual({ unavailable: true });
    const capture = record.councilReport!.files.find(
      (f) => f.startsWith("evidence/") && f !== "evidence/manifest.json",
    )!;
    expect(JSON.parse(readCouncilReport(job, record, capture))).toMatchObject({
      toolCallId: "raw-path",
      output: "exact plan excerpt",
      provenance: { phase: "debate" },
    });
    expect(readFileSync(record.outputPath, "utf8")).toContain(
      `**Council dossier digest:** ${record.councilReport!.digest}`,
    );
    writeFileSync(join(councilReportDirectory(job), "findings.json"), "[]");
    expect(() => readCouncilReport(job, record, "findings.json")).toThrow("changed");
  });
  it("discloses zero captures and refuses path traversal or a replaced manifest", async () => {
    await completeDelegation(job, synthesis);
    const record = await loadDelegation(job);
    expect(readCouncilReport(job, record, "README.md")).toContain(
      "Zero captures means there is no host tool execution proof",
    );
    expect(() => readCouncilReport(job, record, "../fixture.json")).toThrow("No owned");
    writeFileSync(join(councilReportDirectory(job), "manifest.json"), "{}");
    expect(() => readCouncilReport(job, record, "leader.md")).toThrow("digest mismatch");
  });
  it("refuses a narrowed host file list instead of silently omitting tampered evidence", async () => {
    await completeDelegation(job, synthesis);
    const record = await loadDelegation(job);
    record.councilReport!.files = record.councilReport!.files.filter((f) => f !== "participants.json");
    expect(() => readCouncilReport(job, record, "findings.json")).toThrow("file list");
  });
  // CI run 42131417821: every dossier on macOS was refused because tmpdir()
  // (/var/...) sits under a link (/private/var/...). A linked ANCESTOR must not
  // count; a linked dossier directory still must.
  const linkDir = (target: string, link: string) =>
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  it("writes and reads a dossier whose job directory is reached through a linked ancestor", async () => {
    const outer = mkdtempSync(join(tmpdir(), "council-dossier-link-"));
    try {
      linkDir(dir, join(outer, "alias"));
      const linkedJob = join(outer, "alias", "fixture.json");
      await saveDelegationToolResult(linkedJob, "raw-path", "read_file", { path: "PLAN.md" }, "exact plan excerpt");
      await completeDelegation(linkedJob, synthesis);
      const record = await loadDelegation(linkedJob);
      expect(readCouncilReport(linkedJob, record, "leader.md")).toBe(synthesis);
      const capture = record.councilReport!.files.find(
        (f) => f.startsWith("evidence/") && f !== "evidence/manifest.json",
      )!;
      expect(JSON.parse(readCouncilReport(linkedJob, record, capture))).toMatchObject({ toolCallId: "raw-path" });
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
  it("still refuses a dossier directory that is itself a link", async () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    linkDir(elsewhere, councilReportDirectory(job));
    await expect(completeDelegation(job, synthesis)).rejects.toThrow("Linked council dossier path refused.");
  });
});
