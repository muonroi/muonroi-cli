# Agent Harness Protocol

**Version:** 0.1.0-experimental  
**Date:** 2026-05-14

## 1. Overview

The Agent Harness Protocol defines a stable, documented interface for external agent CLIs (Claude CLI, Codex, Gemini, etc.) to drive muonroi-cli's TUI as a real user. The protocol is transport-independent and reuses a single schema across two modes:

- **Live mode** (`LiveFrame`, `LiveEvent`): runtime UI state and events from a running TUI application
- **Design mode** (`DesignSpec`): structural UI layout, states, and transitions defined by designers or QA agents

## 2. Schema: Core Types

### 2.1 Role Enumeration

The following role values are fixed at this protocol version. Additions require a spec bump to 0.2.0.

```typescript
type Role =
  | "dialog" | "textbox" | "listbox" | "listitem"
  | "button" | "checkbox" | "radio" | "radiogroup"
  | "tab" | "tablist" | "tree" | "treeitem"
  | "table" | "row" | "cell"
  | "progressbar" | "spinner"
  | "log" | "statusbar" | "menu" | "menuitem" | "toast" | "tooltip";
```

### 2.2 UINode

A `UINode` represents a single element in the UI tree. Each node is stable within a session (same `id` across renders) and optionally carries semantic flags and opaque properties.

```typescript
type UINode = {
  id: string;              // stable within session; must be deterministic (not render-index based)
  role: Role;              // semantic role from the fixed vocabulary
  name?: string;           // human-readable label (e.g., button text, dialog title)
  value?: string;          // textbox content, OR id of selected child (for listbox, radiogroup, tablist)
  focus?: true;            // present if this node has keyboard focus
  selected?: true;         // present if this node is selected (e.g., in a listbox)
  disabled?: true;         // present if this node is disabled
  hidden?: true;           // present if this node is hidden from view
  state?: string;          // semantic flag: "loading" | "error" | custom string
  props?: Record<string, unknown>;  // consumer-opaque extra data (e.g., { pct: 72, scrollTop: 50 })
  children?: UINode[];     // child nodes in tree order
};
```

**Rules:**
- `id` must remain the same for a logical node across renders. Components must derive `id` from a deterministic key (not a render index).
- For container roles (`listbox`, `radiogroup`, `tablist`), `value` carries the **id** of the selected child, sparing consumers a tree walk.
- Boolean flags (`focus`, `selected`, `disabled`, `hidden`) are present (with value `true`) if set, and omitted otherwise.
- `props` is opaque to selector matching by default; matched only via `props.<key>=...` syntax in selectors.
- Role vocabulary is fixed at this version.

### 2.3 LiveFrame

A snapshot of the UI tree at a given moment during a live session.

```typescript
type LiveFrame = {
  mode: "live";
  version: "0.1.0";
  seq: number;             // monotonic sequence number; increments on every frame
  ts: number;              // UNIX timestamp (ms)
  focus?: string;          // id of the currently focused node
  modals?: string[];       // ordered modal stack: [bottom, ..., top]; top is active
  nodes: UINode[];         // root nodes of the UI tree
};
```

**Rules:**
- `seq` must strictly increase with each frame. Consumers can detect dropped frames by gaps in `seq`.
- Modal stack supports nesting (e.g., `["settings", "confirm-delete"]` = confirm dialog on top of settings).
- If `focus` is set, it must point to an `id` that exists in the tree.

### 2.4 LiveEvent

Ephemeral events that occur during a session (separate from frame snapshots).

```typescript
type LiveEvent =
  | { t: "event"; kind: "stream.delta"; target: string; text: string }
  | { t: "event"; kind: "toast"; level: "info" | "warn" | "error"; text: string; ttlMs?: number }
  | { t: "idle" };
```

**Semantics:**
- `stream.delta`: A chunk of text arrived for a node (typically an LLM response being streamed). `target` is the node id, `text` is the new content chunk.
- `toast`: A transient notification appeared. `level` indicates severity. `ttlMs` is the time-to-live in milliseconds; omit for indefinite.
- `idle`: The UI has reached a stable state with no pending renders or timers. Consumers may use this to detect when the TUI is ready for the next interaction.

## 3. Schema: Design Mode

### 3.1 StatePatch

A partial update to a node's properties (all fields except `children`).

```typescript
type StatePatch = { id: string } & Partial<Omit<UINode, "children" | "id">>;
```

**Constraints:**
- Must have `id` to identify which node to patch.
- Must NOT contain `children` — if a state requires different children, define a separate scene.

### 3.2 DesignSpec

A structural description of UI layouts, possible states, and transitions (used by designers and QA agents).

```typescript
type DesignSpec = {
  mode: "design";
  version: "0.1.0";
  target?: "tui" | "react" | "angular" | "any";  // optional platform hint
  scenes: Array<{
    id: string;                                    // unique scene identifier
    name: string;                                  // human-readable title
    layout: UINode;                                // base layout tree
    states?: Array<{
      name: string;                                // e.g., "loading", "error"
      patches: StatePatch[];                       // modifications to apply
    }>;
    transitions?: Array<{
      from: string;                                // source state id
      on: string;                                  // trigger (e.g., "select", "submit")
      to: string;                                  // target state id
    }>;
    notes?: string;                                // optional designer notes
  }>;
};
```

## 4. StatePatch Resolution Algorithm

When applying a state to a layout, follow these three steps in order:

