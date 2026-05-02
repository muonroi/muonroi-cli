/**
 * EE auth token loader — reads ~/.experience/config.json at startup.
 *
 * EE-07: auth token from config; 401 triggers refreshAuthToken() + retry-once.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactor } from "../utils/redactor.js";

export interface ExperienceConfig {
  authToken?: string;
  embeddingModelVersion?: string;
  serverBaseUrl?: string;
  serverAuthToken?: string;
  server?: { port?: number; authToken?: string };
}

function configPath(homeOverride?: string): string {
  return path.join(homeOverride ?? os.homedir(), ".experience", "config.json");
}

let _token: string | null = null;
let _embeddingModelVersion: string | null = null;
let _serverBaseUrl: string | null = null;

export async function loadEEAuthToken(opts: { home?: string } = {}): Promise<string | null> {
  try {
    const txt = await fs.readFile(configPath(opts.home), "utf8");
    const cfg = JSON.parse(txt) as ExperienceConfig;
    const token = cfg.serverAuthToken ?? cfg.server?.authToken ?? cfg.authToken;
    if (token) {
      redactor.enrollSecret(token);
      _token = token;
    }
    if (cfg.embeddingModelVersion) _embeddingModelVersion = cfg.embeddingModelVersion;
    if (cfg.serverBaseUrl) _serverBaseUrl = cfg.serverBaseUrl;
    return _token;
  } catch {
    return null;
  }
}

export async function refreshAuthToken(opts: { home?: string } = {}): Promise<string | null> {
  _token = null;
  return await loadEEAuthToken(opts);
}

export function getCachedAuthToken(): string | null {
  return _token;
}

export function getEmbeddingModelVersion(): string {
  return _embeddingModelVersion ?? "nomic-embed-text-v1.5";
}

export function getCachedServerBaseUrl(): string | null {
  return _serverBaseUrl;
}
