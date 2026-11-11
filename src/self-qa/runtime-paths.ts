import { fileURLToPath } from "node:url";

// CLI-owned resources follow the executing module (source or installed dist),
// independently of the workspace being verified.
export const SELF_QA_ENTRY = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../index.ts" : "../index.js", import.meta.url),
);
export const SELF_QA_FIXTURES = fileURLToPath(new URL("./fixtures/llm", import.meta.url));