1. **Locate:** For each `StatePatch`, find the node in `scene.layout` by `id`. If the node does not exist, raise a validation error with the patch id.
2. **Merge:** Shallow-merge all non-`children` fields from the patch onto the located node.
3. **Constraint:** `children` are never patched indirectly. If a state transition requires different children, declare them in a separate scene.

**Example:**

```json
{
  "scenes": [{
    "id": "composer", "name": "Composer",
    "layout": {
      "id": "root", "role": "dialog", "children": [
        { "id": "input", "role": "textbox", "value": "" }
      ]
    },
    "states": [{
      "name": "sending",
      "patches": [{ "id": "input", "disabled": true, "state": "loading" }]
    }]
  }]
}
```

Applying the "sending" state to the composer layout produces:

```json
{
  "id": "root", "role": "dialog", "children": [
    { "id": "input", "role": "textbox", "value": "", "disabled": true, "state": "loading" }
  ]
}
```

## 5. Selector Grammar

Selectors identify nodes in the tree. They are used by driver APIs like `wait_for(selector)`, `query(selector)`, and `expect(selector, predicate)`.

### 5.1 Syntax

```
selector  := term (combinator term)*
combinator:= ' '     (descendant)
           | ' >> '  (direct child)
term      := key op value | flag | '[' positional ']'
key       := role | name | id | state | text | props.<dotpath>
op        := '='     (exact match)
           | '~='    (contains, case-insensitive)
           | '*='    (regex match)
flag      := focus | selected | disabled
positional:= 'index=' N
value     := bareword | "quoted string"
```

### 5.2 Worked Examples

1. **Simple button match by name:**
   ```
   role=button name="Send"
   ```
   Matches a button with exact name "Send".

2. **Case-insensitive text search:**
   ```
   role=button name~="send"
   ```
   Matches a button with name containing "send" (case-insensitive).

3. **Listbox with modal nesting:**
   ```
   role=listbox name="Council picker" >> role=listitem [index=2]
   ```
   Matches the 3rd direct child (index 2) of a listbox named "Council picker".

4. **Regex pattern on custom prop:**
   ```
   role=statusbar props.level*=^(warn|error)$
   ```
   Matches a statusbar with `props.level` matching the regex `^(warn|error)$`.

5. **Focused element:**
   ```
   role=textbox focus
   ```
   Matches the textbox that currently has focus.

6. **Selected state flag:**
   ```
   role=listitem selected
   ```
   Matches a listitem with `selected: true`.

## 6. Transport Overview

Messages are exchanged via JSON Lines (JSONL) over a transport layer:

- **POSIX (Linux/macOS):** File descriptors 3 (child → driver) and 4 (driver → child)
- **Windows:** Named pipes (negotiated via stdout handshake)
- **WebSocket:** Single bi-directional socket for React/Angular web-app adapters (see §6.1 below)

Each message is one UTF-8 line terminated by `\n`, with a 1 MiB cap per message. The JSON Schema at `schema.json` (in the same directory as this document) is the normative binding-level specification.

### 6.1 WebSocket Transport Envelope

The fd 3/4 and named-pipe transports use two separate unidirectional channels so the direction of any message is implicit. The WebSocket transport uses a **single bi-directional socket**, which requires an explicit `dir` discriminator on every message.

Every message on a WebSocket harness connection is wrapped in an envelope that adds a top-level `dir` field:

```typescript
type WsEnvelope =
  | { dir: "frame";  /* + all LiveFrame fields verbatim */ }
  | { dir: "event";  /* + all LiveEvent fields verbatim */ }
  | { dir: "cmd";    op: "press" | "type" | "focus"; key?: string; text?: string; id?: string }
```

#### `dir: "frame"` — Server → Client

Carries a complete `LiveFrame` snapshot. All `LiveFrame` fields are placed at the top level alongside `dir`:

```json
{"dir":"frame","mode":"live","version":"0.1.0","seq":1,"ts":1747267200000,"nodes":[...]}
```

#### `dir: "event"` — Server → Client

Carries a `LiveEvent`. The inner `t` discriminant from `LiveEvent` (`"event"` or `"idle"`) is preserved:

```json
{"dir":"event","t":"event","kind":"toast","level":"info","text":"Ready","ttlMs":3000}
{"dir":"event","t":"idle"}
```

#### `dir: "cmd"` — Client → Server

Carries a command from the controlling agent to the TUI process:

```json
{"dir":"cmd","op":"press","key":"Enter"}
{"dir":"cmd","op":"type","text":"hello world"}
{"dir":"cmd","op":"focus","id":"composer"}
```

#### Forward Compatibility

Consumers **MUST** silently ignore any `dir` value they do not recognise (skip the line, do not close). This allows future `dir` values (e.g. `"design"` for `DesignSpec` frames) to be introduced without breaking older consumers.

The fd 3/4 and named-pipe transports are **unchanged** — they continue to emit raw `LiveFrame` and `LiveEvent` objects without a `dir` wrapper.

Full transport spec (security requirements, Zod schema, wire examples): [`docs/agent-harness/TRANSPORTS.md`](./TRANSPORTS.md).

## 7. Version Evolution Policy

- Every top-level message carries a `version` field.
- **Major mismatch (e.g., 0.2.0 vs 0.1.0):** Consumer should reject the message and signal version incompatibility.
- **Minor additions (e.g., 0.1.1 vs 0.1.0):** Consumer ignores unknown fields; forward-compatible.
- **Deprecations:** Producers may include `deprecated_fields?: string[]` listing fields no longer recommended. Producers must support deprecated fields for two minor versions.

No fields are deprecated at protocol v0.1.0.

---

**Last revised:** 2026-05-14  
**Next review:** After Phase 1 implementation
