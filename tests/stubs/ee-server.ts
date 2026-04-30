/**
 * Local HTTP stub server for Experience Engine endpoints.
 * Reused by plans 03/07/08 — do not couple to a single test file.
 *
 * Uses Bun.serve which is available natively in the Bun runtime.
 */
import { serve, type Server } from "bun";

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

export async function startStubEEServer(
  cfg: StubConfig = {},
): Promise<StubHandle> {
  const calls: Record<string, any[]> = {
    intercept: [],
    posttool: [],
    routeModel: [],
    coldRoute: [],
    feedback: [],
    touch: [],
  };

  const port = cfg.port ?? 0;

  const server = serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (cfg.latencyMs) {
        await new Promise((r) => setTimeout(r, cfg.latencyMs));
      }

      // Health endpoint
      if (url.pathname === "/health") {
        const ok = cfg.health ? cfg.health() : true;
        return new Response(JSON.stringify({ ok }), {
          status: ok ? 200 : 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body =
        req.method === "POST" ? await req.json().catch(() => ({})) : {};

      // Route model (warm path)
      if (url.pathname === "/api/route-model") {
        calls.routeModel.push(body);
        const r = cfg.routeModel?.(body);
        return r
          ? Response.json(r)
          : new Response("no handler", { status: 500 });
      }

      // Cold route
      if (url.pathname === "/api/cold-route") {
        calls.coldRoute.push(body);
        const r = cfg.coldRoute?.(body);
        return r
          ? Response.json(r)
          : new Response("no handler", { status: 500 });
      }

      // Intercept
      if (url.pathname === "/api/intercept") {
        calls.intercept.push(body);
        const r = cfg.intercept?.(body) ?? { decision: "allow" };
        return Response.json(r);
      }

      // PostTool
      if (url.pathname === "/api/posttool") {
        calls.posttool.push(body);
        cfg.posttool?.(body);
        return new Response("ok");
      }

      // Feedback
      if (url.pathname === "/api/feedback") {
        calls.feedback.push(body);
        cfg.feedback?.(body);
        return new Response("ok");
      }

      // Principle touch
      if (url.pathname.startsWith("/api/principle/touch")) {
        const id = url.searchParams.get("id") ?? body?.id;
        calls.touch.push(id);
        cfg.touch?.(id);
        return new Response("ok");
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    port: server.port,
    stop: async () => {
      server.stop(true);
    },
    calls,
  };
}
