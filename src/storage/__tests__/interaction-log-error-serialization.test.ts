/**
 * logInteraction bypasses src/utils/logger.ts entirely — it JSON.stringifies
 * `metadata.data` straight into the `interaction_logs.metadata_json` column.
 * That is the same defect class the logger fix closes: `message`/`stack` are
 * non-enumerable on a real Error, so a raw Error nested in `data` used to
 * persist as `{}`, discarding the cause from a DB forensics query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const prepareMock = vi.fn(() => ({ run: runMock }));

vi.mock("../db.js", () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
}));

import { logInteraction } from "../interaction-log.js";

describe("logInteraction — error serialization", () => {
  beforeEach(() => {
    runMock.mockClear();
    prepareMock.mockClear();
  });

  it("persists an Error nested in data.error with message + stack, not '{}'", () => {
    logInteraction("sess-1", "error", {
      eventSubtype: "test_failure",
      data: { error: new Error("db write failed"), op: "insert" },
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    const args = runMock.mock.calls[0];
    // metadata_json is the 8th bound param (0-indexed 7) per the INSERT column list.
    const metadataJson = args[7] as string;
    expect(metadataJson).not.toBe('{"error":{}}');
    const parsed = JSON.parse(metadataJson) as { error: { message: string; stack?: string[] }; op: string };
    expect(parsed.error.message).toBe("db write failed");
    expect(Array.isArray(parsed.error.stack)).toBe(true);
    expect(parsed.op).toBe("insert");
  });

  it("leaves non-Error data untouched", () => {
    logInteraction("sess-2", "routing", { data: { path: "hot-path", complexity: "low" } });
    const metadataJson = runMock.mock.calls[0][7] as string;
    expect(JSON.parse(metadataJson)).toEqual({ path: "hot-path", complexity: "low" });
  });

  // Scope note (deliberately NOT fixed here — see PR discussion): logInteraction
  // has NEVER redacted plain string `data` fields, before or after this change.
  // Only the Error branch added by this fix is redacted. A caller that passes a
  // raw secret as a plain string (not inside an Error) still persists it
  // verbatim today. Pinned so this gap stays visible rather than silently
  // assumed-fixed by the Error-redaction work above.
  it("does NOT redact a secret-shaped plain string — pre-existing, out of scope for this fix", () => {
    const fakeKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
    logInteraction("sess-5", "error", { data: { note: `leaked key: ${fakeKey}` } });
    const metadataJson = runMock.mock.calls[0][7] as string;
    expect(metadataJson).toContain(fakeKey);
  });

  // Security follow-up (post-review): serializeError alone is UNREDACTED —
  // routing a raw Error straight into JSON.stringify(data) would persist a
  // secret embedded in its message/stack/own-properties verbatim to
  // ~/.muonroi-cli/muonroi.db. logInteraction must go through the redacted
  // form (serializeErrorRedacted), not serializeError.
  describe("secret redaction", () => {
    it("redacts an sk- key, a bearer token, and an Authorization header embedded in message/stack", () => {
      const fakeKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
      const fakeToken = `eyJhbGciOiJIUzI1NiJ9${".fakepayload.fakesignature1234567890"}`;
      const err = new Error(`auth failed with key ${fakeKey} — Authorization: Bearer ${fakeToken}`);
      err.stack = `Error: auth failed with key ${fakeKey}\n    at doAuth (Authorization: Bearer ${fakeToken})`;

      logInteraction("sess-3", "error", { data: { error: err } });

      const metadataJson = runMock.mock.calls[0][7] as string;
      expect(metadataJson).not.toContain(fakeKey);
      expect(metadataJson).not.toContain(fakeToken);
      const parsed = JSON.parse(metadataJson) as { error: { message: string; stack: string[] } };
      expect(parsed.error.message).toContain("[REDACTED");
      expect(parsed.error.stack.join("\n")).toContain("[REDACTED");
    });

    it("redacts an Error subclass's token/apiKey/password own properties", () => {
      class SdkError extends Error {
        apiKey: string;
        constructor(message: string, apiKey: string) {
          super(message);
          this.name = "SdkError";
          this.apiKey = apiKey;
        }
      }
      const fakeKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
      const err = new SdkError("sdk call failed", fakeKey);

      logInteraction("sess-4", "error", { data: { error: err } });

      const metadataJson = runMock.mock.calls[0][7] as string;
      expect(metadataJson).not.toContain(fakeKey);
      const parsed = JSON.parse(metadataJson) as { error: { apiKey: string } };
      expect(parsed.error.apiKey).toBe("[REDACTED]");
    });
  });
});
