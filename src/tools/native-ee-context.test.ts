import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ee/auth.js", () => ({
  loadEEAuthToken: async () => "fixture-token",
  getCachedServerBaseUrl: () => "https://fixture.invalid",
}));

import { __resetArtifactCacheForTests, recordArtifact } from "../ee/artifact-cache.js";
import { sessionRecallLedger } from "../ee/recall-ledger.js";
import { compactSubAgentMessages } from "../orchestrator/subagent-compactor.js";
import { TaskContext } from "../orchestrator/task-context.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

let root: string, anchor: string, repoA: string, repoB: string;
let bash: BashTool, context: TaskContext;
let requests: { endpoint: string; body: any }[];
let fetchImpl: ReturnType<typeof vi.fn>;
const entry = { id: "entry-a-12345678", collection: "experience-behavioral" };
const originalActivityLog = process.env.EXPERIENCE_ACTIVITY_LOG;
const norm = (s: string) =>
  s
    .replace(/^~(?=[/\\]|$)/, os.homedir())
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
const wire = (s: string) => norm(s).replace(norm(os.homedir()) + "/", "~/");
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function response(body: any) {
  const project =
    body.project_slug ??
    body.repository?.project ??
    (norm(body.cwd) === norm(repoA) ? "repo-a" : norm(body.cwd) === norm(repoB) ? "repo-b" : undefined);
  if (!project)
    return ok(
      { error: "Cannot resolve a concrete project for strict recall; pass project_slug from /api/projects" },
      400,
    );
  return ok({
    text: `Scoped lesson [${entry.id} ${entry.collection}]`,
    count: 1,
    entries: [entry],
    scope: {
      strict: true,
      project,
      cwd: body.cwd,
      policy: "project-only",
      ...(body.repository ? { repository: { root: body.repository.root, project } } : {}),
    },
  });
}
function tools() {
  return createBuiltinTools(bash, "agent", { taskContext: context, sessionId: "owner" });
}
async function call(name: string, input: unknown, set = tools()) {
  return String(await (set[name] as any).execute(input, {}));
}
function history(output: string): ModelMessage[] {
  return [
    { role: "user", content: "Inspect repo A" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "recall-1", toolName: "ee_query", input: { cwd: repoA, query: "lesson" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "recall-1", toolName: "ee_query", output: { type: "text", value: output } },
      ],
    },
    { role: "user", content: "continue" },
  ];
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "native-ee-context-"));
  process.env.EXPERIENCE_ACTIVITY_LOG = path.join(root, "activity.jsonl");
  [anchor, repoA, repoB] = ["consumer", "repo-a", "repo-b"].map((p) => path.join(root, p));
  for (const p of [anchor, repoA, repoB]) fs.mkdirSync(p);
  bash = new BashTool(anchor);
  context = new TaskContext("owner", anchor);
  requests = [];
  sessionRecallLedger.reset();
  __resetArtifactCacheForTests();
  fetchImpl = vi.fn(async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ endpoint, body });
    if (endpoint === "/health") return ok({ ok: true });
    if (endpoint === "/api/projects")
      return ok({
        projects: [
          { slug: "repo-a", count: 3 },
          { slug: "repo-b", count: 2 },
        ],
        failed: [],
        truncated: false,
        cached: false,
      });
    if (endpoint === "/api/feedback") return ok({ resolvedId: body.pointId, verdict: body.verdict });
    if (endpoint === "/api/import-memory") return ok({ imported: 1 });
    return response(body);
  });
  vi.stubGlobal("fetch", fetchImpl);
});
afterEach(async () => {
  await bash.cleanup();
  vi.unstubAllGlobals();
  sessionRecallLedger.reset();
  __resetArtifactCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
  if (originalActivityLog === undefined) delete process.env.EXPERIENCE_ACTIVITY_LOG;
  else process.env.EXPERIENCE_ACTIVITY_LOG = originalActivityLog;
});

