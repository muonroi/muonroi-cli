import { describe, expect, it } from "vitest";
import type { SlashContext } from "../registry.js";

// Trigger self-registration
import "../council.js";

import { dispatchSlash } from "../registry.js";

const ctx: SlashContext = {
  cwd: "/tmp",
  tenantId: "local",
  defaultProvider: "anthropic",
  defaultModel: "claude-3-5-sonnet-latest",
};

// Feature B — /council lang read path (no-arg). The set path persists to the
// user settings file (FS side effect) and is covered by normalizeCouncilLanguage
// unit tests + the settings getter; here we only assert the discoverable usage.
describe("/council lang (read path)", () => {
  it("prints the current language and the value legend with no args", async () => {
    const result = await dispatchSlash("council", ["lang"], ctx);
    const text = (result ?? "").toString();
    expect(text).toContain("Council debate language");
    expect(text).toContain("auto");
    expect(text).toContain("english");
    expect(text).toContain("/council lang <value>");
  });

  it("accepts the 'language' alias", async () => {
    const result = await dispatchSlash("council", ["language"], ctx);
    expect((result ?? "").toString()).toContain("Council debate language");
  });
});
