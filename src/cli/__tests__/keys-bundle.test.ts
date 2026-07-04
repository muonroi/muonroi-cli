import { describe, expect, test } from "vitest";
import { decryptBundle, encryptBundle } from "../keys-bundle.js";

describe("keys-bundle round-trip", () => {
  const sample = {
    providers: {
      deepseek: "sk-mock-deepseek-test-fixture-only",
      xai: "xai-mock-test-fixture-only",
    },
  };

  test("encrypts and decrypts back to identical payload", () => {
    const bundle = encryptBundle(sample, "correct-horse-battery");
    const restored = decryptBundle(bundle, "correct-horse-battery");
    expect(restored).toEqual(sample);
  });

  test("each encryption produces unique salt+iv+ct", () => {
    const a = encryptBundle(sample, "passphrase-aaa");
    const b = encryptBundle(sample, "passphrase-aaa");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test("wrong passphrase throws decryption error", () => {
    const bundle = encryptBundle(sample, "correct-passphrase");
    expect(() => decryptBundle(bundle, "wrong-passphrase")).toThrow(/Decryption failed/);
  });

  test("rejects passphrase shorter than 8 chars", () => {
    expect(() => encryptBundle(sample, "short")).toThrow(/at least 8/);
  });

  test("rejects unsupported bundle version", () => {
    const bundle = encryptBundle(sample, "passphrase-xyz");
    const tampered = { ...bundle, v: 2 as 1 };
    expect(() => decryptBundle(tampered, "passphrase-xyz")).toThrow(/Unsupported bundle version/);
  });

  test("tampered ciphertext fails auth", () => {
    const bundle = encryptBundle(sample, "passphrase-xyz");
    const tampered = { ...bundle, ct: Buffer.from("not-the-real-ciphertext-here").toString("base64") };
    expect(() => decryptBundle(tampered, "passphrase-xyz")).toThrow(/Decryption failed/);
  });
});
