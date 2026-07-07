/**
 * Build the concrete continuation prompt fed to the LLM after an init_new
 * scaffold completes. The prompt MUST be specific enough that the LLM stops
 * asking "what do you want?" and starts generating domain code.
 */
export interface ContinuationPromptInput {
  originalPrompt: string;
  projectDir: string;
  templateName: string;
  installedPackages?: readonly string[];
}

export function buildIdealContinuationPrompt(input: ContinuationPromptInput): string {
  const { originalPrompt, projectDir, templateName, installedPackages } = input;

  const packagesSuffix =
    installedPackages && installedPackages.length > 0 ? ` with packages: ${installedPackages.join(", ")}` : "";

  return `You are continuing a /ideal product loop. The project has been scaffolded at ${projectDir} using the BB template ${templateName}${packagesSuffix}.

User's original request:
"${originalPrompt}"

You MUST implement this feature now. Do NOT ask the user for clarification unless a hard blocker is reached (missing API key, ambiguous schema requirement, etc.).

Execute these steps in order:

1. Discover structure (1-2 tool calls max)
   - PREFERRED: if a \`muonroi-docs\` MCP tool is in your tool list (look for any \`mcp_*docs*_docs_search\` tool), call it with query \`"${templateName} structure overview"\`. This is faster than reading files.
   - FALLBACK: list the project directory, then read whichever of \`README.md\`, \`AGENTS.md\`, \`Agent.md\`, \`EE-INTENT.md\` actually exist (do NOT assume — missing files are fine, just skip them).
   - Identify: project name, main entry point (Program.cs / Gateway), modular boundaries, where to add new domain code.

IMPORTANT — Template sample files are REFERENCE ONLY:
   - The BB template ships example code (e.g. \`todo-app.Catalog\`, sample \`TodoRepository\`, \`Catalog\` controller, \`DocTemplateDbContext\`, \`BaseTemplateDbContext\`) named after the template/demo, NOT after the user's project.
   - Read AT MOST ONE such sample file to learn the convention, then DELETE all template sample directories before generating your real domain code. They are reference, not the user's feature.
   - Do not re-read the same sample file repeatedly. If you need its pattern again, recall from memory or rely on \`docs.search\`.
   - RENAME every file/class/namespace that still contains the literal token \`BaseTemplate\`, \`DocTemplate\`, or \`TemplateSample\` to a project-appropriate name BEFORE writing domain code. After cleanup, \`git grep -i basetemplate\` MUST return zero hits — the post-scaffold quality gate fails if any survive.
   - DELETE any stub \`<projectName>.Catalog/\` directory that lives at server root next to \`server/src/Services/\` — \`dotnet new\` may emit a duplicate empty stub.

.NET / C# conventions to follow:
   - Async methods MUST accept and forward \`CancellationToken\` to every downstream await; suffix names with \`Async\`.
   - Prefer singular folder names that already exist in the template; if you add new folders, use \`Infrastructure\` (singular), \`Enums\` (plural), \`Authorization\` instead of "Permissioning".
   - Namespace MUST mirror the folder path under the project, in PascalCase.
   - DTO ≠ Entity. Don't return EF entities from controllers — always project to a DTO.
   - DI registration uses \`AddX*\` extension methods in a static class under \`Extensions/\` or \`DependencyInjection/\`; wire them from \`Program.cs\`. Do not register services inline in \`Program.cs\`.

Frontend / client/ conventions (apply ONLY if a \`client/\` directory exists in the scaffold):
   - NEVER delete or overwrite \`SemanticProvider\`, \`createSemanticRegistry\`, or any \`<Semantic ...>\` wrapper that the scaffold wrote into \`main.tsx\` / \`app.component.ts\`. The agent harness depends on them — removing them silently breaks all E2E specs. If you rewrite \`main.tsx\`, re-include the existing SemanticProvider block verbatim.
   - Wrap every NEW user-visible region with \`<Semantic id="..." role="..." name="...">\` (composer, list, listitem, modal, statusbar). Pick \`role\` from the union in \`@muonroi/agent-harness-core/protocol\`.
   - NEVER hardcode API URLs in components. Read from \`import.meta.env.VITE_API_BASE\` (React/Vite) or \`environment.apiBase\` (Angular). If \`.env.example\` does not exist yet, create it with a sensible default; never inline \`http://localhost:5000\` or similar in source.
   - Put HTTP + DTO code under \`client/src/api/\`. Define request/response types in \`api/types.ts\` (mirror the C# DTO names). Components import a typed client; never call \`fetch\` directly.
   - Every async view needs THREE states: loading, empty, error. Surface errors via a toast/notification component, not \`console.error\`. Provide an \`ErrorBoundary\` at the app shell.
   - No inline \`style={{...}}\` literals — use CSS modules (\`*.module.css\`) or utility classes (Tailwind if scaffolded). If neither is present, write tokens + reset into \`src/styles/app.css\` and import it ONCE in main; reference variables via \`var(--color-...)\`.
   - TypeScript MUST be strict. If \`tsconfig.json\` does not have \`"strict": true\`, add it. Run \`bunx tsc --noEmit\` before declaring done — it must exit 0.
   - Run \`bun run build\` from \`client/\` before declaring done — it must exit 0 with zero browser-side console errors.

2. Design the feature
   - List the domain entity(ies), DTOs, endpoints, persistence model.
   - Match BB conventions (controller-per-resource, MediatR/CQRS if used, validation patterns observed in step 1).
   - State your design in 5-10 lines before generating code.

3. Generate code
   - Create files in the locations identified in step 1.
   - Wire DI in Program.cs (use BB extension methods if present).
   - Mirror existing patterns — same namespaces, attributes, error-handling style.

4. Verify
   - Run \`dotnet build\` from the server root — must exit 0.
   - If a \`client/\` directory exists, also run \`bun install\` and \`bun run build\` from \`client/\`.
   - Report concrete evidence: build output excerpt + file list created.

5. Summarize
   - 3-5 bullets: what was added, where, how to test manually.

Constraints:
- Don't re-scaffold. Don't run \`dotnet new\` again.
- Don't \`cd\` into ${projectDir} — your working directory is already there.
- Don't ask "do you want me to continue?" — proceed end-to-end.
- If you hit a blocker that genuinely needs the user, state EXACTLY which decision is blocking and stop.`;
}

