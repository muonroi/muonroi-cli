/**
 * Model-callable skill tools.
 *
 * - `skill_load` (read-only; main and workers): the progressive-disclosure
 *   step — the prompt carries only names/descriptions, this returns one skill's
 *   full instructions plus the files bundled with it.
 * - `skill_create` (main only): writes a new `<name>/SKILL.md` inside the
 *   user or project skills directory. Names are validated (kebab-case, no path
 *   separators) and an existing skill is replaced only after the host itself
 *   asks the human; without an answerer it is refused.
 */

import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { ASK_USER_DISMISSED, type AskUserAskInfo } from "../orchestrator/ask-user.js";
import { logger } from "../utils/logger.js";
import { createSkill, type SkillCreateScope, skillTargetPath } from "../utils/skill-authoring.js";
import { discoverSkills, findSkill, listSkillResources, renderSkillInstructions } from "../utils/skills.js";

/** Same ceiling as the registry's per-tool output cap; a body past it is read with read_file. */
const SKILL_LOAD_MAX_CHARS = 32_000;

/** Raw model input; every field is re-checked at runtime. */
type SkillToolInput = Record<string, unknown> | undefined;

function asInput(raw: unknown): SkillToolInput {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

export interface SkillToolOptions {
  /** Register skill_create (main only; never for workers). */
  allowCreate: boolean;
  /** Host-side confirmation before replacing an existing skill. */
  askUser?: (info: AskUserAskInfo) => Promise<string>;
}

export function loadSkillForModel(cwd: string, name: string, args = ""): string {
  const skills = discoverSkills(cwd);
  const skill = findSkill(skills, name);
  if (!skill) {
    return `ERROR: No skill named "${name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`;
  }
  let text: string;
  try {
    text = renderSkillInstructions(skill, args);
  } catch (error) {
    logger.file("warn", "skills", "skill_load could not read SKILL.md", {
      path: skill.skillMdPath,
      error: String(error),
    });
    return `ERROR: Could not read ${skill.skillMdPath}: ${String(error)}`;
  }
  if (text.length > SKILL_LOAD_MAX_CHARS) {
    text = `${text.slice(0, SKILL_LOAD_MAX_CHARS)}\n... [truncated; read the rest with read_file on ${skill.skillMdPath}]`;
  }
  const resources = listSkillResources(skill);
  const resourceLines = resources.files.length
    ? [
        `Bundled files (relative to ${skill.rootDir}; read with read_file only when the instructions need them):`,
        ...resources.files.map((f) => `- ${f}`),
        ...(resources.truncated ? ["- ...more files not listed"] : []),
      ]
    : [];
  return [`Skill "${skill.name}" [${skill.scope}] from ${skill.skillMdPath}`, text, ...resourceLines].join("\n");
}

export function registerSkillTools(tools: ToolSet, cwd: () => string, opts: SkillToolOptions): void {
  tools.skill_load = dynamicTool({
    description:
      "Load an Agent Skill's full instructions by name (names are listed under AGENT SKILLS in your instructions). Call it when a skill fits the request or the user names one, then follow the returned instructions. Returns the SKILL.md body and its bundled files. Loading grants no permission.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 128, description: "Skill name from the index." },
        arguments: {
          type: "string",
          maxLength: 4000,
          description: "Optional arguments substituted for $ARGUMENTS in the skill.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    }),
    execute: async (raw: unknown, execution: { abortSignal?: AbortSignal } | undefined) => {
      execution?.abortSignal?.throwIfAborted();
      const input = asInput(raw);
      const name = typeof input?.name === "string" ? input.name : "";
      if (!name.trim()) return "ERROR: skill_load requires a skill `name`.";
      return loadSkillForModel(cwd(), name, typeof input?.arguments === "string" ? input.arguments : "");
    },
  });

  if (!opts.allowCreate) return;
  const askUser = opts.askUser;
  tools.skill_create = dynamicTool({
    description:
      'Create a new Agent Skill (SKILL.md) when the user asks you to make/save a skill. Writes only <skills dir>/<name>/SKILL.md: scope "project" = this repository\'s .agents/skills, "user" = the user\'s muonroi-cli skills. name must be kebab-case (a-z, 0-9, hyphens, <=64). description says what it does AND when to use it (<=1024). instructions is the Markdown body (steps, checks; $ARGUMENTS receives invocation arguments). Never overwrites silently: an existing skill is replaced only when overwrite=true AND the user confirms in a prompt this tool shows. Usable immediately via skill_load and /skill <name>.',
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        description: { type: "string", minLength: 1, maxLength: 1024 },
        scope: { type: "string", enum: ["project", "user"] },
        instructions: { type: "string", maxLength: 20000, description: "Markdown body of SKILL.md." },
        overwrite: { type: "boolean", description: "Replace an existing skill (asks the user first)." },
      },
      required: ["name", "description", "scope"],
      additionalProperties: false,
    }),
    execute: async (raw: unknown, execution: { abortSignal?: AbortSignal } | undefined) => {
      execution?.abortSignal?.throwIfAborted();
      const input = asInput(raw);
      const dir = cwd();
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      const scope = input?.scope as SkillCreateScope;
      const base = {
        cwd: dir,
        name,
        description: typeof input?.description === "string" ? input.description : "",
        scope,
        instructions: typeof input?.instructions === "string" ? input.instructions : undefined,
      };
      let result = createSkill(base);
      if (!result.ok && result.code === "exists") {
        if (input?.overwrite !== true) {
          return `ERROR: ${result.error} To replace it, call skill_create again with overwrite=true; the user will be asked to confirm.`;
        }
        if (!askUser) {
          return `ERROR: ${result.error} Replacing a skill needs the user's confirmation and no interactive answerer is available.`;
        }
        const answer = await askUser({
          question: `Replace the existing skill "${name}"?`,
          context: skillTargetPath(dir, scope, name),
          options: [
            { label: "Keep the existing skill", value: "keep" },
            { label: "Overwrite it", value: "overwrite" },
          ],
          defaultIndex: 0,
        });
        if (answer !== "overwrite") {
          return `NOT CHANGED: the user ${answer === ASK_USER_DISMISSED ? "dismissed the prompt" : "chose to keep the existing skill"} at ${result.path}.`;
        }
        result = createSkill({ ...base, overwrite: true });
      }
      if (!result.ok) return `ERROR: ${result.error}`;
      return [
        `${result.overwritten ? "Replaced" : "Created"} skill "${name}" (${result.scope}) at ${result.path}.`,
        `It is available now: skill_load("${name}"), and the user can run /skill ${name}.`,
        ...(result.note ? [result.note] : []),
      ].join("\n");
    },
  });
}
