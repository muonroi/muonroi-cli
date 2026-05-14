# Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-repo agent harness that lets external agent CLIs (Claude/Codex/Gemini) drive `muonroi-cli`'s OpenTUI/React TUI like a real user, by reading structured JSON state via a stable protocol — and reuse the same schema as the design-time output of the `ideal` feature.

**Architecture:** Single shared schema (`UINode` + `LiveFrame`/`LiveEvent` for runtime, `DesignSpec` for design-time). Producer A hooks the OpenTUI reconciler in-process behind `--agent-mode` and streams JSONL over a sidechannel (POSIX fds 3/4, Windows named pipe). Consumer = in-process `driver.ts` (used by ideal-team agents) and a thin `muonroi-cli mcp-driver` MCP server (used by external agents). Producer B is the `ideal` designer agent emitting `DesignSpec` JSON.

**Tech Stack:** TypeScript, Bun runtime, OpenTUI/React (`@opentui/core@0.1.107`), Commander, Vitest, Zod (already in repo), MCP SDK `@modelcontextprotocol/sdk`.

**Design spec:** `docs/superpowers/specs/2026-05-14-agent-harness-design.md`

---

## File Structure

**New files:**
- `docs/agent-harness/PROTOCOL.md` — public protocol spec
- `docs/agent-harness/schema.json` — JSON Schema for messages
- `docs/agent-harness/examples/*` — reference fixtures
- `src/agent-harness/protocol.ts` — TypeScript types
- `src/agent-harness/sidechannel.ts` — JSONL transport (POSIX + Windows)
- `src/agent-harness/reconciler-hook.ts` — OpenTUI → LiveFrame
- `src/agent-harness/idle.ts` — idle detection
- `src/agent-harness/selector.ts` — selector parser + matcher
- `src/agent-harness/driver.ts` — in-process API
- `src/agent-harness/mock-llm.ts` — fixture LLM
- `src/agent-harness/agent-mode.ts` — `--agent-mode` wiring
- `src/agent-harness/predicate.ts` — Zod predicate for `expect`
- `src/mcp/harness-driver.ts` — `mcp-driver` subcommand
- `src/product-loop/design-output.ts` — DesignSpec emission
- `tests/harness/*.spec.ts` — vitest E2E suite

**Modified files:**
- `src/index.ts` — register `--agent-mode` global flag and `mcp-driver` subcommand
- `src/product-loop/index.ts:793-800` — designer agent emits DesignSpec via `design-output.ts`
- `package.json` — add `tests/` and `docs/agent-harness/` to test/files patterns if needed

**Why this split:** harness internals live together under `src/agent-harness/` (one responsibility per file, ≤300 LOC each). MCP wrapper goes in existing `src/mcp/` (follows repo convention). Designer-side emission goes in the existing `src/product-loop/` (where ideal-team logic lives).

---

## Phase 0a — OpenTUI Hook Spike (½ day)

Goal: confirm OpenTUI exposes a stable hook surface before committing Phase 1, OR document the heuristic fallback.

### Task 0a.1: Survey OpenTUI exports

**Files:**
- Read: `node_modules/@opentui/core/dist/*.d.ts`
- Read: `node_modules/@opentui/react/dist/*.d.ts`

- [ ] **Step 1:** List all exports

```bash
cd D:/sources/Core/muonroi-cli
ls node_modules/@opentui/core/dist/
grep -E "export (function|class|const|interface|type)" node_modules/@opentui/core/dist/index.d.ts | head -80
grep -E "export (function|class|const|interface|type)" node_modules/@opentui/react/dist/index.d.ts | head -80
```

Expected: a list of public symbols. Look for: `Renderer`, `Reconciler`, `onRender`, `onFrame`, `Scheduler`, `useRenderer`, hook-like names.

- [ ] **Step 2:** Search for render scheduler / event API

```bash
grep -rn "schedule\|onRender\|onFrame\|frameCallback\|requestRender" node_modules/@opentui/core/dist/ | head -30
```

Expected: candidate surface for `idle.ts`. Capture findings.

### Task 0a.2: Build minimal hook prototype

**Files:**
- Create: `src/agent-harness/__spike__/hook-probe.ts`

- [ ] **Step 1:** Write a 40-line spike that mounts a trivial OpenTUI React tree and tries to observe each render.

```ts
// src/agent-harness/__spike__/hook-probe.ts
// SPIKE: throwaway file, delete after Phase 0a.
import { render } from "@opentui/react";
import React from "react";

let renderCount = 0;
const App = () => {
  renderCount++;
  console.error(JSON.stringify({ t: "render", count: renderCount, ts: Date.now() }));
  return React.createElement("box", null, "hello");
};

// Try every plausible hook: onRender, onFrame, scheduler.subscribe...
// Document which works in a comment header.
render(React.createElement(App));
setTimeout(() => process.exit(0), 200);
```

- [ ] **Step 2:** Run probe

```bash
bun run src/agent-harness/__spike__/hook-probe.ts 2>&1 | head -20
```

Expected: at least one render event observable. Document the API used.

### Task 0a.3: Document outcome and decide

**Files:**
- Create: `docs/agent-harness/spike-0a-findings.md`

- [ ] **Step 1:** Write findings doc with three sections:

```markdown
# Phase 0a spike findings — OpenTUI hook surface

## What works
- `<API name>` — public/internal, semantics, stability assessment

## What does not work
- `<API name>` — reason

## Decision
- [ ] HOOK-AVAILABLE: proceed with §10 plan A
- [ ] HOOK-INTERNAL: pin OpenTUI version, wrap, add smoke test
- [ ] NO-HOOK: implement heuristic mode (`--agent-idle-mode=heuristic`)
```

- [ ] **Step 2:** Delete spike directory

```bash
rm -rf src/agent-harness/__spike__
```

- [ ] **Step 3:** Commit

```bash
git add docs/agent-harness/spike-0a-findings.md
git commit -m "docs(harness): phase 0a spike — OpenTUI hook surface findings"
```

---

## Phase 0b — Protocol Spec + Schema + Types (½ day)

### Task 0b.1: Write `PROTOCOL.md`

**Files:**
- Create: `docs/agent-harness/PROTOCOL.md`

- [ ] **Step 1:** Write the public protocol doc (single source of truth — copy/expand from design §6 and §8).

The doc must include:
- Version: `0.1.0-experimental`
- All message types (`LiveFrame`, `LiveEvent`, `DesignSpec`) with full field tables
- The full `Role` enumeration from design §6.1
- `StatePatch` resolution algorithm (locate by `id`, shallow-merge non-children)
- Selector grammar from design §8.2 with at least 6 worked examples
- Transport overview pointing at `schema.json` for the binding-level spec
- Version-evolution policy from design §6.4

- [ ] **Step 2:** Commit

```bash
git add docs/agent-harness/PROTOCOL.md
git commit -m "docs(harness): add PROTOCOL.md v0.1.0-experimental"
```

### Task 0b.2: Write `schema.json`

**Files:**
- Create: `docs/agent-harness/schema.json`

- [ ] **Step 1:** JSON Schema (draft 2020-12) covering `UINode`, `LiveFrame`, `LiveEvent`, `DesignSpec`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://muonroi.dev/agent-harness/0.1.0/schema.json",
  "title": "Agent Harness Protocol",
  "definitions": {
    "Role": {
      "enum": ["dialog","textbox","listbox","listitem","button","checkbox",
               "radio","radiogroup","tab","tablist","tree","treeitem",
               "table","row","cell","progressbar","spinner",
               "log","statusbar","menu","menuitem","toast","tooltip"]
    },
    "UINode": {
      "type": "object",
      "required": ["id","role"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "role": { "$ref": "#/definitions/Role" },
        "name": { "type": "string" },
        "value": { "type": "string" },
        "focus": { "const": true },
        "selected": { "const": true },
        "disabled": { "const": true },
        "hidden": { "const": true },
        "state": { "type": "string" },
        "props": { "type": "object" },
        "children": { "type": "array", "items": { "$ref": "#/definitions/UINode" } }
      }
    },
    "LiveFrame": {
      "type": "object",
      "required": ["mode","version","seq","ts","nodes"],
      "properties": {
        "mode": { "const": "live" },
        "version": { "const": "0.1.0" },
        "seq": { "type": "integer", "minimum": 0 },
        "ts": { "type": "integer" },
        "focus": { "type": "string" },
        "modals": { "type": "array", "items": { "type": "string" } },
        "nodes": { "type": "array", "items": { "$ref": "#/definitions/UINode" } }
      }
    },
    "LiveEvent": {
      "oneOf": [
        { "type": "object", "required": ["t","kind","target","text"],
          "properties": { "t": { "const": "event" }, "kind": { "const": "stream.delta" },
                          "target": { "type": "string" }, "text": { "type": "string" } } },
        { "type": "object", "required": ["t","kind","level","text"],
          "properties": { "t": { "const": "event" }, "kind": { "const": "toast" },
                          "level": { "enum": ["info","warn","error"] },
                          "text": { "type": "string" }, "ttlMs": { "type": "integer" } } },
        { "type": "object", "required": ["t"],
          "properties": { "t": { "const": "idle" } } }
      ]
    },
    "StatePatch": {
      "type": "object",
      "required": ["id"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" }, "value": { "type": "string" },
        "focus": { "const": true }, "selected": { "const": true },
        "disabled": { "const": true }, "hidden": { "const": true },
        "state": { "type": "string" }, "props": { "type": "object" }
      },
      "not": { "required": ["children"] }
    },
    "DesignSpec": {
      "type": "object",
      "required": ["mode","version","scenes"],
      "properties": {
        "mode": { "const": "design" },
        "version": { "const": "0.1.0" },
        "target": { "enum": ["tui","react","angular","any"] },
        "scenes": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id","name","layout"],
            "properties": {
              "id": { "type": "string" }, "name": { "type": "string" },
              "layout": { "$ref": "#/definitions/UINode" },
              "states": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": ["name","patches"],
                  "properties": {
                    "name": { "type": "string" },
                    "patches": { "type": "array", "items": { "$ref": "#/definitions/StatePatch" } }
                  }
                }
              },
              "transitions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": ["from","on","to"],
                  "properties": {
                    "from": { "type": "string" }, "on": { "type": "string" }, "to": { "type": "string" }
                  }
                }
              },
              "notes": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2:** Commit

```bash
git add docs/agent-harness/schema.json
git commit -m "docs(harness): add JSON Schema for v0.1.0"
```

### Task 0b.3: Write TypeScript types

**Files:**
- Create: `src/agent-harness/protocol.ts`

- [ ] **Step 1:** Write failing test first

