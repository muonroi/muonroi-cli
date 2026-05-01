/**
 * src/utils/redactor.ts
 *
 * Process-wide log redactor singleton.
 * Mitigates Pitfall 2 (HIGH severity API key leakage).
 *
 * Two-layer scrubbing strategy:
 *   Layer 1 — Static regex patterns for known secret shapes (sk-*, JWT, Bearer, env vars)
 *   Layer 2 — Enrolled live values registered at runtime (>=8 chars) via enrollSecret()
 *
 * Usage:
 *   import { redactor } from "./utils/redactor.js";
 *   redactor.installGlobalPatches(); // call FIRST at process boot
 *   redactor.enrollSecret(loadedApiKey); // call immediately after key load
 */

// ---------------------------------------------------------------------------
// Static regex patterns for Layer 1 scrubbing
// ---------------------------------------------------------------------------

const STATIC_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Anthropic sk-ant-* keys (most specific — checked first)
  {
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: "sk-ant-***REDACTED***",
  },
  // General sk-* keys (OpenAI and other providers)
  {
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    replacement: "sk-***REDACTED***",
  },
  // JWT triple-segment shape  eyJ<base64url>.<base64url>.<base64url>
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "***REDACTED-JWT***",
  },
  // Environment variable assignments for common API keys
  {
    pattern: /(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY)\s*=\s*\S+/g,
    replacement: "$1=***REDACTED***",
  },
  // Authorization Bearer header
  {
    pattern: /Authorization:\s*Bearer\s+\S+/gi,
    replacement: "Authorization: Bearer ***REDACTED***",
  },
  // x-api-key header (case-insensitive)
  {
    pattern: /[Xx]-[Aa]pi-[Kk]ey:\s*\S+/g,
    replacement: "x-api-key: ***REDACTED***",
  },
];

// ---------------------------------------------------------------------------
// Redactor class
// ---------------------------------------------------------------------------

class Redactor {
  /** Set of enrolled live secret values (length >= 8). */
  private enrolled = new Set<string>();

  /** Original console method references, saved before patching. */
  private originals: {
    log: typeof console.log;
    error: typeof console.error;
    warn: typeof console.warn;
    info: typeof console.info;
    debug: typeof console.debug;
  } | null = null;

  /**
   * Enroll a live secret value for Layer 2 scrubbing.
   * Values shorter than 8 characters are silently ignored to prevent
   * accidentally redacting common short strings (Test 5 guard).
   */
  enrollSecret(value: string): void {
    if (!value || value.length < 8) {
      return;
    }
    this.enrolled.add(value);
  }

  /**
   * Scrub a string through both layers.
   *
   * Layer 1: apply all static regex patterns.
   * Layer 2: replace all enrolled secret values.
   */
  redact(input: string): string {
    if (!input) return input;

    let result = input;

    // Layer 1 — static regex
    for (const { pattern, replacement } of STATIC_PATTERNS) {
      // Reset lastIndex for global regexes before each call
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
    }

    // Layer 2 — enrolled live values
    for (const secret of this.enrolled) {
      // Only replace secrets that are still >= 8 chars (defensive)
      if (secret.length >= 8) {
        // Use a plain string replacement (not regex) to avoid regex special chars
        // Replace ALL occurrences via split/join
        result = result.split(secret).join("***REDACTED-ENROLLED***");
      }
    }

    return result;
  }

  /**
   * Scrub an Error (or unknown thrown value) to a safe string.
   * Runs redact() on both the stringified error and the stack trace.
   */
  redactError(err: unknown): string {
    const errStr = String(err);
    let result = this.redact(errStr);

    if (err instanceof Error && err.stack) {
      const redactedStack = this.redact(err.stack);
      // If the stack contains more info than just the message, append it
      if (redactedStack !== errStr) {
        result = redactedStack;
      }
    }

    return result;
  }

  /**
   * Stringify an argument for redaction.
   * Returns the redacted string representation of any value.
   */
  private stringifyArg(arg: unknown): string {
    if (typeof arg === "string") {
      return this.redact(arg);
    }
    try {
      return this.redact(JSON.stringify(arg) ?? String(arg));
    } catch {
      return this.redact(String(arg));
    }
  }

  /**
   * Install global patches on console.log/error/warn/info/debug.
   * MUST be called exactly once at process start, before any other logging.
   * Each patched method passes args through redact() before forwarding.
   */
  installGlobalPatches(): void {
    if (this.originals) {
      // Already patched — idempotent: no-op
      return;
    }

    this.originals = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    };

    const { log: origLog, error: origError, warn: origWarn, info: origInfo, debug: origDebug } = this.originals;

    console.log = (...args: unknown[]) => {
      origLog.apply(
        console,
        args.map((a) => this.stringifyArg(a)),
      );
    };

    console.error = (...args: unknown[]) => {
      origError.apply(
        console,
        args.map((a) => this.stringifyArg(a)),
      );
    };

    console.warn = (...args: unknown[]) => {
      origWarn.apply(
        console,
        args.map((a) => this.stringifyArg(a)),
      );
    };

    console.info = (...args: unknown[]) => {
      origInfo.apply(
        console,
        args.map((a) => this.stringifyArg(a)),
      );
    };

    console.debug = (...args: unknown[]) => {
      origDebug.apply(
        console,
        args.map((a) => this.stringifyArg(a)),
      );
    };
  }

  /**
   * Restore original console methods.
   * Useful in tests to avoid cross-test contamination.
   */
  uninstallGlobalPatches(): void {
    if (!this.originals) return;

    console.log = this.originals.log;
    console.error = this.originals.error;
    console.warn = this.originals.warn;
    console.info = this.originals.info;
    console.debug = this.originals.debug;

    this.originals = null;
  }
}

// Export singleton instance
export const redactor = new Redactor();
