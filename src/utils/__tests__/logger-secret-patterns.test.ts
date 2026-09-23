/**
 * Pins the three credential shapes added to `redactSecrets` for the durable-sink
 * audit, plus the JSON-safety contract every pattern in it must satisfy.
 *
 * WHY EACH SHAPE IS HERE: the existing pattern set caught `sk-`/`xai-`/`AIzaSy`
 * prefixes, an `Authorization:` header, and a `Bearer `-prefixed token. It did
 * NOT catch a bare JWT (an OAuth access token once it is inside an error message
 * has lost its `Bearer ` prefix), an `x-api-key:` header (Anthropic's header
 * name — not `Authorization`), or a `NAME_API_KEY=value` assignment (the shape a
 * model-proposed shell command takes). All three reach durable sinks; see the
 * per-sink specs beside this one.
 *
 * Every credential below is assembled AT RUNTIME so no line in this file is a
 * credential-shaped literal — `.husky/pre-commit`'s `check-secrets.mjs` must stay
 * meaningful, and a hardcoded fake would train people to bypass it.
 */

import { describe, expect, it } from "vitest";
import { redactSecrets } from "../logger.js";

/** A JWT-shaped OAuth access token (three base64url segments). */
function fakeJwt(): string {
  return ["eyJ", "hbGciOiJIUzI1NiJ9"].join("") + "." + "eyJzdWIiOiJ0ZXN0LXVzZXIifQ" + "." + "c2lnbmF0dXJlLWJ5dGVz";
}

/** An opaque (non-`sk-`) provider key, as a custom gateway would issue. */
function fakeOpaqueKey(): string {
  return ["k", "eyv"].join("") + "alue" + "0".repeat(28);
}

describe("redactSecrets — bare JWT (OAuth access/refresh/id tokens)", () => {
  it("redacts a JWT that carries no Bearer prefix", () => {
    const jwt = fakeJwt();
    const out = redactSecrets(`token refresh rejected for ${jwt} after 3 tries`);

    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED_JWT]");
    // The diagnostic context must survive — a redaction that eats the sentence
    // is the `{}` bug in a new costume.
    expect(out).toContain("token refresh rejected for");
    expect(out).toContain("after 3 tries");
  });

  it("leaves a dotted non-JWT identifier alone", () => {
    const s = "loaded src/utils/logger.ts from packages/agent-harness-core/src/index.ts";
    expect(redactSecrets(s)).toBe(s);
  });
});

describe("redactSecrets — x-api-key header", () => {
  it("redacts the plain-text header form", () => {
    const key = fakeOpaqueKey();
    const out = redactSecrets(`401 Unauthorized (x-api-key: ${key})`);

    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("401 Unauthorized");
  });

  it("redacts the JSON-encoded header form and keeps the line parseable", () => {
    const key = fakeOpaqueKey();
    const line = JSON.stringify({ status: 401, headers: { "x-api-key": key } });

    const out = redactSecrets(line);

    expect(out).not.toContain(key);
    // The closing quote must survive, or every JSONL reader downstream breaks.
    const reparsed = JSON.parse(out) as { status: number; headers: Record<string, string> };
    expect(reparsed.status).toBe(401);
    expect(reparsed.headers["x-api-key"]).toBe("[REDACTED]");
  });
});

