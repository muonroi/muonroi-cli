/**
 * Durable-sink redaction: the three sprint audit records under
 * `.muonroi-flow/runs/<runId>/sprints/`.
 *
 * Each carries one field copied verbatim off a caught exception —
 * `errorMessage`, populated by sprint-runner / item-debate-runner from
 * `err.message`. Sprint failures are `dotnet restore` / npm / test-runner
 * failures, and a restore error routinely quotes the private feed URL it
 * authenticated against. Unlike `~/.muonroi-cli`, these files live in the
 * PROJECT tree, so they are far more likely to be committed or shared.
 *
 * Reads the persisted JSON back off disk. Credentials are assembled AT RUNTIME
 * so `.husky/pre-commit`'s check-secrets.mjs stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SprintAdherenceRecord,
  type SprintItemDebateRecord,
  type SprintVerifyFixRecord,
  sprintAdherencePath,
  sprintItemDebatePath,
  sprintVerifyFixPath,
  writeSprintAdherence,
  writeSprintItemDebate,
  writeSprintVerifyFix,
} from "../run-artifacts.js";

function fakeFeedUrlWithKey(): string {
  // A NuGet/npm private-feed URL of the shape a restore failure echoes back.
  return `https://pkgs.example.com/v3/index.json (Authorization: Bearer ${"f33dt0ken" + "M".repeat(24)})`;
}

const RUN_ID = "run-redact-1";

describe("sprint audit records — errorMessage is redacted, review content is not", () => {
  let tmpDir: string;
  let flowDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-runartifacts-redact-"));
    flowDir = path.join(tmpDir, ".muonroi-flow");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      console.error(`[run-artifacts.test] temp dir cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  it("writeSprintAdherence redacts errorMessage but keeps residualDeviations", async () => {
    const secretish = fakeFeedUrlWithKey();
    const record: SprintAdherenceRecord = {
      version: 1,
      sprintN: 3,
      runId: RUN_ID,
      enabled: true,
      rounds: [],
      finalVerdict: false,
      residualDeviations: ["Task 2 shipped without the Semantic wrapper the plan required"],
      stopReason: "error",
      startedAt: "2026-09-23T00:00:00.000Z",
      finishedAt: "2026-09-23T00:01:00.000Z",
      errorMessage: `restore failed: ${secretish}`,
    };

    expect(await writeSprintAdherence(flowDir, RUN_ID, record)).toBe(true);

    const persisted = fs.readFileSync(sprintAdherencePath(flowDir, RUN_ID, 3), "utf8");
    expect(persisted).not.toContain("f33dt0ken");
    const parsed = JSON.parse(persisted) as SprintAdherenceRecord;
    expect(parsed.errorMessage).toContain("restore failed:");
    expect(parsed.errorMessage).toContain("pkgs.example.com/v3/index.json");
    // Model-authored review content is functional input for later stages.
    expect(parsed.residualDeviations).toEqual(["Task 2 shipped without the Semantic wrapper the plan required"]);
    expect(parsed.stopReason).toBe("error");
  });

  it("writeSprintVerifyFix redacts errorMessage", async () => {
    const record: SprintVerifyFixRecord = {
      version: 1,
      sprintN: 4,
      runId: RUN_ID,
      enabled: true,
      triggered: true,
      rounds: [],
      stopReason: "error",
      startedAt: "2026-09-23T00:00:00.000Z",
      finishedAt: "2026-09-23T00:02:00.000Z",
      errorMessage: `verify threw: ${fakeFeedUrlWithKey()}`,
    } as SprintVerifyFixRecord;

    expect(await writeSprintVerifyFix(flowDir, RUN_ID, record)).toBe(true);

    const parsed = JSON.parse(
      fs.readFileSync(sprintVerifyFixPath(flowDir, RUN_ID, 4), "utf8"),
    ) as SprintVerifyFixRecord;
    expect(parsed.errorMessage).not.toContain("f33dt0ken");
    expect(parsed.errorMessage).toContain("verify threw:");
  });

  it("writeSprintItemDebate redacts errorMessage and leaves the record otherwise intact", async () => {
    const record: SprintItemDebateRecord = {
      version: 1,
      sprintN: 5,
      runId: RUN_ID,
      enabled: true,
      items: [],
      stopReason: "error",
      startedAt: "2026-09-23T00:00:00.000Z",
      finishedAt: "2026-09-23T00:03:00.000Z",
      errorMessage: `item debate threw: ${fakeFeedUrlWithKey()}`,
    } as SprintItemDebateRecord;

    expect(await writeSprintItemDebate(flowDir, RUN_ID, record)).toBe(true);

    const parsed = JSON.parse(
      fs.readFileSync(sprintItemDebatePath(flowDir, RUN_ID, 5), "utf8"),
    ) as SprintItemDebateRecord;
    expect(parsed.errorMessage).not.toContain("f33dt0ken");
    expect(parsed.errorMessage).toContain("item debate threw:");
    expect(parsed.sprintN).toBe(5);
    expect(parsed.enabled).toBe(true);
  });

  it("a record with no errorMessage round-trips byte-identically", async () => {
    const record: SprintAdherenceRecord = {
      version: 1,
      sprintN: 6,
      runId: RUN_ID,
      enabled: false,
      rounds: [],
      finalVerdict: true,
      residualDeviations: [],
      stopReason: "disabled",
      startedAt: "2026-09-23T00:00:00.000Z",
      finishedAt: "2026-09-23T00:00:01.000Z",
    } as SprintAdherenceRecord;

    await writeSprintAdherence(flowDir, RUN_ID, record);

    const parsed = JSON.parse(fs.readFileSync(sprintAdherencePath(flowDir, RUN_ID, 6), "utf8"));
    expect(parsed).toEqual(record);
    expect("errorMessage" in parsed).toBe(false);
  });
});