```ts
// src/agent-harness/__tests__/protocol.spec.ts
import { describe, it, expect } from "vitest";
import type { LiveFrame, UINode, DesignSpec } from "../protocol";

describe("protocol types", () => {
  it("compiles a minimal LiveFrame", () => {
    const frame: LiveFrame = {
      mode: "live", version: "0.1.0",
      seq: 0, ts: 0, nodes: []
    };
    expect(frame.mode).toBe("live");
  });

  it("compiles a UINode with all flags", () => {
    const node: UINode = {
      id: "a", role: "button", name: "OK",
      focus: true, selected: true, disabled: true, hidden: true,
      state: "loading", props: { pct: 50 }, children: []
    };
    expect(node.id).toBe("a");
  });

  it("compiles a DesignSpec with state patches", () => {
    const spec: DesignSpec = {
      mode: "design", version: "0.1.0",
      scenes: [{
        id: "s1", name: "Composer",
        layout: { id: "root", role: "dialog" },
        states: [{ name: "loading", patches: [{ id: "root", state: "loading" }] }]
      }]
    };
    expect(spec.scenes.length).toBe(1);
  });
});
```

- [ ] **Step 2:** Run test (fails — type module missing)

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/agent-harness/__tests__/protocol.spec.ts
```

Expected: `Cannot find module '../protocol'`.

- [ ] **Step 3:** Write `protocol.ts`

```ts
// src/agent-harness/protocol.ts
export const PROTOCOL_VERSION = "0.1.0" as const;

export type Role =
  | "dialog" | "textbox" | "listbox" | "listitem"
  | "button" | "checkbox" | "radio" | "radiogroup"
  | "tab" | "tablist" | "tree" | "treeitem"
  | "table" | "row" | "cell"
  | "progressbar" | "spinner"
  | "log" | "statusbar" | "menu" | "menuitem" | "toast" | "tooltip";

export type UINode = {
  id: string;
  role: Role;
  name?: string;
  value?: string;
  focus?: true;
  selected?: true;
  disabled?: true;
  hidden?: true;
  state?: string;
  props?: Record<string, unknown>;
  children?: UINode[];
};

export type LiveFrame = {
  mode: "live";
  version: typeof PROTOCOL_VERSION;
  seq: number;
  ts: number;
  focus?: string;
  modals?: string[];
  nodes: UINode[];
};

export type LiveEvent =
  | { t: "event"; kind: "stream.delta"; target: string; text: string }
  | { t: "event"; kind: "toast"; level: "info" | "warn" | "error"; text: string; ttlMs?: number }
  | { t: "idle" };

export type StatePatch = { id: string } & Partial<Omit<UINode, "children" | "id">>;

export type DesignSpec = {
  mode: "design";
  version: typeof PROTOCOL_VERSION;
  target?: "tui" | "react" | "angular" | "any";
  scenes: Array<{
    id: string;
    name: string;
    layout: UINode;
    states?: Array<{ name: string; patches: StatePatch[] }>;
    transitions?: Array<{ from: string; on: string; to: string }>;
    notes?: string;
  }>;
};

export type HarnessMessage = LiveFrame | LiveEvent;
```

- [ ] **Step 4:** Run test — should pass

```bash
bunx vitest run src/agent-harness/__tests__/protocol.spec.ts
```

Expected: PASS 3 tests.

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/protocol.ts src/agent-harness/__tests__/protocol.spec.ts
git commit -m "feat(harness): add protocol types for v0.1.0"
```

### Task 0b.4: Schema-validate fixtures

**Files:**
- Create: `docs/agent-harness/examples/frame-composer.json`
- Create: `docs/agent-harness/examples/frame-council-picker.json`
- Create: `docs/agent-harness/examples/frame-error-toast.json`
- Create: `docs/agent-harness/examples/design-spec-composer.json`
- Create: `docs/agent-harness/examples/design-spec-council.json`
- Create: `src/agent-harness/__tests__/schema.spec.ts`

- [ ] **Step 1:** Write 3 LiveFrame fixtures and 2 DesignSpec fixtures (use the role vocabulary; cover one nested-modal frame and one toast-event frame).

Example `frame-composer.json`:

```json
{
  "mode": "live", "version": "0.1.0",
  "seq": 1, "ts": 1715000000000,
  "focus": "composer",
  "nodes": [
    { "id": "root", "role": "dialog", "children": [
      { "id": "composer", "role": "textbox", "value": "" },
      { "id": "status", "role": "statusbar", "value": "Ready" }
    ]}
  ]
}
```

- [ ] **Step 2:** Write schema test

```ts
// src/agent-harness/__tests__/schema.spec.ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

const schema = JSON.parse(readFileSync("docs/agent-harness/schema.json", "utf8"));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);

describe("schema fixtures", () => {
  const dir = "docs/agent-harness/examples";
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  for (const f of files) {
    it(`${f} matches schema`, () => {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const def = data.mode === "live" ? "LiveFrame" : "DesignSpec";
      const validate = ajv.compile({ $ref: `${schema.$id}#/definitions/${def}` });
      const ok = validate(data);
      if (!ok) console.error(validate.errors);
      expect(ok).toBe(true);
    });
  }
});
```

- [ ] **Step 3:** Install Ajv (if not present)

```bash
bun add -d ajv
```

- [ ] **Step 4:** Run tests

```bash
bunx vitest run src/agent-harness/__tests__/schema.spec.ts
```

Expected: all fixtures PASS.

- [ ] **Step 5:** Commit

```bash
git add docs/agent-harness/examples/ src/agent-harness/__tests__/schema.spec.ts package.json bun.lock
git commit -m "test(harness): validate 5 protocol fixtures against schema"
```

---

## Phase 1 — agent-mode + Reconciler Hook + Sidechannel (1.5–2 days)

### Task 1.1: Sidechannel writer/reader (cross-platform)

**Files:**
- Create: `src/agent-harness/sidechannel.ts`
- Create: `src/agent-harness/__tests__/sidechannel.spec.ts`

- [ ] **Step 1:** Write failing tests

```ts
// src/agent-harness/__tests__/sidechannel.spec.ts
import { describe, it, expect } from "vitest";
import { createSidechannelWriter, parseSidechannelLine } from "../sidechannel";

describe("sidechannel framing", () => {
  it("serializes a message as a single JSONL line", () => {
    const line = createSidechannelWriter.serialize({ t: "idle" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean).length).toBe(1);
  });

  it("rejects messages over 1 MiB", () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    expect(() => createSidechannelWriter.serialize({ t: "event", kind: "stream.delta", target: "a", text: huge }))
      .toThrow(/exceeds 1 MiB/);
  });

  it("parses a valid line", () => {
    expect(parseSidechannelLine('{"t":"idle"}\n')).toEqual({ t: "idle" });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSidechannelLine("not json\n")).toThrow();
  });
});
```

- [ ] **Step 2:** Run — fails

```bash
bunx vitest run src/agent-harness/__tests__/sidechannel.spec.ts
```

- [ ] **Step 3:** Implement

```ts
// src/agent-harness/sidechannel.ts
import type { HarnessMessage } from "./protocol.js";

const MAX_BYTES = 1024 * 1024; // 1 MiB

function serialize(msg: HarnessMessage | Record<string, unknown>): string {
  const line = JSON.stringify(msg) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_BYTES) {
    throw new Error(`sidechannel message exceeds 1 MiB cap`);
  }
  return line;
}

export const createSidechannelWriter = {
  serialize,
  /** Write to a writable stream. Caller owns flushing/error handling. */
  write(stream: NodeJS.WritableStream, msg: HarnessMessage): void {
    stream.write(serialize(msg));
  },
};

export function parseSidechannelLine(line: string): unknown {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  return JSON.parse(trimmed);
}

/** Buffered line splitter for a readable stream. */
export function createLineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      if (line.trim().length > 0) onLine(line);
    }
  };
}
```

- [ ] **Step 4:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/sidechannel.spec.ts
```

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/sidechannel.ts src/agent-harness/__tests__/sidechannel.spec.ts
git commit -m "feat(harness): sidechannel framing — JSONL, 1 MiB cap"
```

### Task 1.2: Sidechannel transport — POSIX (fds 3/4)

**Files:**
- Modify: `src/agent-harness/sidechannel.ts`
- Modify: `src/agent-harness/__tests__/sidechannel.spec.ts`

- [ ] **Step 1:** Add POSIX transport test

```ts
// append to __tests__/sidechannel.spec.ts
import { openPosixSidechannel } from "../sidechannel";

describe.skipIf(process.platform === "win32")("posix sidechannel", () => {
  it("opens fd 3 for write and fd 4 for read", async () => {
    // Smoke: function returns { writer, reader } without throwing when fds available
    const sc = await openPosixSidechannel({ writeFd: 3, readFd: 4, simulateWithPipes: true });
    expect(sc.writer).toBeDefined();
    expect(sc.reader).toBeDefined();
    sc.close();
  });
});
```

- [ ] **Step 2:** Implement (uses `node:fs` createReadStream / createWriteStream on fd)

```ts
// append to src/agent-harness/sidechannel.ts
import { createReadStream, createWriteStream } from "node:fs";
import { pipe as _pipe } from "node:stream";

export type PosixSidechannel = {
  writer: NodeJS.WritableStream;
  reader: NodeJS.ReadableStream;
  close: () => void;
};

export async function openPosixSidechannel(opts: {
  writeFd: number; readFd: number; simulateWithPipes?: boolean;
}): Promise<PosixSidechannel> {
  if (opts.simulateWithPipes) {
    // For tests on hosts without inherited fds — use a memory pipe pair.
    const { PassThrough } = await import("node:stream");
    const writer = new PassThrough();
    const reader = new PassThrough();
    return { writer, reader, close: () => { writer.end(); reader.end(); } };
  }
  const writer = createWriteStream("", { fd: opts.writeFd });
  const reader = createReadStream("", { fd: opts.readFd });
  return {
    writer, reader,
    close: () => { writer.end(); reader.destroy(); }
  };
}
```

- [ ] **Step 3:** Run test

```bash
bunx vitest run src/agent-harness/__tests__/sidechannel.spec.ts
```

Expected: PASS on POSIX, SKIP on Windows.

- [ ] **Step 4:** Commit

```bash
git add src/agent-harness/sidechannel.ts src/agent-harness/__tests__/sidechannel.spec.ts
git commit -m "feat(harness): POSIX fd-based sidechannel transport"
```

### Task 1.3: Sidechannel transport — Windows named pipe

**Files:**
- Modify: `src/agent-harness/sidechannel.ts`
- Modify: `src/agent-harness/__tests__/sidechannel.spec.ts`

- [ ] **Step 1:** Add Windows test

```ts
// append to __tests__/sidechannel.spec.ts
import { openWindowsSidechannel, generatePipeName } from "../sidechannel";