describe("redactSecrets — NAME_API_KEY=value assignments", () => {
  it("redacts the value but keeps the variable NAME", () => {
    const key = fakeOpaqueKey();
    const out = redactSecrets(`export DEEPSEEK_API_KEY=${key} && bun run build`);

    expect(out).not.toContain(key);
    // WHICH credential the command touched is the whole diagnostic value here.
    expect(out).toContain("DEEPSEEK_API_KEY=[REDACTED]");
    expect(out).toContain("bun run build");
  });

  it("covers TOKEN / SECRET / PASSWORD suffixes", () => {
    const v = fakeOpaqueKey();
    expect(redactSecrets(`GITHUB_TOKEN=${v}`)).toBe("GITHUB_TOKEN=[REDACTED]");
    expect(redactSecrets(`CLIENT_SECRET=${v}`)).toBe("CLIENT_SECRET=[REDACTED]");
    expect(redactSecrets(`DB_PASSWORD=${v}`)).toBe("DB_PASSWORD=[REDACTED]");
  });

  // The pattern's whole justification is that a MODEL-PROPOSED shell command
  // reaches the decision log verbatim. Such a command uses lowercase CLI flags
  // (`--api-key=`, `--token=`) at least as often as an uppercase env assignment,
  // and `access_token=` is the standard URL/form shape — so an uppercase-only
  // name class does not cover its own stated threat.
  it("covers lowercase names, hyphenated names and CLI flag forms", () => {
    const v = fakeOpaqueKey();
    // The leading `--` sits OUTSIDE the match (a hyphen is a non-word char, so
    // \b lands right after it), which is what keeps the flag name readable.
    expect(redactSecrets(`muonroi-cli --api-key=${v}`)).toBe("muonroi-cli --api-key=[REDACTED]");
    expect(redactSecrets(`--token=${v}`)).toBe("--token=[REDACTED]");
    expect(redactSecrets(`access_token=${v}`)).toBe("access_token=[REDACTED]");
    expect(redactSecrets(`deepseek_api_key=${v}`)).toBe("deepseek_api_key=[REDACTED]");
    expect(redactSecrets(`apikey=${v}`)).toBe("apikey=[REDACTED]");
  });

  it("does NOT redact token COUNT settings — the trailing S is the guard", () => {
    // Over-redacting a config value is how the original `{}` defect happened:
    // it destroyed the diagnostic instead of the secret.
    expect(redactSecrets("MUONROI_GATE_THROW_MAX_TOKENS=100000")).toBe("MUONROI_GATE_THROW_MAX_TOKENS=100000");
    expect(redactSecrets("maxOutputTokens=4096")).toBe("maxOutputTokens=4096");
    expect(redactSecrets("input_tokens=31702 output_tokens=884")).toBe("input_tokens=31702 output_tokens=884");
  });

  it("does not eat the Bearer marker the earlier pattern left as context", () => {
    // Pattern INTERACTION, caught by an existing spec
    // (interaction-log-error-serialization.test.ts) when the name class was
    // broadened: the `Bearer` pass runs first and turns `token=Bearer <jwt>` into
    // `token=Bearer [REDACTED]`. A naive assignment pattern then treats the
    // literal word `Bearer` as the value and blanks it too, producing
    // `token=[REDACTED] [REDACTED]` — throwing away which credential scheme was
    // involved. `(?:Bearer\s+)?` belongs in the NAME group, not the value.
    const jwt = fakeJwt();
    expect(redactSecrets(`token=Bearer ${jwt}`)).toBe("token=Bearer [REDACTED]");
    expect(redactSecrets(`access_token=Bearer ${jwt}`)).toBe("access_token=Bearer [REDACTED]");
  });

  it("is idempotent — redacting already-redacted text changes nothing", () => {
    // Several sinks redact a line that may already have passed through
    // `redactSecrets` upstream (console → stderr-mirror). A second pass must be
    // a no-op, not a cascade of nested placeholders.
    const once = redactSecrets(`export HF_TOKEN=${fakeOpaqueKey()} && curl -H "x-api-key: ${fakeOpaqueKey()}"`);
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets("token=Bearer [REDACTED]")).toBe("token=Bearer [REDACTED]");
  });

  it("keeps the count guard intact once the name class is case-insensitive", () => {
    // The guard is STRUCTURAL, not case-based: the alternative `TOKEN` must be
    // followed by `\s*=`, and every count field has an `S` in between. Case and
    // hyphenation cannot weaken that — pinned here so nobody has to re-derive it.
    expect(redactSecrets("max_tokens=4096")).toBe("max_tokens=4096");
    expect(redactSecrets("input_tokens=1200 output_tokens=87")).toBe("input_tokens=1200 output_tokens=87");
    expect(redactSecrets("--max-tokens=4096")).toBe("--max-tokens=4096");
    expect(redactSecrets("prompt_cache_hit_tokens=31702")).toBe("prompt_cache_hit_tokens=31702");
    // Not an assignment at all — no `=` after the name.
    expect(redactSecrets("access-token-count=5")).toBe("access-token-count=5");
  });

  it("preserves a surrounding quote pair so a JSON line stays parseable", () => {
    const v = fakeOpaqueKey();
    const line = JSON.stringify({ kind: "yolo-override", meta: { command: `export HF_TOKEN=${v}` } });

    const out = redactSecrets(line);

    expect(out).not.toContain(v);
    const reparsed = JSON.parse(out) as { kind: string; meta: { command: string } };
    expect(reparsed.kind).toBe("yolo-override");
    expect(reparsed.meta.command).toBe("export HF_TOKEN=[REDACTED]");
  });

  it("a case-insensitive name class does not move where the value class stops", () => {
    // The risk in broadening the NAME is that the VALUE class silently changes
    // with it and starts swallowing a closing quote. It must not: a
    // comma-separated value stops at the comma-free run, and the row still parses.
    const v = fakeOpaqueKey();
    const line = JSON.stringify({
      cmd: `muonroi-cli --api-key=${v} --model=deepseek-v4-flash`,
      url: `https://h/cb?access_token=${v}&state=xyz`,
      note: `tried access_token=${v}, then --token=${v}`,
    });

    const out = redactSecrets(line);

    expect(out).not.toContain(v);
    const reparsed = JSON.parse(out) as { cmd: string; url: string; note: string };
    // Everything after the redacted span survives — nothing was over-consumed.
    expect(reparsed.cmd).toBe("muonroi-cli --api-key=[REDACTED] --model=deepseek-v4-flash");
    expect(reparsed.url).toBe("https://h/cb?access_token=[REDACTED]");
    expect(reparsed.note).toBe("tried access_token=[REDACTED] then --token=[REDACTED]");
  });
});
