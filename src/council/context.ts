import type { ModelMessage } from "ai";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CouncilMemoryRecord } from "./types.js";

interface MessageLike {
  role: string;
  content: string | unknown;
}

export interface ProjectSnapshotResult {
  /** Markdown snapshot suitable for injection. Empty when no useful signals. */
  snapshot: string;
  /** True when the directory has no package.json, no README, and (best-effort) no source files. */
  isEmpty: boolean;
}

/**
 * Read a file at most `maxBytes` long; return null on any error.
 * Used to pull lightweight project context without blowing the prompt budget.
 */
async function readSafe(filePath: string, maxBytes = 2000): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath, { encoding: "utf8" });
    if (buf.length <= maxBytes) return buf;
    return buf.slice(0, maxBytes) + "\n[... truncated]";
  } catch {
    return null;
  }
}

/**
 * Snapshot of the workspace the user is currently in. Injected into the
 * clarification prompt so the council leader does not ask "which project?"
 * when the user obviously means the repo they are working in.
 */
export async function buildProjectSnapshot(cwd: string): Promise<ProjectSnapshotResult> {
  if (!cwd) return { snapshot: "", isEmpty: true };
  const parts: string[] = [];
  const baseName = path.basename(cwd);
  parts.push(`### Working directory\n\`${cwd}\` (basename: ${baseName})`);

  let hasPkg = false;
  let hasReadme = false;

  // package.json — name, description, keywords
  const pkgRaw = await readSafe(path.join(cwd, "package.json"), 4000);
  if (pkgRaw) {
    hasPkg = true;
    try {
      const pkg = JSON.parse(pkgRaw) as {
        name?: string;
        description?: string;
        version?: string;
        keywords?: string[];
      };
      const lines: string[] = [];
      if (pkg.name) lines.push(`- name: \`${pkg.name}\``);
      if (pkg.version) lines.push(`- version: \`${pkg.version}\``);
      if (pkg.description) lines.push(`- description: ${pkg.description}`);
      if (pkg.keywords?.length) lines.push(`- keywords: ${pkg.keywords.join(", ")}`);
      if (lines.length > 0) parts.push(`### package.json\n${lines.join("\n")}`);
    } catch {
      // ignore parse errors
    }
  }

  // REPO_DEEP_MAP.md (Muonroi convention) — first 1500 chars
  const deepMap = await readSafe(path.join(cwd, "REPO_DEEP_MAP.md"), 1500);
  if (deepMap) {
    hasReadme = true;
    parts.push(`### REPO_DEEP_MAP.md\n${deepMap.trim()}`);
  } else {
    // Fall back to README first paragraph
    const readme =
      (await readSafe(path.join(cwd, "README.md"), 1200)) ??
      (await readSafe(path.join(cwd, "README"), 1200));
    if (readme) {
      hasReadme = true;
      parts.push(`### README.md (head)\n${readme.trim()}`);
    }
  }

  // Best-effort empty-repo detection: no pkg + no readme + no common source dirs.
  let hasSource = false;
  if (!hasPkg && !hasReadme) {
    for (const dir of ["src", "lib", "app", "pkg", "cmd", "internal"]) {
      try {
        const stat = await fs.stat(path.join(cwd, dir));
        if (stat.isDirectory()) {
          hasSource = true;
          break;
        }
      } catch {
        /* missing — ignore */
      }
    }
  }
  const isEmpty = !hasPkg && !hasReadme && !hasSource;
  if (isEmpty) {
    parts.push(
      `### Empty workspace\n` +
        `No package.json, README, or recognizable source directory found. ` +
        `Treat this as a green-field task: prefer internet research over codebase exploration.`,
    );
  }

  return { snapshot: parts.join("\n\n"), isEmpty };
}

function isCompactionSummary(msg: MessageLike): boolean {
  return (
    msg.role === "system" &&
    typeof msg.content === "string" &&
    (msg.content.startsWith("[Compaction Summary]") || msg.content.startsWith("## Session Summary"))
  );
}

function getCompactionText(msg: MessageLike): string | null {
  if (typeof msg.content !== "string") return null;
  return msg.content;
}

function extractUserText(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type?: string; text?: string }) => c.type === "text" && c.text)
      .map((c: { text: string }) => c.text)
      .join("\n");
  }
  return "";
}