export interface AdoptExistingPromptInput {
  originalPrompt: string;
  projectDir: string;
}

/**
 * Build the continuation prompt fed to the LLM after the user adopts an EXISTING
 * project via the CB-3 "Point to existing" recovery option. Unlike the init_new
 * variant this makes no template/BB assumptions — the target is an arbitrary
 * repo the user already has, with a verify recipe already detected there.
 */
export function buildAdoptExistingContinuationPrompt(input: AdoptExistingPromptInput): string {
  const { originalPrompt, projectDir } = input;

  return `You are continuing a /ideal product loop in an EXISTING project the user pointed to at ${projectDir}. A verify recipe was detected there, so the project already has a runnable test/build setup — adopt it, do NOT re-scaffold.

User's original request:
"${originalPrompt}"

Implement this now against the existing codebase. Do NOT ask the user to restate the request.

1. Discover structure (1-2 tool calls max): list the project directory, then read the manifest that exists (package.json / pyproject.toml / go.mod / Cargo.toml / *.csproj) and any README/AGENTS.md to learn the stack, entry point, and conventions. Do NOT assume files — skip whatever is absent.
2. Design briefly (5-10 lines): the entities/modules/endpoints to add, matching the conventions you observed (naming, error-handling, DI, folder layout).
3. Implement: create/edit files in the EXISTING layout; mirror the surrounding patterns. Never hardcode secrets or URLs — read config from the project's existing mechanism.
4. Verify: run the project's OWN detected test/build command; it must pass. Report the exact command + an output excerpt as evidence.
5. Summarize in 3-5 bullets: what was added, where, and how to run/test it.

Constraints:
- Your working directory is already ${projectDir}; do NOT cd into it and do NOT re-scaffold.
- Don't ask "do you want me to continue?" — proceed end-to-end.
- If a genuine blocker needs the user (missing API key, ambiguous requirement), state EXACTLY which decision is blocking and stop.`;
}
