import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findGitRoot } from "./git-root";
import { logger } from "./logger.js";
import { muonroiHome } from "./muonroi-home.js";

export type SkillScope = "project" | "user" | "builtin";

export interface DiscoveredSkill {
  name: string;
  description: string;
  skillMdPath: string;
  rootDir: string;
  scope: SkillScope;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    // A YAML double-quoted scalar uses JSON-compatible escapes for the common
    // cases; skill_create writes descriptions this way, so `"` and `\` inside
    // one must round-trip instead of surfacing as `\"`.
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
    } catch (error) {
      logger.file("debug", "skills", "Double-quoted frontmatter value is not JSON-escaped; using raw text", {
        error: String(error),
      });
    }
    return t.slice(1, -1).replace(/\\n/g, "\n");
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Minimal YAML frontmatter key extraction for flat `key: value` and optional `|` / `>` blocks after description. */
function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const lines = raw.split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameM = line.match(/^name:\s*(.*)$/);
    if (nameM) {
      const rest = nameM[1].trim();
      out.name = stripQuotes(rest);
      continue;
    }
    const descM = line.match(/^description:\s*(.*)$/);
    if (descM) {
      const rest = descM[1].trim();
      if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
        i++;
        const block: string[] = [];
        while (i < lines.length) {
          const L = lines[i];
          if (L.match(/^[a-zA-Z0-9_-]+:\s/) && !/^\s/.test(L)) break;
          if (/^\s/.test(L) || (block.length > 0 && L === "")) {
            block.push(L.replace(/^\s+/, ""));
            i++;
          } else if (block.length > 0) {
            break;
          } else {
            break;
          }
        }
        i--;
        out.description = block.join("\n").trim();
      } else {
        out.description = stripQuotes(rest);
      }
    }
  }
  return out;
}

function extractFrontmatter(fileContent: string): { frontmatter: string; ok: boolean } {
  const trimmed = fileContent.trimStart();
  if (!trimmed.startsWith("---")) return { frontmatter: "", ok: false };
  const afterFirst = trimmed.slice(3).split(/\r?\n/);
  const restLines = afterFirst.slice(1);
  const end = restLines.findIndex((l) => l.trim() === "---");
  if (end < 0) return { frontmatter: "", ok: false };
  return { frontmatter: restLines.slice(0, end).join("\n"), ok: true };
}

function loadSkillFromDir(rootDir: string, scope: SkillScope): DiscoveredSkill | null {
  const skillMdPath = path.join(rootDir, "SKILL.md");
  try {
    if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) return null;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, ok } = extractFrontmatter(content);
    if (!ok) {
      logger.file("warn", "skills", "Skill has no valid frontmatter", { skillMdPath });
      return null;
    }
    const meta = parseSkillFrontmatter(frontmatter);
    const name = meta.name?.trim();
    const description = meta.description?.trim();
    if (!name || !description) {
      logger.file("warn", "skills", "Skill metadata is incomplete", { skillMdPath });
      return null;
    }
    // Shared installations belong to other clients. Do not advertise their legacy workflow here.
    if (/^gsd(?:-|$)/i.test(name) || /^gsd(?:-|$)/i.test(path.basename(rootDir))) return null;
    return {
      name,
      description,
      skillMdPath: path.resolve(skillMdPath),
      rootDir: path.resolve(rootDir),
      scope,
    };
  } catch (error) {
    logger.file("warn", "skills", "Could not read skill", { skillMdPath, error: String(error) });
    return null;
  }
}

/**
 * Round 4 (G10): a `Dirent` for a symlink is not a directory — `e.isDirectory()`
 * is false for it even when the link resolves to one, so a symlinked skill dir
 * (e.g. Shipd's `.agents/skills/shipd-challenge -> ../../shipd-verify/skill`,
 * matching Claude Code's own support for symlinked skill dirs) was silently
 * invisible here. `e.isSymbolicLink()` gets a `statSync` follow-through instead;
 * a dangling link (target missing) or a link to a plain file is skipped, not
 * thrown — same "just don't list it" behaviour as any other non-directory entry.
 */