export function buildCouncilContext(messages: MessageLike[]): string {
  const parts: string[] = [];

  if (messages.length > 0 && isCompactionSummary(messages[0])) {
    const summary = getCompactionText(messages[0]);
    if (summary) {
      parts.push(`## Session Context (from compaction summary)\n${summary}`);
    }
  }

  const userMessages: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMessages.length < 5; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const text = extractUserText(msg.content);
      if (text.trim()) {
        userMessages.unshift(`- ${text.slice(0, 2000).trim()}`);
      }
    }
  }
  if (userMessages.length > 0) {
    parts.push(`## Recent User Messages\n${userMessages.join("\n")}`);
  }

  const councilMemories: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system" && typeof msg.content === "string" && msg.content.includes("[Council Memory]")) {
      councilMemories.push(msg.content);
    }
  }
  if (councilMemories.length > 0) {
    const digests = councilMemories.slice(-2).map(formatCouncilMemoryDigest);
    parts.push(`## Previous Council Outcomes (cite by role/round)\n${digests.join("\n\n")}`);
  }

  const combined = parts.join("\n\n---\n\n");
  if (combined.length > 12000) {
    return combined.slice(0, 12000) + "\n\n[... context truncated to fit token budget]";
  }
  return combined;
}

/**
 * Parse a `[Council Memory] {...}` system message and format it as a
 * citation-friendly digest. Falls back to the raw line on parse failure.
 *
 * Output is structured so the agent can answer:
 *   - "Who was the leader?"  → `Leader: <model>`
 *   - "What did <role> say?" → `### Final Positions` block
 *   - "Cite a specific round" → `### Debate Archive (per round)` block
 */
function formatCouncilMemoryDigest(raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return raw;
  let parsed: Partial<CouncilMemoryRecord> | null = null;
  try {
    parsed = JSON.parse(raw.slice(jsonStart)) as Partial<CouncilMemoryRecord>;
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") return raw;

  const lines: string[] = [];
  lines.push(`### Council Outcome — ${parsed.topic ?? "(unknown topic)"}`);
  if (parsed.timestamp) lines.push(`- when: ${parsed.timestamp}`);
  if (parsed.leaderModel) lines.push(`- leader: \`${parsed.leaderModel}\``);
  if (parsed.confidence) {
    lines.push(
      `- confidence: **${parsed.confidence.level}** (evidence density ${parsed.confidence.evidenceDensity.toFixed(2)}, ${parsed.confidence.rounds} rounds)`,
    );
  }
  if (Array.isArray(parsed.participants) && parsed.participants.length > 0) {
    lines.push(`- participants:`);
    for (const p of parsed.participants) {
      const stance = p.stance?.name ? ` — _${p.stance.name}_` : "";
      lines.push(`  - \`${p.role}\` / \`${p.model}\`${stance}`);
    }
  }

  if (Array.isArray(parsed.finalPositions) && parsed.finalPositions.length > 0) {
    lines.push(`\n#### Final Positions`);
    for (const fp of parsed.finalPositions) {
      const text = String(fp.position ?? "").slice(0, 600);
      lines.push(`- **[${fp.role}]** ${text}`);
    }
  }

  if (Array.isArray(parsed.archive) && parsed.archive.length > 0) {
    lines.push(`\n#### Debate Archive (per round)`);
    // Cap at 12 entries to control token budget on follow-ups.
    const cap = parsed.archive.slice(0, 12);
    for (const e of cap) {
      const stance = e.stanceName ? ` _${e.stanceName}_` : "";
      const tools = e.toolsUsed?.length ? ` _(tools: ${e.toolsUsed.join(", ")})_` : "";
      // Modern entries store `excerpt` (already capped to ~400 chars). Old
      // entries used `position` — keep that fallback so historical records
      // still render correctly when reloaded.
      const rawText = String(
        (e as { excerpt?: unknown }).excerpt ?? (e as { position?: unknown }).position ?? "",
      );
      const text = rawText.length > 400 ? rawText.slice(0, 400) + "…" : rawText;
      const lengthHint =
        typeof (e as { length?: unknown }).length === "number" && (e as { length: number }).length > rawText.length
          ? ` _(orig ${(e as { length: number }).length} chars)_`
          : "";
      lines.push(`- **round ${e.round} · [${e.role}]**${stance}${tools}: ${text}${lengthHint}`);
    }
    if (parsed.archive.length > cap.length) {
      lines.push(`- _(+${parsed.archive.length - cap.length} more archive entries truncated)_`);
    }
  }

  if (parsed.synthesis) {
    const synth = String(parsed.synthesis).slice(0, 1200);
    lines.push(`\n#### Synthesis\n${synth}`);
  }

  return lines.join("\n");
}