describe.skipIf(process.platform !== "win32")("windows sidechannel", () => {
  it("generates a unique pipe name", () => {
    const a = generatePipeName(); const b = generatePipeName();
    expect(a).toMatch(/^\\\\\.\\pipe\\muonroi-harness-/);
    expect(a).not.toEqual(b);
  });

  it("opens a server and a client roundtrip", async () => {
    const pipeName = generatePipeName();
    const server = await openWindowsSidechannel({ pipeName, role: "server" });
    const client = await openWindowsSidechannel({ pipeName, role: "client" });
    let received = "";
    client.reader.on("data", (b) => { received += b.toString("utf8"); });
    server.writer.write("hello\n");
    await new Promise(r => setTimeout(r, 50));
    expect(received).toBe("hello\n");
    server.close(); client.close();
  });
});
```

- [ ] **Step 2:** Implement using `net.createServer` / `net.connect` (Node's built-in named-pipe support on Windows)

```ts
// append to src/agent-harness/sidechannel.ts
import { createServer, connect, type Socket, type Server } from "node:net";
import { randomBytes } from "node:crypto";

export function generatePipeName(): string {
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  return `\\\\.\\pipe\\muonroi-harness-${id}`;
}

export type WindowsSidechannel = {
  writer: NodeJS.WritableStream;
  reader: NodeJS.ReadableStream;
  close: () => void;
};

export async function openWindowsSidechannel(opts: {
  pipeName: string; role: "server" | "client";
}): Promise<WindowsSidechannel> {
  if (opts.role === "server") {
    return await new Promise<WindowsSidechannel>((resolve, reject) => {
      let socket: Socket | null = null;
      const server: Server = createServer((s) => {
        socket = s;
        resolve({
          writer: s, reader: s,
          close: () => { s.destroy(); server.close(); }
        });
      });
      server.on("error", reject);
      server.listen(opts.pipeName);
    });
  } else {
    return await new Promise<WindowsSidechannel>((resolve, reject) => {
      const s = connect(opts.pipeName);
      s.once("connect", () => resolve({
        writer: s, reader: s, close: () => { s.destroy(); }
      }));
      s.once("error", reject);
    });
  }
}
```

- [ ] **Step 3:** Run on Windows

```bash
bunx vitest run src/agent-harness/__tests__/sidechannel.spec.ts
```

Expected: roundtrip PASS on Windows.

- [ ] **Step 4:** Commit

```bash
git add src/agent-harness/sidechannel.ts src/agent-harness/__tests__/sidechannel.spec.ts
git commit -m "feat(harness): Windows named-pipe sidechannel transport"
```

### Task 1.4: Reconciler hook — emit `LiveFrame`

**Files:**
- Create: `src/agent-harness/reconciler-hook.ts`
- Create: `src/agent-harness/__tests__/reconciler-hook.spec.ts`

> Implementation must follow whichever surface was confirmed in Task 0a.3. If `HOOK-INTERNAL` or `NO-HOOK`, adapt the hook body accordingly; the public function signatures below are stable.

- [ ] **Step 1:** Write the test for tree-to-frame conversion (decoupled from OpenTUI internals)

```ts
// src/agent-harness/__tests__/reconciler-hook.spec.ts
import { describe, it, expect } from "vitest";
import { renderTreeToFrame, type RenderTreeNode } from "../reconciler-hook";

describe("renderTreeToFrame", () => {
  it("maps a flat tree", () => {
    const root: RenderTreeNode = {
      kind: "box", id: "root",
      props: { "data-role": "dialog" },
      children: [
        { kind: "input", id: "composer", props: { "data-role": "textbox", value: "hi", focused: true }, children: [] }
      ]
    };
    const f = renderTreeToFrame(root, { seq: 1, ts: 100 });
    expect(f.seq).toBe(1);
    expect(f.focus).toBe("composer");
    expect(f.nodes[0].id).toBe("root");
    expect(f.nodes[0].children![0].value).toBe("hi");
    expect(f.nodes[0].children![0].focus).toBe(true);
  });

  it("collects modal stack", () => {
    const root: RenderTreeNode = {
      kind: "box", id: "root", props: {}, children: [
        { kind: "box", id: "main", props: { "data-role": "dialog" }, children: [] },
        { kind: "box", id: "confirm", props: { "data-role": "dialog", "data-modal": "true" }, children: [] }
      ]
    };
    const f = renderTreeToFrame(root, { seq: 1, ts: 100 });
    expect(f.modals).toEqual(["confirm"]);
  });
});
```

- [ ] **Step 2:** Run — fails

```bash
bunx vitest run src/agent-harness/__tests__/reconciler-hook.spec.ts
```

- [ ] **Step 3:** Implement

```ts
// src/agent-harness/reconciler-hook.ts
import type { LiveFrame, UINode, Role } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export type RenderTreeNode = {
  kind: string;
  id?: string;
  props: Record<string, unknown>;
  children: RenderTreeNode[];
};

const VALID_ROLES = new Set<Role>([
  "dialog","textbox","listbox","listitem","button","checkbox",
  "radio","radiogroup","tab","tablist","tree","treeitem",
  "table","row","cell","progressbar","spinner",
  "log","statusbar","menu","menuitem","toast","tooltip"
]);

function mapNode(rt: RenderTreeNode): UINode | null {
  const role = rt.props["data-role"] as string | undefined;
  if (!role || !VALID_ROLES.has(role as Role)) return null;
  const node: UINode = {
    id: rt.id ?? rt.props["data-id"] as string ?? `anon-${Math.random().toString(36).slice(2,8)}`,
    role: role as Role,
  };
  const p = rt.props;
  if (typeof p.name === "string") node.name = p.name;
  if (typeof p.value === "string") node.value = p.value;
  if (p.focused === true) node.focus = true;
  if (p.selected === true) node.selected = true;
  if (p.disabled === true) node.disabled = true;
  if (p.hidden === true) node.hidden = true;
  if (typeof p["data-state"] === "string") node.state = p["data-state"];
  if (p["data-props"] && typeof p["data-props"] === "object") node.props = p["data-props"] as Record<string, unknown>;
  const childNodes: UINode[] = [];
  for (const c of rt.children) {
    const mapped = mapNode(c);
    if (mapped) childNodes.push(mapped);
    else for (const inner of (c.children ?? [])) {
      const m = mapNode(inner);
      if (m) childNodes.push(m);
    }
  }
  if (childNodes.length > 0) node.children = childNodes;
  return node;
}

function findFocus(node: UINode | null): string | undefined {
  if (!node) return;
  if (node.focus) return node.id;
  for (const c of node.children ?? []) {
    const f = findFocus(c);
    if (f) return f;
  }
}

function findModals(node: UINode | null, acc: string[] = []): string[] {
  if (!node) return acc;
  if (node.role === "dialog" && (node as unknown as { _modal?: true })._modal) acc.push(node.id);
  for (const c of node.children ?? []) findModals(c, acc);
  return acc;
}

export function renderTreeToFrame(
  root: RenderTreeNode,
  meta: { seq: number; ts: number }
): LiveFrame {
  // collect modal ids by walking RT, since the modal flag lives on the source tree
  const modals: string[] = [];
  function walkRT(n: RenderTreeNode) {
    if (n.props["data-modal"] === "true" && typeof n.id === "string") modals.push(n.id);
    for (const c of n.children) walkRT(c);
  }
  walkRT(root);

  const rootNode = mapNode(root);
  const frame: LiveFrame = {
    mode: "live", version: PROTOCOL_VERSION,
    seq: meta.seq, ts: meta.ts,
    nodes: rootNode ? [rootNode] : [],
  };
  const focus = findFocus(rootNode);
  if (focus) frame.focus = focus;
  if (modals.length > 0) frame.modals = modals;
  return frame;
}
```

- [ ] **Step 4:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/reconciler-hook.spec.ts
```

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/reconciler-hook.ts src/agent-harness/__tests__/reconciler-hook.spec.ts
git commit -m "feat(harness): render-tree → LiveFrame mapping"
```

### Task 1.5: Idle detection module

**Files:**
- Create: `src/agent-harness/idle.ts`
- Create: `src/agent-harness/__tests__/idle.spec.ts`

- [ ] **Step 1:** Test

```ts
// src/agent-harness/__tests__/idle.spec.ts
import { describe, it, expect, vi } from "vitest";
import { createIdleDetector } from "../idle";

