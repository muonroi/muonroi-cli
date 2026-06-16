import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultEEClient } from "./intercept.js";
import { searchEE } from "./search.js";
import type { EESearchResponse } from "./types.js";

// Issue #3 seam: searchEE used to build a FRESH createEEClient, so the artifact
// READ leg (ee_query "tool-artifact id=X") could not be intercepted by
// setDefaultEEClient — while the WRITE leg (persistArtifact → getDefaultEEClient
// .extract) could. Routing searchEE through getDefaultEEClient unifies the seam:
// one injected client now intercepts both legs (testable end-to-end + the spot a
// durability fallback can hook).
describe("searchEE — routes through the injectable default EE client", () => {
  afterEach(() => {
    setDefaultEEClient(null as never); // teardown → next getDefaultEEClient lazy-inits a real one
  });

  it("uses getDefaultEEClient().search so the artifact READ leg is interceptable", async () => {
    const fakeResp = { results: [{ id: "x", text: "REHYDRATED" }] } as unknown as EESearchResponse;
    const search = vi.fn().mockResolvedValue(fakeResp);
    setDefaultEEClient({ search } as never);

    const out = await searchEE("tool-artifact id=x", { collections: ["experience-behavioral"], limit: 1 });

    expect(search).toHaveBeenCalledWith("tool-artifact id=x", { collections: ["experience-behavioral"], limit: 1 });
    expect(out).toBe(fakeResp);
  });
});
