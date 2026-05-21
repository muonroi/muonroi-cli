// src/cli/config/tui.ts
// Raw-mode key capture, ANSI helpers, and box/row rendering for config screens.

export const A = {
  CLEAR_SCREEN: "\x1b[2J\x1b[H",
  CLEAR_LINE: "\x1b[2K\r",
  UP: (n: number) => `\x1b[${n}A`,
  HIDE_CURSOR: "\x1b[?25l",
  SHOW_CURSOR: "\x1b[?25h",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  BLUE: "\x1b[34m",
  BRIGHT_BLUE: "\x1b[94m",
  GREEN: "\x1b[32m",
  RED: "\x1b[31m",
  YELLOW: "\x1b[33m",
  REVERSE: "\x1b[7m",
  RESET: "\x1b[0m",
};

export interface KeyEvent {
  /** Normalized name: "up", "down", "left", "right", "return", "escape", "space",
   *  "backspace", or the raw character for printable keys. */
  name: string;
  raw: Buffer;
}

/** Enter raw mode and return a cleanup function that restores stdin. */
export function enterRawMode(): () => void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdout.write(A.HIDE_CURSOR);
  return () => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write(A.SHOW_CURSOR);
  };
}

/** Read one key event from raw stdin. Exits process on Ctrl+C. */
export function captureKey(): Promise<KeyEvent> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener("data", onData);
      const b0 = chunk[0] ?? 0;

      if (b0 === 0x03) {
        // Ctrl+C
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(false);
        }
        process.stdout.write(`${A.SHOW_CURSOR}\n`);
        process.exit(130);
      }

      if (b0 === 0x1b) {
        if (chunk.length === 1) {
          return resolve({ name: "escape", raw: chunk });
        }
        if (chunk[1] === 0x5b /* [ */) {
          const code = chunk[2];
          if (code === 0x41) return resolve({ name: "up", raw: chunk });
          if (code === 0x42) return resolve({ name: "down", raw: chunk });
          if (code === 0x43) return resolve({ name: "right", raw: chunk });
          if (code === 0x44) return resolve({ name: "left", raw: chunk });
        }
        return resolve({ name: "escape", raw: chunk });
      }

      if (b0 === 0x0d || b0 === 0x0a) return resolve({ name: "return", raw: chunk });
      if (b0 === 0x20) return resolve({ name: "space", raw: chunk });
      if (b0 === 0x7f || b0 === 0x08) return resolve({ name: "backspace", raw: chunk });
      if (b0 >= 0x20) return resolve({ name: String.fromCharCode(b0), raw: chunk });
      resolve({ name: "unknown", raw: chunk });
    };
    process.stdin.once("data", onData);
  });
}

/** Mask an API key for display: first 6 chars + … + last 4. */
export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Prompt for hidden input (key entry). Returns trimmed value. */
export async function hiddenPrompt(question: string): Promise<string> {
  const CHAR_LF = 0x0a;
  const CHAR_CR = 0x0d;
  const CHAR_EOT = 0x04;
  const CHAR_ETX = 0x03;
  const CHAR_BS = 0x08;
  const CHAR_DEL = 0x7f;

  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";

    const finish = (cancelled: boolean) => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write("\n");
      if (cancelled) process.exit(130);
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk[i] ?? 0;
        if (code === CHAR_LF || code === CHAR_CR || code === CHAR_EOT) {
          finish(false);
          return;
        }
        if (code === CHAR_ETX) {
          finish(true);
          return;
        }
        if (code === CHAR_BS || code === CHAR_DEL) {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (code < 0x20) continue;
        value += String.fromCharCode(code);
      }
    };

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Render a horizontal divider line. */
export function divider(width = 56): string {
  return "─".repeat(width);
}

/** Render a row with optional cursor highlight. */
export function renderRow(text: string, selected: boolean, width = 56): string {
  const visualPrefixWidth = 2; // "► " or "  " — same visual width regardless of ANSI codes
  const prefix = selected ? `${A.REVERSE}► ` : "  ";
  const suffix = selected ? A.RESET : "";
  return prefix + text.padEnd(width - visualPrefixWidth) + suffix;
}
