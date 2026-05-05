import http from "node:http";
import { URL } from "node:url";

export interface OAuthCallbackServer {
  port: number;
  url: string;
  close(): void;
}

const SUCCESS_HTML = `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
<h2>Authorization successful</h2><p>You can close this tab and return to the terminal.</p>
</body></html>`;

export function startOAuthCallbackServer(opts: {
  onCode: (code: string, state: string) => void;
  timeoutMs?: number;
}): Promise<OAuthCallbackServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const parsed = new URL(req.url, "http://127.0.0.1");
      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state") ?? "";
      if (!code) {
        res.writeHead(400);
        res.end("Missing code parameter");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SUCCESS_HTML);
      opts.onCode(code, state);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start callback server"));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}/callback`;

      const timeout = setTimeout(() => {
        server.close();
      }, opts.timeoutMs ?? 300_000);

      resolve({
        port,
        url,
        close() {
          clearTimeout(timeout);
          server.close();
        },
      });
    });

    server.on("error", reject);
  });
}
