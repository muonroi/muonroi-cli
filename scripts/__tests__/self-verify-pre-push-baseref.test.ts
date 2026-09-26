/**
 * Round 8 — `scripts/self-verify-pre-push.cjs` used to hardcode
 * `${remote}/master` as its diff base regardless of what was actually being
 * pushed. On this repo `origin/master` is a long-stale ref, so diffing any
 * `develop`-based branch against it picked up hundreds of unrelated files —
 * including, by coincidence, files under the watched UI/harness dirs — and
 * triggered self-verify (and picked a scenario) for a push that touched none
 * of them.
 *
 * `selectBaseRef` is the pure per-pushed-ref decision this file tests
 * directly, with fake `refExists`/`mergeBase` — no real git repo needed.
 */
import { describe, expect, it } from "vitest";

const { selectBaseRef, resolveFallbackBase, decideSelfVerify, selfVerifyArgs, parsePushLines, ZERO_SHA } =
  require("../self-verify-pre-push.cjs") as {
    selectBaseRef: (opts: {
      localSha: string;
      remoteSha: string;
      remote: string;
      refExists: (ref: string) => boolean;
      mergeBase: (a: string, b: string) => string | null;
    }) => string | null;
    resolveFallbackBase: (
      remote: string,
      head: string,
      refExists: (ref: string) => boolean,
      mergeBase: (a: string, b: string) => string | null,
    ) => string | null;
    decideSelfVerify: (
      results: Array<{ base: string | null; touched: string[]; undiffable: boolean }>,
      fallbackBase: string | null,
    ) => { run: boolean; base: string | null; touched: string[]; reason: string };
    selfVerifyArgs: (sinceBase: string | null) => string[];
    parsePushLines: (
      raw: string,
    ) => Array<{ localRef: string; localSha: string; remoteRef: string; remoteSha: string }>;
    ZERO_SHA: string;
  };

const LOCAL_SHA = "1111111111111111111111111111111111111111";

describe("self-verify-pre-push.cjs — selectBaseRef", () => {
  it("uses the remote sha directly when the ref already exists on the remote (non-zero remote sha)", () => {
    const remoteSha = "2222222222222222222222222222222222222222";
    const refExists = () => {
      throw new Error("must not be called — remote sha already resolves the base");
    };
    const mergeBase = () => {
      throw new Error("must not be called — remote sha already resolves the base");
    };
    const base = selectBaseRef({ localSha: LOCAL_SHA, remoteSha, remote: "origin", refExists, mergeBase });
    expect(base).toBe(remoteSha);
  });

  it("a new remote branch (all-zero remote sha) falls back to merge-base with <remote>/develop when it exists", () => {
    const seen: string[] = [];
    const base = selectBaseRef({
      localSha: LOCAL_SHA,
      remoteSha: ZERO_SHA,
      remote: "origin",
      refExists: (ref) => {
        seen.push(ref);
        return ref === "origin/develop";
      },
      mergeBase: (_a, b) => (b === "origin/develop" ? "merge-base-with-develop" : null),
    });
    expect(base).toBe("merge-base-with-develop");
    // Never a hardcoded master FIRST — develop must be tried before it.
    expect(seen[0]).toBe("origin/develop");
  });

  it("a new remote branch with NO <remote>/develop falls back to <remote>/HEAD", () => {
    const base = selectBaseRef({
      localSha: LOCAL_SHA,
      remoteSha: ZERO_SHA,
      remote: "origin",
      refExists: (ref) => ref === "origin/HEAD",
      mergeBase: (_a, b) => (b === "origin/HEAD" ? "merge-base-with-head" : null),
    });
    expect(base).toBe("merge-base-with-head");
  });

  it("a new remote branch with neither develop nor HEAD falls back to <remote>/master (last resort, never first)", () => {
    const seen: string[] = [];
    const base = selectBaseRef({
      localSha: LOCAL_SHA,
      remoteSha: ZERO_SHA,
      remote: "origin",
      refExists: (ref) => {
        seen.push(ref);
        return ref === "origin/master";
      },
      mergeBase: (_a, b) => (b === "origin/master" ? "merge-base-with-master" : null),
    });
    expect(base).toBe("merge-base-with-master");
    expect(seen).toEqual(["origin/develop", "origin/HEAD", "origin/master"]);
  });

  it("a new remote branch where NOTHING resolves returns null (caller treats this as 'could not diff -> skip')", () => {
    const base = selectBaseRef({
      localSha: LOCAL_SHA,
      remoteSha: ZERO_SHA,
      remote: "origin",
      refExists: () => false,
      mergeBase: () => "unreachable",
    });
    expect(base).toBeNull();
  });

  it("a ref DELETION (all-zero local sha) returns null even though the remote sha being deleted is real", () => {
    const base = selectBaseRef({
      localSha: ZERO_SHA,
      remoteSha: "3333333333333333333333333333333333333333",
      remote: "origin",
      refExists: () => {
        throw new Error("must not be called — deletion is detected before any fallback lookup");
      },
      mergeBase: () => {
        throw new Error("must not be called — deletion is detected before any fallback lookup");
      },
    });
    expect(base).toBeNull();
  });

  it("respects a custom remote name (PRE_PUSH_REMOTE) in the fallback candidate order", () => {
    const seen: string[] = [];
    selectBaseRef({
      localSha: LOCAL_SHA,
      remoteSha: ZERO_SHA,
      remote: "upstream",
      refExists: (ref) => {
        seen.push(ref);
        return false;
      },
      mergeBase: () => null,
    });
    expect(seen).toEqual(["upstream/develop", "upstream/HEAD", "upstream/master"]);
  });
});

