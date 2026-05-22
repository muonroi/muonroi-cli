# PIL Interactive Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform PIL from a passive enrichment pipeline into a two-phase interactive discovery pipeline that explores the project context, interviews the user on clarity gaps, validates feasibility, and gets user acceptance before enrichment.

**Architecture:** Two-phase pipeline (Discovery → Enrichment) inside the existing `runPipeline` entry point. Phase 1 adds layers L1.5–L1.8 with a clarity gate to auto-pass 60-70% of prompts. Phase 2 is the existing L2–L6 unchanged. Interactive layers reuse the `CouncilQuestionCard` component via an injected `DiscoveryInteractionHandler`.

**Tech Stack:** TypeScript, Bun, Vitest, existing EE bridge (`searchByText`), existing council-question-card TUI component.

---

### Task 1: Discovery Types

**Files:**
- Create: `src/pil/discovery-types.ts`
- Test: `src/pil/__tests__/discovery-types.test.ts`

- [ ] **Step 1: Write the type definition file**

```typescript
// src/pil/discovery-types.ts
import type { CouncilQuestionAnswer, CouncilQuestionData } from "../types/index.js";
import type { OutputStyle, TaskType } from "./types.js";

export interface ProjectContext {
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  domain: string | null;
  boundedContexts: BoundedContext[];
  eePatterns: string[];
  relevantModules: RelevantModule[];
  scannedAt: number;
  cwd: string;
}

export interface BoundedContext {
  path: string;
  name: string;
  entryFiles: string[];
  exportedSymbols: string[];
}

export interface RelevantModule {
  path: string;
  relevance: string;
  exists: boolean;
}

export type ClarityDimension = "outcome" | "scope" | "constraint";

export interface ClarityGap {
  dimension: ClarityDimension;
  description: string;
  suggestedQuestion: string;
  options: string[];
  defaultIndex: number;
}

export interface ClarifiedIntent {
  outcome: string;
  scope: string[];
  constraints: string[];
  gaps: Array<ClarityGap & { answer: string | null }>;
}

export interface FeasibilityResult {
  viable: boolean;
  warnings: string[];
  adjustedScope: string[];
}

export interface DiscoveryResult {
  raw: string;
  projectContext: ProjectContext;
  clarifiedIntent: ClarifiedIntent;
  feasibility: FeasibilityResult;
  interviewed: boolean;
  intentStatement: string;
  outcome: string;
  scope: string[];
  feasibilityWarnings: string[];
  accepted: boolean;
  taskType: TaskType | null;
  confidence: number;
  domain: string | null;
  outputStyle: OutputStyle | null;
  discoveryMs: number;
}

export interface AcceptanceCardData {
  intentStatement: string;
  outcome: string;
  scope: string[];
  warnings: string[];
}

export interface DiscoveryInteractionHandler {
  askQuestion(question: CouncilQuestionData): Promise<CouncilQuestionAnswer>;
  showAcceptance(card: AcceptanceCardData): Promise<"accept" | "adjust" | "cancel">;
}
```

- [ ] **Step 2: Write a compile-check test**

```typescript
// src/pil/__tests__/discovery-types.test.ts
import { describe, expect, it } from "vitest";
import type {
  AcceptanceCardData,
  BoundedContext,
  ClarifiedIntent,
  ClarityDimension,
  ClarityGap,
  DiscoveryInteractionHandler,
  DiscoveryResult,
  FeasibilityResult,
  ProjectContext,
  RelevantModule,
} from "../discovery-types.js";

describe("discovery-types", () => {
  it("ProjectContext is structurally valid", () => {
    const ctx: ProjectContext = {
      language: "typescript",
      framework: "next",
      packageManager: "bun",
      domain: "web",
      boundedContexts: [{ path: "src/auth/", name: "auth", entryFiles: ["src/auth/index.ts"], exportedSymbols: ["login"] }],
      eePatterns: ["jwt-validation"],
      relevantModules: [{ path: "src/auth/jwt.ts", relevance: "matches keyword auth", exists: true }],
      scannedAt: Date.now(),
      cwd: "/tmp/proj",
    };
    expect(ctx.language).toBe("typescript");
  });

  it("ClarityDimension union covers all 3 values", () => {
    const dims: ClarityDimension[] = ["outcome", "scope", "constraint"];
    expect(dims).toHaveLength(3);
  });

  it("DiscoveryResult has all required fields", () => {
    const result: DiscoveryResult = {
      raw: "fix auth",
      projectContext: { language: null, framework: null, packageManager: null, domain: null, boundedContexts: [], eePatterns: [], relevantModules: [], scannedAt: 0, cwd: "" },
      clarifiedIntent: { outcome: "", scope: [], constraints: [], gaps: [] },
      feasibility: { viable: true, warnings: [], adjustedScope: [] },
      interviewed: false,
      intentStatement: "",
      outcome: "",
      scope: [],
      feasibilityWarnings: [],
      accepted: true,
      taskType: "debug",
      confidence: 0.9,
      domain: "typescript",
      outputStyle: "balanced",
      discoveryMs: 100,
    };
    expect(result.accepted).toBe(true);
  });
});
```

- [ ] **Step 3: Run test**

Run: `bunx vitest run src/pil/__tests__/discovery-types.test.ts`
Expected: 3 passed

- [ ] **Step 4: Commit**

```bash
git add src/pil/discovery-types.ts src/pil/__tests__/discovery-types.test.ts
git commit -m "feat(pil): add discovery phase type definitions"
```

---

### Task 2: Config Flags

**Files:**
- Modify: `src/pil/config.ts`
- Test: `src/pil/__tests__/config.test.ts` (existing — add new tests)

- [ ] **Step 1: Read existing config test to understand pattern**

Read: `src/pil/__tests__/config.test.ts`

- [ ] **Step 2: Write failing tests for new config functions**

Append to `src/pil/__tests__/config.test.ts`:

```typescript
import { getAutoPassThreshold, getMaxInterviewQuestions, isDiscoveryEnabled } from "../config.js";

describe("isDiscoveryEnabled()", () => {
  it("returns true by default (no env)", () => {
    delete process.env.MUONROI_PIL_DISCOVERY;
    expect(isDiscoveryEnabled()).toBe(true);
  });
  it("returns false when MUONROI_PIL_DISCOVERY=0", () => {
    process.env.MUONROI_PIL_DISCOVERY = "0";
    expect(isDiscoveryEnabled()).toBe(false);
    delete process.env.MUONROI_PIL_DISCOVERY;
  });
  it("returns true when MUONROI_PIL_DISCOVERY=1", () => {
    process.env.MUONROI_PIL_DISCOVERY = "1";
    expect(isDiscoveryEnabled()).toBe(true);
    delete process.env.MUONROI_PIL_DISCOVERY;
  });
});

describe("getAutoPassThreshold()", () => {
  it("returns 0.85 by default", () => {
    delete process.env.MUONROI_PIL_AUTOPASS_THRESHOLD;
    expect(getAutoPassThreshold()).toBe(0.85);
  });
  it("respects env override in range", () => {
    process.env.MUONROI_PIL_AUTOPASS_THRESHOLD = "0.7";
    expect(getAutoPassThreshold()).toBe(0.7);
    delete process.env.MUONROI_PIL_AUTOPASS_THRESHOLD;
  });
  it("clamps out-of-range to default", () => {
    process.env.MUONROI_PIL_AUTOPASS_THRESHOLD = "1.5";
    expect(getAutoPassThreshold()).toBe(0.85);
    delete process.env.MUONROI_PIL_AUTOPASS_THRESHOLD;
  });
});

describe("getMaxInterviewQuestions()", () => {
  it("returns 3 by default", () => {
    delete process.env.MUONROI_PIL_MAX_QUESTIONS;
    expect(getMaxInterviewQuestions()).toBe(3);
  });
  it("respects valid override", () => {
    process.env.MUONROI_PIL_MAX_QUESTIONS = "2";
    expect(getMaxInterviewQuestions()).toBe(2);
    delete process.env.MUONROI_PIL_MAX_QUESTIONS;
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run src/pil/__tests__/config.test.ts`
Expected: FAIL — `isDiscoveryEnabled`, `getAutoPassThreshold`, `getMaxInterviewQuestions` not exported

