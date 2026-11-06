import http from "node:http";
import { URL } from "node:url";
import { logger } from "../utils/logger.js";

export interface OAuthCallbackServer {
  port: number;
  url: string;
  close(): void;
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
<h2>${title}</h2><p>${body}</p>
</body></html>`;
}

const SUCCESS_HTML = page("Authorization successful", "You can close this tab and return to the terminal.");

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface StartCallbackServerOpts {
  /**
   * Receives the authorization code. May return the exchange outcome so the
   * browser tab shows success only once tokens are actually stored.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: provider OAuth flows (grok/openai) pass sync void handlers
  onCode: (code: string, state: string) => void | Promise<{ ok: boolean; error?: string } | undefined>;
  /** Authorization server redirected back with `error=` (e.g. access_denied). */
  onError?: (error: string, description?: string) => void;
  /** Fired when no callback arrived within `timeoutMs`; the server is closed. */
  onTimeout?: () => void;
  timeoutMs?: number;
  /** Port to bind. 0 (default) = OS-assigned random port. */
  port?: number;
  /** Callback path. Default "/callback". Must start with "/". */
  path?: string;
  /** Host to bind. Default "127.0.0.1". Pass "localhost" if the OAuth app registered "http://localhost:..." literally. */
  host?: string;
}

export function startOAuthCallbackServer(opts: StartCallbackServerOpts): Promise<OAuthCallbackServer> {
  const callbackPath = opts.path ?? "/callback";
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // One-shot pages: never keep the socket alive. A pooled keep-alive
      // connection would carry the NEXT sign-in's callback (same loopback port,
      // re-bound) to this already-closed server instead of the new one.
      res.setHeader("Connection", "close");
      if (!req.url?.startsWith(callbackPath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const parsed = new URL(req.url, `http://${host}`);
      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state") ?? "";
      const error = parsed.searchParams.get("error");
      if (error) {
        const description = parsed.searchParams.get("error_description") ?? undefined;
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page("Authorization failed", escapeHtml(`${error}${description ? `: ${description}` : ""}`)));
        opts.onError?.(error, description);
        return;
      }
      if (!code) {
        res.writeHead(400);
        res.end("Missing code parameter");
        return;
      }
      Promise.resolve(opts.onCode(code, state)).then(
        (outcome) => {
          if (outcome && !outcome.ok) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(page("Authorization failed", escapeHtml(outcome.error ?? "unknown error")));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(SUCCESS_HTML);
        },
        (err: unknown) => {
          logger.error("mcp", `oauth callback handler failed: ${(err as Error)?.message}`);
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(page("Authorization failed", "See the terminal for details."));
        },
      );
    });

    server.listen(requestedPort, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start callback server"));
        return;
      }
      const port = addr.port;
      const url = `http://${host}:${port}${callbackPath}`;

      const timeout = setTimeout(() => {
        server.close();
        opts.onTimeout?.();
      }, opts.timeoutMs ?? 300_000);
      timeout.unref?.();

      resolve({
        port,
        url,
        close() {
          clearTimeout(timeout);
          // Idle keep-alives only: close() may run from inside onCode, while
          // the browser's callback response is still being written.
          server.close();
          server.closeIdleConnections?.();
        },
      });
    });

    server.on("error", reject);
  });
}
