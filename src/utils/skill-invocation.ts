/**
 * User-invoked skills: `/skill <name> [args]` and `/<skill-name> [args]`.
 *
 * Mirrors Claude Code's explicit invocation (https://code.claude.com/docs/en/skills):
 * the rendered SKILL.md body enters the turn as the user's message, with
 * `$ARGUMENTS` substituted. Built-in and registered slash commands always win
 * over a skill with the same name; `/skill <name>` reaches it regardless.
 */

import { type DiscoveredSkill, discoverSkills, findSkill, renderSkillInstructions } from "./skills.js";

export type SkillSlashResolution =
  | { kind: "invoke"; skill: DiscoveredSkill; message: string; display: string }
  | { kind: "error"; text: string };

/** The turn text a user-invoked skill sends to the model. */
export function buildSkillInvocationMessage(skill: DiscoveredSkill, args: string): string {
  const trimmed = args.trim();
  return [
    `The user invoked the skill "${skill.name}"${trimmed ? ` with arguments: ${trimmed}` : ""}. Follow its instructions below for this request; files it mentions are relative to its dir.`,
    "",
    renderSkillInstructions(skill, trimmed),
  ].join("\n");
}

function available(skills: DiscoveredSkill[]): string {
  return skills.length
    ? `Available: ${skills.map((s) => s.name).join(", ")}`
    : "No skills are installed (see /skills).";
}

/**
 * Resolve a typed slash command to a skill invocation. Returns null when the
 * command is not a skill (caller continues its normal dispatch).
 *
 * @param isReservedCommand true for names another command already owns.
 */
export function resolveSkillSlashCommand(
  cmd: string,
  cwd: string,
  isReservedCommand: (name: string) => boolean,
): SkillSlashResolution | null {
  const raw = cmd.trim();
  const m = raw.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const head = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();

  if (head === "skill") {
    const skills = discoverSkills(cwd);
    const sm = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!sm) return { kind: "error", text: `Usage: /skill <name> [args]\n${available(skills)}` };
    const skill = findSkill(skills, sm[1]);
    if (!skill) return { kind: "error", text: `Unknown skill "${sm[1]}". ${available(skills)}` };
    const args = (sm[2] ?? "").trim();
    return { kind: "invoke", skill, message: buildSkillInvocationMessage(skill, args), display: raw };
  }

  if (isReservedCommand(head)) return null;
  const skill = findSkill(discoverSkills(cwd), m[1]);
  if (!skill) return null;
  return { kind: "invoke", skill, message: buildSkillInvocationMessage(skill, rest), display: raw };
}
