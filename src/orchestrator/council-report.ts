import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CouncilMemoryRecord } from "../council/types.js";
import { isLinkFreeBelow } from "../utils/link-free-path.js";
import { verdictFindings } from "../workflow/review-findings.js";
import { extractStructuredVerdict } from "../workflow/verdict-schema.js";
import type { StoredDelegation } from "./delegations.js";

export interface CouncilReportManifest {
  version: 1;
  jobId: string;
  files: Array<{ name: string; digest: string; bytes: number }>;
}
export interface CouncilReportReference {
  digest: string;
  files: string[];
}
const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
export const councilReportDirectory = (jobPath: string) => jobPath.replace(/\.json$/, ".review");

/** Host packages claims and actual captures separately; no model-controlled paths. */
export function writeCouncilReport(
  jobPath: string,
  record: StoredDelegation,
  synthesis: string,
  verification?: string,
): CouncilReportReference {
  const directory = councilReportDirectory(jobPath);
  const parsed = extractStructuredVerdict(synthesis);
  const findings = parsed ? verdictFindings(parsed) : [];
  const files = new Map<string, string>();
  files.set(
    "README.md",
    [
      `# Council evidence dossier: ${record.id}`,
      "",
      ...(record.planRevalidation
        ? [
            "Independent CURRENT-plan verification. leader.md/findings.json retain HISTORICAL council advice; they are not a new council verdict.",
            "verification.md contains the fresh verifier result; inputs.json binds source council, current inputs and native verification proof.",
          ]
        : []),
      "Advice only. Main must read the findings, inspect referenced captures and independently adjudicate each claim.",
      "A plan risk is conditional, not a reproduced implementation failure. Reproduction instructions below have NOT been executed by this packaging step.",
      `Captured native tool calls: ${record.toolArtifacts?.length ?? 0}. Zero captures means there is no host tool execution proof.`,
      `Participant trace: ${record.councilTrace ? "captured from this council run" : "unavailable (legacy or incomplete run); do not infer role coverage"}.`,
      "",
      "- leader.md: final leader synthesis (model claims)",
      "- findings.json: claim IDs, blocking/advisory classification, references and closure conditions",
      "- participants.json: host-selected model/persona contributions and round archive (model claims)",
      "- reproduction.md: proposed independent checks; never auto-executed",
      "- inputs.json: exact dispatched brief and host input binding",
      "- evidence/manifest.json and evidence/*.json: actual host-captured calls and outputs",
      "- manifest.json: SHA-256 and byte size for every dossier file",
      "",
      'Use delegation_read({id,toolCallId:"report:findings.json",resultVersion,offset,maxChars}) for version-checked dossier pages.',
    ].join("\n"),
  );
  files.set("leader.md", synthesis);
  files.set("findings.json", JSON.stringify(findings, null, 2));
  files.set("participants.json", JSON.stringify(record.councilTrace ?? { unavailable: true }, null, 2));
  files.set(
    "inputs.json",
    JSON.stringify(
      {
        jobId: record.id,
        cwd: record.cwd,
        planReview: record.planReview,
        brief: record.council,
        ...(record.planRevalidation ? { revalidation: record.planRevalidation, hostReview: record.hostReview } : {}),
      },
      null,
      2,
    ),
  );
  if (verification !== undefined) files.set("verification.md", verification);
  files.set(
    "reproduction.md",
    [
      "# Proposed independent reproduction checks (NOT execution evidence)",
      "",
      ...findings.map(
        (f) =>
          `## ${f.id}: ${f.claim}\n\nEvidence kind: ${f.evidenceKind}\nPlan: ${f.planReference}\nClosure: ${f.closure}\n\n${f.reproduction.length ? f.reproduction.map((step, i) => `${i + 1}. ${step}`).join("\n") : "No reproduction supplied. Main must inspect the bound plan/source; do not invent a passing result."}`,
      ),
    ].join("\n"),
  );
  files.set("evidence/manifest.json", JSON.stringify(record.toolArtifacts ?? [], null, 2));
  for (const entry of record.toolArtifacts ?? []) {
    if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.fileName))
      throw new Error("Invalid council evidence filename.");
    const body = readFileSync(join(jobPath.replace(/\.json$/, ".tools"), entry.fileName), "utf8");
    if (hash(body) !== entry.digest || Buffer.byteLength(body) !== entry.bytes)
      throw new Error(`Council tool capture changed: ${entry.toolCallId}`);
    files.set(`evidence/${entry.fileName}`, body);
  }
  const manifest: CouncilReportManifest = { version: 1, jobId: record.id, files: [] };
  let total = 0;
  for (const [name, body] of files) {
    const bytes = Buffer.byteLength(body);
    total += bytes;
    if (total > 80 * 1024 * 1024) throw new Error("Council dossier exceeds 80MiB; no partial report accepted.");
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    // Anchored at the job directory: a linked ANCESTOR (macOS /var, Windows 8.3
    // temp) is not a redirection of the dossier; a link at/below .review is.
    if (!isLinkFreeBelow(dirname(jobPath), dirname(file))) throw new Error("Linked council dossier path refused.");
    writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
    manifest.files.push({ name, digest: hash(body), bytes });
  }
  const body = JSON.stringify(manifest, null, 2);
  writeFileSync(join(directory, "manifest.json"), body, { encoding: "utf8", flag: "wx" });
  return { digest: hash(body), files: [...files.keys(), "manifest.json"] };
}

/** Bound to the terminal result's digest; arbitrary paths and links are refused. */
export function readCouncilReport(jobPath: string, record: StoredDelegation, name: string): string {
  const reference = record.councilReport;
  if (!reference || !reference.files.includes(name))
    throw new Error("No owned council dossier file with this selector.");
  const directory = councilReportDirectory(jobPath);
  const manifestPath = join(directory, "manifest.json");
  if (!isLinkFreeBelow(dirname(jobPath), manifestPath)) throw new Error("Linked council dossier refused.");
  const body = readFileSync(manifestPath, "utf8");
  if (hash(body) !== reference.digest) throw new Error("Council dossier manifest digest mismatch.");
  const manifest = JSON.parse(body) as CouncilReportManifest;
  if (manifest.version !== 1 || manifest.jobId !== record.id) throw new Error("Council dossier ownership mismatch.");
  if (JSON.stringify(reference.files) !== JSON.stringify([...manifest.files.map((f) => f.name), "manifest.json"]))
    throw new Error("Council dossier file list no longer matches its bound manifest.");
  if (name === "manifest.json") return body;
  const entry = manifest.files.find((f) => f.name === name);
  if (!entry || !/^(?:[a-zA-Z-]+\.(?:json|md)|evidence\/(?:manifest|[a-f0-9]{64}-[a-f0-9]{64})\.json)$/.test(name))
    throw new Error("Invalid council dossier selector.");
  const file = join(directory, name);
  if (!isLinkFreeBelow(dirname(jobPath), file)) throw new Error("Linked council dossier file refused.");
  const content = readFileSync(file, "utf8");
  if (hash(content) !== entry.digest || Buffer.byteLength(content) !== entry.bytes)
    throw new Error(`Council dossier file changed: ${name}`);
  return content;
}

export function validateCouncilTrace(trace: CouncilMemoryRecord): void {
  if (Buffer.byteLength(JSON.stringify(trace)) > 16 * 1024 * 1024)
    throw new Error("Council participant trace exceeds 16MiB.");
}
