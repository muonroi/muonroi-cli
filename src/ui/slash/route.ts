/**
 * src/ui/slash/route.ts
 *
 * /route slash command handler (ROUTE-05).
 * Prints next-prompt routing decision: tier, model, provider, reason.
 * Includes cap-driven note when cap_overridden is true.
 *
 * Self-registers on module import — call once from src/index.ts boot path
 * or import in test to trigger registration.
 */

import { decide } from "../../router/decide.js";
import { getRoutingPolicy, isRoutingMode } from "../../router/policy.js";
import { statusBarStore } from "../../state/status-bar-store.js";
import { getRoutingDemoteMin, getRoutingPromoteMax, saveProjectSettings } from "../../utils/settings.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleRouteSlash: SlashHandler = async (args, ctx) => {
  if (args[0] === "mode") {
    if (args.length !== 2 || !isRoutingMode(args[1])) return "Usage: /route mode fixed|auto|suggest";
    saveProjectSettings({ routingMode: args[1] }, ctx.cwd);
    statusBarStore.setState({ routing_mode: args[1], suggested_model: undefined });
    return `Routing mode: ${args[1]} (project: ${ctx.cwd}). Legacy worker routing preference saved. Main remains the provider flagship orchestrator; main explicitly selects workers.`;
  }
  const policy = getRoutingPolicy(ctx.cwd);
  if (args[0] === "status" && args.length === 1) {
    const state = statusBarStore.getState();
    return [
      `Routing mode: ${policy.mode} (${policy.source})`,
      `Orchestrator: ${ctx.defaultProvider}/${ctx.defaultModel}`,
      `Promotion ceiling: ${getRoutingPromoteMax()}; demotion floor: ${getRoutingDemoteMin()}`,
      ...(policy.mode === "suggest" && state.routing_mode === "suggest" && state.suggested_model
        ? [`Last suggestion: ${state.suggested_model}`]
        : []),
      "Main remains the provider flagship orchestrator in every routing mode. Main explicitly chooses worker models; EE never selects them.",
      "Change project policy: /route mode fixed|auto|suggest",
    ].join("\n");
  }
  const prompt = args.join(" ") || ctx.lastPrompt || "";
  if (!prompt) {
    return "/route: no recent prompt — type a prompt first or pass it as argument: /route <prompt>";
  }

  const d = await decide(prompt, {
    tenantId: ctx.tenantId,
    cwd: ctx.cwd,
    defaultModel: ctx.defaultModel,
    defaultProvider: ctx.defaultProvider,
    routingMode: policy.mode,
    ...(policy.mode === "fixed"
      ? {
          forcedModel: ctx.defaultModel,
          forcedReason: policy.source === "project-model-pin" ? "project-model-pin" : "routing-mode-fixed",
        }
      : {}),
  });

  const lines = [
    "Worker routing preview only; this does not change the main flagship orchestrator.",
    `Tier:     ${d.tier}`,
    `Provider: ${d.provider}`,
    `Model:    ${d.model}`,
    `Reason:   ${d.reason}`,
  ];
  lines.push(`Routing mode: ${d.routingMode ?? policy.mode} (${policy.source})`);
  if (d.suggestedModel) lines.push(`Suggestion: ${d.suggestedModel} (${d.suggestedReason})`);

  if (typeof d.confidence === "number") {
    lines.push(`Confidence: ${d.confidence.toFixed(2)}`);
  }

  if (d.cap_overridden) {
    lines.push(`Cap-driven: yes (downgrade applied)`);
  }

  return lines.join("\n");
};

// Self-register on module import
registerSlash("route", handleRouteSlash);
