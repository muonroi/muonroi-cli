/**
 * src/providers/strategies/google.strategy.ts
 *
 * Google strategy (powered by Agy OAuth when using "google" provider without API key).
 *
 * Approach A: When OAuth Bearer headers are present, uses a custom fetch-based
 * provider that sends `Authorization: Bearer <token>` directly to the Gemini
 * API, bypassing @ai-sdk/google's apiKey-based auth.
 *
 * Approach C: Supports self-registered OAuth client via env vars
 * (MUONROI_GOOGLE_CLIENT_ID / MUONROI_GOOGLE_CLIENT_SECRET) or user settings
 * (providers.google.oauthClientId / oauthClientSecret).
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";

// ---------------------------------------------------------------------------
// Approach A: custom fetch-based LanguageModelV1 for Bearer token auth
// ---------------------------------------------------------------------------
// The @ai-sdk/google SDK sends X-Goog-Api-Key from the apiKey parameter even
// when custom Authorization headers are set, which causes Gemini API to
// disregard the Bearer token. This custom model sends ONLY the Bearer token.
// ---------------------------------------------------------------------------

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
}

function createBearerTokenModel(baseURL: string, headers: Record<string, string>) {
  // Remove any trailing slash from baseURL for consistent path building
  const apiBase = baseURL.replace(/\/+$/, "");

  return (modelId: string) => {
    // Return a minimal LanguageModelV1-compatible object that streamText can use.
    // We implement the subset of the interface that streamText actually calls.
    return {
      specificationVersion: "v1",
      provider: "google",
      modelId,

      async doGenerate(options: {
        inputFormat: "messages" | "prompt";
        mode: "regular" | "object" | "tool" | "split";
        prompt: string;
        maxTokens?: number;
        temperature?: number;
        topP?: number;
        headers?: Record<string, string>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools?: any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolChoice?: any;
      }): Promise<unknown> {
        const url = `${apiBase}/models/${modelId}:generateContent`;
        const requestBody: Record<string, unknown> = {
          contents: [{ parts: [{ text: options.prompt }] }],
        };
        if (options.maxTokens)
          requestBody.generationConfig = {
            ...(requestBody.generationConfig as Record<string, unknown>),
            maxOutputTokens: options.maxTokens,
          };
        if (options.temperature !== undefined)
          requestBody.generationConfig = {
            ...(requestBody.generationConfig as Record<string, unknown>),
            temperature: options.temperature,
          };
        if (options.tools && options.tools.length > 0) {
          requestBody.tools = options.tools.map(
            (t: { type?: string; name?: string; description?: string; parameters?: unknown }) => ({
              functionDeclarations: [
                {
                  name: t.name ?? "unknown",
                  description: t.description ?? "",
                  parameters: t.parameters ?? {},
                },
              ],
            }),
          );
        }

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Gemini API error (${res.status}): ${text}`);
        }

        const data = (await res.json()) as GeminiGenerateContentResponse;
        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

        return {
          text,
          finishReason: candidate?.finishReason?.toLowerCase() ?? "stop",
          usage: { promptTokens: 0, completionTokens: 0 },
        };
      },

      async doStream(options: {
        inputFormat: "messages" | "prompt";
        mode: "regular" | "object" | "tool" | "split";
        prompt: string;
        maxTokens?: number;
        temperature?: number;
        topP?: number;
        headers?: Record<string, string>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools?: any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolChoice?: any;
      }) {
        const url = `${apiBase}/models/${modelId}:streamGenerateContent`;
        const requestBody: Record<string, unknown> = {
          contents: [{ parts: [{ text: options.prompt }] }],
        };
        if (options.maxTokens)
          requestBody.generationConfig = {
            ...(requestBody.generationConfig as Record<string, unknown>),
            maxOutputTokens: options.maxTokens,
          };
        if (options.temperature !== undefined)
          requestBody.generationConfig = {
            ...(requestBody.generationConfig as Record<string, unknown>),
            temperature: options.temperature,
          };

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Gemini API error (${res.status}): ${text}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        return {
          stream: new ReadableStream({
            async start(controller) {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  // Parse SSE-like lines: "data: {...}\n\n"
                  const lines = buffer.split("\n");
                  buffer = lines.pop() ?? "";
                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("data: ")) {
                      const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
                      if (!jsonStr) continue;
                      try {
                        const parsed = JSON.parse(jsonStr) as GeminiGenerateContentResponse;
                        const candidate = parsed.candidates?.[0];
                        const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
                        if (text) {
                          controller.enqueue({ type: "text-delta", textDelta: text });
                        }
                      } catch {
                        // skip unparseable chunks
                      }
                    }
                  }
                }
              } catch (e) {
                controller.error(e);
              } finally {
                controller.close();
              }
            },
          }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rawCall: async () => ({ rawResponse: undefined as any }),
        };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// GoogleStrategy
// ---------------------------------------------------------------------------

export class GoogleStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "google";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("google");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    // Approach A: When OAuth Bearer headers are present, use the custom
    // fetch-based provider that sends ONLY the Authorization header (no
    // apiKey / X-Goog-Api-Key). This works with gcloud ADC tokens (Approach B)
    // and self-registered OAuth tokens (Approach C).
    if (opts.headers) {
      const bearerModelFn = createBearerTokenModel(
        opts.baseURL ?? "https://generativelanguage.googleapis.com/v1beta",
        opts.headers,
      );
      return (modelId: string) => bearerModelFn(modelId);
    }
    // Standard API-key path: delegate to @ai-sdk/google.
    const p = createGoogleGenerativeAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    return (modelId: string) => p(modelId);
  }
}
