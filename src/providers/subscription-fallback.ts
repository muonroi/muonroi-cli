import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { appendDecisionLog } from "../usage/decision-log.js";
import { logger } from "../utils/logger.js";
import { reportRetryNotice } from "../utils/visible-retry.js";
import type { ProviderEndpoints } from "./endpoints.js";
import type { ProviderId } from "./types.js";

export type ProviderAuthMode = "subscription" | "api-key";
type Reason = "authentication" | "entitlement" | "model-support" | "quota";

/** Only explicit auth/entitlement failures authorize a change of billing source. */
export function subscriptionFallbackReason(
  error: unknown,
  entitlementError?: NonNullable<ProviderEndpoints["subscription"]>["entitlementError"],
): Reason | undefined {
  let value = error;
  for (let depth = 0; depth < 5 && value && typeof value === "object"; depth++) {
    const item = value as Record<string, unknown>;
    if (item.name === "AbortError") return undefined;
    let body: Record<string, unknown> = item;
    if (typeof item.responseBody === "string") {
      try {
        body = JSON.parse(item.responseBody);
      } catch (err) {
        logger.file("debug", "cli", `[auth-fallback] non-JSON error body: ${(err as Error).message}`);
      }
    }
    const detail = (body?.error && typeof body.error === "object" ? body.error : body) as Record<string, unknown>;
    const code = String(detail?.code ?? item.code ?? "").toLowerCase();
    // Rate limits and content policy are not subscription exhaustion.
    if (["rate_limit_exceeded", "slow_down", "content_policy_violation"].includes(code)) return undefined;
    if (
      entitlementError &&
      (item.statusCode ?? item.status) === entitlementError.statusCode &&
      detail?.type === entitlementError.type &&
      detail?.message === entitlementError.message
    )
      return "entitlement";
    if (item.statusCode === 401 || item.status === 401) return "authentication";
    if (["subscription_expired", "subscription_required", "plan_expired", "subscription_not_active"].includes(code))
      return "entitlement";
    if (["model_not_supported", "unsupported_model", "model_access_denied"].includes(code)) return "model-support";
    if (
      [
        "usage_limit_reached",
        "insufficient_quota",
        "quota_exceeded",
        "credit_balance_exhausted",
        "organization_spend_limit_exceeded",
      ].includes(code)
    )
      return "quota";
    value = item.cause;
  }
  return undefined;
}

/** Factory-local latch: model support failures must not move other models to API billing. */
export function createSubscriptionFallback(
  providerId: ProviderId,
  entitlementError?: NonNullable<ProviderEndpoints["subscription"]>["entitlementError"],
) {
  let providerFallback = false;
  const modelFallbacks = new Set<string>();
  const authModeForModel = (modelId: string): ProviderAuthMode =>
    providerFallback || modelFallbacks.has(modelId) ? "api-key" : "subscription";
  const activate = (modelId: string, error: unknown, signal?: AbortSignal): boolean => {
    if (signal?.aborted) return false;
    const reason = subscriptionFallbackReason(error, entitlementError);
    if (!reason) return false;
    if (reason === "model-support") modelFallbacks.add(modelId);
    else providerFallback = true;
    // Never log error bodies or credentials; only the bounded classification.
    logger.file("info", "cli", `[auth-fallback] ${providerId}/${modelId}: ${reason}; using configured API key`);
    void appendDecisionLog({
      ts: Date.now(),
      kind: "auth-fallback",
      taken: true,
      reason,
      meta: { providerId, modelId, authMode: "api-key" },
    });
    reportRetryNotice(
      `[auth] ${providerId}/${modelId}: subscription ${reason} failure; using configured API key.`,
      "info",
    );
    return true;
  };
  const wrap = (
    primary: LanguageModelV3,
    backup: () => LanguageModelV3,
    unsupported: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP"> = [],
  ): LanguageModelV3 => {
    const modelId = primary.modelId;
    return wrapLanguageModel({
      model: primary,
      middleware: {
        specificationVersion: "v3",
        wrapGenerate: async ({ params }) => {
          if (authModeForModel(modelId) === "api-key") return backup().doGenerate(params);
          const oauthParams = { ...params };
          for (const key of unsupported) delete oauthParams[key];
          try {
            return await primary.doGenerate(oauthParams);
          } catch (error) {
            if (!activate(modelId, error, params.abortSignal)) throw error;
            return backup().doGenerate(params);
          }
        },
        wrapStream: async ({ params }) => {
          if (authModeForModel(modelId) === "api-key") return backup().doStream(params);
          const oauthParams = { ...params };
          for (const key of unsupported) delete oauthParams[key];
          let response: Awaited<ReturnType<LanguageModelV3["doStream"]>>;
          try {
            response = await primary.doStream(oauthParams);
          } catch (error) {
            if (!activate(modelId, error, params.abortSignal)) throw error;
            return backup().doStream(params);
          }
          let reader = response.stream.getReader();
          let meaningful = false;
          let prelude: LanguageModelV3StreamPart[] = [];
          let switched = false;
          return {
            ...response,
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              async pull(controller) {
                try {
                  for (;;) {
                    const next = await reader.read();
                    if (next.done) {
                      for (const part of prelude) controller.enqueue(part);
                      prelude = [];
                      controller.close();
                      return;
                    }
                    const part = next.value;
                    if (
                      !meaningful &&
                      !switched &&
                      part.type === "error" &&
                      activate(modelId, part.error, params.abortSignal)
                    ) {
                      await reader.cancel();
                      const fallback = await backup().doStream(params);
                      reader = fallback.stream.getReader();
                      prelude = [];
                      switched = true;
                      continue;
                    }
                    if (
                      !meaningful &&
                      !switched &&
                      prelude.length < 16 &&
                      ["stream-start", "response-metadata"].includes(part.type)
                    ) {
                      prelude.push(part);
                      continue;
                    }
                    meaningful = true;
                    for (const entry of prelude) controller.enqueue(entry);
                    prelude = [];
                    controller.enqueue(part);
                    return;
                  }
                } catch (error) {
                  logger.file(
                    "debug",
                    "cli",
                    `[auth-fallback] stream failed for ${providerId}/${modelId}: ${(error as Error).message}`,
                  );
                  controller.error(error);
                }
              },
              async cancel(reason) {
                try {
                  await reader.cancel(reason);
                } catch (error) {
                  logger.file(
                    "debug",
                    "cli",
                    `[auth-fallback] stream cancellation failed: ${(error as Error).message}`,
                  );
                }
              },
            }),
          };
        },
      },
    });
  };
  return { wrap, authModeForModel };
}
