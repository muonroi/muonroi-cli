import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schema = JSON.parse(readFileSync(new URL("../../../docs/agent-harness/schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);

describe("schema fixtures", () => {
  const examplesDir = join(__dirname, "../../../docs/agent-harness/examples");
  const files = readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    it(`${f} matches schema`, () => {
      const data = JSON.parse(readFileSync(join(examplesDir, f), "utf8"));
      const def = data.mode === "live" ? "LiveFrame" : "DesignSpec";
      const validate = ajv.compile({
        $ref: `${schema.$id}#/definitions/${def}`,
      });
      const ok = validate(data);
      if (!ok) console.error(validate.errors);
      expect(ok).toBe(true);
    });
  }
});
