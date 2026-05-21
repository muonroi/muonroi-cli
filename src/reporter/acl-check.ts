/**
 * src/reporter/acl-check.ts
 *
 * Checks whether a Discord user is authorized to query the reporter
 * for a given product slug. Uses the stakeholder-acl store from P4.
 */

import { listStakeholders } from "../product-loop/stakeholder-acl.js";

export interface AclCheckResult {
  authorized: boolean;
  reason?: string;
  /** displayNames (not @-handles) of current stakeholders, for the informative reply. */
  stakeholderUsernames?: string[];
}

/**
 * Check whether discordUserId is an authorized stakeholder for productSlug.
 * Returns authorized=true when the user appears in the stakeholder list.
 * Returns authorized=false with stakeholderUsernames populated otherwise.
 * Gracefully degrades — on read error returns authorized=false with empty list.
 */
export async function checkStakeholder(productSlug: string, discordUserId: string): Promise<AclCheckResult> {
  let stakeholders;
  try {
    stakeholders = await listStakeholders(productSlug);
  } catch {
    return { authorized: false, reason: "acl_read_error", stakeholderUsernames: [] };
  }

  const isAuthorized = stakeholders.some((s) => s.discordUserId === discordUserId);

  if (isAuthorized) {
    return { authorized: true };
  }

  const names = stakeholders.map((s) => s.displayName);
  return {
    authorized: false,
    reason: "not_stakeholder",
    stakeholderUsernames: names,
  };
}

/**
 * Build the informative unauthorized reply text (per decision #4 in AGILE-FLOW.md).
 */
export function buildUnauthorizedReply(result: AclCheckResult): string {
  if (!result.stakeholderUsernames || result.stakeholderUsernames.length === 0) {
    return "Not authorized. No stakeholders configured for this product.";
  }
  const list = result.stakeholderUsernames.map((u) => `@${u}`).join(", ");
  return `Not authorized. Current stakeholders: ${list}. Contact them to be added.`;
}
