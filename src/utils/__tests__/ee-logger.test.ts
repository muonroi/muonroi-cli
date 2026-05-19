/**
 * Unit tests for src/utils/ee-logger.ts.
 *
 * The logger is the foundation of Phase 21 observability — every silent EE
 * catch site routes through it. These tests pin down the four guarantees:
 *   1. Warn line has stable `[ee.<source>.<kind>]` prefix shape.
 *   2. `ee-timeout` / `ee-error` events fire when the agent runtime is wired.
 *   3. No-op event path when the runtime is absent (composer-only sessions).
 *   4. Never throws on `null` / `undefined` / non-Error `err` arguments.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyEeError, logEeFailure, withEeTimeout } from "../ee-logger.js";

type RuntimeStub = { emitEvent: ReturnType<typeof vi.fn> };

function installRuntime(): RuntimeStub {
  const stub: RuntimeStub = { emitEvent: vi.fn() };
  (globalThis as Record<string, unknown>).__muonroiAgentRuntime = stub;
  return stub;
}

function removeRuntime(): void {
  delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
}

describe("ee-logger", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    removeRuntime();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    removeRuntime();
  });

  describe("logEeFailure", () => {
    it("emits warn with [ee.<source>.<kind>] prefix and structured error", () => {
      const err = new Error("connection refused");
      logEeFailure("bridge.classifyViaBrain", "error", err, { elapsedMs: 12 });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const args = warnSpy.mock.calls[0]!;
      expect(args[0]).toBe("[ee.bridge.classifyViaBrain.error]");
      expect(args[1]).toEqual({ name: "Error", message: "connection refused" });
      expect(args[2]).toEqual({ elapsedMs: 12 });
    });

    it("emits ee-timeout event when runtime is present and kind=timeout", () => {
      const stub = installRuntime();
      const err = Object.assign(new Error("aborted"), { name: "TimeoutError" });

      logEeFailure("bridge.searchByText", "timeout", err, {
        elapsedMs: 1502,
        budgetMs: 1500,
      });

      expect(stub.emitEvent).toHaveBeenCalledTimes(1);
      const ev = stub.emitEvent.mock.calls[0]![0] as Record<string, unknown>;
      expect(ev.t).toBe("event");
      expect(ev.kind).toBe("ee-timeout");
      expect(ev.source).toBe("bridge.searchByText");
      expect(ev.elapsedMs).toBe(1502);
      expect(ev.budgetMs).toBe(1500);
      expect(typeof ev.ts).toBe("number");
    });

    it("emits ee-error event with name/message when runtime is present and kind=error", () => {
      const stub = installRuntime();
      const err = new TypeError("not a function");

      logEeFailure("client.posttool", "error", err);

      expect(stub.emitEvent).toHaveBeenCalledTimes(1);
      const ev = stub.emitEvent.mock.calls[0]![0] as Record<string, unknown>;
      expect(ev.kind).toBe("ee-error");
      expect(ev.source).toBe("client.posttool");
      expect(ev.name).toBe("TypeError");
      expect(ev.message).toBe("not a function");
      expect(typeof ev.ts).toBe("number");
    });

    it("is a no-op on the event path when runtime is absent", () => {
      // No installRuntime() — runtime missing.
      expect(() => logEeFailure("pil.layer4.routeTask", "error", new Error("x"))).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // No runtime to assert on — just confirm no throw and warn still fires.
    });

    it("never throws on null err", () => {
      installRuntime();
      expect(() => logEeFailure("pil.pipeline.logInteraction", "error", null)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledOnce();
      const args = warnSpy.mock.calls[0]!;
      expect((args[1] as { name: string }).name).toBe("Null");
    });

    it("never throws on undefined err", () => {
      installRuntime();
      expect(() => logEeFailure("phase-outcome.recordCouncilOutcome", "error", undefined)).not.toThrow();
      const args = warnSpy.mock.calls[0]!;
      expect((args[1] as { name: string }).name).toBe("Undefined");
    });

    it("never throws on string err and uses the string as message", () => {
      installRuntime();
      expect(() => logEeFailure("client.feedback", "error", "boom")).not.toThrow();
      const args = warnSpy.mock.calls[0]!;
      expect(args[1]).toEqual({ name: "String", message: "boom" });
    });

    it("never throws on object-with-name err", () => {
      installRuntime();
      const errLike = { name: "AbortError", message: "request aborted" };
      expect(() => logEeFailure("bridge.routeTask", "timeout", errLike)).not.toThrow();
      const args = warnSpy.mock.calls[0]!;
      expect(args[1]).toEqual({ name: "AbortError", message: "request aborted" });
    });

    it("does not propagate emitEvent exceptions", () => {
      const stub: RuntimeStub = {
        emitEvent: vi.fn(() => {
          throw new Error("subscriber blew up");
        }),
      };
      (globalThis as Record<string, unknown>).__muonroiAgentRuntime = stub;

      expect(() => logEeFailure("client.touch", "error", new Error("x"))).not.toThrow();
      expect(stub.emitEvent).toHaveBeenCalledTimes(1);
    });

    it("survives a runtime where emitEvent is not a function", () => {
      (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent: "nope" };
      expect(() => logEeFailure("bridge.routeModel", "error", new Error("x"))).not.toThrow();
    });
  });

  describe("classifyEeError", () => {
    it("classifies TimeoutError as timeout", () => {
      const err = Object.assign(new Error("x"), { name: "TimeoutError" });
      expect(classifyEeError(err)).toBe("timeout");
    });

    it("classifies AbortError as timeout", () => {
      const err = Object.assign(new Error("x"), { name: "AbortError" });
      expect(classifyEeError(err)).toBe("timeout");
    });

    it("classifies generic Error as error", () => {
      expect(classifyEeError(new Error("boom"))).toBe("error");
    });

    it("classifies TypeError as error", () => {
      expect(classifyEeError(new TypeError("boom"))).toBe("error");
    });

    it("classifies null / undefined / string as error", () => {
      expect(classifyEeError(null)).toBe("error");
      expect(classifyEeError(undefined)).toBe("error");
      expect(classifyEeError("boom")).toBe("error");
    });

    it("classifies plain object with TimeoutError name as timeout", () => {
      expect(classifyEeError({ name: "TimeoutError" })).toBe("timeout");
    });
  });

  describe("withEeTimeout (Phase 21.5)", () => {
    it("resolves through when the inner promise settles in time", async () => {
      const v = await withEeTimeout(Promise.resolve(42), 50);
      expect(v).toBe(42);
    });

    it("rejects with TimeoutError when the inner promise takes too long", async () => {
      const slow = new Promise<number>((resolve) => setTimeout(() => resolve(7), 100));
      await expect(withEeTimeout(slow, 20)).rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("forwards inner rejection unchanged when it beats the timeout", async () => {
      const err = new Error("inner boom");
      await expect(withEeTimeout(Promise.reject(err), 50)).rejects.toBe(err);
    });

    it("rejected error classifies as timeout via classifyEeError", async () => {
      const slow = new Promise<number>((resolve) => setTimeout(() => resolve(0), 100));
      try {
        await withEeTimeout(slow, 10);
        throw new Error("should not reach");
      } catch (e) {
        expect(classifyEeError(e)).toBe("timeout");
      }
    });
  });
});
