/**
 * Durable-sink redaction: `.muonroi-flow/runs/<runId>/scaffold-checkpoint.json`.
 *
 * `errorMessage` is the caught scaffold failure copied verbatim. Scaffold
 * failures are `dotnet new` / `dotnet restore` / npm failures, and a restore
 * error routinely quotes the private feed URL it authenticated against — which
 * is where inline credentials live. This checkpoint sits in the PROJECT tree,
 * not under `~`, so it is far more likely to be committed or shared.
 *
 * The replayable `inputs` / `originalPrompt` must NOT be scrubbed: the retry path
 * replays them to re-run the scaffold.
 *
 * Credentials are assembled AT RUNTIME so `.husky/pre-commit`'s check-secrets.mjs
 * stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readScaffoldCheckpoint, type ScaffoldCheckpoint, writeScaffoldCheckpoint } from "../scaffold-checkpoint.js";

function fakeFeedCredential(): string {
  return "nugetfeed" + "P".repeat(24);
}

const RUN_ID = "run-scaffold-redact";

const INPUTS: ScaffoldCheckpoint["inputs"] = {
  projectName: "AcmePortal",
  feStack: "react",
  eePackages: ["Muonroi.BuildingBlock"],
};

describe("writeScaffoldCheckpoint — errorMessage is redacted, replay inputs are not", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-scaffoldckpt-redact-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch (err) {
      console.error(`[scaffold-checkpoint.test] temp dir cleanup failed for ${cwd}: ${(err as Error)?.message}`);
    }
  });

  it("strips a feed credential out of the persisted errorMessage", async () => {
    const cred = fakeFeedCredential();
    const filePath = await writeScaffoldCheckpoint(cwd, RUN_ID, {
      status: "error",
      errorMessage: `dotnet restore failed for https://pkgs.example.com/v3/index.json (Authorization: Bearer ${cred})`,
      originalPrompt: "build an internal portal",
      inputs: INPUTS,
    });

    const persisted = fs.readFileSync(filePath, "utf8");

    expect(persisted).not.toContain(cred);
    // The operator still needs to see WHICH command failed and against WHAT feed.
    expect(persisted).toContain("dotnet restore failed for");
    expect(persisted).toContain("pkgs.example.com/v3/index.json");

    const reloaded = await readScaffoldCheckpoint(cwd, RUN_ID);
    expect(reloaded?.status).toBe("error");
    expect(reloaded?.errorMessage).toContain("[REDACTED]");
  });

  it("leaves originalPrompt and inputs replayable", async () => {
    await writeScaffoldCheckpoint(cwd, RUN_ID, {
      status: "error",
      errorMessage: "BB template not installed",
      originalPrompt: "build an internal portal with SSO",
      inputs: INPUTS,
    });

    const reloaded = await readScaffoldCheckpoint(cwd, RUN_ID);
    // Scrubbing these would change what the retry actually builds.
    expect(reloaded?.originalPrompt).toBe("build an internal portal with SSO");
    expect(reloaded?.inputs).toEqual(INPUTS);
    expect(reloaded?.errorMessage).toBe("BB template not installed");
  });

  it("omits errorMessage entirely when the patch has none", async () => {
    await writeScaffoldCheckpoint(cwd, RUN_ID, {
      status: "submitted",
      originalPrompt: null,
      inputs: INPUTS,
    });

    const reloaded = await readScaffoldCheckpoint(cwd, RUN_ID);
    expect(reloaded?.status).toBe("submitted");
    expect(reloaded?.errorMessage).toBeUndefined();
  });
});
