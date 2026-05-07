import type { ModelMessage } from "ai";
import { promises as fs } from "node:fs";
import * as path from "node:path";

interface MessageLike {
  role: string;
  content: string | unknown;
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
export async function buildProjectSnapshot(cwd: string): Promise<string> {
  if (!cwd) return "";
  const parts: string[] = [];
  const baseName = path.basename(cwd);
  parts.push(`### Working directory\n\`${cwd}\` (basename: ${baseName})`);

  // package.json — name, description, keywords
  const pkgRaw = await readSafe(path.join(cwd, "package.json"), 4000);
  if (pkgRaw) {
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
    parts.push(`### REPO_DEEP_MAP.md\n${deepMap.trim()}`);
  } else {
    // Fall back to README first paragraph
    const readme =
      (await readSafe(path.join(cwd, "README.md"), 1200)) ??
      (await readSafe(path.join(cwd, "README"), 1200));
    if (readme) {
      parts.push(`### README.md (head)\n${readme.trim()}`);
    }
  }

  return parts.join("\n\n");
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
    parts.push(`## Previous Council Outcomes\n${councilMemories.slice(-2).join("\n\n")}`);
  }

  const combined = parts.join("\n\n---\n\n");
  if (combined.length > 12000) {
    return combined.slice(0, 12000) + "\n\n[... context truncated to fit token budget]";
  }
  return combined;
}