describe("self-verify-pre-push.cjs — resolveFallbackBase", () => {
  it("tries develop, then HEAD, then master, in that order, never master first", () => {
    const seen: string[] = [];
    resolveFallbackBase(
      "origin",
      LOCAL_SHA,
      (ref) => {
        seen.push(ref);
        return false;
      },
      () => null,
    );
    expect(seen).toEqual(["origin/develop", "origin/HEAD", "origin/master"]);
  });

  it("returns null when nothing resolves", () => {
    expect(
      resolveFallbackBase(
        "origin",
        LOCAL_SHA,
        () => false,
        () => "unreachable",
      ),
    ).toBeNull();
  });
});

describe("self-verify-pre-push.cjs — decideSelfVerify (round 9: never fail open)", () => {
  it("a ref whose diff touched a watched dir wins outright, using ITS base", () => {
    const decision = decideSelfVerify(
      [
        { base: "base-a", touched: [], undiffable: false },
        { base: "base-b", touched: ["src/ui/foo.ts"], undiffable: false },
      ],
      null,
    );
    expect(decision).toMatchObject({ run: true, base: "base-b", touched: ["src/ui/foo.ts"] });
  });

  it("round 11: an undiffable ref with NO fallback base still fails CLOSED — runs self-verify with base:null (check everything, no --since), never skips", () => {
    const decision = decideSelfVerify([{ base: "remote-sha", touched: [], undiffable: true }], null);
    expect(decision.run).toBe(true);
    expect(decision.base).toBeNull();
    expect(decision.reason).toMatch(/fail(ing)? closed/i);
  });

  it("an undiffable ref WITH a fallback base fails CLOSED — runs self-verify using the fallback base, even though nothing was confirmed touched", () => {
    const decision = decideSelfVerify([{ base: "remote-sha", touched: [], undiffable: true }], "fallback-base");
    expect(decision).toMatchObject({ run: true, base: "fallback-base", touched: [] });
    expect(decision.reason).toMatch(/fail(ing)? closed/i);
  });

  it("a touching ref beats an undiffable one — a confirmed touch always wins over failing closed", () => {
    const decision = decideSelfVerify(
      [
        { base: "remote-sha", touched: [], undiffable: true },
        { base: "base-b", touched: ["src/ui/foo.ts"], undiffable: false },
      ],
      "fallback-base",
    );
    expect(decision).toMatchObject({ run: true, base: "base-b", touched: ["src/ui/foo.ts"] });
  });

  it("no results at all (no candidate base resolved for any ref) — skips", () => {
    const decision = decideSelfVerify([], null);
    expect(decision.run).toBe(false);
  });

  it("every ref diffed cleanly and none touched anything — the only real 'no changes' skip", () => {
    const decision = decideSelfVerify(
      [
        { base: "base-a", touched: [], undiffable: false },
        { base: "base-b", touched: [], undiffable: false },
      ],
      "fallback-base",
    );
    expect(decision.run).toBe(false);
  });
});

describe("self-verify-pre-push.cjs — parsePushLines", () => {
  it("parses git's pre-push stdin protocol (<local ref> <local sha> <remote ref> <remote sha>)", () => {
    const raw =
      "refs/heads/feat/x 1111111111111111111111111111111111111111 refs/heads/feat/x 0000000000000000000000000000000000000000\n";
    const lines = parsePushLines(raw);
    expect(lines).toEqual([
      {
        localRef: "refs/heads/feat/x",
        localSha: "1111111111111111111111111111111111111111",
        remoteRef: "refs/heads/feat/x",
        remoteSha: ZERO_SHA,
      },
    ]);
  });

  it("parses multiple pushed refs, one per line", () => {
    const raw = [
      "refs/heads/a 1111111111111111111111111111111111111111 refs/heads/a 0000000000000000000000000000000000000000",
      "refs/heads/b 2222222222222222222222222222222222222222 refs/heads/b 3333333333333333333333333333333333333333",
    ].join("\n");
    expect(parsePushLines(raw)).toHaveLength(2);
  });

  it("ignores blank lines and malformed lines", () => {
    const raw =
      "\n   \nnot-enough-fields\nrefs/heads/a 1111111111111111111111111111111111111111 refs/heads/a 0000000000000000000000000000000000000000\n";
    expect(parsePushLines(raw)).toHaveLength(1);
  });
});

describe("self-verify-pre-push.cjs — selfVerifyArgs (round 11: base:null means 'check everything')", () => {
  it("includes --since when a base is given", () => {
    expect(selfVerifyArgs("abc123")).toEqual([
      "run",
      "src/index.ts",
      "self-verify",
      "--since",
      "abc123",
      "--max",
      "4",
      "--no-emit",
    ]);
  });

  it("omits --since entirely when the base is null (no trustworthy comparison point — check everything)", () => {
    expect(selfVerifyArgs(null)).toEqual(["run", "src/index.ts", "self-verify", "--max", "4", "--no-emit"]);
  });
});