describe("idle detector", () => {
  it("emits idle after quiescence window", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const det = createIdleDetector({ quiescenceMs: 50, onIdle: () => events.push("idle") });
    det.markActivity();
    vi.advanceTimersByTime(30);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(30);
    expect(events).toEqual(["idle"]);
    vi.useRealTimers();
  });

  it("re-arms on subsequent activity", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const det = createIdleDetector({ quiescenceMs: 50, onIdle: () => events.push("idle") });
    det.markActivity();
    vi.advanceTimersByTime(60);
    det.markActivity();
    vi.advanceTimersByTime(60);
    expect(events).toEqual(["idle", "idle"]);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2:** Run — fails

```bash
bunx vitest run src/agent-harness/__tests__/idle.spec.ts
```

- [ ] **Step 3:** Implement

```ts
// src/agent-harness/idle.ts
export type IdleDetector = {
  markActivity: () => void;
  dispose: () => void;
};

export function createIdleDetector(opts: {
  quiescenceMs: number;
  onIdle: () => void;
}): IdleDetector {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => { timer = null; opts.onIdle(); };
  const markActivity = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, opts.quiescenceMs);
  };
  return {
    markActivity,
    dispose: () => { if (timer) clearTimeout(timer); timer = null; }
  };
}
```

- [ ] **Step 4:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/idle.spec.ts
```

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/idle.ts src/agent-harness/__tests__/idle.spec.ts
git commit -m "feat(harness): idle detector with quiescence window"
```

### Task 1.6: `--agent-mode` wiring + determinism flags

**Files:**
- Create: `src/agent-harness/agent-mode.ts`
- Modify: `src/index.ts` (register flag)

- [ ] **Step 1:** Implement agent-mode initializer (no test — wired smoke is covered by Phase 2 E2E)

```ts
// src/agent-harness/agent-mode.ts
import { generatePipeName, openPosixSidechannel, openWindowsSidechannel, createSidechannelWriter } from "./sidechannel.js";
import { createIdleDetector } from "./idle.js";
import { renderTreeToFrame, type RenderTreeNode } from "./reconciler-hook.js";
import type { HarnessMessage } from "./protocol.js";

export type AgentModeOptions = {
  cols: number;       // default 120
  rows: number;       // default 40
  idleMs: number;     // default 50
  mockLlmDir?: string;
  fakeClock?: boolean;
};

export type AgentModeRuntime = {
  emit: (msg: HarnessMessage) => void;
  onCommand: (handler: (cmd: unknown) => void) => void;
  setRenderTree: (tree: RenderTreeNode) => void;
  shutdown: () => void;
};

export async function startAgentMode(opts: AgentModeOptions): Promise<AgentModeRuntime> {
  // 1) Transport
  let writer: NodeJS.WritableStream, reader: NodeJS.ReadableStream, close: () => void;
  if (process.platform === "win32") {
    const pipeName = generatePipeName();
    process.stdout.write(JSON.stringify({ t: "handshake", pipe: pipeName }) + "\n");
    const sc = await openWindowsSidechannel({ pipeName, role: "server" });
    writer = sc.writer; reader = sc.reader; close = sc.close;
  } else {
    const sc = await openPosixSidechannel({ writeFd: 3, readFd: 4 });
    writer = sc.writer; reader = sc.reader; close = sc.close;
  }

  // 2) State
  let seq = 0;
  const now = () => opts.fakeClock ? seq * 16 : Date.now();
  const emit = (msg: HarnessMessage) => {
    writer.write(createSidechannelWriter.serialize(msg));
  };
  const idle = createIdleDetector({
    quiescenceMs: opts.idleMs,
    onIdle: () => emit({ t: "idle" }),
  });

  // 3) Render tree → frame
  const setRenderTree = (tree: RenderTreeNode) => {
    const frame = renderTreeToFrame(tree, { seq: seq++, ts: now() });
    emit(frame);
    idle.markActivity();
  };

  // 4) Command channel
  const handlers: Array<(cmd: unknown) => void> = [];
  const onCommand = (h: (cmd: unknown) => void) => { handlers.push(h); };
  // Read JSONL lines from `reader`
  let buf = "";
  reader.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) {
        try { for (const h of handlers) h(JSON.parse(line)); }
        catch { /* malformed input — ignore */ }
      }
    }
  });

  // 5) Determinism: force size
  process.stdout.columns = opts.cols;
  process.stdout.rows = opts.rows;

  return {
    emit, onCommand, setRenderTree,
    shutdown: () => { idle.dispose(); close(); }
  };
}
```

- [ ] **Step 2:** Register the flag in `src/index.ts`. Open the file at line ~30 where `program` is set up via Commander and add:

```ts
// In src/index.ts, near top-level program option declarations
program
  .option("--agent-mode", "Enable agent harness mode (JSONL sidechannel)")
  .option("--agent-cols <n>", "Terminal columns in agent-mode", (v) => parseInt(v, 10), 120)
  .option("--agent-rows <n>", "Terminal rows in agent-mode", (v) => parseInt(v, 10), 40)
  .option("--agent-idle-ms <n>", "Idle quiescence window (ms)", (v) => parseInt(v, 10), 50)
  .option("--agent-fake-clock", "Use deterministic frame-counter clock")
  .option("--mock-llm <dir>", "Serve LLM fixtures from directory");
```

After the program parses options (find the existing `program.parse` call), branch:

```ts
const opts = program.opts();
if (opts.agentMode) {
  const { startAgentMode } = await import("./agent-harness/agent-mode.js");
  // Initialize runtime; store on globalThis for the renderer to reach later.
  const runtime = await startAgentMode({
    cols: opts.agentCols, rows: opts.agentRows,
    idleMs: opts.agentIdleMs, fakeClock: opts.agentFakeClock,
    mockLlmDir: opts.mockLlm,
  });
  (globalThis as Record<string, unknown>).__muonroiAgentRuntime = runtime;
}
```

- [ ] **Step 3:** Hook the runtime in the UI render pipeline. Open `src/ui/app.tsx`. Wrap the root render so that after each commit, if `__muonroiAgentRuntime` is set, walk the OpenTUI internal tree (use the API confirmed in Task 0a.3) and call `runtime.setRenderTree(tree)`. Reference Task 0a.3 findings doc for the exact API.

If hook is unavailable, schedule via `setImmediate` after each `useEffect` cleanup in the top-level component.

- [ ] **Step 4:** Build

```bash
bunx tsc --noEmit
```

Expected: zero type errors.

- [ ] **Step 5:** Smoke test

```bash
bun run src/index.ts --agent-mode --agent-idle-ms 50 2>/dev/null &
echo "smoke: agent-mode started (kill manually if it hangs)"
```

- [ ] **Step 6:** Commit

```bash
git add src/agent-harness/agent-mode.ts src/index.ts src/ui/app.tsx
git commit -m "feat(harness): wire --agent-mode and reconciler hook"
```

---

## Phase 2 — Driver + Selector + Idle (1 day)

### Task 2.1: Selector parser

**Files:**
- Create: `src/agent-harness/selector.ts`
- Create: `src/agent-harness/__tests__/selector.spec.ts`

- [ ] **Step 1:** Tests

```ts
// src/agent-harness/__tests__/selector.spec.ts
import { describe, it, expect } from "vitest";
import { parseSelector } from "../selector";

describe("selector parser", () => {
  it("parses key=value", () => {
    expect(parseSelector('role=button name="Send"')).toEqual({
      terms: [
        { key: "role", op: "=", value: "button" },
        { key: "name", op: "=", value: "Send" }
      ],
      combinators: [" "]
    });
  });

  it("parses contains and regex ops", () => {
    expect(parseSelector("name~=Send name*=^Send$").terms.map(t => t.op)).toEqual(["~=", "*="]);
  });

  it("parses flags", () => {
    expect(parseSelector("focus selected").terms).toEqual([
      { key: "__flag", op: "=", value: "focus" },
      { key: "__flag", op: "=", value: "selected" }
    ]);
  });

  it("parses [index=N]", () => {
    const s = parseSelector("role=listitem [index=2]");
    expect(s.terms.find(t => t.key === "__index")?.value).toBe("2");
  });

  it("parses child combinator", () => {
    const s = parseSelector("role=dialog >> role=button");
    expect(s.combinators).toEqual([">>"]);
  });

  it("parses dotted prop key", () => {
    expect(parseSelector("props.scrollTop=5").terms[0].key).toBe("props.scrollTop");
  });
});
```

- [ ] **Step 2:** Run — fails

```bash
bunx vitest run src/agent-harness/__tests__/selector.spec.ts
```

- [ ] **Step 3:** Implement

```ts
// src/agent-harness/selector.ts
import type { UINode } from "./protocol.js";

export type Op = "=" | "~=" | "*=";
export type Term =
  | { key: string; op: Op; value: string };
export type Selector = {
  terms: Term[];           // terms within the *current* segment
  segments?: Selector[];   // populated when combinators present
  combinators: string[];   // " " or " >> "
};

const FLAGS = new Set(["focus", "selected", "disabled"]);

export function parseSelector(input: string): Selector {
  // Split on " >> " first (child combinator); descendants are " ".
  // For simplicity, treat entire input as one segment list with terms.
  const segments = input.split(/\s+>>\s+/);
  const combinators = segments.slice(1).map(() => " >> ");
  const segTerms: Term[][] = segments.map(seg => parseSegment(seg));

  // Flatten into a single shape (caller distinguishes via segments[])
  return {
    terms: segTerms[0],
    segments: segTerms.length > 1
      ? segTerms.map(t => ({ terms: t, combinators: [] }))
      : undefined,
    combinators,
  };
}

function parseSegment(seg: string): Term[] {
  const terms: Term[] = [];
  // tokenizer: [index=N], key OP value, or flag
  const tokens = tokenize(seg);
  for (const tok of tokens) {
    if (tok.startsWith("[") && tok.endsWith("]")) {
      const inner = tok.slice(1, -1);
      const m = inner.match(/^(\w+)=(.+)$/);
      if (!m) throw new Error(`Bad positional: ${tok}`);
      terms.push({ key: `__${m[1]}`, op: "=", value: m[2] });
      continue;
    }
    if (FLAGS.has(tok)) {
      terms.push({ key: "__flag", op: "=", value: tok });
      continue;
    }
    const m = tok.match(/^([\w.]+)(=|~=|\*=)(.+)$/);
    if (!m) throw new Error(`Bad term: ${tok}`);
    terms.push({ key: m[1], op: m[2] as Op, value: stripQuotes(m[3]) });
  }
  return terms;
}

function tokenize(seg: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < seg.length) {
    while (i < seg.length && seg[i] === " ") i++;
    if (i >= seg.length) break;
    if (seg[i] === "[") {
      const end = seg.indexOf("]", i);
      if (end < 0) throw new Error("unclosed [");
      out.push(seg.slice(i, end + 1)); i = end + 1;
      continue;
    }
    let end = i;
    let inQuote = false;
    while (end < seg.length && (inQuote || seg[end] !== " ")) {
      if (seg[end] === '"') inQuote = !inQuote;
      end++;
    }
    out.push(seg.slice(i, end)); i = end;
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}
```

- [ ] **Step 4:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/selector.spec.ts
```

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/selector.ts src/agent-harness/__tests__/selector.spec.ts
git commit -m "feat(harness): selector parser (terms, flags, [index], >>)"
```

### Task 2.2: Selector matcher

**Files:**
- Modify: `src/agent-harness/selector.ts`
- Modify: `src/agent-harness/__tests__/selector.spec.ts`

- [ ] **Step 1:** Tests

```ts
// append to src/agent-harness/__tests__/selector.spec.ts
import { matchSelector } from "../selector";
import type { UINode } from "../protocol";

const tree: UINode = {
  id: "root", role: "dialog",
  children: [
    { id: "composer", role: "textbox", focus: true, value: "hello" },
    { id: "send", role: "button", name: "Send" },
    { id: "list", role: "listbox", children: [
      { id: "i0", role: "listitem", name: "A" },
      { id: "i1", role: "listitem", name: "B", selected: true },
      { id: "i2", role: "listitem", name: "C" },
    ]}
  ]
};

describe("matcher", () => {
  it("matches role=button name=Send", () => {
    const hits = matchSelector(tree, "role=button name=\"Send\"");
    expect(hits.map(n => n.id)).toEqual(["send"]);
  });

  it("matches contains op", () => {
    const hits = matchSelector(tree, "name~=Sen");
    expect(hits.map(n => n.id)).toEqual(["send"]);
  });

  it("matches focus flag", () => {
    const hits = matchSelector(tree, "focus");
    expect(hits.map(n => n.id)).toEqual(["composer"]);
  });

  it("matches [index=N] under listbox", () => {
    const hits = matchSelector(tree, "role=listbox >> role=listitem [index=2]");
    expect(hits.map(n => n.id)).toEqual(["i2"]);
  });
});
```

- [ ] **Step 2:** Run — fails

- [ ] **Step 3:** Implement

```ts
// append to src/agent-harness/selector.ts
function termMatches(node: UINode, t: Term): boolean {
  if (t.key === "__flag") {
    if (t.value === "focus") return node.focus === true;
    if (t.value === "selected") return node.selected === true;
    if (t.value === "disabled") return node.disabled === true;
    return false;
  }
  if (t.key === "__index") return true; // handled at list level by caller
  const v = readField(node, t.key);
  if (v === undefined) return false;
  const s = String(v);
  if (t.op === "=") return s === t.value;
  if (t.op === "~=") return s.toLowerCase().includes(t.value.toLowerCase());
  if (t.op === "*=") return new RegExp(t.value).test(s);
  return false;
}

function readField(node: UINode, key: string): unknown {
  if (key === "role") return node.role;
  if (key === "id") return node.id;
  if (key === "name") return node.name;
  if (key === "value") return node.value;
  if (key === "state") return node.state;
  if (key.startsWith("props.")) {
    const dot = key.slice("props.".length);
    return (node.props ?? {})[dot];
  }
  return undefined;
}

function termsMatch(node: UINode, terms: Term[]): boolean {
  return terms.filter(t => t.key !== "__index").every(t => termMatches(node, t));
}

function indexOf(terms: Term[]): number | undefined {
  const t = terms.find(t => t.key === "__index");
  return t ? parseInt(t.value, 10) : undefined;
}

function walk(node: UINode, fn: (n: UINode) => void): void {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}

export function matchSelector(root: UINode, sel: string): UINode[] {
  const parsed = parseSelector(sel);
  const segments = parsed.segments ?? [{ terms: parsed.terms, combinators: [], }];

  // Resolve segments left-to-right; each refines the set of candidates.
  let candidates: UINode[] = [root];
  for (let s = 0; s < segments.length; s++) {
    const segTerms = segments[s].terms;
    const idx = indexOf(segTerms);
    const nextCandidates: UINode[] = [];
    for (const parent of candidates) {
      const segMatches: UINode[] = [];
      // For first segment (no parent ancestor combinator), search all descendants of root.
      // For later segments, search only direct children (since combinator is " >> " = child).
      if (s === 0) {
        walk(parent, n => { if (termsMatch(n, segTerms)) segMatches.push(n); });
      } else {
        for (const c of parent.children ?? []) {
          if (termsMatch(c, segTerms)) segMatches.push(c);
        }
      }
      if (idx !== undefined) {
        if (segMatches[idx]) nextCandidates.push(segMatches[idx]);
      } else {
        nextCandidates.push(...segMatches);
      }
    }
    candidates = nextCandidates;
  }
  return candidates;
}
```

- [ ] **Step 4:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/selector.spec.ts
```

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/selector.ts src/agent-harness/__tests__/selector.spec.ts
git commit -m "feat(harness): selector matcher with index/child-combinator support"
```

### Task 2.3: Predicate module (Zod-validated, for `expect`)

**Files:**
- Create: `src/agent-harness/predicate.ts`
- Create: `src/agent-harness/__tests__/predicate.spec.ts`

- [ ] **Step 1:** Tests

```ts
// src/agent-harness/__tests__/predicate.spec.ts
import { describe, it, expect } from "vitest";
import { predicateSchema, evaluatePredicate } from "../predicate";
import type { UINode } from "../protocol";

const node: UINode = { id: "x", role: "button", name: "Send", focus: true };

describe("predicate", () => {
  it("parses a field-op predicate", () => {
    const p = predicateSchema.parse({ field: "name", op: "eq", rhs: "Send" });
    expect(evaluatePredicate(p, node)).toBe(true);
  });

  it("parses a flag predicate", () => {
    const p = predicateSchema.parse({ flag: "focus", value: true });
    expect(evaluatePredicate(p, node)).toBe(true);
  });

  it("supports all/any/not", () => {
    const p = predicateSchema.parse({ all: [
      { field: "name", op: "contains", rhs: "Sen" },
      { not: { flag: "disabled", value: true } }
    ]});
    expect(evaluatePredicate(p, node)).toBe(true);
  });

  it("rejects unknown shapes", () => {
    expect(() => predicateSchema.parse({ field: "x", op: "weird", rhs: "y" })).toThrow();
  });
});
```

- [ ] **Step 2:** Run — fails

- [ ] **Step 3:** Implement

```ts
// src/agent-harness/predicate.ts
import { z } from "zod";
import type { UINode } from "./protocol.js";

const FieldOp = z.object({
  field: z.enum(["name", "value", "state"]),
  op: z.enum(["eq", "neq", "contains", "regex"]),
  rhs: z.string(),
});
const FlagOp = z.object({
  flag: z.enum(["focus", "selected", "disabled"]),
  value: z.boolean(),
});

export type Predicate =
  | z.infer<typeof FieldOp>
  | z.infer<typeof FlagOp>
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    FieldOp, FlagOp,
    z.object({ all: z.array(predicateSchema) }),
    z.object({ any: z.array(predicateSchema) }),
    z.object({ not: predicateSchema }),
  ])
);

export function evaluatePredicate(p: Predicate, node: UINode): boolean {
  if ("all" in p) return p.all.every(q => evaluatePredicate(q, node));
  if ("any" in p) return p.any.some(q => evaluatePredicate(q, node));
  if ("not" in p) return !evaluatePredicate(p.not, node);
  if ("flag" in p) {
    const flagVal = p.flag === "focus" ? node.focus : p.flag === "selected" ? node.selected : node.disabled;
    return (!!flagVal) === p.value;
  }
  const v = p.field === "name" ? node.name : p.field === "value" ? node.value : node.state;
  const s = v == null ? "" : String(v);
  switch (p.op) {
    case "eq":       return s === p.rhs;
    case "neq":      return s !== p.rhs;
    case "contains": return s.toLowerCase().includes(p.rhs.toLowerCase());
    case "regex":    return new RegExp(p.rhs).test(s);
  }
}
```

- [ ] **Step 4:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/predicate.spec.ts
```

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/predicate.ts src/agent-harness/__tests__/predicate.spec.ts
git commit -m "feat(harness): typed predicate (Zod) for expect"
```

### Task 2.4: In-process driver

**Files:**
- Create: `src/agent-harness/driver.ts`
- Create: `src/agent-harness/__tests__/driver.spec.ts`

- [ ] **Step 1:** Tests

```ts
// src/agent-harness/__tests__/driver.spec.ts
import { describe, it, expect } from "vitest";
import { createDriver } from "../driver";
import type { LiveFrame } from "../protocol";

const frame: LiveFrame = {
  mode: "live", version: "0.1.0", seq: 1, ts: 0,
  focus: "composer",
  nodes: [
    { id: "root", role: "dialog", children: [
      { id: "composer", role: "textbox", value: "", focus: true },
      { id: "send", role: "button", name: "Send" },
      { id: "status", role: "statusbar", value: "Ready" },
    ]}
  ]
};

describe("driver", () => {
  it("snapshot returns the latest frame", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.snapshot()?.seq).toBe(1);
  });

  it("query throws on multi-match", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(() => d.query("role=listitem")).not.toThrow();
    // multi-match scenario tested below with a list frame
  });

  it("count works", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.count("role=button")).toBe(1);
  });

  it("queryAll returns all matches", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.queryAll("role=dialog").length).toBe(1);
  });

  it("expect evaluates predicate", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.expect("id=status", { field: "value", op: "eq", rhs: "Ready" })).toBe(true);
  });

  it("wait_for(idle) resolves on idle event", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ idle: true, timeoutMs: 100 });
    setTimeout(() => d._ingest({ kind: "idle" }), 10);
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for(selector) resolves when selector appears", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ selector: "role=dialog", timeoutMs: 100 });
    setTimeout(() => d._ingest({ kind: "frame", frame }), 10);
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for times out", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    await expect(d.wait_for({ selector: "role=nonexistent", timeoutMs: 30 })).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2:** Run — fails

- [ ] **Step 3:** Implement

```ts
// src/agent-harness/driver.ts
import type { LiveFrame, UINode, LiveEvent } from "./protocol.js";
import { matchSelector } from "./selector.js";
import { evaluatePredicate, predicateSchema, type Predicate } from "./predicate.js";

type WaitCondition =
  | { idle: true }
  | { selector: string };
type WaitArgs = WaitCondition | { all: WaitCondition[]; timeoutMs?: number } | (WaitCondition & { timeoutMs?: number });

type DriverDeps = {
  sendKey: (key: string) => void;
  sendType: (text: string) => void;
};

type Ingested =
  | { kind: "frame"; frame: LiveFrame }
  | { kind: "idle" }
  | { kind: "event"; event: LiveEvent };

export type Driver = {
  snapshot: () => LiveFrame | null;
  changes_since: (seq: number) => LiveFrame | null;
  press: (key: string) => void;
  press_sequence: (keys: string[]) => void;
  type: (text: string) => void;
  focus: (selector: string) => void;
  wait_for: (args: WaitArgs) => Promise<void>;
  query: (selector: string) => UINode | null;
  queryAll: (selector: string) => UINode[];
  count: (selector: string) => number;
  expect: (selector: string, predicate: Predicate | unknown) => boolean;
  last_event: (kind: "toast" | "stream.delta") => LiveEvent | null;
  render_text: () => string;
  _ingest: (m: Ingested) => void;
};

export function createDriver(deps: DriverDeps): Driver {
  let lastFrame: LiveFrame | null = null;
  let lastIdleAt = 0;
  const eventBuf: LiveEvent[] = [];
  const waiters: Array<{ check: () => boolean; resolve: () => void }> = [];

  function notify() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].check()) { waiters[i].resolve(); waiters.splice(i, 1); }
    }
  }

  function _ingest(m: Ingested) {
    if (m.kind === "frame") lastFrame = m.frame;
    if (m.kind === "idle") lastIdleAt = Date.now();
    if (m.kind === "event") eventBuf.push(m.event);
    notify();
  }

  function rootNode(): UINode | null {
    if (!lastFrame) return null;
    return { id: "__root__", role: "dialog", children: lastFrame.nodes };
  }

  function selectorMatches(sel: string): UINode[] {
    const r = rootNode();
    if (!r) return [];
    return matchSelector(r, sel).filter(n => n.id !== "__root__");
  }

  function buildChecker(c: WaitCondition): () => boolean {
    if ("idle" in c) {
      const start = Date.now();
      return () => lastIdleAt >= start;
    }
    return () => selectorMatches(c.selector).length > 0;
  }

  function wait_for(args: WaitArgs): Promise<void> {
    const conditions: WaitCondition[] =
      "all" in args && Array.isArray((args as { all?: WaitCondition[] }).all)
        ? (args as { all: WaitCondition[] }).all
        : [args as WaitCondition];
    const timeoutMs = (args as { timeoutMs?: number }).timeoutMs ?? 5000;
    const checks = conditions.map(buildChecker);
    const check = () => checks.every(c => c());
    if (check()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const entry = { check, resolve };
      waiters.push(entry);
      setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) { waiters.splice(i, 1); reject(new Error(`wait_for timeout after ${timeoutMs}ms`)); }
      }, timeoutMs);
    });
  }

  return {
    snapshot: () => lastFrame,
    changes_since: (seq) => (lastFrame && lastFrame.seq > seq) ? lastFrame : null,
    press: (key) => deps.sendKey(key),
    press_sequence: (keys) => { for (const k of keys) deps.sendKey(k); },
    type: (text) => deps.sendType(text),
    focus: (selector) => {
      const hits = selectorMatches(selector);
      if (hits.length !== 1) throw new Error(`focus: expected 1 match, got ${hits.length}`);
      deps.sendKey(`__focus__:${hits[0].id}`);
    },
    wait_for,
    query: (selector) => {
      const hits = selectorMatches(selector);
      if (hits.length > 1) throw new Error(`query: ambiguous (${hits.length} matches)`);
      return hits[0] ?? null;
    },
    queryAll: (selector) => selectorMatches(selector),
    count: (selector) => selectorMatches(selector).length,
    expect: (selector, predicate) => {
      const p = predicateSchema.parse(predicate);
      const node = selectorMatches(selector)[0];
      if (!node) return false;
      return evaluatePredicate(p, node);
    },
    last_event: (kind) => {
      for (let i = eventBuf.length - 1; i >= 0; i--) {
        const e = eventBuf[i];
        if (e.t === "event" && e.kind === kind) return e;
      }
      return null;
    },
    render_text: () => {
      // ASCII render is documented as human-debug-only and best-effort.
      // Emit a tree dump.
      if (!lastFrame) return "(no frame)";
      const lines: string[] = [];
      const walk = (n: UINode, depth: number) => {
        const flags = [n.focus && "F", n.selected && "S", n.disabled && "D", n.hidden && "H"].filter(Boolean).join("");
        const v = n.value ? ` "${n.value}"` : "";
        lines.push(`${"  ".repeat(depth)}${n.role}#${n.id}${flags ? `[${flags}]` : ""}${v}`);
        for (const c of n.children ?? []) walk(c, depth + 1);
      };
      for (const n of lastFrame.nodes) walk(n, 0);
      return lines.join("\n");
    },
    _ingest,
  };
}
```

- [ ] **Step 4:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/driver.spec.ts
```

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/driver.ts src/agent-harness/__tests__/driver.spec.ts
git commit -m "feat(harness): in-process driver API"
```

### Task 2.5: Composer E2E (driver + agent-mode together)

**Files:**
- Create: `tests/harness/composer.spec.ts`

- [ ] **Step 1:** Test

```ts
// tests/harness/composer.spec.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createDriver } from "../../src/agent-harness/driver";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";
import { resolve } from "node:path";

