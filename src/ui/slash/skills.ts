/**
 * /skills — list discovered Agent Skills with scope and SKILL.md path.
 *
 * Re-reads disk on every call (resetSkillsCache) so a skill dropped into a
 * skills directory mid-session shows up without a restart. `/skill <name>` and
 * `/skill-create` are handled in use-app-logic's handleCommand because they
 * start a model turn or open askcards.
 */

import { discoverSkills, formatSkillsForChat, resetSkillsCache } from "../../utils/skills.js";
import { registerSlash, type SlashContext } from "./registry.js";

export function handleSkillsSlash(_args: string[], ctx: SlashContext): string {
  resetSkillsCache();
  return formatSkillsForChat(discoverSkills(ctx.cwd), ctx.cwd);
}

registerSlash("skills", handleSkillsSlash);
