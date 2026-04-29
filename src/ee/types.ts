/**
 * EE HTTP client type contracts.
 *
 * These are the wire shapes sent to/received from the Experience Engine
 * running at localhost:8082. The EE protocol deliberately excludes provider
 * API keys — only toolName + toolInput + cwd cross the HTTP boundary (T-00.06-01).
 */

export interface InterceptRequest {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  tenantId?: string; // Phase 1 EE-04 lands this; Phase 0 may omit
}

export interface InterceptResponse {
  decision: "allow" | "block";
  suggestions?: string[];
  surfacedIds?: string[];
  reason?: string;
}

export interface PostToolPayload {
  toolName: string;
  toolInput: unknown;
  outcome: { success: boolean; exitCode?: number; durationMs?: number; error?: string };
  surfacedIds?: string[];
  cwd: string;
  tenantId?: string; // Phase 1 EE-04
}

export interface EEClient {
  health(): Promise<{ ok: boolean; status: number }>;
  intercept(req: InterceptRequest): Promise<InterceptResponse>;
  posttool(payload: PostToolPayload): void;
}