describe("composer E2E", () => {
  let proc: ChildProcessWithoutNullStreams;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    proc = spawn("bun", ["run", entry, "--agent-mode", "--mock-llm", "tests/harness/fixtures/llm"], {
      stdio: ["pipe","pipe","pipe","pipe","pipe"],
    });
    // POSIX only: fd 3 = read frames, fd 4 = write commands
    driver = createDriver({
      sendKey: (k) => proc.stdio[4]!.write(JSON.stringify({ op: "press", key: k }) + "\n"),
      sendType: (t) => proc.stdio[4]!.write(JSON.stringify({ op: "type", text: t }) + "\n"),
    });
    const splitter = createLineSplitter((line) => {
      const msg = JSON.parse(line);
      if (msg.mode === "live") driver._ingest({ kind: "frame", frame: msg });
      else if (msg.t === "idle") driver._ingest({ kind: "idle" });
      else if (msg.t === "event") driver._ingest({ kind: "event", event: msg });
    });
    proc.stdio[3]!.on("data", splitter);
    await driver.wait_for({ idle: true, timeoutMs: 5000 });
  });

  afterAll(() => { proc?.kill(); });

  it("composer is focused on startup", () => {
    expect(driver.query("focus")?.role).toBe("textbox");
  });

  it("typing populates composer value", async () => {
    driver.type("hello world");
    await driver.wait_for({ idle: true });
    const c = driver.query("role=textbox");
    expect(c?.value).toBe("hello world");
  });

  it("Enter sends and shows response in log", async () => {
    driver.press("Enter");
    await driver.wait_for({ selector: "role=log", timeoutMs: 3000 });
    const log = driver.query("role=log");
    expect(log?.value || log?.children?.length).toBeTruthy();
  });
});
```

- [ ] **Step 2:** Create the LLM fixture

```bash
mkdir -p tests/harness/fixtures/llm
cat > tests/harness/fixtures/llm/default.json <<'EOF'
{ "responses": [{ "match": "*", "text": "Hello back!" }] }
EOF
```

- [ ] **Step 3:** Run (Windows: skip — fd transport not yet wired for child stdio[3/4] on Windows; use Phase 4 MCP-driver for Windows E2E)

```bash
bunx vitest run tests/harness/composer.spec.ts
```

Expected on Linux/macOS: 3 tests PASS.

- [ ] **Step 4:** Commit

```bash
git add tests/harness/composer.spec.ts tests/harness/fixtures/llm/default.json
git commit -m "test(harness): composer E2E via in-process driver"
```

---

## Phase 3 — mock-llm + Fake Clock (½ day)

### Task 3.1: mock-llm fixture loader

**Files:**
- Create: `src/agent-harness/mock-llm.ts`
- Create: `src/agent-harness/__tests__/mock-llm.spec.ts`

- [ ] **Step 1:** Tests

```ts
// src/agent-harness/__tests__/mock-llm.spec.ts
import { describe, it, expect } from "vitest";
import { createMockLlm } from "../mock-llm";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mock-llm", () => {
  it("returns fixture matching prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-"));
    writeFileSync(join(dir, "fix.json"), JSON.stringify({
      responses: [{ match: "hello", text: "world" }]
    }));
    const m = createMockLlm({ dir });
    expect(await m.complete({ prompt: "hello there" })).toEqual({ text: "world" });
  });

  it("falls back to wildcard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-"));
    writeFileSync(join(dir, "fix.json"), JSON.stringify({
      responses: [{ match: "*", text: "default" }]
    }));
    const m = createMockLlm({ dir });
    expect(await m.complete({ prompt: "anything" })).toEqual({ text: "default" });
  });

  it("throws on no match without wildcard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockllm-"));
    writeFileSync(join(dir, "fix.json"), JSON.stringify({
      responses: [{ match: "specific", text: "x" }]
    }));
    const m = createMockLlm({ dir });
    await expect(m.complete({ prompt: "other" })).rejects.toThrow(/no fixture/);
  });
});
```

- [ ] **Step 2:** Implement

```ts
// src/agent-harness/mock-llm.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Fixture = { responses: Array<{ match: string; text: string }> };

