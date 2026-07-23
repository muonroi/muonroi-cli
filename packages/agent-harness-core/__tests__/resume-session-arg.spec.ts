/**
 * resume-session-arg.spec.ts
 *
 * Regression for the harness-resume flow. In-TUI `/resume` relaunches a fresh
 * process that cannot inherit the harness transport, so under agent-mode the
 * relaunch is suppressed and a `resume-request` event is emitted instead. The
 * driving agent then resumes by restarting the harnessed child bound to the
 * session: `tui.stop` → `tui.start({ args: ["--session=<id>"] })`.
 *
 * These lock the two enabling contracts:
 *   1. tui.start's argv allowlist accepts `--session=<id>` (combined form only,
 *      word/dash charset) and still rejects malformed / injection-y variants.
 *   2. redactEvent preserves the resume-request sessionId (not dropped as an
 *      unknown kind) so the driving agent actually receives the id.
 */

import { describe, expect, it } from "vitest";
import { redactEvent } from "../src/event-redact.js";
import { validateStartArgs } from "../src/mcp-server.js";
import type { LiveEvent } from "../src/protocol.js";

describe("tui.start argv allowlist — --session", () => {
  it("accepts the combined --session=<id> form", () => {
    expect(validateStartArgs(["--session=abc123"]).ok).toBe(true);
    expect(validateStartArgs(["--session=my-session_42"]).ok).toBe(true);
    expect(validateStartArgs(["--agent-cols=80", "--session=abc123"]).ok).toBe(true);
  });

  it("rejects the space-separated form (value would be a bare token)", () => {
    // `--session` alone (no `=`) is not allowed — its value would land on a
    // separate argv token the per-arg allowlist could not vet.
    expect(validateStartArgs(["--session"]).ok).toBe(false);
    const r = validateStartArgs(["-s", "abc123"]);
    expect(r.ok).toBe(false);
  });

  it("rejects ids carrying path or shell metacharacters", () => {
    expect(validateStartArgs(["--session=../../etc/passwd"]).ok).toBe(false);
    expect(validateStartArgs(["--session=a;rm -rf"]).ok).toBe(false);
    expect(validateStartArgs(["--session=a b"]).ok).toBe(false);
  });
});

describe("redactEvent — resume-request", () => {
  it("preserves sessionId + ts (not dropped as an unknown kind)", () => {
    const e: Extract<LiveEvent, { t: "event"; kind: "resume-request" }> = {
      t: "event",
      kind: "resume-request",
      sessionId: "sess-xyz-9",
      ts: 1000,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { t: "event"; kind: "resume-request" }>;
    expect(out.kind).toBe("resume-request");
    expect(out.sessionId).toBe("sess-xyz-9");
    expect(out.ts).toBe(1000);
  });

  it("strips unknown fields from a resume-request event", () => {
    const e = {
      t: "event",
      kind: "resume-request",
      sessionId: "sess-1",
      ts: 1,
      extraneous: "dropped-by-allowlist",
    } as unknown as LiveEvent;
    const out = redactEvent(e) as Record<string, unknown>;
    expect(out.extraneous).toBeUndefined();
    expect(out.sessionId).toBe("sess-1");
  });
});
