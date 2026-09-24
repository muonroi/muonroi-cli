/**
 * `stripControlBytes` (src/ui/use-app-logic.tsx) wrote its character classes with
 * RAW control bytes — the source file literally held 0x00, 0x1b, 0x1f and 0x7f.
 *
 * ## What that cost (measured 2026-09-24)
 *
 * One 0x00 byte in 386,085 makes ripgrep classify the whole file as BINARY and
 * drop its matches from any tree-wide search:
 *
 *     $ rg --files-with-matches setAskUserHandler src/
 *     src/orchestrator/orchestrator.ts
 *     $ rg -n setAskUserHandler src/ui/use-app-logic.tsx
 *     binary file matches (found "\0" byte around offset 16359)
 *
 * The tree-wide search looks authoritative and "proved" the `ask_user` handler
 * had no call site — while it is registered in that very file.
 *
 * ## What this file pins
 *
 * 1. The rewrite is a NO-OP on behaviour. `stripControlBytes` is the
 *    secret-sanitisation path for a pasted API key / master password, so an
 *    escape rewrite there is a security change until proven otherwise. The
 *    equivalence is checked EXHAUSTIVELY over every UTF-16 code unit
 *    (0x0000–0xFFFF — the complete domain of a non-`u` JS regex), for the
 *    membership test, for `.replace()`, and for the whole two-step function.
 * 2. The escaped literals asserted here are the exact text the source now
 *    carries, so the proof is about the shipped code and not about two regexes
 *    invented in this file.
 * 3. No source file under `src/` carries a 0x00 byte again — the property that
 *    decides whether a tree-wide `rg` can see it at all.
 *
 * The raw-byte forms below are rebuilt from code points with
 * `String.fromCharCode` rather than typed literally: a test that pasted a real
 * NUL in to describe the bug would hide ITSELF from the same search.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = fileURLToPath(new URL("../use-app-logic.tsx", import.meta.url));
const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const NUL = String.fromCharCode(0x00);
const ESC = String.fromCharCode(0x1b);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);

/** The class as it was written with raw bytes: `[<0x00>-<0x1f><0x7f>]`. */
const rawControlClass = (flags: string) => new RegExp(`[${NUL}-${UNIT_SEPARATOR}${DEL}]`, flags);
/** The class as it is written now, with escapes. Same text as the source. */
const escapedControlClass = (flags: string) => new RegExp("[\\x00-\\x1f\\x7f]", flags);

/** The bracketed-paste guard as it was written, with a raw ESC. */
const rawPasteGuard = (flags: string) => new RegExp(`${ESC}?\\[20[01]~`, flags);
/** The same guard written with `\x1b`. */
const escapedPasteGuard = (flags: string) => new RegExp("\\x1b?\\[20[01]~", flags);

/** `stripControlBytes` built out of the RAW-byte regexes (the old source). */
function stripWithRawBytes(raw: string): string {
  return raw.replace(rawPasteGuard("g"), "").replace(rawControlClass("g"), "");
}

/** `stripControlBytes` built out of the ESCAPED regexes (the new source). */
function stripWithEscapes(raw: string): string {
  return raw.replace(escapedPasteGuard("g"), "").replace(escapedControlClass("g"), "");
}

/** Every UTF-16 code unit — the complete input domain of a non-`u` JS regex. */
const ALL_CODE_UNITS = 0x1_0000;

describe("stripControlBytes — escaped classes are identical to the raw-byte ones", () => {
  it("matches the same code units (exhaustive over 0x0000-0xFFFF)", () => {
    const disagreements: string[] = [];
    const raw = rawControlClass("");
    const escaped = escapedControlClass("");
    for (let cu = 0; cu < ALL_CODE_UNITS; cu++) {
      const ch = String.fromCharCode(cu);
      if (raw.test(ch) !== escaped.test(ch)) {
        disagreements.push(`U+${cu.toString(16).padStart(4, "0")}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("covers exactly 0x00-0x1f plus 0x7f and nothing else", () => {
    const matched: number[] = [];
    const escaped = escapedControlClass("");
    for (let cu = 0; cu < ALL_CODE_UNITS; cu++) {
      if (escaped.test(String.fromCharCode(cu))) matched.push(cu);
    }
    const expected = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f];
    expect(matched).toEqual(expected);
  });

  it("replaces the same way for every code unit, in three positions", () => {
    const disagreements: string[] = [];
    for (let cu = 0; cu < ALL_CODE_UNITS; cu++) {
      const ch = String.fromCharCode(cu);
      for (const input of [ch, `a${ch}b`, `${ch}${ch}`, `pfx${ch}`, `${ch}sfx`]) {
        if (stripWithRawBytes(input) !== stripWithEscapes(input)) {
          disagreements.push(`U+${cu.toString(16).padStart(4, "0")} in ${JSON.stringify(input)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("strips the bracketed-paste guards identically, with and without the ESC", () => {
    const guards = [
      `${ESC}[200~`,
      `${ESC}[201~`,
      "[200~",
      "[201~",
      `${ESC}[202~`, // outside the class — must survive both
      `${ESC}[20`,
      `${ESC}`,
    ];
    for (const guard of guards) {
      for (const input of [guard, `sk-live-abc${guard}`, `${guard}sk-live-abc`, `a${guard}b${guard}c`]) {
        expect(stripWithEscapes(input)).toBe(stripWithRawBytes(input));
      }
    }
  });

  it("agrees on a real pasted secret wrapped in guards, per code unit", () => {
    const disagreements: string[] = [];
    for (let cu = 0; cu < ALL_CODE_UNITS; cu++) {
      const ch = String.fromCharCode(cu);
      const pasted = `${ESC}[200~sk-${ch}live-${ch}key${ESC}[201~\r\n`;
      if (stripWithRawBytes(pasted) !== stripWithEscapes(pasted)) {
        disagreements.push(`U+${cu.toString(16).padStart(4, "0")}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("keeps printable characters and spaces (a master password may contain them)", () => {
    const password = "hunter2 with spaces & sym!bols";
    expect(stripWithEscapes(password)).toBe(password);
    expect(stripWithEscapes(password)).toBe(stripWithRawBytes(password));
  });
});

describe("use-app-logic.tsx source hygiene", () => {
  it("writes both regexes with escapes, exactly as this test proves equivalent", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).toContain(String.raw`.replace(/\x1b?\[20[01]~/g, "")`);
    expect(source).toContain(String.raw`.replace(/[\x00-\x1f\x7f]/g, "")`);
  });

  it("carries no raw control byte at all (only TAB, LF, CR)", () => {
    const bytes = readFileSync(SOURCE_PATH);
    const offenders: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const allowed = b === 0x09 || b === 0x0a || b === 0x0d;
      if ((b < 0x20 && !allowed) || b === 0x7f) {
        offenders.push(`0x${b.toString(16).padStart(2, "0")} at offset ${i}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("no source file under src/ is invisible to a tree-wide ripgrep", () => {
  /**
   * 0x00 is the byte ripgrep uses to decide a file is binary, and a binary file
   * is SILENTLY dropped from a tree-wide search (it reports "binary file
   * matches" only when named directly). Write control bytes as escapes.
   */
  it("contains no 0x00 byte in any .ts/.tsx/.js/.jsx/.json file", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(?:tsx?|jsx?|mjs|cjs|json)$/.test(entry)) continue;
        const bytes = readFileSync(full);
        const at = bytes.indexOf(0x00);
        if (at >= 0) offenders.push(`${full} (offset ${at})`);
      }
    };
    walk(SRC_ROOT);
    expect(offenders).toEqual([]);
  });
});
