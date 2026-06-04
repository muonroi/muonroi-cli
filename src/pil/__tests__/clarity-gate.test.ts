import { describe, expect, it } from "vitest";
import {
  canInferOutcome,
  countFileReferences,
  hasExplicitScope,
  hasExternalInfoScope,
  hasImageScope,
  hasOperationalScope,
  hasWholeRepoScope,
  shouldAutoPass,
} from "../clarity-gate.js";

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
