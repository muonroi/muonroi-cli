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
