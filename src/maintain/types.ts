/**
 * types.ts — Mode C (Maintain) data model.
 * P14: MaintenanceTask + CodebaseIntel shapes.
 * No runtime logic here — pure type declarations.
 */

export type MaintenanceTaskKind = "bug" | "feature" | "refactor" | "chore" | "docs";

export interface MaintenanceTask {
  id: string; // ULID via crypto.randomUUID()
  kind: MaintenanceTaskKind;
  title: string; // 1-line summary
  description: string; // user's verbatim prompt + parsed details
  reproSteps?: string;
  expectedBehavior?: string;
  observedBehavior?: string;
  acceptance_criteria: string[]; // 1-3 assertions
  candidateFiles: string[]; // from P14 — populated post-intel
  impactRadius: string[];
  regressionTestFiles: string[];
  status: "queued" | "in_progress" | "blocked" | "done" | "abandoned";
  pr?: {
    branch: string;
    diff: string;
    title: string;
    body: string;
    createdViaGh?: boolean;
    url?: string;
  };
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface CandidateFile {
  path: string; // workspace-relative
  reason: string; // why we picked it
  matchScore: number; // 0-1
}

export interface CodebaseIntel {
  cwd: string;
  repoMap: string; // truncated to ~2KB
  repoMapSource: "existing" | "generated"; // tracks D4 decision
  candidateFiles: CandidateFile[]; // top 5, sorted desc by matchScore
  impactRadius: string[]; // files that import any candidate
  regressionTests: string[]; // existing test files referencing candidates
  detectedFrameworks: string[]; // ["dotnet", "next", "react", "python", "rust", ...]
  capturedAtUtc: string;
}