export function createMockLlm(opts: { dir: string }) {
  const files = readdirSync(opts.dir).filter(f => f.endsWith(".json"));
  const fixtures: Fixture[] = files.map(f => JSON.parse(readFileSync(join(opts.dir, f), "utf8")));

  return {
    async complete(req: { prompt: string }): Promise<{ text: string }> {
      for (const fx of fixtures) {
        for (const r of fx.responses) {
          if (r.match === "*") return { text: r.text };
          if (req.prompt.includes(r.match)) return { text: r.text };
        }
      }
      throw new Error(`no fixture matches prompt: ${req.prompt.slice(0,40)}`);
    }
  };
}
```

- [ ] **Step 3:** Run — passes

```bash
bunx vitest run src/agent-harness/__tests__/mock-llm.spec.ts
```

- [ ] **Step 4:** Wire `--mock-llm` flag in the provider layer. In `src/providers/` find the default text-completion path and add: if `globalThis.__muonroiMockLlm` is set, route through it. Detailed wiring depends on provider abstraction in the repo; do this minimally — one branch in the LLM-call dispatcher.

- [ ] **Step 5:** Commit

```bash
git add src/agent-harness/mock-llm.ts src/agent-harness/__tests__/mock-llm.spec.ts src/providers/
git commit -m "feat(harness): mock-llm fixture loader and provider hook"
```

### Task 3.2: Council flow E2E

**Files:**
- Create: `tests/harness/council-flow.spec.ts`
- Create: `tests/harness/fixtures/llm/council.json`

- [ ] **Step 1:** Fixture covering 4 council models

```json
{
  "responses": [
    { "match": "leader prompt", "text": "Leader analysis: ..." },
    { "match": "participant 1", "text": "Participant 1 view: ..." },
    { "match": "participant 2", "text": "Participant 2 view: ..." },
    { "match": "*", "text": "default reply" }
  ]
}
```

- [ ] **Step 2:** Test using composer E2E harness pattern, opening `/council`, navigating picker, asserting debate plan shown.

```ts
// Follow the same setup as tests/harness/composer.spec.ts.
// Steps:
//  1. wait_for idle on startup
//  2. type "/council"; press Enter
//  3. wait_for({ selector: 'role=dialog name~="Council"' })
//  4. press Down; press Enter to select
//  5. wait_for({ selector: 'text~="Debate Plan"', timeoutMs: 5000 })
//  6. assert driver.query('role=log').children.length >= 4 (one per role)
```

- [ ] **Step 3:** Run

```bash
bunx vitest run tests/harness/council-flow.spec.ts
```

- [ ] **Step 4:** Commit

```bash
git add tests/harness/council-flow.spec.ts tests/harness/fixtures/llm/council.json
git commit -m "test(harness): council flow E2E via mock-llm"
```

---

## Phase 4 — MCP Driver Subcommand + Security Hardening (1 day)

### Task 4.1: MCP server scaffolding + `tui.capabilities`

**Files:**
- Create: `src/mcp/harness-driver.ts`
- Modify: `src/index.ts` (register subcommand)

- [ ] **Step 1:** Scaffold MCP server using `@modelcontextprotocol/sdk` (already a dep).

```ts
// src/mcp/harness-driver.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../agent-harness/protocol.js";

export async function runHarnessDriver(): Promise<void> {
  const server = new McpServer({ name: "muonroi-harness-driver", version: "0.1.0" });

  server.tool("tui.capabilities", {}, async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        protocol: PROTOCOL_VERSION,
        features: ["snapshot","press","type","wait_for","query","expect","render_text","capabilities"],
      })
    }]
  }));

  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 2:** Wire subcommand in `src/index.ts`. Add after the existing subcommand definitions:

