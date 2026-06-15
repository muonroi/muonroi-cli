import { describe, expect, it } from "vitest";
import {
  canInferOutcome,
  countFileReferences,
  detectNoClarifySignal,
  hasExplicitScope,
  hasExternalInfoScope,
  hasImageScope,
  hasOperationalScope,
  hasSelfContainedComputationScope,
  hasWholeRepoScope,
  shouldAutoPass,
} from "../clarity-gate.js";

describe("detectNoClarifySignal()", () => {
  it("detects explicit no-clarify directives (EN)", () => {
    expect(detectNoClarifySignal("just answer, don't ask me anything")).toBe(true);
    expect(detectNoClarifySignal("answer directly without asking")).toBe(true);
    expect(detectNoClarifySignal("no questions please, just do it")).toBe(true);
    expect(detectNoClarifySignal("stop asking and give me the result")).toBe(true);
  });

  it("detects explicit no-clarify directives (VI + transliteration)", () => {
    expect(detectNoClarifySignal("Đừng hỏi lại. Trả lời thẳng 3 câu hỏi.")).toBe(true);
    expect(detectNoClarifySignal("không cần hỏi, trả lời luôn")).toBe(true);
    expect(detectNoClarifySignal("tra loi thang dung hoi")).toBe(true);
  });

  it("does NOT match the explanation idiom 'don't ask me why'", () => {
    expect(detectNoClarifySignal("it just works, don't ask me why")).toBe(false);
    expect(detectNoClarifySignal("explain the auth flow")).toBe(false);
    expect(detectNoClarifySignal("which part of the code should I read?")).toBe(false);
  });
});

describe("hasWholeRepoScope()", () => {
  it("detects whole-repo / whole-project intent (EN + VI)", () => {
    // The repo-eval prompt that fired a nonsensical "which part?" askcard.
    expect(hasWholeRepoScope("đánh giá repo muonroi-cli này: điểm mạnh, điểm yếu")).toBe(true);
    expect(hasWholeRepoScope("evaluate the repo: strengths and weaknesses")).toBe(true);
    expect(hasWholeRepoScope("review the whole codebase")).toBe(true);
    expect(hasWholeRepoScope("audit the entire project")).toBe(true);
    expect(hasWholeRepoScope("phân tích toàn bộ dự án")).toBe(true);
    expect(hasWholeRepoScope("give me an overview of the repository")).toBe(true);
    // summarize/overview verbs (gap found in the deepseek session probe: "tóm tắt
    // repo này" still fired the scope askcard because the verb list lacked it).
    expect(hasWholeRepoScope("tóm tắt nhanh repo này")).toBe(true);
    expect(hasWholeRepoScope("summarize the repository")).toBe(true);
    expect(hasWholeRepoScope("give me a summary of the project")).toBe(true);
  });

  it("does NOT fire on summarize/review of a narrow target", () => {
    expect(hasWholeRepoScope("summarize the login function")).toBe(false);
    expect(hasWholeRepoScope("tóm tắt hàm xử lý auth")).toBe(false);
  });

  it("does NOT fire on narrow tasks that merely mention a repo/project", () => {
    // "this repo" without a wholeness/eval signal must still be scoped.
    expect(hasWholeRepoScope("add a logout button to this repo")).toBe(false);
    expect(hasWholeRepoScope("fix the login bug in the project")).toBe(false);
    expect(hasWholeRepoScope("implement the search feature")).toBe(false);
    expect(hasWholeRepoScope("refactor the auth module")).toBe(false);
  });

  it("whole-repo scope no longer blocks auto-pass (was: scope-gap → false)", () => {
    // With an inferable outcome (explicit goal), the ONLY remaining blocker for a
    // repo-wide prompt was the scope gap. hasWholeRepoScope clears it.
    const prompt = "review the entire codebase — goal: a report of strengths and weaknesses";
    expect(shouldAutoPass({ confidence: 0.9, taskType: "analyze", complexity: "low" }, prompt)).toBe(true);
    // Control: same shape but NOT repo-wide still fails on the scope gap.
    const narrow = "review the system — goal: a report of strengths and weaknesses";
    expect(shouldAutoPass({ confidence: 0.9, taskType: "analyze", complexity: "low" }, narrow)).toBe(false);
  });
});

