/**
 * Skill authoring — validation, SKILL.md scaffolding, and the create flow shared
 * by the `/skill-create` slash command and the model-callable `skill_create`
 * tool. Presentation-agnostic: callers supply an `ask` callback for questions.
 *
 * Format follows the Agent Skills specification
 * (https://agentskills.io/specification): a `<name>/SKILL.md` directory whose
 * YAML frontmatter carries `name` (1-64 chars of a-z, 0-9 and single hyphens,
 * matching the directory) and `description` (1-1024 chars).
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger.js";
import { discoverSkills, findSkill, resetSkillsCache, skillCreateRoot } from "./skills.js";

export type SkillCreateScope = "user" | "project";

export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Names discovery hides or refuses to let a created skill take over. */
const RESERVED_NAME_RE = /^(?:gsd(?:-|$)|muonroi-flow$)/;

/** Returns an error message, or null when `name` is a valid new skill name. */
export function validateSkillName(name: string): string | null {
  if (!name) return "Skill name is required.";
  if (name.length > SKILL_NAME_MAX_CHARS) return `Skill name must be at most ${SKILL_NAME_MAX_CHARS} characters.`;
  if (!SKILL_NAME_RE.test(name))
    return `Invalid skill name "${name}": use lowercase letters, digits and single hyphens (kebab-case), e.g. "release-check".`;
  if (RESERVED_NAME_RE.test(name)) return `Skill name "${name}" is reserved by muonroi-cli.`;
  return null;
}

/** Returns an error message, or null when `description` is acceptable. */
export function validateSkillDescription(description: string): string | null {
  if (!description.trim()) return "Skill description is required: say what the skill does and when to use it.";
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS)
    return `Skill description must be at most ${SKILL_DESCRIPTION_MAX_CHARS} characters.`;
  return null;
}

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

