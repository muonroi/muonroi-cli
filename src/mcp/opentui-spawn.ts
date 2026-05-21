/**
 * opentui-spawn.ts — HarnessSpawn implementation for muonroi-cli (OpenTUI).
 *
 * Wraps the cross-platform test-spawn helper so it satisfies the
 * HarnessSpawnResult / HarnessSpawn contract expected by createMcpHarnessServer.
 *
 * On POSIX: uses fd 3/4 stdio channels.
 * On Windows: uses named pipes (MUONROI_HARNESS_OUT_PIPE / IN_PIPE).
 */

import type { HarnessSpawn, HarnessSpawnResult } from "@muonroi/agent-harness-core/mcp-server";
import { spawnAgentTui } from "../agent-harness/test-spawn.js";

export const opentuiSpawn: HarnessSpawn = async (req): Promise<HarnessSpawnResult> => {
  // req.argv is ["run", entry, ...finalArgs]; strip the leading "run" — spawnAgentTui
  // expects args starting at the entry path (it prepends ["bun", "run"] itself via
  // spawn("bun", ["run", ...args])).
  const args = req.argv.slice(1); // drop "run", keep entry + rest

  const { proc, inWrite, outRead, cleanup } = await spawnAgentTui(args, {
    spawnOpts: {
      cwd: req.cwd,
      env: Object.keys(req.env).length > 0 ? req.env : undefined,
      shell: false,
    },
  });

  // onLine: subscribe to raw newline-separated output from the child.
  // createLineSplitter in mcp-server handles the Buffer→line splitting;
  // here we emit whole string lines from the readable stream.
  const lineCallbacks = new Set<(line: string) => void>();
  let residual = "";

  outRead.on("data", (chunk: Buffer | string) => {
    residual += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = residual.indexOf("\n")) !== -1) {
      const line = residual.slice(0, nl);
      residual = residual.slice(nl + 1);
      for (const cb of lineCallbacks) cb(line);
    }
  });

  const exited = new Promise<number>((resolve) => {
    proc.once("exit", (code) => {
      cleanup();
      resolve(code ?? 0);
    });
  });

  return {
    proc,
    sendLine: (line: string) => {
      // Ensure the line is newline-terminated when written to the child.
      const payload = line.endsWith("\n") ? line : `${line}\n`;
      inWrite.write(payload);
    },
    onLine: (cb: (line: string) => void) => {
      lineCallbacks.add(cb);
      return () => lineCallbacks.delete(cb);
    },
    exited,
  };
};
