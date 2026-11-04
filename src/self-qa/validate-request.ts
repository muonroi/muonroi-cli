export function validateSelfVerifyRequest(input: { mode?: string; kind?: string; mockLlmDir?: string }): string | null {
  if (input.mockLlmDir === undefined) return null;
  if (!input.mockLlmDir.trim())
    return "mockLlmDir must be omitted for bundled fixtures or name a fixture directory; empty strings are invalid.";
  if ((input.mode ?? input.kind) === "tier1" && input.mockLlmDir === "none") {
    return "tier1 requires offline fixtures. Omit mockLlmDir for bundled fixtures. 'none' is supported only in agentic mode with an explicit model.";
  }
  return null;
}
