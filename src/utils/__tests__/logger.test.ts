import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger, isLogLevelEnabled, redactSecrets, redactObject } from "../logger.js";

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
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let existsSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    writeSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => undefined);
    existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    clearTuiActive();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    writeSpy.mockRestore();
    existsSpy.mockRestore();
    mkdirSpy.mockRestore();
    clearTuiActive();
  });

  describe("redactSecrets", () => {
    it("redacts openai keys", () => {
      const msg = "sending request with key sk-proj12345678901234567890123456";
      expect(redactSecrets(msg)).toBe("sending request with key [REDACTED_API_KEY]");
    });

    it("redacts google keys", () => {
      const msg = "sending request with key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";
      expect(redactSecrets(msg)).toBe("sending request with key [REDACTED_API_KEY]");
    });

    it("redacts xai keys", () => {
      const msg = "sending request with key xai-proj12345678901234567890123456";
      expect(redactSecrets(msg)).toBe("sending request with key [REDACTED_API_KEY]");
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
      expect(writeSpy).toHaveBeenCalledTimes(1);

      const filePath = writeSpy.mock.calls[0][0] as string;
      const logContent = writeSpy.mock.calls[0][1] as string;

      expect(filePath).toContain("debug.log");
      expect(logContent).toContain("[INFO]");
      expect(logContent).toContain("[UI]");
      expect(logContent).toContain("render component");
      expect(logContent).toContain('{"id":"main"}');
    });
  });
});
