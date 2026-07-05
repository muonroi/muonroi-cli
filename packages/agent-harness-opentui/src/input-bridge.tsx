/**
 * Input bridge: consume JSONL commands from fd4 (via agentRuntime.onCommand)
 * and inject them as synthetic key events into OpenTUI's keyHandler.
 *
 * Without this bridge the harness can OBSERVE the TUI (fd3 frames) but not
 * DRIVE it — type/press operations sent by the driver are silently dropped.
 *
 * Key naming map: the harness uses friendly names ("Enter", "Down") to keep
 * the protocol agent-agnostic. We translate to ParsedKey objects with the
 * matching `name` field that OpenTUI's textarea/select components expect.
 *
 * For single-character input, the parser would normally emit one keypress per
 * raw byte. We construct ParsedKey directly so we don't depend on terminal
 * escape sequence conventions.
 */

import type { KeyEvent } from "@opentui/core";
import { useAppContext } from "@opentui/react";
import { useEffect } from "react";
import type { AgentModeRuntime } from "./agent-mode.js";

type Cmd = { op: "press"; key: string } | { op: "type"; text: string } | { op: string; [k: string]: unknown };

// Mapping from harness key names to (partial) ParsedKey fields.
// Names follow the `name` field OpenTUI emits for raw-mode keypress parsing.
const NAMED: Record<string, { name: string; sequence: string; raw: string }> = {
  Enter: { name: "return", sequence: "\r", raw: "\r" },
  Return: { name: "return", sequence: "\r", raw: "\r" },
  Escape: { name: "escape", sequence: "\x1b", raw: "\x1b" },
  Esc: { name: "escape", sequence: "\x1b", raw: "\x1b" },
  Up: { name: "up", sequence: "\x1b[A", raw: "\x1b[A" },
  Down: { name: "down", sequence: "\x1b[B", raw: "\x1b[B" },
  Right: { name: "right", sequence: "\x1b[C", raw: "\x1b[C" },
  Left: { name: "left", sequence: "\x1b[D", raw: "\x1b[D" },
  Tab: { name: "tab", sequence: "\t", raw: "\t" },
  Backspace: { name: "backspace", sequence: "\x7f", raw: "\x7f" },
  Delete: { name: "delete", sequence: "\x1b[3~", raw: "\x1b[3~" },
  Space: { name: "space", sequence: " ", raw: " " },
  Home: { name: "home", sequence: "\x1b[H", raw: "\x1b[H" },
  End: { name: "end", sequence: "\x1b[F", raw: "\x1b[F" },
  PageUp: { name: "pageup", sequence: "\x1b[5~", raw: "\x1b[5~" },
  PageDown: { name: "pagedown", sequence: "\x1b[6~", raw: "\x1b[6~" },
};

type KeyMods = { ctrl?: boolean; meta?: boolean; shift?: boolean };

/**
 * Strip modifier prefixes (`C-` ctrl, `M-` meta/alt, `S-` shift) off a harness
 * key string so combos like `C-b` or `C-o` can be driven. Prefixes may stack in
 * any order (`C-S-tab`). The remainder is the base key (named or single char).
 */
function parseModifiers(key: string): { mods: KeyMods; base: string } {
  const mods: KeyMods = {};
  let base = key;
  // Only consume a prefix when a base remains after it, so a literal "C" or a
  // hyphen key is not mis-parsed.
  for (;;) {
    if (base.length > 2 && base[1] === "-") {
      const p = base[0];
      if (p === "C" || p === "c") {
        mods.ctrl = true;
        base = base.slice(2);
        continue;
      }
      if (p === "M" || p === "m") {
        mods.meta = true;
        base = base.slice(2);
        continue;
      }
      if (p === "S") {
        mods.shift = true;
        base = base.slice(2);
        continue;
      }
    }
    break;
  }
  return { mods, base };
}

function makeKey(partial: { name: string; sequence: string; raw: string }, mods: KeyMods = {}): KeyEvent {
  // Some app key-handlers conditionally call key.preventDefault()/stopPropagation()
  // (typed `?.()` so they tolerate undefined). When the host's keypress arrives
  // through a terminal, OpenTUI attaches these methods; in agent-mode we
  // synthesize the event directly, so we must attach them ourselves — otherwise
  // the optional-chained call is a no-op and the textarea inserts the key
  // natively in addition to whatever the handler did (e.g. typing `/` results
  // in `//` because app.tsx manually insertText("/") and relies on
  // preventDefault to suppress the textarea's own insert).
  let _defaultPrevented = false;
  let _propagationStopped = false;
  const ev = {
    name: partial.name,
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    shift: mods.shift ?? false,
    option: false,
    sequence: partial.sequence,
    number: false,
    raw: partial.raw,
    eventType: "press",
    source: "raw",
    preventDefault() {
      _defaultPrevented = true;
    },
    stopPropagation() {
      _propagationStopped = true;
    },
    get defaultPrevented() {
      return _defaultPrevented;
    },
    get propagationStopped() {
      return _propagationStopped;
    },
  };
  return ev as unknown as KeyEvent;
}

function keyForChar(ch: string, mods: KeyMods = {}): KeyEvent {
  return makeKey({ name: ch, sequence: ch, raw: ch }, mods);
}

function keyForNamed(key: string): KeyEvent | null {
  const { mods, base } = parseModifiers(key);
  const m = NAMED[base];
  if (!m) {
    // Unknown named key — fall back to treating it as a literal character if it's 1 char.
    if (base.length === 1) return keyForChar(base, mods);
    return null;
  }
  return makeKey(m, mods);
}

/**
 * Subscribe to agentRuntime.onCommand and inject synthetic key events into
 * OpenTUI's keyHandler. Safe no-op when agentRuntime is undefined (normal user
 * mode).
 *
 * Special key `__focus__:<id>` is intentionally NOT translated to OpenTUI input
 * here — it is a driver-level signal currently ignored at this layer. (Focus
 * routing in OpenTUI is owned by individual components; a global focus dispatch
 * is out of scope for this bridge.)
 */
export function useAgentInputBridge(agentRuntime: AgentModeRuntime | undefined): void {
  const { keyHandler } = useAppContext() as { keyHandler?: { emit: (ev: string, k: KeyEvent) => void } };

  useEffect(() => {
    if (!agentRuntime || !keyHandler) return;
    // Toast-only stub in normal interactive mode provides emitEvent but not
    // onCommand. Guard so the bridge no-ops cleanly instead of crashing the TUI.
    if (typeof agentRuntime.onCommand !== "function") return;
    agentRuntime.onCommand((cmd: unknown) => {
      if (!cmd || typeof cmd !== "object") return;
      const c = cmd as Cmd;
      if (c.op === "press" && typeof c.key === "string") {
        if (c.key.startsWith("__focus__:")) return;
        const k = keyForNamed(c.key);
        if (k) keyHandler.emit("keypress", k);
      } else if (c.op === "type" && typeof c.text === "string") {
        for (const ch of c.text) {
          keyHandler.emit("keypress", keyForChar(ch));
        }
      }
    });
  }, [agentRuntime, keyHandler]);
}
