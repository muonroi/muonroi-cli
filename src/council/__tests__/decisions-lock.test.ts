/**
 * Tests for Phase C:
 * C1 — STACK LOCK section in council system prompts
 * C2 — decisions.lock.md write/read lifecycle
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStackLockSection,
  detectOutOfStackProposals,
  extractStackFromSpec,
  prependDecisionsLock,
  readDecisionsLock,
  renderDecisionsLock,
  writeDecisionsLock,
} from "../decisions-lock.js";
import {
  buildFollowupPrompt,
  buildLeaderEvaluationPrompt,
  buildOpeningPrompt,
  buildResponsePrompt,
} from "../prompts.js";
import type { ClarifiedSpec } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ClarifiedSpec> = {}): ClarifiedSpec {
  return {
    problemStatement: "Build a feature",
    constraints: [],
    successCriteria: ["Feature works"],
    scope: "Backend only",
    rawQA: [],
    ...overrides,
  };
}

function makeSpecWithBBStack(): ClarifiedSpec {
  return makeSpec({
    problemStatement: "Build a REST API using Muonroi.BaseTemplate (.NET 9)",
    constraints: [
      "Backend: Muonroi.BaseTemplate (.NET 9, CQRS/MediatR)",
      "Frontend: React 18 + Vite + CSS modules",
      "Database: SQLite default",
    ],
    scope: "Muonroi commercial license required",
  });
}

function makeGreenfieldSpec(): ClarifiedSpec {
  return makeSpec({
    problemStatement: "Build something",
    constraints: [],
    scope: "",
  });
}

// ── C1: buildStackLockSection ─────────────────────────────────────────────────

describe("C1: buildStackLockSection", () => {
  it("returns non-empty string with STACK LOCK heading when spec has BB stack", () => {
    const spec = makeSpecWithBBStack();
    const section = buildStackLockSection(spec);
    expect(section).toContain("## STACK LOCK (NON-NEGOTIABLE)");
    expect(section).toContain("Muonroi.BaseTemplate");
  });

  it("includes backend, frontend, and database entries when all are present", () => {
    const spec = makeSpecWithBBStack();
    const section = buildStackLockSection(spec);
    expect(section).toContain("- Backend:");
    expect(section).toContain("- Frontend:");
    expect(section).toContain("- Database:");
  });

  it("includes the anti-drift instruction about NOT proposing alternative frameworks", () => {
    const spec = makeSpecWithBBStack();
    const section = buildStackLockSection(spec);
    expect(section).toContain("MUST NOT propose alternative frameworks");
    expect(section).toContain("scope violations");
  });

  it("returns empty string when spec has no committed scaffold target (greenfield)", () => {
    const spec = makeGreenfieldSpec();
    const section = buildStackLockSection(spec);
    expect(section).toBe("");
  });

  it("returns empty string when spec has generic constraints with no framework mentions", () => {
    const spec = makeSpec({
      constraints: ["Must be fast", "No regressions"],
    });
    const section = buildStackLockSection(spec);
    expect(section).toBe("");
  });
});

// ── extractStackFromSpec: mediatr keyword (Cyrillic-char regression) ──────────

describe("extractStackFromSpec — mediatr keyword", () => {
  it("detects the BB/.NET backend from a 'MediatR' mention alone", () => {
    // Pre-fix the keyword used a Cyrillic 'р' (U+0440), so ASCII "mediatr" could
    // never match. A spec mentioning ONLY MediatR (no BaseTemplate / building-block)
    // must still resolve the backend.
    const spec = makeSpec({ problemStatement: "Wire up CQRS handlers with MediatR", constraints: [], scope: "" });
    const stack = extractStackFromSpec(spec);
    expect(stack).not.toBeNull();
    expect(stack?.backend ?? "").toContain("MediatR");
  });

  it("returns null when no BB/.NET/Muonroi keyword is present", () => {
    const spec = makeSpec({ problemStatement: "Build a plain Express API", constraints: [], scope: "" });
    expect(extractStackFromSpec(spec)).toBeNull();
  });
});

// ── C1: STACK LOCK injected into debate system prompts ────────────────────────

describe("C1: STACK LOCK injected into debate system prompts", () => {
  const bbSpec = makeSpecWithBBStack();
  const greenSpec = makeGreenfieldSpec();

  it("buildOpeningPrompt includes STACK LOCK when spec has committed stack", () => {
    const { system } = buildOpeningPrompt({
      speakerRole: "implement",
      partnerRole: "verify",
      spec: bbSpec,
    });
    expect(system).toContain("## STACK LOCK (NON-NEGOTIABLE)");
    expect(system).toContain("Muonroi.BaseTemplate");
  });

  it("buildOpeningPrompt OMITS STACK LOCK section for greenfield spec", () => {
    const { system } = buildOpeningPrompt({
      speakerRole: "implement",
      partnerRole: "verify",
      spec: greenSpec,
    });
    expect(system).not.toContain("## STACK LOCK");
  });

  it("buildResponsePrompt includes STACK LOCK when spec has committed stack", () => {
    const { system } = buildResponsePrompt({
      speakerRole: "implement",
      partnerRole: "verify",
      speakerPosition: "My position",
      partnerPosition: "Their position",
      spec: bbSpec,
    });
    expect(system).toContain("## STACK LOCK (NON-NEGOTIABLE)");
  });

  it("buildResponsePrompt OMITS STACK LOCK section for greenfield spec", () => {
    const { system } = buildResponsePrompt({
      speakerRole: "implement",
      partnerRole: "verify",
      speakerPosition: "My position",
      partnerPosition: "Their position",
      spec: greenSpec,
    });
    expect(system).not.toContain("## STACK LOCK");
  });

  it("buildFollowupPrompt includes STACK LOCK when spec has committed stack", () => {
    const { system } = buildFollowupPrompt({
      speakerRole: "implement",
      partnerRole: "verify",
      partnerPosition: "Their latest",
      round: 2,
      spec: bbSpec,
    });
    expect(system).toContain("## STACK LOCK (NON-NEGOTIABLE)");
  });

  it("buildFollowupPrompt OMITS STACK LOCK section for greenfield spec", () => {
    const { system } = buildFollowupPrompt({
      speakerRole: "implement",
      partnerRole: "verify",
      partnerPosition: "Their latest",
      round: 2,
      spec: greenSpec,
    });
    expect(system).not.toContain("## STACK LOCK");
  });

  it("buildLeaderEvaluationPrompt includes STACK LOCK and out-of-stack enforcement for committed stack", () => {
    const { system } = buildLeaderEvaluationPrompt({
      spec: bbSpec,
      exchangeLogs: "some logs",
      round: 1,
    });
    expect(system).toContain("## STACK LOCK (NON-NEGOTIABLE)");
    expect(system).toContain("outOfStackViolations");
    expect(system).toContain("consensusQuality");
  });

  it("buildLeaderEvaluationPrompt OMITS out-of-stack enforcement for greenfield spec", () => {
    const { system } = buildLeaderEvaluationPrompt({
      spec: greenSpec,
      exchangeLogs: "some logs",
      round: 1,
    });
    expect(system).not.toContain("## STACK LOCK");
    expect(system).not.toContain("outOfStackViolations");
  });
});

// ── C1: detectOutOfStackProposals ─────────────────────────────────────────────

describe("C1: detectOutOfStackProposals", () => {
  const bbSpec = makeSpecWithBBStack();
  const greenSpec = makeGreenfieldSpec();

  it("returns empty array when synthesis stays within locked stack", () => {
    const synthesis = "We will use Muonroi.BaseTemplate with MediatR and React 18 + Vite.";
    expect(detectOutOfStackProposals(synthesis, bbSpec)).toEqual([]);
  });

  it("detects Next.js as out-of-stack violation", () => {
    const synthesis = "We recommend using Next.js for the frontend due to SSR capabilities.";
    const violations = detectOutOfStackProposals(synthesis, bbSpec);
    expect(violations).toContain("Next.js");
  });

  it("detects shadcn as out-of-stack violation", () => {
    const synthesis = "The UI should use shadcn components for consistency.";
    const violations = detectOutOfStackProposals(synthesis, bbSpec);
    expect(violations).toContain("shadcn");
  });

  it("detects NestJS as out-of-stack violation", () => {
    const synthesis = "Backend could be built with NestJS 10.x for the controller layer.";
    const violations = detectOutOfStackProposals(synthesis, bbSpec);
    expect(violations).toContain("NestJS");
  });

  it("returns empty array when spec is greenfield (no stack to enforce)", () => {
    const synthesis = "We recommend Next.js and shadcn for the frontend.";
    // Greenfield spec has no committed stack, so nothing to enforce
    expect(detectOutOfStackProposals(synthesis, greenSpec)).toEqual([]);
  });
});

// ── C2: renderDecisionsLock ───────────────────────────────────────────────────

describe("C2: renderDecisionsLock", () => {
  const baseInput = {
    runId: "run-test-001",
    runDir: "/tmp/run-test-001",
    spec: makeSpecWithBBStack(),
    timestamp: "2026-05-21T10:00:00.000Z",
    participants: [
      {
        role: "implement",
        stance: { name: "Backend Architect", lens: "System design" },
        position: "We should use CQRS pattern with MediatR handlers.",
      },
      {
        role: "verify",
        stance: { name: "Cost Skeptic", lens: "Budget concerns" },
        position: "Avoid over-engineering. Keep the stack minimal.",
      },
      {
        role: "research",
        stance: { name: "Risk Assessor", lens: "Identifying risks" },
        position: "Integration tests are critical. Race conditions are a risk.",
      },
    ],
    synthesisExcerpt: "Agreed architecture: CQRS with MediatR, React 18 + Vite frontend.",
    rejectedProposals: ["Next.js", "shadcn"],
  };

  it("contains the run ID header", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("# Locked Decisions — Run run-test-001");
  });

  it("contains the ISO timestamp", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("2026-05-21T10:00:00.000Z");
  });

  it("contains Stack section with backend and frontend", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("## Stack");
    expect(content).toContain("Muonroi.BaseTemplate");
    expect(content).toContain("React 18");
  });

  it("contains Architecture Decisions section from synthesis excerpt", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("## Architecture Decisions");
    expect(content).toContain("CQRS with MediatR");
  });

  it("contains Tradeoffs section", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("## Tradeoffs (Cost-Controller)");
  });

  it("contains Risks section", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("## Risks (Skeptic)");
  });

  it("contains Architecture section", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("## Architecture (Architect)");
  });

  it("contains rejected proposals section", () => {
    const content = renderDecisionsLock(baseInput);
    expect(content).toContain("## Out-of-stack proposals (REJECTED)");
    expect(content).toContain("Next.js");
    expect(content).toContain("shadcn");
  });

  it("shows greenfield message in Stack section when no stack committed", () => {
    const input = { ...baseInput, spec: makeGreenfieldSpec() };
    const content = renderDecisionsLock(input);
    expect(content).toContain("Greenfield");
  });
});

// ── C2: writeDecisionsLock / readDecisionsLock ────────────────────────────────

describe("C2: writeDecisionsLock and readDecisionsLock", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "decisions-lock-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("writes decisions.lock.md and reads it back", async () => {
    const input = {
      runId: "run-write-001",
      runDir: tmpDir,
      spec: makeSpecWithBBStack(),
      timestamp: new Date().toISOString(),
      participants: [
        {
          role: "implement",
          stance: { name: "Architect", lens: "design" },
          position: "Use MediatR handlers.",
        },
      ],
      synthesisExcerpt: "Agreed: CQRS with MediatR.",
    };

    const ok = await writeDecisionsLock(input);
    expect(ok).toBe(true);

    const content = await readDecisionsLock(tmpDir);
    expect(content).not.toBeNull();
    expect(content).toContain("# Locked Decisions — Run run-write-001");
    expect(content).toContain("## Stack");
    expect(content).toContain("Muonroi.BaseTemplate");
  });

  it("readDecisionsLock returns null when file does not exist", async () => {
    const content = await readDecisionsLock(path.join(tmpDir, "nonexistent-run"));
    expect(content).toBeNull();
  });

  it("writeDecisionsLock returns true on successful write (basic smoke)", async () => {
    // Positive case: write to a real tmp dir succeeds
    const result = await writeDecisionsLock({
      runId: "smoke-run",
      runDir: tmpDir,
      spec: makeGreenfieldSpec(),
      timestamp: new Date().toISOString(),
      participants: [],
      synthesisExcerpt: "nothing",
    });
    expect(result).toBe(true);
  });
});

// ── C2: prependDecisionsLock ──────────────────────────────────────────────────

describe("C2: prependDecisionsLock", () => {
  it("prepends lock content to implementation prompt", () => {
    const lockContent = "# Locked Decisions\n## Stack\n- Backend: Muonroi.BaseTemplate\n";
    const prompt = "Implement the user registration feature.";
    const result = prependDecisionsLock(prompt, lockContent);

    expect(result).toContain("## Locked decisions you MUST follow");
    expect(result).toContain("Muonroi.BaseTemplate");
    expect(result).toContain("## Sprint task");
    expect(result).toContain("Implement the user registration feature.");
  });

  it("returns original prompt unchanged when lockContent is null", () => {
    const prompt = "Implement the feature.";
    expect(prependDecisionsLock(prompt, null)).toBe(prompt);
  });

  it("returns original prompt unchanged when lockContent is empty string", () => {
    const prompt = "Implement the feature.";
    expect(prependDecisionsLock(prompt, "")).toBe(prompt);
  });

  it("returns original prompt unchanged when lockContent is whitespace-only", () => {
    const prompt = "Implement the feature.";
    expect(prependDecisionsLock(prompt, "   \n  ")).toBe(prompt);
  });

  it("lock content comes before sprint task in output", () => {
    const lockContent = "# Locked Decisions\n## Stack\n- Backend: Muonroi.BaseTemplate\n";
    const prompt = "Run the sprint.";
    const result = prependDecisionsLock(prompt, lockContent);

    const lockIdx = result.indexOf("## Locked decisions you MUST follow");
    const taskIdx = result.indexOf("## Sprint task");
    expect(lockIdx).toBeLessThan(taskIdx);
  });
});
