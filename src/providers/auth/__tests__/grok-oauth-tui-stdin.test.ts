/**
 * Regressions for the two ways an xAI sign-in used to leave the TUI unusable
 * until the process was restarted.
 */

import * as readline from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";

// The ESM namespace object is frozen, so vi.spyOn cannot patch it — the module
// has to be mocked outright for createInterface to be observable.
const rlClose = vi.fn();
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({ on: vi.fn(), close: rlClose })),
}));

import type { OAuthCallbackServer } from "../../../mcp/oauth-callback.js";
import type { FetchFn } from "../device-flow.js";
import type { CallbackServerFn, OpenBrowserFn } from "../grok-oauth.js";
import { GrokOAuthProvider } from "../grok-oauth.js";

const idToken = `h.${Buffer.from(JSON.stringify({ email: "grok@example.com" })).toString("base64url")}.s`;

const mockFetch = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ access_token: "a", refresh_token: "r", id_token: idToken, expires_in: 3600 }),
    text: () => Promise.resolve(""),
  }));

/** Callback server that fires the code after binding, and records close(). */
function mockCallbackServer(close: () => void, fire = true): CallbackServerFn {
  return vi.fn(async (opts: { onCode: (code: string, state: string) => void }) => {
    const url = "http://127.0.0.1:56121/callback";
    if (fire) setTimeout(() => opts.onCode("xai_code", capturedState()), 1);
    const server: OAuthCallbackServer = { port: 56121, url, close };
    return server;
  }) as unknown as CallbackServerFn;
}

let capturedAuthorizeUrl = "";
const capturedState = () => new URL(capturedAuthorizeUrl).searchParams.get("state") ?? "";
const openBrowser: OpenBrowserFn = (url: string) => {
  capturedAuthorizeUrl = url;
};

function makeProvider(callbackServerFn: CallbackServerFn) {
  return new GrokOAuthProvider({
    issuer: "https://auth.x.ai",
    clientId: "test_xai_client",
    fetchFn: mockFetch() as unknown as FetchFn,
    callbackServerFn,
    openBrowserFn: openBrowser,
  });
}

const stdin = process.stdin as unknown as { isTTY?: boolean; isRaw?: boolean };
const original = { isTTY: stdin.isTTY, isRaw: stdin.isRaw };

afterEach(() => {
  vi.mocked(readline.createInterface).mockClear();
  rlClose.mockClear();
  stdin.isTTY = original.isTTY;
  stdin.isRaw = original.isRaw;
  vi.restoreAllMocks();
});

describe("GrokOAuthProvider.login — stdin ownership", () => {
  // Inside the TUI, OpenTUI holds stdin in raw mode. Attaching a readline stole
  // every keystroke, so Esc no longer dismissed the provider dialog and only a
  // restart recovered the session.
  it("does not attach a readline when another consumer already owns stdin (raw mode)", async () => {
    stdin.isTTY = true;
    stdin.isRaw = true;

    await makeProvider(mockCallbackServer(vi.fn())).login({});

    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  // The manual-paste fallback is still right for `keys login` on a plain TTY.
  it("attaches — and always closes — the readline on a non-raw TTY", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stdin.isTTY = true;
    stdin.isRaw = false;

    await makeProvider(mockCallbackServer(vi.fn())).login({});

    expect(readline.createInterface).toHaveBeenCalled();
    // The old code closed it only when a code was pasted, so the normal
    // HTTP-callback path (this one) left stdin captured for good.
    expect(rlClose).toHaveBeenCalled();
  });
});

describe("GrokOAuthProvider.login — cancellation", () => {
  // Esc used to abandon the promise, leaving the loopback server bound for the
  // full 5-minute callback timeout across a two-port set, so the next attempt
  // could not bind.
  it("aborting rejects the login AND closes the callback server", async () => {
    const close = vi.fn();
    const controller = new AbortController();
    stdin.isTTY = false;

    const promise = makeProvider(mockCallbackServer(close, false)).login({ signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(promise).rejects.toThrow(/cancelled/i);
    expect(close).toHaveBeenCalled();
  });

  it("an already-aborted signal never binds a server at all", async () => {
    const close = vi.fn();
    const controller = new AbortController();
    controller.abort();
    stdin.isTTY = false;

    await expect(makeProvider(mockCallbackServer(close, false)).login({ signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    );
  });
});