describe("hasSelfContainedComputationScope()", () => {
  it("detects an inline-data computation prompt (the operand is in the prompt, not the codebase)", () => {
    // Live drive (deepseek-vs-grok A/B, session probe 2026-06-05): "Compute
    // f([3,1,2]) where f sorts the list ascending then returns the sum of the
    // first two elements." classified taskType=analyze (regex:read matched the
    // bare word "list") fired the codebase-scope askcard "Which part of the
    // codebase should this target?" — nonsensical for a self-contained math
    // problem whose input data is supplied inline. Symmetric to image/web/
    // operational scope guards.
    expect(
      hasSelfContainedComputationScope(
        "Compute f([3,1,2]) where f sorts the list ascending then returns the sum of the first two elements.",
      ),
    ).toBe(true);
    expect(
      hasSelfContainedComputationScope("Given the array [5, 2, 8, 1, 9], what is the second largest element?"),
    ).toBe(true);
    expect(hasSelfContainedComputationScope("What is the median of [10, 4, 7]?")).toBe(true);
    expect(hasSelfContainedComputationScope('Reverse the list ["a", "b", "c"] and return it.')).toBe(true);
  });

  it("does NOT fire without an inline data literal", () => {
    // The framing verb alone is not enough — a codebase task can say "compute"
    // ("compute the hash in the auth module"). Only an inline operand qualifies.
    expect(hasSelfContainedComputationScope("compute the cache key in the auth module")).toBe(false);
    expect(hasSelfContainedComputationScope("sort the users table by created_at")).toBe(false);
    expect(hasSelfContainedComputationScope("what is the second largest element of the array")).toBe(false);
  });

  it("does NOT fire on a real codebase task that merely contains an array literal (no compute framing)", () => {
    // Narrowness guard: the literal alone is not enough. A feature/debug task
    // that embeds a literal but is scoped to the codebase must KEEP its scope
    // askcard. Requires BOTH an inline literal AND computation framing.
    expect(hasSelfContainedComputationScope("add the items [1, 2, 3] to the cart in the checkout flow")).toBe(false);
    expect(hasSelfContainedComputationScope("fix the bug where parseRange([1, 5]) returns the wrong values")).toBe(
      false,
    );
    expect(hasSelfContainedComputationScope("set the default retry delays to [100, 200, 400] in the config")).toBe(
      false,
    );
  });

  it("does NOT fire on bracketed file-name lists (those are codebase-scoped)", () => {
    // [a.ts, b.ts] is a list of files, not data — must stay codebase-scoped.
    expect(hasSelfContainedComputationScope("compare the exports of [auth.ts, session.ts]")).toBe(false);
  });

  it("self-contained computation no longer blocks auto-pass (was: scope-gap → false)", () => {
    // With an inferable outcome ("return the result"), the ONLY remaining blocker
    // for an inline-data computation prompt was the scope gap.
    // hasSelfContainedComputationScope clears it.
    const prompt = "Compute the sum of the first two sorted elements of [3, 1, 2] and return the result.";
    expect(shouldAutoPass({ confidence: 0.9, taskType: "analyze", complexity: "low" }, prompt)).toBe(true);
    // Control: same outcome-inferable shape but NO inline literal still fails on
    // the scope gap (a real codebase computation must still be scoped).
    const codeTask = "Compute the largest element of the users array and return it.";
    expect(shouldAutoPass({ confidence: 0.9, taskType: "analyze", complexity: "low" }, codeTask)).toBe(false);
  });
});

describe("canInferOutcome()", () => {
  it("returns false for null taskType", () => {
    expect(canInferOutcome(null, "do something")).toBe(false);
  });
  it("returns false for general taskType", () => {
    expect(canInferOutcome("general", "fix stuff")).toBe(false);
  });
  it("returns true for a general taskType that is a direct imperative command", () => {
    // A direct command has a self-evident outcome (it runs / it shows), so it
    // should auto-pass instead of triggering an outcome-clarification askcard.
    expect(canInferOutcome("general", "run the test suite")).toBe(true);
    expect(canInferOutcome("general", "echo harness-ok")).toBe(true);
    expect(canInferOutcome("general", "show the package.json scripts")).toBe(true);
    expect(canInferOutcome("general", "list the open ports")).toBe(true);
  });
  it("returns false for a general imperative verb with no object", () => {
    expect(canInferOutcome("general", "run")).toBe(false);
    expect(canInferOutcome("general", "execute   ")).toBe(false);
  });
  it("returns false for a general non-imperative prompt", () => {
    expect(canInferOutcome("general", "the build is slow")).toBe(false);
  });
  it("returns true when prompt has error reference", () => {
    expect(canInferOutcome("debug", "fix the TypeError in login")).toBe(true);
  });
  it("returns true when prompt has file:line reference", () => {
    expect(canInferOutcome("debug", "fix auth.ts:42")).toBe(true);
  });
  it("returns true when prompt has target state verb", () => {
    expect(canInferOutcome("refactor", "should return a Promise")).toBe(true);
  });
  it("returns true when prompt has add pattern", () => {
    expect(canInferOutcome("generate", "add validation to login form")).toBe(true);
  });
  it("returns false for vague prompt with valid taskType", () => {
    expect(canInferOutcome("debug", "fix auth")).toBe(false);
  });
});

describe("countFileReferences()", () => {
  it("counts .ts and .tsx files", () => {
    expect(countFileReferences("fix login.ts and dashboard.tsx")).toBe(2);
  });
  it("returns 0 for no file refs", () => {
    expect(countFileReferences("fix the auth module")).toBe(0);
  });
  it("ignores non-code extensions", () => {
    expect(countFileReferences("see report.pdf")).toBe(0);
  });
});