describe("native EE owns the task scope", () => {
  it("automatically identifies a new git repository from a nested cwd without manual project registration", async () => {
    fs.mkdirSync(path.join(repoA, ".git"));
    fs.writeFileSync(
      path.join(repoA, ".git", "config"),
      '[remote "origin"]\n url = git@example.invalid:org/new-scope-fixture.git\n',
    );
    const nested = path.join(repoA, "src", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const output = await call("ee_query", { query: "lessons", cwd: nested });
    expect(output).toContain("EE context:");
    expect(requests[0].body).toMatchObject({
      cwd: wire(nested),
      strict_project: true,
      repository: { root: wire(repoA), project: "new-scope-fixture" },
    });
    expect(requests[0].body.project_slug).toBeUndefined();
    expect(context.ee.scope()).toMatchObject({ cwd: nested, project: "new-scope-fixture" });
    await call("ee_query", { query: "next lesson" });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.project_slug).toBe("new-scope-fixture");
  });

  it("rejects a legacy server that ignores repository context instead of binding a parent project", async () => {
    fs.mkdirSync(path.join(repoA, ".git"));
    fs.writeFileSync(
      path.join(repoA, ".git", "config"),
      '[remote "origin"]\nurl = https://example.invalid/new-project.git\n',
    );
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body);
      return ok({
        text: "PARENT_ONLY_LESSON",
        count: 1,
        entries: [entry],
        scope: { strict: true, project: "parent-project", cwd: body.cwd },
      });
    });
    const output = await call("ee_query", { query: "lessons", cwd: repoA });
    expect(output).toContain("ee_scope_unverified");
    expect(output).not.toContain("PARENT_ONLY_LESSON");
    expect(context.ee.scope().project).toBeUndefined();
  });

  it("can learn the first lesson after an automatically scoped empty recall in a new repository", async () => {
    fs.mkdirSync(path.join(repoA, ".git"));
    fs.writeFileSync(
      path.join(repoA, ".git", "config"),
      '[remote "origin"]\nurl = https://example.invalid/first-use-repository.git\n',
    );
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body);
      return ok({
        text: "",
        count: 0,
        entries: [],
        scope: {
          strict: true,
          project: "first-use-repository",
          cwd: body.cwd,
          repository: { root: body.repository.root, project: "first-use-repository" },
        },
      });
    });
    expect(await call("ee_query", { query: "prior lessons", cwd: repoA })).toContain("0 entries");
    await call("ee_write", { lesson: "A first verified lesson for the new project." });
    const write = requests.find((request) => request.endpoint === "/api/import-memory");
    expect(write).toBeDefined();
    expect(write!.body.experiences[0].qa.scope.project_slug).toBe("first-use-repository");
  });

  it("explains the actual rejected scope and native next steps without retrying or changing project", async () => {
    const output = await call("ee_query", { query: "lessons", cwd: anchor });
    expect(output).toContain("[ee_project_required]");
    expect(output).toContain(JSON.stringify({ cwd: anchor }));
    expect(output).toContain('ee_query({"action":"projects"})');
    expect(output).toContain("Repeating the same unresolved scope");
    expect(output).toContain("intended repository");
    expect(output).toContain("Continue using repository evidence");
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ cwd: wire(anchor), strict_project: true });
    expect(JSON.parse(await call("ee_query", { action: "scope" }))).toMatchObject({
      scope: { cwd: anchor },
      lastRecall: { state: "project_required", cwd: anchor },
    });
  });

  it("names a rejected explicit project without choosing another known project", async () => {
    fetchImpl.mockImplementationOnce(async () =>
      ok({ error: "Cannot resolve a concrete project for strict recall; pass project_slug from /api/projects" }, 400),
    );
    const output = await call("ee_query", { query: "lessons", project: "unknown-repo" });
    expect(output).toContain(JSON.stringify({ cwd: anchor, project: "unknown-repo" }));
    expect(output).not.toContain("EE context:");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toMatchObject({
      project_slug: "unknown-repo",
      strict_project: true,
    });
    expect(context.ee.scope().project).toBeUndefined();
  });

  it("resolves an explicit repository cwd once and remembers the proved project across registry rebuilds", async () => {
    expect(await call("ee_query", { query: "lesson", cwd: repoA })).toContain("Scoped lesson");
    expect(await call("ee_query", { query: "next lesson" })).toContain("Scoped lesson");
    expect(requests.map((r) => r.body)).toMatchObject([
      { cwd: wire(repoA), strict_project: true },
      { cwd: wire(repoA), project_slug: "repo-a", strict_project: true },
    ]);
    expect(context.block()).toContain("repo-a");
    const scope = JSON.parse(await call("ee_query", { action: "scope" }));
    expect(scope.scope).toMatchObject({ project: "repo-a", cwd: repoA });
    expect(requests).toHaveLength(2);
  });
  it("offers project discovery without raw HTTP or a query and does not select the first project", async () => {
    const result = JSON.parse(await call("ee_query", { action: "projects" }));
    expect(result.projects.map((p: any) => p.slug)).toEqual(["repo-a", "repo-b"]);
    expect(requests.map((r) => r.endpoint)).toEqual(["/api/projects"]);
    expect(JSON.parse(await call("ee_query", { action: "scope" })).scope.project).toBeUndefined();
  });
  it("reports partial directory coverage and HTTP refusal without selecting a scope", async () => {
    fetchImpl.mockImplementationOnce(async () =>
      ok({ projects: [{ slug: "repo-a", count: 3 }], failed: ["one-collection"], truncated: true }),
    );
    expect(JSON.parse(await call("ee_query", { action: "projects" }))).toMatchObject({
      partial: true,
      truncated: true,
    });
    fetchImpl.mockImplementationOnce(async () => ok({ error: "unauthorized" }, 401));
    expect(JSON.parse(await call("ee_query", { action: "projects" }))).toMatchObject({
      error: "ee_request_rejected",
      status: 401,
    });
    expect(JSON.parse(await call("ee_query", { action: "scope" })).scope.project).toBeUndefined();
  });
  it("binds an empty but strictly verified recall without reporting a failure", async () => {
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body);
      return ok({ count: 0, entries: [], text: "", scope: { strict: true, project: "repo-a", cwd: body.cwd } });
    });
    expect(await call("ee_query", { query: "no matches", cwd: repoA })).toContain("0 entries");
    expect(JSON.parse(await call("ee_query", { action: "scope" }))).toMatchObject({
      scope: { project: "repo-a" },
      lastRecall: { state: "ok", count: 0 },
    });
  });
  it("validates query/action/scope without changing scope or making a request", async () => {
    expect(await call("ee_query", {})).toContain("requires a non-empty");
    expect(await call("ee_query", { action: "unknown" })).toContain("ERROR");
    expect(await call("ee_query", { query: "q", project: "all" })).toContain("invalid_scope");
    expect(await call("ee_query", { query: "q", cwd: "relative-path" })).toContain("invalid_scope");
    expect(requests).toHaveLength(0);
  });
  it("keeps local artifact retrieval available independently of scope and network", async () => {
    recordArtifact("native-fixture-call", "read_file", "LOCAL_ARTIFACT_BODY");
    expect(await call("ee_query", { query: "tool-artifact id=native-fixture-call" })).toContain("LOCAL_ARTIFACT_BODY");
    expect(requests).toHaveLength(0);
  });
  it("does not accrue feedback debt for entries whose handles were not displayed", async () => {
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body);
      return ok({
        text:
          `Visible [${entry.id} ${entry.collection}]\n` +
          "long evidence ".repeat(200) +
          "\n[hidden-id experience-behavioral]",
        count: 2,
        entries: [entry, { id: "hidden-id", collection: entry.collection }],
        scope: { strict: true, project: "repo-a", cwd: body.cwd },
      });
    });
    await call("ee_query", { query: "lesson", cwd: repoA, maxChars: 500 });
    expect(sessionRecallLedger.pending().map((p) => p.id)).toEqual([entry.id]);
  });
  it("does not let an explicit cwd inherit the previous project's binding", async () => {
    await call("ee_query", { query: "a", cwd: repoA });
    await call("ee_query", { query: "b", cwd: repoB });
    expect(requests[1].body.project_slug).toBeUndefined();
    await call("ee_query", { query: "b again" });
    expect(requests[2].body).toMatchObject({ project_slug: "repo-b", cwd: wire(repoB) });
  });
  it("does not bind or inject a response that fails strict proof", async () => {
    fetchImpl.mockImplementationOnce(async () =>
      ok({
        text: "PRIVATE_WRONG_SCOPE",
        count: 1,
        entries: [entry],
        scope: { strict: true, project: "other", cwd: anchor },
      }),
    );
    const output = await call("ee_query", { query: "q", project: "repo-a" });
    expect(output).toContain("ee_scope_unverified");
    expect(output).not.toContain("PRIVATE_WRONG_SCOPE");
    expect(JSON.parse(await call("ee_query", { action: "scope" })).scope.project).toBeUndefined();
  });
  it("does not silently retry a scope refusal and clears binding on shell cwd change", async () => {
    expect(await call("ee_query", { query: "project=repo-a" })).toContain("ee_project_required");
    expect(requests).toHaveLength(1);
    await call("ee_query", { query: "lesson", cwd: repoA });
    bash.setCwd(repoB);
    await call("ee_query", { query: "new cwd" });
    expect(requests[2].body).toMatchObject({ cwd: wire(repoB) });
    expect(requests[2].body.project_slug).toBeUndefined();
  });
  it("persists a scope reset so continuation cannot restore an older binding", async () => {
    const output = await call("ee_query", { query: "lesson", cwd: repoA });
    const messages = history(output);
    const reset = await call("ee_query", { action: "reset" });
    messages.push(...history(reset).slice(1));
    context = new TaskContext("owner", anchor, messages, true, "orient", (s) => s === "continue");
    expect(JSON.parse(await call("ee_query", { action: "scope" })).scope.project).toBeUndefined();
  });
  it("ignores a late completion after a newer explicit target request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body);
      await gate;
      return response(body);
    });
    const first = call("ee_query", { query: "slow", cwd: repoA });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await call("ee_query", { query: "newer", cwd: repoB });
    release();
    await first;
    expect(JSON.parse(await call("ee_query", { action: "scope" })).scope.project).toBe("repo-b");
  });
  it("restores a bounded native scope receipt only for the same owner/cwd and explicit continuation", async () => {
    const output = await call("ee_query", { query: "lesson", cwd: repoA });
    const messages = history(output);
    context = new TaskContext("owner", anchor, messages, true, "orient", (s) => s === "continue");
    await call("ee_query", { query: "continued" });
    expect(requests[1].body.project_slug).toBe("repo-a");
    for (const [owner, cwd, continuing] of [
      ["child", anchor, true],
      ["owner", repoB, true],
      ["owner", anchor, false],
    ] as const) {
      const isolated = new TaskContext(owner, cwd, messages, continuing, "orient", (s) => s === "continue");
      const set = createBuiltinTools(bash, "agent", { taskContext: isolated });
      expect(JSON.parse(await call("ee_query", { action: "scope" }, set)).scope.project).toBeUndefined();
    }
    messages.push({ role: "user", content: "different task" }, { role: "user", content: "continue" });
    context = new TaskContext("owner", anchor, messages, true, "orient", (s) => s === "continue");
    expect(JSON.parse(await call("ee_query", { action: "scope" })).scope.project).toBeUndefined();
  });
  it("retains the bounded scope pointer through compaction without retaining a long recalled lesson", async () => {
    const output = await call("ee_query", { query: "lesson", cwd: repoA });
    const long = output + "\nUNBOUNDED_RECALL_LOG".repeat(10000);
    const compacted = compactSubAgentMessages(history(long), { thresholdChars: 100, keepLastTurns: 0 });
    context = new TaskContext("owner", anchor, compacted, true, "orient", (s) => s === "continue");
    await call("ee_query", { query: "continued" });
    expect(requests[1].body.project_slug).toBe("repo-a");
    expect(JSON.stringify(compacted).length).toBeLessThan(10000);
  });
  it("writes lessons to the verified project instead of the consumer folder basename", async () => {
    await call("ee_query", { query: "lesson", cwd: repoA });
    await call("ee_write", { lesson: "A fixture lesson with a concrete proven fix." });
    const write = requests.find((r) => r.endpoint === "/api/import-memory");
    expect(write?.body.experiences[0].qa.scope.project_slug).toBe("repo-a");
  });
  it("refuses a project lesson without a resolved or explicit project instead of inventing one", async () => {
    expect(await call("ee_write", { lesson: "A fixture lesson with a concrete proven fix." })).toContain(
      "ee_project_required",
    );
    expect(requests).toHaveLength(0);
  });
  it("allows an explicit lesson project or deliberately global principle without inventing a scope", async () => {
    await call("ee_write", { lesson: "A fixture lesson with a concrete proven fix.", project: "repo-a" });
    await call("ee_write", {
      lesson: "A fixture principle intended for all projects.",
      collection: "experience-principles",
    });
    expect(requests[0].body.experiences[0].qa.scope).toEqual({ project_slug: "repo-a" });
    expect(requests[1].body.experiences[0].qa.scope).toEqual({});
  });
  it("rates the original recall scope even after the task selects another project", async () => {
    const outputA = await call("ee_query", { query: "lesson", cwd: repoA });
    // Different entries in the second scope keep the original handle provenance distinct.
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body);
      return ok({
        text: "No matching lessons",
        count: 0,
        entries: [],
        scope: { strict: true, project: "repo-b", cwd: body.cwd },
      });
    });
    const outputB = await call("ee_query", { query: "lesson", cwd: repoB });
    context = new TaskContext(
      "owner",
      anchor,
      [...history(outputA), ...history(outputB).slice(1)],
      true,
      "orient",
      (s) => s === "continue",
    );
    await call("ee_feedback", { ...entry, verdict: "ignored" });
    expect(requests.find((r) => r.endpoint === "/api/feedback")?.body).toMatchObject({
      cwd: repoA,
      project_slug: "repo-a",
    });
  });
  it("separates reachability from the last measured recall state", async () => {
    const before = JSON.parse(await call("ee_health", {}));
    expect(before.recallReady).toBe("not_checked");
    expect(before.lastRecall.state).toBe("not_checked");
    await call("ee_query", { query: "lesson", cwd: repoA });
    const after = JSON.parse(await call("ee_health", {}));
    expect(after.lastRecall).toMatchObject({ state: "ok", project: "repo-a" });
    expect(after.lastRecall.checkedAt).toEqual(expect.any(String));
  });
});