function listSkillDirectories(skillsRoot: string): string[] {
  try {
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) return [];
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(skillsRoot, e.name);
      if (e.isDirectory()) {
        dirs.push(full);
        continue;
      }
      if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(full).isDirectory()) dirs.push(full);
        } catch (error) {
          logger.file("warn", "skills", "Could not resolve skill symlink", { full, error: String(error) });
          // Dangling symlink (target does not exist) — skip silently.
        }
      }
    }
    return dirs.sort();
  } catch (error) {
    logger.file("warn", "skills", "Could not enumerate skill root", { skillsRoot, error: String(error) });
    return [];
  }
}

/**
 * Project skill roots, outermost first: `.agents/skills` in every directory
 * from the git root down to `projectRoot` (the span Codex scans).
 *
 * Outside a git repository only `projectRoot` itself is scanned. The walk used
 * to run to the filesystem root, so a non-git cwd under the home directory
 * re-listed `~/.agents/skills` labelled "project" — measured by the skills
 * harness audit: a temp cwd with HOME isolated still listed the developer's
 * real ~/.agents/skills entries (qc-flow, qc-lock, shipd-*).
 */
function listProjectSkillRoots(projectRoot: string): string[] {
  const start = path.resolve(projectRoot);
  const gitRoot = findGitRoot(start);
  if (!gitRoot) return [path.join(start, ".agents", "skills")];
  const roots: string[] = [];
  let current = start;

  while (true) {
    roots.push(path.join(current, ".agents", "skills"));
    if (current === gitRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots.reverse();
}

/** CLI-owned home, honouring MUONROI_CLI_HOME like every other CLI store. */
function cliHomeDir(): string {
  return muonroiHome();
}

/**
 * User-level skill roots in ascending precedence. `~/.agents/skills` is the
 * cross-client location (Codex reads it too); `<cli home>/skills` is
 * muonroi-cli's own, and is where user-scope skills are created.
 */
export function userSkillRoots(): string[] {
  return [path.join(os.homedir(), ".agents", "skills"), path.join(cliHomeDir(), "skills")];
}

/** Directory a newly created skill of `scope` is written under. */
export function skillCreateRoot(scope: "user" | "project", cwd: string): string {
  if (scope === "user") return path.join(cliHomeDir(), "skills");
  const start = path.resolve(cwd);
  return path.join(findGitRoot(start) ?? start, ".agents", "skills");
}

// --- Skills discovery cache ---
let _skillsCache: { skills: DiscoveredSkill[]; cachedAt: number; cwd: string } | null = null;
const SKILLS_CACHE_TTL_MS = 120_000; // 2 minutes — skills almost never change mid-session
let _skillsGeneration = 0;

/**
 * Drop the discovery cache so the next lookup re-reads disk. Called after a
 * skill is created and by `/skills`; it also bumps {@link skillsGeneration} so
 * the system-prompt prefix cache, which embeds the index, misses too.
 */
export function resetSkillsCache(): void {
  _skillsCache = null;
  _skillsGeneration++;
}

/** Monotonic counter that changes whenever the skills cache is invalidated. */
export function skillsGeneration(): number {
  return _skillsGeneration;
}

/**
 * Discover Agent Skills under ~/.agents/skills, <cli home>/skills and
 * `.agents/skills` from the git root down to <projectRoot>. The nearest
 * project-level skill overrides user-level and higher project skills with the
 * same frontmatter `name`; the bundled muonroi-flow skill cannot be replaced.
 */
export function discoverSkills(projectRoot: string): DiscoveredSkill[] {
  const now = Date.now();
  if (_skillsCache && _skillsCache.cwd === projectRoot && now - _skillsCache.cachedAt < SKILLS_CACHE_TTL_MS) {
    return _skillsCache.skills;
  }

  const byName = new Map<string, DiscoveredSkill>();

  for (const userRoot of userSkillRoots()) {
    for (const dir of listSkillDirectories(userRoot)) {
      const s = loadSkillFromDir(dir, "user");
      if (s) byName.set(s.name, s);
    }
  }
  for (const skillsRoot of listProjectSkillRoots(projectRoot)) {
    for (const dir of listSkillDirectories(skillsRoot)) {
      const s = loadSkillFromDir(dir, "project");
      if (s) byName.set(s.name, s);
    }
  }

  // CLI-owned workflow is packaged with the runtime and cannot be replaced by a shared skill.
  const builtin = loadSkillFromDir(
    fileURLToPath(new URL("../workflow/skills/muonroi-flow/", import.meta.url)),
    "builtin",
  );
  if (builtin) byName.set(builtin.name, builtin);
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  _skillsCache = { skills, cachedAt: now, cwd: projectRoot };
  return skills;
}

const SKILLS_INSTRUCTIONS = `AGENT SKILLS (optional):
The following <available_skills> list specialized workflows. Use them when they might help the user's request — not only on exact keyword matches.
If a skill's description fits the task or could improve consistency, load it first with skill_load(name) (or read_file on <location>), then follow the SKILL.md body.
Paths inside a skill (scripts/, references/, assets/) are relative to the skill directory (the folder containing SKILL.md); prefer absolute paths in tool calls.`;

/**
 * Upper bound on the compact index in the system prompt. Codex caps its initial
 * skill list at 8,000 characters when the context window is unknown
 * (https://learn.chatgpt.com/docs/build-skills); this index is re-sent on every
 * call, so it stays below that. Skills past the cap stay reachable through
 * skill_load / context_load(topic=skills).
 */
export const SKILLS_INDEX_MAX_CHARS = 6000;
/** Worker prompts carry names only, under a much smaller budget. */
export const WORKER_SKILLS_INDEX_MAX_CHARS = 1200;

/** OpenCode-style XML catalog plus activation instructions. Returns null if no skills. */
export function formatSkillsForPrompt(skills: DiscoveredSkill[]): string | null {
  if (skills.length === 0) return null;
  const parts = skills.map(
    (s) =>
      `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.skillMdPath)}</location>\n  </skill>`,
  );
  return `${SKILLS_INSTRUCTIONS}\n\n<available_skills>\n${parts.join("\n")}\n</available_skills>`;
}

function boundedLines(lines: string[], maxChars: number, overflow: (remaining: number) => string): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    if (used + lines[i].length + 1 > maxChars) {
      kept.push(overflow(lines.length - i));
      break;
    }
    kept.push(lines[i]);
    used += lines[i].length + 1;
  }
  return kept.join("\n");
}