describe("hasExplicitScope()", () => {
  it("detects src/ paths", () => {
    expect(hasExplicitScope("refactor src/auth/jwt.ts")).toBe(true);
  });
  it("detects lib/ paths", () => {
    expect(hasExplicitScope("update lib/utils")).toBe(true);
  });
  it("returns false for no path", () => {
    expect(hasExplicitScope("refactor the code")).toBe(false);
  });
});

describe("shouldAutoPass()", () => {
  it("auto-passes high-confidence + specific file + inferrable outcome", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "debug", complexity: "low" },
        "fix TypeError in src/auth/login.ts:42",
      ),
    ).toBe(true);
  });
  it("rejects low confidence", () => {
    expect(
      shouldAutoPass({ confidence: 0.6, taskType: "debug", complexity: "low" }, "fix TypeError in login.ts:42"),
    ).toBe(false);
  });
  it("rejects vague prompt despite high confidence", () => {
    expect(shouldAutoPass({ confidence: 0.9, taskType: "debug", complexity: "low" }, "fix auth")).toBe(false);
  });
  it("rejects high complexity", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "refactor", complexity: "high" },
        "refactor src/auth/login.ts should return Promise",
      ),
    ).toBe(false);
  });
  it("auto-passes with explicit scope path even without file extension", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "refactor", complexity: "medium" },
        "refactor src/auth/ module to return Promises",
      ),
    ).toBe(true);
  });

  // PIL-L6 fix
  it("auto-passes CI/build debug task even without file path (operational scope)", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "debug", complexity: "low" },
        "fix the ci fail — goal: green pipeline",
      ),
    ).toBe(true);
  });

  // Image-scope fix — an image-analysis task is scoped to the image, not a file
  // path, so it should auto-pass when its outcome is inferrable.
  it("auto-passes an image-analysis task even without file path (image scope)", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "analyze", complexity: "low" },
        "analyze screenshot.png — goal: describe the layout",
      ),
    ).toBe(true);
  });

  // External-info fix — a web-search task is scoped to the web, not a file path.
  it("auto-passes a web-search task even without file path (external-info scope)", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "analyze", complexity: "low" },
        "search the web for the vitest release date — goal: find the version",
      ),
    ).toBe(true);
  });
});

describe("hasExternalInfoScope()", () => {
  it("detects web-search / external-info intent", () => {
    expect(hasExternalInfoScope("search the web for the latest vitest release notes")).toBe(true);
    expect(hasExternalInfoScope("google the error message")).toBe(true);
    expect(hasExternalInfoScope("what's the latest news on the framework")).toBe(true);
    expect(hasExternalInfoScope("summarize https://example.com/post")).toBe(true);
  });
  it("returns false for codebase tasks, including in-repo 'search'", () => {
    // Narrow: must NOT swallow a real code task. "search the codebase" and
    // "search feature" are codebase work and still deserve a scope askcard.
    expect(hasExternalInfoScope("search the codebase for usages of foo")).toBe(false);
    expect(hasExternalInfoScope("implement the search feature")).toBe(false);
    expect(hasExternalInfoScope("add the zod library to the auth module")).toBe(false);
    expect(hasExternalInfoScope("refactor the login flow")).toBe(false);
  });
});

describe("hasImageScope()", () => {
  it("detects an image file extension", () => {
    expect(hasImageScope("analyze diagram.png")).toBe(true);
    expect(hasImageScope("describe the layout of mock.jpg")).toBe(true);
    expect(hasImageScope("read chart.svg")).toBe(true);
  });
  it("detects a data:image URI and screenshot/photo nouns", () => {
    expect(hasImageScope("here is data:image/png;base64,AAAA")).toBe(true);
    expect(hasImageScope("take a screenshot and analyze it")).toBe(true);
    expect(hasImageScope("look at the photo")).toBe(true);
  });
  it("returns false for codebase tasks and ambiguous/overloaded words", () => {
    // Narrow on purpose: a false positive SUPPRESSES a legitimate scope
    // question, so overloaded words must NOT match.
    expect(hasImageScope("refactor the login flow")).toBe(false);
    expect(hasImageScope("add a logo to the header")).toBe(false); // "logo" excluded
    expect(hasImageScope("rebuild the docker image")).toBe(false); // bare "image" excluded
    expect(hasImageScope("look at the bigger picture")).toBe(false); // "picture" excluded
  });
});

describe("hasOperationalScope() — PIL-L6", () => {
  it("detects ci/build/test/action keywords", () => {
    expect(hasOperationalScope("fix ci fail")).toBe(true);
    expect(hasOperationalScope("the build is broken")).toBe(true);
    expect(hasOperationalScope("workflow keeps failing")).toBe(true);
    expect(hasOperationalScope("gh check shows red")).toBe(true);
  });
  it("returns false for unrelated prompts", () => {
    expect(hasOperationalScope("refactor login flow")).toBe(false);
    expect(hasOperationalScope("explain hooks")).toBe(false);
  });
});

describe("canInferOutcome() — explicit goal (PIL-L6)", () => {
  it("returns true when prompt names an explicit goal", () => {
    expect(canInferOutcome("debug", "goal: pipeline green")).toBe(true);
    expect(canInferOutcome("debug", "mong muốn: tests passing")).toBe(true);
  });
});
