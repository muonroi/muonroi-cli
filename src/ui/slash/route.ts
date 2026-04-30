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

import { decide } from '../../router/decide.js';
import type { SlashContext, SlashHandler } from './registry.js';
import { registerSlash } from './registry.js';

export const handleRouteSlash: SlashHandler = async (args, ctx) => {
  const prompt = args.join(' ') || ctx.lastPrompt || '';
  if (!prompt) {
    return '/route: no recent prompt — type a prompt first or pass it as argument: /route <prompt>';
  }

  const d = await decide(prompt, {
    tenantId: ctx.tenantId,
    cwd: ctx.cwd,
    defaultModel: ctx.defaultModel,
    defaultProvider: ctx.defaultProvider,
  });

  const lines = [
    `Tier:     ${d.tier}`,
    `Provider: ${d.provider}`,
    `Model:    ${d.model}`,
    `Reason:   ${d.reason}`,
  ];

  if (typeof d.confidence === 'number') {
    lines.push(`Confidence: ${d.confidence.toFixed(2)}`);
  }

  if (d.cap_overridden) {
    lines.push(`Cap-driven: yes (downgrade applied)`);
  }

  return lines.join('\n');
};

// Self-register on module import
registerSlash('route', handleRouteSlash);
