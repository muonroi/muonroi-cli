import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as lsp from "../../lsp/runtime.js";
import { BashTool } from "../bash.js";
import { createBuiltinTools, setLiveToolSet } from "../registry.js";
import { filterScopedWorkerTools, WorkerWriteScope } from "../worker-write-scope.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-file-scope-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("refuses an out-of-task write even inside the ordinary run/temp root", async () => {
  const tools = createBuiltinTools(new BashTool(root), "agent", { writeScope: ["A/", "B.txt"] });
  const result = (await tools.write_file!.execute!({ file_path: "C.txt", content: "forbidden" }, {} as any)) as any;
  expect(result.success).toBe(false);
  expect(result.output).toContain("worker_write_scope_refused");
  expect(fs.existsSync(path.join(root, "C.txt"))).toBe(false);
});

it("forwards the explicit write scope through native task dispatch", async () => {
  const runTask = vi.fn(async (_request: unknown) => ({ success: true, output: "queued" }));
  const tools = createBuiltinTools(new BashTool(root), "agent", { runTask });
  await tools.task!.execute!(
    { agent: "general", description: "Scoped task", prompt: "Change A/B", writeScope: ["A/", "B.txt"] },
    {} as any,
  );
  expect(runTask.mock.calls[0]?.[0]).toMatchObject({ writeScope: ["A/", "B.txt"] });
});

it("writes and edits only A/B, retaining read-before-edit and skipping external LSP effects", async () => {
  const sync = vi.spyOn(lsp, "syncFileWithLsp");
  const tools = createBuiltinTools(new BashTool(root), "agent", { writeScope: ["A/", "B.txt"] });
  const call = async (name: string, input: any) => tools[name]!.execute!(input, {} as any) as Promise<any>;
  expect((await call("write_file", { file_path: "A/new.txt", content: "original" })).success).toBe(true);
  fs.writeFileSync(path.join(root, "B.txt"), "before");
  expect((await call("edit_file", { file_path: "B.txt", old_string: "before", new_string: "after" })).success).toBe(
    false,
  );
  await call("read_file", { file_path: "B.txt" });
  expect((await call("edit_file", { file_path: "B.txt", old_string: "before", new_string: "after" })).success).toBe(
    true,
  );
  expect(fs.readFileSync(path.join(root, "B.txt"), "utf8")).toBe("after");
  expect(sync).not.toHaveBeenCalled();
});

it.each([
  "C.txt",
  "A-evil/x.txt",
  "A/../../outside.txt",
  "B.txt/extra",
  ".git/config",
  "A/file:stream",
])("refuses escaped or special target %s without writes", async (file) => {
  const scope = new WorkerWriteScope(root, ["A/", "B.txt"]);
  expect(scope.refusal(file, root)).toContain("worker_write_scope_refused");
});

it.each(["../other/", "A/*", ".git/", ".GIT/", "A/../C.txt"])("refuses invalid scope %j", (entry) => {
  expect(() => new WorkerWriteScope(root, [entry])).toThrow();
});

it("refuses symlink escapes and hardlink aliases without changing their destinations", async () => {
  const outside = path.join(root, "C");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "original.txt"), "protected");
  fs.mkdirSync(path.join(root, "A"));
  fs.symlinkSync(outside, path.join(root, "A", "alias"), process.platform === "win32" ? "junction" : "dir");
  fs.linkSync(path.join(outside, "original.txt"), path.join(root, "A", "hard.txt"));
  const scope = new WorkerWriteScope(root, ["A/"]);
  expect(scope.refusal("A/alias/original.txt", root)).toContain("refused");
  expect(scope.refusal("A/hard.txt", root)).toContain("hardlink");
  expect(fs.readFileSync(path.join(outside, "original.txt"), "utf8")).toBe("protected");
});

// CI run 42131417821: on macOS tmpdir() is /var/... and its realpath
// /private/var/...; the scope bound the realpath and refused every in-scope
// write named through the /var alias. A junction/symlink ancestor reproduces it.
it("accepts in-scope writes through a linked workspace ancestor and keeps every refusal", async () => {
  const real = path.join(root, "real");
  fs.mkdirSync(path.join(real, "A"), { recursive: true });
  fs.writeFileSync(path.join(real, "A", "original.txt"), "x");
  fs.linkSync(path.join(real, "A", "original.txt"), path.join(real, "A", "hard.txt"));
  fs.symlinkSync(real, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  const linked = path.join(root, "alias");
  const scope = new WorkerWriteScope(linked, ["A/"]);
  expect(scope.refusal("A/new.txt", linked)).toBeUndefined();
  expect(scope.refusal(path.join(linked, "A", "new.txt"), linked)).toBeUndefined();
  expect(scope.refusal("A/new.txt", real)).toBeUndefined();
  expect(scope.refusal("C.txt", linked)).toContain("outside the current task writeScope");
  expect(scope.refusal("A/.git/config", linked)).toContain("forbidden path segment");
  expect(scope.refusal("A/hard.txt", linked)).toContain("hardlink");
  const tools = createBuiltinTools(new BashTool(linked), "agent", { writeScope: ["A/"] });
  const result = (await tools.write_file!.execute!({ file_path: "A/new.txt", content: "ok" }, {} as any)) as any;
  expect(result.success).toBe(true);
  expect(fs.readFileSync(path.join(real, "A", "new.txt"), "utf8")).toBe("ok");
});

it("pins the scope before a directory is retargeted, including existing files inside the workspace", () => {
  fs.mkdirSync(path.join(root, "A"));
  fs.mkdirSync(path.join(root, "C"));
  const scope = new WorkerWriteScope(root, ["A/"]);
  fs.renameSync(path.join(root, "A"), path.join(root, "old-A"));
  fs.symlinkSync(path.join(root, "C"), path.join(root, "A"), process.platform === "win32" ? "junction" : "dir");
  expect(scope.refusal("A/file.txt", root)).toContain("refused");
  expect(() => new WorkerWriteScope(root, ["A/"], scope.binding)).toThrow("retargeted");
});

it("[] revokes writes and the final inventory excludes shell/MCP/LSP and native aliases", () => {
  const tools = createBuiltinTools(new BashTool(root), "agent", { writeScope: [] });
  for (const name of ["bash", "verification_run", "lsp_query", "git_commit", "task", "ask_user"])
    expect(tools[name]).toBeUndefined();
  expect(new WorkerWriteScope(root, []).refusal("A.txt", root)).toContain("refused");
  const native = { write_file: {} };
  expect(
    filterScopedWorkerTools({ write_file: native.write_file, mcp_alias: native.write_file, bash: {} }, native),
  ).toEqual(native);
});

it("does not advertise the parent's shell through tool discovery", async () => {
  const parent = createBuiltinTools(new BashTool(root), "agent");
  setLiveToolSet(parent);
  try {
    const scoped = createBuiltinTools(new BashTool(root), "agent", { writeScope: [] });
    const list = String(await scoped.list_tools!.execute!({}, {} as any));
    expect(list).not.toContain("bash:");
    expect(String(await scoped.describe_tool!.execute!({ name: "bash" }, {} as any))).toContain("Tool not found");
  } finally {
    setLiveToolSet(null);
  }
});