/** Names plus abbreviated descriptions; bodies load on demand through skill_load. */
export function formatCompactSkillsForPrompt(skills: DiscoveredSkill[]): string | null {
  if (!skills.length) return null;
  return (
    "AGENT SKILLS: compact index (descriptions abbreviated). When a skill fits the request, call skill_load(name) and follow the returned instructions; context_load(topic=skills, query=<name or topic>) searches full metadata/paths. Do not omit user-named or repo-required skills. To author a new skill the user asks for, call skill_create.\n" +
    boundedLines(
      skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 72)}`),
      SKILLS_INDEX_MAX_CHARS,
      (n) => `- ...and ${n} more (context_load topic=skills lists them)`,
    )
  );
}

/** Worker index: names only and bounded; the owning main names the skill to use. */
export function formatWorkerSkillsForPrompt(skills: DiscoveredSkill[]): string | null {
  if (!skills.length) return null;
  const header =
    "AGENT SKILLS available via skill_load(name); load one only when the delegated task names it or clearly needs it: ";
  let out = header;
  for (let i = 0; i < skills.length; i++) {
    const piece = (i ? ", " : "") + skills[i].name;
    if (out.length + piece.length > WORKER_SKILLS_INDEX_MAX_CHARS) {
      out += `, ...and ${skills.length - i} more`;
      break;
    }
    out += piece;
  }
  return out;
}

/** Exact name first, then a case-insensitive match. */
export function findSkill(skills: DiscoveredSkill[], name: string): DiscoveredSkill | undefined {
  const wanted = name.trim();
  if (!wanted) return undefined;
  return skills.find((s) => s.name === wanted) ?? skills.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
}

/** SKILL.md content without its frontmatter block. */
export function readSkillBody(skill: DiscoveredSkill): string {
  const content = fs.readFileSync(skill.skillMdPath, "utf-8").replace(/^﻿/, "");
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return content.trim();
  const lines = trimmed.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return end < 0
    ? content.trim()
    : lines
        .slice(end + 1)
        .join("\n")
        .trim();
}

const MAX_LISTED_RESOURCES = 40;

/** Files bundled next to SKILL.md (relative paths, depth <= 2, bounded). */
export function listSkillResources(skill: DiscoveredSkill): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logger.file("warn", "skills", "Could not list skill resources", { dir, error: String(error) });
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (e.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 2) walk(path.join(dir, e.name), relPath, depth + 1);
        continue;
      }
      if (relPath === "SKILL.md") continue;
      if (files.length >= MAX_LISTED_RESOURCES) {
        truncated = true;
        return;
      }
      files.push(relPath);
    }
  };
  walk(skill.rootDir, "", 0);
  return { files, truncated };
}

/**
 * The text a skill contributes to a turn. `$ARGUMENTS` in the body is replaced
 * by the argument string; when the body has no placeholder and arguments were
 * given they are appended as `ARGUMENTS: ...` — Claude Code's convention
 * (https://code.claude.com/docs/en/skills).
 */
export function renderSkillInstructions(skill: DiscoveredSkill, args: string): string {
  const body = readSkillBody(skill);
  const trimmedArgs = args.trim();
  const hasPlaceholder = body.includes("$ARGUMENTS");
  const rendered = hasPlaceholder ? body.split("$ARGUMENTS").join(trimmedArgs) : body;
  const tail = !hasPlaceholder && trimmedArgs ? `\n\nARGUMENTS: ${trimmedArgs}` : "";
  return `<skill name="${escapeXml(skill.name)}" dir="${escapeXml(skill.rootDir)}">\n${rendered}${tail}\n</skill>`;
}

/** Plain-text listing for the /skills slash command. */
export function formatSkillsForChat(skills: DiscoveredSkill[], projectRoot: string): string {
  const where = [
    `  project: ${path.join(skillCreateRoot("project", projectRoot), "<name>", "SKILL.md")}`,
    ...userSkillRoots().map((r) => `  user:    ${path.join(r, "<name>", "SKILL.md")}`),
  ];
  const usage = [
    "Use: /skill <name> [args]  (or /<name> [args] when no command already has that name)",
    "Create: /skill-create [name] [--project|--user] [description]",
  ];
  if (skills.length === 0) {
    return [
      "No Agent Skills found.",
      "",
      "Skills are read from:",
      ...where,
      "",
      ...usage,
      "Format: https://agentskills.io/specification",
    ].join("\n");
  }
  // Project skills first, then user, then bundled: the ones a user just added
  // or is most likely to look for lead the list.
  const rank: Record<SkillScope, number> = { project: 0, user: 1, builtin: 2 };
  const ordered = [...skills].sort((a, b) => rank[a.scope] - rank[b.scope] || a.name.localeCompare(b.name));
  return [
    `Agent Skills (${skills.length})`,
    "",
    ...ordered.map((s) => `- ${s.name} [${s.scope}]\n  ${s.description}\n  ${s.skillMdPath}`),
    "",
    ...usage,
  ].join("\n");
}