function titleFromName(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** SKILL.md text. The description is a JSON-escaped YAML double-quoted scalar. */
export function buildSkillMarkdown(input: { name: string; description: string; instructions?: string }): string {
  const description = normalizeDescription(input.description);
  const body = input.instructions?.trim()
    ? input.instructions.trim()
    : [
        `# ${titleFromName(input.name)}`,
        "",
        "## When to use",
        "",
        description,
        "",
        "## Instructions",
        "",
        "1. Describe the first step.",
        "2. Describe how to verify the result.",
        "",
        "Arguments passed with `/skill " + input.name + " <args>` replace $ARGUMENTS.",
      ].join("\n");
  return `---\nname: ${input.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

export interface CreateSkillInput {
  cwd: string;
  name: string;
  description: string;
  scope: SkillCreateScope;
  instructions?: string;
  /** Replace an existing SKILL.md. Callers must have the user's confirmation. */
  overwrite?: boolean;
}

export type CreateSkillResult =
  | { ok: true; path: string; scope: SkillCreateScope; overwritten: boolean; note?: string }
  | { ok: false; code: "invalid" | "exists" | "io"; error: string; path?: string };

/** Absolute SKILL.md path a skill of `name`/`scope` would be written to (no validation). */
export function skillTargetPath(cwd: string, scope: SkillCreateScope, name: string): string {
  return path.join(skillCreateRoot(scope, cwd), name, "SKILL.md");
}

/**
 * Write `<skills root>/<name>/SKILL.md`. Only inside the scope's skills root;
 * never replaces an existing file unless `overwrite` is set. Invalidates the
 * discovery cache so the skill is usable in the same session.
 */
export function createSkill(input: CreateSkillInput): CreateSkillResult {
  const name = input.name.trim();
  const nameError = validateSkillName(name);
  if (nameError) return { ok: false, code: "invalid", error: nameError };
  const descriptionError = validateSkillDescription(input.description);
  if (descriptionError) return { ok: false, code: "invalid", error: descriptionError };
  if (input.scope !== "user" && input.scope !== "project")
    return { ok: false, code: "invalid", error: 'scope must be "user" or "project".' };

  const root = path.resolve(skillCreateRoot(input.scope, input.cwd));
  const dir = path.resolve(root, name);
  // Defense in depth: the name regex already excludes separators and dots.
  if (path.relative(root, dir) !== name)
    return { ok: false, code: "invalid", error: `Skill name "${name}" escapes the skills directory.` };
  const target = path.join(dir, "SKILL.md");
  const exists = fs.existsSync(target);
  if (exists && !input.overwrite)
    return {
      ok: false,
      code: "exists",
      path: target,
      error: `A skill already exists at ${target}. It was not changed.`,
    };

  const before = discoverSkills(input.cwd);
  const existing = findSkill(before, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, buildSkillMarkdown({ ...input, name }), "utf-8");
  } catch (error) {
    logger.file("error", "skills", "Could not write skill", { target, error: String(error) });
    return { ok: false, code: "io", path: target, error: `Could not write ${target}: ${String(error)}` };
  }
  resetSkillsCache();
  logger.file("info", "skills", "Skill created", { target, scope: input.scope, overwritten: exists });
  const active = findSkill(discoverSkills(input.cwd), name);
  const same = (p?: string) => p !== undefined && path.resolve(p) === path.resolve(target);
  const note = !active
    ? "Discovery did not pick it up; check the file."
    : !same(active.skillMdPath)
      ? `${active.skillMdPath} has the same name and takes precedence; use a different name or scope.`
      : existing && !same(existing.skillMdPath)
        ? `It now takes precedence over ${existing.skillMdPath}.`
        : undefined;
  return { ok: true, path: target, scope: input.scope, overwritten: exists, ...(note ? { note } : {}) };
}

/** Parsed `/skill-create [name] [--project|--user|--scope=x] [description...]`. */
export interface SkillCreateArgs {
  name?: string;
  scope?: SkillCreateScope;
  description?: string;
}

export function parseSkillCreateArgs(argsText: string): SkillCreateArgs {
  const out: SkillCreateArgs = {};
  const rest: string[] = [];
  for (const token of argsText.trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === "--user" || lower === "--project") {
      out.scope = lower.slice(2) as SkillCreateScope;
    } else if (lower === "--scope=user" || lower === "--scope=project") {
      out.scope = lower.slice("--scope=".length) as SkillCreateScope;
    } else if (out.name === undefined && rest.length === 0) {
      out.name = token;
    } else {
      rest.push(token);
    }
  }
  const description = rest
    .join(" ")
    .replace(/^["']|["']$/g, "")
    .trim();
  if (description) out.description = description;
  return out;
}

export interface SkillCreateQuestion {
  question: string;
  context?: string;
  /** Omitted → free-text answer. */
  options?: Array<{ label: string; value: string; description?: string }>;
  defaultIndex?: number;
}

/** Ask the human; resolves null when they dismiss the question. */
export type SkillCreateAsk = (q: SkillCreateQuestion) => Promise<string | null>;

export interface SkillCreateFlowResult {
  ok: boolean;
  message: string;
  path?: string;
}

/**
 * Interactive create flow: asks only for what `argsText` did not supply
 * (name, description, scope), confirms before replacing an existing skill, and
 * writes the scaffold. A dismissed question ends the flow with nothing written.
 */
export async function runSkillCreateFlow(opts: {
  cwd: string;
  argsText: string;
  ask: SkillCreateAsk;
}): Promise<SkillCreateFlowResult> {
  const cancelled: SkillCreateFlowResult = { ok: false, message: "Skill creation cancelled. Nothing was written." };
  const parsed = parseSkillCreateArgs(opts.argsText);

  let name = parsed.name?.trim();
  if (!name) {
    const answer = await opts.ask({
      question: "Skill name?",
      context: "kebab-case: lowercase letters, digits and hyphens, e.g. release-check",
    });
    if (answer === null) return cancelled;
    name = answer.trim();
  }
  const nameError = validateSkillName(name);
  if (nameError) return { ok: false, message: `${nameError} Nothing was written.` };

  let description = parsed.description;
  if (!description) {
    const answer = await opts.ask({
      question: `What does "${name}" do, and when should it be used?`,
      context: "One or two sentences; this is all the model sees until the skill is loaded.",
    });
    if (answer === null) return cancelled;
    description = answer;
  }
  const descriptionError = validateSkillDescription(description);
  if (descriptionError) return { ok: false, message: `${descriptionError} Nothing was written.` };

  let scope = parsed.scope;
  if (!scope) {
    const answer = await opts.ask({
      question: `Where should "${name}" live?`,
      options: [
        {
          label: "This project",
          value: "project",
          description: skillTargetPath(opts.cwd, "project", name),
        },
        { label: "My user skills", value: "user", description: skillTargetPath(opts.cwd, "user", name) },
      ],
      defaultIndex: 0,
    });
    if (answer === null) return cancelled;
    if (answer !== "project" && answer !== "user") return cancelled;
    scope = answer;
  }

  let result = createSkill({ cwd: opts.cwd, name, description, scope });
  if (!result.ok && result.code === "exists") {
    const answer = await opts.ask({
      question: `Skill "${name}" already exists. Replace it?`,
      context: result.path,
      options: [
        { label: "Keep the existing skill", value: "keep" },
        { label: "Overwrite it", value: "overwrite", description: "Its SKILL.md is replaced by a new scaffold." },
      ],
      defaultIndex: 0,
    });
    if (answer !== "overwrite") return { ok: false, message: `Kept the existing skill at ${result.path}.` };
    result = createSkill({ cwd: opts.cwd, name, description, scope, overwrite: true });
  }
  if (!result.ok) return { ok: false, message: result.error };
  const lines = [
    `${result.overwritten ? "Replaced" : "Created"} skill "${name}" (${scope}) at ${result.path}`,
    `Edit its instructions there, then use it with /skill ${name} [args] or /${name}. The model can load it with skill_load.`,
  ];
  if (result.note) lines.push(result.note);
  return { ok: true, message: lines.join("\n"), path: result.path };
}
