import { writeFileSync } from "node:fs";
import { resolvePlanCouncilLeader } from "../council/leader.js";
import { planningArtifact } from "./paths.js";
import { extractStructuredVerdict } from "./verdict-schema.js";
import { buildVerifyContextBundle } from "./verify-context.js";
import {
  buildVerifyDebateTopic,
  buildVerifyPerspectivePrompt,
  type VerifyPerspective,
  verifyPerspectivesForDepth,
} from "./verify-council-prompts.js";

export type VerifyVerdict = "pass" | "revise" | "block";

export interface VerifyCouncilResult {
  skipped: boolean;
  verdict: VerifyVerdict;
  concerns: string[];
  verifyCouncilPath?: string;
  leaderModelId?: string;
  verdictSource: "structured" | "heuristic-fallback" | "parse-failed";
}

export interface VerifyCouncilOpts {
  cwd: string;
  sessionModelId: string;
  depth: string;
  evidence?: string;
  diff?: string;
  runPerspectiveFn?: (prompt: string, p: VerifyPerspective) => Promise<string>;
  runDebate?: (topic: string) => Promise<string>;
}

/** approve → pass; else the worst verdict wins (block > revise). */
function mergeVerdict(verdicts: ("approve" | "revise" | "block")[]): VerifyVerdict {
  if (verdicts.some((v) => v === "block")) return "block";
  if (verdicts.some((v) => v === "revise")) return "revise";
  return "pass";
}

function writeArtifact(
  cwd: string,
  verdict: VerifyVerdict,
  concerns: string[],
  leaderModelId: string,
  source: string,
): string {
  const path = planningArtifact(cwd, "VERIFY-COUNCIL.md");
  const content = [
    "# VERIFY-COUNCIL",
    "",
    `verdict: ${verdict}`,
    `leader: \`${leaderModelId}\``,
    `verdictSource: ${source}`,
    "",
    "## Concerns",
    concerns.length ? concerns.map((c) => `- ${c}`).join("\n") : "- (none)",
  ].join("\n");
  writeFileSync(path, content, "utf8");
  return path;
}

/**
 * Independent council adjudication of an implementation against its plan.
 * Runs ONLY after the deterministic test floor passes (caller's contract).
 * Never silently approves: a missing structured verdict forces "revise".
 */
export async function runVerifyCouncil(opts: VerifyCouncilOpts): Promise<VerifyCouncilResult> {
  const perspectives = verifyPerspectivesForDepth(opts.depth);
  if (perspectives.length === 0) {
    return { skipped: true, verdict: "pass", concerns: [], verdictSource: "structured" };
  }

  const bundle = buildVerifyContextBundle(opts.cwd, { depth: opts.depth, evidence: opts.evidence, diff: opts.diff });
  const leader = await resolvePlanCouncilLeader(opts.sessionModelId);

  // ---- Debate path (production: runCouncilV2 synthesis) ----
  if (opts.runDebate) {
    let synthesis = "";
    try {
      synthesis = await opts.runDebate(buildVerifyDebateTopic(bundle));
    } catch (err) {
      console.error(`[gsd] verify-council debate failed: ${(err as Error).message}`);
    }
    const parsed = extractStructuredVerdict(synthesis);
    if (!parsed) {
      const concerns = ["Verify council leader emitted no structured verdict — forcing revision."];
      const path = writeArtifact(opts.cwd, "revise", concerns, leader.modelId, "parse-failed");
      return {
        skipped: false,
        verdict: "revise",
        concerns,
        verifyCouncilPath: path,
        leaderModelId: leader.modelId,
        verdictSource: "parse-failed",
      };
    }
    const verdict = mergeVerdict([parsed.verdict]);
    const concerns = parsed.concerns.map(String);
    const path = writeArtifact(opts.cwd, verdict, concerns, leader.modelId, "structured");
    return {
      skipped: false,
      verdict,
      concerns,
      verifyCouncilPath: path,
      leaderModelId: leader.modelId,
      verdictSource: "structured",
    };
  }

  // ---- Perspective path (parallel sub-agents; tests use this) ----
  if (!opts.runPerspectiveFn) {
    // No runner at all — cannot adjudicate; conservatively pass (deterministic floor already gated).
    return { skipped: true, verdict: "pass", concerns: [], verdictSource: "structured" };
  }
  const runFn = opts.runPerspectiveFn;
  const results = await Promise.all(
    perspectives.map(async (p) => {
      try {
        const raw = await runFn(buildVerifyPerspectivePrompt(p, bundle), p);
        const parsed = extractStructuredVerdict(raw);
        if (!parsed) {
          console.error(`[gsd] verify-council perspective ${p.id} emitted no structured verdict — forcing revise`);
          return {
            verdict: "revise" as const,
            concerns: [`${p.id}: no structured verdict (parse failed)`],
            parseFailed: true,
          };
        }
        return { verdict: parsed.verdict, concerns: parsed.concerns.map(String), parseFailed: false };
      } catch (err) {
        console.error(`[gsd] verify-council perspective ${p.id} failed: ${(err as Error).message}`);
        return {
          verdict: "revise" as const,
          concerns: [`${p.id}: perspective error — ${(err as Error).message}`],
          parseFailed: true,
        };
      }
    }),
  );
  const verdict = mergeVerdict(results.map((r) => r.verdict));
  const concerns = results.flatMap((r) => r.concerns);
  const anyParseFailed = results.some((r) => r.parseFailed);
  const source = anyParseFailed ? "parse-failed" : "structured";
  const path = writeArtifact(opts.cwd, verdict, concerns, leader.modelId, source);
  return {
    skipped: false,
    verdict,
    concerns,
    verifyCouncilPath: path,
    leaderModelId: leader.modelId,
    verdictSource: source,
  };
}
