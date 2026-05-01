/**
 * src/ui/slash/ee.ts
 *
 * /ee slash command handler (P2 Knowledge Visibility).
 * Surfaces EE knowledge management: stats, graph, timeline, gates, evolve, share/import.
 *
 * Self-registers on module import.
 */

import { getDefaultEEClient } from "../../ee/intercept.js";
import type {
  EEStatsResponse,
  EEGraphResponse,
  EETimelineResponse,
  EEGatesResponse,
  EEEvolveResponse,
  EEShareResponse,
  RouteTaskResponse,
  EESearchResponse,
} from "../../ee/types.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

const UNREACHABLE = "**EE unreachable** — is the Experience Engine running on localhost:8082?";

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtStats(s: EEStatsResponse): string {
  const lines: string[] = ["**EE Stats**", ""];

  // Overview
  lines.push("**Overview**");
  lines.push(`  Intercepts: ${s.totalIntercepts}  |  Suggestions: ${s.suggestions}  |  Misses: ${s.misses}`);
  if (s.mistakesDetected != null) lines.push(`  Mistakes detected: ${s.mistakesDetected}`);
  if (s.lessonsStored != null) lines.push(`  Lessons stored: ${s.lessonsStored}`);
  if (s.extractSessions != null) lines.push(`  Extract sessions: ${s.extractSessions}`);

  // Evolution
  if (s.evolution) {
    const e = s.evolution;
    lines.push("");
    lines.push("**Evolution**");
    lines.push(`  Promoted: ${e.promoted}  |  Demoted: ${e.demoted}  |  Abstracted: ${e.abstracted}  |  Archived: ${e.archived}`);
  }

  // Per-project
  if (s.perProject && Object.keys(s.perProject).length > 0) {
    lines.push("");
    lines.push("**Per Project**");
    for (const [proj, data] of Object.entries(s.perProject)) {
      lines.push(`  ${proj}: ${data.intercepts} intercepts, ${data.suggestions} suggestions`);
    }
  }

  // Routing
  if (s.routingStats) {
    const r = s.routingStats;
    lines.push("");
    lines.push("**Routing**");
    if (r.byTier && Object.keys(r.byTier).length > 0) {
      lines.push(`  By tier: ${Object.entries(r.byTier).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (r.bySource && Object.keys(r.bySource).length > 0) {
      lines.push(`  By source: ${Object.entries(r.bySource).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (r.outcomes && Object.keys(r.outcomes).length > 0) {
      lines.push(`  Outcomes: ${Object.entries(r.outcomes).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }

  // Cost ledger
  if (s.costLedger && s.costLedger.length > 0) {
    lines.push("");
    lines.push("**Cost Ledger** (recent)");
    for (const row of s.costLedger.slice(-5)) {
      const total = row.embed + row.brain + row.judge + row.extract;
      lines.push(`  ${row.date}: $${total.toFixed(4)} (embed=$${row.embed.toFixed(4)} brain=$${row.brain.toFixed(4)} judge=$${row.judge.toFixed(4)} extract=$${row.extract.toFixed(4)})`);
    }
  }

  return lines.join("\n");
}

function fmtTimeline(r: EETimelineResponse): string {
  if (r.timeline.length === 0) return `No timeline entries for topic "${r.topic}".`;

  const lines: string[] = [`**Timeline: ${r.topic}** (${r.count} entries)`, ""];
  for (const e of r.timeline) {
    const tierBadge = `T${e.tier}`;
    const superseded = e.superseded ? " ~~superseded~~" : "";
    const confirms = e.confirmedAt.length;
    lines.push(`- **[${tierBadge}]** ${e.trigger}${superseded}`);
    lines.push(`  Solution: ${e.solution}`);
    lines.push(`  Score: ${e.score} | Confirmed: ${confirms}x | ${e.createdAt}`);
  }
  return lines.join("\n");
}

function fmtGraph(r: EEGraphResponse): string {
  if (r.edges.length === 0) return `No graph edges for "${r.id}".`;

  const lines: string[] = [`**Graph: ${r.id}** (${r.count} edges)`, ""];
  for (const e of r.edges) {
    const arrow = e.direction === "outgoing" ? "→" : "←";
    lines.push(`  ${arrow} ${e.type} ${e.target} (weight: ${e.weight.toFixed(2)})`);
  }
  return lines.join("\n");
}

function fmtGates(r: EEGatesResponse): string {
  const lines: string[] = ["**Quality Gates**", ""];
  for (const g of r.gates) {
    const icon = g.status === "pass" ? "✓" : g.status === "fail" ? "✗" : "●";
    lines.push(`${icon} **${g.name}** — ${g.status}`);
    for (const c of g.checks) {
      const ci = c.ok ? "✓" : "✗";
      lines.push(`  ${ci} ${c.label}${c.detail ? ` (${c.detail})` : ""}`);
    }
  }
  return lines.join("\n");
}

function fmtEvolve(r: EEEvolveResponse): string {
  if (!r.success) return "Evolve cycle failed.";
  const lines: string[] = ["**Evolution cycle complete**"];
  if (r.promoted != null) lines.push(`  Promoted:   ${r.promoted}`);
  if (r.demoted != null) lines.push(`  Demoted:    ${r.demoted}`);
  if (r.abstracted != null) lines.push(`  Abstracted: ${r.abstracted}`);
  if (r.archived != null) lines.push(`  Archived:   ${r.archived}`);
  return lines.join("\n");
}

function fmtShare(r: EEShareResponse): string {
  if (!r.success) return "Share failed.";
  return ["**Shared principle** (portable JSON):", "```json", JSON.stringify(r.shared, null, 2), "```"].join("\n");
}

function fmtRoute(r: RouteTaskResponse): string {
  const icon = r.confidence >= 0.7 ? "✓" : r.confidence >= 0.4 ? "●" : "?";
  const lines: string[] = [
    `**Task Route** ${icon} (confidence: ${(r.confidence * 100).toFixed(0)}%)`,
    "",
    `  Route: **${r.route ?? "needs clarification"}**`,
    `  Reason: ${r.reason}`,
    `  Source: ${r.source}`,
  ];
  if (r.needs_disambiguation && r.options.length > 0) {
    lines.push("", "**Clarify before proceeding:**");
    for (const opt of r.options) {
      lines.push(`  - **${opt.label}** (\`${opt.route}\`): ${opt.description}`);
    }
  }
  return lines.join("\n");
}

function fmtSearch(r: EESearchResponse): string {
  if (r.points.length === 0) return "No results found.";
  const lines: string[] = [`**Search Results** (${r.points.length} hits)`, ""];
  for (const p of r.points) {
    lines.push(`- **[${p.collection}]** (score: ${p.score.toFixed(3)})`);
    lines.push(`  ${p.text.slice(0, 200)}${p.text.length > 200 ? "..." : ""}`);
  }
  return lines.join("\n");
}

const HELP = [
  "**Experience Engine (/ee)**",
  "",
  "Usage:",
  "  /ee stats [7d|30d|all]   — Knowledge base statistics",
  "  /ee timeline <topic>     — Chronological principle evolution",
  "  /ee graph <id>           — Principle relationship graph",
  "  /ee gates                — Quality gate checklist",
  "  /ee evolve               — Trigger evolution cycle",
  "  /ee share <principleId>  — Export principle as portable JSON",
  "  /ee import <json>        — Import a shared principle",
  "  /ee route <task>         — Route task to workflow (discuss/execute/direct)",
  "  /ee search <query>       — Semantic search across knowledge base",
  "  /ee user                 — Current EE user identity",
].join("\n");

// ─── Handler ─────────────────────────────────────────────────────────────────

export const handleEESlash: SlashHandler = async (args, _ctx) => {
  const sub = args[0]?.toLowerCase();
  if (!sub) return HELP;

  const client = getDefaultEEClient();

  switch (sub) {
    case "stats": {
      const since = args[1]; // "7d" | "30d" | "all" | undefined
      const r = await client.stats(since);
      return r ? fmtStats(r) : UNREACHABLE;
    }

    case "timeline": {
      const topic = args.slice(1).join(" ");
      if (!topic) return "/ee timeline: please provide a topic — /ee timeline <topic>";
      const r = await client.timeline(topic);
      return r ? fmtTimeline(r) : UNREACHABLE;
    }

    case "graph": {
      const id = args[1];
      if (!id) return "/ee graph: please provide an id — /ee graph <id>";
      const r = await client.graph(id);
      return r ? fmtGraph(r) : UNREACHABLE;
    }

    case "gates": {
      const r = await client.gates();
      return r ? fmtGates(r) : UNREACHABLE;
    }

    case "evolve": {
      const r = await client.evolve();
      return r ? fmtEvolve(r) : UNREACHABLE;
    }

    case "share": {
      const pid = args[1];
      if (!pid) return "/ee share: please provide a principleId — /ee share <principleId>";
      const r = await client.sharePrinciple(pid);
      return r ? fmtShare(r) : UNREACHABLE;
    }

    case "import": {
      const raw = args.slice(1).join(" ");
      if (!raw) return "/ee import: please provide JSON — /ee import <json>";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return "/ee import: invalid JSON.";
      }
      const r = await client.importPrinciple(parsed);
      if (!r) return UNREACHABLE;
      return r.success ? "Principle imported successfully." : "Import failed.";
    }

    case "route": {
      const task = args.slice(1).join(" ");
      if (!task) return "/ee route: please provide a task — /ee route <task description>";
      const r = await client.routeTask({ task });
      return r ? fmtRoute(r) : UNREACHABLE;
    }

    case "search": {
      const query = args.slice(1).join(" ");
      if (!query) return "/ee search: please provide a query — /ee search <query>";
      const r = await client.search(query);
      return r ? fmtSearch(r) : UNREACHABLE;
    }

    case "user": {
      const r = await client.user();
      if (!r) return UNREACHABLE;
      return `**EE User:** ${r.user}`;
    }

    case "help":
      return HELP;

    default:
      return `Unknown subcommand "${sub}".\n\n${HELP}`;
  }
};

// Self-register on module import
registerSlash("ee", handleEESlash);
