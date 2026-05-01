/**
 * Local HTTP stub server for Experience Engine endpoints.
 * Reused by plans 03/07/08 -- do not couple to a single test file.
 *
 * Uses Node http module for compatibility with vitest (runs under Node, not Bun).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface StubConfig {
  port?: number;
  routeModel?: (req: any) => any;
  coldRoute?: (req: any) => any;
  intercept?: (req: any) => any;
  posttool?: (req: any) => void;
  feedback?: (req: any) => void;
  touch?: (id: string) => void;
  health?: () => boolean;
  latencyMs?: number;
}

export interface StubHandle {
  server: Server;
  port: number;
  stop(): Promise<void>;
  calls: Record<string, any[]>;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res: ServerResponse, data: any, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res: ServerResponse, text: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(text);
}

export async function startStubEEServer(cfg: StubConfig = {}): Promise<StubHandle> {
  const calls: Record<string, any[]> = {
    intercept: [],
    posttool: [],
    routeModel: [],
    coldRoute: [],
    feedback: [],
    touch: [],
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (cfg.latencyMs) {
      await new Promise((r) => setTimeout(r, cfg.latencyMs));
    }

    // Health endpoint
    if (url.pathname === "/health") {
      const ok = cfg.health ? cfg.health() : true;
      sendJson(res, { ok }, ok ? 200 : 503);
      return;
    }

    const body = req.method === "POST" ? await readBody(req) : {};

    // Route model (warm path)
    if (url.pathname === "/api/route-model") {
      calls.routeModel.push(body);
      const r = cfg.routeModel?.(body);
      if (r) {
        sendJson(res, r);
      } else {
        sendText(res, "no handler", 500);
      }
      return;
    }

    // Cold route
    if (url.pathname === "/api/cold-route") {
      calls.coldRoute.push(body);
      const r = cfg.coldRoute?.(body);
      if (r) {
        sendJson(res, r);
      } else {
        sendText(res, "no handler", 500);
      }
      return;
    }

    // Intercept
    if (url.pathname === "/api/intercept") {
      calls.intercept.push(body);
      const r = cfg.intercept?.(body) ?? { decision: "allow" };
      sendJson(res, r);
      return;
    }

    // PostTool
    if (url.pathname === "/api/posttool") {
      calls.posttool.push(body);
      cfg.posttool?.(body);
      sendText(res, "ok");
      return;
    }

    // Feedback
    if (url.pathname === "/api/feedback") {
      calls.feedback.push(body);
      cfg.feedback?.(body);
      sendText(res, "ok");
      return;
    }

    // Principle touch
    if (url.pathname.startsWith("/api/principle/touch")) {
      const id = url.searchParams.get("id") ?? body?.id;
      calls.touch.push(id);
      cfg.touch?.(id);
      sendText(res, "ok");
      return;
    }

    sendText(res, "not found", 404);
  });

  return new Promise((resolve) => {
    server.listen(cfg.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        port,
        stop: () => new Promise<void>((r) => server.close(() => r())),
        calls,
      });
    });
  });
}