- [ ] **Step 4: Implement the config functions**

Append to `src/pil/config.ts`:

```typescript
export function isDiscoveryEnabled(): boolean {
  return process.env.MUONROI_PIL_DISCOVERY !== "0";
}

export function getAutoPassThreshold(): number {
  const v = Number(process.env.MUONROI_PIL_AUTOPASS_THRESHOLD);
  return Number.isFinite(v) && v >= 0.5 && v <= 1.0 ? v : 0.85;
}

export function getMaxInterviewQuestions(): number {
  const v = Number(process.env.MUONROI_PIL_MAX_QUESTIONS);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run src/pil/__tests__/config.test.ts`
Expected: All passed

- [ ] **Step 6: Commit**

```bash
git add src/pil/config.ts src/pil/__tests__/config.test.ts
git commit -m "feat(pil): add discovery config flags"
```

---

### Task 3: Clarity Gate

**Files:**
- Create: `src/pil/clarity-gate.ts`
- Test: `src/pil/__tests__/clarity-gate.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pil/__tests__/clarity-gate.test.ts
import { describe, expect, it } from "vitest";
import { canInferOutcome, countFileReferences, hasExplicitScope, shouldAutoPass } from "../clarity-gate.js";

describe("canInferOutcome()", () => {
  it("returns false for null taskType", () => {
    expect(canInferOutcome(null, "do something")).toBe(false);
  });
  it("returns false for general taskType", () => {
    expect(canInferOutcome("general", "fix stuff")).toBe(false);
  });
  it("returns true when prompt has error reference", () => {
    expect(canInferOutcome("debug", "fix the TypeError in login")).toBe(true);
  });
  it("returns true when prompt has file:line reference", () => {
    expect(canInferOutcome("debug", "fix auth.ts:42")).toBe(true);
  });
  it("returns true when prompt has target state verb", () => {
    expect(canInferOutcome("refactor", "should return a Promise")).toBe(true);
  });
  it("returns true when prompt has add pattern", () => {
    expect(canInferOutcome("generate", "add validation to login form")).toBe(true);
  });
  it("returns false for vague prompt with valid taskType", () => {
    expect(canInferOutcome("debug", "fix auth")).toBe(false);
  });
});

describe("countFileReferences()", () => {
  it("counts .ts and .tsx files", () => {
    expect(countFileReferences("fix login.ts and dashboard.tsx")).toBe(2);
  });
  it("returns 0 for no file refs", () => {
    expect(countFileReferences("fix the auth module")).toBe(0);
  });
  it("ignores non-code extensions", () => {
    expect(countFileReferences("see report.pdf")).toBe(0);
  });
});

describe("hasExplicitScope()", () => {
  it("detects src/ paths", () => {
    expect(hasExplicitScope("refactor src/auth/jwt.ts")).toBe(true);
  });
  it("detects lib/ paths", () => {
    expect(hasExplicitScope("update lib/utils")).toBe(true);
  });
  it("returns false for no path", () => {
    expect(hasExplicitScope("refactor the code")).toBe(false);
  });
});

describe("shouldAutoPass()", () => {
  it("auto-passes high-confidence + specific file + inferrable outcome", () => {
    expect(shouldAutoPass(
      { confidence: 0.9, taskType: "debug", complexity: "low" },
      "fix TypeError in src/auth/login.ts:42",
    )).toBe(true);
  });
  it("rejects low confidence", () => {
    expect(shouldAutoPass(
      { confidence: 0.6, taskType: "debug", complexity: "low" },
      "fix TypeError in login.ts:42",
    )).toBe(false);
  });
  it("rejects vague prompt despite high confidence", () => {
    expect(shouldAutoPass(
      { confidence: 0.9, taskType: "debug", complexity: "low" },
      "fix auth",
    )).toBe(false);
  });
  it("rejects high complexity", () => {
    expect(shouldAutoPass(
      { confidence: 0.9, taskType: "refactor", complexity: "high" },
      "refactor src/auth/login.ts should return Promise",
    )).toBe(false);
  });
  it("auto-passes with explicit scope path even without file extension", () => {
    expect(shouldAutoPass(
      { confidence: 0.9, taskType: "refactor", complexity: "medium" },
      "refactor src/auth/ module to return Promises",
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/pil/__tests__/clarity-gate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement clarity gate**

```typescript
// src/pil/clarity-gate.ts
import type { TaskType } from "./types.js";
import { getAutoPassThreshold } from "./config.js";

export interface L1Signal {
  confidence: number;
  taskType: TaskType | null;
  complexity: "low" | "medium" | "high";
}

export function canInferOutcome(taskType: TaskType | null, raw: string): boolean {
  if (!taskType || taskType === "general") return false;
  const hasErrorRef = /error|exception|stack|TypeError|Cannot|failed|crash/i.test(raw);
  const hasFileLineRef = /\.\w+:\d+/.test(raw);
  const hasTargetState = /should|must|expect|return|produce|output|become/i.test(raw);
  const hasAddPattern = /\b(add|create|implement|write|generate)\b.*\b(to|in|for|into)\b/i.test(raw);
  return hasErrorRef || hasFileLineRef || hasTargetState || hasAddPattern;
}

export function countFileReferences(raw: string): number {
  return (raw.match(/[\w\-]+\.\w{1,5}/g) ?? []).filter((m) =>
    /\.(ts|tsx|js|jsx|py|rs|go|java|cs|rb|vue|svelte|css|scss|json|yaml|yml|toml|md)$/i.test(m),
  ).length;
}

export function hasExplicitScope(raw: string): boolean {
  return /\b(src\/|lib\/|app\/|pages\/|components\/|modules\/|packages\/)\S+/.test(raw);
}

export function shouldAutoPass(l1: L1Signal, raw: string): boolean {
  if (l1.confidence < getAutoPassThreshold()) return false;
  if (!canInferOutcome(l1.taskType, raw)) return false;
  if (countFileReferences(raw) === 0 && !hasExplicitScope(raw)) return false;
  if (l1.complexity === "high") return false;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/pil/__tests__/clarity-gate.test.ts`
Expected: All passed

- [ ] **Step 5: Commit**

```bash
git add src/pil/clarity-gate.ts src/pil/__tests__/clarity-gate.test.ts
git commit -m "feat(pil): add clarity gate for auto-pass decision"
```

---

### Task 4: Discovery Cache

**Files:**
- Create: `src/pil/discovery-cache.ts`
- Test: `src/pil/__tests__/discovery-cache.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pil/__tests__/discovery-cache.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDiscoveryCache, getCachedProjectContext, setCachedProjectContext } from "../discovery-cache.js";
import type { ProjectContext } from "../discovery-types.js";

const EMPTY_CTX: ProjectContext = {
  language: "typescript",
  framework: "next",
  packageManager: "bun",
  domain: null,
  boundedContexts: [],
  eePatterns: [],
  relevantModules: [],
  scannedAt: Date.now(),
  cwd: "/proj",
};

afterEach(() => clearDiscoveryCache());

