import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import the module under test — will fail until src/utils/redactor.ts is created
import { redactor } from "./redactor";

describe("Redactor — Layer 1: static regex scrubbing", () => {
  it("Test 1: redacts sk-ant-* bearer token from string", () => {
    const input = "Bearer sk-ant-1234567890abcdefghij";
    const result = redactor.redact(input);
    expect(result).not.toContain("sk-ant-1234567890abcdefghij");
    expect(result).toContain("***REDACTED***");
  });

  it("Test 2: redacts JWT triple-segment shape from Authorization header", () => {
    const input = "Authorization: Bearer eyJabc.def.ghi";
    const result = redactor.redact(input);
    expect(result).not.toContain("eyJabc.def.ghi");
  });

  it("Test 3: redacts ANTHROPIC_API_KEY env var pattern", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-real-key-here-1234567890";
    const result = redactor.redact(input);
    expect(result).toContain("***REDACTED***");
    // Value should be gone; variable name may remain
    expect(result).not.toContain("sk-ant-real-key-here-1234567890");
  });
});

describe("Redactor — Layer 2: enrolled live values", () => {
  afterEach(() => {
    // Clear enrolled secrets between tests by creating a fresh state
    // The redactor is a singleton — we test idempotency elsewhere
  });

  it("Test 4: redacts enrolled live secret value", () => {
    redactor.enrollSecret("sk-customformat-abcdefghij");
    const result = redactor.redact("...sk-customformat-abcdefghij...");
    expect(result).not.toContain("sk-customformat-abcdefghij");
  });

  it("Test 5: does NOT redact short enrolled values (< 8 chars)", () => {
    redactor.enrollSecret("ab");
    const result = redactor.redact("absolute");
    // Short secret 'ab' must NOT cause 'absolute' to be redacted
    expect(result).toBe("absolute");
    expect(result).toContain("absolute");
  });
});

describe("Redactor — error redaction", () => {
  it("Test 6: redactError removes secrets from Error message and stack", () => {
    const err = new Error("Failed with key sk-ant-shouldredact1234567890");
    const result = redactor.redactError(err);
    expect(result).not.toContain("sk-ant-shouldredact1234567890");
  });
});

describe("Redactor — global patches", () => {
  it("Test 7: installGlobalPatches patches console.log to redact secrets", () => {
    const originalLog = console.log;
    const captured: string[] = [];

    // Patch console.log BEFORE installing global patches to capture output
    // We need to test AFTER patches are installed
    redactor.installGlobalPatches();

    // Spy on the patched console.log by replacing the already-patched version
    const patchedLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
      patchedLog.apply(console, args);
    };

    console.log("test sk-ant-1234567890abcdefghij");

    // Restore
    console.log = originalLog;
    redactor.uninstallGlobalPatches();

    // The captured string should have redacted the secret
    const output = captured.join(" ");
    expect(output).not.toContain("sk-ant-1234567890abcdefghij");
    expect(output).toContain("***REDACTED***");
  });
});

describe("Redactor — idempotency", () => {
  it("Test 8: enrolling the same secret twice produces identical redacted output", () => {
    const secret = "sk-ant-idempotent-test-abcdefghijklm";
    redactor.enrollSecret(secret);
    redactor.enrollSecret(secret); // enroll same value again

    const result1 = redactor.redact(`key is ${secret}`);
    // Enroll again for safety
    redactor.enrollSecret(secret);
    const result2 = redactor.redact(`key is ${secret}`);

    expect(result1).toBe(result2);
    expect(result1).not.toContain(secret);
  });
});