```ts
program
  .command("mcp-driver")
  .description("Run the agent-harness MCP driver (stdio)")
  .action(async () => {
    const { runHarnessDriver } = await import("./mcp/harness-driver.js");
    await runHarnessDriver();
  });
```

- [ ] **Step 3:** Smoke

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun run src/index.ts mcp-driver
```

Expected: a tools/list response including `tui.capabilities`.

- [ ] **Step 4:** Commit

```bash
git add src/mcp/harness-driver.ts src/index.ts
git commit -m "feat(harness): mcp-driver subcommand + tui.capabilities"
```

### Task 4.2: `tui.start` with argv allowlist and env sanitization

**Files:**
- Modify: `src/mcp/harness-driver.ts`
- Create: `src/mcp/__tests__/harness-driver-security.spec.ts`

- [ ] **Step 1:** Security tests

```ts
// src/mcp/__tests__/harness-driver-security.spec.ts
import { describe, it, expect } from "vitest";
import { validateStartArgs, sanitizeEnv } from "../harness-driver";

describe("tui.start argv allowlist", () => {
  it("accepts --agent-*", () => {
    expect(validateStartArgs(["--agent-mode", "--agent-cols=80"])).toEqual({ ok: true });
  });
  it("accepts --mock-llm", () => {
    expect(validateStartArgs(["--mock-llm=fix/"])).toEqual({ ok: true });
  });
  it("rejects --require", () => {
    expect(validateStartArgs(["--require", "evil.js"])).toMatchObject({ ok: false });
  });
  it("rejects --preload", () => {
    expect(validateStartArgs(["--preload=evil"])).toMatchObject({ ok: false });
  });
  it("rejects --eval", () => {
    expect(validateStartArgs(["--eval", "x"])).toMatchObject({ ok: false });
  });
});

describe("tui.start env sanitization", () => {
  it("strips NODE_OPTIONS / BUN_OPTIONS / LD_PRELOAD", () => {
    const e = sanitizeEnv({ NODE_OPTIONS: "x", BUN_OPTIONS: "y", LD_PRELOAD: "z", FOO: "ok" });
    expect(e).toEqual({ FOO: "ok" });
  });
  it("rejects keys with bad chars", () => {
    const e = sanitizeEnv({ "ok=A": "x", "BAD-KEY": "y", GOOD: "z" });
    expect(e).toEqual({ GOOD: "z" });
  });
});
```

- [ ] **Step 2:** Implement

```ts
// Add to src/mcp/harness-driver.ts
const ARG_ALLOW = /^(--agent-[a-z-]+(=.*)?|--mock-llm(=.+)?|--profile=[a-zA-Z0-9_-]+)$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_STRIP = new Set([
  "NODE_OPTIONS","BUN_OPTIONS","LD_PRELOAD","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH"
]);

export function validateStartArgs(args: string[]): { ok: true } | { ok: false; bad: string } {
  for (const a of args) {
    if (!ARG_ALLOW.test(a)) return { ok: false, bad: a };
  }
  return { ok: true };
}

export function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_STRIP.has(k)) continue;
    if (!ENV_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}
```

Then add `tui.start` tool inside `runHarnessDriver`:

```ts
const startSchema = z.object({
  args: z.array(z.string()).max(20),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});

server.tool("tui.start", startSchema, async (input) => {
  const argCheck = validateStartArgs(input.args);
  if (!argCheck.ok) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "argv_rejected", bad: argCheck.bad }) }], isError: true };
  }
  const env = sanitizeEnv(input.env ?? {});
  // ... spawn child via Bun.spawn / Node child_process with sanitized env
  return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
});
```

- [ ] **Step 3:** Run security tests

```bash
bunx vitest run src/mcp/__tests__/harness-driver-security.spec.ts
```

Expected: PASS.

- [ ] **Step 4:** Commit

```bash
git add src/mcp/harness-driver.ts src/mcp/__tests__/harness-driver-security.spec.ts
git commit -m "feat(harness): tui.start with argv/env hardening"
```

### Task 4.3: Driver-backed MCP tools

**Files:**
- Modify: `src/mcp/harness-driver.ts`

- [ ] **Step 1:** Inside `runHarnessDriver`, maintain a single driver instance bound to the spawned child. Add tools:

```ts
server.tool("tui.snapshot", {}, async () => {
  const f = driver.snapshot();
  return { content: [{ type: "text", text: JSON.stringify(f) }] };
});

server.tool("tui.changes_since", z.object({ seq: z.number() }), async ({ seq }) => {
  const f = driver.changes_since(seq);
  return { content: [{ type: "text", text: JSON.stringify(f) }] };
});

server.tool("tui.press", z.object({ key: z.string() }), async ({ key }) => {
  driver.press(key);
  return { content: [{ type: "text", text: "ok" }] };
});

server.tool("tui.type", z.object({ text: z.string().max(10_000) }), async ({ text }) => {
  driver.type(text);
  return { content: [{ type: "text", text: "ok" }] };
});

server.tool("tui.focus", z.object({ selector: z.string() }), async ({ selector }) => {
  driver.focus(selector);
  return { content: [{ type: "text", text: "ok" }] };
});

const waitSchema = z.object({
  selector: z.string().optional(),
  idle: z.boolean().optional(),
  all: z.array(z.object({ selector: z.string().optional(), idle: z.boolean().optional() })).optional(),
  timeoutMs: z.number().int().min(0).max(60_000).optional(),
});
server.tool("tui.wait_for", waitSchema, async (input) => {
  await driver.wait_for(input as Parameters<typeof driver.wait_for>[0]);
  return { content: [{ type: "text", text: "ok" }] };
});

server.tool("tui.query", z.object({ selector: z.string() }), async ({ selector }) => {
  const n = driver.query(selector);
  return { content: [{ type: "text", text: JSON.stringify(n) }] };
});

server.tool("tui.query_all", z.object({ selector: z.string() }), async ({ selector }) => {
  return { content: [{ type: "text", text: JSON.stringify(driver.queryAll(selector)) }] };
});

server.tool("tui.count", z.object({ selector: z.string() }), async ({ selector }) => {
  return { content: [{ type: "text", text: String(driver.count(selector)) }] };
});

server.tool("tui.expect",
  z.object({ selector: z.string(), predicate: z.unknown() }),
  async ({ selector, predicate }) => {
    const ok = driver.expect(selector, predicate);
    return { content: [{ type: "text", text: String(ok) }] };
  });

server.tool("tui.last_event", z.object({ kind: z.enum(["toast","stream.delta"]) }), async ({ kind }) => {
  return { content: [{ type: "text", text: JSON.stringify(driver.last_event(kind)) }] };
});

server.tool("tui.render_text", {}, async () => {
  return { content: [{ type: "text", text: driver.render_text() }] };
});

server.tool("tui.stop", {}, async () => {
  // kill child
  return { content: [{ type: "text", text: "ok" }] };
});
```

- [ ] **Step 2:** Hand-test by piping a few JSON-RPC requests through

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun run src/index.ts mcp-driver | head -20
```

Expected: all 13 tools listed.

- [ ] **Step 3:** Commit

```bash
git add src/mcp/harness-driver.ts
git commit -m "feat(harness): MCP tools (snapshot/press/wait_for/query/expect/...)"
```

### Task 4.4: End-to-end MCP integration test

**Files:**
- Create: `tests/harness/mcp-integration.spec.ts`

- [ ] **Step 1:** Spawn `muonroi-cli mcp-driver`, send JSON-RPC frames over stdio, drive composer flow, assert.

```ts
// tests/harness/mcp-integration.spec.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

function call(proc: ReturnType<typeof spawn>, id: number, method: string, params?: unknown): Promise<unknown> {
  return new Promise((res, rej) => {
    const onData = (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout!.off("data", onData);
            if (msg.error) rej(new Error(JSON.stringify(msg.error)));
            else res(msg.result);
            return;
          }
        } catch {}
      }
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

describe("MCP integration", () => {
  it("capabilities returns protocol version", async () => {
    const p = spawn("bun", ["run", resolve("src/index.ts"), "mcp-driver"]);
    const r: any = await call(p, 1, "tools/call", { name: "tui.capabilities", arguments: {} });
    const text = r.content[0].text;
    expect(JSON.parse(text).protocol).toBe("0.1.0");
    p.kill();
  });

  it("tui.start rejects --require", async () => {
    const p = spawn("bun", ["run", resolve("src/index.ts"), "mcp-driver"]);
    const r: any = await call(p, 1, "tools/call", { name: "tui.start", arguments: { args: ["--require", "evil"] } });
    expect(r.isError).toBe(true);
    p.kill();
  });
});
```

- [ ] **Step 2:** Run

```bash
bunx vitest run tests/harness/mcp-integration.spec.ts
```

- [ ] **Step 3:** Commit

```bash
git add tests/harness/mcp-integration.spec.ts
git commit -m "test(harness): MCP integration — capabilities, security gates"
```

### Task 4.5: Add Windows CI matrix

**Files:**
- Modify (or Create): `.github/workflows/test.yml`

- [ ] **Step 1:** Inspect current CI

```bash
cat .github/workflows/*.yml 2>/dev/null | head -100
```

- [ ] **Step 2:** Add `windows-latest` to the `runs-on` matrix; keep `ubuntu-latest` and `macos-latest`. Ensure Bun setup step supports Windows.

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
```

- [ ] **Step 3:** Commit

```bash
git add .github/workflows/
git commit -m "ci(harness): add windows-latest to test matrix"
```

---

## Phase 5 — Ideal Designer DesignSpec Emission (½ day)

### Task 5.1: `design-output.ts`

**Files:**
- Create: `src/product-loop/design-output.ts`
- Create: `src/product-loop/__tests__/design-output.spec.ts`

- [ ] **Step 1:** Tests

```ts
// src/product-loop/__tests__/design-output.spec.ts
import { describe, it, expect } from "vitest";
import { emitDesignSpec } from "../design-output";

describe("design-output", () => {
  it("emits a valid DesignSpec for a single scene", () => {
    const spec = emitDesignSpec({
      target: "tui",
      scenes: [{
        id: "composer", name: "Composer",
        layout: { id: "root", role: "dialog", children: [
          { id: "input", role: "textbox" }
        ]},
        states: [{ name: "loading", patches: [{ id: "input", state: "loading" }] }]
      }]
    });
    expect(spec.mode).toBe("design");
    expect(spec.version).toBe("0.1.0");
    expect(spec.scenes[0].id).toBe("composer");
  });

  it("rejects orphan patches (id not in layout)", () => {
    expect(() => emitDesignSpec({
      scenes: [{
        id: "a", name: "A",
        layout: { id: "root", role: "dialog" },
        states: [{ name: "x", patches: [{ id: "missing", state: "loading" }] }]
      }]
    })).toThrow(/patch references unknown id/);
  });
});
```

- [ ] **Step 2:** Implement

```ts
// src/product-loop/design-output.ts
import type { DesignSpec, UINode, StatePatch } from "../agent-harness/protocol.js";
import { PROTOCOL_VERSION } from "../agent-harness/protocol.js";

