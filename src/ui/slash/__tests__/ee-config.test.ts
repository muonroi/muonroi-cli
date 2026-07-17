/**
 * /ee config — the post-install path to connect an Experience Engine.
 *
 * Before this existed, EE was configurable only by the one-shot first-run
 * wizard, and index.ts sets eeSetupPrompted even when the user SKIPS it. So a
 * single "no" at first run left hand-editing ~/.experience/config.json as the
 * only way to ever connect a brain.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlashHandler } from "../registry.js";
import type { SlashContext } from "../registry.js";

// The ESM namespace is frozen, so vi.spyOn cannot patch homedir — node:os has
// to be mocked outright. vi.hoisted carries the per-test temp dir into the
// hoisted factory.
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home, default: { ...actual, homedir: () => h.home } };
});

const ctx = { cwd: process.cwd(), tenantId: "local" } as unknown as SlashContext;

let home: string;
let handleEESlash: SlashHandler;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "muonroi-ee-cfg-"));
  h.home = home;
  // Config resolution prefers this env override; keep it out of the way.
  delete process.env.MUONROI_EE_BASE_URL;
  // ee/auth.ts caches serverBaseUrl/token at module scope, so a fresh module
  // graph per test keeps one test's saved config out of the next one's status.
  vi.resetModules();
  ({ handleEESlash } = await import("../ee.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (err) {
    console.error(`[ee-config.test] temp cleanup failed: ${(err as Error).message}`);
  }
});

const configFile = () => join(home, ".experience", "config.json");

describe("/ee config", () => {
  it("writes serverBaseUrl + token to ~/.experience/config.json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200 })),
    );

    const out = await handleEESlash(["config", "https://experience.example.com", "tok_abcd1234"], ctx);

    const written = JSON.parse(readFileSync(configFile(), "utf8"));
    expect(written.serverBaseUrl).toBe("https://experience.example.com");
    expect(written.serverAuthToken).toBe("tok_abcd1234");
    expect(out).toContain("EE Config saved");
  });

  // The transcript is persisted to SQLite, so echoing the token back would
  // write a live credential into the session DB.
  it("never echoes the token back in full", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200 })),
    );

    const out = await handleEESlash(["config", "https://experience.example.com", "tok_abcd1234"], ctx);

    expect(out).not.toContain("tok_abcd1234");
    expect(out).toContain("…1234");
  });

  // A config write that succeeded must not be reported as a failure just
  // because the server is down — the setting is saved either way.
  it("still saves when the server is unreachable, and says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await handleEESlash(["config", "https://down.example.com", "tok_wxyz"], ctx);

    expect(JSON.parse(readFileSync(configFile(), "utf8")).serverBaseUrl).toBe("https://down.example.com");
    expect(out).toContain("not reachable");
    expect(out).toContain("ECONNREFUSED");
  });

  // 401 is a token problem, not a connectivity problem; collapsing both to
  // "unreachable" sends the user to debug the wrong thing.
  it("distinguishes a rejected token from an unreachable server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 })),
    );

    const out = await handleEESlash(["config", "https://experience.example.com", "bad"], ctx);

    expect(out).toMatch(/rejected this auth token/i);
  });

  it("rejects a malformed URL instead of writing it", async () => {
    const out = await handleEESlash(["config", "not-a-url"], ctx);

    expect(out).toContain("not a valid URL");
    expect(() => readFileSync(configFile(), "utf8")).toThrow();
  });

  it("reports the current settings when called with no URL", async () => {
    const out = await handleEESlash(["config"], ctx);

    expect(out).toContain("EE Config");
    expect(out).toContain("/ee config <url> [token]");
  });

  it("is advertised in the help text", async () => {
    const out = await handleEESlash([], ctx);
    expect(out).toContain("/ee config");
  });
});
