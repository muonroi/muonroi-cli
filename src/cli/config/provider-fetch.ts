import * as http from "node:http";
import * as https from "node:https";

export type ModelCapability = "text" | "vision" | "image" | "video";

export interface LiveModel {
  id: string;
  displayName: string;
  capability: ModelCapability;
}

const VISION_RE = /vision|vl|multimodal/i;
const IMAGE_RE = /flux|stable[_-]diffusion|imagen|dall[_-]e/i;
const VIDEO_RE = /video|wan[_-]|kling|hailuo/i;

export function inferCapability(modelId: string): ModelCapability {
  const id = modelId.toLowerCase();
  if (VISION_RE.test(id)) return "vision";
  if (IMAGE_RE.test(id)) return "image";
  if (VIDEO_RE.test(id)) return "video";
  return "text";
}

function shortName(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export async function fetchProviderModels(baseURL: string, apiKey: string, timeoutMs = 8000): Promise<LiveModel[]> {
  const url = new URL("/v1/models", baseURL.endsWith("/") ? baseURL : `${baseURL}/`);
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = lib.get(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(body) as {
              data?: Array<{ id: string }>;
            };
            const items = json.data ?? [];
            resolve(
              items
                .filter((m) => typeof m.id === "string")
                .map((m) => ({
                  id: m.id,
                  displayName: shortName(m.id),
                  capability: inferCapability(m.id),
                })),
            );
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}