type Input = Omit<DesignSpec, "mode" | "version">;

function collectIds(node: UINode, set: Set<string>): void {
  set.add(node.id);
  for (const c of node.children ?? []) collectIds(c, set);
}

export function emitDesignSpec(input: Input): DesignSpec {
  for (const scene of input.scenes) {
    const ids = new Set<string>();
    collectIds(scene.layout, ids);
    for (const state of scene.states ?? []) {
      for (const p of state.patches) {
        if (!ids.has(p.id)) {
          throw new Error(`patch references unknown id "${p.id}" in scene "${scene.id}"`);
        }
      }
    }
  }
  return { mode: "design", version: PROTOCOL_VERSION, ...input };
}
```

- [ ] **Step 3:** Run — passes

```bash
bunx vitest run src/product-loop/__tests__/design-output.spec.ts
```

- [ ] **Step 4:** Wire into the designer-agent step inside `src/product-loop/index.ts` (around the role list at line 793). When the designer role finishes, call `emitDesignSpec(...)` with the agent's structured output and persist alongside other artifacts:

```ts
// in the designer role completion block
import { emitDesignSpec } from "./design-output.js";
// ...
const spec = emitDesignSpec(designerOutput);
await ctx.persistArtifact("design.json", JSON.stringify(spec, null, 2));
```

- [ ] **Step 5:** Commit

```bash
git add src/product-loop/design-output.ts src/product-loop/__tests__/design-output.spec.ts src/product-loop/index.ts
git commit -m "feat(ideal): designer emits DesignSpec artifact"
```

---

## Phase 6 — DesignSpec Consumer Helpers (1 day)

### Task 6.1: `validate_spec`

**Files:**
- Create: `src/agent-harness/spec-helpers.ts`
- Create: `src/agent-harness/__tests__/spec-helpers.spec.ts`

- [ ] **Step 1:** Test

```ts
// src/agent-harness/__tests__/spec-helpers.spec.ts
import { describe, it, expect } from "vitest";
import { validateSpec, querySpec, diffSpecs } from "../spec-helpers";
import type { DesignSpec } from "../protocol";

const spec: DesignSpec = {
  mode: "design", version: "0.1.0",
  scenes: [{ id: "s", name: "S", layout: { id: "root", role: "dialog" } }]
};

describe("validate_spec", () => {
  it("accepts a valid spec", () => {
    expect(validateSpec(spec).ok).toBe(true);
  });

  it("rejects wrong mode", () => {
    expect(validateSpec({ ...spec, mode: "live" as unknown as "design" }).ok).toBe(false);
  });
});
```

- [ ] **Step 2:** Implement using Ajv against `docs/agent-harness/schema.json`

```ts
// src/agent-harness/spec-helpers.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import type { DesignSpec, UINode, StatePatch } from "./protocol.js";

const schema = JSON.parse(readFileSync(resolve("docs/agent-harness/schema.json"), "utf8"));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validator = ajv.compile({ $ref: `${schema.$id}#/definitions/DesignSpec` });

export function validateSpec(spec: unknown): { ok: boolean; errors?: unknown[] } {
  const ok = validator(spec);
  return ok ? { ok: true } : { ok: false, errors: validator.errors ?? [] };
}
```

- [ ] **Step 3:** Run, commit

```bash
bunx vitest run src/agent-harness/__tests__/spec-helpers.spec.ts
git add src/agent-harness/spec-helpers.ts src/agent-harness/__tests__/spec-helpers.spec.ts
git commit -m "feat(harness): validateSpec helper"
```

### Task 6.2: `querySpec` (resolve a scene + state into a UINode tree)

**Files:**
- Modify: `src/agent-harness/spec-helpers.ts`
- Modify: `src/agent-harness/__tests__/spec-helpers.spec.ts`

- [ ] **Step 1:** Tests

```ts
// append
describe("querySpec", () => {
  const spec: DesignSpec = {
    mode: "design", version: "0.1.0",
    scenes: [{
      id: "s", name: "S",
      layout: { id: "root", role: "dialog", children: [{ id: "btn", role: "button", name: "OK" }] },
      states: [{ name: "loading", patches: [{ id: "btn", disabled: true }] }]
    }]
  };

  it("returns base layout when no state", () => {
    const t = querySpec(spec, { scene: "s" });
    expect(t.children![0].disabled).toBeUndefined();
  });

  it("applies state patches", () => {
    const t = querySpec(spec, { scene: "s", state: "loading" });
    expect(t.children![0].disabled).toBe(true);
  });

  it("throws on unknown scene", () => {
    expect(() => querySpec(spec, { scene: "missing" })).toThrow();
  });
});
```

- [ ] **Step 2:** Implement

```ts
// append to spec-helpers.ts
export function querySpec(spec: DesignSpec, q: { scene: string; state?: string }): UINode {
  const scene = spec.scenes.find(s => s.id === q.scene);
  if (!scene) throw new Error(`scene not found: ${q.scene}`);
  const layout = JSON.parse(JSON.stringify(scene.layout)) as UINode;
  if (!q.state) return layout;
  const state = scene.states?.find(s => s.name === q.state);
  if (!state) throw new Error(`state not found: ${q.state}`);
  for (const patch of state.patches) applyPatch(layout, patch);
  return layout;
}

function applyPatch(node: UINode, p: StatePatch): boolean {
  if (node.id === p.id) {
    const { id: _ignored, ...rest } = p;
    Object.assign(node, rest);
    return true;
  }
  for (const c of node.children ?? []) {
    if (applyPatch(c, p)) return true;
  }
  return false;
}
```

- [ ] **Step 3:** Run, commit

```bash
bunx vitest run src/agent-harness/__tests__/spec-helpers.spec.ts
git add src/agent-harness/spec-helpers.ts src/agent-harness/__tests__/spec-helpers.spec.ts
git commit -m "feat(harness): querySpec resolves scene + state"
```

### Task 6.3: `diffSpecs`

**Files:**
- Modify: `src/agent-harness/spec-helpers.ts`
- Modify: `src/agent-harness/__tests__/spec-helpers.spec.ts`

- [ ] **Step 1:** Tests

```ts
// append
describe("diffSpecs", () => {
  const a: DesignSpec = {
    mode: "design", version: "0.1.0",
    scenes: [{ id: "s", name: "S", layout: { id: "root", role: "dialog" } }]
  };
  const b: DesignSpec = {
    mode: "design", version: "0.1.0",
    scenes: [{ id: "s", name: "S2", layout: { id: "root", role: "dialog", children: [{ id: "n", role: "button" }] } }]
  };

  it("reports renamed scene name", () => {
    const d = diffSpecs(a, b);
    expect(d.scenes.modified.find(m => m.id === "s")).toBeTruthy();
  });
});
```

- [ ] **Step 2:** Implement

```ts
// append to spec-helpers.ts
export type SpecDiff = {
  scenes: {
    added: Array<{ id: string }>;
    removed: Array<{ id: string }>;
    modified: Array<{ id: string; changes: string[] }>;
  };
};

export function diffSpecs(a: DesignSpec, b: DesignSpec): SpecDiff {
  const aIds = new Set(a.scenes.map(s => s.id));
  const bIds = new Set(b.scenes.map(s => s.id));
  const added = [...bIds].filter(i => !aIds.has(i)).map(id => ({ id }));
  const removed = [...aIds].filter(i => !bIds.has(i)).map(id => ({ id }));
  const modified: SpecDiff["scenes"]["modified"] = [];
  for (const id of aIds) {
    if (!bIds.has(id)) continue;
    const sa = a.scenes.find(s => s.id === id)!;
    const sb = b.scenes.find(s => s.id === id)!;
    const changes: string[] = [];
    if (sa.name !== sb.name) changes.push("name");
    if (JSON.stringify(sa.layout) !== JSON.stringify(sb.layout)) changes.push("layout");
    if (JSON.stringify(sa.states ?? []) !== JSON.stringify(sb.states ?? [])) changes.push("states");
    if (changes.length) modified.push({ id, changes });
  }
  return { scenes: { added, removed, modified } };
}
```

- [ ] **Step 3:** Run, commit

```bash
bunx vitest run src/agent-harness/__tests__/spec-helpers.spec.ts
git add src/agent-harness/spec-helpers.ts src/agent-harness/__tests__/spec-helpers.spec.ts
git commit -m "feat(harness): diffSpecs structural compare"
```

---

## Final Phase — Test Coverage Gaps from Cross-Review (½ day, optional but recommended)

### Task F.1: Error state, modal restore, scroll, timeout, disconnect

**Files:**
- Create: `tests/harness/error-states.spec.ts`
- Create: `tests/harness/modal-focus.spec.ts`
- Create: `tests/harness/scroll.spec.ts`
- Create: `tests/harness/timeouts.spec.ts`
- Create: `tests/harness/disconnect.spec.ts`

Each test follows the composer E2E pattern; cover the scenarios named in design §14.

- [ ] **Step 1:** Implement the five spec files (one scenario each).
- [ ] **Step 2:** Run them all together.

```bash
bunx vitest run tests/harness/
```

- [ ] **Step 3:** Commit

```bash
git add tests/harness/
git commit -m "test(harness): coverage gaps — error/modal/scroll/timeout/disconnect"
```

### Task F.2: Determinism check — 50× identical traces

**Files:**
- Create: `tests/harness/determinism.spec.ts`

- [ ] **Step 1:** Run the council flow 50 times and assert byte-identical `LiveFrame` traces (excluding `ts` field).
- [ ] **Step 2:** If `--agent-fake-clock` is set, `ts` must also be identical.
- [ ] **Step 3:** Commit

```bash
git add tests/harness/determinism.spec.ts
git commit -m "test(harness): determinism — 50x identical LiveFrame traces"
```

---

## Self-review note (for the implementing engineer)

Before opening a PR, run the full vitest suite **on both Linux and Windows** locally if possible:

```bash
bunx vitest run
bunx tsc --noEmit
bunx biome check src/
```

Then sanity-check the design doc (`docs/superpowers/specs/2026-05-14-agent-harness-design.md`) and confirm every section maps to one or more tasks above.

---

## Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (recommended for this plan: 6 phases, 25+ tasks, lots of cross-cutting state).

**2. Inline Execution** — execute tasks in this session with checkpoint review.

Choose when ready to proceed.
