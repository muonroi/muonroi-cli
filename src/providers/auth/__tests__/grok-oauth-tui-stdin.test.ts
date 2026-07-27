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
  // Inside the TUI, OpenTUI holds stdin. Attaching a readline steals every
  // keystroke, so Esc no longer dismisses the provider dialog and only a
  // restart recovers the session.
  //
  // The gate is the caller's opt-in, NOT a runtime probe: this case pins the
  // exact state measured inside the TUI under Bun 1.3.13 — isTTY true and
  // isRaw FALSE even while OpenTUI holds raw mode — which is what made the
  // previous `!process.stdin.isRaw` guard pass and the freeze come back.
  it("does not attach a readline when the caller did not lend stdin (TUI, isRaw unreliable)", async () => {
    stdin.isTTY = true;
    stdin.isRaw = false;

    await makeProvider(mockCallbackServer(vi.fn())).login({});

    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  // The manual-paste fallback is still right for `keys login` on a plain TTY —
  // there the caller owns stdin and says so explicitly.
  it("attaches — and always closes — the readline when the caller opts in", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stdin.isTTY = true;
    stdin.isRaw = false;

    await makeProvider(mockCallbackServer(vi.fn())).login({ allowManualCodePaste: true });

    expect(readline.createInterface).toHaveBeenCalled();
    // The old code closed it only when a code was pasted, so the normal
    // HTTP-callback path (this one) left stdin captured for good.
    expect(rlClose).toHaveBeenCalled();
  });

  it("leaves stdin flowing after the opted-in readline closes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stdin.isTTY = true;
    // readline.close() pauses the input stream; a paused stdin is the same
    // freeze under another name, so the flow must resume what it borrowed.
    const resume = vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);

    await makeProvider(mockCallbackServer(vi.fn())).login({ allowManualCodePaste: true });

    expect(resume).toHaveBeenCalled();
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
