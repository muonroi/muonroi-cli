import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, redactObject, redactSecrets, serializeError, serializeErrorRedacted } from "../logger.js";

function setTuiActive(active: boolean) {
  (globalThis as Record<string, unknown>).__muonroiTuiActive = active;
}

function clearTuiActive() {
  delete (globalThis as Record<string, unknown>).__muonroiTuiActive;
}

describe("logger utility", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    clearTuiActive();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    clearTuiActive();
  });

  describe("redactSecrets", () => {
    it("redacts openai keys", () => {
      const msg = "sending request with key sk-proj12345678901234567890123456";
      expect(redactSecrets(msg)).toBe("sending request with key [REDACTED_API_KEY]");
    });

    it("redacts google keys", () => {
      // Built from parts so the source contains no complete AIzaSy… literal —
      // otherwise GitHub secret scanning flags this redaction fixture as a
      // real Google API key. The concatenation reproduces the full pattern at
      // runtime, so the regex under test is still exercised.
      const fakeGoogleKey = `AIzaSy${"A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"}`;
      const msg = `sending request with key ${fakeGoogleKey}`;
      expect(redactSecrets(msg)).toBe("sending request with key [REDACTED_API_KEY]");
    });

    it("redacts xai keys", () => {
      const msg = "sending request with key xai-proj12345678901234567890123456";
      expect(redactSecrets(msg)).toBe("sending request with key [REDACTED_API_KEY]");
    });

    // A bearer token or Authorization header has no fixed provider prefix, so
    // it needs its own generic pattern (not the sk-/xai-/AIzaSy ones above).
    // Motivated by an Error's `message` carrying a credential verbatim — e.g.
    // an HTTP client error embedding the request header it failed on.
    it("redacts a bearer token", () => {
      const fakeToken = `eyJhbGciOiJIUzI1NiJ9${".fakepayload.fakesignature1234567890"}`;
      const msg = `request failed: Bearer ${fakeToken} was rejected`;
      expect(redactSecrets(msg)).toBe("request failed: Bearer [REDACTED] was rejected");
    });

    it("redacts an Authorization header value", () => {
      const fakeToken = `eyJhbGciOiJIUzI1NiJ9${".fakepayload.fakesignature1234567890"}`;
      const msg = `Authorization: Bearer ${fakeToken}`;
      expect(redactSecrets(msg)).toBe("Authorization: [REDACTED]");
    });
  });

  describe("redactObject", () => {
    it("redacts sensitive fields in an object recursively", () => {
      const raw = {
        name: "test",
        apiKey: "sk-proj1234567890",
        nested: {
          secretToken: "some-secret",
          plainVal: "hello",
        },
        arr: ["item1", "sk-proj12345678901234567890123456"],
      };

      const expected = {
        name: "test",
        apiKey: "[REDACTED]",
        nested: {
          secretToken: "[REDACTED]",
          plainVal: "hello",
        },
        arr: ["item1", "[REDACTED_API_KEY]"],
      };

      expect(redactObject(raw)).toEqual(expected);
    });

    // Root defect: JSON.stringify(new Error("x")) === "{}" because `message`
    // and `stack` are non-enumerable, so any logger call that carries a raw
    // Error in its data object silently dropped the cause once it reached
    // appendToFile/formatConsole's JSON.stringify. redactObject now walks an
    // Error out into a plain object BEFORE that stringify runs.
    it("serializes a plain Error into message + stack instead of '{}'", () => {
      const err = new Error("boom");
      const result = redactObject({ error: err }) as { error: { name: string; message: string; stack: string[] } };
      expect(result.error.name).toBe("Error");
      expect(result.error.message).toBe("boom");
      expect(Array.isArray(result.error.stack)).toBe(true);
      expect(result.error.stack.length).toBeGreaterThan(0);
      expect(result.error.stack[0]).toContain("boom");
      // The old behavior — proof the regression is actually closed.
      expect(JSON.stringify(result.error)).not.toBe("{}");
    });

    it("keeps extra own properties (code, status) from an Error subclass", () => {
      class HttpError extends Error {
        code: string;
        status: number;
        constructor(message: string, code: string, status: number) {
          super(message);
          this.name = "HttpError";
          this.code = code;
          this.status = status;
        }
      }
      const err = new HttpError("request failed", "ECONNRESET", 502);
      const result = redactObject({ error: err }) as {
        error: { name: string; message: string; code: string; status: number };
      };
      expect(result.error.name).toBe("HttpError");
      expect(result.error.message).toBe("request failed");
      expect(result.error.code).toBe("ECONNRESET");
      expect(result.error.status).toBe(502);
    });

    it("serializes an Error nested inside another object at any depth", () => {
      const err = new Error("nested boom");
      const result = redactObject({ ctx: { error: err, other: "x" } }) as {
        ctx: { error: { message: string }; other: string };
      };
      expect(result.ctx.error.message).toBe("nested boom");
      expect(result.ctx.other).toBe("x");
    });

    it("bounds an AggregateError's inner errors and a cause chain", () => {
      const rootCause = new Error("root cause");
      const wrapped = new Error("wrapped", { cause: rootCause });
      const agg = new AggregateError([new Error("first"), new Error("second")], "multiple failures");
      const result = redactObject({ wrapped, agg }) as {
        wrapped: { message: string; cause?: { message: string } };
        agg: { message: string; errors?: Array<{ message: string }> };
      };
      expect(result.wrapped.message).toBe("wrapped");
      expect(result.wrapped.cause?.message).toBe("root cause");
      expect(result.agg.message).toBe("multiple failures");
      expect(result.agg.errors?.map((e) => e.message)).toEqual(["first", "second"]);
    });

    it("does not throw on a deep cause chain — bounded, not unbounded recursion", () => {
      let err = new Error("depth-0");
      for (let i = 1; i <= 20; i++) {
        err = new Error(`depth-${i}`, { cause: err });
      }
      expect(() => redactObject({ error: err })).not.toThrow();
      const result = JSON.stringify(redactObject({ error: err }));
      expect(result.length).toBeLessThan(5000);
    });

    it("leaves non-Error throwables (string, plain object) unchanged", () => {
      expect(redactObject({ error: "just a string" })).toEqual({ error: "just a string" });
      expect(redactObject({ error: { reason: "plain object" } })).toEqual({ error: { reason: "plain object" } });
    });

    it("does not throw on a cyclic object", () => {
      const cyclic: Record<string, unknown> = { name: "cyclic" };
      cyclic.self = cyclic;
      let result: unknown;
      expect(() => {
        result = redactObject(cyclic);
      }).not.toThrow();
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("does not throw on a cyclic array", () => {
      const cyclic: unknown[] = ["a", "b"];
      cyclic.push(cyclic);
      expect(() => redactObject(cyclic)).not.toThrow();
    });
  });

  describe("serializeError", () => {
    it("caps the stack to its first few lines", () => {
      const err = new Error("long stack");
      err.stack = Array.from({ length: 50 }, (_, i) => `  at frame${i} (file.ts:${i}:1)`).join("\n");
      const result = serializeError(err);
      expect(result.stack?.length).toBeLessThanOrEqual(5);
    });

    // UNREDACTED by design — serializeError is the internal building block
    // redactObject calls before walking (and redacting) its output. A secret
    // embedded in the message/stack/own-properties survives verbatim here;
    // any sink that persists the result MUST go through serializeErrorRedacted
    // instead (see the describe block below).
    it("does NOT redact a secret in the message — this is why direct use is unsafe", () => {
      const fakeKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
      const err = new Error(`auth failed with key ${fakeKey}`);
      const result = serializeError(err);
      expect(result.message).toContain(fakeKey);
    });
  });

  describe("serializeErrorRedacted — the sanctioned entry point for sinks outside logger.ts", () => {
    it("redacts a provider key embedded in the message and the first stack line", () => {
      const fakeKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
      const err = new Error(`auth failed with key ${fakeKey}`);
      err.stack = `Error: auth failed with key ${fakeKey}\n    at doAuth (auth.ts:1:1)`;
      const result = serializeErrorRedacted(err);
      expect(result.message).not.toContain(fakeKey);
      expect(result.message).toContain("[REDACTED_API_KEY]");
      expect((result.stack as string[])[0]).not.toContain(fakeKey);
    });

    it("redacts a bearer token and an Authorization header value in the message", () => {
      const fakeToken = `eyJhbGciOiJIUzI1NiJ9${".fakepayload.fakesignature1234567890"}`;
      const err = new Error(`request failed — Authorization: Bearer ${fakeToken}`);
      const result = serializeErrorRedacted(err);
      expect(result.message).not.toContain(fakeToken);
      expect(result.message).toContain("[REDACTED]");
    });

    it("redacts an Error subclass's token/apiKey/password own properties", () => {
      class SdkError extends Error {
        apiKey: string;
        token: string;
        password: string;
        constructor(message: string) {
          super(message);
          this.name = "SdkError";
          this.apiKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
          this.token = `raw-session-${"token-value"}`;
          this.password = "hunter2";
        }
      }
      const err = new SdkError("sdk call failed");
      const result = serializeErrorRedacted(err) as unknown as {
        apiKey: string;
        token: string;
        password: string;
      };
      expect(result.apiKey).toBe("[REDACTED]");
      expect(result.token).toBe("[REDACTED]");
      expect(result.password).toBe("[REDACTED]");
    });
  });

  // Regression: the real live shape from council/compaction — a proposer
  // failure logged via `logger.warn(ns, "Proposer failure", { error: err })`
  // previously wrote `{"error":{}}` to the log line, discarding the cause.
  describe("Proposer failure log — real live shape regression", () => {
    it("logger.warn with a raw Error in the data object no longer writes '{\"error\":{}}'", () => {
      logger.warn("orchestrator", "Proposer failure", { error: new Error("boom") });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const callArg = warnSpy.mock.calls[0][0] as string;
      expect(callArg).not.toContain('{"error":{}}');
      expect(callArg).toContain("boom");
    });
  });

  describe("logger functionality in CLI mode", () => {
    it("logs info messages to console.log", () => {
      logger.info("cli", "test message", { val: 42 });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const callArg = logSpy.mock.calls[0][0];
      expect(callArg).toContain("[INFO]");
      expect(callArg).toContain("[CLI]");
      expect(callArg).toContain("test message");
      expect(callArg).toContain('{"val":42}');
    });

    it("logs warn messages to console.warn", () => {
      logger.warn("orchestrator", "warning message");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const callArg = warnSpy.mock.calls[0][0];
      expect(callArg).toContain("[WARN]");
      expect(callArg).toContain("[ORCHESTRATOR]");
      expect(callArg).toContain("warning message");
    });

    it("logs error messages to console.error", () => {
      logger.error("storage", "error message");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const callArg = errorSpy.mock.calls[0][0];
      expect(callArg).toContain("[ERROR]");
      expect(callArg).toContain("[STORAGE]");
      expect(callArg).toContain("error message");
    });
  });

  describe("logger functionality in TUI mode", () => {
    it("does not log to console, but appends to debug.log", () => {
      setTuiActive(true);
      logger.info("ui", "render component", { id: "main" });

      expect(logSpy).not.toHaveBeenCalled();
      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);

      const filePath = (fs.appendFileSync as any).mock.calls[0][0] as string;
      const logContent = (fs.appendFileSync as any).mock.calls[0][1] as string;

      expect(filePath).toContain("debug.log");
      expect(logContent).toContain("[INFO]");
      expect(logContent).toContain("[UI]");
      expect(logContent).toContain("render component");
      expect(logContent).toContain('{"id":"main"}');
    });
  });
});
