/**
 * Durable-sink redaction: `~/.muonroi-cli/delegations/<projectId>/<id>.{json,md}`.
 *
 * `failDelegation` writes the caught failure text into BOTH artifacts — the job
 * record's `error` field and the rendered markdown's `**Error:**` line / body
 * fallback. A delegated run that dies on a provider 401 puts the key in that
 * string.
 *
 * Scope check matters as much as the redaction: `prompt` / `description` /
 * `output` are the delegation's functional payload (the record is read back by
 * `loadDelegation`, and the `.md` IS the deliverable), so this test also pins
 * that they are NOT scrubbed.
 *
 * Credentials are assembled AT RUNTIME so check-secrets.mjs stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeDelegation, failDelegation, loadDelegation, type StoredDelegation } from "../delegations.js";

function fakeProviderKey(): string {
  return ["sk", "proj"].join("-") + "-" + "d3l3g4t3" + "Y".repeat(26);
}

describe("failDelegation — the error text is redacted in both artifacts", () => {
  let tmpDir: string;
  let jobPath: string;
  let outputPath: string;

  function seedRecord(overrides: Partial<StoredDelegation> = {}): StoredDelegation {
    const record = {
      id: "brisk-amber-otter",
      agent: "explore",
      description: "Audit the provider adapters",
      prompt: "Read every file under src/providers and report the auth header each adapter sends.",
      cwd: tmpDir,
      status: "running",
      startedAt: "2026-09-23T00:00:00.000Z",
      outputPath,
      ...overrides,
    } as unknown as StoredDelegation;
    fs.writeFileSync(jobPath, JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-delegation-redact-"));
    jobPath = path.join(tmpDir, "brisk-amber-otter.json");
    outputPath = path.join(tmpDir, "brisk-amber-otter.md");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[delegations.test] temp dir cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  it("strips the key from the job JSON and the rendered markdown", async () => {
    const key = fakeProviderKey();
    seedRecord();

    await failDelegation(jobPath, `delegated run aborted: 401 Unauthorized (api key ${key})`);

    const persistedJson = fs.readFileSync(jobPath, "utf8");
    const persistedMd = fs.readFileSync(outputPath, "utf8");

    expect(persistedJson).not.toContain(key);
    expect(persistedMd).not.toContain(key);

    // The failure must still be diagnosable from either artifact.
    expect(persistedJson).toContain("delegated run aborted: 401 Unauthorized");
    expect(persistedMd).toContain("delegated run aborted: 401 Unauthorized");

    const reloaded = await loadDelegation(jobPath);
    expect(reloaded.status).toBe("error");
    expect(reloaded.error).toContain("[REDACTED_API_KEY]");
  });

  it("leaves the functional prompt and description untouched", async () => {
    seedRecord();

    await failDelegation(jobPath, "delegated run aborted: timeout");

    const reloaded = await loadDelegation(jobPath);
    // Scrubbing these would corrupt a delegation whose legitimate job was to
    // produce config or credential-adjacent output.
    expect(reloaded.prompt).toBe("Read every file under src/providers and report the auth header each adapter sends.");
    expect(reloaded.description).toBe("Audit the provider adapters");
  });

  it("does not scrub a SUCCESSFUL delegation's output — that is the deliverable", async () => {
    seedRecord();
    const deliverable = "Each adapter sends Authorization: Bearer <config.apiKey>; anthropic.ts sends x-api-key.";

    await completeDelegation(jobPath, deliverable);

    const persistedMd = fs.readFileSync(outputPath, "utf8");
    // The literal example text the delegation was asked to report back must
    // survive verbatim — over-redaction here would silently destroy the answer.
    expect(persistedMd).toContain("<config.apiKey>");
    expect(persistedMd).toContain("x-api-key");
    expect((await loadDelegation(jobPath)).status).toBe("complete");
  });
});
