import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * High-confidence project discovery for /ideal — runs before gather so the
 * loop does not ask the user about things the codebase already answers (stack,
 * test command). Soft dimensions like persona/core-features/cost-tolerance are
 * deliberately NOT auto-filled (low signal-to-noise from README scraping).
 */
export interface DiscoveryResult {
  hasProject: boolean;
  /** Maps SEED_DIMENSIONS.id → confident answer. Only populated when evidence is unambiguous. */
  prefilled: Map<string, string>;
  /** Audit trail: which file proved each dimension. */
  evidence: Array<{ dim: string; source: string; value: string }>;
  /** Human-readable summary line per discovery (for the streamed chunk). */
  notes: string[];
}

interface ManifestProbe {
  filename: string;
  language: string;
  testHint?: string;
}

const MANIFESTS: ManifestProbe[] = [
  { filename: "package.json", language: "TypeScript/JavaScript (Node.js)" },
  { filename: "pyproject.toml", language: "Python", testHint: "pytest" },
  { filename: "requirements.txt", language: "Python", testHint: "pytest" },
  { filename: "Cargo.toml", language: "Rust", testHint: "cargo test" },
  { filename: "go.mod", language: "Go", testHint: "go test ./..." },
  { filename: "pom.xml", language: "Java (Maven)", testHint: "mvn test" },
  { filename: "build.gradle", language: "Java/Kotlin (Gradle)", testHint: "gradle test" },
  { filename: "Gemfile", language: "Ruby", testHint: "bundle exec rspec" },
  { filename: "composer.json", language: "PHP", testHint: "composer test" },
];

export async function discoverProject(cwd: string | undefined): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    hasProject: false,
    prefilled: new Map(),
    evidence: [],
    notes: [],
  };
  if (!cwd) return result;

  for (const probe of MANIFESTS) {
    const found = await readIfExists(path.join(cwd, probe.filename));
    if (!found) continue;
    result.hasProject = true;

    if (probe.filename === "package.json") {
      await fillFromPackageJson(found, probe, result);
    } else {
      // Non-package.json manifests: language is enough for tech-constraints; test hint
      // is best-effort (does not parse contents for fine-grained framework detection).
      addPrefill(
        result,
        "tech-constraints",
        probe.language,
        probe.filename,
        `Detected ${probe.language} from ${probe.filename}`,
      );
      if (probe.testHint) {
        addPrefill(
          result,
          "success-metric",
          `automated tests pass (${probe.testHint})`,
          probe.filename,
          `Test runner inferred: ${probe.testHint}`,
        );
      }
    }
    break;
  }

  return result;
}

async function fillFromPackageJson(content: string, probe: ManifestProbe, out: DiscoveryResult): Promise<void> {
  let pkg: any = null;
  try {
    pkg = JSON.parse(content);
  } catch {
    addPrefill(
      out,
      "tech-constraints",
      probe.language,
      probe.filename,
      `Detected ${probe.language} from package.json (unparseable, using default stack)`,
    );
    return;
  }

  const frameworks = detectNodeFrameworks(pkg);
  const stack = frameworks.length > 0 ? `${probe.language} + ${frameworks.join(", ")}` : probe.language;
  addPrefill(out, "tech-constraints", stack, probe.filename, `Stack: ${stack}`);

  const testCmd: string | undefined = pkg?.scripts?.test;
  if (testCmd && !/echo .*no test/i.test(testCmd)) {
    addPrefill(
      out,
      "success-metric",
      `automated tests pass via \`npm test\` (${testCmd.slice(0, 80)})`,
      probe.filename,
      `Test command: ${testCmd.slice(0, 80)}`,
    );
  }
}

function detectNodeFrameworks(pkg: any): string[] {
  const out: string[] = [];
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.react || deps.next) out.push("React/Next.js");
  if (deps.vue || deps.nuxt) out.push("Vue/Nuxt");
  if (deps["@angular/core"]) out.push("Angular");
  if (deps.express || deps.fastify || deps.koa) out.push("Node.js HTTP");
  if (deps.nestjs || deps["@nestjs/core"]) out.push("NestJS");
  if (deps.vitest) out.push("Vitest");
  else if (deps.jest) out.push("Jest");
  return out;
}

function addPrefill(out: DiscoveryResult, dim: string, value: string, source: string, note: string): void {
  if (out.prefilled.has(dim)) return;
  out.prefilled.set(dim, value);
  out.evidence.push({ dim, source, value });
  out.notes.push(note);
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Format DiscoveryResult into a single content chunk for the UI. Returns null
 * when nothing was detected (caller can skip the chunk).
 */
export function formatDiscoverySummary(d: DiscoveryResult): string | null {
  if (!d.hasProject) {
    return "No existing project manifest detected — proceeding as greenfield.";
  }
  if (d.prefilled.size === 0) {
    return "Existing project detected, but no high-confidence dimensions could be auto-filled.";
  }
  const lines = ["**Discovered from your project:**"];
  for (const ev of d.evidence) {
    lines.push(`- \`${ev.dim}\` ← ${ev.value} _(from ${ev.source})_`);
  }
  lines.push("");
  lines.push(
    `Skipping ${d.prefilled.size} clarification question${d.prefilled.size === 1 ? "" : "s"}; you'll only be asked the rest.`,
  );
  return lines.join("\n");
}
