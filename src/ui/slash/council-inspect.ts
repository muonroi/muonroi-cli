/**
 * /council inspect <session-id>
 *
 * Renders a past council debate from the DB for forensic review.
 * Reads [Council Memory], [Council Round N], and [Council Tool Trace] system messages.
 * CQ-21
 */

import { getDatabase } from "../../storage/db.js";
import { COUNCIL_SIGILS } from "../components/role-palette.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

/**
 * Sigil for a participant, by their position in the roster.
 *
 * Uses the SAME `COUNCIL_SIGILS` table and the same first-seen ordering the live
 * TUI assigns palette slots from, so a role carries one identity from the live
 * debate through to this forensic view. This output is plain markdown (no
 * color), which is exactly the case the sigils exist for.
 */
export function inspectSigil(index: number): string {
  return COUNCIL_SIGILS[index % COUNCIL_SIGILS.length] ?? "•";
}

/**
 * Summarise one round from the leader's evaluation text.
 *
 * The stored record is prose, not a struct, so the numbers are recovered by
 * regex. Every part is independently optional: a round whose text does not
 * carry a criteria count still renders with its decision, and one with neither
 * renders as `○` rather than inventing an outcome.
 */
export function summariseRound(evalText: string | undefined): { mark: string; score: string; decision: string } {
  const text = evalText ?? "";
  const scoreMatch = text.match(/(\d+)\s*\/\s*(\d+)\s+criteria met/i);
  const met = scoreMatch ? Number(scoreMatch[1]) : null;
  const total = scoreMatch ? Number(scoreMatch[2]) : null;
  const score = met !== null && total !== null ? `${met}/${total} met` : "";

  // Decision keywords, matched in severity order so "stopped early" does not
  // read as a plain continue.
  const lower = text.toLowerCase();
  const decision = /circuit|abort/.test(lower)
    ? "ended early"
    : /converg|sufficient|\bstop\b/.test(lower)
      ? "sufficient — stop"
      : /\bextend\b/.test(lower)
        ? "extend"
        : /\bcontinue\b/.test(lower)
          ? "continue"
          : "";

  const mark = met !== null && total !== null ? (met >= total ? "✓" : met > 0 ? "◐" : "○") : "○";
  return { mark, score, decision };
}

interface CouncilMemoryRecord {
  topic: string;
  participants: Array<{ role: string; model: string; stance?: { name: string; lens: string } }>;
  finalPositions: Array<{ role: string; position: string }>;
  synthesis: string;
  stats: { calls: number; durationMs: number; phases: Array<{ name: string; durationMs: number }> };
  timestamp: string;
  debatePlan?: {
    outputShape?: { kind: string };
    stances?: Array<{ name: string; lens: string }>;
  };
}

interface MessageRow {
  role: string;
  message_json: string;
  seq: number;
  created_at: string;
}

function extractContent(messageJson: string): string {
  try {
    const parsed = JSON.parse(messageJson) as { content?: string | Array<{ text?: string }> };
    if (typeof parsed.content === "string") return parsed.content;
    if (Array.isArray(parsed.content)) {
      return parsed.content.map((c) => (typeof c === "object" && c.text ? c.text : "")).join("");
    }
  } catch {
    /* fall through */
  }
  return messageJson;
}

