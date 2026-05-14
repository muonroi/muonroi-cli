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
