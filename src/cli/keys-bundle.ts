/**
 * Portable encrypted key bundle (Option B from UX redesign 2026-05-21).
 *
 * Goal: move all provider keys between devices via a single passphrase-encrypted
 * file. No Bitwarden, no cloud, no extra deps — just Node crypto.
 *
 * Format (JSON):
 *   { v:1, kdf:"scrypt", salt:hex, iv:hex, tag:hex, ct:base64 }
 *
 * Plaintext payload (JSON): { providers: { deepseek: "sk-...", siliconflow: "sf-..." } }
 *
 * Crypto:
 *   - scrypt(passphrase, salt, 32) → 256-bit key
 *   - aes-256-gcm, 12-byte iv, 16-byte tag
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface KeyBundleV1 {
  v: 1;
  kdf: "scrypt";
  salt: string; // hex
  iv: string; // hex
  tag: string; // hex
  ct: string; // base64 ciphertext
}

export interface BundlePayload {
  providers: Record<string, string>;
}

const SCRYPT_N = 1 << 15; // 32768 — moderate cost, ~50ms
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const IV_LEN = 12;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // Memory cost = 128 * N * r ≈ 33MB with these params; bump maxmem above
  // Node's 32MB default so scryptSync doesn't throw on Windows/Linux.
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

export function encryptBundle(payload: BundlePayload, passphrase: string): KeyBundleV1 {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters.");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: "scrypt",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ct: ct.toString("base64"),
  };
}

export function decryptBundle(bundle: KeyBundleV1, passphrase: string): BundlePayload {
  if (bundle.v !== 1) throw new Error(`Unsupported bundle version: ${bundle.v}`);
  if (bundle.kdf !== "scrypt") throw new Error(`Unsupported KDF: ${bundle.kdf}`);
  const salt = Buffer.from(bundle.salt, "hex");
  const iv = Buffer.from(bundle.iv, "hex");
  const tag = Buffer.from(bundle.tag, "hex");
  const ct = Buffer.from(bundle.ct, "base64");
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted bundle.");
  }
  const parsed = JSON.parse(pt.toString("utf8")) as BundlePayload;
  if (!parsed || typeof parsed !== "object" || !parsed.providers) {
    throw new Error("Invalid bundle payload shape.");
  }
  return parsed;
}
