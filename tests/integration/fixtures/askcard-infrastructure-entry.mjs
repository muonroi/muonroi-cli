import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Test-only role injection. There is deliberately no production flag or settings
// override: index/App, harness transport and council execution remain real.
const entry = process.env.MUONROI_ASKCARD_FIXTURE_ENTRY;
if (!entry) throw new Error("Askcard fixture requires its explicit source entry");
const trace = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", "askcard-fixture-bootstrap.log");
appendFileSync(trace, "fixture entry started\n");
const entryFilter = new RegExp(`^${resolve(entry).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
Bun.plugin({
  name: "askcard-infrastructure-role-fixture",
  setup(build) {
    build.onLoad({ filter: entryFilter }, (args) => {
      const source = readFileSync(args.path, "utf8");
      appendFileSync(trace, "source entry load intercepted\n");
      const agentImport = /import\s*\{\s*Agent\s*\}\s*from\s*["']\.\/orchestrator\/orchestrator(?:\.js)?["'];?/;
      if (!agentImport.test(source)) throw new Error("Askcard fixture could not locate the entry's Agent import");
      // Keep the import static and apply the constructor role in this entry only;
      // no production setting, environment-role override or proxy module is added.
      const replacement = `import { Agent as InfrastructureRuntimeAgent } from "./orchestrator/orchestrator";
        class Agent extends InfrastructureRuntimeAgent {
          constructor(apiKey, baseURL, model, maxToolRounds, options = {}) {
            super(apiKey, baseURL, model, maxToolRounds, { ...options, executionRole: "infrastructure" });
            if (this.getExecutionRole() !== "infrastructure") throw new Error("Askcard infrastructure fixture role was not applied");
          }
        }`;
      return { contents: source.replace(agentImport, replacement), loader: "ts" };
    });
  },
});
try {
  await import(pathToFileURL(entry).href);
  appendFileSync(trace, "source entry imported\n");
} catch (error) {
  appendFileSync(trace, String(error?.stack ?? error) + "\n");
  throw error;
}
