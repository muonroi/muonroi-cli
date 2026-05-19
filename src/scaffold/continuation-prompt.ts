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
   - If the \`muonroi-docs\` MCP server is available, call \`docs.search({query:"${templateName} structure overview"})\` to get a structured summary.
   - Otherwise read these files in parallel: \`README.md\`, \`Agent.md\`, \`AGENTS.md\`, \`EE-INTENT.md\`.
   - Identify: project name, main entry point (Program.cs / Gateway), modular boundaries, where to add new domain code.

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