export const handleCouncilInspectSlash: SlashHandler = async (args) => {
  const sessionId = args[0]?.trim();
  if (!sessionId) {
    return (
      "/council inspect <session-id>\n" +
      "Renders a past council debate stored in ~/.muonroi-cli/muonroi.db.\n" +
      "Example: /council inspect abc123def456"
    );
  }

  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch (err) {
    // No-Silent-Catch: "DB unavailable" with no reason is unactionable — a
    // locked file and a missing file need opposite fixes.
    console.error(`[council inspect] getDatabase failed: ${err instanceof Error ? err.message : String(err)}`);
    return `[council inspect] DB unavailable.`;
  }

  // Load all system messages for this session — parameterized query prevents SQL injection (T-17-04)
  const rows = db
    .prepare(
      `SELECT role, message_json, seq, created_at
       FROM messages
       WHERE session_id = ?
         AND role = 'system'
       ORDER BY seq ASC`,
    )
    .all(sessionId) as MessageRow[];

  if (rows.length === 0) {
    return `[council inspect] No messages found for session: ${sessionId}`;
  }

  // Partition into council message types
  let memoryRecord: CouncilMemoryRecord | null = null;
  const rounds: Array<{ n: number; text: string }> = [];
  const toolTraces: string[] = [];
  const leaderEvals: Array<{ round: number; text: string }> = [];

  for (const row of rows) {
    const content = extractContent(row.message_json);

    if (content.startsWith("[Council Memory] ")) {
      try {
        memoryRecord = JSON.parse(content.slice("[Council Memory] ".length)) as CouncilMemoryRecord;
      } catch {
        /* skip malformed — T-17-06 */
      }
      continue;
    }

    const roundMatch = content.match(/^\[Council Round (\d+)\]/);
    if (roundMatch) {
      rounds.push({ n: parseInt(roundMatch[1], 10), text: content });
      // Extract leader evaluation lines from round text
      const evalMatch = content.match(/Leader evaluation[^\n]*\n([^\n]+)/);
      if (evalMatch) {
        leaderEvals.push({ round: parseInt(roundMatch[1], 10), text: evalMatch[1] });
      }
      continue;
    }

    if (content.startsWith("[Council Tool Trace]")) {
      toolTraces.push(content);
    }
  }

  if (!memoryRecord) {
    return (
      `[council inspect] Session ${sessionId} found (${rows.length} system messages) ` +
      `but no [Council Memory] record. ` +
      `Rounds: ${rounds.length}, Tool Traces: ${toolTraces.length}.`
    );
  }

  // Build render output
  const lines: string[] = [];
  lines.push(`## Council Session: ${sessionId}`);
  lines.push(`**Topic:** ${memoryRecord.topic}`);
  lines.push(`**Timestamp:** ${memoryRecord.timestamp}`);
  lines.push(
    `**Stats:** ${memoryRecord.stats.calls} API calls · ${(memoryRecord.stats.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push("");

  // Participants
  lines.push("### Participants");
  // Roster order == the slot order the live TUI colors by, so the sigil printed
  // here is the same one that labelled this speaker during the debate.
  const sigilFor = new Map<string, string>();
  for (const p of memoryRecord.participants) {
    if (!sigilFor.has(p.role)) sigilFor.set(p.role, inspectSigil(sigilFor.size));
  }
  for (const p of memoryRecord.participants) {
    const stancePart = p.stance ? ` (${p.stance.name} — ${p.stance.lens})` : "";
    lines.push(`- ${sigilFor.get(p.role) ?? "•"} \`${p.role}\` · ${p.model}${stancePart}`);
  }
  lines.push("");

  // Final positions
  lines.push("### Final Positions");
  for (const fp of memoryRecord.finalPositions) {
    lines.push(`\n**${sigilFor.get(fp.role) ?? "•"} ${fp.role}:** ${fp.position || "(empty)"}`);
  }
  lines.push("");

  // Per-round leader evaluations
  if (rounds.length > 0) {
    lines.push("### Per-Round Leader Evaluations");
    for (const r of rounds.sort((a, b) => a.n - b.n)) {
      // Extract evidence density from round text if present
      const densityMatch = r.text.match(/evidenceDensity[=:]\s*([\d.]+)/i);
      const evalLine = leaderEvals.find((e) => e.round === r.n);
      const densityPart = densityMatch ? ` · evidenceDensity=${densityMatch[1]}` : "";
      // Lead with the round's OUTCOME (mark · score · decision) so the list is
      // scannable; the full evaluation prose follows on the same line.
      const { mark, score, decision } = summariseRound(evalLine?.text);
      const headline = [score, decision].filter(Boolean).join(" · ");
      lines.push(
        `- ${mark} **Round ${r.n}:**${headline ? ` ${headline}` : ""}${densityPart} ` +
          `${evalLine?.text ?? "(no evaluation logged)"}`,
      );
    }
    lines.push("");
  }

  // Tool calls summary
  if (toolTraces.length > 0) {
    lines.push("### Tool Calls (per-call traces)");
    for (const trace of toolTraces) {
      // Format: [Council Tool Trace] tool=<name> args=<...> result=<...>
      const toolMatch = trace.match(/tool=(\S+)/);
      const toolName = toolMatch?.[1] ?? "unknown";
      lines.push(`- \`${toolName}\`: ${trace.slice(0, 200)}${trace.length > 200 ? "…" : ""}`);
    }
    lines.push("");
  } else {
    lines.push("### Tool Calls\n_(no [Council Tool Trace] records for this session)_\n");
  }

  // Citations extraction from synthesis (T-17-05: local DB only, user owns their data)
  lines.push("### Synthesis (excerpt)");
  const citationMatches = memoryRecord.synthesis.match(/\[(?:file|url|snapshot|REFUTED|CONFIRMED)[^\]]+\]/g) ?? [];
  if (citationMatches.length > 0) {
    lines.push(`**Citations found (${citationMatches.length}):** ${citationMatches.slice(0, 10).join(", ")}`);
  } else {
    lines.push("_(no citations found in synthesis excerpt)_");
  }
  lines.push("");
  lines.push(memoryRecord.synthesis.slice(0, 500) + (memoryRecord.synthesis.length > 500 ? "\n…[truncated]" : ""));

  return lines.join("\n");
};

// Register under "council-inspect" key.
// council.ts delegates to this handler when args[0] === "inspect".
registerSlash("council-inspect", handleCouncilInspectSlash);
