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
  serverTimeoutMs?: number;
  server?: { port?: number; authToken?: string };
}

function configPath(homeOverride?: string): string {
  return path.join(homeOverride ?? os.homedir(), ".experience", "config.json");
}

let _token: string | null = null;
let _embeddingModelVersion: string | null = null;
let _serverBaseUrl: string | null = null;
let _serverTimeoutMs: number | null = null;

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
    if (cfg.serverTimeoutMs && cfg.serverTimeoutMs > 0) _serverTimeoutMs = cfg.serverTimeoutMs;
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
  // Test/CI override — lets harness specs point EE traffic at an unreachable
  // stub URL without writing ~/.experience/config.json. Validated as a URL
  // before being returned so a bad env value falls through to the cached
  // config value instead of breaking fetch calls downstream.
  const envOverride = process.env.MUONROI_EE_BASE_URL;
  if (envOverride !== undefined && envOverride !== "") {
    try {
      // Throws on malformed URLs; falls through to _serverBaseUrl on error.
      const parsed = new URL(envOverride);
      return parsed.toString().replace(/\/$/, "");
    } catch {
      // Invalid override — ignore and use cached config value.
    }
  }
  return _serverBaseUrl;
}

export function getCachedServerTimeoutMs(): number | null {
  return _serverTimeoutMs;
}