describe("discovery-cache", () => {
  it("returns null when empty", () => {
    expect(getCachedProjectContext("/proj")).toBeNull();
  });

  it("returns cached context for same cwd", () => {
    setCachedProjectContext(EMPTY_CTX);
    expect(getCachedProjectContext("/proj")).toEqual(EMPTY_CTX);
  });

  it("returns null for different cwd", () => {
    setCachedProjectContext(EMPTY_CTX);
    expect(getCachedProjectContext("/other")).toBeNull();
  });

  it("returns null after TTL expires", () => {
    const old = { ...EMPTY_CTX, scannedAt: Date.now() - 6 * 60_000 };
    setCachedProjectContext(old);
    expect(getCachedProjectContext("/proj")).toBeNull();
  });

  it("clearDiscoveryCache resets", () => {
    setCachedProjectContext(EMPTY_CTX);
    clearDiscoveryCache();
    expect(getCachedProjectContext("/proj")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bunx vitest run src/pil/__tests__/discovery-cache.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement cache**

```typescript
// src/pil/discovery-cache.ts
import type { ProjectContext } from "./discovery-types.js";

const CACHE_TTL_MS = 5 * 60_000;

let _cached: ProjectContext | null = null;

export function getCachedProjectContext(cwd: string): ProjectContext | null {
  if (!_cached) return null;
  if (_cached.cwd !== cwd) return null;
  if (Date.now() - _cached.scannedAt > CACHE_TTL_MS) return null;
  return _cached;
}

export function setCachedProjectContext(ctx: ProjectContext): void {
  _cached = ctx;
}

export function clearDiscoveryCache(): void {
  _cached = null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/pil/__tests__/discovery-cache.test.ts`
Expected: All passed

- [ ] **Step 5: Commit**

```bash
git add src/pil/discovery-cache.ts src/pil/__tests__/discovery-cache.test.ts
git commit -m "feat(pil): add session-level project context cache"
```

---

### Task 5: L1.5 Context Scan

**Files:**
- Create: `src/pil/layer15-context-scan.ts`
- Test: `src/pil/__tests__/layer15-context-scan.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pil/__tests__/layer15-context-scan.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

import { detectFramework, detectLanguage, detectPackageManager, findRelevantModules, scanProjectContext } from "../layer15-context-scan.js";

describe("detectLanguage()", () => {
  it("detects typescript from tsconfig.json", () => {
    const exists = (p: string) => p.endsWith("tsconfig.json");
    expect(detectLanguage("/proj", exists)).toBe("typescript");
  });
  it("detects python from pyproject.toml", () => {
    const exists = (p: string) => p.endsWith("pyproject.toml") || p.endsWith("requirements.txt");
    expect(detectLanguage("/proj", exists)).toBe("python");
  });
  it("returns null when no signal", () => {
    expect(detectLanguage("/proj", () => false)).toBeNull();
  });
});

describe("detectFramework()", () => {
  it("detects next.js from next.config.js", () => {
    const exists = (p: string) => p.includes("next.config");
    expect(detectFramework("/proj", exists, {})).toBe("next");
  });
  it("detects express from deps", () => {
    expect(detectFramework("/proj", () => false, { express: "4.0.0" })).toBe("express");
  });
  it("detects angular from angular.json", () => {
    const exists = (p: string) => p.endsWith("angular.json");
    expect(detectFramework("/proj", exists, {})).toBe("angular");
  });
});

describe("detectPackageManager()", () => {
  it("detects bun from bun.lockb", () => {
    const exists = (p: string) => p.endsWith("bun.lockb") || p.endsWith("bun.lock");
    expect(detectPackageManager("/proj", exists)).toBe("bun");
  });
  it("detects npm from package-lock.json", () => {
    const exists = (p: string) => p.endsWith("package-lock.json");
    expect(detectPackageManager("/proj", exists)).toBe("npm");
  });
});

describe("findRelevantModules()", () => {
  it("matches keyword against bounded context names", () => {
    const bcs = [
      { path: "src/auth/", name: "auth", entryFiles: [], exportedSymbols: [] },
      { path: "src/billing/", name: "billing", entryFiles: [], exportedSymbols: [] },
    ];
    const result = findRelevantModules("fix auth bug", bcs);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("src/auth/");
  });
  it("returns empty for no keyword matches", () => {
    const bcs = [{ path: "src/auth/", name: "auth", entryFiles: [], exportedSymbols: [] }];
    expect(findRelevantModules("refactor code", bcs)).toHaveLength(0);
  });
});

describe("scanProjectContext()", () => {
  it("returns a ProjectContext with cwd set", async () => {
    const ctx = await scanProjectContext("hello world", "/proj");
    expect(ctx.cwd).toBe("/proj");
    expect(ctx.scannedAt).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bunx vitest run src/pil/__tests__/layer15-context-scan.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement L1.5**

```typescript
// src/pil/layer15-context-scan.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { BoundedContext, ProjectContext, RelevantModule } from "./discovery-types.js";

type ExistsFn = (p: string) => boolean;

export function detectLanguage(cwd: string, exists: ExistsFn = (p) => existsSync(p)): string | null {
  if (exists(join(cwd, "tsconfig.json"))) return "typescript";
  if (exists(join(cwd, "Cargo.toml"))) return "rust";
  if (exists(join(cwd, "go.mod"))) return "go";
  if (exists(join(cwd, "pyproject.toml")) || exists(join(cwd, "requirements.txt"))) return "python";
  if (exists(join(cwd, "package.json"))) return "javascript";
  const slnFiles = safeReaddir(cwd).filter((f) => f.endsWith(".sln"));
  if (slnFiles.length > 0) return "csharp";
  if (exists(join(cwd, "pom.xml")) || exists(join(cwd, "build.gradle"))) return "java";
  return null;
}

export function detectFramework(
  cwd: string,
  exists: ExistsFn = (p) => existsSync(p),
  deps: Record<string, string> = {},
): string | null {
  if (exists(join(cwd, "next.config.js")) || exists(join(cwd, "next.config.mjs")) || exists(join(cwd, "next.config.ts"))) return "next";
  if (exists(join(cwd, "angular.json"))) return "angular";
  if ((exists(join(cwd, "vite.config.ts")) || exists(join(cwd, "vite.config.js"))) && !exists(join(cwd, "next.config.js"))) return "vite";
  if (exists(join(cwd, "Directory.Build.props"))) {
    const hasSln = safeReaddir(cwd).some((f) => f.endsWith(".sln"));
    const hasMuonroi = safeReaddir(join(cwd, "src")).some((f) => f.startsWith("Muonroi."));
    if (hasSln && hasMuonroi) return "muonroi-building-block";
    if (hasSln) return "dotnet";
  }
  if (deps.express) return "express";
  if (deps.django || deps.flask) return deps.django ? "django" : "flask";
  if (exists(join(cwd, "Cargo.toml"))) return "rust";
  if (exists(join(cwd, "go.mod"))) return "go";
  return null;
}

export function detectPackageManager(cwd: string, exists: ExistsFn = (p) => existsSync(p)): string | null {
  if (exists(join(cwd, "bun.lockb")) || exists(join(cwd, "bun.lock"))) return "bun";
  if (exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(cwd, "yarn.lock"))) return "yarn";
  if (exists(join(cwd, "package-lock.json"))) return "npm";
  if (exists(join(cwd, "Cargo.lock"))) return "cargo";
  if (exists(join(cwd, "go.sum"))) return "go";
  return null;
}

export function scanBoundedContexts(cwd: string): BoundedContext[] {
  const srcDir = join(cwd, "src");
  const dirs = safeReaddir(srcDir).filter((d) => {
    try { return readdirSync(join(srcDir, d)).length > 0; } catch { return false; }
  });
  return dirs.slice(0, 20).map((d) => {
    const dirPath = join("src", d);
    const entryNames = ["index.ts", "index.tsx", "index.js", "mod.rs", "__init__.py"];
    const entryFiles = entryNames
      .map((e) => join(dirPath, e))
      .filter((e) => existsSync(join(cwd, e)));
    const exportedSymbols = extractExports(cwd, entryFiles).slice(0, 20);
    return { path: dirPath + "/", name: d, entryFiles, exportedSymbols };
  });
}

function extractExports(cwd: string, entryFiles: string[]): string[] {
  const symbols: string[] = [];
  for (const f of entryFiles) {
    try {
      const content = readFileSync(join(cwd, f), "utf-8");
      const matches = content.matchAll(/export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/g);
      for (const m of matches) symbols.push(m[1]!);
    } catch { /* ignore */ }
  }
  return symbols;
}

export function findRelevantModules(raw: string, boundedContexts: BoundedContext[]): RelevantModule[] {
  const words = raw.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const results: RelevantModule[] = [];
  for (const bc of boundedContexts) {
    const name = bc.name.toLowerCase();
    const match = words.find((w) => name.includes(w) || w.includes(name));
    if (match) {
      results.push({ path: bc.path, relevance: `keyword "${match}" matches module "${bc.name}"`, exists: true });
    }
  }
  return results.slice(0, 5);
}

function readDeps(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch { return {}; }
}

export async function scanProjectContext(raw: string, cwd: string): Promise<ProjectContext> {
  const exists: ExistsFn = (p) => existsSync(p);
  const deps = readDeps(cwd);
  const language = detectLanguage(cwd, exists);
  const framework = detectFramework(cwd, exists, deps);
  const packageManager = detectPackageManager(cwd, exists);
  const boundedContexts = scanBoundedContexts(cwd);
  const relevantModules = findRelevantModules(raw, boundedContexts);

  let eePatterns: string[] = [];
  try {
    const { searchByText } = await import("../ee/bridge.js");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 500);
    const hits = await searchByText(raw, ["experience-behavioral"], 5, ac.signal);
    clearTimeout(timer);
    eePatterns = hits.map((h) => h.payload?.text ?? "").filter(Boolean).slice(0, 5);
  } catch { /* EE unavailable — proceed without patterns */ }

  return {
    language,
    framework,
    packageManager,
    domain: language,
    boundedContexts,
    eePatterns,
    relevantModules,
    scannedAt: Date.now(),
    cwd,
  };
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/pil/__tests__/layer15-context-scan.test.ts`
Expected: All passed

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer15-context-scan.ts src/pil/__tests__/layer15-context-scan.test.ts
git commit -m "feat(pil): add L1.5 context discovery scan"
```

---

### Task 6: L1.6 Clarity Interview

**Files:**
- Create: `src/pil/layer16-clarity.ts`
- Test: `src/pil/__tests__/layer16-clarity.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pil/__tests__/layer16-clarity.test.ts
import { describe, expect, it } from "vitest";
import { detectClarityGaps, buildInterviewQuestion, resolveGapsNonInteractive } from "../layer16-clarity.js";
import type { ProjectContext } from "../discovery-types.js";

const EMPTY_PROJECT: ProjectContext = {
  language: "typescript", framework: null, packageManager: null, domain: null,
  boundedContexts: [
    { path: "src/auth/", name: "auth", entryFiles: ["src/auth/index.ts"], exportedSymbols: ["login", "logout"] },
    { path: "src/billing/", name: "billing", entryFiles: [], exportedSymbols: [] },
  ],
  eePatterns: [], relevantModules: [], scannedAt: Date.now(), cwd: "/proj",
};

describe("detectClarityGaps()", () => {
  it("detects outcome gap for vague prompt", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const outcomeGap = gaps.find((g) => g.dimension === "outcome");
    expect(outcomeGap).toBeDefined();
  });

  it("detects scope gap when no file reference", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const scopeGap = gaps.find((g) => g.dimension === "scope");
    expect(scopeGap).toBeDefined();
  });

  it("returns no gaps for specific prompt", () => {
    const gaps = detectClarityGaps("fix TypeError in src/auth/login.ts:42", "debug", 0.9, EMPTY_PROJECT);
    expect(gaps).toHaveLength(0);
  });

  it("scope options include matching bounded contexts", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const scopeGap = gaps.find((g) => g.dimension === "scope");
    expect(scopeGap?.options.some((o) => o.includes("auth"))).toBe(true);
  });
});

describe("buildInterviewQuestion()", () => {
  it("builds a CouncilQuestionData with pil-interview phase", () => {
    const gap = { dimension: "outcome" as const, description: "no outcome", suggestedQuestion: "What outcome?", options: ["test passes", "no error"], defaultIndex: 0 };
    const q = buildInterviewQuestion(gap, "q-1");
    expect(q.phase).toBe("pil-interview");
    expect(q.questionId).toBe("q-1");
    expect(q.options).toBeDefined();
    expect(q.options!.some((o) => o.kind === "freetext")).toBe(true);
  });
});

describe("resolveGapsNonInteractive()", () => {
  it("fills gaps with best-effort from project context", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const resolved = resolveGapsNonInteractive(gaps, EMPTY_PROJECT, "fix auth");
    expect(resolved.outcome).toBeTruthy();
    expect(resolved.scope.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bunx vitest run src/pil/__tests__/layer16-clarity.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement L1.6**

```typescript
// src/pil/layer16-clarity.ts
import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import type { ClarifiedIntent, ClarityDimension, ClarityGap, ProjectContext } from "./discovery-types.js";
import type { TaskType } from "./types.js";
import { canInferOutcome, countFileReferences, hasExplicitScope } from "./clarity-gate.js";

export function detectClarityGaps(
  raw: string,
  taskType: TaskType | null,
  confidence: number,
  projectContext: ProjectContext,
): ClarityGap[] {
  const gaps: ClarityGap[] = [];

  if (!canInferOutcome(taskType, raw)) {
    const outcomeOptions = buildOutcomeOptions(taskType, projectContext);
    gaps.push({
      dimension: "outcome",
      description: "Cannot infer the expected outcome from the prompt",
      suggestedQuestion: `What's the expected outcome? ${taskType === "debug" ? "(e.g., error gone, test passes, behavior fixed)" : "(e.g., feature works, file updated, test passes)"}`,
      options: outcomeOptions,
      defaultIndex: 0,
    });
  }

  if (countFileReferences(raw) === 0 && !hasExplicitScope(raw)) {
    const scopeOptions = buildScopeOptions(raw, projectContext);
    gaps.push({
      dimension: "scope",
      description: "No specific file or module referenced",
      suggestedQuestion: "Which part of the codebase should this target?",
      options: scopeOptions,
      defaultIndex: 0,
    });
  }

  const hasConstraint = /\b(\d+\s*ms|\d+\s*%|faster|slower|before|deadline|limit|max|min)\b/i.test(raw);
  const isPerformanceTask = /\b(optimi[zs]e|performance|speed|fast|slow|latency|throughput)\b/i.test(raw);
  if (isPerformanceTask && !hasConstraint) {
    gaps.push({
      dimension: "constraint",
      description: "Performance target not specified",
      suggestedQuestion: "Any specific performance target? (e.g., <200ms response, 50% faster)",
      options: ["General improvement", "Specific latency target", "Reduce bundle size"],
      defaultIndex: 0,
    });
  }

  return gaps;
}

function buildOutcomeOptions(taskType: TaskType | null, ctx: ProjectContext): string[] {
  switch (taskType) {
    case "debug": return ["Error disappears", "Test passes", "Feature works correctly"];
    case "refactor": return ["Code cleaner, same behavior", "Better performance", "Easier to test"];
    case "generate": return ["Feature implemented and working", "File created with boilerplate", "Tests added"];
    case "documentation": return ["Docs updated", "README reflects current state", "API docs generated"];
    case "plan": return ["Architecture decided", "Step-by-step plan", "Trade-offs documented"];
    case "analyze": return ["Root cause identified", "Report generated", "Recommendations listed"];
    default: return ["Task completed", "Issue resolved"];
  }
}

function buildScopeOptions(raw: string, ctx: ProjectContext): string[] {
  const words = raw.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const matching = ctx.boundedContexts.filter((bc) => {
    const name = bc.name.toLowerCase();
    return words.some((w) => name.includes(w) || w.includes(name));
  });
  const options = matching.map((bc) => `${bc.path} (${bc.name})`);
  if (options.length === 0 && ctx.boundedContexts.length > 0) {
    options.push(...ctx.boundedContexts.slice(0, 3).map((bc) => `${bc.path} (${bc.name})`));
  }
  options.push("Entire project");
  return options.slice(0, 4);
}

export function buildInterviewQuestion(gap: ClarityGap, questionId: string): CouncilQuestionData {
  const options: CouncilQuestionOption[] = gap.options.map((label) => ({
    label,
    value: label,
    kind: "choice" as const,
  }));
  options.push({
    label: "Type something",
    description: "Enter a custom answer",
    value: "",
    kind: "freetext" as const,
  });

  return {
    questionId,
    question: gap.suggestedQuestion,
    context: gap.description,
    isRequired: false,
    phase: "pil-interview" as CouncilQuestionData["phase"],
    options,
    defaultIndex: gap.defaultIndex,
  };
}

export function resolveGapsNonInteractive(
  gaps: ClarityGap[],
  projectContext: ProjectContext,
  raw: string,
): ClarifiedIntent {
  let outcome = "";
  let scope: string[] = [];
  const constraints: string[] = [];

  for (const gap of gaps) {
    const defaultAnswer = gap.options[gap.defaultIndex] ?? gap.options[0] ?? "";
    switch (gap.dimension) {
      case "outcome":
        outcome = defaultAnswer;
        break;
      case "scope": {
        const relevant = projectContext.relevantModules.map((m) => m.path);
        scope = relevant.length > 0 ? relevant : [defaultAnswer];
        break;
      }
      case "constraint":
        constraints.push(defaultAnswer);
        break;
    }
  }

  if (!outcome) outcome = `Complete the task described in: "${raw.slice(0, 80)}"`;
  if (scope.length === 0) {
    scope = projectContext.relevantModules.map((m) => m.path);
    if (scope.length === 0) scope = ["project root"];
  }

  return {
    outcome,
    scope,
    constraints,
    gaps: gaps.map((g) => ({ ...g, answer: null })),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/pil/__tests__/layer16-clarity.test.ts`
Expected: All passed

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer16-clarity.ts src/pil/__tests__/layer16-clarity.test.ts
git commit -m "feat(pil): add L1.6 clarity interview gap detection and question generation"
```

---

### Task 7: L1.7 Feasibility Check

**Files:**
- Create: `src/pil/layer17-feasibility.ts`
- Test: `src/pil/__tests__/layer17-feasibility.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pil/__tests__/layer17-feasibility.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

import { checkFeasibility } from "../layer17-feasibility.js";
import type { ClarifiedIntent, ProjectContext } from "../discovery-types.js";

const PROJECT: ProjectContext = {
  language: "typescript", framework: null, packageManager: null, domain: null,
  boundedContexts: [{ path: "src/auth/", name: "auth", entryFiles: ["src/auth/index.ts"], exportedSymbols: [] }],
  eePatterns: [], relevantModules: [], scannedAt: Date.now(), cwd: "/proj",
};

describe("checkFeasibility()", () => {
  it("returns no warnings when scope files exist", async () => {
    const intent: ClarifiedIntent = { outcome: "done", scope: ["src/auth/"], constraints: [], gaps: [] };
    const result = await checkFeasibility(intent, PROJECT, (p) => true);
    expect(result.viable).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns warning when scope file does not exist", async () => {
    const intent: ClarifiedIntent = { outcome: "done", scope: ["src/billing/pay.ts"], constraints: [], gaps: [] };
    const result = await checkFeasibility(intent, PROJECT, (p) => false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("src/billing/pay.ts");
  });

  it("still returns viable=true even with warnings", async () => {
    const intent: ClarifiedIntent = { outcome: "done", scope: ["missing.ts"], constraints: [], gaps: [] };
    const result = await checkFeasibility(intent, PROJECT, () => false);
    expect(result.viable).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bunx vitest run src/pil/__tests__/layer17-feasibility.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement L1.7**

```typescript
// src/pil/layer17-feasibility.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClarifiedIntent, FeasibilityResult, ProjectContext } from "./discovery-types.js";

type ExistsFn = (p: string) => boolean;

export async function checkFeasibility(
  intent: ClarifiedIntent,
  projectContext: ProjectContext,
  exists: ExistsFn = (p) => existsSync(join(projectContext.cwd, p)),
): Promise<FeasibilityResult> {
  const warnings: string[] = [];
  const adjustedScope: string[] = [];

  for (const scopeItem of intent.scope) {
    if (scopeItem === "project root" || scopeItem === "Entire project") {
      adjustedScope.push(scopeItem);
      continue;
    }
    const cleanPath = scopeItem.replace(/\s*\(.*\)\s*$/, "").trim();
    if (exists(cleanPath)) {
      adjustedScope.push(cleanPath);
    } else {
      warnings.push(`File/directory not found: ${cleanPath}`);
      const matchingBc = projectContext.boundedContexts.find(
        (bc) => cleanPath.startsWith(bc.path) || bc.path.startsWith(cleanPath),
      );
      if (matchingBc) {
        adjustedScope.push(matchingBc.path);
        warnings.push(`→ Adjusted scope to nearest module: ${matchingBc.path}`);
      }
    }
  }

  return {
    viable: true,
    warnings,
    adjustedScope: adjustedScope.length > 0 ? adjustedScope : intent.scope,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/pil/__tests__/layer17-feasibility.test.ts`
Expected: All passed

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer17-feasibility.ts src/pil/__tests__/layer17-feasibility.test.ts
git commit -m "feat(pil): add L1.7 feasibility check"
```

---

### Task 8: L1.8 Acceptance Card Builder

**Files:**
- Create: `src/pil/layer18-acceptance.ts`
- Test: `src/pil/__tests__/layer18-acceptance.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pil/__tests__/layer18-acceptance.test.ts
import { describe, expect, it } from "vitest";
import { buildAcceptanceCard, buildAcceptanceQuestion } from "../layer18-acceptance.js";
import type { ClarifiedIntent, FeasibilityResult } from "../discovery-types.js";

describe("buildAcceptanceCard()", () => {
  it("builds card with intent, outcome, scope, and warnings", () => {
    const intent: ClarifiedIntent = { outcome: "error gone", scope: ["src/auth/jwt.ts"], constraints: [], gaps: [] };
    const feasibility: FeasibilityResult = { viable: true, warnings: ["oauth.ts also handles tokens"], adjustedScope: ["src/auth/jwt.ts"] };
    const card = buildAcceptanceCard("Fix JWT validation returning 401", intent, feasibility);
    expect(card.intentStatement).toBe("Fix JWT validation returning 401");
    expect(card.outcome).toBe("error gone");
    expect(card.scope).toEqual(["src/auth/jwt.ts"]);
    expect(card.warnings).toEqual(["oauth.ts also handles tokens"]);
  });
});

describe("buildAcceptanceQuestion()", () => {
  it("builds a CouncilQuestionData with pil-acceptance phase", () => {
    const card = { intentStatement: "Fix auth", outcome: "done", scope: ["src/auth/"], warnings: [] };
    const q = buildAcceptanceQuestion(card, "acc-1");
    expect(q.phase).toBe("pil-acceptance");
    expect(q.questionId).toBe("acc-1");
    expect(q.options).toHaveLength(3);
    expect(q.options![0]!.label).toBe("Accept");
    expect(q.options![1]!.label).toBe("Adjust");
    expect(q.options![2]!.label).toBe("Cancel");
    expect(q.defaultIndex).toBe(0);
  });

  it("includes warnings in context when present", () => {
    const card = { intentStatement: "Fix auth", outcome: "done", scope: ["src/auth/"], warnings: ["risk: oauth.ts"] };
    const q = buildAcceptanceQuestion(card, "acc-2");
    expect(q.context).toContain("risk: oauth.ts");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bunx vitest run src/pil/__tests__/layer18-acceptance.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement L1.8**

```typescript
// src/pil/layer18-acceptance.ts
import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import type { AcceptanceCardData, ClarifiedIntent, FeasibilityResult } from "./discovery-types.js";

export function buildAcceptanceCard(
  intentStatement: string,
  intent: ClarifiedIntent,
  feasibility: FeasibilityResult,
): AcceptanceCardData {
  return {
    intentStatement,
    outcome: intent.outcome,
    scope: feasibility.adjustedScope.length > 0 ? feasibility.adjustedScope : intent.scope,
    warnings: feasibility.warnings,
  };
}

export function buildAcceptanceQuestion(card: AcceptanceCardData, questionId: string): CouncilQuestionData {
  const contextLines: string[] = [];
  contextLines.push(`Outcome: ${card.outcome}`);
  contextLines.push(`Scope: ${card.scope.join(", ")}`);
  if (card.warnings.length > 0) {
    contextLines.push(`⚠ ${card.warnings.join("; ")}`);
  }

  const options: CouncilQuestionOption[] = [
    { label: "Accept", value: "accept", kind: "choice", description: "Proceed with this understanding" },
    { label: "Adjust", value: "adjust", kind: "choice", description: "Let me clarify further" },
    { label: "Cancel", value: "cancel", kind: "choice", description: "Never mind" },
  ];

  return {
    questionId,
    question: `I understand you want to: ${card.intentStatement}`,
    context: contextLines.join("\n"),
    isRequired: true,
    phase: "pil-acceptance" as CouncilQuestionData["phase"],
    options,
    defaultIndex: 0,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/pil/__tests__/layer18-acceptance.test.ts`
Expected: All passed

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer18-acceptance.ts src/pil/__tests__/layer18-acceptance.test.ts
git commit -m "feat(pil): add L1.8 acceptance card builder"
```

---

### Task 9: Discovery Orchestrator

**Files:**
- Create: `src/pil/discovery.ts`
- Test: `src/pil/__tests__/discovery.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pil/__tests__/discovery.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

import { runDiscovery } from "../discovery.js";
import { clearDiscoveryCache } from "../discovery-cache.js";
import type { DiscoveryInteractionHandler, DiscoveryResult } from "../discovery-types.js";

afterEach(() => clearDiscoveryCache());

const mockHandler: DiscoveryInteractionHandler = {
  askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "Error disappears", kind: "choice" }),
  showAcceptance: vi.fn().mockResolvedValue("accept"),
};

describe("runDiscovery()", () => {
  it("auto-passes on high-confidence specific prompt", async () => {
    const result = await runDiscovery(
      "fix TypeError in src/auth/login.ts:42",
      { taskType: "debug", confidence: 0.9, complexity: "low", domain: "typescript", outputStyle: "balanced", intentKind: "task" },
      process.cwd(),
      null,
    );
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
  });

  it("interviews user on vague prompt with handler", async () => {
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "Error disappears", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("accept"),
    };
    const result = await runDiscovery(
      "fix auth",
      { taskType: "debug", confidence: 0.6, complexity: "low", domain: "typescript", outputStyle: null, intentKind: "task" },
      process.cwd(),
      handler,
    );
    expect(result.interviewed).toBe(true);
    expect(result.accepted).toBe(true);
    expect(handler.showAcceptance).toHaveBeenCalled();
  });

  it("skips interview but still passes when handler is null (headless)", async () => {
    const result = await runDiscovery(
      "fix auth",
      { taskType: "debug", confidence: 0.6, complexity: "low", domain: "typescript", outputStyle: null, intentKind: "task" },
      process.cwd(),
      null,
    );
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
  });

  it("sets accepted=false when user cancels", async () => {
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "done", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("cancel"),
    };
    const result = await runDiscovery(
      "fix auth",
      { taskType: "debug", confidence: 0.6, complexity: "low", domain: "typescript", outputStyle: null, intentKind: "task" },
      process.cwd(),
      handler,
    );
    expect(result.accepted).toBe(false);
  });

  it("skips discovery entirely for chitchat", async () => {
    const result = await runDiscovery(
      "hi",
      { taskType: null, confidence: 0.5, complexity: "low", domain: null, outputStyle: null, intentKind: "chitchat" },
      process.cwd(),
      mockHandler,
    );
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bunx vitest run src/pil/__tests__/discovery.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement discovery orchestrator**

```typescript
// src/pil/discovery.ts
import { randomUUID } from "node:crypto";
import type { OutputStyle, TaskType } from "./types.js";
import type { ClarifiedIntent, DiscoveryInteractionHandler, DiscoveryResult, ProjectContext } from "./discovery-types.js";
import { isDiscoveryEnabled, getMaxInterviewQuestions } from "./config.js";
import { shouldAutoPass, type L1Signal } from "./clarity-gate.js";
import { getCachedProjectContext, setCachedProjectContext } from "./discovery-cache.js";
import { scanProjectContext } from "./layer15-context-scan.js";
import { detectClarityGaps, buildInterviewQuestion, resolveGapsNonInteractive } from "./layer16-clarity.js";
import { checkFeasibility } from "./layer17-feasibility.js";
import { buildAcceptanceCard, buildAcceptanceQuestion } from "./layer18-acceptance.js";

export interface L1Result {
  taskType: TaskType | null;
  confidence: number;
  complexity: "low" | "medium" | "high";
  domain: string | null;
  outputStyle: OutputStyle | null;
  intentKind: "task" | "chitchat" | null;
}

export async function runDiscovery(
  raw: string,
  l1: L1Result,
  cwd: string,
  handler: DiscoveryInteractionHandler | null,
): Promise<DiscoveryResult> {
  const start = Date.now();

  const baseResult = (): DiscoveryResult => ({
    raw,
    projectContext: { language: null, framework: null, packageManager: null, domain: null, boundedContexts: [], eePatterns: [], relevantModules: [], scannedAt: Date.now(), cwd },
    clarifiedIntent: { outcome: raw, scope: [], constraints: [], gaps: [] },
    feasibility: { viable: true, warnings: [], adjustedScope: [] },
    interviewed: false,
    intentStatement: raw,
    outcome: raw,
    scope: [],
    feasibilityWarnings: [],
    accepted: true,
    taskType: l1.taskType,
    confidence: l1.confidence,
    domain: l1.domain,
    outputStyle: l1.outputStyle,
    discoveryMs: Date.now() - start,
  });

  if (!isDiscoveryEnabled()) return baseResult();
  if (l1.intentKind === "chitchat" || l1.taskType === null) return baseResult();

  const l1Signal: L1Signal = { confidence: l1.confidence, taskType: l1.taskType, complexity: l1.complexity };

  if (shouldAutoPass(l1Signal, raw)) return baseResult();

  // L1.5: Context Discovery (cacheable)
  let projectContext: ProjectContext;
  const cached = getCachedProjectContext(cwd);
  if (cached) {
    projectContext = cached;
  } else {
    try {
      projectContext = await Promise.race([
        scanProjectContext(raw, cwd),
        new Promise<ProjectContext>((resolve) =>
          setTimeout(() => resolve({ language: null, framework: null, packageManager: null, domain: null, boundedContexts: [], eePatterns: [], relevantModules: [], scannedAt: Date.now(), cwd }), 500),
        ),
      ]);
      setCachedProjectContext(projectContext);
    } catch {
      projectContext = { language: null, framework: null, packageManager: null, domain: null, boundedContexts: [], eePatterns: [], relevantModules: [], scannedAt: Date.now(), cwd };
    }
  }

  // L1.6: Clarity Interview
  const gaps = detectClarityGaps(raw, l1.taskType, l1.confidence, projectContext);
  let clarifiedIntent: ClarifiedIntent;
  let interviewed = false;

  if (gaps.length > 0 && handler) {
    interviewed = true;
    const answeredGaps = [...gaps];
    const maxQ = Math.min(gaps.length, getMaxInterviewQuestions());

    for (let i = 0; i < maxQ; i++) {
      const gap = answeredGaps[i]!;
      const question = buildInterviewQuestion(gap, randomUUID());
      const answer = await handler.askQuestion(question);
      (answeredGaps[i] as typeof gap & { answer: string | null }).answer = answer.text;
    }

    clarifiedIntent = {
      outcome: answeredGaps.find((g) => g.dimension === "outcome" && "answer" in g)?.answer as string ?? `Complete: ${raw.slice(0, 80)}`,
      scope: (() => {
        const scopeAnswer = answeredGaps.find((g) => g.dimension === "scope" && "answer" in g)?.answer as string | undefined;
        if (scopeAnswer) return [scopeAnswer.replace(/\s*\(.*\)\s*$/, "").trim()];
        return projectContext.relevantModules.map((m) => m.path);
      })(),
      constraints: (() => {
        const constraintAnswer = answeredGaps.find((g) => g.dimension === "constraint" && "answer" in g)?.answer as string | undefined;
        return constraintAnswer ? [constraintAnswer] : [];
      })(),
      gaps: answeredGaps.map((g) => ({ ...g, answer: "answer" in g ? (g as { answer: string | null }).answer : null })),
    };
  } else {
    clarifiedIntent = resolveGapsNonInteractive(gaps, projectContext, raw);
  }

  // L1.7: Feasibility Check
  let feasibility = await checkFeasibility(clarifiedIntent, projectContext).catch(() => ({
    viable: true as const,
    warnings: [] as string[],
    adjustedScope: clarifiedIntent.scope,
  }));

  // L1.8: User Acceptance
  const intentStatement = `${l1.taskType ?? "task"}: ${clarifiedIntent.outcome}`;
  let accepted = true;

  if (handler && interviewed) {
    const card = buildAcceptanceCard(intentStatement, clarifiedIntent, feasibility);
    const question = buildAcceptanceQuestion(card, randomUUID());
    const answer = await handler.askQuestion(question);
    const decision = answer.text.toLowerCase();

    if (decision === "cancel") {
      accepted = false;
    } else if (decision === "adjust") {
      // Re-run interview once with previous context
      for (let i = 0; i < Math.min(gaps.length, getMaxInterviewQuestions()); i++) {
        const gap = gaps[i]!;
        const q = buildInterviewQuestion(gap, randomUUID());
        const ans = await handler.askQuestion(q);
        const existing = clarifiedIntent.gaps.find((g) => g.dimension === gap.dimension);
        if (existing) existing.answer = ans.text;
      }
      // Re-check feasibility after adjustment
      feasibility = await checkFeasibility(clarifiedIntent, projectContext).catch(() => feasibility);
      // Auto-accept after adjustment (max 1 retry per spec)
      accepted = true;
    }
  }

  return {
    raw,
    projectContext,
    clarifiedIntent,
    feasibility,
    interviewed,
    intentStatement,
    outcome: clarifiedIntent.outcome,
    scope: feasibility.adjustedScope.length > 0 ? feasibility.adjustedScope : clarifiedIntent.scope,
    feasibilityWarnings: feasibility.warnings,
    accepted,
    taskType: l1.taskType,
    confidence: l1.confidence,
    domain: l1.domain,
    outputStyle: l1.outputStyle,
    discoveryMs: Date.now() - start,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/pil/__tests__/discovery.test.ts`
Expected: All passed

- [ ] **Step 5: Commit**

```bash
git add src/pil/discovery.ts src/pil/__tests__/discovery.test.ts
git commit -m "feat(pil): add discovery orchestrator (L1.5-L1.8)"
```

---

### Task 10: Wire Discovery into Pipeline

**Files:**
- Modify: `src/pil/pipeline.ts`
- Modify: `src/pil/types.ts`
- Modify: `src/pil/index.ts`
- Test: `src/pil/__tests__/pipeline.test.ts` (existing — add new tests)

- [ ] **Step 1: Add DiscoveryResult to PipelineContext in types.ts**

Add at the end of the `PipelineContext` interface in `src/pil/types.ts` (after `_intentTrace`):

```typescript
  /**
   * Discovery phase result. Present when L1.5–L1.8 ran (vague prompt + handler available).
   * Null when auto-passed or discovery disabled.
   */
  _discoveryResult?: import("./discovery-types.js").DiscoveryResult | null;
```

- [ ] **Step 2: Add interactionHandler to PipelineOptions and wire discovery into pipeline.ts**

In `src/pil/pipeline.ts`, add to the `PipelineOptions` interface:

```typescript
export interface PipelineOptions {
  gsdPhase?: string | null;
  resumeDigest?: string | null;
  activeRunId?: string | null;
  sessionId?: string | null;
  interactionHandler?: import("./discovery-types.js").DiscoveryInteractionHandler | null;
}
```

Then modify `runPipeline` to call discovery after L1 and before L2–L6. In the `runLayers` function, after `await timed("layer1-intent", layer1Intent);` (line 95) and before the `if (ctx.taskType !== null)` block (line 97), insert:

```typescript
  // Phase 1 discovery: L1.5–L1.8 (interactive, no hard timeout)
  if (isDiscoveryEnabled() && ctx.intentKind !== "chitchat") {
    const { runDiscovery } = await import("./discovery.js");
    const discoveryStart = Date.now();
    try {
      const l1Result = {
        taskType: ctx.taskType,
        confidence: ctx.confidence,
        complexity: ctx._intentTrace?.complexity ?? ("low" as const),
        domain: ctx.domain,
        outputStyle: ctx.outputStyle,
        intentKind: ctx.intentKind ?? null,
      };
      const discovery = await runDiscovery(ctx.raw, l1Result, process.cwd(), options?.interactionHandler ?? null);
      ctx = {
        ...ctx,
        _discoveryResult: discovery,
      };
      if (discovery.interviewed && discovery.accepted) {
        // Prepend discovery context to enriched prompt
        const discoveryPrefix = [
          `[Discovery] Intent: ${discovery.intentStatement}`,
          `[Discovery] Outcome: ${discovery.outcome}`,
          discovery.scope.length > 0 ? `[Discovery] Scope: ${discovery.scope.join(", ")}` : "",
          discovery.feasibilityWarnings.length > 0 ? `[Discovery] Warnings: ${discovery.feasibilityWarnings.join("; ")}` : "",
        ].filter(Boolean).join("\n");
        ctx = { ...ctx, enriched: `${discoveryPrefix}\n\n${ctx.enriched}` };
      }
      if (!discovery.accepted) {
        // User cancelled — return raw prompt, skip enrichment
        return { ...ctx, enriched: ctx.raw, fallbackReason: "discovery-cancelled" };
      }
    } catch {
      // Discovery failure — continue with existing enrichment (fail-open)
    }
    timings.push({ name: "discovery", ms: Date.now() - discoveryStart });
  }
```

Add the import at the top of `pipeline.ts`:

```typescript
import { isDiscoveryEnabled } from "./config.js";
```

- [ ] **Step 3: Update exports in index.ts**

Add to `src/pil/index.ts`:

```typescript
export type { DiscoveryInteractionHandler, DiscoveryResult, ProjectContext, AcceptanceCardData } from "./discovery-types.js";
export { isDiscoveryEnabled } from "./config.js";
```

- [ ] **Step 4: Write integration test**

Append to `src/pil/__tests__/pipeline.test.ts`:

```typescript
describe("runPipeline() with discovery", () => {
  it("passes interactionHandler through and runs discovery on vague prompt", async () => {
    process.env.MUONROI_PIL_DISCOVERY = "1";
    const handler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "Error gone", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("accept"),
    };
    const ctx = await runPipeline("fix auth", { interactionHandler: handler });
    expect(ctx.raw).toBe("fix auth");
    // Discovery should have run (vague prompt, low confidence from mock classifier)
    expect(ctx._discoveryResult).toBeDefined();
    delete process.env.MUONROI_PIL_DISCOVERY;
  });

  it("skips discovery when disabled", async () => {
    process.env.MUONROI_PIL_DISCOVERY = "0";
    const ctx = await runPipeline("fix auth");
    expect(ctx._discoveryResult).toBeUndefined();
    delete process.env.MUONROI_PIL_DISCOVERY;
  });
});
```

- [ ] **Step 5: Run all PIL tests**

Run: `bunx vitest run src/pil/`
Expected: All passed (existing + new tests)

- [ ] **Step 6: Commit**

```bash
git add src/pil/pipeline.ts src/pil/types.ts src/pil/index.ts src/pil/__tests__/pipeline.test.ts
git commit -m "feat(pil): wire discovery phase into pipeline with backward-compatible API"
```

---

### Task 11: TUI Phase Labels

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/ui/components/council-question-card.tsx`

- [ ] **Step 1: Extend CouncilQuestionPhase type**

In `src/types/index.ts`, change line 221:

```typescript
// Before:
export type CouncilQuestionPhase = "clarify" | "preflight" | "plan-confirm" | "post-debate";

// After:
export type CouncilQuestionPhase = "clarify" | "preflight" | "plan-confirm" | "post-debate" | "pil-interview" | "pil-acceptance";
```

- [ ] **Step 2: Add phase labels to card component**

In `src/ui/components/council-question-card.tsx`, change the `PHASE_LABEL` record (line 5):

```typescript
// Before:
const PHASE_LABEL: Record<CouncilQuestionPhase, string> = {
  clarify: "Clarify",
  preflight: "Pre-flight",
  "plan-confirm": "Plan",
  "post-debate": "Post-Debate",
};

// After:
const PHASE_LABEL: Record<CouncilQuestionPhase, string> = {
  clarify: "Clarify",
  preflight: "Pre-flight",
  "plan-confirm": "Plan",
  "post-debate": "Post-Debate",
  "pil-interview": "Understanding",
  "pil-acceptance": "Confirm Intent",
};
```

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/ui/components/council-question-card.tsx
git commit -m "feat(pil): add TUI phase labels for discovery interview and acceptance"
```

---

### Task 12: Consumer Integration (message-processor.ts)

**Files:**
- Modify: `src/orchestrator/message-processor.ts`

The plumbing follows the same pattern as `product-loop/gather.ts` (lines 78–121) and `product-loop/loop-driver.ts` (lines 306–350): a chunk queue + emit callback + `councilManager.createQuestionResponder()` + drain loop.

Key discovery: `processMessage` is an `AsyncGenerator<StreamChunk>` — PIL discovery chunks are yielded inline. `deps.councilManager` provides question responder plumbing. The emit + respondToQuestion pattern is NOT directly on `deps` — it's built by creating a question responder from `councilManager`.

- [ ] **Step 1: Read the current runPipeline call site and surrounding generator**

Read: `src/orchestrator/message-processor.ts` lines 395–435 (the `runPipeline` call). Confirm `processMessage` is `async *processMessage(...)`. Note the `deps.councilManager` accessor at line 171.

- [ ] **Step 2: Replace the runPipeline call with discovery-aware handler + chunk drain**

Replace the entire `runPipeline` call block (lines ~402–423 — from the `// PIL:` comment through the `.catch(...)` closing paren) with:

```typescript
    // --- PIL with discovery (interactive path) ---
    // Build discovery handler using council plumbing (same pattern as gather.ts:78)
    const pilChunkQueue: StreamChunk[] = [];
    const pilResponder = deps.councilManager.createQuestionResponder();

    const discoveryHandler: import("../pil/discovery-types.js").DiscoveryInteractionHandler = {
      askQuestion: async (question) => {
        pilChunkQueue.push({
          type: "council_question",
          content: question.question,
          councilQuestion: question,
        } as StreamChunk);
        const text = await pilResponder(question.questionId);
        return { questionId: question.questionId, text, kind: "choice" as const };
      },
      showAcceptance: async (card) => {
        const { buildAcceptanceQuestion } = await import("../pil/layer18-acceptance.js");
        const question = buildAcceptanceQuestion(card, crypto.randomUUID());
        pilChunkQueue.push({
          type: "council_question",
          content: question.question,
          councilQuestion: question,
        } as StreamChunk);
        const text = await pilResponder(question.questionId);
        return text.toLowerCase() as "accept" | "adjust" | "cancel";
      },
    };

    // Run PIL as background task, drain emitted chunks via yield
    // (same pattern as loop-driver.ts:306-350)
    const _pilStart = Date.now();
    let pilCtxResolved: typeof pilCtxFallback | null = null;
    let pilDone = false;

    // Keep the existing fallback shape for the catch path
    const pilCtxFallback = {
      raw: userMessage,
      enriched: userMessage,
      taskType: null,
      domain: null,
      confidence: 0,
      outputStyle: null,
      tokenBudget: 500,
      metrics: null,
      layers: [],
      gsdPhase: null,
      activeRunId: null,
      intentKind: null as "task" | "chitchat" | null,
      fallbackReason: null as string | null,
    };

    const pilTask = (async () => {
      try {
        pilCtxResolved = await runPipeline(userMessage, {
          resumeDigest: deps.getResumeDigest(),
          activeRunId: deps.getActiveRunId(),
          sessionId: deps.session?.id ?? null,
          interactionHandler: discoveryHandler,
        });
      } catch (err) {
        pilCtxResolved = {
          ...pilCtxFallback,
          fallbackReason: err instanceof Error ? `orchestrator-catch:${err.name}` : "orchestrator-catch:unknown",
        };
      } finally {
        pilDone = true;
      }
    })();

    // Drain chunk queue (askcard questions) while PIL is running.
    while (!pilDone) {
      while (pilChunkQueue.length > 0) {
        yield pilChunkQueue.shift()!;
      }
      if (!pilDone) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    while (pilChunkQueue.length > 0) {
      yield pilChunkQueue.shift()!;
    }
    await pilTask;

    const pilCtx = pilCtxResolved!;
```

**Important**: remove the OLD `runPipeline` call and its `.catch()` block entirely — the new code replaces it.

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Run existing orchestrator tests**

Run: `bunx vitest run src/pil/__tests__/orchestrator-integration.test.ts`
Expected: All passed

- [ ] **Step 5: Run full PIL test suite**

Run: `bunx vitest run src/pil/`
Expected: All passed

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/message-processor.ts
git commit -m "feat(pil): wire discovery interaction handler into message processor with chunk drain loop"
```

---

### Task 13: Full Integration Test

**Files:**
- Run existing test suites

- [ ] **Step 1: Run full PIL test suite**

Run: `bunx vitest run src/pil/`
Expected: All passed

- [ ] **Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Run full unit test suite**

Run: `bunx vitest run`
Expected: No regressions (some pre-existing skips are OK)

- [ ] **Step 4: Run harness tests (Windows native)**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/`
Expected: No regressions vs baseline

- [ ] **Step 5: Commit any fixes needed**

If any test needed adjustment, commit fixes:
```bash
git add -A
git commit -m "fix(pil): address integration test issues from discovery wiring"
```
